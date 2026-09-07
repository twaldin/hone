import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { boolFlag, parseFlags, strFlag } from "../args.js";
import { extractWorkspaceArtifact } from "../artifact.js";
import { alignedAuthoritySnapshot } from "../authority.js";
import { gitTimeoutError, gitTimeoutMs } from "../git-bound.js";
import { bestArtifact } from "../eventlog.js";
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
  // A diff over a public log the journal has outrun previews the WRONG
  // incumbent — preview ONLY the replay the alignment check vouched for,
  // never a separate earlier read the journal may have outrun.
  const snapshot = alignedAuthoritySnapshot(runDir, io);
  if (!snapshot.aligned) return 1;
  const { state } = snapshot;
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
    // Sealed, configless git env: the preview must never execute a
    // caller-supplied GIT_EXTERNAL_DIFF / difftool / textconv helper or
    // load hostile system/global config — only PATH survives.
    const env: Record<string, string> = {
      PATH: io.env["PATH"] ?? process.env["PATH"] ?? "",
      HOME: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: devNull,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      LC_ALL: "C",
    };
    const gitArgs = ["-c", "core.pager=cat", "diff", "--no-index", "--no-ext-diff", "--no-textconv"];
    if (boolFlag(flags, "stat")) gitArgs.push("--stat");
    gitArgs.push("--src-prefix=baseline/", "--dst-prefix=incumbent/", a, b);
    // Bounded like every trusted git helper (git-bound.ts): a wedged git or
    // hostile extraction must fail the preview closed, never hang the CLI.
    const timeout = gitTimeoutMs();
    const r = spawnSync("git", gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env, timeout, killSignal: "SIGKILL" });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || r.signal === "SIGKILL") {
        throw gitTimeoutError("git diff --no-index", timeout);
      }
      throw r.error;
    }
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr.trim()}`);
    io.out(`# baseline  ${baseline.hash}`);
    io.out(`# incumbent ${best.hash} (selected by non-holdout search score)`);
    io.out(r.stdout.replaceAll(`${a}/`, "").replaceAll(`${b}/`, ""));
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
