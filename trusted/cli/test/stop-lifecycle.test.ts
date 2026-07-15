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
import { pidAlive, readSupervisorPid } from "../src/supervisor.js";
import type { RunnerBackendContext } from "../src/types.js";
import {
  fakeHash,
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
    };

    await backend.start(ctx);

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
