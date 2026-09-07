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
  it("continues from the replayed cursor without duplicating episodes", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const total = 40;

    // phase 1: slow scripted run, killed after >=2 episodes have started
    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "stub"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: String(total), HONE_STUB_DELAY_MS: "100" },
    });
    try {
      const deadline = Date.now() + 20_000;
      let killed = false;
      while (Date.now() < deadline) {
        const ids = runIds(root);
        const id = ids[0];
        if (id !== undefined) {
          const started = (logText(root, id).match(/"episode\.started"/g) ?? []).length;
          if (started >= 2) {
            killTree(child);
            killed = true;
            break;
          }
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

    // phase 2: resume, fast
    const r = await hone(["run", "capsule", "--headless", "--backend", "stub", "--resume"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: String(total), HONE_STUB_DELAY_MS: "0" },
    });
    expect(r.code, r.stderr).toBe(0);

    // same run dir, no new run minted
    expect(runIds(root)).toEqual([runId]);

    const lines = logText(root, runId)
      .split("\n")
      .filter((l) => l.trim() !== "");
    const events = lines.map((l) => RunEvent.parse(JSON.parse(l)));

    // exactly one run.started, at least one run.resumed with a sane cursor
    expect(events.filter((e) => e.type === "run.started").length).toBe(1);
    const resumed = events.filter((e) => e.type === "run.resumed");
    expect(resumed.length).toBeGreaterThanOrEqual(1);
    const first = resumed[0];
    if (first?.type === "run.resumed") expect(first.fromCursor).toBeGreaterThanOrEqual(2);

    // no duplicated episodes; the full schedule completed
    const episodes = events.flatMap((e) => (e.type === "episode.started" ? [e.episode] : []));
    expect(new Set(episodes).size).toBe(episodes.length);
    expect(episodes.length).toBe(total);

    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("completed");

    // resumed headless stdout still ends with the machine report
    const out = r.stdout.trim().split("\n");
    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.status).toBe("completed");
    expect(report.runId).toBe(runId);
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
