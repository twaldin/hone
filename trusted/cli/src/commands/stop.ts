import { basename } from "node:path";
import { UsageError, boolFlag, parseFlags, strFlag } from "../args.js";
import { incumbentsAligned, readJournalIncumbents } from "../backends/local.js";
import { appendEvent, readEvents, replayRun } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { sleep } from "../promise.js";
import { resolveRun } from "../runs.js";
import { acquireRunLock, pidAlive, probeRunLockIdentity, readSupervisorSentinel } from "../supervisor.js";
import { applyBest } from "./apply.js";

interface StopFlags {
  takeBest: boolean;
  repo: string | undefined;
  branch: string | undefined;
}

/**
 * The sentinel PID confirmed against the live run-lock holder's identity
 * metadata, or null. PIDs recycle: a live pid in supervisor.json is NEVER
 * trusted (let alone signalled) unless the run lock is live (kernel-level
 * connect) AND its metadata names the exact same pid/nonce/runId — a bare
 * live PID with no matching lock is an unrelated process wearing a recycled
 * number. The probe needs no event-loop progress from the holder, so a
 * supervisor blocked in synchronous delivery is still confirmable.
 */
async function confirmedSupervisorPid(runDir: string, runId: string): Promise<number | null> {
  const sentinel = readSupervisorSentinel(runDir);
  if (sentinel === null || sentinel.nonce === undefined || !pidAlive(sentinel.pid)) return null;
  const lock = await probeRunLockIdentity(runDir);
  if (lock === null || lock.pid !== sentinel.pid || lock.nonce !== sentinel.nonce || lock.runId !== runId) return null;
  return sentinel.pid;
}

/**
 * Stop a run. A live, identity-confirmed supervisor is SIGTERM'd and awaited
 * (terminal event + lock release + process death). A dead run is finalized
 * as stopped — but ONLY while holding the same per-run lock the supervisor
 * uses and only when the broker journal is aligned, so a concurrent resume
 * and this finalization can never both write authority, and no stale state
 * is ever sealed or applied. --take-best lands the incumbent on a branch.
 */
export async function stopCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { booleans: ["take-best"], strings: ["run", "repo", "branch"] });
  const runDir = resolveRun(io.root, strFlag(flags, "run"));
  const runId = replayRun(runDir).runId ?? basename(runDir);
  const stopFlags: StopFlags = { takeBest: boolFlag(flags, "take-best"), repo: strFlag(flags, "repo"), branch: strFlag(flags, "branch") };

  // The run's state machine can move underneath us — a concurrent resume can
  // acquire the run lock between our reads. Loop over a bounded number of
  // observations; the terminal-appending path only ever runs UNDER the lock,
  // so exactly one authority path (resume or finalization) wins.
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = replayRun(runDir);
    const confirmed = await confirmedSupervisorPid(runDir, runId);

    if (state.finished !== null) {
      if (confirmed !== null) {
        // Terminal logged but the confirmed supervisor still holds its lock
        // (draining delivery/teardown). Wait for release AND death — the pid
        // was identity-confirmed live, so waiting on it is bound to the real
        // supervisor, never a recycled number.
        // The initial identity proof is the authorization to wait. Do not
        // re-probe during teardown: each probe is a live lock-server
        // connection, and a polling storm can delay server.close() and thus
        // the very process exit this loop awaits.
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (!pidAlive(confirmed)) break;
          await sleep(200);
        }
        if (pidAlive(confirmed)) {
          io.err(`run ${runId}: run.finished is logged but the supervisor (pid ${confirmed}) has not exited within 15s`);
          return 1;
        }
      }
      io.out(`run ${runId} already finished (${state.finished.status})`);
      return takeBest(stopFlags, io, runDir);
    }

    if (confirmed !== null) {
      process.kill(confirmed, "SIGTERM");
      // Terminal order: callers apply the result right after we return, so
      // wait for the terminal event, the lock release, AND process death.
      // The initial identity proof is enough: no further signal is sent, and
      // process death implies superviseRun's awaited lock release completed.
      // Re-probing here would keep feeding connections into that release.
      const deadline = Date.now() + 15_000;
      let live = replayRun(runDir);
      while (Date.now() < deadline) {
        live = replayRun(runDir);
        if (live.finished !== null && !pidAlive(confirmed)) break;
        await sleep(200);
      }
      if (live.finished === null) {
        io.err(`run ${runId}: supervisor (pid ${confirmed}) did not finish within 15s`);
        return 1;
      }
      if (pidAlive(confirmed)) {
        io.err(`run ${runId}: run.finished is logged but the supervisor (pid ${confirmed}) has not exited within 15s`);
        return 1;
      }
      io.out(`run ${runId} stopped (${live.finished.status})`);
      return takeBest(stopFlags, io, runDir);
    }

    // No identity-confirmed supervisor: dead run, stale/unrelated sentinel,
    // or a holder that has not written its sentinel yet. Finalization NEVER
    // happens without the run lock — and never signals an unconfirmed PID.
    let release: () => Promise<void>;
    try {
      release = await acquireRunLock(runDir, runId);
    } catch (e) {
      if (e instanceof UsageError) {
        // Someone owns the run right now (e.g. a resume between lock and
        // sentinel write) — observe its outcome and retry.
        await sleep(150);
        continue;
      }
      throw e;
    }
    try {
      // Re-validate UNDER the lock: a resume may have started and finished
      // between our observation and this acquisition. Holding the lock also
      // proves no supervisor is live — a still-alive sentinel PID here is a
      // recycled number and must NOT block finalization (or be signalled).
      const under = replayRun(runDir);
      if (under.finished !== null) continue;

      // Seal guard: never finalize from stale events — the fsynced broker
      // journal may hold promotions the event sink never saw. No journal =
      // stub/legacy run; corruption or mismatch fails CLOSED.
      try {
        const journal = readJournalIncumbents(runDir);
        if (journal !== null && !incumbentsAligned(journal, readEvents(runDir))) {
          io.err(
            `run ${runId}: the broker journal holds incumbent authority the event log never saw — resume required (\`hone run --resume\`) before stop or apply`,
          );
          return 1;
        }
      } catch (e) {
        io.err(`run ${runId}: ${e instanceof Error ? e.message : String(e)} — resume required; refusing to finalize`);
        return 1;
      }

      const best = under.incumbent?.artifact ?? null;
      appendEvent(runDir, {
        runId,
        at: new Date().toISOString(),
        type: "run.finished",
        ...(best !== null ? { best } : {}),
        status: "stopped",
      });
      io.out(`run ${runId}: supervisor not running — finalized log as stopped`);
      return takeBest(stopFlags, io, runDir);
    } finally {
      await release();
    }
  }

  io.err(`run ${runId}: run state kept changing underneath stop (live resume contention) — retry \`hone stop\``);
  return 1;
}

function takeBest(flags: StopFlags, io: CmdIo, runDir: string): Promise<number> | number {
  if (!flags.takeBest) return 0;
  return applyBest(io, { runDir, repo: flags.repo, branch: flags.branch });
}
