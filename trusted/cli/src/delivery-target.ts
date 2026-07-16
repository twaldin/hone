import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { devNull } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ApplyMode } from "@hone/schema";
import { CAPSULE_SNAPSHOT_FILE, authenticateCapsuleSnapshot, readCapsuleSnapshot } from "./admission.js";
import { UsageError } from "./args.js";
import { assertNoGraftedAncestry } from "./deliver.js";
import { writeFileDurable } from "./eventlog.js";
import { assertPlainGitStore, baselineGitDir } from "./git-baseline.js";
import { gitTimeoutError, gitTimeoutMs } from "./git-bound.js";
import { assertObjectIntegrity } from "./git-integrity.js";

/**
 * Explicitly bound, fully validated target for MANUAL delivery
 * (`hone apply --best`, `hone stop --take-best`).
 *
 * Fail-closed rules:
 *  - an explicit --repo is REQUIRED — manual delivery never defaults to the
 *    working root the CLI happens to run from;
 *  - the run must durably bind a git baseline (sealed capsule-manifest.json
 *    with baseline.kind === "git"); a missing snapshot or a CAS baseline is
 *    a refusal, never a guess;
 *  - the named directory must BE the repository: either a repo whose own
 *    top level is exactly that directory (Git parent-repository discovery
 *    can never pick the target), or a capsule baseline directory whose
 *    embedded plain `.gitdir` store is bound explicitly and whose HEAD
 *    equals the frozen baseline commit;
 *  - the target must already contain the sealed baseline commit — a
 *    repository that never had the capsule baseline is the wrong repository.
 */
/** Immutable filesystem identity (bigint-exact dev:ino) of a validated path. */
export interface FsIdentity {
  dev: string;
  ino: string;
}

/**
 * Per-run random marker durably created INSIDE the target's git store at
 * seal time. dev:ino alone is not an incarnation proof — a deleted and
 * recreated directory can be handed the same inode number — so publication
 * additionally requires the sealed nonce to still sit inside the store.
 */
export interface TargetMarker {
  /** Plain store-local filename (never a path). */
  file: string;
  nonce: string;
}

export interface DeliveryTarget {
  /** Absolute path of the validated target repository (worktree root or capsule baseline dir). */
  repo: string;
  /** Explicit git store bind for an embedded-`.gitdir` baseline target. */
  gitDir?: string;
  /** Full destination ref selected and sealed at creation for apply:auto. */
  autoRef?: string;
  /** The frozen manifest baseline commit this run is sealed against. */
  baselineCommit: string;
  /** dev:ino of the validated repo root at validation time. */
  repoIdentity: FsIdentity;
  /** dev:ino of the git store backing the target (`<repo>/.git` or the embedded `.gitdir`). */
  storeIdentity: FsIdentity;
  /** Present on a sealed target (delivery-target.json); absent on a fresh manual resolution. */
  marker?: TargetMarker;
}

/** The git store that backs a validated target. */
export function targetStoreDir(target: Pick<DeliveryTarget, "repo" | "gitDir">): string {
  return target.gitDir ?? join(target.repo, ".git");
}

function fsIdentity(path: string): FsIdentity {
  const st = statSync(path, { bigint: true });
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}

/**
 * Minimal, closed environment for target validation probes: no system or
 * global config, no replace refs, no commit-graph reads (a checksum-valid
 * forged graph could fabricate ancestry), no prompts. `ceiling` pins
 * discovery so `-C <dir>` probes can never walk above the directory the
 * operator named. (`info/grafts` ancestry forgery is rejected separately —
 * assertNoGraftedAncestry — since no environment knob disables grafts.)
 */
function probeEnv(ceiling?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    // Replace refs are disabled above; a forged objects/info/commit-graph
    // would still feed fabricated ancestry into merge-base without any
    // raw-object cross-check — pin graph reads off at command scope, which
    // outranks hostile repo-local config.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.commitgraph",
    GIT_CONFIG_VALUE_0: "false",
    // A promisor/partial-clone target must never lazy-fetch (or run a
    // remote helper) during VALIDATION: missing objects fail locally.
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "none",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    ...(ceiling !== undefined ? { GIT_CEILING_DIRECTORIES: ceiling } : {}),
  };
}

