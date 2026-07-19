import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, RunConfig, RunEvent, capsuleDigest } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { freezeCapsuleAssets } from "../src/admission.js";
import { createBackend } from "../src/backends/local.js";
import { defaultApplyBranch } from "../src/commands/apply.js";
import { stopCommand } from "../src/commands/stop.js";
import { appendEvent, bestArtifact, readEvents, replayRun } from "../src/eventlog.js";
import { sleep } from "../src/promise.js";
import { acquireRunLock, pidAlive, readSupervisorPid, runCommand as cliRunCommand } from "../src/supervisor.js";
import type { RunnerBackendContext } from "../src/types.js";
import {
  FIX_IMAGE,
  scriptedCreateHelper,
  fakeHash,
  fakeOptimizerSpawn,
  fixtureEvents,
  gitIn,
  hone,
  honeSpawn,
  initScratchRepo,
  killTree,
  makeCapsule,
  makeGitBaselineCapsule,
  sealGitBaselineSnapshot,
  makeIo,
  makeRoot,
  manifestRaw,
  readLogLines,
  tarToCas,
  writeAlignedDispatchJournal,
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
    const { baselineDir } = makeGitBaselineCapsule(root);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    writeFileSync(join(root, "delivering-backend.mjs"), incumbentBackendSrc(hash));

    // PATH shim: the first delivery plumbing call (hash-object — used only
    // inside deliver()) TERMs its parent (the supervisor itself) — a real
    // signal deterministically inside the synchronous delivery window — then
    // delegates to the real git. Creation-time target validation and the
    // delivery's remaining git calls pass straight through.
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "hash-object" ]; then kill -TERM $PPID 2>/dev/null; fi; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );

    const r = await hone(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--apply", "branch", "--repo", "capsule/baseline"], {
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
    expect(gitIn(baselineDir, "show", `hone/${runId}:hello.txt`)).toBe("improved");
  });
});

describe("external stop during blocked synchronous delivery (final gate: identity without holder event-loop progress)", () => {
  it("authenticates via lock metadata while the supervisor JS loop is blocked >5s; SIGTERM queues, delivery lands, run stops", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    const { baselineDir } = makeGitBaselineCapsule(root);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    writeFileSync(join(root, "delivering-backend.mjs"), incumbentBackendSrc(hash));

    // PATH shim: the FIRST hash-object invocation (delivery plumbing, used
    // only inside deliver() — the head of the synchronous delivery stretch)
    // drops a marker and blocks >5s in spawnSync — for that whole window the
    // supervisor's JS loop can run neither its lock accept handler nor its
    // SIGTERM handler. Creation-time target validation and all other git
    // calls pass straight through to the real git.
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const marker = join(root, "blocked.marker");
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "hash-object" ] && [ ! -f "${marker}" ]; then : > "${marker}"; sleep 6; fi; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );

    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "./delivering-backend.mjs", "--apply", "branch", "--repo", "capsule/baseline"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "200", PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    try {
      const armed = Date.now() + 30_000;
      while (!existsSync(marker) && Date.now() < armed) await sleep(50);
      expect(existsSync(marker)).toBe(true);

      const runId = soleRunId(root);
      const runDir = join(root, ".hone-runs", runId);
      const supPid = readSupervisorPid(runDir);
      expect(supPid).not.toBeNull();
      if (supPid === null) throw new Error("unreachable");
      expect(pidAlive(supPid)).toBe(true);

      // External stop DURING the blocked window: identity must be proven
      // without any holder socket response (metadata + kernel-level connect),
      // the SIGTERM queued, and stop must ride out the block — never report
      // contention or finalize over a live supervisor.
      const { io, err } = makeIo(root);
      const code = await stopCommand([], io);
      expect(code, err.join("\n")).toBe(0);
      // stop returning 0 means the identity-bound lock RELEASE completed —
      // the supervisor has nothing left but its exit report and drains now.
      const gone = Date.now() + 10_000;
      while (pidAlive(supPid) && Date.now() < gone) await sleep(50);
      expect(pidAlive(supPid)).toBe(false);

      const events = runEvents(root, runId);
      const types = events.map((e) => e.type);
      expect(types[types.length - 1]).toBe("run.finished");
      expect(types.filter((t) => t === "run.finished").length).toBe(1);
      const finished = events[events.length - 1];
      if (finished?.type === "run.finished") expect(finished.status).toBe("stopped");
      // The delivery the signal landed inside still finished atomically, before the terminal.
      const deliveryIdx = types.indexOf("delivery.applied");
      expect(deliveryIdx, types.join(",")).toBeGreaterThanOrEqual(0);
      expect(deliveryIdx).toBeLessThan(types.indexOf("run.finished"));
      expect(gitIn(baselineDir, "show", `hone/${runId}:hello.txt`)).toBe("improved");

      // The spawned process tree exits on its own after the stop.
      if (child.exitCode === null) {
        await new Promise<void>((resolveClose) => {
          child.once("close", () => resolveClose());
          setTimeout(resolveClose, 10_000);
        });
      }
    } finally {
      killTree(child);
    }
  });
});

