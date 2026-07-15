import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyMode } from "@hone/schema";
import { extractWorkspaceArtifact, validateWorkspaceTar } from "./artifact.js";
import { casPath } from "./cas.js";

/**
 * Delivery modes (review VI.4 / IV.2). Invariant across ALL modes: the user's
 * working tree is never touched — branch/pr build in a throwaway worktree,
 * auto merges by ref-only plumbing (merge-tree + commit-tree + update-ref).
 */

export class LadderLockedError extends Error {}

export const LADDER_REFUSAL =
  "refusing apply mode 'auto' on an improver-seat run: the autonomy ladder is locked (set HONE_LADDER_OK=1 once the IV.2 criteria are met)";

export function ladderLocked(mode: ApplyMode, improverSeat: boolean, env: NodeJS.ProcessEnv): boolean {
  return mode === "auto" && improverSeat && env["HONE_LADDER_OK"] !== "1";
}

export function assertLadder(mode: ApplyMode, improverSeat: boolean, env: NodeJS.ProcessEnv): void {
  if (ladderLocked(mode, improverSeat, env)) throw new LadderLockedError(LADDER_REFUSAL);
}

export interface DeliverOptions {
  mode: ApplyMode;
  /** Target git repository — never the artifact staging area. */
  repo: string;
  runId: string;
  /** CAS hash of the artifact tar to deliver. */
  artifact: string;
  casDir: string;
  branch?: string;
  improverSeat: boolean;
  env: NodeJS.ProcessEnv;
}

