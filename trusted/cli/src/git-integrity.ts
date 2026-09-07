import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { gitTimeoutError, gitTimeoutMs } from "./git-bound.js";

/**
 * Exact object-integrity verification for every git store the trusted CLI
 * derives authority from (delivery targets, embedded baseline stores, the
 * capsule git baseline).
 *
 * Why fsck and never the ordinary read plumbing: `cat-file`, `ls-tree`,
 * `rev-parse` and `merge-base` serve loose objects straight off the inflated
 * zlib stream WITHOUT recomputing the object id (git skips
 * check_object_signature on the ordinary read path). A valid-zlib
 * commit/tree/blob stored under the WRONG oid is therefore silently served
 * as that oid — forged content rides every ancestry/tree/byte "proof" built
 * on those commands. `git fsck` is the one plumbing command that RE-HASHES
 * the store: every loose object is inflated and its id recalculated, and
 * every packfile is verified object-by-object (verify_pack), under the
 * store's declared object format — so both SHA-1 and SHA-256 stores are
 * covered by the same recalculation. Passing the trusted roots additionally
 * proves their full commit→tree→blob closures are PRESENT (a missing object
 * in the closure is a hard fsck error), so a later cat-file/ls-tree over
 * those roots can only ever return bytes whose ids were just recomputed.
 *
 * `--connectivity-only` is deliberately absent — it skips exactly the hash
 * recalculation this gate exists for. `--no-reflogs` keeps reflog entries
 * from widening the trusted root set; `--no-dangling` only silences
 * dangling REPORTING (unreachable objects are still re-hashed, and a
 * corrupt one still fails), keeping output bounded on messy stores.
 */

/** fsck findings on a hostile store can be large; cap and fail closed on overflow. */
const MAX_FSCK_OUTPUT = 16 * 1024 * 1024;

/** Error/output excerpt kept small enough for event logs. */
const EXCERPT_LIMIT = 2048;

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= EXCERPT_LIMIT ? trimmed : `${trimmed.slice(0, EXCERPT_LIMIT)}… (truncated)`;
}

/**
 * Append command-scope config entries AFTER whatever the caller's
 * environment already injects via GIT_CONFIG_COUNT/KEY_n/VALUE_n — never
 * clobbering existing entries (later entries win on duplicate keys, and the
 * appended pins are identical to the callers' own, so re-pinning is
 * harmless).
 */