describe("explicit stop before delivery (P1)", () => {
  it("skips automatic delivery entirely and terminates stopped", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const { baselineDir } = makeGitBaselineCapsule(root);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    // The backend itself requests the stop, then yields so the handler runs
    // BEFORE it settles — stopRequested is true when the delivery gate runs.
    writeFileSync(
      join(root, "stopping-backend.mjs"),
      incumbentBackendSrc(hash, `process.kill(process.pid, "SIGTERM"); await new Promise((r) => setTimeout(r, 150));`),
    );
    const r = await hone(["run", "capsule", "--headless", "--backend", "./stopping-backend.mjs", "--apply", "branch", "--repo", "capsule/baseline"], {
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
    const ref = spawnSync("git", ["-C", baselineDir, "show-ref", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
    expect(ref.status).not.toBe(0);
  });
});

describe("identity-bound stop wait (P1: --take-best must not race a draining supervisor)", () => {
  it("stop blocks while the confirmed lock holder drains, applies only after release + death", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const runId = "run_drain1";
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash: fakeHash("b"), bestHash: best, finished: true }));
    writeAlignedDispatchJournal(root, runId);
    // Manual take-best validates the --repo target against the run's sealed
    // git-baseline snapshot — bind this fixture run to the scratch repo.
    sealGitBaselineSnapshot(root, runId, repo);
    // A stand-in supervisor process that is still draining after run.finished.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    const helperPid = helper.pid;
    expect(helperPid).toBeDefined();
    if (helperPid === undefined) throw new Error("unreachable");
    const nonce = "nonce-drain-test";
    writeFileSync(join(runDir, "supervisor.json"), `${JSON.stringify({ pid: helperPid, runId, nonce })}\n`);
    // The held lock VOUCHES for the sentinel pid — this is the only license to wait on it.
    const release = await acquireRunLock(runDir, runId, { pid: helperPid, runId, nonce });
    try {
      const stopPromise = stopCommand(["--take-best", "--repo", "repo"], makeIo(root).io);
      await sleep(400); // stop is in its confirmed-drain wait
      // Nothing applied while the confirmed supervisor still holds the lock.
      const before = spawnSync("git", ["-C", repo, "show-ref", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
      expect(before.status).not.toBe(0);

      await release();
      helper.kill("SIGKILL"); // …then the supervisor process actually exits
      const code = await stopPromise;
      expect(code).toBe(0);
      // Death is certain (SIGKILL above) but reaping is event-loop-async:
      // yield until it is observable instead of depending on stop's own
      // duration (release — not a PID wait — is stop's completion signal;
      // a provably-never-contacted run now skips Docker and returns fast).
      const gone = Date.now() + 5_000;
      while (pidAlive(helperPid) && Date.now() < gone) await sleep(50);
      expect(pidAlive(helperPid)).toBe(false);
      expect(gitIn(repo, "show", `${defaultApplyBranch(runId, best)}:hello.txt`)).toBe("improved");
    } finally {
      try {
        helper.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});

describe("PID reuse (final gate: a bare live sentinel PID is not identity)", () => {
  it("never signals an unrelated live process named by a stale sentinel; finalizes under the lock instead", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runId = "run_reuse1";
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash: fakeHash("b"), bestHash: best, finished: false }));
    writeAlignedDispatchJournal(root, runId);
    writeFileSync(
      join(runDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "incumbent", hash: best, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 })}\n`,
    );
    // A live UNRELATED process wearing the recycled pid; it records any SIGTERM.
    const marker = join(root, "helper-signalled");
    const helper = spawn(
      process.execPath,
      ["-e", `process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "signalled")); setInterval(() => {}, 1000);`],
      { stdio: "ignore" },
    );
    const helperPid = helper.pid;
    expect(helperPid).toBeDefined();
    if (helperPid === undefined) throw new Error("unreachable");
    try {
      await sleep(400); // helper handler installed
      expect(pidAlive(helperPid)).toBe(true);
      // Stale sentinel points at the live helper — but NO lock vouches for it.
      writeFileSync(join(runDir, "supervisor.json"), `${JSON.stringify({ pid: helperPid, runId, nonce: "stale-nonce" })}\n`);

      const { io } = makeIo(root);
      const code = await stopCommand([], io);
      expect(code).toBe(0);

      // stop finalized the dead run under its own lock…
      const events = readEvents(runDir);
      const last = events.at(-1);
      expect(last?.type).toBe("run.finished");
      if (last?.type === "run.finished") expect(last.status).toBe("stopped");
      // …and the unrelated process was NEVER signalled and is still alive.
      expect(existsSync(marker)).toBe(false);
      expect(pidAlive(helperPid)).toBe(true);
    } finally {
      try {
        helper.kill("SIGKILL");
      } catch {
        // already gone
      }
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

/** A drift-free capsule the REAL local backend accepts (frozen admission + broker asset preflight). */
function validCapsule(root: string): { capsuleDir: string; manifest: CapsuleManifest; digest: string } {
  const baseline = join(root, "capsule", "baseline");
  initScratchRepo(baseline);
  const commit = gitIn(baseline, "rev-parse", "HEAD");
  const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit } });
  const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")));
  return { capsuleDir, manifest, digest: capsuleDigest(manifest) };
}

describe("abort during resume startup (P1: reconcile before any terminal)", () => {
  it("a pre-aborted start still reconciles the broker journal and never launches the optimizer", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_seed");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(root, ".hone-cas"), { recursive: true });
    const { capsuleDir, manifest, digest } = validCapsule(root);
    freezeCapsuleAssets(runDir, capsuleDir, manifest);

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
    const run: RunCommand = (argv) => {
      // Donor create must answer with a container id; the keeper's snapshot
      // exec publishes exactly the minted per-attempt HONE_SCRATCH_SNAPSHOT_OUT
      // basename into the bind-mounted dir — modeling the daemon, never
      // weakening production's fail-closed teardown.
      if (argv[1] === "info") return Promise.resolve(res({ stdout: Buffer.from("ENGINE-TEST\n") }));
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("d0n0r1d\n") }));
      const outArg = argv.find((a) => typeof a === "string" && a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
      if (argv[1] === "exec" && outArg !== undefined) {
        mkdirSync(join(runDir, "scratch-snapshot"), { recursive: true });
        writeFileSync(join(runDir, "scratch-snapshot", outArg.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length)), "");
      }
      return Promise.resolve(res());
    };
    const backend = createBackend({ run, spawnOptimizer: fakeOptimizerSpawn(FIX_IMAGE), createHelper: scriptedCreateHelper(run) });
    let registeredBarrier: Promise<void> | null = null;
    let cleanupBarrier: Promise<void> | null = null;
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
        HONE_OPTIMIZER_CMD: `${process.execPath} ${optimizerEntry}`,
      },
      capsuleDigest: digest,
      // Direct backend fixture: frozen assets/run.started already exist; this is the post-seal byte recheck.
      admissionReview: "off",
      optimizerDigest: fakeHash("0"),
      replayed: replayRun(runDir),
      signal: abort.signal,
      emit: (event) => appendEvent(runDir, event),
      registerChild: () => () => {},
      probeGate: () => Promise.resolve(true),
      requestStop: () => {},
      registerAuthorityBarrier: (b) => {
        registeredBarrier = b;
      },
      registerCleanupBarrier: (b) => {
        cleanupBarrier = b;
        void b.catch(() => {});
      },
    };

    await backend.start(ctx);

    // The trusted-authority barrier was registered synchronously and settles
    // resolved: the supervisor may fence/terminalize. The cleanup barrier
    // settles resolved too — the full teardown (donor fence + strict sweep)
    // completed; an unawaited rejection here would be a real teardown bug.
    expect(registeredBarrier).not.toBeNull();
    await expect(registeredBarrier).resolves.toBeUndefined();
    expect(cleanupBarrier).not.toBeNull();
    await expect(cleanupBarrier).resolves.toBeUndefined();

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
    makeGitBaselineCapsule(root);
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
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./failing-recovery-backend.mjs", "--apply", "branch", "--repo", "capsule/baseline"], io);
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
    writeAlignedDispatchJournal(root, runId);
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
    // A validated take-best target (stop now resolves it BEFORE any stop or
    // finalization) — the journal seal guard must be the surfaced refusal.
    sealGitBaselineSnapshot(root, runId, repo);
    const { io, err } = makeIo(root);
    const code = await stopCommand(["--take-best", "--repo", "repo"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/resume required/);
    // append nothing, apply nothing
    expect(readEvents(runDir).some((e) => e.type === "run.finished")).toBe(false);
    const ref = spawnSync("git", ["-C", repo, "show-ref", "--verify", `refs/heads/hone/${runId}`], { encoding: "utf8" });
    expect(ref.status).not.toBe(0);
  });

  it("refuses to seal when any non-incumbent broker event transaction is ahead", async () => {
    const root = makeRoot();
    const runId = "run_seal_events";
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const hidden = {
      runId,
      at: "2026-07-15T00:00:00.000Z",
      type: "episode.started",
      episode: 1,
      parent: { hash: best },
    };
    const runDir = crashedRun(root, runId, [
      alignedLine(best),
      { t: "episode", episode: 1, events: [hidden] },
    ]);
    const { io, err } = makeIo(root);
    expect(await stopCommand([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/event authority.*resume required/);
    expect(readEvents(runDir).some((event) => event.type === "run.finished")).toBe(false);
  });

  it("finalizes normally when the journal and events are exactly aligned", async () => {
    const root = makeRoot();
    const runId = "run_seal2";
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash: baseline, bestHash: best, finished: false }));
    writeAlignedDispatchJournal(root, runId);
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

describe("dead-stop vs concurrent resume (P1: crash finalization only under the run lock)", () => {
  it("a stop contending with a live resume defers; exactly one terminal, take-best applies the FINAL best", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const runId = "run_race1";
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const finalBest = tarToCas(root, { "hello.txt": "final\n" });
    const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash: fakeHash("b"), bestHash: best, finished: false }));
    writeAlignedDispatchJournal(root, runId);
    sealGitBaselineSnapshot(root, runId, repo);
    writeFileSync(
      join(runDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "incumbent", hash: best, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 })}\n`,
    );

    // Simulated resume winner: holds the run lock while stop starts.
    const release = await acquireRunLock(runDir, runId);
    const stopPromise = stopCommand(["--take-best", "--repo", "repo"], makeIo(root).io);
    await sleep(50); // stop observes dead+unfinished, loses the lock, enters its retry loop

    // The "resume" completes the run and releases the lock.
    appendEvent(runDir, { runId, at: at(), type: "run.resumed", fromCursor: 7 });
    appendEvent(runDir, { runId, at: at(), type: "incumbent.new", artifact: { hash: finalBest }, aggregate: 0.8, deltaVsBaseline: 0.3, episode: 1 });
    appendEvent(runDir, { runId, at: at(), type: "run.finished", best: { hash: finalBest }, status: "completed" });
    appendFileSync(
      join(runDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "incumbent", hash: finalBest, aggregate: 0.8, deltaVsBaseline: 0.3, episode: 1 })}\n`,
    );
    await release();

    const code = await stopPromise;
    expect(code).toBe(0);
    const events = readEvents(runDir);
    // exactly one authority path won; nothing was appended after its terminal
    expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
    expect(events.at(-1)?.type).toBe("run.finished");
    // take-best applied the FINAL best, never the stale pre-resume one
    expect(gitIn(repo, "show", `${defaultApplyBranch(runId, finalBest)}:hello.txt`)).toBe("final");
  });

  it("a stop that wins the lock finalizes exactly once; a following resume refuses", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const runId = "run_race2";
    const best = tarToCas(root, { "hello.txt": "improved\n" });
    const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash: fakeHash("b"), bestHash: best, finished: false }));
    writeAlignedDispatchJournal(root, runId);
    writeFileSync(
      join(runDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "incumbent", hash: best, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 })}\n`,
    );
    expect(await stopCommand([], makeIo(root).io)).toBe(0);
    await expect(cliRunCommand(["capsule", "--headless", "--resume", "--backend", "stub"], makeIo(root).io)).rejects.toThrow(/nothing to resume/);
    const events = readEvents(runDir);
    expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
    expect(events.some((e) => e.type === "run.resumed")).toBe(false);
  });
});

