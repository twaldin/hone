import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ApplyMode } from "@hone/schema";
import { z } from "zod";
import { extractWorkspaceArtifact, validateWorkspaceTar } from "./artifact.js";
import { casPath } from "./cas.js";
import { gitTimeoutError, gitTimeoutMs } from "./git-bound.js";
import { assertPlainGitStore } from "./git-baseline.js";
import { assertObjectIntegrity } from "./git-integrity.js";
import { writeFileDurable } from "./eventlog.js";

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
  /**
   * Explicit git store bind (a capsule baseline's embedded `.gitdir`). When
   * set, EVERY git call is pinned to this store via GIT_DIR — repository
   * discovery of any kind is off — and the store's HEAD must equal
   * `baselineCommit`. Only branch/pr modes may use it.
   */
  gitDir?: string;
  /**
   * Sealed manifest baseline commit. The target must already contain it
   * (wrong-root delivery fails closed) and the candidate commit parents on
   * it, so the delivered branch is exactly the run's delta over the frozen
   * baseline — never a silent revert of post-baseline target history.
   */
  baselineCommit: string;
  runId: string;
  /**
   * Trusted per-run directory for the durable apply:auto commit receipt.
   * Required in auto mode so crash recovery never infers success from
   * arbitrary ancestry.
   */
  runDir?: string;
  /** CAS hash of the artifact tar to deliver. */
  artifact: string;
  casDir: string;
  branch?: string;
  /** Full refs/heads/* destination sealed when apply:auto is approved. */
  autoRef?: string;
  improverSeat: boolean;
  env: NodeJS.ProcessEnv;
  /**
   * Immediate pre-publication revalidation hook: invoked right before EVERY
   * ref update (the only operations that make delivered objects reachable).
   * Callers bind it to the sealed/resolved target's immutable filesystem
   * identity (dev:ino + durable marker) so a target renamed, deleted, or
   * recreated between validation and publication fails closed with no ref
   * moved.
   */
  verifyTarget?: () => void;
  /**
   * Test seam replacing the fd-level fsync primitive used by the
   * publication-durability epilogue (files AND directories). Defaults to a
   * real open/fsync/close.
   */
  fsyncPath?: (path: string) => void;
}

export interface DeliverResult {
  /** The ref the artifact landed on (branch name), or null for mode=none. */
  ref: string | null;
  notes: string[];
}

/** cat-file of a delivered blob must never truncate — plumbing output cap. */
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;

