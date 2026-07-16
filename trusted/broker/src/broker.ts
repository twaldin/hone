import { createHash, randomUUID } from "node:crypto";
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
import { MAX_ARTIFACT_BYTES, canonicalizeWorkspaceTar, diffProtectedPaths, dirSizeBytes, unpackArtifact } from "./artifact.js";
import { CasStore } from "./cas.js";
import { runCommand, type CmdResult, type RunCommand } from "./command.js";
import { deferred } from "./deferred.js";
import { BrokerError } from "./errors.js";
import { ArtifactValidationError, validateWorkspaceTar } from "./tarcheck.js";

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

/** Mutation-sandbox network: fully isolated, or attached to a broker-managed internal network. */
export type SandboxNetworkMode = { mode: "none" } | { mode: "internal"; network: string };

export interface BrokerConfig {
  runId: string;
  manifest: CapsuleManifest;
  /** Directory holding the capsule's asset groups (paths in the manifest are relative to it). */
  capsuleRootDir: string;
  /** CAS hash of the trusted-measured baseline artifact. */
  baselineArtifactHash: string;
  /** Full canonical capsule digest ("sha256:<64 hex>") — pins the frozen capsule in the eval memo key. */
  capsuleDigest: string;
  /** Digest of the optimizer artifact driving this run ("sha256:<64 hex>") — also memo-key material. */
  optimizerDigest: string;
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
  /** docker --pids-limit for every container this broker spawns. Default 512. */
  sandboxPidsLimit?: number | undefined;
  /** docker --memory (bytes) for every container this broker spawns. Default 2 GiB. */
  sandboxMemoryBytes?: number | undefined;
  /** docker --cpus for every container this broker spawns. Default 2. */
  sandboxCpus?: number | undefined;
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
const SCRATCH_SNAPSHOT_SCRIPT =
  "set -eu; total=$(find /scratch -type f -exec stat -c %s {} + | awk '{s+=$1} END{print s+0}'); " +
  "[ \"$total\" -le \"${HONE_SCRATCH_QUOTA_BYTES:?}\" ] || { echo 'scratch apparent size exceeds quota' >&2; exit 1; }; " +
  "tar -cf /snapshot/scratch.tar.tmp -C /scratch .; mv -f /snapshot/scratch.tar.tmp /snapshot/scratch.tar";

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

const StateLine = z.discriminatedUnion("t", [
  z.object({ t: z.literal("start"), atMs: z.number(), events: JournalEvents }),
  z.object({ t: z.literal("spend"), tokens: z.number().int().nonnegative(), usd: z.number().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("inv"), events: JournalEvents }),
  z.object({ t: z.literal("holdout"), seq: z.number().int().positive(), events: JournalEvents }),
  z.object({ t: z.literal("eval"), record: EvaluationRecord, events: JournalEvents }),
  z.object({ t: z.literal("episode"), episode: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("lineage"), candidate: z.string(), parent: z.string(), episode: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("repair"), hash: z.string(), parent: z.string(), episode: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("trace"), hash: z.string().regex(/^sha256:[0-9a-f]{64}$/), bytes: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("artifact"), hash: z.string().regex(/^sha256:[0-9a-f]{64}$/), bytes: z.number().int().nonnegative(), events: JournalEvents }),
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

class RunStateLog {
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
    }
    // Only newline-terminated lines are authoritative; bytes after the last
    // newline are a torn crash-write whose action was never acknowledged.
    // Durably truncate them BEFORE replay/append — otherwise the next record
    // would fuse onto the torn tail and corrupt the journal on the restart
    // after that.
    const keep = content.lastIndexOf(0x0a) + 1; // 0 when no newline exists
    const fd = openSync(filePath, "a");
    if (keep !== content.length) {
      ftruncateSync(fd, keep);
      fsyncSync(fd);
    }
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
  }

  /** Append + fsync, blocking. Returns only once the whole line is durable. */
  append(line: StateLine): void {
    const buf = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
    let written = 0;
    while (written < buf.length) {
      written += writeSync(this.fd, buf, written, buf.length - written);
    }
    fsyncSync(this.fd);
  }

  close(): void {
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
  private readonly maxActiveSandboxes: number;
  private readonly maxConcurrentEvaluations: number;
  private readonly maxMutationEpisodes: number;
  private readonly maxCandidateArtifacts: number;
  private readonly maxCandidateArtifactBytes: number;
  private readonly sandboxPidsLimit: number;
  private readonly sandboxMemoryBytes: number;
  private readonly sandboxCpus: number;

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
   * artifactHash -> (assetGroupId|seed -> trusted aggregate) over this run's
   * ELIGIBLE non-holdout EvaluationRecords — the only promotion authority.
   */
  private readonly trusted = new Map<string, Map<string, number>>();
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
  private scratchReady = false;

  constructor(private readonly config: BrokerConfig) {
    this.manifest = CapsuleManifest.parse(config.manifest);
    assertAssetGroupIsolation(this.manifest);
    assertAssetPathsResolveSafely(this.manifest, config.capsuleRootDir);
    this.cas = new CasStore(config.casDir);
    this.run = config.runCommand ?? runCommand;
    this.now = config.now ?? Date.now;
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
    this.maxActiveSandboxes = config.maxActiveSandboxes ?? 8;
    this.maxConcurrentEvaluations = config.maxConcurrentEvaluations ?? 4;
    this.maxMutationEpisodes = config.maxMutationEpisodes ?? 64;
    this.maxCandidateArtifacts = config.maxCandidateArtifacts ?? 128;
    this.maxCandidateArtifactBytes = config.maxCandidateArtifactBytes ?? 2 * 1024 * 1024 * 1024;
    for (const [name, value] of [
      ["maxActiveSandboxes", this.maxActiveSandboxes],
      ["maxConcurrentEvaluations", this.maxConcurrentEvaluations],
      ["maxMutationEpisodes", this.maxMutationEpisodes],
      ["maxCandidateArtifacts", this.maxCandidateArtifacts],
      ["maxCandidateArtifactBytes", this.maxCandidateArtifactBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new BrokerError("INTERNAL", `${name} must be a positive safe integer`);
      }
    }
    this.sandboxPidsLimit = config.sandboxPidsLimit ?? 512;
    this.sandboxMemoryBytes = config.sandboxMemoryBytes ?? 2 * 1024 * 1024 * 1024;
    this.sandboxCpus = config.sandboxCpus ?? 2;
    this.episodeOrdinal = config.episodeOrigin ?? 0;
    this.startedAtMs = this.now();
    // Durable state opens (and replays) synchronously at construction — a
    // broker NEVER exists without its journal, so no method can act before
    // replay and no acknowledged fact can be lost to ordering.
    mkdirSync(config.runDir, { recursive: true });
    const stateLog = RunStateLog.open(path.join(config.runDir, STATE_FILE));
    try {
      this.validateReplay(stateLog);
      this.replayState(stateLog);
    } catch (error) {
      stateLog.close();
      throw error;
    }
  }

  async init(): Promise<void> {
    await mkdir(this.scratchDir, { recursive: true });
    await mkdir(this.scratchSnapshotDir, { recursive: true });
    await chmod(this.scratchSnapshotDir, 0o700);
    await mkdir(this.unpackRoot, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    // Repo-lifetime holdout authority: the ledger file outlives this run. A
    // fresh file is created with the immutable budget; an existing one keeps
    // its lifetime count — a new run can NEVER reset it (budget mismatch
    // fails closed inside HoldoutLedger.open).
    await mkdir(path.dirname(this.config.holdoutLedgerPath), { recursive: true });
    this.ledger = await HoldoutLedger.open(this.config.holdoutLedgerPath, { budget: this.holdoutBudget });
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

    let scratchRemovable = true;
    if (this.scratchVolumeName !== undefined && this.scratchReady) {
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

  /** Admission for async operations: rejected once close() has begun. */
  private enterOp(): void {
    if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
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
    const artifacts = new Set<string>();
    for (const line of log.replayed) {
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
        if (artifacts.size > this.maxCandidateArtifacts || artifactBytes > this.maxCandidateArtifactBytes) {
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
          }
          break;
        case "eval":
          this.acceptRecord(line.record);
          break;
        case "episode":
          this.episodeOrdinal = Math.max(this.episodeOrdinal, line.episode + 1);
          this.anyEpisodeStarted = true;
          break;
        case "lineage":
          this.lineage.set(line.candidate, { parent: line.parent, episode: line.episode });
          // Graduation: once a hash has candidate lineage it is never a
          // repair snapshot again — the lineage line is the tombstone.
          this.repairs.delete(line.candidate);
          break;
        case "repair":
          this.repairs.set(line.hash, { parent: line.parent, episode: line.episode });
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

  private reserveCandidateArtifact(hash: string, bytes: number): void {
    if (hash === this.config.baselineArtifactHash || this.candidateArtifactHashes.has(hash)) return;
    if (this.candidateArtifactHashes.size >= this.maxCandidateArtifacts) {
      throw new BrokerError("QUOTA_EXCEEDED", `candidate artifact count cap reached (${this.maxCandidateArtifacts})`);
    }
    if (this.candidateArtifactBytes + bytes > this.maxCandidateArtifactBytes) {
      throw new BrokerError("QUOTA_EXCEEDED", `candidate artifact byte cap reached (${this.maxCandidateArtifactBytes})`);
    }
    this.state().append({ t: "artifact", hash, bytes });
    this.candidateArtifactHashes.add(hash);
    this.candidateArtifactBytes += bytes;
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

  /** Stores an eligible record in the trusted table. Returns its aggregate on first sight, else undefined. */
  private acceptRecord(record: EvaluationRecord): number | undefined {
    const aggregate = eligibleAggregate(record);
    if (aggregate === undefined) return undefined;
    let perArtifact = this.trusted.get(record.artifactHash);
    if (!perArtifact) {
      perArtifact = new Map();
      this.trusted.set(record.artifactHash, perArtifact);
    }
    const pairKey = `${record.assetGroupId}|${record.seed}`;
    if (perArtifact.has(pairKey)) return undefined;
    perArtifact.set(pairKey, aggregate);
    return aggregate;
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
        await this.serializeSandbox(id, async () => {
          const current = this.sandboxes.get(id);
          if (current === undefined || this.now() < current.expiresAtMs) return;
          try {
            const removed = await this.removeTrackedContainer(current.containerId);
            if (containerGone(removed)) this.sandboxes.delete(id);
          } catch {
            // Keep the expired entry tracked: close() retries and fails terminal
            // cleanup if Docker still cannot remove it.
          }
        });
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
        "--opt", `o=size=${this.scratchQuotaBytes},nr_inodes=131072`,
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
        "--security-opt", "no-new-privileges",
        "-e", `HONE_SCRATCH_QUOTA_BYTES=${this.scratchQuotaBytes}`,
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
    const snapshotted = await this.run(
      ["docker", "exec", "-u", "root", this.scratchKeeperName, "/bin/sh", "-c", SCRATCH_SNAPSHOT_SCRIPT],
      { timeoutMs: 300_000 },
    );
    if (snapshotted.exitCode !== 0 || snapshotted.timedOut) {
      throw new BrokerError("INTERNAL", `scratch snapshot failed: ${stderrText(snapshotted)}`);
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
   * per-evaluation host directory (root and every directory 0700, every file
   * 0600, owned by the broker user) that becomes the SINGLE read-only source
   * of /capsule/assets. Selected fixtures therefore never reach a container
   * with their original owner-readable modes, and only the root evaluator
   * can read them in-container (see the tmpfs parent in evaluateReserved).
   * Sources must be regular files reached without following symlinks;
   * anything else fails closed before the invocation is burned.
   */
  private async stageAssets(group: CapsuleManifest["assetGroups"][number]): Promise<string> {
    const stageDir = path.join(this.tmpDir, `assets-${randomUUID()}`);
    await mkdir(stageDir, { recursive: true, mode: 0o700 });
    await chmod(stageDir, 0o700); // umask-independent
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
          await mkdir(parent, { recursive: true, mode: 0o700 });
          await chmod(parent, 0o700);
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
      await mkdir(dst, { recursive: true, mode: 0o700 });
      await chmod(dst, 0o700);
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
      await writeFile(dst, bytes, { mode: 0o600, flag: "wx" });
    } finally {
      await fh.close();
    }
    await chmod(dst, 0o600);
  }

  private async ensureUnpacked(hash: string): Promise<string> {
    await this.requireArtifact(hash);
    return unpackArtifact(this.cas, hash, this.unpackRoot, this.run);
  }

  /** Shared per-container resource ceilings (mutation AND eval containers). */
  private resourceArgs(): string[] {
    return [
      "--log-driver", "none",
      "--pids-limit", String(this.sandboxPidsLimit),
      "--memory", String(this.sandboxMemoryBytes),
      "--cpus", String(this.sandboxCpus),
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
    ];
  }

  // ---------- methods ----------

  getTask(_ctx: CallContext): GetTaskR {
    this.budgetGate();
    return {
      capsuleId: this.manifest.id,
      objective: this.manifest.objective,
      baselineArtifact: { hash: this.config.baselineArtifactHash },
      visibleAssetGroups: this.manifest.assetGroups.filter((g) => g.visibility !== "holdout").map((g) => g.id),
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
      const repair = this.lineage.has(params.artifact.hash) ? undefined : this.repairs.get(params.artifact.hash);
      const reservesNewEpisode = repair === undefined;
      if (reservesNewEpisode && this.episodeOrdinal + this.pendingNewEpisodes >= this.maxMutationEpisodes) {
        throw new BrokerError("BUDGET_EXCEEDED", `mutation episode cap reached (${this.maxMutationEpisodes})`);
      }
      if (reservesNewEpisode) this.pendingNewEpisodes += 1;
      this.pendingSandboxes += 1;
      try {
        return await this.createSandboxReserved(params, repair);
      } finally {
        this.pendingSandboxes -= 1;
        if (reservesNewEpisode) this.pendingNewEpisodes -= 1;
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
      `/workspace:rw,exec,nosuid,nodev,size=${this.workspaceQuotaBytes},mode=1777`,
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
    const unpack = await this.run([
      "docker", "exec", "-i", "-u", "1000:1000", containerId,
      "/bin/tar", "-o", "--no-same-permissions", "--strip-components", "1", "-x", "-C", "/workspace",
    ], {
      stdin: artifactBytes,
      timeoutMs: 300_000,
    });
    if (unpack.exitCode !== 0) {
      await this.removeTrackedContainer(containerId);
      throw new BrokerError("INTERNAL", `artifact unpack failed: ${stderrText(unpack)}`);
    }

    // close() snapshots the sandbox map — a container spawned in flight but
    // not yet registered would leak past it. Reap it here instead.
    if (this.closing) {
      await this.removeTrackedContainer(containerId);
      throw new BrokerError("INTERNAL", "broker is closed");
    }

    const ttlSec = params.ttlSec ?? this.defaultTtlSec;
    let episode: number;
    let parentHash: string;
    let startedEvents: RunEvent[] = [];
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
    this.sandboxes.set(sandboxId, {
      containerId,
      expiresAtMs: this.now() + ttlSec * 1000,
      episode,
      parentHash,
      lastExecStdout: null,
      lastExecExitCode: null,
      lastExecTruncated: null,
    });
    this.publish(startedEvents);
    return { sandboxId };
  }

  async exec(params: ExecP, ctx: CallContext): Promise<ExecR> {
    this.enterOp();
    try {
      return await this.serializeSandbox(params.sandboxId, () => this.execOp(params, ctx));
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
      return await this.serializeSandbox(params.sandboxId, () => this.putFileOp(params, ctx));
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
      return await this.serializeSandbox(params.sandboxId, () => this.getFileOp(params, ctx));
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
      return await this.serializeSandbox(params.sandboxId, () => this.saveArtifactOp(params, ctx));
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
        (candidateHash, bytes) => this.reserveCandidateArtifact(candidateHash, bytes),
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
    const memoKey = `${params.artifact.hash}|${this.config.capsuleDigest}|${this.config.optimizerDigest}|${params.assetGroupId}|${params.seed}|wall:${this.evalTimeoutSec}`;
    const existing = this.inFlightEvaluations.get(memoKey);
    if (existing !== undefined) return existing;
    if (this.pendingEvaluations >= this.maxConcurrentEvaluations) {
      throw new BrokerError("QUOTA_EXCEEDED", `concurrent evaluator cap reached (${this.maxConcurrentEvaluations})`);
    }
    if (this.spent.evaluatorInvocations + this.pendingEvaluations >= this.manifest.budget.maxEvaluatorInvocations) {
      throw new BrokerError("BUDGET_EXCEEDED", "budget dimension exhausted: evaluatorInvocations");
    }
    this.pendingEvaluations += 1;
    const evaluation = this.evaluateReserved(params, group, ctx, memoKey);
    this.inFlightEvaluations.set(memoKey, evaluation);
    try {
      return await evaluation;
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
  ): Promise<EvaluationRecord> {
    if (group.visibility === "holdout") {
      if (!ctx.privileged) {
        throw new BrokerError("HOLDOUT_ACCESS_DENIED", "holdout asset groups are only reachable on the admin socket");
      }
      await this.chargeHoldout();
    }

    // Memo key pins the FULL provenance of a measurement: artifact, frozen
    // capsule digest, optimizer digest, asset group, seed, AND the effective
    // evaluator wall-time cap (config.evalTimeoutSec). The cap sets the
    // docker timeout for the evaluator run, so a per-run overlay can change
    // it while capsuleDigest stays the frozen capsule digest — a
    // timing-sensitive result measured under one cap must never be served to
    // a run with a different cap. A different capsule or optimizer build can
    // likewise never alias onto a cached record.
    const memoHash = await this.cas.indexGet("eval", memoKey);
    if (memoHash !== undefined && (await this.cas.has(memoHash))) {
      const record = EvaluationRecord.parse(JSON.parse((await this.cas.readBuffer(memoHash)).toString("utf8")));
      const cached = { ...record, cached: true };
      this.recordEvaluation(cached, group.visibility);
      return this.redactRecord(cached, group.visibility, ctx);
    }

    const workspaceDir = await this.ensureUnpacked(params.artifact.hash);
    // The evaluator ALWAYS runs from the frozen baseline tree — candidate
    // code cannot substitute its own copy of the evaluator (scoring attack).
    const baselineDir = await this.ensureUnpacked(this.config.baselineArtifactHash);
    if (params.artifact.hash !== this.config.baselineArtifactHash && this.manifest.protectedPaths.length > 0) {
      const violations = await diffProtectedPaths(baselineDir, workspaceDir, this.manifest.protectedPaths);
      if (violations.length > 0) {
        throw new BrokerError("PROTECTED_PATH_VIOLATION", `protected paths modified: ${violations.join(", ")}`, {
          paths: violations,
        });
      }
    }

    // Stage the selected group BEFORE burning the invocation: a missing or
    // non-regular host asset is trusted-side misconfiguration, not an
    // attempted evaluation.
    const stageDir = await this.stageAssets(group);

    let invocationEvents: RunEvent[] = [];
    let res: CmdResult;
    const startedMs = Date.now();
    const evalName = `hone-${this.safeRunId}-eval-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    try {
      // Last-instant closing check (synchronous with the registration and the
      // spawn below): close() either sees this eval container in the active
      // set and reaps it by name, or this op throws before spawning.
      if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
      this.trackedContainers.add(evalName);

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
        "--read-only",
        "--tmpfs",
        "/tmp",
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
        // enforce host file modes in-container, so the 0700/0600 staged host
        // tree alone is only sufficient on native Linux.
        "--tmpfs",
        "/capsule:mode=0700,size=1m",
        "-v",
        `${stageDir}:/capsule/assets:ro`,
      ];
      argv.push(this.config.image, ...this.manifest.evalEntrypoint);

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
      // the staged copies never outlive the evaluation.
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
    await this.cas.indexPut("eval", memoKey, recordHash);
    this.recordEvaluation(record, group.visibility);
    return this.redactRecord(record, group.visibility, ctx);
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
   * any failed constraint) grant no authority. Pre-episode evaluations (the
   * optimizer measuring its parent before any sandbox exists) populate
   * authority but emit nothing — the event log keeps episode.started first.
   *
   * Trusted probe evidence (M0 blocker, run_mrmklm7i738484): the FIRST
   * accepted evaluation of a saved candidate is tagged with its
   * broker-validated lineage episode, and — when the lineage parent already
   * holds a trusted aggregate at the SAME group/seed coordinate — followed by
   * a broker-authored `gate.paired` carrying exactly those trusted scores
   * (greedy: the child must strictly beat the parent). Optimizer events and
   * claims are never consulted. Later evaluations of the same artifact (an
   * old candidate re-measured as a parent of the next episode) are untagged
   * and re-emit no gate — the artifact already holds trusted records, and
   * replay repopulates those records before any live call, so a restart can
   * never make an old candidate look first again.
   */
  private recordEvaluation(record: EvaluationRecord, visibility: string): void {
    if (visibility === "holdout") return;
    const aggregate = eligibleAggregate(record);
    if (aggregate === undefined) return;
    const pairKey = `${record.assetGroupId}|${record.seed}`;
    let perArtifact = this.trusted.get(record.artifactHash);
    if (perArtifact?.has(pairKey) === true) return;

    const hadTrusted = (perArtifact?.size ?? 0) > 0;
    const lin = this.anyEpisodeStarted && !hadTrusted ? this.lineage.get(record.artifactHash) : undefined;
    const events: EmittableEvent[] = [];
    if (this.anyEpisodeStarted) {
      events.push({
        type: "eval.completed",
        ...(lin !== undefined ? { episode: lin.episode } : {}),
        artifact: { hash: record.artifactHash },
        assetGroupId: record.assetGroupId,
        seed: record.seed,
        aggregate,
        cached: record.cached,
      });
      if (lin !== undefined) {
        const parentScore = this.trusted.get(lin.parent)?.get(pairKey);
        if (parentScore !== undefined) {
          events.push({
            type: "gate.paired",
            episode: lin.episode,
            parentScore,
            childScore: aggregate,
            passed: aggregate > parentScore,
          });
        }
      }
    }

    const journaled = this.journalFact({ t: "eval", record }, events);
    if (perArtifact === undefined) {
      perArtifact = new Map();
      this.trusted.set(record.artifactHash, perArtifact);
    }
    perArtifact.set(pairKey, aggregate);
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
   * prove it — same-group/same-seed paired child-vs-parent positive delta,
   * plus monotone improvement over the current incumbent on paired records.
   * Claimed metrics are never read.
   */
  reportIncumbent(params: ReportIncumbentP, _ctx: CallContext): Record<string, never> {
    this.budgetGate();
    const hash = params.artifact.hash;
    if (this.currentIncumbent?.hash === hash) return {}; // idempotent re-report

    const lin = this.lineage.get(hash);
    if (!lin) {
      throw new BrokerError("INTERNAL", `reportIncumbent: ${hash} is not a saved candidate of this run (no lineage)`);
    }
    const cand = this.trusted.get(hash);
    if (!cand || cand.size === 0) {
      throw new BrokerError("INTERNAL", `reportIncumbent: no trusted evaluation for artifact ${hash}`);
    }
    const parentScores = this.trusted.get(lin.parent);
    const pairedParent = parentScores === undefined ? [] : [...cand.keys()].filter((k) => parentScores.has(k));
    if (parentScores === undefined || pairedParent.length === 0) {
      throw new BrokerError(
        "INTERNAL",
        "reportIncumbent: insufficient authority — no same-group/same-seed paired evaluations of candidate and parent",
      );
    }
    const deltaVsParent = meanOver(cand, pairedParent) - meanOver(parentScores, pairedParent);
    if (!(deltaVsParent > 0)) {
      throw new BrokerError("INTERNAL", `reportIncumbent: no positive trusted delta vs parent (paired delta ${deltaVsParent})`);
    }
    const inc = this.currentIncumbent;
    if (inc !== undefined && inc.hash !== lin.parent) {
      const incScores = this.trusted.get(inc.hash);
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
    // deltaVsBaseline is only meaningful over PAIRED keys: the client picks
    // which evaluations exist, so disjoint mean-vs-mean would let it steer
    // the trusted progress number arbitrarily. No paired baseline
    // measurement -> no promotion (the parent chain starts at the baseline,
    // so honest optimizers always have one for the keys they promote on).
    const baselineScores = this.trusted.get(this.config.baselineArtifactHash);
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

  getBudget(_ctx: CallContext): BudgetState {
    return this.budgetStateNow();
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