export function appendGitConfigEnv(env: NodeJS.ProcessEnv, entries: [key: string, value: string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  const declared = Number.parseInt(out["GIT_CONFIG_COUNT"] ?? "0", 10);
  const base = Number.isSafeInteger(declared) && declared > 0 ? declared : 0;
  for (const [i, [key, value]] of entries.entries()) {
    out[`GIT_CONFIG_KEY_${base + i}`] = key;
    out[`GIT_CONFIG_VALUE_${base + i}`] = value;
  }
  out["GIT_CONFIG_COUNT"] = String(base + entries.length);
  return out;
}

/** The store fsck runs against: an explicit store pin, or -C discovery inside an already-validated repo root. */
export interface IntegrityStore {
  /** Repository worktree root (`git -C <repo>`); ignored when gitDir is set. */
  repo?: string;
  /** Explicit git store (`--git-dir=<gitDir>`); no repository discovery of any kind. */
  gitDir?: string;
}

/**
 * Bounded, fail-closed `git fsck --strict` over the store, tracing from the
 * given trusted roots. Throws on ANY of: malformed root, spawn failure,
 * wall-clock bound (git-bound.ts, SIGKILL), output-cap overflow, nonzero
 * exit, or fatal/error diagnostics on stderr despite exit 0. Runs with
 * replace refs, lazy fetching, transports, commit-graph reads, and any
 * repo-local fsck.skipList pinned off (appended after the caller's own
 * injected config, never clobbering it). Grafted ancestry is rejected
 * separately (assertNoGraftedAncestry) — fsck itself walks raw parenthood
 * only.
 *
 * A root that does not EXIST as an object is skipped rather than reported
 * as corruption: the store-wide rehash below still runs in full, and the
 * caller's own containment/HEAD-equality proof over that root then fails
 * closed with its precise wrong-repository diagnostic (an absent object
 * can never satisfy an ancestry or identity proof). The existence probe
 * decides ONLY which refusal fires — it never enables a success path.
 */
export function assertObjectIntegrity(
  store: IntegrityStore,
  roots: string[],
  env: NodeJS.ProcessEnv,
  what: string,
): void {
  for (const root of roots) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(root)) {
      throw new Error(`${what}: refusing object-integrity verification from malformed root ${JSON.stringify(root)}`);
    }
  }
  const storeDir = store.gitDir ?? (store.repo !== undefined ? join(store.repo, ".git") : undefined);
  const args =
    store.gitDir !== undefined
      ? [`--git-dir=${store.gitDir}`]
      : store.repo !== undefined
        ? ["-C", store.repo]
        : undefined;
  if (args === undefined || storeDir === undefined) {
    throw new Error(`${what}: object-integrity verification needs an explicit repo or gitDir`);
  }
  // Objects borrowed through alternates live OUTSIDE the validated store:
  // even a closure fsck just hash-verified can be swapped out from under
  // the delivery by mutating the alternate directory (the sealed dev:ino
  // identity never covers it). No trusted store may borrow objects.
  // (GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_OBJECT_DIRECTORY are never
  // inherited — every trusted env is built from scratch.)
  for (const rel of ["alternates", "http-alternates"]) {
    if (existsSync(join(storeDir, "objects", "info", rel))) {
      throw new Error(
        `${what}: git store ${storeDir} borrows objects via objects/info/${rel} — external object indirection is outside the sealed store identity and its integrity cannot be pinned; refusing`,
      );
    }
  }
  const fsckEnv = appendGitConfigEnv(env, [
    ["core.commitgraph", "false"],
    // A hostile repo-local fsck.skipList could exempt exactly the forged
    // objects from verification; command-scope wins over local config, and
    // /dev/null parses as the empty oid list. (fsck.<msg>=ignore knobs only
    // downgrade msg-id-classified CONTENT findings — hash-recomputation
    // mismatches and missing closure objects are unconditional errors — but
    // those knobs are still neutralized below.)
    ["fsck.skiplist", devNull],
  ]);
  fsckEnv["GIT_NO_REPLACE_OBJECTS"] = "1";
  fsckEnv["GIT_NO_LAZY_FETCH"] = "1";
  fsckEnv["GIT_ALLOW_PROTOCOL"] = "none";
  fsckEnv["GIT_PROTOCOL_FROM_USER"] = "0";
  // Enforced, not assumed: no env-level object-store indirection may leak
  // into the verification run even if a caller env ever carried it.
  delete fsckEnv["GIT_ALTERNATE_OBJECT_DIRECTORIES"];
  delete fsckEnv["GIT_OBJECT_DIRECTORY"];
  const timeout = gitTimeoutMs();

  // Neutralize repo-local fsck severity downgrades: a hostile store's
  // `fsck.<msg> = ignore|warn` entries would silence exactly the content
  // findings --strict exists to surface (a malformed object under a valid
  // id sails through an fsck whose local config ignores its msg-id).
  // Enumerate every fsck.* key the verification run would resolve (command
  // scope + local/worktree; system and global never load under trusted
  // envs) and re-pin each to `error` at command scope, which outranks the
  // store's own config. fsck.skiplist is excluded — it is already pinned to
  // the empty list above. An unenumerable config is itself untrustworthy.
  const cfg = spawnSync("git", [...args, "config", "-z", "--get-regexp", "^fsck\\."], {
    env: fsckEnv,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (cfg.error) {
    if ((cfg.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || cfg.signal === "SIGKILL") {
      throw gitTimeoutError(`git config fsck.* enumeration (${what})`, timeout);
    }
    throw new Error(`${what}: cannot enumerate fsck.* config (${cfg.error.message}) — refusing to trust the store`);
  }
  if (cfg.status !== 0 && cfg.status !== 1) {
    throw new Error(
      `${what}: cannot enumerate fsck.* config overrides (git config exited ${cfg.status ?? "(signal)"}: ${excerpt((cfg.stderr ?? Buffer.alloc(0)).toString("utf8"))}) — refusing to trust the store`,
    );
  }
  const severityKeys = new Set<string>();
  for (const record of (cfg.stdout ?? Buffer.alloc(0)).toString("utf8").split("\0")) {
    if (record === "") continue;
    const nl = record.indexOf("\n");
    const key = (nl < 0 ? record : record.slice(0, nl)).toLowerCase();
    if (key !== "fsck.skiplist") severityKeys.add(key);
  }
  const runEnv =
    severityKeys.size === 0
      ? fsckEnv
      : appendGitConfigEnv(
          fsckEnv,
          [...severityKeys].map((key): [string, string] => [key, "error"]),
        );

  const presentRoots: string[] = [];
  for (const root of roots) {
    const probe = spawnSync("git", [...args, "rev-parse", "--verify", "--quiet", `${root}^{object}`], {
      env: runEnv,
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    if (probe.error) {
      if ((probe.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || probe.signal === "SIGKILL") {
        throw gitTimeoutError(`git rev-parse root probe (${what})`, timeout);
      }
      throw new Error(`${what}: cannot probe root ${root} (${probe.error.message}) — refusing to trust the store`);
    }
    if (probe.status === 0) presentRoots.push(root);
  }
  args.push("fsck", "--strict", "--no-progress", "--no-reflogs", "--no-dangling", ...presentRoots);

  const r = spawnSync("git", args, { env: runEnv, timeout, killSignal: "SIGKILL", maxBuffer: MAX_FSCK_OUTPUT });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || r.signal === "SIGKILL") {
      throw gitTimeoutError(`git fsck (${what})`, timeout);
    }
    if (code === "ENOBUFS") {
      throw new Error(`${what}: git fsck exceeded the ${MAX_FSCK_OUTPUT}-byte output cap — refusing to trust the store`);
    }
    throw new Error(`${what}: git fsck could not run (${r.error.message}) — refusing to trust the store`);
  }
  const stdout = (r.stdout ?? Buffer.alloc(0)).toString("utf8");
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString("utf8");
  if ((r.status ?? -1) !== 0) {
    throw new Error(
      `${what}: object-integrity verification failed — git fsck exited ${r.status ?? "(signal)"}: ${excerpt(`${stderr}\n${stdout}`)} — the store's object database does not hash-verify; refusing before any read is trusted or any write is made`,
    );
  }
  // Defense in depth: a zero exit with fatal/error diagnostics on stderr is
  // still an untrustworthy verification run.
  if (/(^|\n)\s*(fatal|error):/i.test(stderr)) {
    throw new Error(
      `${what}: git fsck exited 0 but reported errors: ${excerpt(stderr)} — refusing to trust the store`,
    );
  }
}