// One hard wall-clock bound on EVERY synchronous delivery Git call — see
// git-bound.ts. On expiry the child is SIGKILLed by spawnSync itself; the
// interactive contract editor is deliberately NOT routed through exec().
interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function exec(cmd: string, args: string[], opts: { env?: Record<string, string>; input?: string | Buffer } = {}): ExecResult {
  const timeout = gitTimeoutMs();
  const r = spawnSync(cmd, args, {
    maxBuffer: MAX_GIT_OUTPUT,
    timeout,
    killSignal: "SIGKILL",
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || r.signal === "SIGKILL") {
      throw gitTimeoutError(`${cmd} ${args.join(" ")}`, timeout);
    }
    throw r.error;
  }
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
    // Renormalization runs clean filters (repo-config-defined COMMANDS) during
    // content merges; command-scope config outranks any hostile local setting.
    ["merge.renormalize", "false"],
    // A repo-local core.attributesFile can point anywhere — pin it dead.
    ["core.attributesfile", devNull],
    // Power-loss durability of PUBLICATION: every object write (hash-object
    // -w, write-tree, commit-tree) and every ref update in a delivery must
    // be fsynced by git itself — a hostile or merely sloppy repo-local
    // `core.fsync=none` / `core.fsyncMethod=writeout-only` is outranked by
    // this command-scope pin. A delivery the CLI acknowledges (and the
    // supervisor terminalizes on) must survive a crash right after the call.
    ["core.fsync", "objects,reference"],
    ["core.fsyncmethod", "fsync"],
    // A checksum-valid forged objects/info/commit-graph could feed rev walks
    // fabricated parent/generation metadata without any raw-object
    // cross-check — every ancestry/merge proof below must come from the
    // object database only.
    ["core.commitgraph", "false"],
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
    // refs/replace/* in a hostile target could make every rev-parse/ls-tree
    // see a forged object graph — delivery reads raw objects only.
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
    // A partial-clone target repo must never demand-fetch during delivery:
    // missing objects fail locally (git >= 2.42 honors GIT_NO_LAZY_FETCH; on
    // older gits the protocol whitelist "none" blocks the transport — and any
    // ext::/helper command execution — so the fetch still fails closed).
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "none",
    GIT_PROTOCOL_FROM_USER: "0",
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
    // A forged tree can carry duplicate or non-UTF-8 paths that collide or
    // masquerade after decoding — both are unrepresentable in a real
    // artifact stage and reject outright.
    if (entry.path.includes("\uFFFD")) {
      throw new Error("delivery verification failed: tree entry path is not valid UTF-8");
    }
    if (byPath.has(entry.path)) {
      throw new Error(`delivery verification failed: duplicate tree entry ${JSON.stringify(entry.path)}`);
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

/** With gitDir set, pin EVERY git call to that store via GIT_DIR — no repository discovery of any kind. */
function bindEnv(opts: DeliverOptions, env: Record<string, string>): Record<string, string> {
  return opts.gitDir !== undefined ? { ...env, GIT_DIR: opts.gitDir } : env;
}

/**
 * Files-only ref-storage preflight, before ANY object or ref write. The
 * delivery durability epilogue (loose-object dirents, loose/packed ref
 * publication, crash-idempotent recovery) is proven ONLY for the files
 * backend. A reftable stack is rewritten in place by every ref update and
 * the workstation git this CLI ships against cannot even open a reftable
 * store, so reftable durability is unprovable here — any store that is not
 * canonically the files backend is rejected fail-closed, with zero external
 * side effects. Detection: the running git's own `rev-parse
 * --show-ref-format` (git >= 2.43) is canonical when it answers a KNOWN
 * format — the same binary that would publish resolves extensions, config
 * includes, and worktree indirection itself — but older gits echo unknown
 * rev-parse flags back verbatim (exit 0). Anything non-canonical falls back
 * to reading the store's own config file (`--file` mode needs no repository
 * setup and deliberately follows NO include directives) plus the reftable
 * stack marker; the fallback may only ever REJECT, never enable a write
 * path.
 */
export function assertSupportedRefStorage(repo: string, gitDir: string | undefined, env: Record<string, string>): void {
  const storeDir = gitDir ?? join(repo, ".git");
  const probe =
    gitDir !== undefined
      ? exec("git", ["rev-parse", "--show-ref-format"], { env })
      : exec("git", ["-C", repo, "rev-parse", "--show-ref-format"], { env });
  const reported = probe.code === 0 ? probe.stdout.toString("utf8").trim() : "";
  if (reported === "files") return;
  const cfg = exec("git", ["config", "--file", join(storeDir, "config"), "--get", "extensions.refstorage"], { env });
  const declared = cfg.code === 0 ? cfg.stdout.toString("utf8").trim().toLowerCase() : "";
  if (
    reported !== "reftable" &&
    (declared === "" || declared === "files") &&
    !existsSync(join(storeDir, "reftable", "tables.list"))
  ) {
    return;
  }
  const format = reported === "reftable" || declared === "" ? "reftable" : declared;
  throw new Error(
    `target git store ${storeDir} uses ref storage format ${JSON.stringify(format)} but this delivery state machine can prove durable publication only over the files backend (probe ${probe.code === 0 ? `answered ${JSON.stringify(reported)}` : `failed: ${probe.stderr.trim() || `exit ${probe.code}`}`}) — refusing before any object or ref write; no changes were made`,
  );
}

/** Real fd-level fsync of a file or directory — the durability primitive the epilogue seam defaults to. */
function fsyncPathReal(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Publication-durability epilogue, part 1 (release gate P1 follow-up):
 * `core.fsync` makes git fsync FILE contents, but the files backend
 * publishes loose objects and refs via lockfile rename/link WITHOUT
 * fsyncing parent directories — a power cut can lose the dirents of a
 * delivery the CLI already acknowledged. Before any ref makes the new
 * objects reachable, fsync every loose-object fanout dir plus objects/
 * itself (bounded: at most 256 two-hex dirs). Any failure fails the
 * delivery before publication.
 */
export function syncLooseObjectDirs(gitDir: string, sync: (path: string) => void = fsyncPathReal): void {
  const objects = join(gitDir, "objects");
  for (const name of readdirSync(objects)) {
    if (/^[0-9a-f]{2}$/.test(name)) sync(join(objects, name));
  }
  sync(objects);
}

/**
 * Publication-durability epilogue, part 2: after a successful update-ref,
 * make the published ref's storage durable. Fsync the loose ref file and
 * every directory on its chain up through the git store, so the ref's
 * dirent (and any newly created refs/… intermediate dirs) survive power
 * loss. Recovery paths may find the ref legitimately packed (a user ran
 * pack-refs since the crashed attempt) — then packed-refs + the store dir
 * are synced instead. Neither present is a failed delivery. Only the files
 * backend ever reaches this epilogue: assertSupportedRefStorage rejects
 * every other ref-storage backend before any write.
 */
interface PublishedRefBacking {
  path: string;
  loose: boolean;
}

const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024;

function publishedRefBacking(gitDir: string, ref: string, expectedOid: string): PublishedRefBacking {
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedOid)
    || ref.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`cannot prove published ref ${JSON.stringify(ref)} at malformed expected oid ${JSON.stringify(expectedOid)}`);
  }
  const refFile = join(gitDir, ...ref.split("/"));
  if (existsSync(refFile)) {
    const st = lstatSync(refFile);
    if (!st.isFile() || st.size > 256) {
      throw new Error(`published ref ${ref} has a non-plain or oversized loose backing — cannot prove expected ${expectedOid}`);
    }
    const value = readFileSync(refFile, "utf8").trim();
    if (value !== expectedOid) {
      throw new Error(`published ref ${ref} resolves to loose value ${JSON.stringify(value)}, expected ${expectedOid}`);
    }
    return { path: refFile, loose: true };
  }
  const packed = join(gitDir, "packed-refs");
  if (existsSync(packed)) {
    const st = lstatSync(packed);
    if (!st.isFile() || st.size > MAX_PACKED_REFS_BYTES) {
      throw new Error(`published ref ${ref} has a non-plain or oversized packed-refs backing — cannot prove expected ${expectedOid}`);
    }
    const line = `${expectedOid} ${ref}`;
    if (readFileSync(packed, "utf8").split("\n").some((entry) => entry === line)) {
      return { path: packed, loose: false };
    }
  }
  throw new Error(
    `published ref ${ref} exists neither as a loose ref nor as an exact packed ref at expected ${expectedOid} — delivery failed`,
  );
}

