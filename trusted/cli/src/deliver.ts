import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyMode } from "@hone/schema";
import { extractWorkspaceArtifact, validateWorkspaceTar } from "./artifact.js";
import { casPath } from "./cas.js";

/**
 * Delivery modes (review VI.4 / IV.2). Invariant across ALL modes: the
 * target's working tree, index, and checkout machinery are never used. The
 * validated artifact is turned into a commit with pure object-database
 * plumbing (hash-object --no-filters → temp index → write-tree →
 * commit-tree → update-ref), so target-repo hooks, clean/smudge filters,
 * .gitignore/global excludes, and hostile system/global config can neither
 * execute code nor alter a single delivered byte. The commit's tree is
 * compared byte-for-byte and mode-for-mode against the extracted artifact
 * BEFORE any ref moves; any divergence fails the delivery closed.
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

/** cat-file of a delivered blob must never truncate — plumbing output cap. */
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;

interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function exec(cmd: string, args: string[], opts: { env?: Record<string, string>; input?: string | Buffer } = {}): ExecResult {
  const r = spawnSync(cmd, args, {
    maxBuffer: MAX_GIT_OUTPUT,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  if (r.error) throw r.error;
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

/**
 * Minimal, fully explicit environment for EVERY delivery Git call — from the
 * very first one. System and global config never load (hostile hooksPath /
 * filter / excludes / fsmonitor / identity definitions are unreachable),
 * hooks resolve to an empty trusted directory (covers reference-transaction
 * and post-index-change, which even pure plumbing would otherwise fire),
 * signing is off, and no pager or prompt can ever be spawned. Only PATH is
 * inherited, so test/ops git shims keep working.
 */
function gitEnv(base: NodeJS.ProcessEnv, hooksDir?: string): Record<string, string> {
  const configs: [string, string][] = [
    ["core.fsmonitor", ""],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ];
  if (hooksDir !== undefined) configs.push(["core.hooksPath", hooksDir]);
  const env: Record<string, string> = {
    PATH: base["PATH"] ?? process.env["PATH"] ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    GIT_CONFIG_COUNT: String(configs.length),
  };
  for (const [i, [key, value]] of configs.entries()) {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  }
  return env;
}

function git(repo: string, env: Record<string, string>, args: string[], input?: string | Buffer): string {
  const r = exec("git", ["-C", repo, ...args], { env, ...(input !== undefined ? { input } : {}) });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout.toString("utf8")).trim()}`);
  return r.stdout.toString("utf8").trim();
}

/** Like git() but returns raw stdout bytes (blob readback must not be trimmed/decoded). */
function gitBuf(repo: string, env: Record<string, string>, args: string[]): Buffer {
  const r = exec("git", ["-C", repo, ...args], { env });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout.toString("utf8")).trim()}`);
  return r.stdout;
}

export function isGitRepo(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return exec("git", ["-C", dir, "rev-parse", "--git-dir"], { env: gitEnv(process.env) }).code === 0;
  } catch {
    return false;
  }
}

/**
 * Explicit commit identity: the target repo's LOCAL user.name/user.email
 * (repo-local config is the owner's declared identity), never global/system
 * config, with a fixed fallback so delivery works on identity-less repos.
 */
function localIdentity(repo: string, env: Record<string, string>): Record<string, string> {
  const get = (key: string, fallback: string): string => {
    const r = exec("git", ["-C", repo, "config", "--local", "--get", key], { env });
    const value = r.stdout.toString("utf8").trim();
    return r.code === 0 && value !== "" ? value : fallback;
  };
  const name = get("user.name", "hone");
  const email = get("user.email", "hone@localhost");
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

interface StageFile {
  rel: string;
  abs: string;
  mode: "100644" | "100755";
}

/**
 * Walk the extracted artifact: every regular file (executable bit → 100755)
 * enters the delivery, unconditionally — ignore rules never apply because
 * nothing here consults them. Anything that is not a plain file or directory
 * is rejected (defense-in-depth behind the tar-layout validation).
 */
function walkStage(stageDir: string): StageFile[] {
  const files: StageFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) files.push({ rel, abs, mode: (st.mode & 0o111) !== 0 ? "100755" : "100644" });
      else throw new Error(`extracted artifact contains a non-regular entry at ${JSON.stringify(rel)} — rejected`);
    }
  };
  walk(stageDir, "");
  return files;
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