export interface DeliverResult {
  /** The ref the artifact landed on (branch name), or null for mode=none. */
  ref: string | null;
  notes: string[];
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: string[], cwd?: string): ExecResult {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(repo: string, ...args: string[]): string {
  const r = exec("git", ["-C", repo, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export function isGitRepo(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return exec("git", ["-C", dir, "rev-parse", "--git-dir"]).code === 0;
  } catch {
    return false;
  }
}

/**
 * Run a git command in the delivery worktree with candidate-influence vectors
 * disabled: hooks point at an empty trusted dir and config-driven executable
 * knobs (fsmonitor) are cleared. Repo identity/config otherwise applies.
 */
function gitSafe(worktree: string, hooksDir: string, ...args: string[]): string {
  return git(worktree, "-c", `core.hooksPath=${hooksDir}`, "-c", "core.fsmonitor=", ...args);
}

/**
 * Reject staged gitlinks (mode 160000) and staged symlinks (mode 120000) —
 * defense-in-depth behind the tar-layout validation (a gitlink would let the
 * candidate smuggle an unreviewable commit reference into the delivery).
 */
export function assertNoStagedGitlinks(worktree: string): void {
  const staged = git(worktree, "ls-files", "--stage");
  for (const line of staged.split("\n")) {
    if (line.startsWith("160000 ")) {
      throw new Error(`staged index contains a gitlink (mode 160000): ${line.slice(line.indexOf("\t") + 1)} — rejected`);
    }
    if (line.startsWith("120000 ")) {
      throw new Error(`staged index contains a symlink (mode 120000): ${line.slice(line.indexOf("\t") + 1)} — rejected`);
    }
  }
}

/**
 * Unpack the artifact into a fresh worktree branch; the main working tree is
 * never touched. The artifact MUST be a single-`workspace/`-root tar of plain
 * files/dirs (validated pre-extraction); files land at the repo root with the
 * workspace component stripped.
 */
function branchDeliver(opts: DeliverOptions): { branch: string; commit: string } {
  const branch = opts.branch ?? `hone/${opts.runId}`;
  if (!isGitRepo(opts.repo)) throw new Error(`${opts.repo} is not a git repository`);
  if (exec("git", ["-C", opts.repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0) {
    throw new Error(`branch ${branch} already exists in ${opts.repo} — pass --branch to pick another name`);
  }
  const blob = casPath(opts.casDir, opts.artifact);
  if (!existsSync(blob)) throw new Error(`artifact ${opts.artifact} not found in CAS (${blob})`);
  // Reject adversarial layouts BEFORE the repo is mutated (branch/worktree):
  // a refused artifact must leave no trace in the target repository.
  validateWorkspaceTar(readFileSync(blob));

  const parent = mkdtempSync(join(tmpdir(), "hone-worktree-"));
  const worktree = join(parent, "wt");
  const hooksDir = join(parent, "no-hooks");
  mkdirSync(hooksDir);
  git(opts.repo, "worktree", "add", "-b", branch, worktree);
  let landed = false;
  try {
    for (const entry of readdirSync(worktree)) {
      if (entry === ".git") continue;
      rmSync(join(worktree, entry), { recursive: true, force: true });
    }
    // Validates layout (single workspace/ root, files/dirs only, no .git,
    // no traversal/links) and strips the workspace component.
    extractWorkspaceArtifact(opts.casDir, opts.artifact, worktree);
    gitSafe(worktree, hooksDir, "add", "-A");
    assertNoStagedGitlinks(worktree);
    if (gitSafe(worktree, hooksDir, "status", "--porcelain") !== "") {
      gitSafe(worktree, hooksDir, "commit", "-m", `hone(${opts.runId}): best artifact ${opts.artifact}`);
    }
    const commit = git(worktree, "rev-parse", "HEAD");
    landed = true;
    return { branch, commit };
  } finally {
    exec("git", ["-C", opts.repo, "worktree", "remove", "--force", worktree]);
    if (!landed) exec("git", ["-C", opts.repo, "branch", "-D", branch]);
    rmSync(parent, { recursive: true, force: true });
  }
}

/**
 * apply:pr is LOCAL-ONLY in the M0 seed: build the branch (throwaway
 * worktree, same as branch mode) and print the manual `gh pr create`
 * instruction. The trusted CLI never invokes gh, pushes, or touches the
 * network — opening the PR is a deliberate human act.
 */
function prDeliver(opts: DeliverOptions, notes: string[]): string {
  const { branch } = branchDeliver(opts);
  const title = `hone(${opts.runId}): apply best artifact`;
  const body = `Best artifact ${opts.artifact} from hone run ${opts.runId}.`;
  notes.push(
    `apply pr (local-only): branch ${branch} created — push it and open the PR yourself: git push -u origin ${branch} && gh pr create --head ${branch} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
  );
  return branch;
}

/**
 * auto = branch + ref-only merge into the repo's HEAD branch. No working tree
 * (the user's or anyone's) is written; a conflicted merge degrades to branch.
 */
function autoDeliver(opts: DeliverOptions, notes: string[]): string {
  const { branch } = branchDeliver(opts);
  let base: string;
  try {
    base = git(opts.repo, "symbolic-ref", "--short", "HEAD");
  } catch {
    notes.push(`repo HEAD is detached; left the result on branch ${branch}`);
    return branch;
  }
  const merge = exec("git", ["-C", opts.repo, "merge-tree", "--write-tree", base, branch]);
  if (merge.code !== 0) {
    notes.push(`auto-merge into ${base} has conflicts; left the result on branch ${branch}`);
    return branch;
  }
  const tree = merge.stdout.trim().split("\n")[0];
  if (tree === undefined || tree === "") {
    notes.push(`auto-merge produced no tree; left the result on branch ${branch}`);
    return branch;
  }
  const baseSha = git(opts.repo, "rev-parse", base);
  const branchSha = git(opts.repo, "rev-parse", branch);
  const commit = git(opts.repo, "commit-tree", tree, "-p", baseSha, "-p", branchSha, "-m", `hone(${opts.runId}): auto-apply ${branch}`);
  git(opts.repo, "update-ref", `refs/heads/${base}`, commit, baseSha);
  notes.push(`auto-applied to ${base} @ ${commit} (ref-only update; no working tree was written)`);
  return base;
}

export function deliver(opts: DeliverOptions): DeliverResult {
  assertLadder(opts.mode, opts.improverSeat, opts.env);
  const notes: string[] = [];
  switch (opts.mode) {
    case "none":
      return { ref: null, notes: ["apply mode none — report only; use `hone apply --best` to land it manually"] };
    case "branch": {
      const { branch, commit } = branchDeliver(opts);
      notes.push(`applied ${opts.artifact} to branch ${branch} @ ${commit}`);
      return { ref: branch, notes };
    }
    case "pr":
      return { ref: prDeliver(opts, notes), notes };
    case "auto":
      return { ref: autoDeliver(opts, notes), notes };
  }
}
