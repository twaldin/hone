import { basename } from "node:path";
import { parseFlags, strFlag } from "../args.js";
import { replayRun } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { formatDelta, formatSpend } from "../report.js";
import { resolveRun } from "../runs.js";

export async function statusCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { strings: ["run"] });
  const runDir = resolveRun(io.root, strFlag(flags, "run"));
  const state = replayRun(runDir);
  io.out(`run: ${state.runId ?? basename(runDir)}`);
  io.out(`capsule: ${state.capsuleId ?? "(unknown)"}`);
  io.out(`status: ${state.status}`);
  io.out(`cursor: ${state.cursor}`);
  io.out(`episodes: ${state.episodes.size}`);
  if (state.incumbent !== null) {
    io.out(`incumbent: ${state.incumbent.artifact.hash} (episode ${state.incumbent.episode})`);
    io.out(`aggregate: ${state.incumbent.aggregate} (non-holdout search score)`);
    io.out(`delta vs baseline: ${formatDelta(state.incumbent.deltaVsBaseline)}`);
  } else {
    io.out("incumbent: (none yet)");
  }
  io.out(`spend: ${formatSpend(state.lastBudget)}`);
  return 0;
}
