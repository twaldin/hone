import { parseFlags, strFlag } from "../args.js";
import { replayRun } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { formatDelta, formatSpend } from "../report.js";
import { resolveRun } from "../runs.js";

/** Anytime scorecard for the current incumbent (review VI.4). */
export async function bestCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { strings: ["run"] });
  const runDir = resolveRun(io.root, strFlag(flags, "run"));
  const state = replayRun(runDir);
  if (state.incumbent === null) {
    io.err("no incumbent yet — the run has not produced a scoring candidate");
    return 1;
  }
  io.out(`best: ${state.incumbent.artifact.hash}`);
  io.out(`aggregate: ${state.incumbent.aggregate} (validation — not holdout)`);
  io.out(`delta vs baseline: ${formatDelta(state.incumbent.deltaVsBaseline)}`);
  io.out(`episode: ${state.incumbent.episode}`);
  io.out(`spend: ${formatSpend(state.lastBudget)}`);
  return 0;
}
