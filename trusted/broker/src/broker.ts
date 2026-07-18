import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BudgetState,
  CapsuleManifest,
  CreateSandboxParams,
  EvaluateParams,
  EvaluationRecord,
  EvaluatorOutput,
  ExecParams,
  ExecResult,
  FinishParams,
  GetFileParams,
  GetFileResult,
  GetTaskResult,
  PutFileParams,
  ReportIncumbentParams,
  SandboxRef,
  SaveArtifactParams,
  RunEvent,
  type ArtifactRef,
} from "@hone/schema";
import { HoldoutBudgetExceededError, HoldoutLedger } from "@hone/scoring";
import { MAX_ARTIFACT_BYTES, canonicalizeWorkspaceTar, diffProtectedPaths, dirSizeBytes, findProtectedPaths, unpackArtifact } from "./artifact.js";
import { CasStore, durability } from "./cas.js";
import { runCommand, type CmdResult, type RunCommand } from "./command.js";
import { deferred } from "./deferred.js";
import { BrokerError } from "./errors.js";
import { ArtifactValidationError, MAX_ARTIFACT_ENTRIES, validateWorkspaceTar } from "./tarcheck.js";

export type BudgetDimension = "tokens" | "usd" | "wallClockSec" | "evaluatorInvocations";

/** Internal method (admin socket only): the proxy reports LLM spend. */
export const RecordSpendParams = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});

export interface CallContext {
  /** True only for connections on the trusted admin socket (broker-admin.sock). */
  privileged: boolean;
}

/** Trusted host-only evaluator seam. It is never reachable through broker RPC or sandbox environment. */
export interface TrustedEvaluationStrategyInput {
  runId: string;
  capsuleId: string;
  artifact: ArtifactRef;
  assetGroupId: string;
  seed: number;
  measurementEpoch?: string | undefined;
}

export type TrustedEvaluationStrategy = (input: TrustedEvaluationStrategyInput) => Promise<EvaluationRecord>;

/** Mutation-sandbox network: fully isolated, or attached to a broker-managed internal network. */
export type SandboxNetworkMode = { mode: "none" } | { mode: "internal"; network: string };

export interface BrokerConfig {
  runId: string;
  manifest: CapsuleManifest;
  /** Directory holding the capsule's asset groups (paths in the manifest are relative to it). */
  capsuleRootDir: string;
  /** CAS hash of the trusted-measured baseline artifact. */
  baselineArtifactHash: string;
  /**
   * Full frozen baseline used only as the trusted evaluator's code mount.
   * When present, baselineArtifactHash is the protected-path-free mutation
   * lineage root and this hash is never exposed through broker RPC.
   */
  evaluatorBaselineArtifactHash?: string | undefined;
  /** Full canonical capsule digest ("sha256:<64 hex>") — pins the frozen capsule in the eval memo key. */
  capsuleDigest: string;
  /** Digest of the optimizer artifact driving this run ("sha256:<64 hex>") — also memo-key material. */
  optimizerDigest: string;
  /**
   * Trusted M1 replicate identity. Omitted for M0, preserving the exact
   * legacy memo key and `eval` cache namespace. This value is process config,
   * never a sandbox RPC or environment input.
   */
  measurementEpoch?: string | undefined;
  /** Optional host-only evaluator strategy used by the trusted M1 outer broker. */
  evaluationStrategy?: TrustedEvaluationStrategy | undefined;
  /**
   * Number of distinct public candidate artifacts that may enter evaluation.
   * Default 1 preserves M0's one-candidate authority exactly.
   */
  maxPublicCandidateEvaluations?: number | undefined;
  /**
   * Trusted outer-campaign graceful fence: the number of distinct non-baseline
   * artifacts whose trusted strategy returned an eligible result. Invalid and
   * duplicate attempts do not count. Public getBudget reports evaluator
   * exhaustion at the target; internal spend and privileged views stay exact.
   */
  trustedValidPublicCandidateTarget?: number | undefined;
  /**
   * Repo-lifetime holdout ledger file (shared across runs of this capsule).
   * The broker creates it on first init(); the lifetime access count NEVER
   * resets when a new run opens the same path.
   */
  holdoutLedgerPath: string;
  /** OCI image for both mutation and eval sandboxes (seed: one image). */
  image: string;
  /** Per-run dir: sockets, scratch, unpack cache, durable run state live here. */
  runDir: string;
  /** Repo-wide CAS root (.hone-cas). */
  casDir: string;
  /** Event sink — the runner appends these to events.ndjson. The broker never touches the log itself. */
  onEvent: (event: RunEvent) => void;
  scratchQuotaBytes?: number | undefined;
  /** Per-mutation-sandbox writable /workspace tmpfs cap. Default 1 GiB. */
  workspaceQuotaBytes?: number | undefined;
  defaultTtlSec?: number | undefined;
  reaperIntervalMs?: number | undefined;
  evalTimeoutSec?: number | undefined;
  execOutputLimitBytes?: number | undefined;
  /** Aggregate unique session-trace bytes admitted to CAS for this run. Default 64 MiB. */
  sessionTraceQuotaBytes?: number | undefined;
  /** Lifetime holdout-access ledger budget (immutable once the ledger file exists); defaults to maxEvaluatorInvocations. */
  holdoutBudget?: number | undefined;
  /**
   * Narrow terminal-phase release: holdout groups listed here become reachable
   * on the public mutation socket for this broker instance only. Trusted
   * orchestration sets this only after the campaign's terminal holdout latch.
   */
  terminalHoldoutAssetGroupIds?: readonly string[] | undefined;
  /**
   * Network mode for MUTATION sandboxes only (WP7 macOS decision: proxy runs
   * as a container on a shared --internal network; sandboxes attach to it as
   * their only reachable endpoint). Eval sandboxes are ALWAYS --network none.
   * Default: { mode: "none" }.
   */
  sandboxNetwork?: SandboxNetworkMode | undefined;
  /**
   * Env injected into MUTATION sandboxes only (e.g. HONE_PROXY_BASE_URL,
   * HONE_PROXY_TOKEN) — trusted config, never transits the client protocol.
   */
  mutationEnv?: Record<string, string> | undefined;
  /** DI seam for the docker/tar CLI — tests observe container spawns through it. */
  runCommand?: RunCommand | undefined;
  /** Injectable clock (ms) for TTL/wall-clock determinism in tests. */
  now?: (() => number) | undefined;
  /**
   * First episode ordinal (resume: the runner passes replayed nextEpisode so
   * trusted episode numbering stays monotone across restarts). The broker's
   * own durable state is authoritative; the max of both wins. Default 0.
   */
  episodeOrigin?: number | undefined;
  /** Hard cap on simultaneously-live mutation sandboxes. Default 8. */
  maxActiveSandboxes?: number | undefined;
  /** Hard cap on concurrent evaluator containers. Default 4. */
  maxConcurrentEvaluations?: number | undefined;
  /** Hard cap on new mutation episode boundaries across the run. Default 64. */
  maxMutationEpisodes?: number | undefined;
  /** Hard cap on distinct candidate/repair artifacts admitted across the run. Default 128. */
  maxCandidateArtifacts?: number | undefined;
  /** Aggregate canonical candidate/repair artifact bytes admitted to CAS. Default 2 GiB. */
  maxCandidateArtifactBytes?: number | undefined;
  /**
   * Aggregate candidate/repair artifact tar ENTRIES admitted across the run.
   * Every admitted artifact can be retained as an unpacked tree under the
   * run's unpack cache, so this is the durable ceiling on host inodes a
   * hostile optimizer can mint; the trusted baseline is never charged.
   * Default 262,144 (2× MAX_ARTIFACT_ENTRIES).
   */
  maxCandidateArtifactEntries?: number | undefined;
  /** docker --pids-limit for every container this broker spawns. Default 512. */
  sandboxPidsLimit?: number | undefined;
  /** docker --memory (bytes) for every container this broker spawns. Default 2 GiB. */
  sandboxMemoryBytes?: number | undefined;
  /** docker --cpus for every container this broker spawns. Default 2. */
  sandboxCpus?: number | undefined;
  /**
   * Name of the run's stopped docker-run lease (donor) container. When set,
   * every container this broker spawns (keeper, mutation sandboxes,
   * evaluators) declares `--volumes-from <lease>:ro`, so removing the donor
   * is a daemon-side creation fence: a create that has not resolved the
   * donor can no longer start after teardown. Lifecycle is owned by the CLI.
   */
  containerLease?: string | undefined;
  /**
   * When true, /scratch is a per-run docker LOCAL tmpfs volume sized to
   * scratchQuotaBytes — the kernel enforces the quota at write time. If the
   * daemon cannot create such a volume, init() FAILS: the host bind mount's
   * polling quota only measures between broker calls and would let one exec
   * fill the host disk. Production runs set this; the default false keeps the
   * host bind + polling quota for tests/dev only.
   */
  scratchVolume?: boolean | undefined;
}

/** A journaled promotion — the unit of trusted incumbent authority. */
export interface IncumbentState {
  hash: string;
  aggregate: number;
  deltaVsBaseline: number;
  episode: number;
}

interface SandboxEntry {
  containerId: string;
  expiresAtMs: number;
  /** Trusted episode ordinal assigned at creation (one per mutation sandbox). */
  episode: number;
  /** Artifact the sandbox was unpacked from — trusted lineage parent for candidates it saves. */
  parentHash: string;
  /** Exact bytes from the most recent exec, retained only until candidate admission. */
  lastExecStdout: Buffer | null;
  /** Exit code of the most recent exec; a candidate save requires 0. */
  lastExecExitCode: number | null;
  /** Whether the most recent exec's captured output hit the size cap — a candidate requires a COMPLETE trace. */
  lastExecTruncated: boolean | null;
}

const MISSING_CONTAINER_RE = /no such container|is not running|no such object/i;
const containerGone = (res: CmdResult): boolean =>
  res.exitCode === 0 || MISSING_CONTAINER_RE.test(res.stderr.toString("utf8"));
const STATE_FILE = "broker-state.ndjson";
const SCRATCH_SNAPSHOT_DIR = "scratch-snapshot";
const SCRATCH_SNAPSHOT_FILE = "scratch.tar";
/** Prefix shared by every unpublished snapshot output (per-attempt files, in-container pid temps, legacy shared temps) — swept, never published as-is. */
export const SCRATCH_SNAPSHOT_TMP_PREFIX = "scratch.tar.tmp.";
/**
 * Mints the collision-proof, unguessable (128-bit random) per-attempt output
 * basename for ONE snapshot attempt. Trusted HOST code generates it and
 * passes it into the bounded in-container script via the per-exec env
 * HONE_SCRATCH_SNAPSHOT_OUT; only that exact basename may be finalized, so an
 * orphaned exec from an OLDER (e.g. host-timed-out) attempt — which only ever
 * knows ITS OWN basename — can neither overwrite nor satisfy a newer attempt.
 */
export function newScratchSnapshotAttemptName(): string {
  return `${SCRATCH_SNAPSHOT_TMP_PREFIX}${randomBytes(16).toString("hex")}`;
}
/** tmpfs inode cap for the /scratch volume — bounds how many archive entries a hostile tree can mint. */
export const SCRATCH_INODE_LIMIT = 131072;
/**
 * tmpfs inode cap for each mutation /workspace volume: the archive admission
 * ceiling plus explicit headroom for the tmpfs root itself and transient
 * temp files a mutating process needs — so an exactly-admitted
 * MAX_ARTIFACT_ENTRIES tree can still extract and mutate, while saveArtifact
 * keeps enforcing the exact archive cap at admission.
 */
export const WORKSPACE_TMPFS_INODES = MAX_ARTIFACT_ENTRIES + 1024;
/** Host-side wall clock granted to the snapshot `docker exec`. */
const SCRATCH_SNAPSHOT_HOST_TIMEOUT_MS = 300_000;
/** In-container tar deadline — strictly below the host exec timeout, so a
 * killed host CLI can never leave tar running inside the keeper. */
export const SCRATCH_SNAPSHOT_DEADLINE_SEC = 270;

/**
 * Kernel-enforced byte cap for the snapshot archive: the scratch payload
 * quota plus a bounded per-inode allowance for tar metadata (512 B header +
 * long-name extension + padding ≈ 2 KiB per entry, entry count bounded by
 * the volume's inode cap) plus the 10 KiB end-of-archive record. A tree
 * whose archive outgrows this — e.g. a flood of zero-byte entries or
 * adversarial path names — kills tar via RLIMIT_FSIZE instead of writing
 * unbounded bytes to the host.
 */
export function scratchSnapshotArchiveCapBytes(scratchQuotaBytes: number): number {
  return scratchQuotaBytes + SCRATCH_INODE_LIMIT * 2048 + 10240;
}

/**
 * Runs inside the scratch keeper (`docker exec -u root <keeper> /bin/sh -c`).
 * The ENTIRE work sequence — apparent-size preflight (find/stat/awk), the
 * RLIMIT_FSIZE cap, tar, and the atomic in-container temp rename — is
 * bounded by a pure-sh watchdog that SIGKILLs the exec's whole PROCESS
 * GROUP (`kill -9 0`; without job control every process this script spawns
 * shares the exec's group, and the keeper's own PID 1 lives in a different
 * session) after HONE_SCRATCH_SNAPSHOT_DEADLINE_SEC:
 * - the deadline is strictly below the host exec timeout, so a killed host
 *   CLI can never leave find/stat/awk/tar running, and any orphan from a
 *   host-timeout attempt is already dead before the next retry or unpause;
 * - `ulimit -f` (RLIMIT_FSIZE) bounds the archive bytes the kernel lets tar
 *   write to HONE_SCRATCH_SNAPSHOT_MAX_BYTES (POSIX sh counts 512-byte
 *   blocks; a shell using 1 KiB units merely doubles the still-hard cap);
 * - the apparent-size preflight keeps sparse files from smuggling bytes
 *   past the write-time tmpfs cap;
 * - the output path is the PER-ATTEMPT basename HONE_SCRATCH_SNAPSHOT_OUT
 *   (minted by trusted host code, see newScratchSnapshotAttemptName; the
 *   script validates it as a plain basename). tar writes `$out.$$` and
 *   renames it over `$out` only on success, so a not-yet-dead orphan from
 *   an older attempt — which only knows its own basename — can neither
 *   interleave bytes into nor substitute itself for a newer attempt's
 *   archive;
 * - the watchdog's stdio is detached so an orphaned sleep can never hold
 *   the exec streams open; a deadline kill takes the shell itself, so the
 *   exec reports SIGKILL (137) rather than printing.
 * The quota/cap/deadline env vars are baked into the keeper at creation, so
 * recovery execs (the CLI stale-run sweep) inherit identical bounds;
 * HONE_SCRATCH_SNAPSHOT_OUT is passed per exec (`-e`). The script only
 * produces the per-attempt temp; the trusted HOST publishes exactly that
 * basename durably and atomically via finalizeScratchSnapshot
 * (fsync tmp → rename → fsync dir) and sweeps every unpublished output on
 * every outcome.
 */
export const SCRATCH_SNAPSHOT_SCRIPT =
  "set -eu; " +
  "( set -eu; " +
  "case \"${HONE_SCRATCH_SNAPSHOT_OUT:?}\" in *[!A-Za-z0-9._-]*|.|..) echo 'invalid snapshot output basename' >&2; exit 1;; esac; " +
  "out=\"/snapshot/${HONE_SCRATCH_SNAPSHOT_OUT}\"; " +
  "total=$(find /scratch -type f -exec stat -c %s {} + | awk '{s+=$1} END{print s+0}'); " +
  "[ \"$total\" -le \"${HONE_SCRATCH_QUOTA_BYTES:?}\" ] || { echo 'scratch apparent size exceeds quota' >&2; exit 1; }; " +
  "ulimit -f $(( (${HONE_SCRATCH_SNAPSHOT_MAX_BYTES:?} + 511) / 512 )); " +
  "tar -cf \"$out.$$\" -C /scratch .; " +
  "mv -f \"$out.$$\" \"$out\" " +
  ") & workpid=$!; " +
  "( sp=; trap 'kill -9 $sp 2>/dev/null; wait $sp 2>/dev/null; exit 0' TERM; sleep \"${HONE_SCRATCH_SNAPSHOT_DEADLINE_SEC:?}\" & sp=$!; wait \"$sp\" || exit 0; kill -9 0 ) >/dev/null 2>&1 </dev/null & watchpid=$!; " +
  "rc=0; wait \"$workpid\" || rc=$?; " +
  "kill \"$watchpid\" 2>/dev/null || true; wait \"$watchpid\" 2>/dev/null || true; " +
  "[ \"$rc\" -eq 0 ] || { echo \"scratch snapshot failed or exceeded its byte cap: rc=$rc\" >&2; exit 1; }";

/**
 * Publishes ONE attempt's completed snapshot durably and atomically on the
 * HOST: fsync(<per-attempt temp>) → rename over scratch.tar → fsync(parent
 * dir). BusyBox images may lack `sync -f`, so power-loss ordering lives in
 * trusted host code, never in the container. A crash at any point leaves
 * either the previous snapshot or the new one — never a torn scratch.tar.
 * Only the caller's own per-attempt output (newScratchSnapshotAttemptName)
 * may be published: a leftover written late by any OTHER attempt's orphan
 * can never satisfy this one.
 */
export async function finalizeScratchSnapshot(snapshotDir: string, attemptName: string): Promise<void> {
  if (path.basename(attemptName) !== attemptName || !attemptName.startsWith(SCRATCH_SNAPSHOT_TMP_PREFIX)) {
    throw new BrokerError("INTERNAL", `refusing to publish non-attempt snapshot output: ${attemptName}`);
  }
  const tmp = path.join(snapshotDir, attemptName);
  await durability.syncFile(tmp);
  await durability.rename(tmp, path.join(snapshotDir, SCRATCH_SNAPSHOT_FILE));
  await durability.syncDir(snapshotDir);
}

type CreateSandboxP = z.infer<typeof CreateSandboxParams>;
type ExecP = z.infer<typeof ExecParams>;
type ExecR = z.infer<typeof ExecResult>;
type PutFileP = z.infer<typeof PutFileParams>;
type GetFileP = z.infer<typeof GetFileParams>;
type GetFileR = z.infer<typeof GetFileResult>;
type SaveArtifactP = z.infer<typeof SaveArtifactParams>;
type EvaluateP = z.infer<typeof EvaluateParams>;
type ReportIncumbentP = z.infer<typeof ReportIncumbentParams>;
type FinishP = z.infer<typeof FinishParams>;
type GetTaskR = z.infer<typeof GetTaskResult>;
type RecordSpendP = z.infer<typeof RecordSpendParams>;

/**
 * Trusted-side event derivation (WP7 boundary ruling): the mutable optimizer
 * has NO event authority — every RunEvent about its activity is derived here
 * from the broker method calls it makes, with scores recomputed from the
 * broker's own EvaluationRecords (claimed metrics are never trusted).
 */
