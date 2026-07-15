import { basename } from "node:path";
import { UsageError, boolFlag, parseFlags, strFlag } from "../args.js";
import { incumbentsAligned, readJournalIncumbents } from "../backends/local.js";
import { appendEvent, readEvents, replayRun } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { sleep } from "../promise.js";
import { resolveRun } from "../runs.js";
import { acquireRunLock, pidAlive, readSupervisorPid } from "../supervisor.js";
import { applyBest } from "./apply.js";

interface StopFlags {
  takeBest: boolean;
  repo: string | undefined;
  branch: string | undefined;
}

/**
 * Stop a run: SIGTERM the live supervisor and wait for its run.finished AND
 * its real process exit; if the supervisor is already dead (crash), finalize
 * the log as stopped — but ONLY while holding the same per-run lock the
 * supervisor uses, so a concurrent resume and this finalization can never
 * both write authority. --take-best additionally lands the incumbent on a
 * branch (same path as `hone apply --best`).
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
    const pid = readSupervisorPid(runDir);

    if (state.finished !== null) {
      // The PID sentinel outlives run.finished by design (removed only at
      // real process exit): a supervisor may still be draining teardown or
      // group kills. Whenever the sentinel names a live pid, wait for actual
      // death before returning — `--take-best` must never race a live run.
      if (pid !== null && pidAlive(pid)) {
        const deadline = Date.now() + 15_000;
        while (pidAlive(pid) && Date.now() < deadline) await sleep(200);
        if (pidAlive(pid)) {
          io.err(`run ${runId}: run.finished is logged but the supervisor (pid ${pid}) has not exited within 15s`);
          return 1;
        }
      }
      io.out(`run ${runId} already finished (${state.finished.status})`);
      return takeBest(stopFlags, io, runDir);
    }

    if (pid !== null && pidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      // Terminal order: callers apply the result right after we return, so
      // wait for BOTH run.finished AND actual supervisor exit — a lingering
      // process could still be draining delivery or killing children.
      const deadline = Date.now() + 15_000;
      let live = replayRun(runDir);
      while (Date.now() < deadline) {
        live = replayRun(runDir);
        if (live.finished !== null && !pidAlive(pid)) break;
        await sleep(200);
      }
      if (live.finished === null) {
        io.err(`run ${runId}: supervisor (pid ${pid}) did not finish within 15s`);
        return 1;
      }
      if (pidAlive(pid)) {
        io.err(`run ${runId}: run.finished is logged but the supervisor (pid ${pid}) has not exited within 15s`);
        return 1;
      }
      io.out(`run ${runId} stopped (${live.finished.status})`);
      return takeBest(stopFlags, io, runDir);
    }

    // Dead + unfinished: crash finalization. NEVER without the run lock — a
    // concurrent resume acquiring between our reads and our append would
    // leave a run executing past a terminal event.
    let release: () => Promise<void>;
    try {
      release = await acquireRunLock(runDir, runId);
    } catch (e) {
      if (e instanceof UsageError) {
        // A resume owns the run right now — observe its outcome and retry.
        await sleep(150);
        continue;
      }
      throw e;
    }
    try {
      // Re-validate UNDER the lock: a resume may have started (and even
      // finished) between our observation and this acquisition.
      const under = replayRun(runDir);
      const underPid = readSupervisorPid(runDir);
      if (under.finished !== null || (underPid !== null && pidAlive(underPid))) continue;

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