function lsTree(repo: string, env: Record<string, string>, treeish: string): TreeEntry[] {
  const out = gitBuf(repo, env, ["ls-tree", "-r", "-z", "--full-tree", treeish]).toString("utf8");
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const meta = record.slice(0, tab).split(" ");
    const mode = meta[0];
    const type = meta[1];
    const oid = meta[2];
    if (tab < 0 || mode === undefined || type === undefined || oid === undefined) {
      throw new Error(`unparseable ls-tree record: ${JSON.stringify(record)}`);
    }
    entries.push({ mode, type, oid, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * Fail-closed delivery gate: the tree reachable from `treeish` must be
 * EXACTLY the extracted artifact — same path set, same 100644/100755 modes,
 * byte-identical blob content (independent ODB readback via cat-file, not a
 * re-hash) — and must contain nothing but plain file blobs (a gitlink or
 * symlink smuggled to this point is rejected here too). Runs before any ref
 * is updated.
 */
export function assertTreeMatchesStage(repo: string, treeish: string, stageDir: string, env?: Record<string, string>): void {
  const e = env ?? gitEnv(process.env);
  const byPath = new Map<string, TreeEntry>();
  for (const entry of lsTree(repo, e, treeish)) {
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new Error(
        `delivery verification failed: tree entry ${JSON.stringify(entry.path)} has mode ${entry.mode} (${entry.type}) — only plain file blobs (100644/100755) are deliverable`,
      );
    }
    byPath.set(entry.path, entry);
  }
  for (const file of walkStage(stageDir)) {
    const entry = byPath.get(file.rel);
    if (entry === undefined) {
      throw new Error(`delivery verification failed: artifact file ${JSON.stringify(file.rel)} is missing from the delivered tree`);
    }
    if (entry.mode !== file.mode) {
      throw new Error(`delivery verification failed: mode mismatch at ${JSON.stringify(file.rel)} (tree ${entry.mode}, artifact ${file.mode})`);
    }
    if (!gitBuf(repo, e, ["cat-file", "blob", entry.oid]).equals(readFileSync(file.abs))) {
      throw new Error(`delivery verification failed: content mismatch at ${JSON.stringify(file.rel)}`);
    }
    byPath.delete(file.rel);
  }
  const extra = byPath.keys().next();
  if (!extra.done) {
    throw new Error(`delivery verification failed: delivered tree contains ${JSON.stringify(extra.value)} which is not in the artifact`);
  }
}

/**
 * Turn the artifact into a commit on a new branch with object-database
 * plumbing only. No checkout, no worktree, no `git add`: every regular file
 * of the validated artifact is hashed with --no-filters and force-listed in
 * a temporary index via explicit cacheinfo records, so .gitignore, excludes,
 * attributes, and filters are structurally out of the loop. The branch ref
 * is created atomically ("" old-value ⇒ must-not-exist) only after the
 * commit tree verifies against the extracted bytes.
 */
function branchDeliver(opts: DeliverOptions): { branch: string; commit: string } {
  const branch = opts.branch ?? `hone/${opts.runId}`;
  if (!isGitRepo(opts.repo)) throw new Error(`${opts.repo} is not a git repository`);
  const scratch = mkdtempSync(join(tmpdir(), "hone-deliver-"));
  const hooksDir = join(scratch, "no-hooks");
  mkdirSync(hooksDir);
  const env = gitEnv(opts.env, hooksDir);
  try {
    if (exec("git", ["-C", opts.repo, "check-ref-format", `refs/heads/${branch}`], { env }).code !== 0) {
      throw new Error(`invalid branch name: ${branch}`);
    }
    const blob = casPath(opts.casDir, opts.artifact);
    if (!existsSync(blob)) throw new Error(`artifact ${opts.artifact} not found in CAS (${blob})`);
    // Reject adversarial layouts BEFORE anything else happens: a refused
    // artifact must leave no trace in the target repository.
    validateWorkspaceTar(readFileSync(blob));

    // Validates layout (single workspace/ root, files/dirs only, no .git,
    // no traversal/links) and strips the workspace component.
    const stage = join(scratch, "stage");
    extractWorkspaceArtifact(opts.casDir, opts.artifact, stage);
    const files = walkStage(stage);

    // Crash-idempotence: a prior attempt may have created the deterministic
    // run branch before delivery.applied was fsynced. Accept it only when its
    // complete tree is exactly this artifact; any collision still fails.
    const branchRef = `refs/heads/${branch}`;
    const existing = exec("git", ["-C", opts.repo, "rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`], { env });
    if (existing.code === 0) {
      const commit = existing.stdout.toString("utf8").trim();
      assertTreeMatchesStage(opts.repo, commit, stage, env);
      return { branch, commit };
    }
    if (existing.code !== 1) {
      throw new Error(`cannot inspect branch ${branch} in ${opts.repo}: ${(existing.stderr || existing.stdout.toString("utf8")).trim()}`);
    }

    let tree: string;
    if (files.length === 0) {
      tree = git(opts.repo, env, ["mktree"], "");
    } else {
      const indexEnv = { ...env, GIT_INDEX_FILE: join(scratch, "index") };
      let indexInfo = "";
      for (const file of files) {
        // --no-filters: hash the artifact bytes as-is; repo attributes and
        // clean filters can neither run nor rewrite content.
        const oid = git(opts.repo, env, ["hash-object", "-w", "--no-filters", "--", file.abs]);
        // NUL-terminated cacheinfo records survive every path edge case
        // (spaces, quotes, unicode, leading dashes, even newlines).
        indexInfo += `${file.mode} ${oid}\t${file.rel}\0`;
      }
      git(opts.repo, indexEnv, ["update-index", "-z", "--index-info"], indexInfo);
      tree = git(opts.repo, indexEnv, ["write-tree"]);
    }

    let headSha: string;
    try {
      headSha = git(opts.repo, env, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    } catch {
      throw new Error(`${opts.repo} has no commits (unborn HEAD) — cannot deliver`);
    }
    const headTree = git(opts.repo, env, ["rev-parse", "--verify", "HEAD^{tree}"]);
    const commit =
      tree === headTree
        ? headSha // artifact is byte-identical to HEAD — nothing to commit, same as the old no-op path
        : git(opts.repo, { ...env, ...localIdentity(opts.repo, env) }, [
            "commit-tree",
            tree,
            "-p",
            headSha,
            "-m",
            `hone(${opts.runId}): best artifact ${opts.artifact}`,
          ]);

    // Fail closed BEFORE the ref moves: the commit must carry exactly the
    // artifact's bytes and modes, nothing more, nothing less.
    assertTreeMatchesStage(opts.repo, commit, stage, env);

    // Atomic creation of ONLY the requested ref; "" old-value means the ref
    // must not exist yet, so a concurrent creation loses cleanly.
    git(opts.repo, env, ["update-ref", branchRef, commit, ""]);
    return { branch, commit };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * apply:pr is LOCAL-ONLY in the M0 seed: build the branch (same plumbing as
 * branch mode) and print the manual `gh pr create` instruction. The trusted
 * CLI never invokes gh, pushes, or touches the network — opening the PR is a
 * deliberate human act.
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
  const scratch = mkdtempSync(join(tmpdir(), "hone-deliver-"));
  const hooksDir = join(scratch, "no-hooks");
  mkdirSync(hooksDir);
  const env = gitEnv(opts.env, hooksDir);
  try {
    let base: string;
    try {
      base = git(opts.repo, env, ["symbolic-ref", "--short", "HEAD"]);
    } catch {
      notes.push(`repo HEAD is detached; left the result on branch ${branch}`);
      return branch;
    }
    const alreadyApplied = exec("git", ["-C", opts.repo, "merge-base", "--is-ancestor", branch, base], { env });
    if (alreadyApplied.code === 0) {
      notes.push(`auto-apply already present on ${base}; recovered prior delivery of ${branch}`);
      return base;
    }
    if (alreadyApplied.code !== 1) {
      throw new Error(`cannot determine whether ${branch} is already applied to ${base}: ${alreadyApplied.stderr.trim()}`);
    }
    const merge = exec("git", ["-C", opts.repo, "merge-tree", "--write-tree", base, branch], { env });
    if (merge.code !== 0) {
      notes.push(`auto-merge into ${base} has conflicts; left the result on branch ${branch}`);
      return branch;
    }
    const tree = merge.stdout.toString("utf8").trim().split("\n")[0];
    if (tree === undefined || tree === "") {
      notes.push(`auto-merge produced no tree; left the result on branch ${branch}`);
      return branch;
    }
    const baseSha = git(opts.repo, env, ["rev-parse", base]);
    const branchSha = git(opts.repo, env, ["rev-parse", branch]);
    const commit = git(opts.repo, { ...env, ...localIdentity(opts.repo, env) }, [
      "commit-tree",
      tree,
      "-p",
      baseSha,
      "-p",
      branchSha,
      "-m",
      `hone(${opts.runId}): auto-apply ${branch}`,
    ]);
    git(opts.repo, env, ["update-ref", `refs/heads/${base}`, commit, baseSha]);
    notes.push(`auto-applied to ${base} @ ${commit} (ref-only update; no working tree was written)`);
    return base;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
