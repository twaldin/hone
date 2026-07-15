import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, RunConfig, RunEvent } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { createBackend } from "../src/backends/local.js";
import { stopCommand } from "../src/commands/stop.js";
import { appendEvent, bestArtifact, readEvents, replayRun } from "../src/eventlog.js";
import { sleep } from "../src/promise.js";
import { pidAlive, readSupervisorPid, runCommand as cliRunCommand } from "../src/supervisor.js";
import type { RunnerBackendContext } from "../src/types.js";
import {
  fakeHash,
  fixtureEvents,
  gitIn,
  hone,
  honeSpawn,
  initScratchRepo,
  killTree,
  makeCapsule,
  makeIo,
  makeRoot,
  manifestRaw,
  readLogLines,
  tarToCas,
  writeEvents,
} from "./helpers.js";

/**
 * Four stop-lifecycle P1s: a SIGTERM during synchronous delivery must be
 * handled (not the OS default kill), an explicit stop skips automatic
 * delivery, the PID sentinel lives until real process exit so stop/take-best
 * never race a draining supervisor, a TERM-ignoring descendant dies before
 * the terminal event, and an abort during resume startup still reconciles
 * the broker journal before anything terminalizes.
 *
 * Integration tests over real processes and signals — real sleeps here poll
 * external state transitions that fake timers cannot drive.
 */

const at = (): string => new Date().toISOString();

function runEvents(root: string, runId: string): RunEvent[] {
  return readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
}

function soleRunId(root: string): string {
  const runs = join(root, ".hone-runs");
  const entries = existsSync(runs) ? readdirSync(runs) : [];
  expect(entries.length).toBe(1);
  const id = entries[0];
  if (id === undefined) throw new Error("unreachable");
  return id;
}

/** Backend module emitting one real-CAS incumbent, with an optional body appended before settling. */
function incumbentBackendSrc(hash: string, extra = ""): string {
  return `export function createBackend() {
    return {
      async start(ctx) {
        const at = () => new Date().toISOString();
        ctx.emit({ runId: ctx.runId, at: at(), type: "episode.started", episode: 0, parent: { hash: "${fakeHash("b")}" } });
        ctx.emit({ runId: ctx.runId, at: at(), type: "incumbent.new", artifact: { hash: "${hash}" }, aggregate: 0.9, deltaVsBaseline: 0.4, episode: 0 });
        ${extra}
      },
    };
  }
  `;
}

