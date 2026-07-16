import { parseFlags, strFlag } from "../args.js";
import { alignedAuthoritySnapshot } from "../authority.js";
import type { CmdIo } from "../io.js";
import { formatDelta, formatSpend } from "../report.js";
import { resolveRun } from "../runs.js";

export async function statusCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { strings: ["run"] });
  const runDir = resolveRun(io.root, strFlag(flags, "run"));
  // The broker journal is the durable authority; render ONLY the replay the
  // journal was proven against — a separate pre-gate replay could be a stale
  // view the alignment check never vouched for.
  const snapshot = alignedAuthoritySnapshot(runDir, io);
  if (!snapshot.aligned) return 1;
  const { runId, state } = snapshot;
  io.out(`run: ${runId}`);
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
