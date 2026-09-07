import { parseFlags, strFlag } from "../args.js";
import { alignedAuthoritySnapshot } from "../authority.js";
import type { CmdIo } from "../io.js";
import { formatDelta, formatSpend } from "../report.js";
import { resolveRun } from "../runs.js";

/** Anytime scorecard for the current incumbent (review VI.4). */
export async function bestCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { strings: ["run"] });
  const runDir = resolveRun(io.root, strFlag(flags, "run"));
  // Refuse a stale scorecard: the journal may hold a newer incumbent the
  // public log never saw (crash window) — report ONLY the replay whose
  // alignment the helper just proved, never an earlier separate read.
  const snapshot = alignedAuthoritySnapshot(runDir, io);
  if (!snapshot.aligned) return 1;
  const { state } = snapshot;
  if (state.incumbent === null) {
    io.err("no incumbent yet — the run has not produced a scoring candidate");
    return 1;
  }
  io.out(`best: ${state.incumbent.artifact.hash}`);
  io.out(`aggregate: ${state.incumbent.aggregate} (non-holdout search score)`);
  io.out(`delta vs baseline: ${formatDelta(state.incumbent.deltaVsBaseline)}`);
  io.out(`episode: ${state.incumbent.episode}`);
  io.out(`spend: ${formatSpend(state.lastBudget)}`);
  return 0;
}