describe("SIGTERM during synchronous delivery (P1: handlers must outlive the backend race)", () => {
  it("delivery completes atomically, run terminates stopped, run.finished is last", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    initScratchRepo(root);
    makeCapsule(root);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    writeFileSync(join(root, "delivering-backend.mjs"), incumbentBackendSrc(hash));

    // PATH shim: every git invocation inside the supervisor first TERMs its
    // parent (the supervisor itself) — a real signal deterministically inside
    // the synchronous delivery window — then delegates to the real git.
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\nkill -TERM $PPID 2>/dev/null\nexec "${realGit}" "$@"\n`, { mode: 0o755 });

    const r = await hone(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--apply", "branch"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200", PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    expect(r.code, r.stderr).toBe(0); // stopped is not a failure

    const runId = soleRunId(root);
    const events = runEvents(root, runId);
    const types = events.map((e) => e.type);
    expect(types[types.length - 1]).toBe("run.finished");
    expect(types.filter((t) => t === "run.finished").length).toBe(1);
    const finished = events[events.length - 1];
    if (finished?.type === "run.finished") expect(finished.status).toBe("stopped");
    // the delivery that was interrupted by the signal still finished atomically, BEFORE the terminal
    const deliveryIdx = types.indexOf("delivery.applied");
    expect(deliveryIdx, types.join(",")).toBeGreaterThanOrEqual(0);
    expect(deliveryIdx).toBeLessThan(types.indexOf("run.finished"));
    expect(gitIn(root, "show", `hone/${runId}:hello.txt`)).toBe("improved");
  });
});

describe("explicit stop before delivery (P1)", () => {
  it("skips automatic delivery entirely and terminates stopped", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    initScratchRepo(root);
    makeCapsule(root);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    // The backend itself requests the stop, then yields so the handler runs
    // BEFORE it settles — stopRequested is true when the delivery gate runs.
    writeFileSync(
      join(root, "stopping-backend.mjs"),
      incumbentBackendSrc(hash, `process.kill(process.pid, "SIGTERM"); await new Promise((r) => setTimeout(r, 150));`),
    );
    const r = await hone(["run", "capsule", "--headless", "--backend", "./stopping-backend.mjs", "--apply", "branch"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200" },
    });
    expect(r.code, r.stderr).toBe(0);

    const runId = soleRunId(root);
    const types = runEvents(root, runId).map((e) => e.type);
    expect(types).not.toContain("delivery.applied");
    expect(types[types.length - 1]).toBe("run.finished");
    const finished = runEvents(root, runId).at(-1);
    if (finished?.type === "run.finished") expect(finished.status).toBe("stopped");
    // no branch was minted
    const ref = spawnSync("git", ["-C", root, "show-ref", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
    expect(ref.status).not.toBe(0);
  });
});

describe("PID sentinel until real exit (P1: stop --take-best must not race teardown)", () => {
  it("stop blocks on a finished-but-still-alive supervisor, then applies", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    makeCapsule(root);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    // Lingers ~6s past run.finished: the pending timer keeps the supervisor
    // process alive after the terminal event (main.ts sets exitCode only).
    writeFileSync(join(root, "lingering-backend.mjs"), incumbentBackendSrc(hash, `setTimeout(() => {}, 6000);`));
    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "./lingering-backend.mjs"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200" },
    });
    try {
      // Wait for the terminal event while the process is still alive.
      const deadline = Date.now() + 20_000;
      let runId: string | null = null;
      while (Date.now() < deadline) {
        const runs = join(root, ".hone-runs");
        const ids = existsSync(runs) ? readdirSync(runs) : [];
        const candidate = ids[0];
        if (candidate !== undefined && readLogLines(root, candidate).some((l) => l.includes('"run.finished"'))) {
          runId = candidate;
          break;
        }
        await sleep(100);
      }
      expect(runId).not.toBeNull();
      if (runId === null) throw new Error("unreachable");
      const runDir = join(root, ".hone-runs", runId);

      // The sentinel survives run.finished (no unlink on the return path)…
      const pid = readSupervisorPid(runDir);
      expect(pid).not.toBeNull();
      if (pid === null) throw new Error("unreachable");
      expect(pidAlive(pid)).toBe(true);
      // …and nothing has been applied yet.
      const before = spawnSync("git", ["-C", repo, "show-ref", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
      expect(before.status).not.toBe(0);

      const { io } = makeIo(root);
      const code = await stopCommand(["--take-best", "--repo", "repo"], io);
      expect(code).toBe(0);
      // stop returned only after REAL death; only then was best applied.
      expect(pidAlive(pid)).toBe(false);
      expect(gitIn(repo, "show", `hone/${runId}:hello.txt`)).toBe("improved");
    } finally {
      killTree(child);
    }
  });
});

describe("termination barrier (P1: backend settle must not cancel the group SIGKILL)", () => {
  it("a TERM-ignoring registered child is dead before the supervisor exits", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const pidFile = join(root, "ignoring-child.pid");
    // The backend registers a TERM-trapping child, requests the stop, and
    // SETTLES — with the old timer-pool escalation, settling canceled the
    // pending SIGKILL and the child outlived run.finished.
    writeFileSync(
      join(root, "barrier-backend.mjs"),
      `import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      export function createBackend() {
        return {
          async start(ctx) {
            const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
            ctx.registerChild({ pid: child.pid, kill: (s) => child.kill(s) });
            writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
            await new Promise((r) => setTimeout(r, 150));
            process.kill(process.pid, "SIGTERM");
          },
        };
      }
      `,
    );
    const r = await hone(["run", "capsule", "--headless", "--backend", "./barrier-backend.mjs"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "300" },
    });
    expect(r.code, r.stderr).toBe(0);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(childPid)).toBe(true);
    // The supervisor has exited (hone resolved) — the barrier must have
    // SIGKILLed the TERM-ignoring child before the terminal event, so it is
    // certainly dead now.
    expect(pidAlive(childPid)).toBe(false);
    const runId = soleRunId(root);
    const events = runEvents(root, runId);
    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("stopped");
  });
});

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

/** A drift-free capsule the REAL local backend accepts (validateCapsule + broker asset preflight). */
function validCapsule(root: string): { capsuleDir: string; manifest: CapsuleManifest } {
  const capsuleDir = join(root, "capsule");
  mkdirSync(join(capsuleDir, "assets", "train"), { recursive: true });
  mkdirSync(join(capsuleDir, "assets", "validation"), { recursive: true });
  mkdirSync(join(capsuleDir, "protected"), { recursive: true });
  writeFileSync(join(capsuleDir, "assets", "train", "data.txt"), "train\n");
  writeFileSync(join(capsuleDir, "assets", "validation", "data.txt"), "val\n");
  writeFileSync(join(capsuleDir, "protected", "keep.txt"), "keep\n");
  const baseline = join(capsuleDir, "baseline");
  initScratchRepo(baseline);
  const commit = gitIn(baseline, "rev-parse", "HEAD");
  const trainSha = `sha256:${createHash("sha256").update(readFileSync(join(capsuleDir, "assets", "train", "data.txt"))).digest("hex")}`;
  const manifest = CapsuleManifest.parse(
    manifestRaw({
      baseline: { kind: "git", commit },
      contentHashes: { "assets/train/data.txt": trainSha },
    }),
  );
  writeFileSync(join(capsuleDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { capsuleDir, manifest };
}

describe("abort during resume startup (P1: reconcile before any terminal)", () => {
  it("a pre-aborted start still reconciles the broker journal and never launches the optimizer", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_seed");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(root, ".hone-cas"), { recursive: true });
    const { capsuleDir, manifest } = validCapsule(root);

    // Crash-window fixture: the broker journal is one promotion AHEAD of the
    // event log. (Journal line format owned by @hone/broker RunStateLog.)
    const durable = fakeHash("d");
    writeFileSync(
      join(runDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "incumbent", hash: durable, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 0 })}\n`,
    );
    appendEvent(runDir, {
      runId: "run_seed",
      at: at(),
      type: "run.started",
      capsuleId: manifest.id,
      contractHash: fakeHash("c"),
      optimizerDigest: "unpinned",
    });

    const marker = join(root, "optimizer-ran");
    const optimizerEntry = join(root, "opt.mjs");
    writeFileSync(optimizerEntry, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`);

    const abort = new AbortController();
    abort.abort(new Error("stop requested")); // stop landed BEFORE startup
    const run: RunCommand = () => Promise.resolve(res()); // every docker call succeeds
    const backend = createBackend({ run });
    let registeredBarrier: Promise<void> | null = null;
    const ctx: RunnerBackendContext = {
      runId: "run_seed",
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
      }),
      env: {
        PATH: process.env["PATH"] ?? "",
        HONE_EGRESS: "socket",
        HONE_OPTIMIZER_CMD: process.execPath,
        HONE_OPTIMIZER_ENTRY: optimizerEntry,
      },
      replayed: replayRun(runDir),
      signal: abort.signal,
      emit: (event) => appendEvent(runDir, event),
      registerChild: () => {},
      registerAuthorityBarrier: (b) => {
        registeredBarrier = b;
      },
    };

    await backend.start(ctx);

    // The trusted-authority barrier was registered synchronously and settles
    // resolved: the supervisor may fence/terminalize.
    expect(registeredBarrier).not.toBeNull();
    await expect(registeredBarrier).resolves.toBeUndefined();

    // Abort was honored only AFTER reconciliation: the optimizer never ran…
    expect(existsSync(marker)).toBe(false);
    // …but the durable incumbent reached events.ndjson, so the terminal
    // event the supervisor emits next records the RECOVERED best, not a
    // stale/null one that would strand the promotion forever.
    const incumbents = readEvents(runDir).filter((e) => e.type === "incumbent.new");
    expect(incumbents.length).toBe(1);
    expect(bestArtifact(replayRun(runDir))?.hash).toBe(durable);
  });
});

describe("trusted authority barrier (P1: hard-stop must not fence a pending recovery)", () => {
  it("a recovery finishing after the hard-stop still lands the incumbent before the terminal", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    // 1s wall budget triggers the abort; grace 100ms puts hardStop at ~2.1s.
    makeCapsule(root, { budget: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 1, maxEvaluatorInvocations: 100 } });
    const recovered = fakeHash("d");
    writeFileSync(
      join(root, "slow-recovery-backend.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            // Node 18 has no Promise.withResolvers — executor form required in this fixture.
            let resolveBarrier;
            const barrier = new Promise((r) => { resolveBarrier = r; });
            ctx.registerAuthorityBarrier(barrier); // synchronous, before the first await
            const at = () => new Date().toISOString();
            ctx.emit({ runId: ctx.runId, at: at(), type: "episode.started", episode: 0, parent: { hash: "${fakeHash("b")}" } });
            // Deliberately slower than abort(1s) + grace(100ms) + 1s hard stop:
            // the docker-bound setup + journal reconcile is still running when
            // the supervisor's race gives up on the backend.
            await new Promise((r) => setTimeout(r, 3200));
            ctx.emit({ runId: ctx.runId, at: at(), type: "incumbent.new", artifact: { hash: "${recovered}" }, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 0 });
            resolveBarrier();
          },
        };
      }
      `,
    );
    const { io } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "100" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./slow-recovery-backend.mjs"], io);
    expect(code).toBe(0);

    const runId = soleRunId(root);
    const events = runEvents(root, runId);
    const types = events.map((e) => e.type);
    // The recovered incumbent PRECEDES the terminal event instead of being fenced away…
    expect(types.indexOf("incumbent.new")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("incumbent.new")).toBeLessThan(types.indexOf("run.finished"));
    expect(types[types.length - 1]).toBe("run.finished");
    // …and the terminal best is the durable one.
    const finished = events[events.length - 1];
    if (finished?.type === "run.finished") {
      expect(finished.status).toBe("budget");
      expect(finished.best?.hash).toBe(recovered);
    }
  });

  it("a rejected barrier fails the run with NO terminal event and no delivery — resumable", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    initScratchRepo(root);
    makeCapsule(root);
    writeFileSync(
      join(root, "failing-recovery-backend.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            // Node 18 has no Promise.withResolvers — executor form required in this fixture.
            let rejectBarrier;
            const barrier = new Promise((_, rej) => { rejectBarrier = rej; });
            ctx.registerAuthorityBarrier(barrier);
            const err = new Error("broker journal unreadable");
            rejectBarrier(err);
            throw err;
          },
        };
      }
      `,
    );
    const { io, err } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "100" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./failing-recovery-backend.mjs", "--apply", "branch"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/trusted authority recovery failed/);

    const runId = soleRunId(root);
    const types = runEvents(root, runId).map((e) => e.type);
    // Nothing sealed, nothing applied: the run stays resumable.
    expect(types).not.toContain("run.finished");
    expect(types).not.toContain("delivery.applied");
    expect(replayRun(join(root, ".hone-runs", runId)).finished).toBeNull();
  });
});

describe("dead-supervisor seal guard (P1: stop must not finalize stale events)", () => {
  const baseline = fakeHash("b");

  function crashedRun(root: string, runId: string, journalLines: unknown[] | null): string {
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash: baseline, bestHash: best, finished: false }));
    if (journalLines !== null) {
      writeFileSync(join(runDir, "broker-state.ndjson"), `${journalLines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    }
    return runDir;
  }

  // fixtureEvents' single public incumbent: bestHash / 0.62 / 0.12 / episode 0.
  const alignedLine = (hash: string): Record<string, unknown> => ({ t: "incumbent", hash, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 });

  it("refuses to finalize or apply when the journal is a promotion ahead of the events", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const runId = "run_seal1";
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const durable = fakeHash("e");
    const runDir = crashedRun(root, runId, [
      alignedLine(best),
      { t: "incumbent", hash: durable, aggregate: 0.8, deltaVsBaseline: 0.3, episode: 1 }, // never reached events
    ]);
    const { io, err } = makeIo(root);
    const code = await stopCommand(["--take-best", "--repo", "repo"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/resume required/);
    // append nothing, apply nothing
    expect(readEvents(runDir).some((e) => e.type === "run.finished")).toBe(false);
    const ref = spawnSync("git", ["-C", repo, "show-ref", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
    expect(ref.status).not.toBe(0);
  });

  it("finalizes normally when the journal and events are exactly aligned", async () => {
    const root = makeRoot();
    const runId = "run_seal2";
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash: baseline, bestHash: best, finished: false }));
    writeFileSync(join(runDir, "broker-state.ndjson"), `${JSON.stringify(alignedLine(best))}\n`);
    const { io } = makeIo(root);
    expect(await stopCommand([], io)).toBe(0);
    const last = readEvents(runDir).at(-1);
    expect(last?.type).toBe("run.finished");
    if (last?.type === "run.finished") expect(last.status).toBe("stopped");
  });

  it("fails closed on a corrupt journal", async () => {
    const root = makeRoot();
    const runId = "run_seal3";
    const runDir = crashedRun(root, runId, null);
    writeFileSync(join(runDir, "broker-state.ndjson"), 'not json at all\n{"t":"incumbent"}\n');
    const { io, err } = makeIo(root);
    expect(await stopCommand([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/resume required/);
    expect(readEvents(runDir).some((e) => e.type === "run.finished")).toBe(false);
  });

  it("still finalizes legacy/stub runs that never had a journal", async () => {
    const root = makeRoot();
    const runDir = crashedRun(root, "run_seal4", null);
    const { io } = makeIo(root);
    expect(await stopCommand([], io)).toBe(0);
    expect(readEvents(runDir).at(-1)?.type).toBe("run.finished");
  });
});
