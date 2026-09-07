import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunConfig, RunEvent } from "@hone/schema";
import type { RunnerBackendContext } from "../src/types.js";
import { runOptimizer } from "../src/backends/local.js";
import { replay, replayRun } from "../src/eventlog.js";
import { stopCommand } from "../src/commands/stop.js";
import { pidAlive, runCommand as cliRunCommand, readSupervisorPid } from "../src/supervisor.js";
import { sleep } from "../src/promise.js";
import {
  fakeHash,
  honeSpawn,
  initScratchRepo,
  makeGitBaselineCapsule,
  killTree,
  makeCapsule,
  makeIo,
  makeRoot,
  manifestObject,
  readLogLines,
  testOptimizerRuntime,
  tarToCas,
} from "./helpers.js";

/**
 * Live M0 stop lifecycle: after run.finished nothing may append or run.
 * Covers the terminal-order fence, optimizer process-group kill, automatic
 * delivery-before-finished ordering, and stop waiting for real process exit.
 *
 * These are integration tests over real OS processes, POSIX process groups,
 * and the supervisor's genuine wall-clock grace windows — fake timers cannot
 * drive a separate process or the kernel, so the few real sleeps here poll
 * for real external state transitions.
 */

function eventTypes(root: string, runId: string): string[] {
  return readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)).type);
}

function soleRunId(root: string): string {
  const runs = join(root, ".hone-runs");
  const entries = existsSync(runs) ? readdirSync(runs) : [];
  expect(entries.length).toBe(1);
  const id = entries[0];
  if (id === undefined) throw new Error("unreachable");
  return id;
}

describe("terminal-order fence", () => {
  it("an abort-ignoring backend cannot append after hard-stop; run.finished is the final event", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    // 1s wall-clock budget forces the abort; grace 100ms forces the hard stop.
    makeCapsule(root, { budget: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 1, maxEvaluatorInvocations: 100 } });
    const rogue = join(root, "rogue-backend.mjs");
    writeFileSync(
      rogue,
      `export function createBackend() {
        return {
          async start(ctx) {
            // Deliberately ignores ctx.signal: keeps emitting long after abort + hard stop.
            for (let i = 0; i < 100; i++) {
              await new Promise((r) => setTimeout(r, 50));
              try {
                ctx.emit({ runId: ctx.runId, at: new Date().toISOString(), type: "episode.started", episode: i, parent: { hash: "${fakeHash("b")}" } });
              } catch {
                // an emit failure must not stop the rogue loop
              }
            }
          },
        };
      }
      `,
    );
    const { io } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "100" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./rogue-backend.mjs"], io);
    expect(code).toBe(0); // budget exhaustion is not a failure

    const runId = soleRunId(root);
    const types = eventTypes(root, runId);
    expect(types[types.length - 1]).toBe("run.finished");
    expect(types.filter((t) => t === "run.finished").length).toBe(1);
    const frozen = readLogLines(root, runId).join("\n");

    // The rogue backend keeps emitting for seconds after the supervisor
    // returned — every late append must be dropped by the fence. Real wait:
    // the rogue's own real timers are the competing activity under test.
    await sleep(1500);
    expect(readLogLines(root, runId).join("\n")).toBe(frozen);

    const state = replayRun(join(root, ".hone-runs", runId));
    expect(state.finished?.status).toBe("budget");
  });
});

describe("optimizer process-group kill", () => {
  it("SIGTERM through the registered handle kills descendants, not just the child", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_grp");
    mkdirSync(runDir, { recursive: true });
    const pidFile = join(runDir, "pids.json");
    const script = join(root, "optimizer-with-descendant.mjs");
    writeFileSync(
      script,
      `import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const grandchild = spawn("sleep", ["60"]); // same process group as this optimizer
      writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ self: process.pid, grandchild: grandchild.pid }));
      setInterval(() => {}, 1000); // stay alive until signalled
      `,
    );

    const manifest = manifestObject();
    const abort = new AbortController();
    const children: { pid?: number | undefined; kill(signal?: NodeJS.Signals): boolean }[] = [];
    const ctx: RunnerBackendContext = {
      runId: "run_grp",
      root,
      runDir,
      casDir: join(root, ".hone-cas"),
      capsuleDir: join(root, "capsule"),
      manifest,
      config: RunConfig.parse({
        version: 1,
        capsuleId: manifest.id,
        objective: manifest.objective,
        budget: manifest.budget,
        routing: { mutation: { model: "m" } },
      }),
      env: {
        PATH: process.env["PATH"] ?? "",
      },
      capsuleDigest: fakeHash("f"),
      optimizerDigest: fakeHash("0"),
      replayed: replay([]),
      signal: abort.signal,
      emit: (event) => event,
      registerChild: (child) => {
        children.push(child);
        return () => {};
      },
      probeGate: () => Promise.resolve(true),
      requestStop: () => {},
      registerAuthorityBarrier: () => {},
      registerCleanupBarrier: () => {},
    };

    const done = runOptimizer(ctx, testOptimizerRuntime({ runId: "run_grp", argv: [process.execPath, script] }));
    const spawnDeadline = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < spawnDeadline) await sleep(50);
    expect(existsSync(pidFile)).toBe(true);
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { self: number; grandchild: number };
    expect(pidAlive(pids.self)).toBe(true);
    expect(pidAlive(pids.grandchild)).toBe(true);
    expect(children.length).toBe(1);

    // Supervisor wind-down order: abort, then the registered kill handle.
    abort.abort(new Error("stop requested"));
    children[0]?.kill("SIGTERM");
    const killDeadline = Date.now() + 10_000;
    while ((pidAlive(pids.self) || pidAlive(pids.grandchild)) && Date.now() < killDeadline) await sleep(50);
    expect(pidAlive(pids.self)).toBe(false);
    // The whole point: a direct child.kill would have orphaned the grandchild.
    expect(pidAlive(pids.grandchild)).toBe(false);
    await done; // aborted wind-down resolves rather than rejects
  });
});

