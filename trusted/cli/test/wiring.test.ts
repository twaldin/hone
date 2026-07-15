import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, RunConfig, RunEvent, capsuleDigest } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { createBackend } from "../src/backends/local.js";
import { deliver } from "../src/deliver.js";
import { appendEvent, replayRun } from "../src/eventlog.js";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import type { RunnerBackendContext } from "../src/types.js";
import {
  FIX_IMAGE,
  at,
  fakeHash,
  fixtureEvents,
  gitIn,
  initScratchRepo,
  makeCapsule,
  makeIo,
  makeRoot,
  readLogLines,
  tarToCas,
  writeEvents,
} from "./helpers.js";

function soleRunConfig(root: string): RunConfig {
  const runsDir = join(root, ".hone-runs");
  const entries = readdirSync(runsDir);
  expect(entries.length).toBe(1);
  return RunConfig.parse(JSON.parse(readFileSync(join(runsDir, entries[0] ?? "", "runconfig.json"), "utf8")));
}

describe("bare run: default mutation route", () => {
  it("a config-less run defaults the mutation route to glm-5.2", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1", HONE_MODEL_ID: undefined });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", "stub"], io)).toBe(0);
    const config = soleRunConfig(root);
    expect(config.routing["mutation"]?.model).toBe("glm-5.2");
    // The upstream base URL stays the proxy's single configured default.
    expect(config.routing["mutation"]?.upstreamBaseUrl).toBeUndefined();
  });

  it("HONE_MODEL_ID overrides the default model id", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1", HONE_MODEL_ID: "custom-model-7" });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", "stub"], io)).toBe(0);
    expect(soleRunConfig(root).routing["mutation"]?.model).toBe("custom-model-7");
  });

  it("an explicit --config mutation route wins over the default", async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ routing: { mutation: { model: "picked-explicitly" } } }));
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1", HONE_MODEL_ID: "ignored" });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", "stub", "--config", "cfg.json"], io)).toBe(0);
    expect(soleRunConfig(root).routing["mutation"]?.model).toBe("picked-explicitly");
  });
});

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

describe("image wiring: manifest.image is THE image, no environment override", () => {
  it("relay + broker use manifest.image; HONE_MUTATION_IMAGE is dead", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runId = "run_img";
    const runDir = join(root, ".hone-runs", runId);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(root, ".hone-cas"), { recursive: true });
    const baseline = join(root, "capsule", "baseline");
    initScratchRepo(baseline);
    const commit = gitIn(baseline, "rev-parse", "HEAD");
    const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit } });
    const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")));
    appendEvent(runDir, { runId, at: at(), type: "run.started", capsuleId: manifest.id, contractHash: fakeHash("c"), optimizerDigest: fakeHash("0") });

    const argvs: (readonly string[])[] = [];
    const run: RunCommand = (argv) => {
      argvs.push(argv);
      // docker network inspect must confirm --internal for idempotent reuse paths
      if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
      return Promise.resolve(res());
    };
    const abort = new AbortController();
    abort.abort(new Error("stop requested")); // setup-only pass: egress + broker init, no optimizer
    const ctx: RunnerBackendContext = {
      runId,
      root,
      runDir,
      casDir: join(root, ".hone-cas"),
      capsuleDir,
      manifest,
      config: RunConfig.parse({
        version: 1,
        capsuleId: manifest.id,
        objective: manifest.objective,
        budget: manifest.budget,
        routing: { mutation: { model: "m" } },
        headless: true,
      }),
      env: {
        PATH: process.env["PATH"] ?? "",
        HONE_EGRESS: "network", // exercise the relay container path
        HONE_MUTATION_IMAGE: "evil:latest", // MUST be ignored
        HONE_OPTIMIZER_CMD: process.execPath,
        HONE_OPTIMIZER_ENTRY: join(root, "never-runs.mjs"),
      },
      capsuleDigest: capsuleDigest(manifest),
      optimizerDigest: fakeHash("0"),
      replayed: replayRun(runDir),
      signal: abort.signal,
      emit: (event) => appendEvent(runDir, event),
      registerChild: () => () => {},
      probeGate: () => Promise.resolve(true),
      requestStop: () => {},
      registerAuthorityBarrier: () => {},
    };

    await createBackend({ run }).start(ctx);

    // The relay container runs the manifest's immutable image…
    const relayRun = argvs.find((a) => a[0] === "docker" && a[1] === "run");
    expect(relayRun, JSON.stringify(argvs)).toBeDefined();
    expect(relayRun).toContain(FIX_IMAGE);
    // …and no docker invocation anywhere references an override or a mutable tag.
    const flat = argvs.flat();
    expect(flat).not.toContain("evil:latest");
    expect(flat.some((a) => a.includes("hone-mutation:latest"))).toBe(false);

    // Repo-lifetime holdout ledger landed under the CAS root, keyed by capsule digest.
    const digestHex = capsuleDigest(manifest).replace(/^sha256:/, "");
    expect(existsSync(join(root, ".hone-cas", "ledgers", `${digestHex}.ndjson`))).toBe(true);
  });
});

describe("broker budget.exhausted normalizes the terminal status", () => {
  it("a backend-logged budget.exhausted terminalizes status=budget with exactly one exhaustion event", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "exhausting-backend.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            const now = () => new Date().toISOString();
            // Trusted broker authority: the usd dimension ran out mid-run.
            ctx.emit({ runId: ctx.runId, at: now(), type: "budget.exhausted", dimension: "usd" });
          },
        };
      }
      `,
    );
    const { io, out } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "50" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./exhausting-backend.mjs"], io);
    expect(code).toBe(0);

    const runsDir = join(root, ".hone-runs");
    const runId = readdirSync(runsDir)[0] ?? "";
    const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.filter((e) => e.type === "budget.exhausted").length).toBe(1);
    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("budget");
    // and the machine-readable exit report agrees
    const report = JSON.parse(out[out.length - 1] ?? "{}") as Record<string, unknown>;
    expect(report["status"]).toBe("budget");
  });
});

describe("apply:pr is local-only for the seed", () => {
  it("creates the branch and a manual PR instruction; gh is NEVER invoked", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_pr", fixtureEvents({ runId: "run_pr", baselineHash: fakeHash("b"), bestHash: artifact, finished: true }));

    // A gh shim earlier on PATH records any invocation — the trusted CLI must never call it.
    const shimDir = join(root, "shims");
    mkdirSync(shimDir, { recursive: true });
    const marker = join(root, "gh-invoked");
    writeFileSync(join(shimDir, "gh"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
    const priorPath = process.env["PATH"];
    process.env["PATH"] = `${shimDir}:${priorPath ?? ""}`;
    try {
      const result = deliver({
        mode: "pr",
        repo,
        runId: "run_pr",
        artifact,
        casDir: join(root, ".hone-cas"),
        improverSeat: false,
        env: process.env,
      });
      expect(result.ref).toMatch(/^hone\/run_pr/);
      expect(result.notes.join("\n")).toMatch(/local-only/);
      expect(result.notes.join("\n")).toMatch(/gh pr create/); // manual instruction, not an invocation
      // Branch exists, produced ref-only — and gh was never executed.
      expect(gitIn(repo, "show", `${result.ref ?? ""}:hello.txt`)).toBe("improved");
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env["PATH"] = priorPath;
    }
  });
});
