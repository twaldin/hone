import { basename, resolve } from "node:path";
import { UsageError, boolFlag, parseFlags, strFlag } from "../args.js";
import { deliver } from "../deliver.js";
import { bestArtifact, replayRun } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { casRoot, resolveRun } from "../runs.js";

const APPLY_USAGE = "usage: hone apply --best [--branch NAME] [--run ID] [--repo DIR]";

export interface ApplyBestOptions {
  runDir?: string | undefined;
  runId?: string | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
}

/**
 * Manual anytime apply: land the current best on a branch of the target repo,
 * mid-run or after — never the working tree, never stopping the run.
 */
export async function applyBest(io: CmdIo, opts: ApplyBestOptions): Promise<number> {
  const runDir = opts.runDir ?? resolveRun(io.root, opts.runId);
  const state = replayRun(runDir);
  const best = bestArtifact(state);
  if (best === null) {
    io.err("no incumbent artifact to apply yet");
    return 1;
  }
  const runId = state.runId ?? basename(runDir);
  const result = deliver({
    mode: "branch",
    repo: opts.repo !== undefined ? resolve(io.root, opts.repo) : io.root,
    runId,
    artifact: best.hash,
    casDir: casRoot(io.root),
    ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
    improverSeat: false,
    env: io.env,
  });
  io.out(`applied ${best.hash} to branch ${result.ref ?? "(none)"}`);
  for (const note of result.notes) io.err(note);
  return 0;
}

export async function applyCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { booleans: ["best"], strings: ["branch", "run", "repo"] });
  if (!boolFlag(flags, "best")) throw new UsageError(APPLY_USAGE);
  try {
    return await applyBest(io, {
      runId: strFlag(flags, "run"),
      repo: strFlag(flags, "repo"),
      branch: strFlag(flags, "branch"),
    });
  } catch (e) {
    if (e instanceof UsageError) throw e;
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