type EmittableEvent =
  | { type: "budget.exhausted"; dimension: string }
  | { type: "holdout.accessed"; capsuleId: string; ledgerCount: number; ledgerBudget: number }
  | { type: "episode.started"; episode: number; parent: ArtifactRef }
  | { type: "episode.candidate"; episode: number; candidate: ArtifactRef; sessionTrace: string }
  | { type: "eval.completed"; episode?: number; artifact: ArtifactRef; assetGroupId: string; seed: number; aggregate: number; cached: boolean }
  | { type: "gate.paired"; episode: number; parentScore: number; childScore: number; passed: boolean }
  | { type: "incumbent.new"; artifact: ArtifactRef; aggregate: number; deltaVsBaseline: number; episode: number }
  | { type: "budget.snapshot"; budget: BudgetState };
const BROKER_EVENT_TYPES = new Set<RunEvent["type"]>([
  "holdout.accessed",
  "episode.started",
  "episode.candidate",
  "eval.completed",
  "gate.paired",
  "incumbent.new",
]);

/** Whether an event type is emitted exclusively by the broker (budgets are shared with the supervisor). */
export function isBrokerAuthoredEvent(event: RunEvent): boolean {
  return BROKER_EVENT_TYPES.has(event.type);
}

/**
 * Durable run-state journal, one JSON line per authority-bearing fact. Every
 * line is appended + fsynced BEFORE the corresponding action is acknowledged
 * (write-ahead), so a broker restart replays to exactly the authority and
 * budgets that were ever granted — resume can never reset them. All writes
 * are SYNCHRONOUS: single-threaded JS makes every check-then-append atomic,
 * which is what serializes concurrent holdout charges.
 */
const JournalEvents = z.array(RunEvent).optional();

/**
 * Persisted parent-first gate identity: the lineage parent's SAME-EPOCH score
 * captured at the instant the candidate's measurement was accepted. Journaled
 * inside the eval fact; replay restores it verbatim (never re-derives).
 */
const GateFact = z.object({
  parent: z.string(),
  parentScore: z.number(),
  childScore: z.number(),
  passed: z.boolean(),
});
type GateFact = z.infer<typeof GateFact>;

