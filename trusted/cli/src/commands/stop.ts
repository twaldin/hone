import { basename } from "node:path";
import { boolFlag, parseFlags, strFlag } from "../args.js";
import { appendEvent, replayRun } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { sleep } from "../promise.js";
import { resolveRun } from "../runs.js";
import { pidAlive, readSupervisorPid } from "../supervisor.js";
import { applyBest } from "./apply.js";


/**
 * Stop a run: SIGTERM the live supervisor and wait for its run.finished; if
 * the supervisor is already dead (crash), finalize the log as stopped so the
 * anytime surface settles. --take-best additionally lands the incumbent on a
 * branch (same path as `hone apply --best`).
 */
export async function stopCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { booleans: ["take-best"], strings: ["run", "repo", "branch"] });
  const runDir = resolveRun(io.root, strFlag(flags, "run"));
  let state = replayRun(runDir);
  const runId = state.runId ?? basename(runDir);

  const pid = readSupervisorPid(runDir);

  if (state.finished !== null) {
    // The PID sentinel outlives run.finished by design (it is removed only
    // at real process exit): a supervisor may still be draining teardown or
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
  } else {
    if (pid !== null && pidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      // Terminal order: callers apply the result right after we return, so
      // wait for BOTH run.finished AND actual supervisor exit — a lingering
      // process could still be draining delivery or killing children.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        state = replayRun(runDir);
        if (state.finished !== null && !pidAlive(pid)) break;
        await sleep(200);
      }
      if (state.finished === null) {
        io.err(`run ${runId}: supervisor (pid ${pid}) did not finish within 15s`);
        return 1;
      }
      if (pidAlive(pid)) {
        io.err(`run ${runId}: run.finished is logged but the supervisor (pid ${pid}) has not exited within 15s`);
        return 1;
      }
      io.out(`run ${runId} stopped (${state.finished.status})`);
    } else {
      // Crash finalization: no live supervisor, no run.finished — settle the log.
      const best = state.incumbent?.artifact ?? null;
      appendEvent(runDir, {
        runId,
        at: new Date().toISOString(),
        type: "run.finished",
        ...(best !== null ? { best } : {}),
        status: "stopped",
      });
      io.out(`run ${runId}: supervisor not running — finalized log as stopped`);
    }
  }

  if (boolFlag(flags, "take-best")) {
    return applyBest(io, {
      runDir,
      repo: strFlag(flags, "repo"),
      branch: strFlag(flags, "branch"),
    });
  }
  return 0;
}