function syncRefBacking(gitDir: string, backing: PublishedRefBacking, sync: (path: string) => void): void {
  sync(backing.path);
  if (!backing.loose) {
    sync(gitDir);
    return;
  }
  const stop = resolve(gitDir);
  let dir = dirname(backing.path);
  for (;;) {
    sync(dir);
    if (resolve(dir) === stop) break;
    dir = dirname(dir);
  }
}

export function syncPublishedRef(
  gitDir: string,
  ref: string,
  expectedOid: string,
  sync: (path: string) => void = fsyncPathReal,
): void {
  // The backing may legitimately move loose→packed while recovery runs.
  // Re-sync the replacement, but never accept a packed-refs file that does
  // not contain THIS exact ref/value.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = publishedRefBacking(gitDir, ref, expectedOid);
    syncRefBacking(gitDir, before, sync);
    const after = publishedRefBacking(gitDir, ref, expectedOid);
    if (after.path === before.path && after.loose === before.loose) return;
  }
  throw new Error(`published ref ${ref} backing changed repeatedly during durability sync — refusing unstable delivery`);
}

/**
 * Grafted-ancestry rejection: GIT_NO_REPLACE_OBJECTS disables replace REFS,
 * but a nonempty `<store>/info/grafts` file is still honored by every rev
 * walk and rewrites parenthood at will — an unrelated repository that
 * imported the baseline objects and grafted `HEAD baseline` would "contain"
 * the sealed baseline commit. Any nonempty (or unreadable) grafts file
 * fails validation closed, before any write. (GIT_GRAFT_FILE cannot
 * redirect this: delivery envs are built from scratch and never inherit
 * it.)
 */