describe("durable supervisor sentinel (exit-hook ownership race)", () => {
  it("survives clean exit with a dead pid; the next locked supervisor overwrites, never unlinks", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    // Phase 1: a killed run leaves sentinel A (SIGKILL leftover).
    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "stub"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: "100", HONE_STUB_DELAY_MS: "100" },
    });
    let runDir: string | null = null;
    let pidA: number | null = null;
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const runs = join(root, ".hone-runs");
        const ids = existsSync(runs) ? readdirSync(runs) : [];
        const candidate = ids[0];
        if (candidate !== undefined) {
          runDir = join(runs, candidate);
          pidA = readSupervisorPid(runDir);
          // Boot order is unordered here: the sentinel can land before
          // events.ndjson exists. Keep polling through the gap — only a
          // sentinel + a started log means phase 1 is observable.
          if (pidA !== null && existsSync(join(runDir, "events.ndjson")) && readLogLines(root, candidate).length >= 2) break;
        }
        await sleep(100);
      }
    } finally {
      killTree(child);
    }
    expect(runDir).not.toBeNull();
    expect(pidA).not.toBeNull();
    if (runDir === null || pidA === null) throw new Error("unreachable");
    await sleep(400); // let the killed tree die
    expect(existsSync(join(runDir, "supervisor.json"))).toBe(true); // stale sentinel is the SAFE steady state

    // Phase 2: resume overwrites the sentinel under its lock and completes.
    const r = await hone(["run", "capsule", "--headless", "--backend", "stub", "--resume"], {
      cwd: root,
      env: { HONE_STUB_EPISODES: "100" },
    });
    expect(r.code, r.stderr).toBe(0);
    const pidB = readSupervisorPid(runDir);
    // Durable last-supervisor metadata REMAINS after clean exit (no exit
    // unlink — an exit hook could race a successor and delete ITS sentinel)…
    expect(pidB).not.toBeNull();
    if (pidB === null) throw new Error("unreachable");
    // …names the SUCCESSOR (locked overwrite), and is safely dead.
    expect(pidB).not.toBe(pidA);
    expect(pidAlive(pidB)).toBe(false);
    expect(readEvents(runDir).at(-1)?.type).toBe("run.finished");
  });
});
