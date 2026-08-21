import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { RUNTIME_PIN_FILE, trustedRuntimeDigest } from "../src/supervisor.js";
import { honeSpawn, hone, killTree, makeCapsule, makeRoot, pkgRoot, sleep } from "./helpers.js";

function runIds(root: string): string[] {
  const dir = join(root, ".hone-runs");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function logText(root: string, runId: string): string {
  const p = join(root, ".hone-runs", runId, "events.ndjson");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("kill -9 mid-run + hone run --resume", () => {
  it("reuses a journaled evaluator checkpoint and budget after SIGKILL", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const total = 1;

    // Phase 1: kill the real CLI process after the evaluator checkpoint is
    // durable but before the episode commit boundary.
    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "stub"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: String(total), HONE_STUB_CHECKPOINT_DELAY_MS: "10000" },
    });
    try {
      const deadline = Date.now() + 20_000;
      let killed = false;
      while (Date.now() < deadline) {
        const id = runIds(root)[0];
        if (id !== undefined && logText(root, id).includes('"eval.completed"')) {
          killTree(child);
          killed = true;
          break;
        }
        await sleep(50);
      }
      expect(killed).toBe(true);
    } finally {
      killTree(child);
    }
    await sleep(300); // let the group die

    const ids = runIds(root);
    expect(ids.length).toBe(1);
    const runId = ids[0];
    expect(runId).toBeDefined();
    if (runId === undefined) throw new Error("unreachable");
    // hard kill: no run.finished was written
    expect(logText(root, runId)).not.toContain('"run.finished"');

    // Phase 2: the same run resumes from the incomplete episode checkpoint.
    const r = await hone(["run", "capsule", "--headless", "--backend", "stub", "--resume"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: String(total), HONE_STUB_CHECKPOINT_DELAY_MS: "0" },
    });
    expect(r.code, r.stderr).toBe(0);

    // same run dir, no new run minted
    expect(runIds(root)).toEqual([runId]);

    const lines = logText(root, runId)
      .split("\n")
      .filter((l) => l.trim() !== "");
    const events = lines.map((l) => RunEvent.parse(JSON.parse(l)));

    // One start/candidate/evaluator/dispatch charge survives across both
    // processes; resume only seals selection and the episode boundary.
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(1);
    const resumed = events.filter((e) => e.type === "run.resumed");
    expect(resumed).toHaveLength(1);
    expect(events.filter((e) => e.type === "episode.started")).toHaveLength(1);
    expect(events.filter((e) => e.type === "episode.candidate")).toHaveLength(1);
    expect(events.filter((e) => e.type === "eval.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "episode.completed")).toHaveLength(1);
    const budget = events.filter((e) => e.type === "budget.snapshot").at(-1);
    if (budget?.type === "budget.snapshot") {
      expect(budget.budget.spent.evaluatorInvocations).toBe(1);
      expect(budget.budget.spent.tokens).toBe(1000);
    }
    const dispatches = readFileSync(join(root, ".hone-runs", runId, "proxy-dispatch.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string });
    expect(dispatches.filter((entry) => entry.kind === "intent")).toHaveLength(1);

    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("completed");

    // resumed headless stdout still ends with the machine report
    const out = r.stdout.trim().split("\n");
    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.status).toBe("completed");
    expect(report.runId).toBe(runId);
  });

describe("provider-limit auto-pause", () => {
  it("durably pauses on a simulated 429 and later resumes to completion", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "provider-limit-backend.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            if (ctx.replayed.resumeCount === 0) {
              ctx.requestPause({
                reason: "provider-rate-limit",
                pauseId: "pause_test_429",
                providerStatus: 429,
              });
            }
          },
        };
      }\n`,
    );

    const pausedRun = await hone(
      ["run", "capsule", "--headless", "--backend", "./provider-limit-backend.mjs"],
      { cwd: root, env: { HONE_UNSAFE_BACKEND: "1" } },
    );
    expect(pausedRun.code, pausedRun.stderr).toBe(0);
    const runId = runIds(root)[0];
    expect(runId).toBeDefined();
    if (runId === undefined) throw new Error("unreachable");
    const pausedEvents = logText(root, runId).trim().split("\n").map((line) => RunEvent.parse(JSON.parse(line)));
    const paused = pausedEvents.at(-1);
    expect(paused).toMatchObject({
      type: "run.paused",
      reason: "provider-rate-limit",
      pauseId: "pause_test_429",
      providerStatus: 429,
    });
    expect(pausedEvents.some((event) => event.type === "run.finished")).toBe(false);

    const resumedRun = await hone(
      ["run", "capsule", "--headless", "--resume"],
      { cwd: root, env: { HONE_UNSAFE_BACKEND: "1" } },
    );
    expect(resumedRun.code, resumedRun.stderr).toBe(0);
    const finishedEvents = logText(root, runId).trim().split("\n").map((line) => RunEvent.parse(JSON.parse(line)));
    expect(finishedEvents.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(finishedEvents.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(finishedEvents.at(-1)).toMatchObject({ type: "run.finished", status: "completed" });
  });
});

  it("--resume with nothing to resume is a usage error", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const r = await hone(["run", "capsule", "--headless", "--backend", "stub", "--resume"], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/resum/i);
  });
});

describe("trusted-runtime pin (.hone-version)", () => {
  it("is deterministic over the transitive trusted workspace closure", () => {
    const digest = trustedRuntimeDigest();
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(trustedRuntimeDigest()).toBe(digest);
  });

  it("mutated trusted source in a TRANSITIVE dependency (scoring) drifts the digest", () => {
    // @hone/scoring is reached only through @hone/broker's workspace deps —
    // a hand list would miss it. Adding a source file must drift the pin.
    const before = trustedRuntimeDigest();
    const probe = join(pkgRoot, "..", "scoring", "src", `drift-probe-${process.pid}.ts`);
    writeFileSync(probe, "export const driftProbe = 1;\n");
    try {
      expect(trustedRuntimeDigest()).not.toBe(before);
    } finally {
      rmSync(probe, { force: true });
    }
    expect(trustedRuntimeDigest()).toBe(before);
  });

  it("resume refuses drifted/missing pins BEFORE any event; sidecars were durably minted before run.started", { timeout: 120_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    // phase 1: slow stub run, killed mid-flight (same shape as the kill -9 test)
    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "stub"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: "40", HONE_STUB_DELAY_MS: "100" },
    });
    try {
      const deadline = Date.now() + 20_000;
      let killed = false;
      while (Date.now() < deadline) {
        const id = runIds(root)[0];
        if (id !== undefined && logText(root, id).includes('"episode.started"')) {
          killTree(child);
          killed = true;
          break;
        }
        await sleep(50);
      }
      expect(killed).toBe(true);
    } finally {
      killTree(child);
    }
    await sleep(300); // let the group die
    const runId = runIds(root)[0];
    expect(runId).toBeDefined();
    if (runId === undefined) throw new Error("unreachable");
    const runDir = join(root, ".hone-runs", runId);

    // Sidecar ordering: run.started is acknowledged in the log, so EVERY
    // resume-required sidecar must already be durably published and whole.
    expect(logText(root, runId)).toContain('"run.started"');
    const pinPath = join(runDir, RUNTIME_PIN_FILE);
    expect(readFileSync(pinPath, "utf8").trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(runDir, "capsule-manifest.json"), "utf8"))).toBeTruthy();
    expect(JSON.parse(readFileSync(join(runDir, "runconfig.json"), "utf8"))).toBeTruthy();
    expect(readFileSync(join(runDir, "contract.md"), "utf8")).toContain("# Hone Run Contract");
    expect(readdirSync(runDir).filter((n) => n.includes(".tmp"))).toEqual([]);

    const genuine = readFileSync(pinPath, "utf8");
    const eventsBefore = logText(root, runId);
    const resumeArgs = ["run", "capsule", "--headless", "--backend", "stub", "--resume"];
    const resumeEnv = { HONE_STUB_EPISODES: "40", HONE_STUB_DELAY_MS: "0" };

    // Drifted pin: refuse, appending NOTHING.
    writeFileSync(pinPath, `sha256:${"0".repeat(64)}\n`);
    const drift = await hone(resumeArgs, { cwd: root, env: resumeEnv });
    expect(drift.code).not.toBe(0);
    expect(drift.stderr).toContain("trusted-runtime drift");
    expect(logText(root, runId)).toBe(eventsBefore);

    // Missing pin: refuse, appending NOTHING.
    rmSync(pinPath);
    const missing = await hone(resumeArgs, { cwd: root, env: resumeEnv });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("no trusted-runtime pin");
    expect(logText(root, runId)).toBe(eventsBefore);

    // Genuine pin restored: the resume completes.
    writeFileSync(pinPath, genuine);
    const ok = await hone(resumeArgs, { cwd: root, env: resumeEnv });
    expect(ok.code, ok.stderr).toBe(0);
    const lines = logText(root, runId)
      .split("\n")
      .filter((l) => l.trim() !== "");
    const events = lines.map((l) => RunEvent.parse(JSON.parse(l)));
    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("completed");
  });
});