export function assertNoGraftedAncestry(storeDir: string): void {
  const grafts = join(storeDir, "info", "grafts");
  if (!existsSync(grafts)) return;
  let content: string;
  try {
    content = readFileSync(grafts, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${grafts} (${e instanceof Error ? e.message : String(e)}) — refusing to trust the ancestry of a store with an unreadable grafts file`);
  }
  if (content.trim() !== "") {
    throw new Error(`${storeDir} carries a nonempty info/grafts file — grafted ancestry can forge baseline containment; refusing to deliver`);
  }
}

/**
 * Immediate pre-write/recovery gate. The entry preflight proves the store
 * writable and hash-verified, but its subjects live in the filesystem and
 * can change while a delivery is in flight: a config flip to reftable, a
 * grafts file appearing, or an object rewritten under its old oid
 * mid-delivery must abort BEFORE the ref (re)publication and its
 * durability epilogue, never after. `roots` are the trusted commits whose
 * closures the imminent publication relies on — fsck re-hashes the store
 * and proves those closures present (see git-integrity.ts).
 */
function assertWritableStore(repo: string, gitDir: string | undefined, env: Record<string, string>, roots: string[]): void {
  const store = gitDir ?? join(repo, ".git");
  assertPlainGitStore(store);
  assertSupportedRefStorage(repo, gitDir, env);
  assertNoGraftedAncestry(store);
  assertObjectIntegrity(gitDir !== undefined ? { gitDir } : { repo }, roots, env, "delivery store");
}

/**
 * Fail-closed target validation, before ANY object write:
 *  - the sealed baseline commit must be a full sha (frozen manifest shape);
 *  - an explicitly bound store (embedded capsule-baseline `.gitdir`) must
 *    have HEAD exactly at the sealed baseline commit — which also proves
 *    containment;
 *  - a plain repo target must BE its own top level (a plain subdirectory is
 *    never escalated to a parent repository Git discovered on its own) and
 *    must already contain the sealed baseline commit — a repository that
 *    never held the capsule baseline is the wrong repository.
 */
function assertExactTarget(opts: DeliverOptions, env: Record<string, string>): void {
  if (!/^[0-9a-f]{40}$/.test(opts.baselineCommit)) {
    throw new Error(`sealed baseline commit ${JSON.stringify(opts.baselineCommit)} is not a full commit sha — refusing to deliver`);
  }
  assertPlainGitStore(opts.gitDir ?? join(opts.repo, ".git"));
  // Every ancestry proof below (and every recovery-path merge-base) is only
  // meaningful over the store's REAL object graph.
  assertNoGraftedAncestry(opts.gitDir ?? join(opts.repo, ".git"));
  // Hash-verify the ENTIRE object database (and the baseline's closure)
  // BEFORE any rev-parse/merge-base/ls-tree output below is trusted:
  // ordinary read plumbing never recomputes object ids, so a valid-zlib
  // object stored under the wrong oid would otherwise ride every proof.
  assertObjectIntegrity(
    opts.gitDir !== undefined ? { gitDir: opts.gitDir } : { repo: opts.repo },
    [opts.baselineCommit],
    env,
    "delivery target",
  );
  if (opts.gitDir !== undefined) {
    const head = exec("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env });
    const sha = head.stdout.toString("utf8").trim();
    if (head.code !== 0 || sha !== opts.baselineCommit) {
      throw new Error(
        `explicitly bound store ${opts.gitDir} has HEAD ${head.code === 0 ? sha : "(unborn)"} but the run is sealed to baseline commit ${opts.baselineCommit} — refusing to deliver`,
      );
    }
    return;
  }
  // `.git` must be a PLAIN in-tree directory: a gitfile or symlink can
  // rebind the named repository to a different store between validation
  // and delivery (defense in depth behind the CLI-side target resolver).
  const dotGit = join(opts.repo, ".git");
  if (!existsSync(dotGit) || !lstatSync(dotGit).isDirectory()) {
    throw new Error(
      `${opts.repo} does not own a plain in-tree .git directory — refusing: delivery never follows gitfile/symlink indirection or discovers a parent repository`,
    );
  }
  const top = exec("git", ["-C", opts.repo, "rev-parse", "--show-toplevel"], { env });
  const topPath = top.stdout.toString("utf8").trim();
  if (top.code !== 0 || topPath === "" || realpathSync(topPath) !== realpathSync(opts.repo)) {
    throw new Error(
      `${opts.repo} is not the exact top level of a git repository — delivery never targets a parent repository discovered from a subdirectory`,
    );
  }
  // REACHABILITY, not object existence: a dangling hash-identical object
  // proves nothing about this repository's history. Delivery merges over
  // HEAD, so the sealed baseline must be an ancestor of the checkout.
  const contained = exec("git", ["-C", opts.repo, "merge-base", "--is-ancestor", opts.baselineCommit, "HEAD"], { env });
  if (contained.code !== 0) {
    throw new Error(
      `target ${opts.repo} does not contain the sealed baseline commit ${opts.baselineCommit} in its checked-out history — wrong repository or wrong branch; refusing to deliver`,
    );
  }
}

/** Parents of a commit via rev-list ("<commit> [parent…]" line, first field dropped). */
function commitParents(repo: string, env: Record<string, string>, commit: string): string[] {
  const line = git(repo, env, ["rev-list", "--no-walk", "--parents", commit]);
  return line.split(/\s+/).slice(1);
}

/**
 * Turn the artifact into a commit on a new branch with object-database
 * plumbing only. No checkout, no worktree, no `git add`: every regular file
 * of the validated artifact is hashed with --no-filters and force-listed in
 * a temporary index via explicit cacheinfo records, so .gitignore, excludes,
 * attributes, and filters are structurally out of the loop.
 *
 * Shape: the CANDIDATE commit carries exactly the artifact tree and parents
 * on the sealed baseline commit — the run's delta over the frozen baseline,
 * never a snapshot that silently reverts post-baseline target history. When
 * the target's HEAD has moved past the baseline, the branch tip is a
 * ref-only merge (HEAD, candidate); a conflicted or driver-unsafe merge
 * degrades to the raw candidate with a note. The branch ref is created
 * atomically ("" old-value ⇒ must-not-exist) only after the candidate tree
 * verifies against the extracted bytes.
 */
function branchDeliver(opts: DeliverOptions, notes: string[] = []): { branch: string; commit: string } {
  const branch = opts.branch ?? `hone/${opts.runId}`;
  const storeDir = opts.gitDir ?? join(opts.repo, ".git");
  const scratch = mkdtempSync(join(tmpdir(), "hone-deliver-"));
  const hooksDir = join(scratch, "no-hooks");
  mkdirSync(hooksDir);
  const env = bindEnv(opts, gitEnv(opts.env, hooksDir));
  try {
    assertSupportedRefStorage(opts.repo, opts.gitDir, env);
    assertExactTarget(opts, env);
    if (exec("git", ["check-ref-format", `refs/heads/${branch}`], { env }).code !== 0) {
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
    // branch before delivery.applied was fsynced. Accept it ONLY as a prior
    // delivery of exactly this artifact: its candidate side (the tip, or the
    // second parent of a HEAD-merge tip) parents on the sealed baseline
    // commit and carries exactly the artifact tree. Anything else collides.
    const branchRef = `refs/heads/${branch}`;
    const existing = exec("git", ["-C", opts.repo, "rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`], { env });
    if (existing.code === 0) {
      // Sealed-identity gate BEFORE any recovery authority is derived from
      // this filesystem: the existing ref is only trusted as a prior
      // delivery while the repo/store are still the sealed incarnation.
      opts.verifyTarget?.();
      const tip = existing.stdout.toString("utf8").trim();
      const tipParents = commitParents(opts.repo, env, tip);
      // The sealed baseline ITSELF may be a merge commit: a zero-delta
      // delivery points the branch directly at the baseline, so a tip equal
      // to the baseline is ALWAYS the raw candidate. Inferring the
      // two-parent Hone wrapper shape first would misread the baseline's
      // second parent as the candidate and brick a valid crash recovery.
      const candidate = tip === opts.baselineCommit ? tip : tipParents.length === 2 ? tipParents[1] : tip;
      if (candidate === undefined) {
        throw new Error(`delivery verification failed: cannot resolve the candidate side of existing branch ${branch}`);
      }
      const candidateParents = candidate === tip ? tipParents : commitParents(opts.repo, env, candidate);
      // Exact recovery shape only: the candidate is the sealed baseline
      // itself (zero-delta artifact) or a SINGLE-parent child of it. A
      // forged commit that lists the baseline first among several parents
      // would smuggle extra ancestry into HEAD on a later auto-merge.
      if (candidate !== opts.baselineCommit && !(candidateParents.length === 1 && candidateParents[0] === opts.baselineCommit)) {
        throw new Error(
          `delivery verification failed: branch ${branch} exists but its candidate is not exactly the sealed baseline commit ${opts.baselineCommit} or a single-parent commit on it (${candidateParents.length} parents)`,
        );
      }
      assertTreeMatchesStage(opts.repo, candidate, stage, env);
      if (tip !== candidate) {
        if (opts.mode === "auto") {
          throw new Error(`delivery verification failed: apply:auto branch ${branch} must be the raw baseline-parented candidate`);
        }
        // The tip must be EXACTLY the merge shape a prior delivery could
        // have produced: two parents [p1, candidate], p1 on this repo's
        // HEAD line, and a tree that RECOMPUTES from merge-tree(p1,
        // candidate). A pre-forged "merge" whose tree carries anything
        // else would otherwise ride the verified candidate into HEAD.
        const p1 = tipParents[0];
        if (tipParents.length !== 2 || p1 === undefined) {
          throw new Error(`delivery verification failed: branch ${branch} tip is neither the candidate nor a two-parent delivery merge`);
        }
        const anc = exec("git", ["-C", opts.repo, "merge-base", "--is-ancestor", p1, "HEAD"], { env });
        if (anc.code !== 0) {
          throw new Error(`delivery verification failed: branch ${branch} merge tip does not descend from this repository's HEAD line`);
        }
        if (externalMergeDriver(opts.repo, env) !== undefined) {
          throw new Error(`delivery verification failed: cannot re-verify the merge tip of ${branch} — target repo defines an external merge driver`);
        }
        const remerge = exec("git", ["-C", opts.repo, "merge-tree", "--write-tree", p1, candidate], { env });
        const remergedTree = remerge.stdout.toString("utf8").trim().split("\n")[0];
        const tipTree = git(opts.repo, env, ["rev-parse", "--verify", `${tip}^{tree}`]);
        if (remerge.code !== 0 || remergedTree === undefined || remergedTree !== tipTree) {
          throw new Error(`delivery verification failed: branch ${branch} merge tip tree does not recompute from (HEAD line, candidate)`);
        }
      }
      // A crashed prior attempt fsynced file CONTENTS (core.fsync) but its
      // dirents may never have reached disk — returning success here must
      // still make the recovered publication durable.
      assertWritableStore(opts.repo, opts.gitDir, env, [opts.baselineCommit]);
      syncLooseObjectDirs(storeDir, opts.fsyncPath);
      syncPublishedRef(storeDir, branchRef, tip, opts.fsyncPath);
      // Re-verify IMMEDIATELY before the successful no-update return: the
      // sealed identity must still hold after the durability epilogue.
      opts.verifyTarget?.();
      return { branch, commit: tip };
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

    // Candidate = the run's exact delta: artifact tree parented on the
    // sealed baseline commit (already proven present in this target).
    const baselineTree = git(opts.repo, env, ["rev-parse", "--verify", `${opts.baselineCommit}^{tree}`]);
    const candidate =
      tree === baselineTree
        ? opts.baselineCommit // artifact is byte-identical to the frozen baseline — nothing to commit
        : git(opts.repo, { ...env, ...localIdentity(opts.repo, env) }, [
            "commit-tree",
            tree,
            "-p",
            opts.baselineCommit,
            "-m",
            `hone(${opts.runId}): best artifact ${opts.artifact}`,
          ]);

    // Fail closed BEFORE the ref moves: the candidate must carry exactly the
    // artifact's bytes and modes, nothing more, nothing less.
    assertTreeMatchesStage(opts.repo, candidate, stage, env);

    // Branch/pr preserve ambient post-baseline HEAD history. apply:auto must
    // NOT: its only approved integration target is the sealed autoRef, which
    // autoDeliver merges separately from the raw baseline-parented candidate.
    const head = opts.mode === "auto"
      ? null
      : exec("git", ["-C", opts.repo, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { env });
    const headSha = head !== null && head.code === 0 ? head.stdout.toString("utf8").trim() : null;
    let tip = candidate;
    if (headSha !== null && headSha !== opts.baselineCommit && headSha !== candidate) {
      const driverKey = externalMergeDriver(opts.repo, env);
      if (driverKey !== undefined) {
        notes.push(
          `target repo defines external merge driver (${driverKey}); branch ${branch} holds the raw candidate parented on the baseline — merge it manually`,
        );
      } else {
        const merge = exec("git", ["-C", opts.repo, "merge-tree", "--write-tree", headSha, candidate], { env });
        const mergedTree = merge.stdout.toString("utf8").trim().split("\n")[0];
        if (merge.code !== 0 || mergedTree === undefined || mergedTree === "") {
          notes.push(
            `target HEAD has diverged from the sealed baseline and the merge conflicts; branch ${branch} holds the raw candidate parented on the baseline — merge it manually`,
          );
        } else {
          tip = git(opts.repo, { ...env, ...localIdentity(opts.repo, env) }, [
            "commit-tree",
            mergedTree,
            "-p",
            headSha,
            "-p",
            candidate,
            "-m",
            `hone(${opts.runId}): merge best artifact ${opts.artifact} over current HEAD`,
          ]);
        }
      }
    }

    // Atomic creation of ONLY the requested ref; "" old-value means the ref
    // must not exist yet, so a concurrent creation loses cleanly.
    // Durability ORDER: object dirents first (nothing may point at an
    // object whose dirent can vanish), then the store + sealed-identity
    // gates, then the ref update, then the ref file + its directory chain.
    // Any sync failure fails the delivery before delivery.applied is emitted.
    syncLooseObjectDirs(storeDir, opts.fsyncPath);
    assertWritableStore(opts.repo, opts.gitDir, env, [opts.baselineCommit]);
    opts.verifyTarget?.();
    git(opts.repo, env, ["update-ref", branchRef, tip, ""]);
    syncPublishedRef(storeDir, branchRef, tip, opts.fsyncPath);
    // The path may be swapped while the ref epilogue is syncing. Success is
    // authorized only if the approved repo/store identity still names the
    // object we just published into.
    opts.verifyTarget?.();
    return { branch, commit: tip };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export const AUTO_DELIVERY_RECEIPT_FILE = "auto-delivery-receipt.json";

const AutoDeliveryReceiptSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  ref: z.string().min(1),
  branchRef: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  branchSha: z.string().regex(/^[0-9a-f]{40}$/),
  tree: z.string().regex(/^[0-9a-f]{40}$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();

type AutoDeliveryReceipt = z.infer<typeof AutoDeliveryReceiptSchema>;

function requiredAutoRef(opts: DeliverOptions): { ref: string; short: string } {
  const ref = opts.autoRef;
  if (
    ref === undefined
    || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
    || ref.includes("..")
    || ref.includes("//")
    || ref.endsWith("/")
    || ref.endsWith(".")
    || ref.endsWith(".lock")
  ) {
    throw new Error("apply:auto requires a valid full refs/heads/* destination sealed at run creation");
  }
  return { ref, short: ref.slice("refs/heads/".length) };
}

function autoReceiptPath(opts: DeliverOptions): string {
  if (opts.runDir === undefined || !existsSync(opts.runDir) || !lstatSync(opts.runDir).isDirectory()) {
    throw new Error("apply:auto requires the existing trusted run directory for its durable commit receipt");
  }
  return join(opts.runDir, AUTO_DELIVERY_RECEIPT_FILE);
}

function readAutoReceipt(path: string): AutoDeliveryReceipt | null {
  if (!existsSync(path)) return null;
  const st = lstatSync(path);
  if (!st.isFile() || st.size > 4096) {
    throw new Error(`automatic delivery receipt ${path} is not a plain bounded file`);
  }
  return AutoDeliveryReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function mergeTree(repo: string, env: Record<string, string>, baseSha: string, branchSha: string): string | null {
  const merge = exec("git", ["-C", repo, "merge-tree", "--write-tree", baseSha, branchSha], { env });
  if (merge.code !== 0) return null;
  return merge.stdout.toString("utf8").trim().split("\n")[0] ?? null;
}

function isolatedMergeTree(repo: string, env: Record<string, string>, baseSha: string, branchSha: string): string | null {
  const root = mkdtempSync(join(tmpdir(), "hone-merge-verify-"));
  const gitDir = join(root, "git");
  try {
    mkdirSync(join(gitDir, "objects", "info"), { recursive: true });
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n");
    // Read target objects through a trusted temporary store, but never load
    // target-local config. A merge.*.driver added after receipt publication
    // therefore cannot execute or alter semantic recovery validation.
    writeFileSync(join(gitDir, "objects", "info", "alternates"), `${realpathSync(join(repo, ".git", "objects"))}\n`);
    const isolatedEnv: Record<string, string> = { ...env, GIT_DIR: gitDir };
    delete isolatedEnv["GIT_WORK_TREE"];
    const merge = exec("git", ["merge-tree", "--write-tree", baseSha, branchSha], { env: isolatedEnv });
    if (merge.code !== 0) return null;
    return merge.stdout.toString("utf8").trim().split("\n")[0] ?? null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateAutoReceipt(
  opts: DeliverOptions,
  env: Record<string, string>,
  receipt: AutoDeliveryReceipt,
  ref: string,
  branchRef: string,
  branchSha: string,
): void {
  if (
    receipt.runId !== opts.runId
    || receipt.ref !== ref
    || receipt.branchRef !== branchRef
    || receipt.branchSha !== branchSha
  ) {
    throw new Error("automatic delivery receipt does not match this sealed run, destination, and candidate branch");
  }
  const parents = git(opts.repo, env, ["rev-list", "--parents", "-n", "1", receipt.commit]).split(" ");
  if (
    parents.length !== 3
    || parents[0] !== receipt.commit
    || parents[1] !== receipt.baseSha
    || parents[2] !== receipt.branchSha
  ) {
    throw new Error(`automatic delivery receipt commit ${receipt.commit} has unexpected parents`);
  }
  const actualTree = git(opts.repo, env, ["rev-parse", "--verify", `${receipt.commit}^{tree}`]);
  if (actualTree !== receipt.tree) {
    throw new Error(`automatic delivery receipt commit ${receipt.commit} has tree ${actualTree}, expected ${receipt.tree}`);
  }
  const baseline = exec("git", ["-C", opts.repo, "merge-base", "--is-ancestor", opts.baselineCommit, receipt.baseSha], { env });
  if (baseline.code !== 0) {
    throw new Error(`automatic delivery receipt base ${receipt.baseSha} does not contain sealed baseline ${opts.baselineCommit}`);
  }
  const expectedTree = isolatedMergeTree(opts.repo, env, receipt.baseSha, receipt.branchSha);
  if (expectedTree === null || expectedTree !== receipt.tree) {
    throw new Error(`automatic delivery receipt tree ${receipt.tree} is not the exact merge of its recorded parents`);
  }
}

/**
 * apply:pr is LOCAL-ONLY in the M0 seed: build the branch (same plumbing as
 * branch mode) and print the manual `gh pr create` instruction. The trusted
 * CLI never invokes gh, pushes, or touches the network — opening the PR is a
 * deliberate human act.
 */
function prDeliver(opts: DeliverOptions, notes: string[]): string {
  const { branch } = branchDeliver(opts, notes);
  const title = `hone(${opts.runId}): apply best artifact`;
  const body = `Best artifact ${opts.artifact} from hone run ${opts.runId}.`;
  notes.push(
    `apply pr (local-only): branch ${branch} created — push it and open the PR yourself: git push -u origin ${branch} && gh pr create --head ${branch} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`,
  );
  return branch;
}

/**
 * Content-level merging is the ONE delivery operation that consults the
 * target repo's attribute stack: a `merge.<name>.driver` config value is an
 * arbitrary command line git executes ON THE HOST (with candidate-controlled
 * content as its input) the moment both sides touch the same file. Local
 * repo config is untrusted (a hostile checkout must not gain execution), so
 * ANY external driver definition refuses the content merge — callers degrade
 * to plain branch delivery. The listing sees every scope a merge would see:
 * command scope (our own known-safe injections), local config, and — when
 * extensions.worktreeConfig is set — config.worktree; system/global never
 * load under gitEnv. Built-in drivers (text/binary/union) define no command
 * and stay usable; renormalize-driven clean filters are pinned off in gitEnv.
 */
function externalMergeDriver(repo: string, env: Record<string, string>): string | undefined {
  const r = exec("git", ["-C", repo, "config", "--list", "-z"], { env });
  if (r.code !== 0) {
    throw new Error(`cannot inspect ${repo} config for merge drivers: ${r.stderr.trim()}`);
  }
  for (const record of r.stdout.toString("utf8").split("\0")) {
    if (record === "") continue;
    const nl = record.indexOf("\n");
    const key = nl < 0 ? record : record.slice(0, nl);
    if (/^merge\..+\.driver$/i.test(key)) return key;
  }
  return undefined;
}

/**
 * auto = branch + ref-only merge into the repo's HEAD branch. No working tree
 * (the user's or anyone's) is written; a conflicted merge degrades to branch.
 */
function autoDeliver(opts: DeliverOptions, notes: string[]): string {
  // Freeze all authority-bearing names before branchDeliver can publish.
  const destination = requiredAutoRef(opts);
  const receiptPath = autoReceiptPath(opts);
  const branchRef = `refs/heads/${opts.branch ?? `hone/${opts.runId}`}`;
  const { branch, commit: branchSha } = branchDeliver(opts, notes);
  if (branchRef !== `refs/heads/${branch}`) {
    throw new Error(`automatic delivery branch ${branch} does not match its sealed full ref ${branchRef}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "hone-deliver-"));
  const hooksDir = join(scratch, "no-hooks");
  mkdirSync(hooksDir);
  const env = gitEnv(opts.env, hooksDir);
  try {
    assertWritableStore(opts.repo, undefined, env, [opts.baselineCommit]);

    const prior = readAutoReceipt(receiptPath);
    if (prior !== null) {
      opts.verifyTarget?.();
      assertWritableStore(opts.repo, undefined, env, [opts.baselineCommit]);
      validateAutoReceipt(opts, env, prior, destination.ref, branchRef, branchSha);
      const current = git(opts.repo, env, ["rev-parse", "--verify", `${destination.ref}^{commit}`]);
      let published = current;
      if (current === prior.baseSha) {
        // Receipt publication is durable BEFORE this CAS. A crash on either
        // side therefore resumes with an exact commit, never an ancestry
        // guess and never whichever branch HEAD happens to name later.
        opts.verifyTarget?.();
        assertWritableStore(opts.repo, undefined, env, [opts.baselineCommit]);
        git(opts.repo, env, ["update-ref", destination.ref, prior.commit, prior.baseSha]);
        published = prior.commit;
      } else if (current !== prior.commit) {
        const containsReceipt = exec("git", ["-C", opts.repo, "merge-base", "--is-ancestor", prior.commit, current], { env });
        if (containsReceipt.code !== 0) {
          throw new Error(
            `sealed automatic destination ${destination.ref} moved from receipt base ${prior.baseSha} to unrelated ${current}`,
          );
        }
      }
      syncLooseObjectDirs(join(opts.repo, ".git"), opts.fsyncPath);
      assertWritableStore(opts.repo, undefined, env, [opts.baselineCommit]);
      syncPublishedRef(join(opts.repo, ".git"), destination.ref, published, opts.fsyncPath);
      opts.verifyTarget?.();
      notes.push(`auto-apply receipt recovered on ${destination.short} @ ${prior.commit}`);
      return destination.short;
    }
    const driverKey = externalMergeDriver(opts.repo, env);
    if (driverKey !== undefined) {
      notes.push(`target repo defines external merge driver (${driverKey}); refusing content merge — left the result on branch ${branch}`);
      return branch;
    }


    const baseSha = git(opts.repo, env, ["rev-parse", "--verify", `${destination.ref}^{commit}`]);
    const ambiguous = exec("git", ["-C", opts.repo, "merge-base", "--is-ancestor", branchSha, baseSha], { env });
    if (ambiguous.code === 0) {
      throw new Error(
        `candidate branch ${branchRef} already appears in ${destination.ref} without this run's durable automatic-delivery receipt`,
      );
    }
    if (ambiguous.code !== 1) {
      throw new Error(`cannot prove candidate ancestry for ${destination.ref}: ${ambiguous.stderr.trim()}`);
    }
    const tree = mergeTree(opts.repo, env, baseSha, branchSha);
    if (tree === null || tree === "") {
      notes.push(`auto-merge into ${destination.short} has conflicts; left the result on branch ${branch}`);
      return branch;
    }
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
    const receipt: AutoDeliveryReceipt = {
      version: 1,
      runId: opts.runId,
      ref: destination.ref,
      branchRef,
      baseSha,
      branchSha,
      tree,
      commit,
    };

    // Durability order: objects → semantic receipt → destination ref. The
    // receipt is validated from parents+merge tree on every recovery.
    syncLooseObjectDirs(join(opts.repo, ".git"), opts.fsyncPath);
    assertWritableStore(opts.repo, undefined, env, [opts.baselineCommit]);
    opts.verifyTarget?.();
    validateAutoReceipt(opts, env, receipt, destination.ref, branchRef, branchSha);
    writeFileDurable(receiptPath, `${JSON.stringify(receipt)}\n`);
    assertWritableStore(opts.repo, undefined, env, [opts.baselineCommit]);
    opts.verifyTarget?.();
    git(opts.repo, env, ["update-ref", destination.ref, commit, baseSha]);
    syncPublishedRef(join(opts.repo, ".git"), destination.ref, commit, opts.fsyncPath);
    opts.verifyTarget?.();
    notes.push(`auto-applied to ${destination.short} @ ${commit} (ref-only update; no working tree was written)`);
    return destination.short;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function deliver(opts: DeliverOptions): DeliverResult {
  assertLadder(opts.mode, opts.improverSeat, opts.env);
  if (opts.gitDir !== undefined && opts.mode !== "branch" && opts.mode !== "pr") {
    throw new Error(`apply mode '${opts.mode}' cannot target an explicitly bound git store`);
  }
  const notes: string[] = [];
  switch (opts.mode) {
    case "none":
      return { ref: null, notes: ["apply mode none — report only; use `hone apply --best` to land it manually"] };
    case "branch": {
      const { branch, commit } = branchDeliver(opts, notes);
      notes.push(`applied ${opts.artifact} to branch ${branch} @ ${commit}`);
      return { ref: branch, notes };
    }
    case "pr":
      return { ref: prDeliver(opts, notes), notes };
    case "auto":
      return { ref: autoDeliver(opts, notes), notes };
  }
}
