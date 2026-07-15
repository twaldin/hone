import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boolFlag, parseFlags, strFlag } from "../args.js";
import { extractWorkspaceArtifact } from "../artifact.js";
import { bestArtifact, replayRun } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { casRoot, resolveRun } from "../runs.js";

/**
 * Baseline vs incumbent, as a git diff over the unpacked CAS artifacts —
 * value preview AND evaluator-misalignment alarm (review VI.4). Never touches
 * any repository: both sides are temp extractions.
 */
export async function diffCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { booleans: ["stat"], strings: ["run"] });
  const runDir = resolveRun(io.root, strFlag(flags, "run"));
  const state = replayRun(runDir);
  const baseline = state.baselineArtifact;
  if (baseline === null) throw new Error("no baseline artifact in the log yet (no episode has started)");
  const best = bestArtifact(state);
  if (best === null) throw new Error("no incumbent yet — nothing to diff against the baseline");

  const scratch = mkdtempSync(join(tmpdir(), "hone-diff-"));
  try {
    const a = join(scratch, "baseline");
    const b = join(scratch, "incumbent");
    // Same validated, workspace-stripped extraction as delivery: adversarial
    // tars (links, traversal, .git) are rejected before touching the tmp dirs.
    extractWorkspaceArtifact(casRoot(io.root), baseline.hash, a);
    extractWorkspaceArtifact(casRoot(io.root), best.hash, b);
    const gitArgs = ["-c", "core.pager=cat", "diff", "--no-index"];
    if (boolFlag(flags, "stat")) gitArgs.push("--stat");
    gitArgs.push("--src-prefix=baseline/", "--dst-prefix=incumbent/", a, b);
    const r = spawnSync("git", gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr.trim()}`);
    io.out(`# baseline  ${baseline.hash}`);
    io.out(`# incumbent ${best.hash} (selected by non-holdout search score)`);
    io.out(r.stdout.replaceAll(`${a}/`, "").replaceAll(`${b}/`, ""));
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