/** Bounded validation probe: hard timeout + SIGKILL + output cap (git-bound.ts) — a wedged or hostile target repo fails validation closed. */
function runGit(args: string[], env: NodeJS.ProcessEnv): { code: number; stdout: string } {
  const timeout = gitTimeoutMs();
  const r = spawnSync("git", args, { encoding: "utf8", env, timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || r.signal === "SIGKILL") {
      throw gitTimeoutError(`git ${args.join(" ")}`, timeout);
    }
    throw r.error;
  }
  return { code: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
}

/** HEAD of an explicitly bound git store, or null when unborn/unreadable. */
function storeHead(gitDir: string): string | null {
  const r = runGit(["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], probeEnv());
  return r.code === 0 && /^[0-9a-f]{40}$/.test(r.stdout) ? r.stdout : null;
}

/** True when --repo names an embedded capsule-baseline directory (plain `.gitdir` store). */
export function isEmbeddedBaselineTarget(root: string, repoArg: string): boolean {
  const named = resolve(root, repoArg);
  if (!existsSync(named) || !statSync(named).isDirectory()) return false;
  return existsSync(join(realpathSync(named), ".gitdir"));
}

/**
 * Resolve and validate the delivery target for a run. Throws UsageError for
 * an omitted --repo (operator misuse) and Error for every fail-closed
 * refusal. Never returns a guessed target. When `applyMode` is given, modes
 * an embedded store cannot support (auto merges into a checked-out branch;
 * an embedded `.gitdir` store has no checkout) refuse here.
 */
export function resolveDeliveryTarget(
  root: string,
  runDir: string,
  repoArg: string | undefined,
  applyMode?: ApplyMode,
  sealedAutoRef?: string,
): DeliveryTarget {
  if (repoArg === undefined) {
    throw new UsageError(
      "manual delivery writes into a repository — pass an explicit --repo DIR (it never defaults to the current root)",
    );
  }
  if (!existsSync(join(runDir, CAPSULE_SNAPSHOT_FILE))) {
    throw new Error(
      `run has no sealed ${CAPSULE_SNAPSHOT_FILE} — it does not durably bind a delivery baseline; refusing to deliver`,
    );
  }
  const manifest = readCapsuleSnapshot(runDir);
  if (manifest.baseline.kind !== "git") {
    throw new Error(
      "sealed capsule baseline is a CAS artifact, not a git commit — the run binds no git delivery target; refusing manual apply (inspect the artifact with `hone diff` instead)",
    );
  }
  const baselineCommit = manifest.baseline.commit;

  // Canonicalize FIRST: the sealed identity is the real filesystem object,
  // never a symlink alias that can be silently retargeted later.
  const named = resolve(root, repoArg);
  if (!existsSync(named) || !statSync(named).isDirectory()) {
    throw new Error(`delivery target ${named} is not a directory`);
  }
  const repo = realpathSync(named);

  // Capsule baseline directory with an embedded plain store: bind it
  // explicitly (Git never discovers `.gitdir`) and require its HEAD to be
  // exactly the frozen baseline commit — anything else is not the sealed
  // baseline and must not receive the run's branches.
  if (existsSync(join(repo, ".gitdir"))) {
    if (applyMode === "auto") {
      throw new Error(
        "--apply auto merges into a checked-out repository branch and cannot target an embedded capsule-baseline store (.gitdir) — use --apply branch or --apply pr, or target the real repository",
      );
    }
    const gitDir = baselineGitDir(repo); // validates plainness + no external object indirection
    // Ancestry over this store must come from its REAL object graph: a
    // nonempty info/grafts rewrites parenthood for every rev walk.
    assertNoGraftedAncestry(gitDir);
    // Hash-verify the store's object database (and the baseline's full
    // closure) BEFORE trusting any read over it: ordinary plumbing never
    // recomputes object ids (git-integrity.ts).
    assertObjectIntegrity({ gitDir }, [baselineCommit], probeEnv(), "embedded baseline store");
    const head = storeHead(gitDir);
    if (head !== baselineCommit) {
      throw new Error(
        `embedded baseline store ${gitDir} has HEAD ${head ?? "(unborn)"} but the run is sealed to baseline commit ${baselineCommit} — refusing to deliver`,
      );
    }
    return { repo, gitDir, baselineCommit, repoIdentity: fsIdentity(repo), storeIdentity: fsIdentity(gitDir) };
  }

  // Ordinary repository target: the named directory must itself be the
  // repository root. Discovery is ceilinged at its parent AND the resolved
  // top level must realpath-equal the named directory, so a plain
  // subdirectory of some outer repository (e.g. the Hone monorepo) can
  // never be silently escalated to that outer repository.
  // `.git` must be a PLAIN in-tree directory: a gitfile ("gitdir: …") or a
  // symlink can silently rebind the named repository to a different store
  // between validation and delivery. Linked worktrees/submodules are not
  // deliverable targets.
  const dotGit = join(repo, ".git");
  if (!existsSync(dotGit)) {
    throw new Error(
      `${repo} is not a git repository root (no .git entry) — delivery never discovers a parent repository; pass the exact repository root as --repo`,
    );
  }
  if (!lstatSync(dotGit).isDirectory()) {
    throw new Error(
      `${repo}/.git is not a plain directory (gitfile or symlink indirection) — refusing: the delivery target must own its git store in-tree`,
    );
  }
  assertPlainGitStore(dotGit);
  const env = probeEnv(dirname(repo));
  const top = runGit(["-C", repo, "rev-parse", "--show-toplevel"], env);
  if (top.code !== 0 || top.stdout === "" || realpathSync(top.stdout) !== realpathSync(repo)) {
    throw new Error(
      `${repo} does not resolve to its own repository top level — refusing anything but the exact repository root`,
    );
  }
  let autoRef: string | undefined;
  if (applyMode === "auto") {
    const selected = sealedAutoRef ?? runGit(["-C", repo, "symbolic-ref", "--quiet", "HEAD"], env).stdout;
    if (
      !selected.startsWith("refs/heads/")
      || selected === "refs/heads/"
      || runGit(["check-ref-format", selected], env).code !== 0
    ) {
      throw new Error(
        sealedAutoRef === undefined
          ? `target ${repo} has no valid checked-out branch to seal for apply:auto`
          : `sealed apply:auto destination ${JSON.stringify(sealedAutoRef)} is not a valid branch ref`,
      );
    }
    autoRef = selected;
  } else if (sealedAutoRef !== undefined) {
    throw new Error(`sealed apply:auto destination ${sealedAutoRef} cannot be used with apply mode ${applyMode ?? "unspecified"}`);
  }
  // Reject grafted ancestry BEFORE the containment proof below: an
  // unrelated repository that imported the baseline objects and grafted
  // `HEAD baseline` would otherwise pass merge-base --is-ancestor.
  assertNoGraftedAncestry(dotGit);
  // Hash-verify the object database BEFORE the reachability proof below:
  // merge-base parses commits off the ordinary (non-rehashing) read path,
  // so a valid-zlib object stored under the wrong oid would otherwise
  // forge containment (git-integrity.ts).
  assertObjectIntegrity({ repo }, [baselineCommit], env, "delivery target");
  // Containment must be REACHABILITY, not object existence: a dangling
  // object proves nothing about this repository's history. Auto delivery is
  // bound to the branch selected at run creation; resume never re-selects
  // whichever branch HEAD happens to name later.
  const containmentRef = autoRef ?? "HEAD";
  const contained = runGit(["-C", repo, "merge-base", "--is-ancestor", baselineCommit, containmentRef], env);
  if (contained.code !== 0) {
    throw new Error(
      `target ${repo} does not contain the sealed baseline commit ${baselineCommit} in ${containmentRef} — wrong repository or wrong branch; refusing to deliver`,
    );
  }
  return {
    repo,
    ...(autoRef !== undefined ? { autoRef } : {}),
    baselineCommit,
    repoIdentity: fsIdentity(repo),
    storeIdentity: fsIdentity(dotGit),
  };
}

/**
 * Immutable-identity check, run on every revalidation and IMMEDIATELY before
 * publication (deliver's verifyTarget hook fires right before each ref
 * update): the repo root and its git store must still be the exact
 * filesystem objects (dev:ino) that were validated, and — for a sealed
 * target — the store must still carry the run's random marker, so a
 * renamed, deleted+recreated (inode-reused), or cloned-into-place directory
 * fails closed with no ref moved.
 */
export function assertTargetIdentity(target: DeliveryTarget): void {
  const store = targetStoreDir(target);
  const checks: [label: string, path: string, sealed: FsIdentity][] = [
    ["repository root", target.repo, target.repoIdentity],
    ["git store", store, target.storeIdentity],
  ];
  for (const [label, path, sealed] of checks) {
    let fresh: FsIdentity;
    try {
      fresh = fsIdentity(path);
    } catch {
      throw new Error(`delivery target ${label} ${path} no longer exists — refusing to publish`);
    }
    if (fresh.dev !== sealed.dev || fresh.ino !== sealed.ino) {
      throw new Error(
        `delivery target ${label} ${path} is not the validated filesystem object (dev:ino ${fresh.dev}:${fresh.ino} != sealed ${sealed.dev}:${sealed.ino}) — it was replaced or rebound; refusing to publish`,
      );
    }
  }
  // Authority-bearing subpaths must remain plain too: Git follows symlinks
  // below an unchanged .git inode when reading/writing objects and refs.
  assertPlainGitStore(store);
  if (target.marker !== undefined) {
    const markerPath = join(store, target.marker.file);
    let content: string;
    try {
      content = readFileSync(markerPath, "utf8");
    } catch {
      throw new Error(
        `delivery marker ${markerPath} is missing — the sealed git store is not the incarnation this run bound; refusing to publish`,
      );
    }
    if (content.trim() !== target.marker.nonce) {
      throw new Error(
        `delivery marker ${markerPath} does not carry the sealed nonce — the git store was replaced by another incarnation; refusing to publish`,
      );
    }
  }
  // A grafts file added AFTER sealing must still fail the immediate
  // pre-publication/recovery gate — every ancestry proof of the delivery
  // state machine is meaningless over grafted parenthood.
  assertNoGraftedAncestry(store);
}

/**
 * Durable delivery-target sidecar. `hone run --repo DIR` seals the exact
 * validated repo/git-dir identity + frozen baseline commit into the run dir
 * at creation, so automatic delivery at run end (apply != none) targets a
 * durably bound repository — never a root Git guessed at delivery time. A
 * run without a sidecar binds NO automatic target.
 */
export const DELIVERY_TARGET_FILE = "delivery-target.json";

/** Store-local marker filename prefix; the suffix is the run id. */
export const TARGET_MARKER_PREFIX = "hone-delivery-marker.";

const FsIdentitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });

const PersistedTarget = z.object({
  repo: z.string().min(1),
  gitDir: z.string().min(1).optional(),
  autoRef: z.string().regex(/^refs\/heads\/.+$/).optional(),
  baselineCommit: z.string().regex(/^[0-9a-f]{40}$/),
  repoIdentity: FsIdentitySchema,
  storeIdentity: FsIdentitySchema,
  marker: z.object({
    // Plain store-local filename — a sidecar can never smuggle a path.
    file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
  }),
});

/**
 * Validate `repoArg` for this run and durably seal it as the run's delivery
 * target: filesystem identities (dev:ino of repo root and git store), a
 * fresh random marker fsynced INSIDE the git store (inode reuse defeats
 * dev:ino alone), and the frozen baseline commit. The sealed target is
 * rendered into the approved contract, so run.started.contractHash binds it.
 */
export function sealDeliveryTarget(root: string, runDir: string, repoArg: string, applyMode?: ApplyMode): DeliveryTarget {
  const resolved = resolveDeliveryTarget(root, runDir, repoArg, applyMode);
  const marker: TargetMarker = {
    file: `${TARGET_MARKER_PREFIX}${basename(runDir)}`,
    nonce: randomBytes(16).toString("hex"),
  };
  // write-all → fsync → rename → fsync store dir: the marker (and its
  // dirent) is durable before the sidecar that references it is published.
  writeFileDurable(join(targetStoreDir(resolved), marker.file), `${marker.nonce}\n`);
  const target: DeliveryTarget = { ...resolved, marker };
  writeFileDurable(join(runDir, DELIVERY_TARGET_FILE), `${JSON.stringify(target, null, 2)}\n`);
  return target;
}

/**
 * Load the sealed delivery target and RE-VALIDATE it from scratch (the
 * repository may have changed since creation): the capsule snapshot must
 * authenticate against run.started + the approved contract, the target must
 * re-resolve to the exact sealed repo/gitDir/baseline, and the sealed
 * filesystem identities + in-store marker must still hold. Returns null when
 * the run never sealed a target — the run binds no automatic delivery
 * target. Throws (fail closed) on a corrupt sidecar or a target that no
 * longer validates exactly as sealed.
 */
export function readSealedDeliveryTarget(root: string, runDir: string, applyMode?: ApplyMode): DeliveryTarget | null {
  const path = join(runDir, DELIVERY_TARGET_FILE);
  if (!existsSync(path)) return null;
  // The snapshot names the baseline that target validation checks against —
  // authenticate it BEFORE consuming it.
  authenticateCapsuleSnapshot(runDir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`sealed delivery target ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = PersistedTarget.safeParse(raw);
  if (!parsed.success) throw new Error(`sealed delivery target ${path} is malformed — refusing to deliver`);
  const sealed = parsed.data;
  const target: DeliveryTarget = {
    repo: sealed.repo,
    ...(sealed.gitDir !== undefined ? { gitDir: sealed.gitDir } : {}),
    ...(sealed.autoRef !== undefined ? { autoRef: sealed.autoRef } : {}),
    baselineCommit: sealed.baselineCommit,
    repoIdentity: sealed.repoIdentity,
    storeIdentity: sealed.storeIdentity,
    marker: sealed.marker,
  };
  const revalidated = resolveDeliveryTarget(root, runDir, sealed.repo, applyMode, sealed.autoRef);
  if (
    revalidated.repo !== resolve(root, sealed.repo)
    || revalidated.gitDir !== sealed.gitDir
    || revalidated.baselineCommit !== sealed.baselineCommit
    || revalidated.autoRef !== sealed.autoRef
  ) {
    throw new Error(
      `sealed delivery target ${path} no longer validates as sealed (repo/gitDir/baseline drift) — refusing to deliver`,
    );
  }
  // Sealed identity + marker: the path may re-validate while naming a
  // DIFFERENT filesystem object (rename/recreate/clone-into-place).
  assertTargetIdentity(target);
  return target;
}