describe("automatic delivery order", () => {
  it("delivery.applied lands BEFORE run.finished; run.finished is the final event", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeGitBaselineCapsule(root); // the baseline repo doubles as the sealed delivery target
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    const backend = join(root, "delivering-backend.mjs");
    writeFileSync(
      backend,
      `export function createBackend() {
        return {
          async start(ctx) {
            const at = () => new Date().toISOString();
            ctx.emit({ runId: ctx.runId, at: at(), type: "episode.started", episode: 0, parent: { hash: "${fakeHash("b")}" } });
            ctx.emit({ runId: ctx.runId, at: at(), type: "incumbent.new", artifact: { hash: "${hash}" }, aggregate: 0.9, deltaVsBaseline: 0.4, episode: 0 });
          },
        };
      }
      `,
    );
    const { io, err } = makeIo(root, { HONE_UNSAFE_BACKEND: "1" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./delivering-backend.mjs", "--apply", "branch", "--repo", "capsule/baseline"], io);
    expect(code, err.join("\n")).toBe(0);

    const runId = soleRunId(root);
    const types = eventTypes(root, runId);
    const deliveryIdx = types.indexOf("delivery.applied");
    const finishedIdx = types.indexOf("run.finished");
    expect(deliveryIdx, types.join(",")).toBeGreaterThanOrEqual(0);
    expect(deliveryIdx).toBeLessThan(finishedIdx);
    expect(types[types.length - 1]).toBe("run.finished");
  });
});

describe("stop waits for real termination", () => {
  it("returns only after run.finished and the identity-bound lock release; the supervisor then exits", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "stub"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: "200", HONE_STUB_DELAY_MS: "100", HONE_KILL_GRACE_MS: "500" },
    });
    try {
      // Wait until the run is live: supervisor pid file + at least one event.
      const deadline = Date.now() + 20_000;
      let runId: string | null = null;
      let pid: number | null = null;
      while (Date.now() < deadline) {
        const runs = join(root, ".hone-runs");
        const ids = existsSync(runs) ? readdirSync(runs) : [];
        const candidate = ids[0];
        if (candidate !== undefined) {
          runId = candidate;
          pid = readSupervisorPid(join(runs, candidate));
          // Boot order is unordered: the sentinel can land before
          // events.ndjson exists — poll through the gap.
          if (pid !== null && existsSync(join(runs, candidate, "events.ndjson")) && readLogLines(root, candidate).length >= 2) break;
        }
        await sleep(100);
      }
      expect(runId).not.toBeNull();
      expect(pid).not.toBeNull();
      if (runId === null || pid === null) throw new Error("unreachable");

      const { io } = makeIo(root);
      const code = await stopCommand([], io);
      expect(code).toBe(0);
      // Stop's completion signal is the identity-bound lock RELEASE (never a
      // bare-PID wait — pids recycle); the released supervisor has nothing
      // left but its exit report, so its process drains within moments.
      const gone = Date.now() + 10_000;
      while (pidAlive(pid) && Date.now() < gone) await sleep(50);
      expect(pidAlive(pid)).toBe(false);
      const state = replayRun(join(root, ".hone-runs", runId));
      expect(state.finished?.status).toBe("stopped");
      const types = eventTypes(root, runId);
      expect(types[types.length - 1]).toBe("run.finished");
    } finally {
      killTree(child);
    }
  });
});