const StateLine = z.discriminatedUnion("t", [
  z.object({ t: z.literal("start"), atMs: z.number(), events: JournalEvents }),
  z.object({ t: z.literal("spend"), tokens: z.number().int().nonnegative(), usd: z.number().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("inv"), events: JournalEvents }),
  z.object({ t: z.literal("holdout"), seq: z.number().int().positive(), events: JournalEvents }),
  z.object({
    t: z.literal("eval"),
    record: EvaluationRecord,
    /** Measurement generation (`${bootNonce}:{startup|ep<N>}`); legacy lines lack it and grant no gate authority. */
    epoch: z.string().optional(),
    /** Trusted M1 replicate identity; absent on M0 and legacy journal facts. */
    measurementEpoch: z.string().optional(),
    /** Monotone trusted mint ordinal of `epoch` (see mintEpochSeq); pre-ordinal lines rank by first appearance in the journal. */
    epochSeq: z.number().int().nonnegative().optional(),
    /** Persisted parent-first same-epoch gate identity (see recordEvaluation). */
    gate: GateFact.optional(),
    events: JournalEvents,
  }),
  z.object({ t: z.literal("episode"), episode: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("lineage"), candidate: z.string(), parent: z.string(), episode: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("repair"), hash: z.string(), parent: z.string(), episode: z.number().int().nonnegative(), events: JournalEvents }),
  /** M0 candidate attempt: the one public non-baseline evaluator admission, WAL'd before spawn. */
  z.object({ t: z.literal("slot"), hash: z.string().regex(/^sha256:[0-9a-f]{64}$/), events: JournalEvents }),
  z.object({ t: z.literal("trace"), hash: z.string().regex(/^sha256:[0-9a-f]{64}$/), bytes: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({
    t: z.literal("artifact"),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    // Entry count of the canonical archive (host-inode charge). Optional so
    // pre-entry-quota journals still replay; every new line records it.
    entries: z.number().int().nonnegative().optional(),
    events: JournalEvents,
  }),
  z.object({
    t: z.literal("incumbent"),
    hash: z.string(),
    aggregate: z.number(),
    deltaVsBaseline: z.number(),
    episode: z.number().int().nonnegative(),
    events: JournalEvents,
  }),
  z.object({ t: z.literal("migration"), events: z.array(RunEvent) }),
  z.object({ t: z.literal("event"), event: RunEvent }),
]);
type StateLine = z.infer<typeof StateLine>;
type StateFact = Exclude<StateLine, { t: "event" | "migration" }>;

/**
 * Journal write primitives, grouped in a mutable object (mirrors cas.ts
 * `durability`) so focused tests can inject partial-write/fsync failures.
 * Signatures are narrowed to the exact forms the journal uses.
 */
export const journalIo = {
  write(fd: number, buf: Buffer, offset: number, length: number): number {
    return writeSync(fd, buf, offset, length);
  },
  fsync(fd: number): void {
    fsyncSync(fd);
  },
  syncDir(dir: string): void {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
};

class RunStateLog {
  /** Set on the first append failure; the writer is permanently unusable. */
  private poisoned: string | undefined;

  private constructor(
    private readonly fd: number,
    readonly replayed: readonly StateLine[],
  ) {}

  static open(filePath: string): RunStateLog {
    let content = Buffer.alloc(0);
    try {
      content = readFileSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Absent is valid: openSync below creates the journal.
    }
    // Only newline-terminated lines are authoritative; bytes after the last
    // newline are a torn crash-write whose action was never acknowledged.
    // Durably truncate them BEFORE replay/append — otherwise the next record
    // would fuse onto the torn tail and corrupt the journal on the restart
    // after that.
    const keep = content.lastIndexOf(0x0a) + 1; // 0 when no newline exists
    const fd = openSync(filePath, "a");
    try {
      if (keep !== content.length) ftruncateSync(fd, keep);
      // Every opener re-establishes durability before replaying authority.
      // This closes both recovery windows: a prior failed directory fsync
      // after creation, and a complete newline write whose file fsync failed.
      journalIo.fsync(fd);
      journalIo.syncDir(path.dirname(filePath));
      const rawLines = content.subarray(0, keep).toString("utf8").split("\n");
      rawLines.pop();
      const replayed = rawLines.map((line, i) => {
        try {
          return StateLine.parse(JSON.parse(line));
        } catch {
          throw new BrokerError("INTERNAL", `run state log corrupt at line ${i + 1}: ${filePath}`);
        }
      });
      return new RunStateLog(fd, replayed);
    } catch (err) {
      // Never leak the fd on a post-open failure (truncate/replay/parse).
      try {
        closeSync(fd);
      } catch {
        // the original failure wins
      }
      throw err;
    }
  }

  /** Throws once a prior append failure has poisoned this writer. */
  assertUsable(): void {
    if (this.poisoned !== undefined) {
      throw new BrokerError(
        "INTERNAL",
        `run state log unusable after append failure (${this.poisoned}); restart to truncate the torn tail`,
      );
    }
  }

  /** Append + fsync, blocking. Returns only once the whole line is durable. */
  append(line: StateLine): void {
    this.assertUsable();
    const buf = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
    try {
      let written = 0;
      while (written < buf.length) {
        written += journalIo.write(this.fd, buf, written, buf.length - written);
      }
      journalIo.fsync(this.fd);
    } catch (err) {
      // The failed write/fsync may have left a torn, non-newline-terminated
      // tail. This writer is permanently poisoned: appending (and thus
      // acknowledging) any later fact could fuse it onto the torn bytes and
      // corrupt the journal. Only a restart — whose open() durably truncates
      // the unterminated tail — may write again.
      this.poisoned = err instanceof Error ? err.message : String(err);
      try {
        closeSync(this.fd);
      } catch {
        // fd state is unknown after the I/O failure; poisoning already
        // guarantees no further use.
      }
      throw new BrokerError("INTERNAL", `run state log append failed: ${this.poisoned}`);
    }
  }

  close(): void {
    if (this.poisoned !== undefined) return; // fd already closed when poisoned
    closeSync(this.fd);
  }
}
/**
 * Read-only, torn-tail-aware authority-journal validation for dead-run
 * sealing. Every complete fact is parsed, not merely lines carrying events.
 */
export function readBrokerJournalEvents(runDir: string): RunEvent[] | null {
  const filePath = path.join(runDir, STATE_FILE);
  let content: Buffer;
  try {
    content = readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const keep = content.lastIndexOf(0x0a) + 1;
  const rawLines = content.subarray(0, keep).toString("utf8").split("\n");
  rawLines.pop();
  const events: RunEvent[] = [];
  let hasEventFormat = false;
  for (const [index, raw] of rawLines.entries()) {
    let line: StateLine;
    try {
      line = StateLine.parse(JSON.parse(raw));
    } catch {
      throw new BrokerError("INTERNAL", `run state log corrupt at line ${index + 1}: ${filePath}`);
    }
    if (line.t === "event" || line.t === "migration" || line.events !== undefined) hasEventFormat = true;
    if (line.t === "event") events.push(line.event);
    else if (line.events !== undefined) events.push(...line.events);
  }
  return hasEventFormat ? events : null;
}

export interface BrokerJournalEvaluationSnapshot {
  records: readonly EvaluationRecord[];
  journalHash: `sha256:${string}`;
  lineCount: number;
}

/** Strict completed-child evidence reader: unlike recovery, a torn tail is never publishable evidence. */
export function readBrokerJournalEvaluations(runDir: string): BrokerJournalEvaluationSnapshot {
  const filePath = path.join(runDir, STATE_FILE);
  const content = readFileSync(filePath);
  if (content.length === 0 || content[content.length - 1] !== 0x0a) {
    throw new BrokerError("INTERNAL", `run state log has a torn tail: ${filePath}`);
  }
  const rawLines = content.toString("utf8").split("\n");
  rawLines.pop();
  const records: EvaluationRecord[] = [];
  for (const [index, raw] of rawLines.entries()) {
    let line: StateLine;
    try {
      line = StateLine.parse(JSON.parse(raw));
    } catch {
      throw new BrokerError("INTERNAL", `run state log corrupt at line ${index + 1}: ${filePath}`);
    }
    if (line.t === "eval") records.push(line.record);
  }
  return {
    records,
    journalHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    lineCount: rawLines.length,
  };
}

/**
 * Trusted scalarization gate: a record grants promotion authority only when
 * the evaluator declared it valid, produced at least one finite objective,
 * and EVERY constraint passed. Returns the aggregate (mean of objectives) or
 * undefined for ineligible records.
 */
function eligibleAggregate(record: EvaluationRecord): number | undefined {
  const out = record.output;
  if (!out.valid) return undefined;
  const values = Object.values(out.objectives);
  if (values.length === 0 || !values.every((v) => Number.isFinite(v))) return undefined;
  if (!Object.values(out.constraints).every(Boolean)) return undefined;
  const aggregate = values.reduce((a, b) => a + b, 0) / values.length;
  return Number.isFinite(aggregate) ? aggregate : undefined;
}

/**
 * Sandbox broker (review IV.1): the optimizer is an unprivileged CLIENT; all
 * containers are SIBLINGS spawned by this trusted daemon via the docker CLI.
 * No global state — everything hangs off the config so the runner (WP7) can
 * compose several brokers in one process.
 */
export class Broker {
  readonly manifest: CapsuleManifest;
  readonly cas: CasStore;
  private readonly run: RunCommand;
  private readonly now: () => number;
  private readonly safeRunId: string;
  private readonly scratchDir: string;
  private readonly proxySockPath: string;
  private readonly unpackRoot: string;
  private readonly tmpDir: string;
  private readonly scratchSnapshotDir: string;
  private readonly scratchSnapshotPath: string;
  private readonly scratchKeeperName: string;
  private readonly scratchQuotaBytes: number;
  private readonly workspaceQuotaBytes: number;
  private readonly defaultTtlSec: number;
  private readonly evalTimeoutSec: number;
  private readonly execOutputLimitBytes: number;
  private readonly sessionTraceQuotaBytes: number;
  private readonly holdoutBudget: number;
  private readonly terminalHoldoutAssetGroupIds: ReadonlySet<string>;
  private readonly maxActiveSandboxes: number;
  private readonly maxConcurrentEvaluations: number;
  private readonly maxMutationEpisodes: number;
  private readonly maxCandidateArtifacts: number;
  private readonly maxCandidateArtifactBytes: number;
  private readonly maxCandidateArtifactEntries: number;
  private readonly maxPublicCandidateEvaluations: number;
  private readonly trustedValidPublicCandidateTarget: number | undefined;
  private readonly sandboxPidsLimit: number;
  private readonly sandboxMemoryBytes: number;
  private readonly sandboxCpus: number;
  /** `--volumes-from <lease>:ro` when a docker-run lease fences creates; empty otherwise. */
  private readonly leaseArgs: readonly string[];
  /** Optional trusted M1 replicate identity, independent of the broker's boot/episode gate epoch. */
  private readonly trustedMeasurementEpoch: string | undefined;
  /** M0 remains `eval`; M1 receives a disjoint hash-derived cache namespace. */
  private readonly evaluationCacheNamespace: string;
  private readonly evaluationStrategy: TrustedEvaluationStrategy | undefined;
  /**
   * Fresh per-Broker-instance measurement generation. Part of the eval memo
   * key: after a kill/resume the new broker must re-measure comparators
   * (a parent eval cached hours before the crash must not stand in for
   * today's conditions), while retries within one boot still memoize.
   */
  private readonly bootNonce = randomUUID();
  /**
   * Current measurement generation: `${bootNonce}:startup` until the first
   * sandbox of this boot begins/resumes an episode; thereafter
   * `${bootNonce}:ep<N>` (set exactly where createSandbox journals or
   * resumes episode N). Comparator pairing and the eval memo are both scoped
   * to this value — never derived from ordinal arithmetic at call sites.
   */
  private measurementEpoch: string;
  /**
   * Trusted mint order of measurement epochs. Every epoch that can admit an
   * evaluation is assigned a monotone ordinal at the instant TRUSTED code
   * activates it (constructor startup, createSandbox episode boundary) or at
   * replay (restored verbatim from the journaled eval facts). Cross-epoch
   * gate authority compares these ordinals — NEVER async completion order.
   */
  private readonly epochSeqByName = new Map<string, number>();
  private nextEpochSeq = 0;

  private startedAtMs: number;
  private readonly spent = { tokens: 0, usd: 0, evaluatorInvocations: 0 };
  private readonly sandboxes = new Map<string, SandboxEntry>();
  /** Synchronous admission reservation: creations in flight but not yet in `sandboxes`. */
  private pendingSandboxes = 0;
  /** Synchronous admission reservation: real evaluations in flight but not yet charged. */
  private pendingEvaluations = 0;
  private readonly exhaustedAnnounced = new Set<string>();
  /** Durable unique session traces already charged to this run. */
  private readonly sessionTraceHashes = new Set<string>();
  private sessionTraceBytes = 0;
  /** Identical concurrent traces share one paid CAS write. */
  private readonly pendingSessionTraces = new Map<string, Promise<string>>();
  /** Same-provenance concurrent evaluations share one trusted invocation. */
  private readonly inFlightEvaluations = new Map<string, Promise<EvaluationRecord>>();
  private readonly candidateArtifactHashes = new Set<string>();
  private candidateArtifactBytes = 0;
  private candidateArtifactEntries = 0;
  /** Per-run journal ordinal for holdout charges (observability only — the persistent ledger is authority). */
  private holdoutCount = 0;
  /** Repo-lifetime holdout ledger — the ONLY holdout-access authority; opened in init(), never reset per run. */
  private ledger: HoldoutLedger | undefined;
  private lastIncumbent: ReportIncumbentP | undefined;
  private best: ArtifactRef | undefined;
  private reaper: NodeJS.Timeout | undefined;
  /** Next trusted episode ordinal (one per mutation sandbox created). */
  private episodeOrdinal: number;
  /** Synchronous reservations for concurrent new-episode sandbox creates. */
  private pendingNewEpisodes = 0;
  /** True once any episode of this RUN (including replayed ones) started — gates eval.completed emission. */
  private anyEpisodeStarted = false;
  /**
   * Epoch-scoped trusted measurements: `${epoch}|${artifactHash}` ->
   * (`${assetGroupId}|${seed}` -> aggregate) over this run's ELIGIBLE
   * non-holdout EvaluationRecords. The epoch is the measurement generation
   * (`${bootNonce}:{startup|ep<N>}`): a fresh re-measurement in a NEW epoch
   * is recorded — a stale pre-crash or pre-episode score never wins over
   * today's comparator — while within one epoch the first record wins, so
   * retries memoize.
   */
  private readonly trusted = new Map<string, Map<string, number>>();
  /** Lifetime (all-epoch) coordinates per artifact — public-event dedupe and existence checks, never pairing authority. */
  private readonly lifetimeCoords = new Map<string, Set<string>>();
  /**
   * The persisted promotion gate per candidate: its FIRST valid
   * parent-before-child SAME-EPOCH pair (exact coordinate + aggregates),
   * frozen forever the moment it is journaled. There is exactly ONE pair —
   * no supplementation, same epoch or not: every later parent/child pairing
   * (a later optimizer-minted episode, an earlier late-completing admission,
   * a retry, a resume, a lucky extra seed) stays a journaled measurement
   * that grants no authority. A failed first pair is therefore permanent —
   * no volume of fresh epochs, seeds, or re-reports can erase it. And the
   * pair exists at all only when it is the candidate's first-ever trusted
   * evidence (global artifact taint — see recordEvaluation): any candidate
   * measurement before a parent pair kills gate authority for that artifact
   * for good (evaluator cache side-channels make ANY earlier run of the
   * candidate, at any seed, an information leak worth shopping on). The pair
   * is journaled inside its eval fact, so replay rebuilds it verbatim.
   */
  private readonly gates = new Map<string, { epoch: string; pairKey: string; gate: GateFact }>();
  /**
   * Public candidate evaluation admissions. M0's default cap is one. A trusted
   * M1 constructor may raise the cap only while giving every child a fresh
   * measurement epoch; each distinct hash is WAL-admitted before evaluation.
   */
  private readonly promotionSlots = new Set<string>();
  private readonly trustedAcceptedCandidates = new Set<string>();
  /** Candidate artifact -> trusted lineage (parent it was mutated from + episode). */
  private readonly lineage = new Map<string, { parent: string; episode: number }>();
  /** Failed-exec repair snapshots: NOT candidates; sandboxes resumed from one reuse its episode. */
  private readonly repairs = new Map<string, { parent: string; episode: number }>();
  /** Trusted current incumbent — promotion is monotone against this. */
  private currentIncumbent: IncumbentState | undefined;
  /** Full ordered promotion history (replayed + live) — crash-resume event recovery. */
  private readonly incumbentHistory: IncumbentState[] = [];
  /** Full ordered broker-authored event journal, replayed before optimizer resume. */
  private readonly journalEvents: RunEvent[] = [];
  /** False only for pre-transaction journals; first reconciliation migrates them once. */
  private eventJournalFormat = false;
  private stateLog: RunStateLog | undefined;
  /** Set when /scratch is a quota-enforcing docker tmpfs volume (else host bind + polling quota). */
  private scratchVolumeName: string | undefined;
  /** Set once close() begins: no new operation is admitted. */
  private closing = false;
  /** Async operations (createSandbox/exec/putFile/getFile/saveArtifact/evaluate) in flight. */
  private inFlightOps = 0;
  /** close() callers awaiting the in-flight operation count to reach zero. */
  private readonly opDrainWaiters: Array<() => void> = [];
  /** Every spawned Docker container stays here until removal is positively confirmed. */
  private readonly trackedContainers = new Set<string>();
  /** One FIFO tail per sandbox; mutable Docker operations never interleave. */
  private readonly sandboxQueues = new Map<string, Promise<void>>();
  /** Run-wide mutable-operation tail: shared /scratch snapshots need exclusivity across sandboxes. */
  private mutationQueue: Promise<void> = Promise.resolve();
  /** Fair run-wide reader/writer gate: evaluations share; mutation Docker ops exclude them. */
  private readonly runGateQueue: Array<{
    mode: "evaluation" | "mutation";
    grant: (release: () => void) => void;
  }> = [];
  private runGateReaders = 0;
  private runGateWriter = false;
  /** One Docker pause set shared by every overlapping evaluator. */
  private activeEvaluationLeases = 0;
  private evaluationQuiescence: Promise<string[]> | undefined;
  /** A failed thaw permanently refuses further operations; close() can still reap containers. */
  private quiescencePoisoned: string | undefined;
  private scratchReady = false;

  constructor(private readonly config: BrokerConfig) {
    this.manifest = CapsuleManifest.parse(config.manifest);
    assertAssetGroupIsolation(this.manifest);
    assertAssetPathsResolveSafely(this.manifest, config.capsuleRootDir);
    this.cas = new CasStore(config.casDir);
    this.run = config.runCommand ?? runCommand;
    this.now = config.now ?? Date.now;
    if (
      config.measurementEpoch !== undefined &&
      (config.measurementEpoch.length === 0 ||
        config.measurementEpoch.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(config.measurementEpoch))
    ) {
      throw new BrokerError("INTERNAL", "measurementEpoch must be 1-256 characters without control characters");
    }
    this.trustedMeasurementEpoch = config.measurementEpoch;
    this.evaluationCacheNamespace =
      config.measurementEpoch === undefined
        ? "eval"
        : `eval-${createHash("sha256").update(config.measurementEpoch).digest("hex")}`;
    this.evaluationStrategy = config.evaluationStrategy;
    this.safeRunId = config.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
    this.scratchDir = path.join(config.runDir, "scratch");
    this.proxySockPath = path.join(config.runDir, "proxy.sock");
    this.unpackRoot = path.join(config.runDir, "unpacked");
    this.tmpDir = path.join(config.runDir, "tmp");
    this.scratchSnapshotDir = path.join(config.runDir, SCRATCH_SNAPSHOT_DIR);
    this.scratchSnapshotPath = path.join(this.scratchSnapshotDir, SCRATCH_SNAPSHOT_FILE);
    this.scratchKeeperName = `hone-scratch-keeper-${this.safeRunId}`;
    this.scratchQuotaBytes = config.scratchQuotaBytes ?? 1024 * 1024 * 1024;
    this.workspaceQuotaBytes = config.workspaceQuotaBytes ?? 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(this.workspaceQuotaBytes) || this.workspaceQuotaBytes <= 0) {
      throw new BrokerError("INTERNAL", "workspaceQuotaBytes must be a positive safe integer");
    }
    this.defaultTtlSec = config.defaultTtlSec ?? 3_600;
    this.evalTimeoutSec = config.evalTimeoutSec ?? 600;
    this.execOutputLimitBytes = config.execOutputLimitBytes ?? 1024 * 1024;
    this.sessionTraceQuotaBytes = config.sessionTraceQuotaBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.sessionTraceQuotaBytes) || this.sessionTraceQuotaBytes <= 0) {
      throw new BrokerError("INTERNAL", "sessionTraceQuotaBytes must be a positive safe integer");
    }
    this.holdoutBudget = config.holdoutBudget ?? this.manifest.budget.maxEvaluatorInvocations;
    const terminalHoldoutAssetGroupIds = new Set(config.terminalHoldoutAssetGroupIds ?? []);
    if (terminalHoldoutAssetGroupIds.size !== (config.terminalHoldoutAssetGroupIds?.length ?? 0)) {
      throw new BrokerError("INTERNAL", "terminal holdout asset group ids must be unique");
    }
    for (const assetGroupId of terminalHoldoutAssetGroupIds) {
      const group = this.manifest.assetGroups.find((candidate) => candidate.id === assetGroupId);
      if (group?.visibility !== "holdout") {
        throw new BrokerError("INTERNAL", `terminal holdout asset group ${assetGroupId} is not visibility=holdout`);
      }
    }
    this.terminalHoldoutAssetGroupIds = terminalHoldoutAssetGroupIds;
    this.maxActiveSandboxes = config.maxActiveSandboxes ?? 8;
    this.maxConcurrentEvaluations = config.maxConcurrentEvaluations ?? 4;
    this.maxMutationEpisodes = config.maxMutationEpisodes ?? 64;
    this.maxCandidateArtifacts = config.maxCandidateArtifacts ?? 128;
    this.maxPublicCandidateEvaluations = config.maxPublicCandidateEvaluations ?? 1;
    this.trustedValidPublicCandidateTarget = config.trustedValidPublicCandidateTarget;
    if (this.trustedValidPublicCandidateTarget !== undefined) {
      if (
        this.evaluationStrategy === undefined ||
        !Number.isSafeInteger(this.trustedValidPublicCandidateTarget) ||
        this.trustedValidPublicCandidateTarget <= 0 ||
        this.trustedValidPublicCandidateTarget > this.maxPublicCandidateEvaluations
      ) {
        throw new BrokerError("INTERNAL", "trusted valid-candidate target requires a trusted strategy and must fit the public candidate cap");
      }
    }
    this.maxCandidateArtifactBytes = config.maxCandidateArtifactBytes ?? 2 * 1024 * 1024 * 1024;
    this.maxCandidateArtifactEntries = config.maxCandidateArtifactEntries ?? 2 * MAX_ARTIFACT_ENTRIES;
    for (const [name, value] of [
      ["maxActiveSandboxes", this.maxActiveSandboxes],
      ["maxConcurrentEvaluations", this.maxConcurrentEvaluations],
      ["maxMutationEpisodes", this.maxMutationEpisodes],
      ["maxCandidateArtifacts", this.maxCandidateArtifacts],
      ["maxCandidateArtifactBytes", this.maxCandidateArtifactBytes],
      ["maxCandidateArtifactEntries", this.maxCandidateArtifactEntries],
      ["maxPublicCandidateEvaluations", this.maxPublicCandidateEvaluations],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new BrokerError("INTERNAL", `${name} must be a positive safe integer`);
      }
    }
    this.sandboxPidsLimit = config.sandboxPidsLimit ?? 512;
    this.sandboxMemoryBytes = config.sandboxMemoryBytes ?? 2 * 1024 * 1024 * 1024;
    this.sandboxCpus = config.sandboxCpus ?? 2;
    this.leaseArgs = config.containerLease !== undefined ? ["--volumes-from", `${config.containerLease}:ro`] : [];
    this.episodeOrdinal = config.episodeOrigin ?? 0;
    this.measurementEpoch = `${this.bootNonce}:startup`;
    this.startedAtMs = this.now();
    // Durable state opens (and replays) synchronously at construction — a
    // broker NEVER exists without its journal, so no method can act before
    // replay and no acknowledged fact can be lost to ordering.
    mkdirSync(config.runDir, { recursive: true });
    const stateLog = RunStateLog.open(path.join(config.runDir, STATE_FILE));
    try {
      this.validateReplay(stateLog);
      this.replayState(stateLog);
      // This boot's startup generation is minted ABOVE every replayed epoch:
      // fresh re-measurements are today's authority; replayed ones are not.
      this.mintEpochSeq(this.measurementEpoch);
    } catch (error) {
      stateLog.close();
      throw error;
    }
  }

  async init(): Promise<void> {
    await mkdir(this.scratchDir, { recursive: true });
    await mkdir(this.scratchSnapshotDir, { recursive: true });
    await chmod(this.scratchSnapshotDir, 0o700);
    await this.sweepScratchSnapshotTemps();
    // `unpacked/` and `tmp/` are derived exclusively from durable CAS and
    // admitted inputs. A SIGKILL may strand quota-sized extraction/staging
    // trees or a power-loss-partial final directory, so every boot discards
    // the entire run-scoped derived cache before any operation can observe it.
    await rm(this.unpackRoot, { recursive: true, force: true });
    await mkdir(this.unpackRoot, { recursive: true });
    await chmod(this.unpackRoot, 0o700);
    await rm(this.tmpDir, { recursive: true, force: true });
    await mkdir(this.tmpDir, { recursive: true });
    await chmod(this.tmpDir, 0o700);
    // Repo-lifetime holdout authority: the ledger file outlives this run. A
    // fresh file is created with the immutable budget; an existing one keeps
    // its lifetime count — a new run can NEVER reset it (budget mismatch
    // fails closed inside HoldoutLedger.open). open() creates the ledger's
    // directory chain itself and fsyncs every level through the durable
    // root's parent before it can accept a charge; when the ledger lives
    // inside the CAS store (the CLI's .hone-cas/ledgers layout) the chain
    // runs through the CAS root's parent, exactly like CAS publication.
    const ledgerDir = path.dirname(this.config.holdoutLedgerPath);
    const relToCas = path.relative(path.resolve(this.config.casDir), path.resolve(ledgerDir));
    const insideCas = relToCas === "" || (!relToCas.startsWith("..") && !path.isAbsolute(relToCas));
    this.ledger = await HoldoutLedger.open(this.config.holdoutLedgerPath, {
      budget: this.holdoutBudget,
      durableRoot: insideCas ? this.config.casDir : ledgerDir,
    });
    if (this.config.scratchVolume) {
      await this.provisionScratchVolume();
      await this.restoreScratchSnapshot();
      this.scratchReady = true;
    }
    const interval = this.config.reaperIntervalMs ?? 30_000;
    this.reaper = setInterval(() => {
      void this.reapExpired();
    }, interval);
    this.reaper.unref();
  }

  /**
   * Graceful close: new operations are rejected; active evaluator/mutation
   * containers are force-removed to unblock their Docker CLIs, then every
   * in-flight operation is awaited. The dedicated scratch keeper survives
   * that drain long enough to atomically snapshot the size-capped tmpfs
   * before the keeper and volume are removed. After return, no handler can
   * emit, spend, write, or mutate persistent scratch state.
   */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.reaper);
    const failures: string[] = [];
    const sweepWorkContainers = async (): Promise<void> => {
      const work = [...this.trackedContainers].filter((ref) => ref !== this.scratchKeeperName);
      await Promise.allSettled(work.map((ref) => this.removeTrackedContainer(ref)));
    };
    this.sandboxes.clear();

    // First pass interrupts active work; the second catches containers that
    // an in-flight create registered after the first snapshot.
    await sweepWorkContainers();
    if (this.inFlightOps > 0) {
      const drained = deferred<void>();
      this.opDrainWaiters.push(drained.resolve);
      await drained.promise;
    }
    await sweepWorkContainers();
    const workStillLive = [...this.trackedContainers].filter((ref) => ref !== this.scratchKeeperName);
    if (workStillLive.length > 0) failures.push(`containers still live: ${workStillLive.join(", ")}`);

    // Never snapshot or remove the keeper/volume while a mutation container
    // may still be writing. Preserve the whole scratch authority for the
    // next strict resume sweep, which will quiesce writers then snapshot.
    let scratchRemovable = workStillLive.length === 0;
    if (scratchRemovable && this.scratchVolumeName !== undefined && this.scratchReady) {
      try {
        await this.snapshotScratchVolume();
      } catch (error) {
        scratchRemovable = false;
        failures.push(`scratch snapshot: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (scratchRemovable && this.trackedContainers.has(this.scratchKeeperName)) {
      const removed = await this.removeTrackedContainer(this.scratchKeeperName);
      if (!containerGone(removed)) {
        scratchRemovable = false;
        failures.push(`container ${this.scratchKeeperName}: ${stderrText(removed)}`);
      }
    }
    if (scratchRemovable && this.scratchVolumeName !== undefined) {
      const volumeName = this.scratchVolumeName;
      try {
        const removed = await this.run(["docker", "volume", "rm", "-f", volumeName], { timeoutMs: 30_000 });
        if (removed.exitCode === 0 || /no such volume|not found/i.test(removed.stderr.toString("utf8"))) {
          this.scratchVolumeName = undefined;
        } else {
          failures.push(`volume ${volumeName}: ${stderrText(removed)}`);
        }
      } catch (err) {
        failures.push(`volume ${volumeName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.trackedContainers.size > 0) {
      failures.push(`containers still live: ${[...this.trackedContainers].join(", ")}`);
    }

    const ledger = this.ledger;
    this.ledger = undefined;
    try {
      await ledger?.close();
    } catch (err) {
      failures.push(`holdout ledger: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.stateLog?.close();
    } catch (err) {
      failures.push(`run journal: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.stateLog = undefined;
    if (failures.length > 0) {
      throw new BrokerError("INTERNAL", `broker cleanup incomplete: ${failures.join("; ")}`);
    }
  }

  /** Admission for async operations: rejected once close() has begun or the
   * journal writer is poisoned — no staging/CAS/Docker side effect may start
   * for an operation whose fact could never be acknowledged durably. */
  private enterOp(): void {
    if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
    this.stateLog?.assertUsable();
    this.assertQuiescenceUsable();
    this.inFlightOps += 1;
  }

  private exitOp(): void {
    this.inFlightOps -= 1;
    if (this.inFlightOps === 0) {
      for (const waiter of this.opDrainWaiters.splice(0)) waiter();
    }
  }

  private async serializeSandbox<T>(sandboxId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sandboxQueues.get(sandboxId) ?? Promise.resolve();
    const turn = deferred<void>();
    const tail = previous.then(() => turn.promise);
    this.sandboxQueues.set(sandboxId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      turn.resolve();
      if (this.sandboxQueues.get(sandboxId) === tail) this.sandboxQueues.delete(sandboxId);
    }
  }
  private acquireRunGate(mode: "evaluation" | "mutation"): Promise<() => void> {
    return new Promise((grant) => {
      this.runGateQueue.push({ mode, grant });
      this.drainRunGate();
    });
  }

  private drainRunGate(): void {
    if (this.runGateWriter) return;
    const next = this.runGateQueue[0];
    if (next === undefined) return;
    if (next.mode === "mutation") {
      if (this.runGateReaders !== 0) return;
      this.runGateQueue.shift();
      this.runGateWriter = true;
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true;
        this.runGateWriter = false;
        this.drainRunGate();
      });
      return;
    }
    while (this.runGateQueue[0]?.mode === "evaluation") {
      const reader = this.runGateQueue.shift();
      if (reader === undefined) break;
      this.runGateReaders += 1;
      let released = false;
      reader.grant(() => {
        if (released) return;
        released = true;
        this.runGateReaders -= 1;
        this.drainRunGate();
      });
    }
  }

  private assertQuiescenceUsable(): void {
    if (this.quiescencePoisoned !== undefined) {
      throw new BrokerError("INTERNAL", `evaluator quiescence is poisoned: ${this.quiescencePoisoned}`);
    }
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    const turn = deferred<void>();
    this.mutationQueue = previous.then(() => turn.promise);
    await previous;
    const releaseRunGate = await this.acquireRunGate("mutation");
    try {
      this.assertQuiescenceUsable();
      return await operation();
    } finally {
      releaseRunGate();
      turn.resolve();
    }
  }

  private async enterEvaluationQuiescence(): Promise<() => Promise<void>> {
    const releaseRunGate = await this.acquireRunGate("evaluation");
    try {
      this.assertQuiescenceUsable();
      if (this.activeEvaluationLeases === 0) {
        this.evaluationQuiescence = this.pauseRunContainersForEvaluation();
      }
      this.activeEvaluationLeases += 1;
      await this.evaluationQuiescence;
    } catch (error) {
      if (this.activeEvaluationLeases > 0) this.activeEvaluationLeases -= 1;
      if (this.activeEvaluationLeases === 0) this.evaluationQuiescence = undefined;
      releaseRunGate();
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.activeEvaluationLeases -= 1;
      try {
        if (this.activeEvaluationLeases === 0) {
          const quiescence = this.evaluationQuiescence;
          this.evaluationQuiescence = undefined;
          await this.unpauseRunContainersAfterEvaluation(quiescence === undefined ? [] : await quiescence);
        }
      } finally {
        releaseRunGate();
      }
    };
  }
  /**
   * The exact run label includes optimizer/relay containers created by the
   * CLI as well as broker-owned mutation sandboxes. The run-wide reader/
   * writer gate prevents mutable Docker operations from racing the
   * list/pause window.
   */
  private async pauseRunContainersForEvaluation(): Promise<string[]> {
    const listed = await this.run(
      ["docker", "ps", "-q", "--no-trunc", "--filter", `label=hone.runId=${this.config.runId}`],
      { timeoutMs: 30_000 },
    );
    if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) {
      throw new BrokerError("INTERNAL", `evaluator quiescence listing failed: ${stderrText(listed)}`);
    }
    const refs = listed.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (refs.some((ref) => !/^[0-9a-f]{12,64}$/.test(ref))) {
      throw new BrokerError("INTERNAL", "evaluator quiescence listing returned an invalid container id");
    }

    const paused: string[] = [];
    for (const ref of refs) {
      const result = await this.run(["docker", "pause", ref], { timeoutMs: 30_000 });
      if (result.exitCode !== 0 || result.timedOut || result.truncated) {
        try {
          await this.unpauseRunContainersAfterEvaluation(paused);
        } catch (cleanupError) {
          throw new BrokerError(
            "INTERNAL",
            `evaluator quiescence failed for ${ref}; rollback failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        }
        throw new BrokerError("INTERNAL", `evaluator quiescence failed for ${ref}: ${stderrText(result)}`);
      }
      paused.push(ref);
    }
    return paused;
  }

  private async unpauseRunContainersAfterEvaluation(refs: readonly string[]): Promise<void> {
    const failures: string[] = [];
    for (const ref of [...refs].reverse()) {
      const result = await this.run(["docker", "unpause", ref], { timeoutMs: 30_000 });
      const safelyInactive = /no such container|no such object|is not running|is not paused/i.test(result.stderr.toString("utf8"));
      if ((result.exitCode !== 0 || result.timedOut || result.truncated) && !safelyInactive) {
        failures.push(`${ref}: ${stderrText(result)}`);
      }
    }
    if (failures.length > 0) {
      this.quiescencePoisoned = failures.join("; ");
      throw new BrokerError("INTERNAL", `evaluator quiescence release failed: ${this.quiescencePoisoned}`);
    }
  }


  // ---------- durable run state ----------

  private state(): RunStateLog {
    if (!this.stateLog) throw new BrokerError("INTERNAL", "broker is closed");
    return this.stateLog;
  }

  /** Full semantic preflight: a corrupt journal changes no in-memory authority. */
  private validateReplay(log: RunStateLog): void {
    let holdoutSeq = 0;
    let traceBytes = 0;
    const traces = new Set<string>();
    let artifactBytes = 0;
    let artifactEntries = 0;
    const artifacts = new Set<string>();
    for (const line of log.replayed) {
      if (line.t === "eval" && line.measurementEpoch !== this.trustedMeasurementEpoch) {
        throw new BrokerError(
          "INTERNAL",
          "run state log measurementEpoch does not match trusted broker configuration",
        );
      }
      if (line.t === "holdout") {
        holdoutSeq += 1;
        if (line.seq !== holdoutSeq) {
          throw new BrokerError("INTERNAL", `run state log corrupt: holdout seq ${line.seq}, expected ${holdoutSeq}`);
        }
      } else if (line.t === "trace" && !traces.has(line.hash)) {
        traces.add(line.hash);
        traceBytes += line.bytes;
        if (traceBytes > this.sessionTraceQuotaBytes) {
          throw new BrokerError("INTERNAL", "run state log exceeds the configured session trace quota");
        }
      } else if (line.t === "artifact" && !artifacts.has(line.hash)) {
        artifacts.add(line.hash);
        artifactBytes += line.bytes;
        artifactEntries += line.entries ?? 0;
        if (
          artifacts.size > this.maxCandidateArtifacts ||
          artifactBytes > this.maxCandidateArtifactBytes ||
          artifactEntries > this.maxCandidateArtifactEntries
        ) {
          throw new BrokerError("INTERNAL", "run state log exceeds the configured candidate artifact quota");
        }
      }
    }
  }

  /** Replays the journal into in-memory authority/budget state. Never emits events. */
  private replayState(log: RunStateLog): void {
    this.stateLog = log;
    let firstStartMs: number | undefined;
    for (const line of log.replayed) {
      if (line.t === "event") {
        this.eventJournalFormat = true;
        this.journalEvents.push(line.event);
        if (line.event.type === "budget.exhausted") this.exhaustedAnnounced.add(line.event.dimension);
        continue;
      }
      if (line.events !== undefined) {
        this.eventJournalFormat = true;
        this.journalEvents.push(...line.events);
        for (const event of line.events) {
          if (event.type === "budget.exhausted") this.exhaustedAnnounced.add(event.dimension);
        }
      }
      switch (line.t) {
        case "migration":
          break;
        case "start":
          firstStartMs ??= line.atMs;
          break;
        case "spend":
          this.spent.tokens += line.tokens;
          this.spent.usd += line.usd;
          break;
        case "inv":
          this.spent.evaluatorInvocations += 1;
          break;
        case "holdout":
          if (line.seq !== this.holdoutCount + 1) {
            throw new BrokerError("INTERNAL", `run state log corrupt: holdout seq ${line.seq}, expected ${this.holdoutCount + 1}`);
          }
          this.holdoutCount = line.seq;
          break;
        case "artifact":
          if (!this.candidateArtifactHashes.has(line.hash)) {
            this.candidateArtifactHashes.add(line.hash);
            this.candidateArtifactBytes += line.bytes;
            this.candidateArtifactEntries += line.entries ?? 0;
          }
          break;
        case "eval":
          this.applyJournaledEval(line);
          break;
        case "episode":
          this.episodeOrdinal = Math.max(this.episodeOrdinal, line.episode + 1);
          this.anyEpisodeStarted = true;
          break;
        case "lineage": {
          // Live code journals lineage at most once per hash, so a second
          // line is old-journal/corruption territory: an identical restatement
          // is idempotent, a DIFFERENT parent or episode is a contradictory
          // persisted parent fact that could relineage a candidate — fail
          // closed rather than silently rewrite promotion ancestry.
          const prior = this.lineage.get(line.candidate);
          if (prior !== undefined && (prior.parent !== line.parent || prior.episode !== line.episode)) {
            throw new BrokerError(
              "INTERNAL",
              `run state log corrupt: contradictory lineage for ${line.candidate}: ` +
                `${prior.parent}@ep${prior.episode} vs ${line.parent}@ep${line.episode}`,
            );
          }
          this.lineage.set(line.candidate, { parent: line.parent, episode: line.episode });
          // Graduation: once a hash has candidate lineage it is never a
          // repair snapshot again — the lineage line is the tombstone.
          this.repairs.delete(line.candidate);
          break;
        }
        case "repair":
          this.repairs.set(line.hash, { parent: line.parent, episode: line.episode });
          break;
        case "slot":
          // Every slot hash is unique and bounded by the trusted constructor.
          // Repeating a fact is corruption even if it names the same hash.
          if (this.promotionSlots.has(line.hash)) {
            throw new BrokerError("INTERNAL", `run state log corrupt: duplicate promotion slot: ${line.hash}`);
          }
          if (this.promotionSlots.size >= this.maxPublicCandidateEvaluations) {
            throw new BrokerError("INTERNAL", `run state log exceeds public candidate evaluation cap ${this.maxPublicCandidateEvaluations}`);
          }
          if (!this.lineage.has(line.hash)) {
            throw new BrokerError("INTERNAL", `run state log corrupt: promotion slot has no prior lineage: ${line.hash}`);
          }
          this.promotionSlots.add(line.hash);
          break;
        case "trace":
          if (!this.sessionTraceHashes.has(line.hash)) {
            this.sessionTraceHashes.add(line.hash);
            this.sessionTraceBytes += line.bytes;
            if (this.sessionTraceBytes > this.sessionTraceQuotaBytes) {
              throw new BrokerError("INTERNAL", "run state log exceeds the configured session trace quota");
            }
          }
          break;
        case "incumbent": {
          const inc = { hash: line.hash, aggregate: line.aggregate, deltaVsBaseline: line.deltaVsBaseline, episode: line.episode };
          this.incumbentHistory.push(inc);
          this.currentIncumbent = inc;
          break;
        }
      }
    }
    // Wall clock is metered from the FIRST start of this run, ever — a
    // restart cannot rewind it.
    if (firstStartMs === undefined) {
      log.append({ t: "start", atMs: this.startedAtMs });
    } else {
      this.startedAtMs = Math.min(firstStartMs, this.startedAtMs);
    }
  }

  private reserveCandidateArtifact(hash: string, bytes: number, entries: number): void {
    if (hash === this.config.baselineArtifactHash || this.candidateArtifactHashes.has(hash)) return;
    if (this.candidateArtifactHashes.size >= this.maxCandidateArtifacts) {
      throw new BrokerError("QUOTA_EXCEEDED", `candidate artifact count cap reached (${this.maxCandidateArtifacts})`);
    }
    if (this.candidateArtifactBytes + bytes > this.maxCandidateArtifactBytes) {
      throw new BrokerError("QUOTA_EXCEEDED", `candidate artifact byte cap reached (${this.maxCandidateArtifactBytes})`);
    }
    if (this.candidateArtifactEntries + entries > this.maxCandidateArtifactEntries) {
      throw new BrokerError("QUOTA_EXCEEDED", `candidate artifact entry cap reached (${this.maxCandidateArtifactEntries})`);
    }
    this.state().append({ t: "artifact", hash, bytes, entries });
    this.candidateArtifactHashes.add(hash);
    this.candidateArtifactBytes += bytes;
    this.candidateArtifactEntries += entries;
  }

  private async persistSessionTrace(bytes: Buffer): Promise<string> {
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const inFlight = this.pendingSessionTraces.get(hash);
    if (inFlight !== undefined) return inFlight;

    // Charge unique bytes durably BEFORE touching CAS. A crash or disk error
    // may leave paid-but-missing content, never uncharged content. A retry
    // repairs that same hash without charging twice.
    if (!this.sessionTraceHashes.has(hash)) {
      if (this.sessionTraceBytes + bytes.length > this.sessionTraceQuotaBytes) {
        throw new BrokerError(
          "QUOTA_EXCEEDED",
          `session trace quota exceeded (${this.sessionTraceBytes + bytes.length} > ${this.sessionTraceQuotaBytes})`,
        );
      }
      this.state().append({ t: "trace", hash, bytes: bytes.length });
      this.sessionTraceHashes.add(hash);
      this.sessionTraceBytes += bytes.length;
    }

    const write = (async (): Promise<string> => {
      const stored = await this.cas.putBuffer(bytes);
      if (stored !== hash) throw new BrokerError("INTERNAL", "CAS returned the wrong session trace hash");
      return hash;
    })();
    this.pendingSessionTraces.set(hash, write);
    try {
      return await write;
    } finally {
      this.pendingSessionTraces.delete(hash);
    }
  }

  /** Assigns (once) the monotone trusted mint ordinal of an epoch activated by trusted code. */
  private mintEpochSeq(epoch: string): number {
    let seq = this.epochSeqByName.get(epoch);
    if (seq === undefined) {
      seq = this.nextEpochSeq;
      this.nextEpochSeq += 1;
      this.epochSeqByName.set(epoch, seq);
    }
    return seq;
  }

  /** Replay: restore a persisted epoch ordinal verbatim and keep every future mint strictly above it. */
  private noteReplayedEpochSeq(epoch: string, seq: number): void {
    this.epochSeqByName.set(epoch, seq);
    if (seq >= this.nextEpochSeq) this.nextEpochSeq = seq + 1;
  }

  /**
   * Registers the candidate's FIRST persisted parent-before-child pair — its
   * permanent promotion authority (journal order, identical live and at
   * replay). Everything after the first registration is ignored: the frozen
   * pair can never be replaced, supplemented, or erased, whatever its epoch,
   * coordinate, parent, or completion order. Old-journal gate facts that
   * current live code would not derive are thus inert — they replay as
   * measurements and grant nothing (fail closed, never open).
   */
  private registerGate(child: string, epoch: string, pairKey: string, gate: GateFact): void {
    if (this.gates.has(child)) return; // frozen: the first pair is permanent
    this.gates.set(child, { epoch, pairKey, gate });
  }

  /** Shared live/replay insertion into the epoch-scoped trusted table. False when the coordinate was already measured in this epoch. */
  private insertMeasurement(epoch: string, hash: string, pairKey: string, aggregate: number): boolean {
    const key = `${epoch}|${hash}`;
    let per = this.trusted.get(key);
    if (per === undefined) {
      per = new Map();
      this.trusted.set(key, per);
    }
    if (per.has(pairKey)) return false;
    per.set(pairKey, aggregate);
    let lifetime = this.lifetimeCoords.get(hash);
    if (lifetime === undefined) {
      lifetime = new Set();
      this.lifetimeCoords.set(hash, lifetime);
    }
    lifetime.add(pairKey);
    return true;
  }

  /** Replays one journaled eval fact: epoch-scoped measurement plus the PERSISTED gate identity (never re-derived). */
  private applyJournaledEval(line: { record: EvaluationRecord; epoch?: string | undefined; epochSeq?: number | undefined; gate?: GateFact | undefined }): void {
    const aggregate = eligibleAggregate(line.record);
    if (aggregate === undefined) return;
    if (
      line.record.artifactHash !== this.config.baselineArtifactHash &&
      this.promotionSlots.has(line.record.artifactHash)
    ) {
      this.trustedAcceptedCandidates.add(line.record.artifactHash);
    }
    const epoch = line.epoch ?? "legacy";
    // Restore epoch ordinal bookkeeping so this boot's fresh mints stay
    // strictly above every replayed generation (pre-ordinal journals rank by
    // first appearance — deterministic per journal).
    if (line.epochSeq !== undefined) this.noteReplayedEpochSeq(epoch, line.epochSeq);
    else this.mintEpochSeq(epoch);
    const pairKey = `${line.record.assetGroupId}|${line.record.seed}`;
    // Global artifact taint, replay side (checked BEFORE this fact's own
    // insertion, exactly like live derivation): a persisted gate on a
    // candidate that already has ANY lifetime evidence earlier in the journal
    // was either never derivable by current live code or is an old-journal
    // score-shopping artifact — the measurement replays, the gate grants
    // nothing (fail closed).
    const tainted = (this.lifetimeCoords.get(line.record.artifactHash)?.size ?? 0) > 0;
    this.insertMeasurement(epoch, line.record.artifactHash, pairKey, aggregate);
    // Slot admissions are journaled before each candidate's first eval fact.
    // A persisted gate on an unadmitted artifact replays as measurement only.
    if (line.gate !== undefined && !tainted && this.promotionSlots.has(line.record.artifactHash)) {
      this.registerGate(line.record.artifactHash, epoch, pairKey, line.gate);
    }
  }

  // ---------- events + budget ----------

  private journalFact(fact: StateFact, events: readonly EmittableEvent[]): RunEvent[] {
    const at = new Date(this.now()).toISOString();
    const full = events.map((event) => RunEvent.parse({ runId: this.config.runId, at, ...event }));
    this.state().append(StateLine.parse({ ...fact, events: full }));
    this.eventJournalFormat = true;
    this.journalEvents.push(...full);
    for (const event of full) {
      if (event.type === "budget.exhausted") this.exhaustedAnnounced.add(event.dimension);
    }
    return full;
  }

  private publish(events: readonly RunEvent[]): void {
    for (const event of events) this.config.onEvent(event);
  }

  private emit(event: EmittableEvent): void {
    // A fully closed broker (journal gone) has no event authority left.
    if (this.stateLog === undefined) return;
    const full = RunEvent.parse({
      runId: this.config.runId,
      at: new Date(this.now()).toISOString(),
      ...event,
    });
    this.state().append({ t: "event", event: full });
    this.eventJournalFormat = true;
    this.journalEvents.push(full);
    if (full.type === "budget.exhausted") this.exhaustedAnnounced.add(full.dimension);
    this.config.onEvent(full);
  }

  private budgetStateNow(tokensDelta = 0, usdDelta = 0, evaluatorInvocationDelta = 0): BudgetState {
    return BudgetState.parse({
      envelope: this.manifest.budget,
      spent: {
        tokens: this.spent.tokens + tokensDelta,
        usd: this.spent.usd + usdDelta,
        wallClockSec: (this.now() - this.startedAtMs) / 1000,
        evaluatorInvocations: this.spent.evaluatorInvocations + evaluatorInvocationDelta,
      },
    });
  }

  private exhaustedDimension(tokensDelta = 0, usdDelta = 0, evaluatorInvocationDelta = 0): BudgetDimension | undefined {
    const e = this.manifest.budget;
    if (this.spent.tokens + tokensDelta >= e.maxTokens) return "tokens";
    if (this.spent.usd + usdDelta >= e.maxUsd) return "usd";
    if ((this.now() - this.startedAtMs) / 1000 >= e.maxWallClockSec) return "wallClockSec";
    if (this.spent.evaluatorInvocations + evaluatorInvocationDelta >= e.maxEvaluatorInvocations) return "evaluatorInvocations";
    return undefined;
  }

  private announceExhaustion(): BudgetDimension | undefined {
    const dim = this.exhaustedDimension();
    if (dim !== undefined && !this.exhaustedAnnounced.has(dim)) {
      this.emit({ type: "budget.exhausted", dimension: dim });
    }
    return dim;
  }

  /** Every metered method calls this; getBudget/finish/recordSpend stay reachable for observability + teardown. */
  private budgetGate(): void {
    // A poisoned journal refuses every new metered operation immediately —
    // nothing may act when its authority can no longer be journaled.
    this.stateLog?.assertUsable();
    const persisted = this.exhaustedAnnounced.values().next().value;
    const dim = persisted ?? this.announceExhaustion();
    if (dim !== undefined) throw new BrokerError("BUDGET_EXCEEDED", `budget dimension exhausted: ${dim}`);
  }

  // ---------- helpers ----------

  private async requireArtifact(hash: string): Promise<void> {
    if (!(await this.cas.has(hash))) throw new BrokerError("INTERNAL", `artifact not in CAS: ${hash}`);
  }

  /**
   * Reads a CAS artifact and validates its tar layout (WP-ArchiveWire
   * contract): a hash in CAS is NOT trusted to be well-formed — malformed or
   * hostile archives (symlinks, .. paths, non-workspace roots) are rejected
   * before any extraction or container sees them.
   */
  private async readValidatedArtifact(hash: string): Promise<Buffer> {
    await this.requireArtifact(hash);
    const bytes = await this.cas.readBuffer(hash);
    try {
      validateWorkspaceTar(bytes);
    } catch (err) {
      if (err instanceof ArtifactValidationError) {
        throw new BrokerError("INTERNAL", `artifact ${hash} rejected: ${err.message}`, {
          reason: err.reason,
          ...(err.entryName !== undefined ? { entryName: err.entryName } : {}),
        });
      }
      throw err;
    }
    return bytes;
  }

  private async requireSandbox(sandboxId: string): Promise<SandboxEntry> {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw new BrokerError("SANDBOX_NOT_FOUND", `unknown sandbox: ${sandboxId}`);
    if (this.now() >= entry.expiresAtMs) {
      const removed = await this.removeTrackedContainer(entry.containerId);
      if (!containerGone(removed)) {
        throw new BrokerError("INTERNAL", `expired sandbox cleanup failed: ${stderrText(removed)}`);
      }
      this.sandboxes.delete(sandboxId);
      throw new BrokerError("SANDBOX_NOT_FOUND", `sandbox expired: ${sandboxId}`);
    }
    return entry;
  }

  private async removeTrackedContainer(ref: string): Promise<CmdResult> {
    const res = await this.run(["docker", "rm", "-f", ref], { timeoutMs: 30_000 });
    if (containerGone(res)) {
      this.trackedContainers.delete(ref);
    }
    return res;
  }

  private async reapExpired(): Promise<void> {
    if (this.closing) return;
    this.enterOp();
    try {
      const nowMs = this.now();
      for (const [id, entry] of [...this.sandboxes]) {
        if (nowMs < entry.expiresAtMs) continue;
        await this.serializeMutation(() =>
          this.serializeSandbox(id, async () => {
            const current = this.sandboxes.get(id);
            if (current === undefined || this.now() < current.expiresAtMs) return;
            try {
              const removed = await this.removeTrackedContainer(current.containerId);
              if (containerGone(removed)) this.sandboxes.delete(id);
            } catch {
              // Keep the expired entry tracked: close() retries and fails terminal
              // cleanup if Docker still cannot remove it.
            }
          }),
        );
      }
    } finally {
      this.exitOp();
    }
  }

  private async checkScratchQuota(): Promise<void> {
    // Volume mode: the tmpfs size cap enforces the quota at write time.
    if (this.scratchVolumeName !== undefined) return;
    const size = await dirSizeBytes(this.scratchDir);
    if (size > this.scratchQuotaBytes) {
      throw new BrokerError("QUOTA_EXCEEDED", `scratch dir ${size}B exceeds quota ${this.scratchQuotaBytes}B`);
    }
  }

  /**
   * Provisions the per-run size-capped tmpfs volume for /scratch. When
   * scratchVolume is requested it MUST exist: the host bind mount's polling
   * quota is only checked between broker calls, so falling back would let a
   * single exec fill the host disk. Fail closed — init aborts.
   */
  private async provisionScratchVolume(): Promise<void> {
    const name = `hone-scratch-${this.safeRunId}`;
    // The daemon may create either resource but lose/timeout the CLI response.
    // Register deterministic names first so init unwind always reaps them.
    this.scratchVolumeName = name;
    const created = await this.run(
      [
        "docker", "volume", "create",
        "--driver", "local",
        "--opt", "type=tmpfs",
        "--opt", "device=tmpfs",
        "--opt", `o=size=${this.scratchQuotaBytes},nr_inodes=${SCRATCH_INODE_LIMIT}`,
        "--label", `hone.runId=${this.config.runId}`,
        name,
      ],
      { timeoutMs: 30_000 },
    );
    if (created.exitCode !== 0) {
      throw new BrokerError("INTERNAL", `scratch volume provisioning failed (refusing unquota'd fallback): ${stderrText(created)}`);
    }

    this.trackedContainers.add(this.scratchKeeperName);
    const keeper = await this.run(
      [
        "docker", "run", "-d",
        "--name", this.scratchKeeperName,
        "--label", `hone.runId=${this.config.runId}`,
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--cap-add", "DAC_READ_SEARCH",
        "--cap-add", "CHOWN",
        // Trusted keeper only: native rootful Linux still enforces the
        // host-owned 0700 /snapshot bind after `--cap-drop ALL`.
        "--cap-add", "DAC_OVERRIDE",
        // GNU tar chowns uid-1000 entries before applying their final modes.
        // Without FOWNER, a real production scratch snapshot cannot resume.
        "--cap-add", "FOWNER",
        ...this.leaseArgs,
        // The pinned image must already exist locally — a create must fail
        // fast, never sit in a minutes-long daemon-side pull past its fence.
        "--pull", "never",
        "--security-opt", "no-new-privileges",
        "-e", `HONE_SCRATCH_QUOTA_BYTES=${this.scratchQuotaBytes}`,
        "-e", `HONE_SCRATCH_SNAPSHOT_MAX_BYTES=${scratchSnapshotArchiveCapBytes(this.scratchQuotaBytes)}`,
        "-e", `HONE_SCRATCH_SNAPSHOT_DEADLINE_SEC=${SCRATCH_SNAPSHOT_DEADLINE_SEC}`,
        "--pids-limit", "16",
        "--memory", "32m",
        "--memory-swap", "32m",
        "--cpus", "0.1",
        "--log-driver", "none",
        "-v", `${name}:/scratch`,
        "-v", `${this.scratchSnapshotDir}:/snapshot`,
        this.config.image,
        "sleep", "2147483647",
      ],
      { timeoutMs: 120_000 },
    );
    if (keeper.exitCode !== 0) {
      throw new BrokerError("INTERNAL", `scratch keeper failed: ${stderrText(keeper)}`);
    }
  }

  private async restoreScratchSnapshot(): Promise<void> {
    try {
      await stat(this.scratchSnapshotPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const restored = await this.run(
      ["docker", "exec", "-i", "-u", "root", this.scratchKeeperName, "/bin/tar", "-x", "-C", "/scratch"],
      { stdinFile: this.scratchSnapshotPath, timeoutMs: 300_000 },
    );
    if (restored.exitCode !== 0 || restored.timedOut) {
      throw new BrokerError("INTERNAL", `scratch snapshot restore failed: ${stderrText(restored)}`);
    }
  }

  private async snapshotScratchVolume(): Promise<void> {
    if (this.scratchVolumeName === undefined) return;
    const containers = [...new Set([...this.sandboxes.values()].map((entry) => entry.containerId))];
    let failure: string | undefined;
    if (containers.length > 0) {
      // An exec may leave descendants running after the docker CLI returns.
      // Freeze every mutation cgroup so the shared tmpfs has one coherent
      // point-in-time view while the trusted keeper archives it.
      const paused = await this.run(["docker", "pause", ...containers], { timeoutMs: 30_000 });
      if (paused.exitCode !== 0 || paused.timedOut) failure = `scratch quiesce failed: ${stderrText(paused)}`;
    }
    if (failure === undefined) {
      // Per-attempt unguessable output: an orphaned exec from an older
      // (e.g. host-timed-out) attempt only ever knows ITS OWN basename — it
      // can neither overwrite this attempt's output nor be published by it.
      const attemptName = newScratchSnapshotAttemptName();
      try {
        const snapshotted = await this.run(
          [
            "docker", "exec", "-u", "root",
            "-e", `HONE_SCRATCH_SNAPSHOT_OUT=${attemptName}`,
            this.scratchKeeperName, "/bin/sh", "-c", SCRATCH_SNAPSHOT_SCRIPT,
          ],
          { timeoutMs: SCRATCH_SNAPSHOT_HOST_TIMEOUT_MS },
        );
        if (snapshotted.exitCode !== 0 || snapshotted.timedOut) {
          failure = `scratch snapshot failed: ${stderrText(snapshotted)}`;
        } else {
          // Durable publication (fsync tmp → rename → fsync dir) happens on
          // the HOST, BEFORE thaw and before any journal/event acknowledges
          // the boundary — a power loss never leaves a torn scratch.tar
          // behind an acknowledged snapshot. Only THIS attempt's exact
          // output is ever published.
          try {
            await finalizeScratchSnapshot(this.scratchSnapshotDir, attemptName);
          } catch (error) {
            failure = `scratch snapshot finalize failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      } finally {
        // EVERY outcome sweeps unpublished outputs (this attempt's residue
        // and any orphan's late write) — a stale archive never survives to
        // satisfy or confuse a later attempt.
        await this.sweepScratchSnapshotTemps();
      }
    }
    if (containers.length > 0) {
      // Always thaw after an attempted pause, including partial daemon
      // failures. A failed thaw is terminally visible and cleanup reaps the
      // affected containers; never strand a silently frozen sandbox.
      const unpaused = await this.run(["docker", "unpause", ...containers], { timeoutMs: 30_000 });
      if (unpaused.exitCode !== 0 || unpaused.timedOut) {
        const thaw = `scratch thaw failed: ${stderrText(unpaused)}`;
        failure = failure === undefined ? thaw : `${failure}; ${thaw}`;
      }
    }
    if (failure !== undefined) throw new BrokerError("INTERNAL", failure);
  }

  /** Best-effort sweep of every unpublished snapshot output: per-attempt files, in-container pid temps, and legacy shared temps. */
  private async sweepScratchSnapshotTemps(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.scratchSnapshotDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === SCRATCH_SNAPSHOT_FILE || !entry.startsWith("scratch.tar.tmp")) continue;
      try {
        await rm(path.join(this.scratchSnapshotDir, entry), { force: true });
      } catch {
        // Cleanup is not authority: a stale unpublished temp is inert (it can
        // never be finalized) and the next attempt sweeps again.
      }
    }
  }

  private missingContainer(res: CmdResult, sandboxId: string): BrokerError | undefined {
    if (res.exitCode !== 0 && MISSING_CONTAINER_RE.test(res.stderr.toString("utf8"))) {
      this.sandboxes.delete(sandboxId);
      return new BrokerError("SANDBOX_NOT_FOUND", `sandbox container gone: ${sandboxId}`);
    }
    return undefined;
  }

  private async rejectTimedOutSandbox(
    sandboxId: string,
    entry: SandboxEntry,
    result: CmdResult,
    operation: string,
  ): Promise<void> {
    if (!result.timedOut) return;
    entry.expiresAtMs = 0;
    const retired = await this.removeTrackedContainer(entry.containerId);
    if (containerGone(retired)) this.sandboxes.delete(sandboxId);
    throw new BrokerError("INTERNAL", `${operation} timed out; sandbox retired`);
  }

  /** Absolute in-container path; relative paths resolve against /workspace. */
  private containerPath(p: string): string {
    const abs = path.posix.normalize(p.startsWith("/") ? p : path.posix.join("/workspace", p));
    if (abs === "/run/hone/proxy.sock" || abs.startsWith("/run/hone/")) {
      throw new BrokerError("INTERNAL", `path not allowed: ${abs}`);
    }
    return abs;
  }

  /**
   * Defense in depth: a mutation sandbox may see EXACTLY the scratch mount
   * (host dir or the run's quota volume) and the proxy socket. Protected/
   * holdout assets, credentials, the docker socket, and the event log can
   * never appear because nothing outside this allowlist is mountable.
   */
  private assertMutationMounts(mounts: ReadonlyArray<{ host: string; container: string }>): void {
    const allowed = new Set([this.scratchVolumeName ?? this.scratchDir, this.proxySockPath]);
    for (const m of mounts) {
      if (!allowed.has(m.host)) throw new BrokerError("INTERNAL", `mount not allowlisted: ${m.host}`);
    }
  }

  private resolveAssetHostPath(rel: string): string {
    const abs = path.resolve(this.config.capsuleRootDir, rel);
    const relBack = path.relative(this.config.capsuleRootDir, abs);
    if (relBack.startsWith("..") || path.isAbsolute(relBack)) {
      throw new BrokerError("INTERNAL", `asset path escapes capsule root: ${rel}`);
    }
    return abs;
  }

  /**
   * Asset confidentiality (M0 blocker): the selected group's assets are
   * STAGED — copied, never bind-mounted from the capsule root — into a
   * per-evaluation host directory that becomes the SINGLE read-only source
   * of /capsule/assets. Host-side confidentiality lives on the OUTER,
   * host-only parent (this.tmpDir, 0700, broker-owned, never mounted); the
   * staged content itself is dirs 0755 / files 0644 because the evaluator
   * runs with --cap-drop ALL (no CAP_DAC_OVERRIDE) — on native Linux even
   * uid 0 cannot traverse a 0700 tree owned by the host uid. In-container
   * confinement against the uid-2000 candidate remains the /capsule tmpfs
   * parent (mode=0700) in evaluateReserved. Sources must be regular files
   * reached without following symlinks; anything else fails closed before
   * the invocation is burned.
   */
  private async stageAssets(group: CapsuleManifest["assetGroups"][number]): Promise<string> {
    const stageDir = path.join(this.tmpDir, `assets-${randomUUID()}`);
    await mkdir(stageDir, { recursive: true, mode: 0o755 });
    await chmod(stageDir, 0o755); // umask-independent
    try {
      for (const raw of group.paths) {
        const rel = path.posix.normalize(raw).replace(/\/+$/, "");
        const host = this.resolveAssetHostPath(rel);
        if (rel === "." || rel === "") {
          // The whole capsule root as one group: stage its children directly.
          for (const name of await readdir(host)) {
            await this.stageEntry(path.join(host, name), path.join(stageDir, name), group.id, name);
          }
          continue;
        }
        const parts = rel.split("/");
        let parent = stageDir;
        for (const part of parts.slice(0, -1)) {
          parent = path.join(parent, part);
          await mkdir(parent, { recursive: true, mode: 0o755 });
          await chmod(parent, 0o755);
        }
        await this.stageEntry(host, path.join(parent, parts[parts.length - 1] ?? ""), group.id, rel);
      }
    } catch (err) {
      await rm(stageDir, { recursive: true, force: true });
      throw err;
    }
    return stageDir;
  }

  /** Copies one admitted asset (file or directory tree) into the staging dir. Fail closed on anything non-regular. */
  private async stageEntry(src: string, dst: string, groupId: string, rel: string): Promise<void> {
    let st;
    try {
      st = await lstat(src);
    } catch {
      throw new BrokerError("INTERNAL", `asset path missing on host: ${rel}`);
    }
    if (st.isDirectory()) {
      await mkdir(dst, { recursive: true, mode: 0o755 });
      await chmod(dst, 0o755);
      for (const name of await readdir(src)) {
        await this.stageEntry(path.join(src, name), path.join(dst, name), groupId, `${rel}/${name}`);
      }
      return;
    }
    if (!st.isFile()) {
      throw new BrokerError("INTERNAL", `asset group ${groupId}: refusing non-regular asset source: ${rel}`);
    }
    // O_NOFOLLOW pins the lstat verdict. Hash the bytes read from that exact
    // handle against the frozen manifest immediately before staging; edits
    // after admission cannot poison memoized scores under the old digest.
    const fh = await open(src, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      if (!(await fh.stat()).isFile()) {
        throw new BrokerError("INTERNAL", `asset group ${groupId}: refusing non-regular asset source: ${rel}`);
      }
      const bytes = await fh.readFile();
      const expected = this.manifest.contentHashes[rel];
      const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (expected === undefined || actual !== expected) {
        throw new BrokerError("INTERNAL", `asset group ${groupId}: frozen content hash mismatch at ${rel}`);
      }
      await writeFile(dst, bytes, { mode: 0o644, flag: "wx" });
    } finally {
      await fh.close();
    }
    await chmod(dst, 0o644);
  }

  private async ensureUnpacked(hash: string): Promise<string> {
    await this.requireArtifact(hash);
    return unpackArtifact(this.cas, hash, this.unpackRoot, this.run);
  }

  /** Shared per-container args (mutation AND eval containers): resource
   * ceilings plus the docker-run lease attachment (creation fence). */
  private resourceArgs(): string[] {
    return [
      "--log-driver", "none",
      "--pids-limit", String(this.sandboxPidsLimit),
      "--memory", String(this.sandboxMemoryBytes),
      "--cpus", String(this.sandboxCpus),
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      ...this.leaseArgs,
      // Pinned images are pre-staged; a daemon-side pull must never keep a
      // timed-out create alive past the run lease fence.
      "--pull", "never",
    ];
  }

  // ---------- methods ----------

  getTask(_ctx: CallContext): GetTaskR {
    this.budgetGate();
    return {
      capsuleId: this.manifest.id,
      objective: this.manifest.objective,
      baselineArtifact: { hash: this.config.baselineArtifactHash },
      visibleAssetGroups: this.manifest.assetGroups
        .filter((group) => group.visibility !== "holdout" || this.terminalHoldoutAssetGroupIds.has(group.id))
        .map((group) => group.id),
      budget: this.budgetStateNow(),
    };
  }

  async createSandbox(params: CreateSandboxP, _ctx: CallContext): Promise<SandboxRef> {
    this.enterOp();
    try {
      this.budgetGate();
      // Atomic admission: the check and the reservation are one synchronous
      // step, so parallel creations cannot all observe the same free slot and
      // stampede past the cap while creation awaits docker.
      if (this.sandboxes.size + this.pendingSandboxes >= this.maxActiveSandboxes) {
        throw new BrokerError("QUOTA_EXCEEDED", `active sandbox cap reached (${this.maxActiveSandboxes})`);
      }
      this.pendingSandboxes += 1;
      try {
        return await this.serializeMutation(async () => {
          // Lineage/repair admission shares the same critical section as
          // saveArtifact. A queued save may graduate or create this hash
          // before our turn; never carry a stale episode decision across it.
          const repair = this.lineage.has(params.artifact.hash) ? undefined : this.repairs.get(params.artifact.hash);
          const reservesNewEpisode = repair === undefined;
          if (reservesNewEpisode && this.episodeOrdinal + this.pendingNewEpisodes >= this.maxMutationEpisodes) {
            throw new BrokerError(
              "BUDGET_EXCEEDED",
              `mutation episode cap reached (${this.maxMutationEpisodes})`,
            );
          }
          if (reservesNewEpisode) this.pendingNewEpisodes += 1;
          try {
            return await this.createSandboxReserved(params, repair);
          } finally {
            if (reservesNewEpisode) this.pendingNewEpisodes -= 1;
          }
        });
      } finally {
        this.pendingSandboxes -= 1;
      }
    } finally {
      this.exitOp();
    }
  }

  private async createSandboxReserved(
    params: CreateSandboxP,
    repair: { parent: string; episode: number } | undefined,
  ): Promise<SandboxRef> {
    await this.checkScratchQuota();
    // A CAS hash is not trusted layout — validate the archive before any
    // container extracts it.
    const artifactBytes = await this.readValidatedArtifact(params.artifact.hash);

    // The proxy socket is the sandbox's ONLY egress. If the proxy has not
    // bound it yet, a placeholder keeps docker from creating a host DIRECTORY
    // at the path; real runs start the proxy before the first sandbox.
    try {
      await stat(this.proxySockPath);
    } catch {
      await writeFile(this.proxySockPath, "");
    }

    const mounts = [
      { host: this.scratchVolumeName ?? this.scratchDir, container: "/scratch", mode: "rw" },
      { host: this.proxySockPath, container: "/run/hone/proxy.sock", mode: "rw" },
    ];
    this.assertMutationMounts(mounts);

    const sandboxId = `sb_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const net = this.config.sandboxNetwork ?? { mode: "none" };
    const networkArg = net.mode === "internal" ? net.network : "none";
    const argv = [
      "docker",
      "run",
      "-d",
      "--network",
      networkArg,
      "--name",
      `hone-${this.safeRunId}-${sandboxId}`,
      "--label",
      `hone.runId=${this.config.runId}`,
      ...this.resourceArgs(),
      "--user", "1000:1000",
      "--read-only",
      "--tmpfs",
      `/workspace:rw,exec,nosuid,nodev,size=${this.workspaceQuotaBytes},nr_inodes=${WORKSPACE_TMPFS_INODES},mode=1777`,
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,size=67108864,mode=1777",
      "--tmpfs",
      "/home/hone:rw,exec,nosuid,nodev,size=67108864,mode=0700,uid=1000,gid=1000",
      "-w",
      "/workspace",
    ];
    // Trusted-side env injection (WP7 contract with WP5): proxy endpoint +
    // per-run bearer reach mutation sandboxes via broker config, never over
    // the client wire protocol. Values are role-scoped and metered; the
    // upstream credentials themselves never enter any sandbox.
    for (const [k, v] of Object.entries(this.config.mutationEnv ?? {})) {
      argv.push("-e", `${k}=${v}`);
    }
    for (const m of mounts) argv.push("-v", `${m.host}:${m.container}:${m.mode}`);
    argv.push(this.config.image, "sleep", "2147483647");

    // Pre-register the deterministic name BEFORE the daemon call. A timeout
    // can mean “created, response lost”; every uncertain outcome is removed
    // by name and remains tracked if removal cannot be proved.
    if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
    const containerName = `hone-${this.safeRunId}-${sandboxId}`;
    this.trackedContainers.add(containerName);
    let res: CmdResult;
    try {
      res = await this.run(argv, { timeoutMs: 120_000 });
    } catch (error) {
      const removed = await this.removeTrackedContainer(containerName);
      if (!containerGone(removed)) {
        throw new BrokerError("INTERNAL", `uncertain docker run and cleanup failed: ${stderrText(removed)}`);
      }
      throw error;
    }
    if (res.exitCode !== 0 || res.timedOut) {
      const removed = await this.removeTrackedContainer(containerName);
      if (!containerGone(removed)) {
        throw new BrokerError("INTERNAL", `docker run failed and cleanup was not confirmed: ${stderrText(res)}; ${stderrText(removed)}`);
      }
      throw new BrokerError("INTERNAL", `docker run failed: ${stderrText(res)}`);
    }
    const containerId = res.stdout.toString("utf8").trim();
    if (containerId.length === 0) {
      const removed = await this.removeTrackedContainer(containerName);
      if (!containerGone(removed)) {
        throw new BrokerError("INTERNAL", `docker run returned no container id and cleanup failed: ${stderrText(removed)}`);
      }
      throw new BrokerError("INTERNAL", "docker run returned no container id");
    }
    // The uncertain-create name becomes the daemon-confirmed id atomically.
    this.trackedContainers.delete(containerName);
    this.trackedContainers.add(containerId);

    // Extract AS the fixed unprivileged mutation identity. No root-side chown
    // (or CAP_CHOWN) is needed, and the long-lived sandbox retains zero caps.
    const ttlSec = params.ttlSec ?? this.defaultTtlSec;
    let startedEvents: RunEvent[] = [];
    try {
      const unpack = await this.run([
        "docker", "exec", "-i", "-u", "1000:1000", containerId,
        "/bin/tar", "-o", "--no-same-permissions", "--strip-components", "1", "-x", "-C", "/workspace",
      ], {
        stdin: artifactBytes,
        timeoutMs: 300_000,
      });
      if (unpack.exitCode !== 0) {
        throw new BrokerError("INTERNAL", `artifact unpack failed: ${stderrText(unpack)}`);
      }

      // close() snapshots the sandbox map — a container spawned in flight but
      // not yet registered would leak past it. Reap it here instead.
      if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");

      let episode: number;
      let parentHash: string;
      if (repair !== undefined) {
        episode = repair.episode;
        parentHash = repair.parent;
      } else {
        episode = this.episodeOrdinal;
        parentHash = params.artifact.hash;
        // One fsynced fact owns both the ordinal and the public boundary: a
        // crash can strand neither side of the split journal.
        startedEvents = this.journalFact(
          { t: "episode", episode },
          [{ type: "episode.started", episode, parent: { hash: parentHash } }],
        );
        this.episodeOrdinal = episode + 1;
        this.anyEpisodeStarted = true;
      }
      // The ACTIVE episode (new or resumed repair) defines the measurement
      // generation — set from the episode itself, never derived from ordinal
      // arithmetic at evaluation sites — but the active generation is
      // MONOTONE in the trusted epoch ordinal: a resumed repair reuses its
      // episode's epoch only while that generation is still current. Once a
      // newer epoch was minted, the reopened sandbox evaluates under the
      // LATEST generation (fresh comparators); rolling back would let a
      // stale parent memo from the old epoch pair against — and promote — a
      // fresh child. A new episode's epoch is always a fresh mint, so it
      // always becomes current.
      const sandboxEpoch = `${this.bootNonce}:ep${episode}`;
      const sandboxEpochSeq = this.mintEpochSeq(sandboxEpoch);
      const currentSeq = this.epochSeqByName.get(this.measurementEpoch);
      if (currentSeq === undefined || sandboxEpochSeq >= currentSeq) this.measurementEpoch = sandboxEpoch;
      this.sandboxes.set(sandboxId, {
        containerId,
        expiresAtMs: this.now() + ttlSec * 1000,
        episode,
        parentHash,
        lastExecStdout: null,
        lastExecExitCode: null,
        lastExecTruncated: null,
      });
    } catch (error) {
      // No acknowledgment without a registered sandbox: a failure ANYWHERE
      // after the container exists (unpack, closing fence, journal append —
      // e.g. a poisoned run state log) must reap the container WITH PROOF.
      // Otherwise the tracked-but-unregistered container escapes the
      // active-sandbox cap and repeated creates leak containers unboundedly.
      const removed = await this.removeTrackedContainer(containerId);
      if (!containerGone(removed)) {
        throw new BrokerError(
          "INTERNAL",
          `sandbox create failed and container cleanup unproven: ${
            error instanceof Error ? error.message : String(error)
          }; ${stderrText(removed)}`,
        );
      }
      throw error;
    }
    this.publish(startedEvents);
    return { sandboxId };
  }

  async exec(params: ExecP, ctx: CallContext): Promise<ExecR> {
    this.enterOp();
    try {
      return await this.serializeMutation(() =>
        this.serializeSandbox(params.sandboxId, () => this.execOp(params, ctx)),
      );
    } finally {
      this.exitOp();
    }
  }

  private async execOp(params: ExecP, _ctx: CallContext): Promise<ExecR> {
    this.budgetGate();
    const sb = await this.requireSandbox(params.sandboxId);
    // Candidate admission keys off the LAST COMPLETED exec. Clear the record
    // BEFORE the spawn so a saveArtifact that interleaves with an in-flight
    // exec (or observes a timed-out one) can never reuse stale prior-success
    // provenance — it degrades to a repair snapshot instead.
    sb.lastExecExitCode = null;
    sb.lastExecStdout = null;
    sb.lastExecTruncated = null;
    const argv = ["docker", "exec", "-i"];
    if (params.cwd !== undefined) argv.push("-w", params.cwd);
    argv.push(sb.containerId, ...params.argv);
    const res = await this.run(argv, {
      stdin: params.stdin ?? "",
      timeoutMs: (params.timeoutSec ?? 600) * 1000,
      maxOutputBytes: this.execOutputLimitBytes,
    });
    const gone = this.missingContainer(res, params.sandboxId);
    if (gone) throw gone;
    if (res.timedOut) {
      // Killing the local docker CLI does NOT kill in-container work — the
      // sandbox may still be running arbitrary code. Invalidate and remove it
      // so the orphan cannot keep computing against the run.
      sb.expiresAtMs = 0;
      const retired = await this.removeTrackedContainer(sb.containerId);
      if (containerGone(retired)) this.sandboxes.delete(params.sandboxId);
      // Keep the capped partial bytes only in this bounded sandbox entry.
      // Failed/truncated executions can never become candidate provenance.
      sb.lastExecExitCode = 124;
      sb.lastExecTruncated = res.truncated;
      sb.lastExecStdout = res.stdout;
      return { exitCode: 124, stdout: res.stdout.toString("utf8"), stderr: res.stderr.toString("utf8"), truncated: res.truncated };
    }
    sb.lastExecExitCode = res.exitCode;
    sb.lastExecTruncated = res.truncated;
    // Hold the capped bytes in memory until saveArtifact proves this exec
    // actually minted a candidate. Repeated diagnostic execs never grow CAS.
    sb.lastExecStdout = res.stdout;
    return {
      exitCode: res.exitCode,
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr.toString("utf8"),
      truncated: res.truncated,
    };
  }

  async putFile(params: PutFileP, ctx: CallContext): Promise<Record<string, never>> {
    this.enterOp();
    try {
      return await this.serializeMutation(() =>
        this.serializeSandbox(params.sandboxId, () => this.putFileOp(params, ctx)),
      );
    } finally {
      this.exitOp();
    }
  }

  private async putFileOp(params: PutFileP, _ctx: CallContext): Promise<Record<string, never>> {
    this.budgetGate();
    const sb = await this.requireSandbox(params.sandboxId);
    const target = this.containerPath(params.path);
    const mkdirRes = await this.run(
      ["docker", "exec", sb.containerId, "mkdir", "-p", path.posix.dirname(target)],
      { timeoutMs: 120_000 },
    );
    const goneMkdir = this.missingContainer(mkdirRes, params.sandboxId);
    await this.rejectTimedOutSandbox(params.sandboxId, sb, mkdirRes, "mkdir");
    if (goneMkdir) throw goneMkdir;
    if (mkdirRes.exitCode !== 0) throw new BrokerError("INTERNAL", `mkdir failed: ${stderrText(mkdirRes)}`);

    const write = await this.run(
      ["docker", "exec", "-i", sb.containerId, "sh", "-c", "cat > \"$1\"", "sh", target],
      { stdin: Buffer.from(params.contentBase64, "base64"), timeoutMs: 120_000 },
    );
    const gone = this.missingContainer(write, params.sandboxId);
    await this.rejectTimedOutSandbox(params.sandboxId, sb, write, "write");
    if (gone) throw gone;
    if (write.exitCode !== 0) throw new BrokerError("INTERNAL", `write failed: ${stderrText(write)}`);
    return {};
  }

  async getFile(params: GetFileP, ctx: CallContext): Promise<GetFileR> {
    this.enterOp();
    try {
      return await this.serializeMutation(() =>
        this.serializeSandbox(params.sandboxId, () => this.getFileOp(params, ctx)),
      );
    } finally {
      this.exitOp();
    }
  }

  private async getFileOp(params: GetFileP, _ctx: CallContext): Promise<GetFileR> {
    this.budgetGate();
    const sb = await this.requireSandbox(params.sandboxId);
    const target = this.containerPath(params.path);
    const res = await this.run(["docker", "exec", sb.containerId, "cat", target], {
      maxOutputBytes: 64 * 1024 * 1024,
      timeoutMs: 120_000,
    });
    const gone = this.missingContainer(res, params.sandboxId);
    await this.rejectTimedOutSandbox(params.sandboxId, sb, res, "read");
    if (gone) throw gone;
    if (res.exitCode !== 0) throw new BrokerError("INTERNAL", `read failed: ${stderrText(res)}`);
    if (res.truncated) throw new BrokerError("QUOTA_EXCEEDED", `file too large: ${target}`);
    return { contentBase64: res.stdout.toString("base64") };
  }

  async saveArtifact(params: SaveArtifactP, ctx: CallContext): Promise<ArtifactRef> {
    this.enterOp();
    try {
      return await this.serializeMutation(() =>
        this.serializeSandbox(params.sandboxId, () => this.saveArtifactOp(params, ctx)),
      );
    } finally {
      this.exitOp();
    }
  }

  private async saveArtifactOp(params: SaveArtifactP, _ctx: CallContext): Promise<ArtifactRef> {
    this.budgetGate();
    const sb = await this.requireSandbox(params.sandboxId);
    await this.checkScratchQuota();
    const res = await this.run(["docker", "exec", sb.containerId, "/bin/tar", "-c", "-C", "/", "workspace"], {
      maxOutputBytes: MAX_ARTIFACT_BYTES,
      timeoutMs: 300_000,
    });
    const gone = this.missingContainer(res, params.sandboxId);
    if (gone) throw gone;
    if (res.exitCode !== 0) throw new BrokerError("INTERNAL", `workspace archive failed: ${stderrText(res)}`);
    if (res.truncated) throw new BrokerError("QUOTA_EXCEEDED", "artifact exceeds size cap");
    // The sandbox ran adversarial code — its tar is untrusted until the
    // archive validator accepts it; validation runs BEFORE anything is
    // extracted, and nothing malformed ever enters CAS. The accepted tree is
    // then repacked canonically (sorted entries, zeroed metadata, runtime
    // detritus stripped) so an unchanged tree always lands on the same hash —
    // lineage, events, and evaluation all key off the canonical hash.
    let hash: string;
    try {
      hash = await canonicalizeWorkspaceTar(
        res.stdout,
        this.cas,
        this.run,
        (candidateHash, bytes, entryCount) => this.reserveCandidateArtifact(candidateHash, bytes, entryCount),
        this.tmpDir,
      );
    } catch (err) {
      if (err instanceof ArtifactValidationError) {
        throw new BrokerError("INTERNAL", `saved artifact rejected: ${err.message}`, {
          reason: err.reason,
          ...(err.entryName !== undefined ? { entryName: err.entryName } : {}),
        });
      }
      throw err;
    }

    // The candidate/repair event is acknowledged only after mutable scratch
    // has an atomic host snapshot. A crash can replay this episode from the
    // previous boundary, never observe an event whose scratch state vanished.
    await this.snapshotScratchVolume();

    // Candidate admission requires a COMPLETE successful exec record: exit 0
    // AND an untruncated capture — a capped trace is stored in CAS for
    // diagnostics but can never be cited as candidate provenance.
    if (sb.lastExecExitCode === 0 && sb.lastExecTruncated === false) {
      // Lineage and its public candidate record share one fsynced journal
      // line, including the exact CAS-backed session-trace reference.
      if (!this.lineage.has(hash) && hash !== sb.parentHash) {
        const stdout = sb.lastExecStdout;
        if (stdout === null) {
          throw new BrokerError("INTERNAL", "candidate save without a completed exec trace");
        }
        const sessionTrace = await this.persistSessionTrace(stdout);
        const events = this.journalFact(
          { t: "lineage", candidate: hash, parent: sb.parentHash, episode: sb.episode },
          [{ type: "episode.candidate", episode: sb.episode, candidate: { hash }, sessionTrace }],
        );
        this.lineage.set(hash, { parent: sb.parentHash, episode: sb.episode });
        // Graduation: the hash may have been journaled as a repair snapshot
        // earlier; lineage supersedes it (replay treats the lineage line as
        // the tombstone), so descendants pair against THIS artifact.
        this.repairs.delete(hash);
        this.publish(events);
      }
    } else if (hash !== sb.parentHash && !this.lineage.has(hash) && !this.repairs.has(hash)) {
      // Repair snapshot (no exec, or last exec failed): NOT a candidate, no
      // event; remembered so a follow-up sandbox reuses the original episode.
      this.state().append({ t: "repair", hash, parent: sb.parentHash, episode: sb.episode });
      this.repairs.set(hash, { parent: sb.parentHash, episode: sb.episode });
    }

    // Terminal save (final-gate finding): a successful save RETIRES the
    // sandbox — the container is removed and its active-quota slot released
    // BEFORE the save is acknowledged, so an optimizer iterating
    // create→exec→save can never strand `maxActiveSandboxes` exhausted
    // containers that keep holding the cap, /scratch, and the proxy token.
    // Nothing needs the old container afterwards: candidates AND repair
    // snapshots both resume from the saved CAS artifact in a fresh sandbox.
    // Fail closed — if docker cannot remove it, the entry stays registered
    // (the TTL reaper remains the backup) and the save is not acknowledged.
    const retired = await this.removeTrackedContainer(sb.containerId);
    if (!containerGone(retired)) {
      throw new BrokerError("INTERNAL", `sandbox retirement failed after save: ${stderrText(retired)}`);
    }
    this.sandboxes.delete(params.sandboxId);
    return { hash };
  }

  async evaluate(params: EvaluateP, ctx: CallContext): Promise<EvaluationRecord> {
    this.enterOp();
    try {
      return await this.evaluateOp(params, ctx);
    } finally {
      this.exitOp();
    }
  }

  private async evaluateOp(params: EvaluateP, ctx: CallContext): Promise<EvaluationRecord> {
    this.budgetGate();
    const group = this.manifest.assetGroups.find((g) => g.id === params.assetGroupId);
    if (!group) throw new BrokerError("INTERNAL", `unknown asset group: ${params.assetGroupId}`);
    // Authorization is caller-specific and MUST precede in-flight dedup:
    // otherwise a public caller can attach to an admin holdout promise.
    if (
      group.visibility === "holdout"
      && !ctx.privileged
      && !this.terminalHoldoutAssetGroupIds.has(group.id)
    ) {
      throw new BrokerError("HOLDOUT_ACCESS_DENIED", "holdout asset groups are only reachable on the admin socket or through a terminal holdout capability");
    }
    // Cross-artifact evaluator cache channel: public mutation authority is
    // bounded by a trusted constructor cap. M0 defaults to exactly one;
    // M1 admits distinct hashes only after assigning fresh measurement domains.
    if (!ctx.privileged && params.artifact.hash !== this.config.baselineArtifactHash) {
      if (!this.lineage.has(params.artifact.hash)) {
        throw new BrokerError(
          "INTERNAL",
          `evaluate: ${params.artifact.hash} is neither the baseline nor a saved candidate of this run — repairs and arbitrary CAS content never reach a public evaluator`,
        );
      }
      if (this.promotionSlots.has(params.artifact.hash)) {
        if (this.maxPublicCandidateEvaluations === 1) {
          throw new BrokerError(
            "QUOTA_EXCEEDED",
            `candidate evaluation attempt already consumed by ${params.artifact.hash}; M0 admits one public non-baseline evaluator invocation per run`,
          );
        }
      } else {
        if (this.promotionSlots.size >= this.maxPublicCandidateEvaluations) {
          const first = this.promotionSlots.values().next().value as string | undefined;
          throw new BrokerError(
            "QUOTA_EXCEEDED",
            this.maxPublicCandidateEvaluations === 1
              ? `candidate evaluation attempt already consumed by ${first ?? "unknown"}; M0 admits one public non-baseline evaluator invocation per run`
              : `public candidate evaluation cap reached (${this.maxPublicCandidateEvaluations})`,
          );
        }
        // Synchronous durable admission before ANY await/spawn.
        this.state().append({ t: "slot", hash: params.artifact.hash });
        this.promotionSlots.add(params.artifact.hash);
      }
    }
    // Every ADMITTED privileged holdout request consumes one lifetime ledger
    // slot — this is information-query budget, not unique-computation budget,
    // so it is charged BEFORE in-flight coalescing and memo lookup: N
    // concurrent identical calls burn N slots exactly like N sequential ones.
    // Immutable measurement generation for THIS evaluation, captured before
    // any await — a concurrently created episode must not re-scope an
    // in-flight measurement.
    const evalEpoch = this.measurementEpoch;
    if (group.visibility === "holdout") await this.chargeHoldout();
    const memoKey =
      `run:${this.config.runId}|gen:${evalEpoch}|${params.artifact.hash}` +
      `|${this.config.capsuleDigest}|${this.config.optimizerDigest}|${params.assetGroupId}|${params.seed}|wall:${this.evalTimeoutSec}` +
      (this.trustedMeasurementEpoch === undefined
        ? ""
        : `|measurementEpoch:${encodeURIComponent(this.trustedMeasurementEpoch)}`);
    const existing = this.inFlightEvaluations.get(memoKey);
    if (existing !== undefined) {
      return this.redactRecord(await existing, group.visibility, ctx);
    }
    if (this.pendingEvaluations >= this.maxConcurrentEvaluations) {
      throw new BrokerError("QUOTA_EXCEEDED", `concurrent evaluator cap reached (${this.maxConcurrentEvaluations})`);
    }
    if (this.spent.evaluatorInvocations + this.pendingEvaluations >= this.manifest.budget.maxEvaluatorInvocations) {
      throw new BrokerError("BUDGET_EXCEEDED", "budget dimension exhausted: evaluatorInvocations");
    }
    this.pendingEvaluations += 1;
    const evaluation = this.evaluateReserved(params, group, ctx, memoKey, evalEpoch);
    this.inFlightEvaluations.set(memoKey, evaluation);
    try {
      return this.redactRecord(await evaluation, group.visibility, ctx);
    } finally {
      this.pendingEvaluations -= 1;
      this.inFlightEvaluations.delete(memoKey);
    }
  }

  private async evaluateReserved(
    params: EvaluateP,
    group: CapsuleManifest["assetGroups"][number],
    ctx: CallContext,
    memoKey: string,
    epoch: string,
  ): Promise<EvaluationRecord> {
    // Memo key pins the FULL provenance of a measurement: run, measurement
    // generation (`${bootNonce}:{startup|ep<N>}`), artifact, frozen capsule
    // digest, optimizer digest, asset group, seed, AND the effective
    // evaluator wall-time cap (config.evalTimeoutSec). The cap sets the
    // docker timeout for the evaluator run, so a per-run overlay can change
    // it while capsuleDigest stays the frozen capsule digest — a
    // timing-sensitive result measured under one cap must never be served to
    // a run with a different cap; a different capsule or optimizer build can
    // likewise never alias onto a cached record. runId keeps one run's
    // measurements from leaking into another; the boot nonce inside the
    // generation forces a fresh comparator after any kill/resume (an
    // hours-old pre-crash parent measurement must not stand in for today's
    // conditions); the episode number makes every new mutation episode
    // re-measure parent AND candidate freshly. Retries within one
    // boot+episode still memoize.
    const memoHash = await this.cas.indexGet(this.evaluationCacheNamespace, memoKey);
    if (memoHash !== undefined && (await this.cas.has(memoHash))) {
      const record = EvaluationRecord.parse(JSON.parse((await this.cas.readBuffer(memoHash)).toString("utf8")));
      const cached = { ...record, cached: true };
      this.recordEvaluation(cached, group.visibility, epoch);
      return cached;
    }

    if (this.evaluationStrategy !== undefined) {
      return await this.evaluateWithTrustedStrategy(params, group, memoKey, epoch);
    }

    const workspaceDir = await this.ensureUnpacked(params.artifact.hash);
    // The evaluator ALWAYS runs from the frozen baseline tree — candidate
    // code cannot substitute its own copy of the evaluator (scoring attack).
    const evaluatorBaselineHash = this.config.evaluatorBaselineArtifactHash ?? this.config.baselineArtifactHash;
    const baselineDir = await this.ensureUnpacked(evaluatorBaselineHash);
    if (this.manifest.protectedPaths.length > 0) {
      if (this.config.evaluatorBaselineArtifactHash !== undefined) {
        const violations = await findProtectedPaths(workspaceDir, this.manifest.protectedPaths);
        if (violations.length > 0) {
          throw new BrokerError("PROTECTED_PATH_VIOLATION", `protected paths reintroduced into hidden-evaluator workspace: ${violations.join(", ")}`, {
            paths: violations,
          });
        }
      } else if (params.artifact.hash !== this.config.baselineArtifactHash) {
        const violations = await diffProtectedPaths(baselineDir, workspaceDir, this.manifest.protectedPaths);
        if (violations.length > 0) {
          throw new BrokerError("PROTECTED_PATH_VIOLATION", `protected paths modified: ${violations.join(", ")}`, {
            paths: violations,
          });
        }
      }
    }

    const releaseEvaluation = await this.enterEvaluationQuiescence();
    try {
    // Stage the selected group BEFORE burning the invocation: a missing or
    // non-regular host asset is trusted-side misconfiguration, not an
    // attempted evaluation.
    const stageDir = await this.stageAssets(group);

    let invocationEvents: RunEvent[] = [];
    let res: CmdResult;
    const startedMs = Date.now();
    const evalName = `hone-${this.safeRunId}-eval-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    try {
      // Closing fence BEFORE the durable burn: a broker that is already
      // closing must not consume an invocation it will never spawn.
      if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");

      // Burn the invocation DURABLY before the spawn so a crashed evaluator
      // cannot farm free retries. The projected snapshot/exhaustion are part
      // of that same fact, but publish only after this admitted evaluation
      // returns so the exact-cap invocation itself is allowed to finish.
      const budgetEvents: EmittableEvent[] = [
        { type: "budget.snapshot", budget: this.budgetStateNow(0, 0, 1) },
      ];
      const exhausted = this.exhaustedDimension(0, 0, 1);
      if (exhausted !== undefined && !this.exhaustedAnnounced.has(exhausted)) {
        budgetEvents.push({ type: "budget.exhausted", dimension: exhausted });
      }
      invocationEvents = this.journalFact({ t: "inv" }, budgetEvents);
      this.spent.evaluatorInvocations += 1;

      const argv = [
        "docker",
        "run",
        "--rm",
        "--name",
        evalName,
        "--network",
        "none",
        "--label",
        `hone.runId=${this.config.runId}`,
        ...this.resourceArgs(),
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "KILL",
        // Trusted-parent-only reset authority. setuid(2000) clears these
        // capabilities from the candidate worker, and no-new-privileges
        // prevents reacquisition through file capabilities.
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "IPC_OWNER",
        // Trusted-scorer-only namespace authority (evaluator container ONLY,
        // never mutation sandboxes/keeper): the scorer's preexec unshares
        // fresh NET+IPC namespaces per repetition BEFORE the setuid(2000)
        // drop, so cross-rep loopback state (TIME_WAIT caches, SysV IPC)
        // cannot leak between repetitions. The drop strips it from the
        // candidate worker and no-new-privileges prevents reacquisition.
        "--cap-add",
        "SYS_ADMIN",
        "--read-only",
        "--tmpfs",
        "/tmp:size=16m,nosuid,nodev,noexec",
        "--shm-size",
        "16m",
        // The trusted scorer runs as ROOT inside the eval container so it can
        // drop the candidate worker to an unprivileged uid (2000) — same-uid
        // signal//proc reach from candidate code to the scorer is severed
        // (capsule contract with WP6; hardened images ship a `sandbox` user).
        "--user",
        "0:0",
        // Entrypoints are baseline-relative; the candidate workspace is DATA,
        // never the working directory the evaluator executes from.
        "-w",
        "/trusted/baseline",
        "-e",
        `HONE_SEED=${params.seed}`,
        "-v",
        `${workspaceDir}:/workspace:ro`,
        "-v",
        `${baselineDir}:/trusted/baseline:ro`,
        // Asset confidentiality: the assets bind mount is parented under a
        // root-owned mode=0700 tmpfs, so the dropped uid-2000 candidate
        // worker cannot even traverse to it. The kernel enforces this on the
        // tmpfs everywhere — Docker Desktop's VirtioFS bind mounts do NOT
        // enforce host file modes in-container. Host-side, the staged tree is
        // dirs 0755 / files 0644 under the 0700 host-only tmp parent: on
        // native Linux the cap-dropped evaluator (even uid 0 has no
        // CAP_DAC_OVERRIDE) must be able to read the bind content.
        "--tmpfs",
        "/capsule:mode=0700,size=1m",
        "-v",
        `${stageDir}:/capsule/assets:ro`,
      ];
      argv.push(this.config.image, ...this.manifest.evalEntrypoint);

      // Registration is SYNCHRONOUS with the spawn: close() either sees this
      // name in the tracked set and reaps it, or this op threw before
      // spawning. Every post-registration path — resolve, throw, timeout —
      // runs the reap finally below, so a journal append failure (which
      // throws ABOVE, before registration) can never strand a phantom
      // tracked name or repeat staging against a poisoned journal.
      if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
      this.trackedContainers.add(evalName);
      try {
        res = await this.run(argv, { timeoutMs: this.evalTimeoutSec * 1000, maxOutputBytes: 32 * 1024 * 1024 });
      } finally {
        // A timed-out `docker run` kills only the local CLI; the container (and
        // the adversarial code inside it) keeps running. Always reap by name —
        // a no-op for containers --rm already removed.
        const retired = await this.removeTrackedContainer(evalName);
        if (!containerGone(retired)) {
          throw new BrokerError("INTERNAL", `evaluator cleanup failed: ${stderrText(retired)}`);
        }
      }
    } finally {
      // Confidentiality teardown on EVERY path (success, error, timeout):
      // staged fixtures disappear before any untrusted process runs again.
      await rm(stageDir, { recursive: true, force: true });
    }
    const durationMs = Date.now() - startedMs;
    this.publish(invocationEvents);
    if (res.timedOut) throw new BrokerError("INTERNAL", `evaluator timed out after ${this.evalTimeoutSec}s`);
    if (res.exitCode !== 0) throw new BrokerError("INTERNAL", `evaluator exited ${res.exitCode}: ${stderrText(res)}`);

    let output: EvaluatorOutput;
    try {
      output = EvaluatorOutput.parse(JSON.parse(res.stdout.toString("utf8")));
    } catch (err) {
      throw new BrokerError("INTERNAL", `evaluator emitted invalid EvaluatorOutput: ${String(err)}`);
    }

    const record = EvaluationRecord.parse({
      capsuleId: this.manifest.id,
      artifactHash: params.artifact.hash,
      assetGroupId: params.assetGroupId,
      seed: params.seed,
      output,
      costUsd: 0, // eval containers have no network — no LLM spend to attribute
      durationMs,
      cached: false,
      evaluatedAt: new Date().toISOString(),
    });
    const recordHash = await this.cas.putBuffer(Buffer.from(JSON.stringify(record)));
    await this.cas.indexPut(this.evaluationCacheNamespace, memoKey, recordHash);
    this.recordEvaluation(record, group.visibility, epoch);
    return record;
    } finally {
      await releaseEvaluation();
    }
  }

  private async evaluateWithTrustedStrategy(
    params: EvaluateP,
    group: CapsuleManifest["assetGroups"][number],
    memoKey: string,
    epoch: string,
  ): Promise<EvaluationRecord> {
    const strategy = this.evaluationStrategy;
    if (strategy === undefined) throw new BrokerError("INTERNAL", "trusted evaluation strategy is not configured");
    const releaseEvaluation = await this.enterEvaluationQuiescence();
    try {
      if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
      const budgetEvents: EmittableEvent[] = [
        { type: "budget.snapshot", budget: this.budgetStateNow(0, 0, 1) },
      ];
      const exhausted = this.exhaustedDimension(0, 0, 1);
      if (exhausted !== undefined && !this.exhaustedAnnounced.has(exhausted)) {
        budgetEvents.push({ type: "budget.exhausted", dimension: exhausted });
      }
      const invocationEvents = this.journalFact({ t: "inv" }, budgetEvents);
      this.spent.evaluatorInvocations += 1;

      let supplied: EvaluationRecord;
      try {
        supplied = EvaluationRecord.parse(await strategy({
          runId: this.config.runId,
          capsuleId: this.manifest.id,
          artifact: params.artifact,
          assetGroupId: params.assetGroupId,
          seed: params.seed,
          ...(this.trustedMeasurementEpoch !== undefined
            ? { measurementEpoch: this.trustedMeasurementEpoch }
            : {}),
        }));
      } finally {
        this.publish(invocationEvents);
      }
      if (
        supplied.capsuleId !== this.manifest.id ||
        supplied.artifactHash !== params.artifact.hash ||
        supplied.assetGroupId !== params.assetGroupId ||
        supplied.seed !== params.seed
      ) {
        throw new BrokerError("INTERNAL", "trusted evaluation strategy returned a record for a different request identity");
      }
      const record = EvaluationRecord.parse({ ...supplied, cached: false });
      const recordHash = await this.cas.putBuffer(Buffer.from(JSON.stringify(record)));
      await this.cas.indexPut(this.evaluationCacheNamespace, memoKey, recordHash);
      this.recordEvaluation(record, group.visibility, epoch);
      return record;
    } finally {
      await releaseEvaluation();
    }
  }

  /**
   * Holdout charge against the repo-lifetime ledger (@hone/scoring
   * HoldoutLedger) — the ONLY authority over lifetime holdout access. The
   * charge is written + fsynced by the ledger BEFORE the access is granted;
   * a run-local journal line is kept afterwards purely for replay
   * observability (it never gates anything, so a new run against the same
   * ledger path can never reset the lifetime count).
   */
  private async chargeHoldout(): Promise<void> {
    const ledger = this.ledger;
    if (!ledger) throw new BrokerError("INTERNAL", "holdout ledger not open (broker not initialized)");
    let charged: { count: number; budget: number };
    try {
      charged = await ledger.charge();
    } catch (err) {
      if (err instanceof HoldoutBudgetExceededError) {
        throw new BrokerError("HOLDOUT_ACCESS_DENIED", "holdout ledger budget exhausted");
      }
      throw err;
    }
    const seq = this.holdoutCount + 1;
    const events = this.journalFact(
      { t: "holdout", seq },
      [{
        type: "holdout.accessed",
        capsuleId: this.manifest.id,
        ledgerCount: charged.count,
        ledgerBudget: charged.budget,
      }],
    );
    this.holdoutCount = seq;
    this.publish(events);
  }

  /**
   * Trusted scalarization + the eval.completed event. Holdout results NEVER
   * enter the log or the promotion table — scores of ledger-gated groups stay
   * admin-side. Ineligible outputs (invalid, objective-less, non-finite, or
   * any failed constraint) grant no authority.
   *
   * Authority is EPOCH-SCOPED: the measurement lands in the epoch captured
   * when its evaluation was admitted, and a same-epoch retry is a no-op
   * (memoized). A gate is derived — and PERSISTED inside the journaled eval
   * fact — only when BOTH hold:
   * - the lineage parent already holds a measurement at this exact
   *   coordinate IN THE SAME EPOCH (parent-before-child): measuring the
   *   parent after shopping candidate seeds, in an older episode, or before
   *   a crash pairs nothing; and
   * - this is the candidate's FIRST trusted evidence EVER (global artifact
   *   taint): any earlier candidate measurement — child-first, any seed, any
   *   epoch — permanently disqualifies the artifact from gate authority.
   *   Coordinate-level taint is not enough: evaluator inode/page-cache state
   *   survives across evaluator containers and seeds don't change assets, so
   *   a child-first run at seed 0 warms caches that flatter a "clean"
   *   parent→child pairing at seed 1. Repairs and byte-identical resaves
   *   share the hash, so they inherit the taint.
   *
   * Public events keep the historical shape: eval.completed once per
   * artifact/coordinate lifetime (episode-tagged on the artifact's first
   * record), gate.paired only alongside that first tagged record — fresh
   * re-measurements in later epochs are measurements, not news and not
   * authority (see registerGate: the first pair is frozen).
   */
  private recordEvaluation(record: EvaluationRecord, visibility: string, epoch: string): void {
    if (visibility === "holdout" && !this.terminalHoldoutAssetGroupIds.has(record.assetGroupId)) return;
    const aggregate = eligibleAggregate(record);
    if (aggregate === undefined) return;
    if (
      record.artifactHash !== this.config.baselineArtifactHash &&
      this.promotionSlots.has(record.artifactHash)
    ) {
      this.trustedAcceptedCandidates.add(record.artifactHash);
    }
    const pairKey = `${record.assetGroupId}|${record.seed}`;
    if (this.trusted.get(`${epoch}|${record.artifactHash}`)?.has(pairKey) === true) return;
    const epochSeq = this.epochSeqByName.get(epoch);
    if (epochSeq === undefined) {
      throw new BrokerError("INTERNAL", `measurement epoch was never minted by trusted code: ${epoch}`);
    }

    // Gate derivation BEFORE the child's own insertion: parent-before-child
    // within the SAME epoch, at the same coordinate, and only as the
    // candidate's first-ever trusted evidence (global taint — any prior
    // measurement of this artifact kills authority for good).
    const lin = this.lineage.get(record.artifactHash);
    const lifetime = this.lifetimeCoords.get(record.artifactHash);
    const hadTrusted = (lifetime?.size ?? 0) > 0;
    const lifetimeFirst = lifetime?.has(pairKey) !== true;
    const parentScore =
      lin === undefined || hadTrusted || !this.promotionSlots.has(record.artifactHash)
        ? undefined
        : this.trusted.get(`${epoch}|${lin.parent}`)?.get(pairKey);
    const gate: GateFact | undefined =
      lin !== undefined && parentScore !== undefined
        ? { parent: lin.parent, parentScore, childScore: aggregate, passed: aggregate > parentScore }
        : undefined;

    const tagged = this.anyEpisodeStarted && !hadTrusted ? lin : undefined;
    const events: EmittableEvent[] = [];
    if (this.anyEpisodeStarted && lifetimeFirst) {
      events.push({
        type: "eval.completed",
        ...(tagged !== undefined ? { episode: tagged.episode } : {}),
        artifact: { hash: record.artifactHash },
        assetGroupId: record.assetGroupId,
        seed: record.seed,
        aggregate,
        cached: record.cached,
      });
      if (tagged !== undefined && gate !== undefined) {
        events.push({
          type: "gate.paired",
          episode: tagged.episode,
          parentScore: gate.parentScore,
          childScore: gate.childScore,
          passed: gate.passed,
        });
      }
    }

    const journaled = this.journalFact({
      t: "eval",
      record,
      epoch,
      epochSeq,
      ...(this.trustedMeasurementEpoch !== undefined ? { measurementEpoch: this.trustedMeasurementEpoch } : {}),
      ...(gate !== undefined ? { gate } : {}),
    }, events);
    // Tables AFTER the durable fact, via the same helpers replay uses — a
    // crash rebuilds the exact same measurements and persisted gates.
    this.insertMeasurement(epoch, record.artifactHash, pairKey, aggregate);
    if (gate !== undefined) this.registerGate(record.artifactHash, epoch, pairKey, gate);
    this.publish(journaled);
  }

  /**
   * Result minimization at the trust boundary: unprivileged clients querying
   * a PROTECTED asset group get scores only — per-example feedback, example
   * ids, and evaluator diagnostics stay admin-side (they exist to leak).
   */
  private redactRecord(record: EvaluationRecord, visibility: string, ctx: CallContext): EvaluationRecord {
    if (ctx.privileged || visibility === "public") return record;
    return {
      ...record,
      output: {
        valid: record.output.valid,
        objectives: record.output.objectives,
        constraints: record.output.constraints,
        perExample: {},
      },
    };
  }

  /**
   * Promotion authority (contract 2): the client's report is a HINT. An
   * artifact becomes incumbent only when this broker's own eligible records
   * prove it — the ONE persisted SAME-EPOCH, PARENT-FIRST gate pair with a
   * positive delta, plus monotone improvement over the current incumbent on
   * same-epoch paired records. Claimed metrics are never read.
   *
   * Anti-score-shopping: the gate pair exists only when the lineage parent
   * was measured BEFORE the candidate within one measurement epoch AND the
   * pairing was the candidate's first-ever trusted evidence (global taint) —
   * shopping candidate seeds/epochs and then staging parent→child at a
   * lucky (or cache-warmed) coordinate pairs nothing, and pre-crash or
   * pre-episode parent scores pair nothing either. The pair is FROZEN at
   * first registration — never supplemented or replaced — so a failed first
   * pairing is permanent: this method reads only that frozen authority, and
   * no volume of later createSandbox/evaluate epochs, retries, or re-reports
   * can make an initially losing candidate promotable. The pair replays
   * verbatim from the journal, so this authority survives crashes.
   */
  reportIncumbent(params: ReportIncumbentP, _ctx: CallContext): Record<string, never> {
    this.budgetGate();
    const hash = params.artifact.hash;
    if (this.currentIncumbent?.hash === hash) return {}; // idempotent re-report

    const lin = this.lineage.get(hash);
    if (!lin) {
      throw new BrokerError("INTERNAL", `reportIncumbent: ${hash} is not a saved candidate of this run (no lineage)`);
    }
    if ((this.lifetimeCoords.get(hash)?.size ?? 0) === 0) {
      throw new BrokerError("INTERNAL", `reportIncumbent: no trusted evaluation for artifact ${hash}`);
    }
    if (!this.promotionSlots.has(hash)) {
      throw new BrokerError(
        "INTERNAL",
        `reportIncumbent: insufficient authority — artifact has no public candidate evaluation admission (cap ${this.maxPublicCandidateEvaluations})`,
      );
    }
    const gateEntry = this.gates.get(hash);
    if (gateEntry === undefined || gateEntry.gate.parent !== lin.parent) {
      throw new BrokerError(
        "INTERNAL",
        "reportIncumbent: insufficient authority — no persisted same-epoch parent-first gate pairing candidate and parent " +
          "(measure the parent BEFORE the candidate's first-ever evaluation, at a shared group+seed coordinate, " +
          "within the current mutation episode)",
      );
    }
    const deltaVsParent = gateEntry.gate.childScore - gateEntry.gate.parentScore;
    if (!(deltaVsParent > 0)) {
      throw new BrokerError("INTERNAL", `reportIncumbent: no positive trusted delta vs parent (paired delta ${deltaVsParent})`);
    }
    const cand = this.trusted.get(`${gateEntry.epoch}|${hash}`);
    if (cand === undefined || cand.size === 0) {
      throw new BrokerError("INTERNAL", `reportIncumbent: no trusted evaluation for artifact ${hash}`);
    }
    const inc = this.currentIncumbent;
    if (inc !== undefined && inc.hash !== lin.parent) {
      // Same-epoch pairing against the incumbent too — a stale incumbent
      // score from another generation is not a comparator.
      const incScores = this.trusted.get(`${gateEntry.epoch}|${inc.hash}`);
      const pairedInc = incScores === undefined ? [] : [...cand.keys()].filter((k) => incScores.has(k));
      if (incScores === undefined || pairedInc.length === 0) {
        throw new BrokerError(
          "INTERNAL",
          "reportIncumbent: insufficient authority — no paired evaluations of candidate and current incumbent",
        );
      }
      const deltaVsInc = meanOver(cand, pairedInc) - meanOver(incScores, pairedInc);
      if (!(deltaVsInc > 0)) {
        throw new BrokerError("INTERNAL", `reportIncumbent: not an improvement over current incumbent (paired delta ${deltaVsInc})`);
      }
    }

    const aggregate = meanOver(cand, [...cand.keys()]);
    // deltaVsBaseline is only meaningful over PAIRED same-epoch keys: the
    // client picks which evaluations exist, so disjoint mean-vs-mean would
    // let it steer the trusted progress number arbitrarily. No same-epoch
    // paired baseline measurement -> no promotion (the parent chain starts
    // at the baseline, so honest optimizers always have one for the keys
    // they promote on).
    const baselineScores = this.trusted.get(`${gateEntry.epoch}|${this.config.baselineArtifactHash}`);
    const pairedBaseline = baselineScores === undefined ? [] : [...cand.keys()].filter((k) => baselineScores.has(k));
    if (baselineScores === undefined || pairedBaseline.length === 0) {
      throw new BrokerError(
        "INTERNAL",
        "reportIncumbent: insufficient authority — no same-group/same-seed paired evaluations of candidate and baseline",
      );
    }
    const deltaVsBaseline = meanOver(cand, pairedBaseline) - meanOver(baselineScores, pairedBaseline);

    // Durable BEFORE the ack and the event — a restart replays exactly the
    const events = this.journalFact(
      { t: "incumbent", hash, aggregate, deltaVsBaseline, episode: lin.episode },
      [
        {
          type: "incumbent.new",
          artifact: { hash },
          aggregate,
          deltaVsBaseline,
          episode: lin.episode,
        },
        { type: "budget.snapshot", budget: this.budgetStateNow() },
      ],
    );
    const promoted = { hash, aggregate, deltaVsBaseline, episode: lin.episode };
    this.incumbentHistory.push(promoted);
    this.currentIncumbent = promoted;
    this.lastIncumbent = params;
    this.publish(events);
    return {};
  }

  /** Durable trusted-side terminal snapshot; never exposed on the public RPC table. */
  snapshotBudget(_ctx: CallContext): Record<string, never> {
    this.emit({ type: "budget.snapshot", budget: this.budgetStateNow() });
    return {};
  }

  getBudget(ctx: CallContext): BudgetState {
    const budget = this.budgetStateNow();
    if (
      !ctx.privileged &&
      this.trustedValidPublicCandidateTarget !== undefined &&
      this.trustedAcceptedCandidates.size >= this.trustedValidPublicCandidateTarget
    ) {
      return BudgetState.parse({
        envelope: budget.envelope,
        spent: { ...budget.spent, evaluatorInvocations: budget.envelope.maxEvaluatorInvocations },
      });
    }
    return budget;
  }
  /** Trusted admission view: includes a projected-refusal latch, not only numeric spend. */
  getBudgetExhaustion(ctx: CallContext): BudgetDimension | undefined {
    if (!ctx.privileged) throw new BrokerError("INTERNAL", "getBudgetExhaustion requires the admin socket");
    const persisted = this.exhaustedAnnounced.values().next().value;
    return persisted === "tokens" || persisted === "usd" || persisted === "wallClockSec" || persisted === "evaluatorInvocations"
      ? persisted
      : this.exhaustedDimension();
  }

  finish(params: FinishP, _ctx: CallContext): Record<string, never> {
    this.best = params.best;
    return {};
  }

  notImplemented(): never {
    this.budgetGate();
    throw new BrokerError("NOT_IMPLEMENTED", "reserved method — not available in the seed");
  }

  /**
   * Trusted proxy admission refusal: the next requested unit of work cannot
   * fit in the remaining envelope. Persist the boundary before replying 402;
   * budgetGate then prevents an unbounded mutable loop from retrying forever,
   * including after crash/resume.
   */
  recordBudgetExhaustion(dimension: BudgetDimension, ctx: CallContext): Record<string, never> {
    if (!ctx.privileged) throw new BrokerError("INTERNAL", "recordBudgetExhaustion requires the admin socket");
    if (!this.exhaustedAnnounced.has(dimension)) this.emit({ type: "budget.exhausted", dimension });
    return {};
  }

  recordSpend(params: RecordSpendP, ctx: CallContext): Record<string, never> {
    if (!ctx.privileged) throw new BrokerError("INTERNAL", "recordSpend requires the admin socket");
    // Spend and the projected public budget state are one durable fact.
    const budgetEvents: EmittableEvent[] = [
      { type: "budget.snapshot", budget: this.budgetStateNow(params.tokens, params.usd) },
    ];
    const exhausted = this.exhaustedDimension(params.tokens, params.usd);
    if (exhausted !== undefined && !this.exhaustedAnnounced.has(exhausted)) {
      budgetEvents.push({ type: "budget.exhausted", dimension: exhausted });
    }
    const events = this.journalFact(
      { t: "spend", tokens: params.tokens, usd: params.usd },
      budgetEvents,
    );
    this.spent.tokens += params.tokens;
    this.spent.usd += params.usd;
    this.publish(events);
    return {};
  }

  get incumbent(): ReportIncumbentP | undefined {
    return this.lastIncumbent;
  }

  /** Trusted current incumbent (survives restarts via the run state log). */
  get trustedIncumbent(): IncumbentState | undefined {
    return this.currentIncumbent;
  }

  /**
   * Reconciles the complete broker-authored event journal against the
   * runner's public log. Only a missing suffix is recoverable: finding a later
   * public event after an earlier journal event is absent means the public log
   * has a non-prefix hole and must fail closed.
   */
  replayJournalEvents(alreadyLogged: readonly RunEvent[]): number {
    if (!this.eventJournalFormat) {
      // One-time legacy migration. Validate the authority-bearing promotion
      // subsequence, then durably seed existing public events AND every
      // recoverable missing incumbent in one newline/fsync transaction.
      const publicEvents = alreadyLogged.filter(isBrokerAuthoredEvent);
      const publicIncumbents = publicEvents.filter((event) => event.type === "incumbent.new");
      if (publicIncumbents.length > this.incumbentHistory.length) {
        throw new BrokerError("INTERNAL", "legacy event log claims more incumbents than the authority journal");
      }
      for (let index = 0; index < publicIncumbents.length; index += 1) {
        const event = publicIncumbents[index];
        const incumbent = this.incumbentHistory[index];
        if (
          event === undefined
          || event.type !== "incumbent.new"
          || incumbent === undefined
          || event.artifact.hash !== incumbent.hash
          || event.aggregate !== incumbent.aggregate
          || event.deltaVsBaseline !== incumbent.deltaVsBaseline
          || event.episode !== incumbent.episode
        ) {
          throw new BrokerError("INTERNAL", "legacy public incumbent sequence diverges from the authority journal");
        }
      }
      const at = new Date(this.now()).toISOString();
      const missing = this.incumbentHistory.slice(publicIncumbents.length).map((incumbent) =>
        RunEvent.parse({
          runId: this.config.runId,
          at,
          type: "incumbent.new",
          artifact: { hash: incumbent.hash },
          aggregate: incumbent.aggregate,
          deltaVsBaseline: incumbent.deltaVsBaseline,
          episode: incumbent.episode,
        })
      );
      const migrated = [...publicEvents, ...missing];
      this.state().append({ t: "migration", events: migrated });
      this.journalEvents.push(...migrated);
      this.eventJournalFormat = true;
      for (const event of missing) this.config.onEvent(event);
      return missing.length;
    }
    // Exclusive broker events must be an exact prefix; no runner path emits
    // these types, so an extra or altered public record is corruption.
    const publicExclusive = alreadyLogged.filter(isBrokerAuthoredEvent);
    const journalExclusive = this.journalEvents.filter(isBrokerAuthoredEvent);
    if (publicExclusive.length > journalExclusive.length) {
      throw new BrokerError("INTERNAL", "broker event log is ahead of the authority journal");
    }
    for (let index = 0; index < publicExclusive.length; index += 1) {
      if (JSON.stringify(publicExclusive[index]) !== JSON.stringify(journalExclusive[index])) {
        throw new BrokerError("INTERNAL", "broker event log has a non-prefix gap relative to the authority journal");
      }
    }

    // Shared budget types may also be supervisor-authored. Match every exact
    // journal record against the full public stream and permit only a missing
    // suffix; validate the whole shape before appending anything.
    const publicLines = alreadyLogged.map((event) => JSON.stringify(event));
    let cursor = 0;
    let missingAt: number | null = null;
    for (let index = 0; index < this.journalEvents.length; index += 1) {
      const found = publicLines.indexOf(JSON.stringify(this.journalEvents[index]), cursor);
      if (found >= 0) {
        if (missingAt !== null) {
          throw new BrokerError("INTERNAL", "broker event log has a non-prefix gap relative to the authority journal");
        }
        cursor = found + 1;
      } else {
        missingAt ??= index;
      }
    }
    const missing = missingAt === null ? [] : this.journalEvents.slice(missingAt);
    for (const event of missing) this.config.onEvent(event);
    return missing.length;
  }

  /**
   * Legacy crash-resume recovery for journals created before complete event
   * transactions were introduced. New journals recover through
   * replayJournalEvents; this count-alignment fallback preserves old runs.
   */
  replayIncumbentEvents(alreadyLogged: number): number {
    if (!Number.isInteger(alreadyLogged) || alreadyLogged < 0 || alreadyLogged > this.incumbentHistory.length) {
      throw new BrokerError("INTERNAL", `replayIncumbentEvents: event log claims ${alreadyLogged} incumbents, journal has ${this.incumbentHistory.length}`);
    }
    const missing = this.incumbentHistory.slice(alreadyLogged);
    for (const inc of missing) {
      this.config.onEvent(RunEvent.parse({
        runId: this.config.runId,
        at: new Date(this.now()).toISOString(),
        type: "incumbent.new",
        artifact: { hash: inc.hash },
        aggregate: inc.aggregate,
        deltaVsBaseline: inc.deltaVsBaseline,
        episode: inc.episode,
      }));
    }
    return missing.length;
  }


  get finishedBest(): ArtifactRef | undefined {
    return this.best;
  }
}

function meanOver(scores: Map<string, number>, keys: readonly string[]): number {
  let sum = 0;
  for (const k of keys) sum += scores.get(k) ?? 0;
  return sum / keys.length;
}

/**
 * Preflight (constructor): asset-group paths must not overlap or nest across
 * visibility classes — otherwise mounting a public group could smuggle
 * protected/holdout files into a container that must never see them.
 */
function assertAssetGroupIsolation(manifest: CapsuleManifest): void {
  const entries = manifest.assetGroups.flatMap((g) =>
    g.paths.map((p) => ({ group: g.id, visibility: g.visibility, path: path.posix.normalize(p).replace(/\/+$/, "") })),
  );
  for (const e of entries) {
    if (e.path.startsWith("..") || path.posix.isAbsolute(e.path)) {
      throw new BrokerError("INTERNAL", `asset group ${e.group}: path escapes capsule root: ${e.path}`);
    }
  }
  for (const [i, a] of entries.entries()) {
    for (const b of entries.slice(i + 1)) {
      if (a.visibility === b.visibility) continue;
      // "." mounts the whole capsule root — it is an ancestor of everything.
      if (a.path === "." || b.path === "." || a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`)) {
        throw new BrokerError(
          "INTERNAL",
          `asset group paths overlap across visibility classes: ${a.group}:${a.path} (${a.visibility}) vs ${b.group}:${b.path} (${b.visibility})`,
        );
      }
    }
  }
}

/**
 * Preflight (constructor), filesystem half: the overlap check above is
 * LEXICAL, so a symlink, a case alias (default macOS filesystems are
 * case-insensitive), or a hard link inside the capsule root could still
 * alias one visibility class into another (public/train -> holdout). Reject
 * any symlink component in a declared asset path, require every path to
 * exist and resolve inside the (resolved) capsule root, then compare
 * CANONICAL identities across visibility classes: native realpaths (true
 * on-disk casing) for equality/ancestry, and dev+ino for hard-link aliases.
 * Fails closed at boot — independent of whatever capsule ingestion rejects.
 */
function assertAssetPathsResolveSafely(manifest: CapsuleManifest, capsuleRootDir: string): void {
  const realRoot = realpathSync.native(capsuleRootDir);
  const resolved: Array<{ group: string; visibility: string; rel: string; canonical: string; dev: number; ino: number }> = [];
  for (const g of manifest.assetGroups) {
    for (const rel of g.paths) {
      const norm = path.posix.normalize(rel).replace(/\/+$/, "");
      let cur = capsuleRootDir;
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        throw new BrokerError("INTERNAL", `capsule root missing on host: ${capsuleRootDir}`);
      }
      for (const part of norm.split("/")) {
        if (part === "." || part === "") continue;
        cur = path.join(cur, part);
        try {
          st = lstatSync(cur);
        } catch {
          throw new BrokerError("INTERNAL", `asset group ${g.id}: asset path missing on host: ${rel}`);
        }
        if (st.isSymbolicLink()) {
          throw new BrokerError(
            "INTERNAL",
            `asset group ${g.id}: symlink in asset path is not allowed: ${path.relative(capsuleRootDir, cur)}`,
          );
        }
      }
      const canonical = realpathSync.native(path.join(capsuleRootDir, norm));
      if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
        throw new BrokerError("INTERNAL", `asset group ${g.id}: asset path escapes capsule root after resolution: ${rel}`);
      }
      resolved.push({ group: g.id, visibility: g.visibility, rel, canonical, dev: st.dev, ino: st.ino });
    }
  }
  for (const [i, a] of resolved.entries()) {
    for (const b of resolved.slice(i + 1)) {
      if (a.visibility === b.visibility) continue;
      const aliased =
        a.canonical === b.canonical ||
        a.canonical.startsWith(b.canonical + path.sep) ||
        b.canonical.startsWith(a.canonical + path.sep) ||
        (a.dev === b.dev && a.ino === b.ino);
      if (aliased) {
        throw new BrokerError(
          "INTERNAL",
          `asset paths alias the same files across visibility classes: ${a.group}:${a.rel} (${a.visibility}) vs ${b.group}:${b.rel} (${b.visibility})`,
        );
      }
    }
  }

  // Content scan: hard links BELOW the declared paths can alias one class's
  // bytes into another even when the declared roots are disjoint. Enumerate
  // every mounted regular file/dir (lstat, symlinks never followed — inside
  // the container they resolve within the mount or dangle) and reject any
  // inode shared across visibility classes. Seed asset trees are small, so
  // this stays a boot-time cost.
  const seen = new Map<string, { group: string; visibility: string; rel: string }>();
  const record = (visibility: string, group: string, rel: string, dev: number, ino: number): void => {
    const key = `${dev}:${ino}`;
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, { group, visibility, rel });
    } else if (prior.visibility !== visibility) {
      throw new BrokerError(
        "INTERNAL",
        `asset paths alias the same files across visibility classes: ${group}:${rel} (${visibility}) vs ${prior.group}:${prior.rel} (${prior.visibility})`,
      );
    }
  };
  const walk = (visibility: string, group: string, dirAbs: string, relBase: string): void => {
    for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = `${relBase}/${entry.name}`;
      const st = lstatSync(abs);
      record(visibility, group, rel, st.dev, st.ino);
      if (entry.isDirectory()) walk(visibility, group, abs, rel);
    }
  };
  for (const r of resolved) {
    record(r.visibility, r.group, r.rel, r.dev, r.ino);
    if (lstatSync(r.canonical).isDirectory()) walk(r.visibility, r.group, r.canonical, r.rel);
  }
}

function stderrText(res: CmdResult): string {
  return res.stderr.toString("utf8").slice(0, 2_000);
}
