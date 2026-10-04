import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  constants as fsConstants,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BudgetEnvelope,
  assessPromotion,
  BudgetState,
  canonicalJson,
  CapsuleRuntimeIdentity,
  CapsuleManifest,
  ChildRunAdmission,
  ChildRunLaunchReceipt,
  ChildRunTerminal,
  CompleteEpisodeParams,
  CreateSandboxParams,
  EvaluateParams,
  CorpusPanelEvidence,
  CorpusPublicDocument,
  EvaluatorIsolationRecord,
  EvaluationRecord,
  EvaluatorOutput,
  ExecParams,
  ExecResult,
  DEFAULT_EVALUATOR_TIMEOUT_SEC,
  FinishParams,
  GetPromotionVerdictParams,
  GetFileParams,
  GetFileResult,
  QueryCorpusParams,
  QueryCorpusResult,
  GetTaskResult,
  PutFileParams,
  ReportIncumbentParams,
  SESSION_NO_YIELD_EXIT_CODE,
  SessionNoYieldRecord,
  SessionUsageAnomalyRecord,
  ReportSessionNoYieldBoundParams,
  PromotionVerdict,
  PromotionGateDecision,
  PromotionNoiseCalibration,
  PROMOTION_GATE_VERSION,
  HoldoutNullControlRecord,
  PromotionHoldoutRecord,
  PromotionHoldoutSplit,
  PromotionHoldoutSplitSummary,
  RecordHoldoutNullControlParams,
  RecordPromotionHoldoutParams,
  RecursiveTask,
  ResourceUsage,
  SandboxRef,
  SaveArtifactParams,
  SpawnRunParams,
  SpawnRunResult,
  RunEvent,
  type ArtifactRef,
  type RunDepth,
} from "@hone/schema";
import { HoldoutBudgetExceededError, HoldoutLedger } from "@hone/scoring";
import { MAX_ARTIFACT_BYTES, canonicalizeWorkspaceTar, diffProtectedPaths, dirSizeBytes, findProtectedPaths, unpackArtifact } from "./artifact.js";
import { CasStore, durability } from "./cas.js";
import { runCommand, type CmdResult, type RunCommand } from "./command.js";
import { deferred } from "./deferred.js";
import { acquireEvaluatorIsolation, type EvaluatorIsolationLease } from "./evaluator-isolation.js";
import { type UidClaimRecovery } from "./host-evaluator-gate.js";
import { campaign12PromotionNoiseCalibration } from "./promotion-noise-calibration.js";
import {
  assertPromotionHoldoutSplitIdentity,
  buildHoldoutNullControl,
  buildPromotionHoldoutRecord,
  promotionHoldoutSplitSummary,
} from "./promotion-holdout.js";

import { BrokerError } from "./errors.js";
import { RecursiveResourceLedger } from "./recursive.js";
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
  /** Optimizer-authored recursive allocation policy, schema-validated on the wire. */
  recursivePlan?: z.infer<typeof EvaluateParams>["recursivePlan"];
  /** Host-only recursive dispatch; every call still crosses the broker's trusted ledgers and admission gate. */
  spawnRun: (params: z.infer<typeof SpawnRunParams>) => Promise<z.infer<typeof SpawnRunResult>>;
}

export type TrustedEvaluationStrategy = (input: TrustedEvaluationStrategyInput) => Promise<EvaluationRecord>;

/** Mutation-sandbox network: fully isolated, or attached to a broker-managed internal network. */
export type SandboxNetworkMode = { mode: "none" } | { mode: "internal"; network: string };

export interface ChildRunLaunchInput {
  admission: z.infer<typeof ChildRunAdmission>;
  request: z.infer<typeof SpawnRunParams>;
  /** True when the durable reservation predates this broker call/boot. */
  replay: boolean;
}

export interface ChildRunLaunchOutcome {
  /** Trusted path to the child's newline-terminated event stream. */
  /** Trusted durable receipt binding launch/config/provenance to the reserved child. */
  launchReceiptPath: string;
  terminalEventPath: string;
  /** Trusted direct usage for this run; descendant usage is already charged to every ancestor by its own settlement. */
  usage: z.infer<typeof ResourceUsage>;
  /**
   * Commits trusted campaign-side settlement facts. The broker invokes this
   * only after the launch receipt and terminal stream bind successfully.
   */
  finalizeSettlement: () => void;
}

export interface TrustedChildAdmissionInput {
  parentRunId: string;
  parentDepth: RunDepth;
  request: z.infer<typeof SpawnRunParams>;
}

export type TrustedChildRunAdmission = (
  input: TrustedChildAdmissionInput,
) => z.infer<typeof ChildRunAdmission> | undefined;

export type ChildRunLauncher = (input: ChildRunLaunchInput) => Promise<ChildRunLaunchOutcome>;

export interface BrokerRecursiveConfig {
  depth: RunDepth;
  /** Root-first durable ancestor identities; its length must equal depth. */
  ancestors: readonly string[];
  /** Shared authority instance for the entire recursive run tree. */
  ledger: RecursiveResourceLedger;
  /**
   * Aggregate ancestor authority for this run and every recursive descendant.
   * The direct broker budget remains the capsule/run-config envelope.
   */
  resourceEnvelope?: z.infer<typeof BudgetEnvelope> | undefined;
  /** Development-only task description exposed to the mutable optimizer. */
  evaluationTask?: z.infer<typeof RecursiveTask> | undefined;
  /** Frozen trusted membership/provenance gate, evaluated before any reservation is written. */
  admitChildRun: TrustedChildRunAdmission;
  launchChildRun: ChildRunLauncher;
}

export const MAX_CORPUS_PAGE_BYTES = 1024 * 1024;
export const MAX_CORPUS_JOURNAL_BYTES = 256 * 1024 * 1024;

export interface BrokerCorpusConfig {
  provenance: {
    campaignConfigHash: string;
    developmentCapsuleIds: readonly string[];
    terminalCapsuleIds: readonly string[];
    terminalContentHashes: readonly string[];
    /** inputsDigest of the corpus-provenance.v1 artifact this config was minted from — run-time cohort fence material. */
    provenanceInputsDigest?: string | undefined;
  };
  /** Hash of canonical publicSnapshot.documents; verified at broker construction. */
  publicSnapshot: {
    hash: string;
    documents: readonly z.infer<typeof CorpusPublicDocument>[];
  };
  /** Development-panel evidence only. The wire schema has no terminal variant. */
  panelEvidence: readonly z.infer<typeof CorpusPanelEvidence>[];
  /** UTF-8 JSON response-page cap, enforced before journaling. Default/hard maximum 1 MiB. */
  maxPageBytes?: number | undefined;
  /** Exact broker-journal + public-event byte charge. Default 64 MiB; hard maximum 256 MiB. */
  maxJournalBytes?: number | undefined;
}

/** Canonical content address frozen into every corpus cursor and response. */
export function hashCorpusSnapshot(documents: readonly z.infer<typeof CorpusPublicDocument>[]): `sha256:${string}` {
  const ordered = documents
    .map((document) => CorpusPublicDocument.parse(document))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : left.contentHash < right.contentHash ? -1 : left.contentHash > right.contentHash ? 1 : 0,
    );
  return `sha256:${createHash("sha256").update(canonicalJson(ordered)).digest("hex")}`;
}

export function hashChildRunLaunchReceipt(
  receipt: Omit<z.infer<typeof ChildRunLaunchReceipt>, "receiptDigest">,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(receipt)).digest("hex")}`;
}

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
  /** Digest of the admitted manifest; never recomputed from an execution override. */
  admittedCapsuleDigest: string;
  /** Image actually executed by mutation/evaluator containers. */
  executionImage: string;
  /** Digest of the optimizer artifact driving this run ("sha256:<64 hex>") — also memo-key material. */
  optimizerDigest: string;
  /**
   * Trusted M1 replicate identity. Omitted for M0, preserving the exact
   * legacy memo key and `eval` cache namespace. This value is process config,
   * never a sandbox RPC or environment input.
   */
  measurementEpoch?: string | undefined;
  /**
   * Trusted, identity-bound promotion calibrations. Omit to use the built-in
   * dated campaign-12 artifact; unmatched identities remain uncalibrated.
   */
  promotionNoiseCalibrations?: readonly z.infer<typeof PromotionNoiseCalibration>[] | undefined;
  /**
   * Trusted frozen per-capsule promotion holdout. It is process configuration,
   * never returned by getTask or accepted from optimizer-authored config.
   */
  promotionHoldoutSplit?: z.infer<typeof PromotionHoldoutSplit> | undefined;
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
  /** Per-run dir: sockets, scratch, unpack cache, durable run state live here. */
  runDir: string;
  /** Trusted host Unix socket mounted at /run/hone/proxy.sock; defaults to runDir/proxy.sock. */
  proxySocketHostPath?: string | undefined;
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
  /** Durable run.started wall time, retained separately from active budget spend. */
  runStartedAtMs?: number | undefined;
  /** Start of this supervisor's active interval (run.started/run.resumed). */
  activeStartedAtMs?: number | undefined;
  /** Legacy/public-journal active total used only until this broker journal carries active checkpoints. */
  initialActiveWallClockSec?: number | undefined;
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
  /** Production recursive child authority. Omit to fail closed on spawnRun. */
  recursive?: BrokerRecursiveConfig | undefined;
  /** Frozen public snapshot plus development-only metered evidence. Omit to fail closed on queryCorpus. */
  corpus?: BrokerCorpusConfig | undefined;
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
  /** Checkpoint-v1 measurement epoch this sandbox is authorized to mutate. */
  epoch: string;
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
/** Content-addressed authority written durably before its matching archive is published. */
export const SCRATCH_SNAPSHOT_DIGEST_PREFIX = "scratch.tar.sha256.";
const SCRATCH_SNAPSHOT_AUTHORITY_FILE = "checksum-authority-v1";
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
/** Fixed identity and writable home shared by every mutation sandbox image. */
export const MUTATION_SANDBOX_USER = "1000:1000";
export const MUTATION_SANDBOX_HOME = "/home/hone";
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

const MEBIBYTE = 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
/** Fixed process/kernel headroom above the archive-backed restore working sets. */
const SCRATCH_RESTORE_FIXED_HEADROOM_BYTES = 64 * MEBIBYTE;
/**
 * A real tmpfs probe charged about 5.1 KiB per tiny-file inode to the keeper
 * cgroup. Round that measured cost up to 6 KiB so the restore envelope covers
 * inode/dentry metadata as well as payload pages.
 */
const SCRATCH_RESTORE_BYTES_PER_ARCHIVE_ENTRY = 6 * 1024;

/**
 * Docker charges the bind-mounted archive page cache, restored tmpfs payload
 * pages, and tmpfs inode/dentry metadata to the keeper cgroup. Reserve two
 * archive-sized working sets, 6 KiB per real tar entry, and 64 MiB for tar,
 * the shell, and kernel working memory, rounded up to Docker's MiB unit.
 */
export function scratchRestoreMemoryBytes(snapshotArchiveBytes: number, archiveEntries: number): number {
  if (!Number.isSafeInteger(snapshotArchiveBytes) || snapshotArchiveBytes < 0) {
    throw new BrokerError("INTERNAL", "scratch snapshot archive size must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(archiveEntries) || archiveEntries < 0 || archiveEntries > SCRATCH_INODE_LIMIT) {
    throw new BrokerError("INTERNAL", "scratch snapshot archive entry count is outside the trusted inode envelope");
  }
  const required =
    snapshotArchiveBytes * 2
    + archiveEntries * SCRATCH_RESTORE_BYTES_PER_ARCHIVE_ENTRY
    + SCRATCH_RESTORE_FIXED_HEADROOM_BYTES;
  if (!Number.isSafeInteger(required)) {
    throw new BrokerError("INTERNAL", "scratch snapshot restore memory exceeds the safe integer range");
  }
  return Math.ceil(required / MEBIBYTE) * MEBIBYTE;
}

function tarNumericField(field: Buffer, label: string): number {
  if ((field[0] ?? 0) & 0x80) {
    if ((field[0] ?? 0) & 0x40) {
      throw new BrokerError("INTERNAL", `scratch snapshot has a negative ${label}`);
    }
    let value = (field[0] ?? 0) & 0x3f;
    for (let i = 1; i < field.length; i += 1) {
      value = value * 256 + (field[i] ?? 0);
      if (!Number.isSafeInteger(value)) {
        throw new BrokerError("INTERNAL", `scratch snapshot ${label} exceeds the safe integer range`);
      }
    }
    return value;
  }
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new BrokerError("INTERNAL", `scratch snapshot has an invalid ${label}`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new BrokerError("INTERNAL", `scratch snapshot ${label} exceeds the safe integer range`);
  }
  return value;
}

async function inspectScratchSnapshotArchive(
  filePath: string,
): Promise<{ archiveBytes: number; archiveEntries: number }> {
  const file = await open(filePath, "r");
  try {
    const archiveBytes = (await file.stat()).size;
    if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 2 * TAR_BLOCK_BYTES) {
      throw new BrokerError("INTERNAL", "scratch snapshot archive is truncated");
    }
    let offset = 0;
    let archiveEntries = 0;
    let zeroBlocks = 0;
    while (offset < archiveBytes) {
      const header = Buffer.allocUnsafe(TAR_BLOCK_BYTES);
      let bytesRead = 0;
      while (bytesRead < header.length) {
        const read = await file.read(header, bytesRead, header.length - bytesRead, offset + bytesRead);
        if (read.bytesRead === 0) {
          throw new BrokerError("INTERNAL", "scratch snapshot archive is truncated");
        }
        bytesRead += read.bytesRead;
      }
      offset += TAR_BLOCK_BYTES;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        continue;
      }
      if (zeroBlocks >= 2) {
        throw new BrokerError("INTERNAL", "scratch snapshot archive has nonzero data after its end marker");
      }
      if (zeroBlocks !== 0) {
        throw new BrokerError("INTERNAL", "scratch snapshot archive has a partial end marker");
      }

      const storedChecksum = tarNumericField(header.subarray(148, 156), "header checksum");
      let actualChecksum = 0;
      for (let i = 0; i < header.length; i += 1) {
        actualChecksum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
      }
      if (storedChecksum !== actualChecksum) {
        throw new BrokerError("INTERNAL", "scratch snapshot archive header checksum mismatch");
      }

      const type = String.fromCharCode(header[156] ?? 0);
      if (!["x", "g", "L", "K"].includes(type)) {
        archiveEntries += 1;
        if (archiveEntries > SCRATCH_INODE_LIMIT) {
          throw new BrokerError("INTERNAL", "scratch snapshot archive exceeds the trusted inode envelope");
        }
      }
      const payloadBytes = tarNumericField(header.subarray(124, 136), "entry size");
      const paddedPayloadBytes = Math.ceil(payloadBytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
      if (!Number.isSafeInteger(paddedPayloadBytes) || offset + paddedPayloadBytes > archiveBytes) {
        throw new BrokerError("INTERNAL", "scratch snapshot archive is truncated");
      }
      offset += paddedPayloadBytes;
    }
    if (zeroBlocks >= 2) return { archiveBytes, archiveEntries };
    throw new BrokerError("INTERNAL", "scratch snapshot archive has no complete end marker");
  } finally {
    await file.close();
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * GNU tar's positional `--no-recursion --exclude=.` pair skips only the `./`
 * archive entry. That entry describes the source filesystem root, while the
 * destination root is a separately provisioned Docker tmpfs mount; it is not
 * scratch payload and its metadata is deliberately not replayed. Every inner
 * path keeps normal GNU extraction semantics and is checked by `--compare`.
 *
 * BusyBox tar has different exclude semantics and no `--compare`, so it
 * restores normally and makes a second streaming archive pass:
 * `--to-command` hashes each archived regular-file payload against the
 * corresponding restored path. The fresh volume cannot contain extras,
 * extraction remains responsible for directories/links and their metadata,
 * and any command/hash failure makes tar fail closed.
 */
export const SCRATCH_RESTORE_SCRIPT =
  "set -eu; " +
  "if tar --version 2>/dev/null | grep -q \"GNU tar\"; then " +
  "tar -x --no-recursion --exclude=. -f /snapshot/scratch.tar -C /scratch; " +
  "tar -d --no-recursion --exclude=. -f /snapshot/scratch.tar -C /scratch; " +
  "else " +
  "tar -xf /snapshot/scratch.tar -C /scratch; " +
  "tar -x -f /snapshot/scratch.tar --to-command " +
  "'set -eu; expected=$(sha256sum); actual=$(sha256sum \"/scratch/${TAR_FILENAME#./}\"); " +
  "[ \"${actual%% *}\" = \"${expected%% *}\" ] || { echo \"scratch content differs: $TAR_FILENAME\" >&2; exit 1; }' " +
  ">/dev/null; " +
  "fi";

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

const SCRATCH_SNAPSHOT_AUTHORITY_CONTENT = "scratch-snapshot-checksum-authority-v1\n";

async function writeChecksumAuthorityFile(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(filePath, "utf8")) !== content) {
      throw new BrokerError("INTERNAL", `scratch snapshot checksum authority is corrupt: ${path.basename(filePath)}`);
    }
  }
  await durability.syncFile(filePath);
}

async function publishScratchChecksumAuthority(snapshotDir: string, digest: string): Promise<string> {
  const markerName = `${SCRATCH_SNAPSHOT_DIGEST_PREFIX}${digest.slice("sha256:".length)}`;
  await writeChecksumAuthorityFile(path.join(snapshotDir, markerName), `${digest}\n`);
  await writeChecksumAuthorityFile(
    path.join(snapshotDir, SCRATCH_SNAPSHOT_AUTHORITY_FILE),
    SCRATCH_SNAPSHOT_AUTHORITY_CONTENT,
  );
  await durability.syncDir(snapshotDir);
  return markerName;
}

async function removeObsoleteScratchChecksumMarkers(snapshotDir: string, currentMarker: string): Promise<void> {
  let removed = false;
  for (const entry of await readdir(snapshotDir)) {
    if (entry.startsWith(SCRATCH_SNAPSHOT_DIGEST_PREFIX) && entry !== currentMarker) {
      await rm(path.join(snapshotDir, entry), { force: true });
      removed = true;
    }
  }
  if (removed) await durability.syncDir(snapshotDir);
}

/**
 * Publishes one completed attempt plus a content-addressed checksum authority.
 * The marker and version sentinel are fsynced before scratch.tar is renamed,
 * so any durable new archive always has a durable matching checksum. After
 * publication, obsolete markers are removed; stable state contains exactly
 * one marker and deletion of that marker cannot downgrade to legacy mode
 * while the separately durable sentinel remains.
 */
export async function finalizeScratchSnapshot(snapshotDir: string, attemptName: string): Promise<void> {
  if (path.basename(attemptName) !== attemptName || !attemptName.startsWith(SCRATCH_SNAPSHOT_TMP_PREFIX)) {
    throw new BrokerError("INTERNAL", `refusing to publish non-attempt snapshot output: ${attemptName}`);
  }
  const tmp = path.join(snapshotDir, attemptName);
  await durability.syncFile(tmp);
  const digest = await sha256File(tmp);
  const markerName = await publishScratchChecksumAuthority(snapshotDir, digest);
  await durability.rename(tmp, path.join(snapshotDir, SCRATCH_SNAPSHOT_FILE));
  await durability.syncDir(snapshotDir);
  await removeObsoleteScratchChecksumMarkers(snapshotDir, markerName);
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
type GetPromotionVerdictP = z.infer<typeof GetPromotionVerdictParams>;
type PromotionVerdictR = z.infer<typeof PromotionVerdict>;
type RecordHoldoutNullControlP = z.infer<typeof RecordHoldoutNullControlParams>;
type RecordPromotionHoldoutP = z.infer<typeof RecordPromotionHoldoutParams>;
type ReportSessionNoYieldBoundP = z.infer<typeof ReportSessionNoYieldBoundParams>;
type CompleteEpisodeP = z.infer<typeof CompleteEpisodeParams>;
type FinishP = z.infer<typeof FinishParams>;
type GetTaskR = z.infer<typeof GetTaskResult>;
type CorpusDocument = z.infer<typeof CorpusPublicDocument> | z.infer<typeof CorpusPanelEvidence>;
interface FrozenCorpusVersion {
  versionHash: `sha256:${string}`;
  documents: readonly CorpusDocument[];
}
interface FrozenCorpus {
  snapshotHash: `sha256:${string}`;
  campaignConfigHash: string;
  developmentCapsuleIds: ReadonlySet<string>;
  terminalCapsuleIds: ReadonlySet<string>;
  terminalContentHashes: ReadonlySet<string>;
  versions: Map<string, FrozenCorpusVersion>;
  latestVersionHash: `sha256:${string}`;
  maxPageBytes: number;
  maxJournalBytes: number;
}

function corpusVersion(
  snapshotHash: `sha256:${string}`,
  documentsInput: readonly CorpusDocument[],
): FrozenCorpusVersion {
  const documents = [...documentsInput].sort((left, right) =>
    left.id < right.id
      ? -1
      : left.id > right.id
        ? 1
        : left.source < right.source
          ? -1
          : left.source > right.source
            ? 1
            : left.contentHash < right.contentHash
              ? -1
              : left.contentHash > right.contentHash
                ? 1
                : 0,
  );
  const versionHash = `sha256:${createHash("sha256")
    .update(canonicalJson({ snapshotHash, documents }))
    .digest("hex")}` as const;
  return {
    versionHash,
    documents: Object.freeze(documents.map((document) => Object.freeze(document))),
  };
}

function validateCorpusProvenance(
  documents: readonly CorpusDocument[],
  policy: Pick<
    FrozenCorpus,
    "campaignConfigHash" | "developmentCapsuleIds" | "terminalCapsuleIds" | "terminalContentHashes"
  >,
): void {
  const documentIds = new Set<string>();
  for (const document of documents) {
    if (documentIds.has(document.id)) throw new BrokerError("INTERNAL", "duplicate corpus document identity");
    documentIds.add(document.id);
    const actualHash = `sha256:${createHash("sha256").update(document.content).digest("hex")}`;
    const normalizedIdentitySurface = `${document.id}\n${document.content}`.normalize("NFC");
    const terminalIdentityPresent = [...policy.terminalCapsuleIds].some((identity) =>
      normalizedIdentitySurface.includes(identity.normalize("NFC")),
    );
    const provenanceAllowed =
      document.provenance.campaignConfigHash === policy.campaignConfigHash &&
      (document.source === "public-snapshot" ||
        (policy.developmentCapsuleIds.has(document.provenance.capsuleId) &&
          !policy.terminalCapsuleIds.has(document.provenance.capsuleId)));
    if (
      actualHash !== document.contentHash ||
      policy.terminalContentHashes.has(document.contentHash) ||
      terminalIdentityPresent ||
      !provenanceAllowed
    ) {
      throw new BrokerError("INTERNAL", "corpus document violates frozen development provenance");
    }
  }
}
type RecordSpendP = z.infer<typeof RecordSpendParams>;
type SpawnRunP = z.infer<typeof SpawnRunParams>;
type SpawnRunR = z.infer<typeof SpawnRunResult>;
type QueryCorpusP = z.infer<typeof QueryCorpusParams>;
type QueryCorpusR = z.infer<typeof QueryCorpusResult>;

/**
 * Trusted-side event derivation (WP7 boundary ruling): the mutable optimizer
 * has NO event authority — every RunEvent about its activity is derived here
 * from the broker method calls it makes, with scores recomputed from the
 * broker's own EvaluationRecords (claimed metrics are never trusted).
 */
type EmittableEvent =
  | { type: "evaluator.queue.entered"; allocationId: string }
  | { type: "evaluator.queue.acquired"; allocationId: string; waitMs: number }
  | { type: "evaluator.isolation"; isolation: z.infer<typeof EvaluatorIsolationRecord> }
  | {
      type: "evaluator.isolation.quarantined";
      isolation: z.infer<typeof EvaluatorIsolationRecord>;
      evaluatorContainer: string;
      cleanupError: string;
    }
  | {
      type: "evaluator.isolation.released";
      isolation: z.infer<typeof EvaluatorIsolationRecord>;
      evaluatorContainer: string;
    }
  | { type: "budget.exhausted"; dimension: string }
  | { type: "holdout.accessed"; capsuleId: string; ledgerCount: number; ledgerBudget: number }
  | { type: "holdout.split.frozen"; split: z.infer<typeof PromotionHoldoutSplitSummary> }
  | {
      type: "holdout.eval.completed";
      splitId: string;
      artifact: ArtifactRef;
      assetGroupId: string;
      seed: number;
      aggregate: number | null;
      cached: boolean;
    }
  | { type: "holdout.null-control.completed"; control: z.infer<typeof HoldoutNullControlRecord> }
  | { type: "promotion.holdout.completed"; record: z.infer<typeof PromotionHoldoutRecord> }
  | { type: "episode.started"; episode: number; parent: ArtifactRef }
  | { type: "episode.completed"; episode: number }
  | { type: "episode.candidate"; episode: number; candidate: ArtifactRef; sessionTrace: string }
  | {
      type: "mutation.no-yield-bound";
      episode: number;
      sandboxId: string;
      limitTokens: number;
      modelCalls: number;
      promptTokens: number;
      completionTokens: number;
      consumedTokens: number;
    }
  | {
      type: "mutation.usage-anomaly";
      episode: number;
      sandboxId: string;
      zeroUsageTurns: number;
      normalizedUsageTurns: number;
    }
  | { type: "eval.completed"; episode?: number; artifact: ArtifactRef; assetGroupId: string; seed: number; aggregate: number | null; cached: boolean }
  | {
      type: "gate.paired";
      episode: number;
      parentScore: number;
      childScore: number;
      passed: boolean;
      gateVersion: typeof PROMOTION_GATE_VERSION;
      calibrationEvidenceVersion: string | null;
      delta: number;
      noiseFloor: number | null;
      noiseEnvelope: number | null;
      decision: z.infer<typeof PromotionGateDecision>;
    }
  | { type: "incumbent.new"; artifact: ArtifactRef; aggregate: number; deltaVsBaseline: number; episode: number }
  | { type: "corpus.query"; request: QueryCorpusP }
  | { type: "corpus.response"; response: QueryCorpusR }
  | { type: "budget.snapshot"; budget: BudgetState };

interface PublicationGroup {
  readonly events: RunEvent[];
  ready: boolean;
  nextEvent: number;
}
const BROKER_EVENT_TYPES = new Set<RunEvent["type"]>([
  "holdout.accessed",
  "holdout.split.frozen",
  "holdout.eval.completed",
  "holdout.null-control.completed",
  "promotion.holdout.completed",
  "evaluator.queue.entered",
  "evaluator.queue.acquired",
  "evaluator.isolation",
  "episode.started",
  "mutation.no-yield-bound",
  "mutation.usage-anomaly",
  "episode.completed",
  "episode.candidate",
  "eval.completed",
  "gate.paired",
  "incumbent.new",
  "corpus.query",
  "corpus.response",
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
const LegacyGateFact = z.object({
  parent: z.string(),
  parentScore: z.number(),
  childScore: z.number(),
  passed: z.boolean(),
}).strict();
const PreviousCalibratedGateFact = z.object({
  parent: z.string(),
  parentScore: z.number(),
  childScore: z.number(),
  passed: z.boolean(),
  gateVersion: z.literal("noise-envelope-v1"),
  calibrationEvidenceVersion: z.string().nullable(),
  delta: z.number(),
  noiseEnvelope: z.number().nonnegative().nullable(),
  decision: z.enum(["promote", "refuse-no-improvement", "refuse-within-noise", "refuse-uncalibrated"]),
}).strict();
const PreviousV2GateFact = z.object({
  parent: z.string(),
  parentScore: z.number(),
  childScore: z.number(),
  passed: z.boolean(),
  gateVersion: z.literal("noise-envelope-v2"),
  calibrationEvidenceVersion: z.string().nullable(),
  delta: z.number(),
  noiseFloor: z.number().nonnegative().nullable(),
  noiseEnvelope: z.number().nonnegative().nullable(),
  decision: z.enum([
    "promote",
    "refuse-no-improvement",
    "refuse-within-noise",
    "refuse-indeterminate",
    "refuse-uncalibrated",
  ]),
}).strict();
const CalibratedGateFact = z.object({
  parent: z.string(),
  parentScore: z.number(),
  childScore: z.number(),
  passed: z.boolean(),
  gateVersion: z.literal(PROMOTION_GATE_VERSION),
  calibrationEvidenceVersion: z.string().nullable(),
  delta: z.number(),
  noiseFloor: z.number().nonnegative().nullable(),
  noiseEnvelope: z.number().nonnegative().nullable(),
  decision: PromotionGateDecision,
}).strict();
const GateFact = z.union([
  CalibratedGateFact,
  PreviousV2GateFact,
  PreviousCalibratedGateFact,
  LegacyGateFact,
]);
type GateFact = z.infer<typeof GateFact>;

const StatePayload = z.discriminatedUnion("t", [
  z.object({ t: z.literal("start"), atMs: z.number(), events: JournalEvents }),
  z.object({ t: z.literal("clock"), activeMs: z.number().finite().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("spend"), tokens: z.number().int().nonnegative(), usd: z.number().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("inv"), isolation: EvaluatorIsolationRecord.optional(), events: JournalEvents }),
  z.object({ t: z.literal("holdout"), seq: z.number().int().positive(), events: JournalEvents }),
  z.object({ t: z.literal("holdoutSplit"), split: PromotionHoldoutSplitSummary, events: JournalEvents }),
  z.object({
    t: z.literal("holdoutEval"),
    splitId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    record: EvaluationRecord,
    events: JournalEvents,
  }),
  z.object({ t: z.literal("holdoutNullControl"), control: HoldoutNullControlRecord, events: JournalEvents }),
  z.object({ t: z.literal("promotionHoldout"), record: PromotionHoldoutRecord, events: JournalEvents }),
  z.object({
    t: z.literal("eval"),
    record: EvaluationRecord,
    /** Measurement generation (`${bootNonce}:{startup|ep<N>}`); legacy lines lack it and grant no gate authority. */
    /** Full evaluator memo identity, including recursive plan when present. */
    memoKey: z.string().optional(),
    epoch: z.string().optional(),
    /** Trusted M1 replicate identity; absent on M0 and legacy journal facts. */
    measurementEpoch: z.string().optional(),
    /** Monotone trusted mint ordinal of `epoch` (see mintEpochSeq); pre-ordinal lines rank by first appearance in the journal. */
    epochSeq: z.number().int().nonnegative().optional(),
    /** Persisted parent-first same-epoch gate identity (see recordEvaluation). */
    gate: GateFact.optional(),
    events: JournalEvents,
  }),
  z.object({
    t: z.literal("episode"),
    episode: z.number().int().nonnegative(),
    /** Present on checkpoint-v1 facts; legacy episode lines remain replayable. */
    parent: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    epoch: z.string().min(1).optional(),
    events: JournalEvents,
  }),
  z.object({ t: z.literal("episodeComplete"), episode: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("lineage"), candidate: z.string(), parent: z.string(), episode: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({ t: z.literal("repair"), hash: z.string(), parent: z.string(), episode: z.number().int().nonnegative(), events: JournalEvents }),
  z.object({
    t: z.literal("continuation"),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    parent: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    episode: z.number().int().nonnegative(),
    events: JournalEvents,
  }),
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
  z.object({
    t: z.literal("corpusVersion"),
    previousVersionHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    versionHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    added: z.array(CorpusPanelEvidence).min(1),
    chargedBytes: z.number().int().positive(),
    events: JournalEvents,
  }),
  z.object({
    t: z.literal("corpus"),
    request: QueryCorpusParams,
    response: QueryCorpusResult,
    chargedBytes: z.number().int().positive(),
    events: JournalEvents,
  }),
  z.object({
    t: z.literal("uidClaimBlocked"),
    claimPath: z.string().min(1).max(4096),
    workerUid: z.number().int(),
    ownerAllocationId: z.string().regex(/^[0-9a-f]{32}$/),
    evaluatorContainer: z.string().min(1),
    events: JournalEvents,
  }),
  z.object({
    t: z.literal("uidClaimTakeover"),
    claimPath: z.string().min(1).max(4096),
    workerUid: z.number().int(),
    ownerAllocationId: z.string().regex(/^[0-9a-f]{32}$/),
    evaluatorContainer: z.string().min(1),
    newAllocationId: z.string().regex(/^[0-9a-f]{32}$/),
    newEvaluatorContainer: z.string().min(1),
    events: JournalEvents,
  }),
  z.object({ t: z.literal("migration"), events: z.array(RunEvent) }),
  z.object({ t: z.literal("event"), event: RunEvent }),
]);
const StateLine = StatePayload.and(z.object({
  /** Cumulative active milliseconds through this acknowledged fact; absent only on legacy records. */
  activeMs: z.number().finite().nonnegative().optional(),
}));
type StatePayload = z.infer<typeof StatePayload>;
type StateLine = z.infer<typeof StateLine>;
type StateFact = Exclude<StatePayload, { t: "event" | "migration" | "clock" }>;

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

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Sandbox broker (review IV.1): the optimizer is an unprivileged CLIENT; all
 * containers are SIBLINGS spawned by this trusted daemon via the docker CLI.
 * No global state — everything hangs off the config so the runner (WP7) can
 * compose several brokers in one process.
 */
export class Broker {
  readonly manifest: CapsuleManifest;
  readonly runtimeIdentity: z.infer<typeof CapsuleRuntimeIdentity>;
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
  private readonly promotionNoiseCalibrations: ReadonlyMap<string, z.infer<typeof PromotionNoiseCalibration>>;
  private readonly promotionHoldoutSplit: z.infer<typeof PromotionHoldoutSplit> | undefined;
  /** M0 remains `eval`; M1 receives a disjoint hash-derived cache namespace. */
  private readonly evaluationCacheNamespace: string;
  private readonly evaluationStrategy: TrustedEvaluationStrategy | undefined;
  private readonly recursive: BrokerRecursiveConfig | undefined;
  private readonly corpus: FrozenCorpus | undefined;
  private corpusJournalBytes = 0;
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

  /** First run start (operator lifetime signal; includes pauses/offline gaps). */
  private startedAtMs: number;
  /** Durable active total before this broker boot's current interval. */
  private accumulatedActiveMs: number;
  /** Start of the current active interval; never inherited across broker boots. */
  private activeSinceMs: number;
  private activeClockPaused = false;
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
  /** Identical live/replayed child requests share one trusted recovery/launch operation. */
  private readonly inFlightChildRuns = new Map<string, Promise<SpawnRunR>>();
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
  /** Durable proof that a CAS hash was produced inside an episode, independent of immutable first lineage. */
  private readonly continuationEpisodes = new Map<string, Set<number>>();
  /** Durable episode boundaries and the one replayable incomplete checkpoint. */
  private readonly episodeCheckpoints = new Map<number, {
    parent: string | undefined;
    epoch: string | undefined;
    completed: boolean;
  }>();
  private resumingEpisode: { episode: number; parent: string; epoch: string; claimedSandboxId: string | null } | undefined;
  /** Full trusted records from the resumed episode, returned only for exact replay asks. */
  private readonly replayedEvaluations = new Map<string, EvaluationRecord>();
  private readonly journaledEvaluationMemoKeys = new Set<string>();
  /** Trusted-only scores; never inserted into optimizer-facing promotion tables. */
  private readonly promotionHoldoutScores = new Map<string, number | null>();
  private readonly holdoutNullControls = new Map<string, z.infer<typeof HoldoutNullControlRecord>>();
  private readonly promotionHoldoutRecords = new Map<string, z.infer<typeof PromotionHoldoutRecord>>();
  private holdoutSplitJournaled = false;
  /** Trusted current incumbent — promotion is monotone against this. */
  private currentIncumbent: IncumbentState | undefined;
  /** Full ordered promotion history (replayed + live) — crash-resume event recovery. */
  private readonly incumbentHistory: IncumbentState[] = [];
  /** Full ordered broker-authored event journal, replayed before optimizer resume. */
  private readonly journalEvents: RunEvent[] = [];
  /**
   * Journal-order publication fence. A synchronous onEvent side effect may
   * re-enter the broker (budget abort pauses the active clock); later facts
   * stay queued until every earlier transaction is ready and delivered.
   */
  private readonly publicationQueue: PublicationGroup[] = [];
  private readonly publicationGroupByEvents = new WeakMap<readonly RunEvent[], PublicationGroup>();
  private readonly deliveredPublicationGroups = new WeakSet<readonly RunEvent[]>();
  private publicationHead = 0;
  private publishingEvents = false;
  /** False only for pre-transaction journals; first reconciliation migrates them once. */
  private eventJournalFormat = false;
  private stateLog: RunStateLog | undefined;
  /** Set when /scratch is a quota-enforcing docker tmpfs volume (else host bind + polling quota). */
  private scratchVolumeName: string | undefined;
  /** Set once close() begins: no new operation is admitted. */
  private closing = false;
  /** Wakes evaluator requests queued behind another broker when close begins. */
  private readonly closeController = new AbortController();
  /** Async operations in flight. */
  private inFlightOps = 0;
  /** close() callers awaiting the in-flight operation count to reach zero. */
  private readonly opDrainWaiters: Array<() => void> = [];
  /** Every spawned Docker container stays here until removal is positively confirmed. */
  private readonly trackedContainers = new Set<string>();
  /**
   * A reserved uid cannot return to the pool while its evaluator container
   * might still exist. Failed removals retain the kernel lease here until a
   * later reaper/close sweep proves the named container gone.
   */
  private readonly quarantinedEvaluatorLeases = new Map<
    string,
    { lease: EvaluatorIsolationLease; isolation: z.infer<typeof EvaluatorIsolationRecord> }
  >();
  private readonly uidClaimRecovery: UidClaimRecovery = {
    onBlocked: (claim) => {
      this.journalFact({ t: "uidClaimBlocked", ...claim }, []);
    },
    proveContainerAbsent: async (claim) => {
      try {
        const removed = await this.run(["docker", "rm", "-f", "-v", claim.evaluatorContainer], { timeoutMs: 30_000 });
        return {
          absent: containerGone(removed),
          detail: stderrText(removed) || "Docker did not prove the claimed evaluator container absent",
        };
      } catch (error) {
        return { absent: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    onTakenOver: (claim) => {
      this.journalFact({ t: "uidClaimTakeover", ...claim }, []);
    },
  };

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
    this.runtimeIdentity = CapsuleRuntimeIdentity.parse({
      admittedCapsuleDigest: config.admittedCapsuleDigest,
      executionImage: config.executionImage,
    });
    assertAssetGroupIsolation(this.manifest);
    assertAssetPathsResolveSafely(this.manifest, config.capsuleRootDir);
    this.cas = new CasStore(config.casDir);
    this.run = config.runCommand ?? runCommand;
    this.now = config.now ?? Date.now;
    const constructedAtMs = this.now();
    const startedAtMs = config.runStartedAtMs ?? constructedAtMs;
    const activeSinceMs = config.activeStartedAtMs ?? constructedAtMs;
    const initialActiveWallClockSec = config.initialActiveWallClockSec ?? 0;
    if (
      !Number.isFinite(startedAtMs) ||
      !Number.isFinite(activeSinceMs) ||
      activeSinceMs > constructedAtMs ||
      !Number.isFinite(initialActiveWallClockSec) ||
      initialActiveWallClockSec < 0
    ) {
      throw new BrokerError("INTERNAL", "active clock inputs must be finite, nonnegative, and not start in the future");
    }
    this.startedAtMs = startedAtMs;
    this.activeSinceMs = activeSinceMs;
    this.accumulatedActiveMs = initialActiveWallClockSec * 1000;
    if (
      config.measurementEpoch !== undefined &&
      (config.measurementEpoch.length === 0 ||
        config.measurementEpoch.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(config.measurementEpoch))
    ) {
      throw new BrokerError("INTERNAL", "measurementEpoch must be 1-256 characters without control characters");
    }
    this.trustedMeasurementEpoch = config.measurementEpoch;
    if (config.promotionHoldoutSplit === undefined) {
      this.promotionHoldoutSplit = undefined;
    } else {
      const split = PromotionHoldoutSplit.parse(config.promotionHoldoutSplit);
      try {
        assertPromotionHoldoutSplitIdentity(split);
      } catch (error) {
        throw new BrokerError("INTERNAL", error instanceof Error ? error.message : String(error));
      }
      if (split.capsuleId !== this.manifest.id || split.capsuleDigest !== this.runtimeIdentity.admittedCapsuleDigest) {
        throw new BrokerError("INTERNAL", "holdout split does not match the frozen capsule identity");
      }
      const trainGroup = this.manifest.assetGroups.find((group) => group.id === split.train.assetGroupId);
      const holdoutGroup = this.manifest.assetGroups.find((group) => group.id === split.holdout.assetGroupId);
      if (trainGroup === undefined || trainGroup.visibility === "holdout") {
        throw new BrokerError("INTERNAL", "holdout split train group is not optimizer-visible");
      }
      if (holdoutGroup?.visibility !== "holdout") {
        throw new BrokerError("INTERNAL", "holdout split group is not visibility=holdout");
      }
      const fileCache = new Map<string, { bytes: Buffer; hash: string; parsed: unknown }>();
      const unitHash = (
        unit: z.infer<typeof PromotionHoldoutSplit>["train"]["units"][number],
      ): { containerHash: string; contentHash: string } => {
        let cached = fileCache.get(unit.path);
        if (cached === undefined) {
          try {
            const bytes = readFileSync(path.join(config.capsuleRootDir, unit.path));
            const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
            cached = {
              bytes,
              hash,
              parsed: unit.selector === "" ? undefined : JSON.parse(bytes.toString("utf8")),
            };
            fileCache.set(unit.path, cached);
          } catch {
            throw new BrokerError("INTERNAL", `holdout split unit ${unit.id} is not a readable materialized file`);
          }
        }
        if (unit.selector === "") return { containerHash: cached.hash, contentHash: cached.hash };
        let selected = cached.parsed;
        for (const encoded of unit.selector.slice(1).split("/")) {
          const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
          if (Array.isArray(selected)) {
            const index = Number(segment);
            if (!Number.isSafeInteger(index) || index < 0 || index >= selected.length) {
              throw new BrokerError("INTERNAL", `holdout split selector is missing for unit ${unit.id}`);
            }
            selected = selected[index];
          } else if (selected !== null && typeof selected === "object" && segment in selected) {
            selected = (selected as Record<string, unknown>)[segment];
          } else {
            throw new BrokerError("INTERNAL", `holdout split selector is missing for unit ${unit.id}`);
          }
        }
        return {
          containerHash: cached.hash,
          contentHash: `sha256:${createHash("sha256").update(canonicalJson(selected)).digest("hex")}`,
        };
      };
      const assertUnits = (
        units: ReadonlyArray<z.infer<typeof PromotionHoldoutSplit>["train"]["units"][number]>,
        group: NonNullable<typeof trainGroup>,
      ): void => {
        const roots = group.paths.map((entry) => path.posix.normalize(entry).replace(/\/+$/, ""));
        for (const unit of units) {
          const normalized = path.posix.normalize(unit.path);
          const covered = roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
          const actual = unitHash(unit);
          if (
            normalized !== unit.path
            || !covered
            || this.manifest.contentHashes[unit.path] !== unit.containerHash
            || actual.containerHash !== unit.containerHash
            || actual.contentHash !== unit.contentHash
          ) {
            throw new BrokerError(
              "INTERNAL",
              `holdout split unit ${unit.id} is not content-bound inside asset group ${group.id}`,
            );
          }
        }
      };
      assertUnits(split.train.units, trainGroup);
      assertUnits(split.holdout.units, holdoutGroup);
      this.promotionHoldoutSplit = split;
    }
    const configuredCalibrations = config.promotionNoiseCalibrations
      ?? this.manifest.assetGroups.flatMap((group) => {
        const calibration = campaign12PromotionNoiseCalibration({
          capsuleId: this.manifest.id,
          admittedCapsuleDigest: this.runtimeIdentity.admittedCapsuleDigest,
          executionImage: this.runtimeIdentity.executionImage,
          assetGroupId: group.id,
          measurementEpoch: config.measurementEpoch ?? null,
        });
        return calibration === null ? [] : [calibration];
      });
    const calibrations = new Map<string, z.infer<typeof PromotionNoiseCalibration>>();
    for (const input of configuredCalibrations) {
      const calibration = PromotionNoiseCalibration.parse(input);
      if (
        calibration.capsuleId !== this.manifest.id
        || calibration.admittedCapsuleDigest !== this.runtimeIdentity.admittedCapsuleDigest
        || calibration.executionImage !== this.runtimeIdentity.executionImage
        || calibration.measurementEpoch !== (config.measurementEpoch ?? null)
        || !this.manifest.assetGroups.some((group) => group.id === calibration.assetGroupId)
      ) {
        throw new BrokerError("INTERNAL", "promotion noise calibration does not match capsule, evaluator, asset group, or measurement epoch");
      }
      if (calibrations.has(calibration.assetGroupId)) {
        throw new BrokerError("INTERNAL", `duplicate promotion noise calibration for ${calibration.assetGroupId}`);
      }
      calibrations.set(calibration.assetGroupId, calibration);
    }
    this.promotionNoiseCalibrations = calibrations;
    this.evaluationCacheNamespace =
      config.measurementEpoch === undefined
        ? "eval"
        : `eval-${createHash("sha256").update(config.measurementEpoch).digest("hex")}`;
    this.evaluationStrategy = config.evaluationStrategy;
    if (config.recursive === undefined) {
      this.recursive = undefined;
    } else {
      const evaluationTask = config.recursive.evaluationTask === undefined
        ? undefined
        : RecursiveTask.parse(config.recursive.evaluationTask);
      if (evaluationTask !== undefined && evaluationTask.depth !== config.recursive.depth) {
        throw new BrokerError("INTERNAL", "recursive evaluation task depth does not match broker depth");
      }
      if (evaluationTask !== undefined && this.evaluationStrategy === undefined) {
        throw new BrokerError(
          "INTERNAL",
          "recursive search requires a trusted evaluation strategy; refusing the synthetic capsule evaluator",
        );
      }
      const resourceEnvelope = config.recursive.resourceEnvelope === undefined
        ? undefined
        : BudgetEnvelope.parse(config.recursive.resourceEnvelope);
      if (
        resourceEnvelope !== undefined
        && (
          this.manifest.budget.maxTokens > resourceEnvelope.maxTokens
          || this.manifest.budget.maxUsd > resourceEnvelope.maxUsd
          || this.manifest.budget.maxWallClockSec > resourceEnvelope.maxWallClockSec
          || this.manifest.budget.maxEvaluatorInvocations > resourceEnvelope.maxEvaluatorInvocations
        )
      ) {
        throw new BrokerError("INTERNAL", "recursive resource envelope cannot be smaller than the direct broker budget");
      }
      this.recursive = {
        ...config.recursive,
        ...(evaluationTask === undefined ? {} : { evaluationTask }),
        ...(resourceEnvelope === undefined ? {} : { resourceEnvelope }),
      };
    }
    if (this.recursive !== undefined) {
      this.recursive.ledger.registerRun(
        config.runId,
        this.recursive.depth,
        this.recursive.ancestors,
        this.recursive.resourceEnvelope ?? this.manifest.budget,
      );
    }

    if (config.corpus === undefined) {
      this.corpus = undefined;
    } else {
      const campaignConfigHash = config.corpus.provenance.campaignConfigHash;
      if (!/^sha256:[0-9a-f]{64}$/.test(campaignConfigHash)) {
        throw new BrokerError("INTERNAL", "corpus campaign config hash is invalid");
      }
      const developmentCapsuleIds = new Set(config.corpus.provenance.developmentCapsuleIds);
      const terminalCapsuleIds = new Set(config.corpus.provenance.terminalCapsuleIds);
      const terminalContentHashes = new Set(config.corpus.provenance.terminalContentHashes);
      if (
        developmentCapsuleIds.size !== config.corpus.provenance.developmentCapsuleIds.length ||
        terminalCapsuleIds.size !== config.corpus.provenance.terminalCapsuleIds.length ||
        terminalContentHashes.size !== config.corpus.provenance.terminalContentHashes.length ||
        [...developmentCapsuleIds].some((identity) => terminalCapsuleIds.has(identity)) ||
        [...terminalContentHashes].some((hash) => !/^sha256:[0-9a-f]{64}$/.test(hash)) ||
        (config.corpus.provenance.provenanceInputsDigest !== undefined &&
          !/^sha256:[0-9a-f]{64}$/.test(config.corpus.provenance.provenanceInputsDigest))
      ) {
        throw new BrokerError("INTERNAL", "corpus provenance policy is invalid");
      }
      const maxPageBytes = config.corpus.maxPageBytes ?? 1024 * 1024;
      const maxJournalBytes = config.corpus.maxJournalBytes ?? 64 * 1024 * 1024;
      if (
        !Number.isSafeInteger(maxPageBytes) ||
        maxPageBytes <= 0 ||
        maxPageBytes > MAX_CORPUS_PAGE_BYTES ||
        !Number.isSafeInteger(maxJournalBytes) ||
        maxJournalBytes <= 0 ||
        maxJournalBytes > MAX_CORPUS_JOURNAL_BYTES
      ) {
        throw new BrokerError("INTERNAL", "corpus byte caps exceed trusted hard limits");
      }
      const publicDocuments = config.corpus.publicSnapshot.documents.map((document) =>
        CorpusPublicDocument.parse(document),
      );
      const panelEvidence = config.corpus.panelEvidence.map((document) => CorpusPanelEvidence.parse(document));
      const provenancePolicy = {
        campaignConfigHash,
        developmentCapsuleIds,
        terminalCapsuleIds,
        terminalContentHashes,
      };
      validateCorpusProvenance([...publicDocuments, ...panelEvidence], provenancePolicy);
      const snapshotHash = hashCorpusSnapshot(publicDocuments);
      if (config.corpus.publicSnapshot.hash !== snapshotHash) {
        throw new BrokerError("INTERNAL", "public corpus snapshot hash does not match its canonical documents");
      }
      const initialVersion = corpusVersion(snapshotHash, [...publicDocuments, ...panelEvidence]);
      this.corpus = {
        snapshotHash,
        ...provenancePolicy,
        versions: new Map([[initialVersion.versionHash, initialVersion]]),
        latestVersionHash: initialVersion.versionHash,
        maxPageBytes,
        maxJournalBytes,
      };
    }
    this.safeRunId = config.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
    this.scratchDir = path.join(config.runDir, "scratch");
    this.proxySockPath = config.proxySocketHostPath ?? path.join(config.runDir, "proxy.sock");
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
    // Trusted campaign cap first, then the capsule's own (digest-bound)
    // declaration, then the engine default.
    this.evalTimeoutSec = config.evalTimeoutSec
      ?? this.manifest.evaluatorTimeoutSec
      ?? DEFAULT_EVALUATOR_TIMEOUT_SEC;
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
    if (this.promotionHoldoutSplit !== undefined) {
      if (terminalHoldoutAssetGroupIds.size > 0) {
        throw new BrokerError(
          "INTERNAL",
          "promotion holdout and terminal holdout capabilities are mutually exclusive on one capsule: "
          + "semantic re-encoding makes shared-capability leak detection undecidable",
        );
      }
      // Unreachable under mutual exclusion; retained as a content-aware safety
      // net if shared capabilities are ever deliberately reintroduced.
      assertPromotionHoldoutTerminalIsolation(
        this.manifest,
        config.capsuleRootDir,
        this.promotionHoldoutSplit,
        terminalHoldoutAssetGroupIds,
      );
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
    // Active/lifetime clocks were initialized from the supervisor's durable
    // run.started/run.resumed boundary before journal replay.
    // Durable state opens (and replays) synchronously at construction — a
    // broker NEVER exists without its journal, so no method can act before
    // replay and no acknowledged fact can be lost to ordering.
    mkdirSync(config.runDir, { recursive: true, mode: 0o700 });
    const stateLog = RunStateLog.open(path.join(config.runDir, STATE_FILE));
    try {
      this.validateReplay(stateLog);
      this.replayState(stateLog);
      if (this.promotionHoldoutSplit !== undefined && !this.holdoutSplitJournaled) {
        const summary = promotionHoldoutSplitSummary(this.promotionHoldoutSplit);
        const events = this.journalFact(
          { t: "holdoutSplit", split: summary },
          [{ type: "holdout.split.frozen", split: summary }],
        );
        try {
          this.holdoutSplitJournaled = true;
        } finally {
          this.publish(events);
        }
      }
      this.syncRecursiveUsage(true);
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
    const failures: string[] = [];
    try {
      this.pauseActiveTime();
    } catch (err) {
      failures.push(`active clock: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.closing = true;
    this.closeController.abort();
    clearInterval(this.reaper);
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

  /**
   * Active-time invariant: a boot starts a fresh interval at run.started or
   * run.resumed. Every acknowledged broker fact checkpoints the cumulative
   * level. A crash resumes from the final acknowledged fact, so neither the
   * process-down gap nor unacknowledged in-flight work is charged.
   */
  private activeWallClockMs(nowMs = this.now()): number {
    return this.accumulatedActiveMs +
      (this.activeClockPaused ? 0 : Math.max(0, nowMs - this.activeSinceMs));
  }

  private appendState(line: Exclude<StatePayload, { t: "clock" }>): void {
    this.state().append(StateLine.parse({ ...line, activeMs: this.activeWallClockMs() }));
  }

  /** Full semantic preflight: a corrupt journal changes no in-memory authority. */
  private validateReplay(log: RunStateLog): void {
    let holdoutSeq = 0;
    let traceBytes = 0;
    const traces = new Set<string>();
    let artifactBytes = 0;
    let artifactEntries = 0;
    const artifacts = new Set<string>();
    const replayCorpus =
      this.corpus === undefined
        ? undefined
        : {
            ...this.corpus,
            versions: new Map(this.corpus.versions),
          };
    let replayCorpusBytes = 0;
    let activeMs = -1;
    for (const line of log.replayed) {
      if (line.activeMs !== undefined) {
        if (line.activeMs < activeMs) {
          throw new BrokerError("INTERNAL", "run state log active clock decreased");
        }
        activeMs = line.activeMs;
      }
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
      } else if (line.t === "corpusVersion") {
        if (replayCorpus === undefined) {
          throw new BrokerError("INTERNAL", "run state log contains corpus versions but no frozen corpus is configured");
        }
        let next: FrozenCorpusVersion;
        try {
          next = this.deriveCorpusVersion(replayCorpus, line.previousVersionHash, line.added);
        } catch {
          throw new BrokerError("INTERNAL", "run state log corpus version violates the frozen provenance chain");
        }
        const exactCharge = Buffer.byteLength(`${JSON.stringify(line)}\n`, "utf8");
        if (
          next.versionHash !== line.versionHash ||
          (line.events?.length ?? 0) !== 0 ||
          line.chargedBytes !== exactCharge
        ) {
          throw new BrokerError("INTERNAL", "run state log corpus version charge or digest is inconsistent");
        }
        replayCorpus.versions.set(next.versionHash, next);
        replayCorpus.latestVersionHash = next.versionHash;
        replayCorpusBytes += line.chargedBytes;
        if (replayCorpusBytes > replayCorpus.maxJournalBytes) {
          throw new BrokerError("INTERNAL", "run state log exceeds the configured corpus journal byte budget");
        }
      } else if (line.t === "corpus") {
        if (replayCorpus === undefined) {
          throw new BrokerError("INTERNAL", "run state log contains corpus facts but no frozen corpus is configured");
        }
        let expected: QueryCorpusR;
        try {
          expected = this.corpusResponse(line.request, replayCorpus);
        } catch {
          throw new BrokerError("INTERNAL", "run state log corpus request does not address a retained corpus version");
        }
        const [queryEvent, responseEvent, ...extraEvents] = line.events ?? [];
        if (
          !sameCanonical(expected, line.response) ||
          queryEvent?.type !== "corpus.query" ||
          responseEvent?.type !== "corpus.response" ||
          extraEvents.length !== 0 ||
          queryEvent.runId !== this.config.runId ||
          responseEvent.runId !== this.config.runId ||
          queryEvent.at !== responseEvent.at ||
          !sameCanonical(queryEvent.request, line.request) ||
          !sameCanonical(responseEvent.response, line.response) ||
          line.chargedBytes !==
            Buffer.byteLength(`${JSON.stringify(line)}\n`, "utf8") +
              (line.events ?? []).reduce(
                (sum, event) => sum + Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8"),
                0,
              )
        ) {
          throw new BrokerError("INTERNAL", "run state log corpus query/response transaction is inconsistent");
        }
        replayCorpusBytes += line.chargedBytes;
        if (replayCorpusBytes > replayCorpus.maxJournalBytes) {
          throw new BrokerError("INTERNAL", "run state log exceeds the configured corpus journal byte budget");
        }
      }
    }
  }

  /** Replays the journal into in-memory authority/budget state. Never emits events. */
  private replayState(log: RunStateLog): void {
    this.stateLog = log;
    let firstStartMs: number | undefined;
    let replayedActiveMs: number | undefined;
    for (const line of log.replayed) {
      if (line.activeMs !== undefined) replayedActiveMs = line.activeMs;
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
        case "uidClaimBlocked":
        case "uidClaimTakeover":
          break;
        case "start":
          firstStartMs ??= line.atMs;
          break;
        case "clock":
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
        case "holdoutSplit":
          if (
            this.holdoutSplitJournaled
            || this.promotionHoldoutSplit === undefined
            || !sameCanonical(line.split, promotionHoldoutSplitSummary(this.promotionHoldoutSplit))
          ) {
            throw new BrokerError("INTERNAL", "run state log holdout split does not match trusted configuration");
          }
          this.holdoutSplitJournaled = true;
          break;
        case "holdoutEval": {
          if (this.promotionHoldoutSplit?.splitId !== line.splitId) {
            throw new BrokerError("INTERNAL", "run state log holdout evaluation has no matching frozen split");
          }
          const aggregate = eligibleAggregate(line.record) ?? null;
          const key = canonicalJson([
            line.record.artifactHash,
            line.record.assetGroupId,
            line.record.seed,
          ]);
          if (this.promotionHoldoutScores.has(key)) {
            throw new BrokerError("INTERNAL", "run state log contains a duplicate promotion holdout coordinate");
          }
          this.promotionHoldoutScores.set(key, aggregate);
          break;
        }
        case "holdoutNullControl":
          if (
            this.promotionHoldoutSplit?.splitId !== line.control.splitId
            || this.holdoutNullControls.has(line.control.controlId)
          ) {
            throw new BrokerError("INTERNAL", "run state log contains an invalid holdout null control");
          }
          this.holdoutNullControls.set(line.control.controlId, line.control);
          break;
        case "promotionHoldout":
          if (
            this.promotionHoldoutSplit?.splitId !== line.record.splitId
            || this.promotionHoldoutRecords.has(line.record.artifactHash)
          ) {
            throw new BrokerError("INTERNAL", "run state log contains an invalid promotion holdout record");
          }
          this.promotionHoldoutRecords.set(line.record.artifactHash, line.record);
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
          if (line.epoch !== undefined) {
            const legacyKey =
              `${line.epoch}|${line.record.artifactHash}|` +
              `${line.record.assetGroupId}|${line.record.seed}`;
            this.replayedEvaluations.set(line.memoKey ?? legacyKey, line.record);
            if (line.memoKey !== undefined) this.journaledEvaluationMemoKeys.add(line.memoKey);
          }
          break;
        case "episode":
          if (this.episodeCheckpoints.has(line.episode)) {
            throw new BrokerError("INTERNAL", `run state log corrupt: duplicate episode ${line.episode}`);
          }
          this.episodeCheckpoints.set(line.episode, {
            parent: line.parent,
            epoch: line.epoch,
            completed: false,
          });
          this.episodeOrdinal = Math.max(this.episodeOrdinal, line.episode + 1);
          this.anyEpisodeStarted = true;
          break;
        case "episodeComplete": {
          const checkpoint = this.episodeCheckpoints.get(line.episode);
          if (checkpoint === undefined || checkpoint.completed) {
            throw new BrokerError("INTERNAL", `run state log corrupt: invalid episode completion ${line.episode}`);
          }
          checkpoint.completed = true;
          break;
        }
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
          this.bindContinuationArtifact(line.candidate, line.episode);
          // Graduation: once a hash has candidate lineage it is never a
          // repair snapshot again — the lineage line is the tombstone.
          this.repairs.delete(line.candidate);
          break;
        }
        case "repair":
          this.repairs.set(line.hash, { parent: line.parent, episode: line.episode });
          this.bindContinuationArtifact(line.hash, line.episode);
          break;
        case "continuation": {
          const checkpoint = this.episodeCheckpoints.get(line.episode);
          if (
            checkpoint === undefined
            || checkpoint.completed
            || checkpoint.parent !== line.parent
          ) {
            throw new BrokerError(
              "INTERNAL",
              `run state log corrupt: continuation ${line.hash} does not match active episode ${line.episode}`,
            );
          }
          this.bindContinuationArtifact(line.hash, line.episode);
          break;
        }
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
        case "corpusVersion": {
          const corpus = this.corpus;
          if (corpus === undefined) throw new BrokerError("INTERNAL", "corpus version replay has no corpus configuration");
          const next = this.deriveCorpusVersion(corpus, line.previousVersionHash, line.added);
          corpus.versions.set(next.versionHash, next);
          corpus.latestVersionHash = next.versionHash;
          this.corpusJournalBytes += line.chargedBytes;
          break;
        }
        case "corpus":
          this.corpusJournalBytes += line.chargedBytes;
          break;
        case "incumbent": {
          const inc = { hash: line.hash, aggregate: line.aggregate, deltaVsBaseline: line.deltaVsBaseline, episode: line.episode };
          this.incumbentHistory.push(inc);
          this.currentIncumbent = inc;
          break;
        }
      }
    }
    if (replayedActiveMs !== undefined) this.accumulatedActiveMs = replayedActiveMs;
    const resumable = [...this.episodeCheckpoints.entries()].filter(
      (entry): entry is [number, { parent: string; epoch: string; completed: false }] =>
        !entry[1].completed && entry[1].parent !== undefined && entry[1].epoch !== undefined,
    );
    if (resumable.length > 1) {
      throw new BrokerError("INTERNAL", "run state log holds multiple incomplete checkpoint-v1 episodes");
    }
    const pending = resumable[0];
    if (pending !== undefined) {
      this.resumingEpisode = {
        episode: pending[0],
        parent: pending[1].parent,
        epoch: pending[1].epoch,
        claimedSandboxId: null,
      };
    }
    // The FIRST start remains the lifetime origin. Active spend instead
    // resumes from the final durable checkpoint and begins a fresh interval
    // at this process's run.resumed boundary; process-down time is excluded.
    if (firstStartMs === undefined) {
      this.appendState({ t: "start", atMs: this.startedAtMs });
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
    this.appendState({ t: "artifact", hash, bytes, entries });
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
      this.appendState({ t: "trace", hash, bytes: bytes.length });
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
    this.appendState({ ...fact, events: full });
    this.eventJournalFormat = true;
    this.journalEvents.push(...full);
    for (const event of full) {
      if (event.type === "budget.exhausted") this.exhaustedAnnounced.add(event.dimension);
    }
    this.stagePublication(full);
    return full;
  }
  /**
   * Stages one exact array identity; publish() must receive this same object.
   * Register before queueing so a registration failure cannot wedge the head.
   */
  private stagePublication(events: RunEvent[]): void {
    if (events.length === 0) return;
    const group: PublicationGroup = { events, ready: false, nextEvent: 0 };
    this.publicationGroupByEvents.set(events, group);
    try {
      this.publicationQueue.push(group);
    } catch (error) {
      this.publicationGroupByEvents.delete(events);
      throw error;
    }
  }

  /** Marks a staged group ready; safe to repeat after complete delivery. */
  private publish(events: readonly RunEvent[]): void {
    if (events.length === 0 || this.deliveredPublicationGroups.has(events)) return;
    const group = this.publicationGroupByEvents.get(events);
    if (group === undefined) {
      throw new BrokerError("INTERNAL", "broker event publication group is unknown");
    }
    group.ready = true;
    this.flushPublications();
  }

  private flushPublications(): void {
    if (this.publishingEvents) return;
    this.publishingEvents = true;
    try {
      while (this.publicationHead < this.publicationQueue.length) {
        const group = this.publicationQueue[this.publicationHead];
        if (group === undefined || !group.ready) break;
        while (group.nextEvent < group.events.length) {
          const event = group.events[group.nextEvent];
          if (event === undefined) {
            throw new BrokerError("INTERNAL", "broker event publication group is sparse");
          }
          this.config.onEvent(event);
          group.nextEvent += 1;
        }
        this.deliveredPublicationGroups.add(group.events);
        this.publicationGroupByEvents.delete(group.events);
        this.publicationHead += 1;
      }
      if (this.publicationHead === this.publicationQueue.length) {
        this.publicationQueue.length = 0;
        this.publicationHead = 0;
      }
    } finally {
      this.publishingEvents = false;
    }
  }

  private emit(event: EmittableEvent): void {
    // A fully closed broker (journal gone) has no event authority left.
    if (this.stateLog === undefined) return;
    const full = RunEvent.parse({
      runId: this.config.runId,
      at: new Date(this.now()).toISOString(),
      ...event,
    });
    this.appendState({ t: "event", event: full });
    this.eventJournalFormat = true;
    this.journalEvents.push(full);
    if (full.type === "budget.exhausted") this.exhaustedAnnounced.add(full.dimension);
    const events = [full];
    this.stagePublication(events);
    this.publish(events);
  }

  private directUsageNow(nowMs = this.now()): z.infer<typeof ResourceUsage> {
    return {
      tokens: this.spent.tokens,
      usd: this.spent.usd,
      wallClockSec: this.activeWallClockMs(nowMs) / 1000,
      evaluatorInvocations: this.spent.evaluatorInvocations,
    };
  }

  private syncRecursiveUsage(allowDurableWallClockFloor = false): void {
    if (this.recursive === undefined) return;
    const nowMs = this.now();
    let activeMs = this.activeWallClockMs(nowMs);
    let usage = this.directUsageNow(nowMs);
    const durableUsage = this.recursive.ledger.budgetState(this.config.runId).directUsage;
    if (allowDurableWallClockFloor && usage.wallClockSec < durableUsage.wallClockSec) {
      // Pre-active-clock ledgers recorded broker lifetime here. A crash under
      // the first active-clock implementation could also durably advance this
      // ledger immediately before its broker-state checkpoint. Neither case
      // is corruption: retain the already-charged value as a conservative
      // migration floor, then accrue active time only from this boot onward.
      this.accumulatedActiveMs += (durableUsage.wallClockSec - usage.wallClockSec) * 1000;
      activeMs = this.activeWallClockMs(nowMs);
      usage = this.directUsageNow(nowMs);
    }
    // Cross-file write ordering is the crash contract: broker active time is
    // durable before the recursive ledger may advance to the same value. A
    // crash can therefore leave broker state ahead (which sync repairs), but
    // can never leave a new recursive usage fact ahead of broker authority.
    this.state().append(StateLine.parse({ t: "clock", activeMs }));
    this.recursive.ledger.syncRunUsage(this.config.runId, usage);
  }

  private budgetStateNow(tokensDelta = 0, usdDelta = 0, evaluatorInvocationDelta = 0): BudgetState {
    const nowMs = this.now();
    const envelope = this.manifest.budget;
    if (this.recursive === undefined || this.recursive.resourceEnvelope !== undefined) {
      return BudgetState.parse({
        envelope,
        spent: {
          tokens: this.spent.tokens + tokensDelta,
          usd: this.spent.usd + usdDelta,
          wallClockSec: this.activeWallClockMs(nowMs) / 1000,
          evaluatorInvocations: this.spent.evaluatorInvocations + evaluatorInvocationDelta,
        },
        lifetimeSec: Math.max(0, (nowMs - this.startedAtMs) / 1000),
      });
    }

    const recursiveState = this.recursive.ledger.budgetState(this.config.runId);
    const current = this.directUsageNow(nowMs);
    return BudgetState.parse({
      envelope,
      spent: {
        tokens:
          envelope.maxTokens -
          recursiveState.remaining.maxTokens +
          (current.tokens - recursiveState.directUsage.tokens) +
          tokensDelta,
        usd:
          envelope.maxUsd -
          recursiveState.remaining.maxUsd +
          (current.usd - recursiveState.directUsage.usd) +
          usdDelta,
        wallClockSec:
          envelope.maxWallClockSec -
          recursiveState.remaining.maxWallClockSec +
          (current.wallClockSec - recursiveState.directUsage.wallClockSec),
        evaluatorInvocations:
          envelope.maxEvaluatorInvocations -
          recursiveState.remaining.maxEvaluatorInvocations +
          (current.evaluatorInvocations - recursiveState.directUsage.evaluatorInvocations) +
          evaluatorInvocationDelta,
      },
      lifetimeSec: Math.max(0, (nowMs - this.startedAtMs) / 1000),
    });
  }

  private exhaustedDimension(tokensDelta = 0, usdDelta = 0, evaluatorInvocationDelta = 0): BudgetDimension | undefined {
    const budget = this.budgetStateNow(tokensDelta, usdDelta, evaluatorInvocationDelta);
    if (budget.spent.tokens >= budget.envelope.maxTokens) return "tokens";
    if (budget.spent.usd >= budget.envelope.maxUsd) return "usd";
    if (budget.spent.wallClockSec >= budget.envelope.maxWallClockSec) return "wallClockSec";
    if (budget.spent.evaluatorInvocations >= budget.envelope.maxEvaluatorInvocations) return "evaluatorInvocations";
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
    this.syncRecursiveUsage();
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
      this.deleteProvenGoneSandbox(sandboxId);
      throw new BrokerError("SANDBOX_NOT_FOUND", `sandbox expired: ${sandboxId}`);
    }
    return entry;
  }

  private async removeTrackedContainer(ref: string): Promise<CmdResult> {
    const res = await this.run(["docker", "rm", "-f", "-v", ref], { timeoutMs: 30_000 });
    if (containerGone(res)) {
      this.trackedContainers.delete(ref);
      const quarantined = this.quarantinedEvaluatorLeases.get(ref);
      if (quarantined !== undefined) {
        await quarantined.lease.release();
        this.quarantinedEvaluatorLeases.delete(ref);
        this.emit({
          type: "evaluator.isolation.released",
          isolation: quarantined.isolation,
          evaluatorContainer: ref,
        });
      }
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
              if (containerGone(removed)) this.deleteProvenGoneSandbox(id);
            } catch {
              // Keep the expired entry tracked: close() retries and fails terminal
              // cleanup if Docker still cannot remove it.
            }
          }),
        );
      }
      for (const ref of this.quarantinedEvaluatorLeases.keys()) {
        try {
          await this.removeTrackedContainer(ref);
        } catch {
          // The durable quarantine and kernel lease stay live. A later reaper,
          // close sweep, or operator action must prove the container gone.
        }
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
    let restoreArchive = { archiveBytes: 0, archiveEntries: 0 };
    try {
      restoreArchive = await inspectScratchSnapshotArchive(this.scratchSnapshotPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const keeperMemoryBytes = scratchRestoreMemoryBytes(
      restoreArchive.archiveBytes,
      restoreArchive.archiveEntries,
    );
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
        "--memory", String(keeperMemoryBytes),
        "--memory-swap", String(keeperMemoryBytes),
        "--cpus", "0.1",
        "--log-driver", "none",
        "-v", `${name}:/scratch`,
        "-v", `${this.scratchSnapshotDir}:/snapshot`,
        this.runtimeIdentity.executionImage,
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await lstat(path.join(this.scratchSnapshotDir, SCRATCH_SNAPSHOT_AUTHORITY_FILE));
      } catch (authorityError) {
        if ((authorityError as NodeJS.ErrnoException).code === "ENOENT") return;
        throw authorityError;
      }
      throw new BrokerError(
        "INTERNAL",
        "scratch snapshot archive is missing while checksum authority sentinel exists",
      );
    }
    const expectedArchiveHash = await sha256File(this.scratchSnapshotPath);
    const markerName = `${SCRATCH_SNAPSHOT_DIGEST_PREFIX}${expectedArchiveHash.slice("sha256:".length)}`;
    const entries = await readdir(this.scratchSnapshotDir);
    const markerNames = entries.filter((entry) => entry.startsWith(SCRATCH_SNAPSHOT_DIGEST_PREFIX));
    if (markerNames.some((entry) => !/^scratch\.tar\.sha256\.[0-9a-f]{64}$/.test(entry))) {
      throw new BrokerError("INTERNAL", "scratch snapshot checksum marker set is malformed");
    }
    let checksumAuthorityRequired = false;
    try {
      const authority = await readFile(path.join(this.scratchSnapshotDir, SCRATCH_SNAPSHOT_AUTHORITY_FILE), "utf8");
      if (authority !== SCRATCH_SNAPSHOT_AUTHORITY_CONTENT) {
        throw new BrokerError("INTERNAL", "scratch snapshot checksum authority sentinel is corrupt");
      }
      checksumAuthorityRequired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (checksumAuthorityRequired || markerNames.length > 0) {
      if (!markerNames.includes(markerName)) {
        throw new BrokerError(
          "INTERNAL",
          `scratch snapshot checksum mismatch: ${expectedArchiveHash} has no published checksum authority`,
        );
      }
      const marker = await readFile(path.join(this.scratchSnapshotDir, markerName), "utf8");
      if (marker !== `${expectedArchiveHash}\n`) {
        throw new BrokerError("INTERNAL", `scratch snapshot checksum marker is corrupt: ${markerName}`);
      }
    }
    const restored = await this.run(
      [
        "docker", "exec", "-u", "root",
        this.scratchKeeperName, "/bin/sh", "-c", SCRATCH_RESTORE_SCRIPT,
      ],
      { timeoutMs: 300_000 },
    );
    if (restored.exitCode !== 0 || restored.timedOut) {
      throw new BrokerError("INTERNAL", `scratch snapshot restore or content verification failed: ${stderrText(restored)}`);
    }
    const actualArchiveHash = await sha256File(this.scratchSnapshotPath);
    if (actualArchiveHash !== expectedArchiveHash) {
      throw new BrokerError(
        "INTERNAL",
        `scratch snapshot checksum changed during restore: expected ${expectedArchiveHash}, got ${actualArchiveHash}`,
      );
    }
    const publishedMarker = await publishScratchChecksumAuthority(this.scratchSnapshotDir, expectedArchiveHash);
    await removeObsoleteScratchChecksumMarkers(this.scratchSnapshotDir, publishedMarker);
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
      this.deleteProvenGoneSandbox(sandboxId);
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
    if (containerGone(retired)) this.deleteProvenGoneSandbox(sandboxId);
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
      promotionGateCalibrations: [...this.promotionNoiseCalibrations.values()],
      ...(this.recursive?.evaluationTask === undefined
        ? {}
        : { recursiveTask: this.recursive.evaluationTask }),
    };
  }

  private bindContinuationArtifact(hash: string, episode: number): void {
    const episodes = this.continuationEpisodes.get(hash) ?? new Set<number>();
    episodes.add(episode);
    this.continuationEpisodes.set(hash, episodes);
  }


  /**
   * A caller can lose the response after a resumed parent claim succeeded.
   * Only the one in-memory sandbox registered for the same episode, parent,
   * and checkpoint epoch is safe to return; any claimed-but-unmatched state
   * remains a hard refusal rather than guessing at a sandbox.
   */
  private replayedResumeClaim(params: CreateSandboxP): SandboxRef | undefined {
    const resumed = this.resumingEpisode;
    if (
      resumed === undefined
      || params.continueEpisode !== resumed.episode
      || params.artifact.hash !== resumed.parent
      || resumed.claimedSandboxId === null
    ) {
      return undefined;
    }
    const sandbox = this.sandboxes.get(resumed.claimedSandboxId);
    if (
      sandbox === undefined
      || sandbox.episode !== resumed.episode
      || sandbox.parentHash !== resumed.parent
      || sandbox.epoch !== resumed.epoch
    ) {
      throw new BrokerError(
        "INTERNAL",
        `resumed episode ${resumed.episode} claim has no unique registered sandbox`,
      );
    }
    return { sandboxId: resumed.claimedSandboxId };
  }

  /**
   * Forget a sandbox only after its caller proved the container is gone.
   * The resumed-parent claim names one exact in-memory sandbox; clearing it
   * requires the same id, episode, parent, and checkpoint epoch.
   */
  private deleteProvenGoneSandbox(sandboxId: string): boolean {
    const sandbox = this.sandboxes.get(sandboxId);
    const deleted = this.sandboxes.delete(sandboxId);
    const resumed = this.resumingEpisode;
    if (
      deleted
      && sandbox !== undefined
      && resumed?.claimedSandboxId === sandboxId
      && sandbox.episode === resumed.episode
      && sandbox.parentHash === resumed.parent
      && sandbox.epoch === resumed.epoch
    ) {
      resumed.claimedSandboxId = null;
    }
    return deleted;
  }

  async createSandbox(params: CreateSandboxP, _ctx: CallContext): Promise<SandboxRef> {
    this.enterOp();
    try {
      const replayedClaim = this.replayedResumeClaim(params);
      if (replayedClaim !== undefined) return replayedClaim;
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
          const replayedClaim = this.replayedResumeClaim(params);
          if (replayedClaim !== undefined) return replayedClaim;
          const repair = this.lineage.has(params.artifact.hash) ? undefined : this.repairs.get(params.artifact.hash);
          const requestedContinuation = params.continueEpisode;
          if (requestedContinuation !== undefined) {
            const checkpoint = this.episodeCheckpoints.get(requestedContinuation);
            if (
              checkpoint === undefined
              || checkpoint.completed
              || checkpoint.parent === undefined
              || checkpoint.epoch === undefined
            ) {
              throw new BrokerError("INTERNAL", `cannot continue non-active checkpoint-v1 episode ${requestedContinuation}`);
            }
            if (
              params.artifact.hash !== checkpoint.parent
              && this.continuationEpisodes.get(params.artifact.hash)?.has(requestedContinuation) !== true
            ) {
              throw new BrokerError(
                "INTERNAL",
                `continuation artifact ${params.artifact.hash} does not belong to episode ${requestedContinuation}`,
              );
            }
          }
          const reservesNewEpisode =
            repair === undefined
            && requestedContinuation === undefined;
          if (reservesNewEpisode && this.episodeOrdinal + this.pendingNewEpisodes >= this.maxMutationEpisodes) {
            throw new BrokerError(
              "BUDGET_EXCEEDED",
              `mutation episode cap reached (${this.maxMutationEpisodes})`,
            );
          }
          const artifactEpisode = this.lineage.get(params.artifact.hash)?.episode;
          if (
            reservesNewEpisode
            && artifactEpisode !== undefined
            && this.episodeCheckpoints.get(artifactEpisode)?.completed === false
            && !this.trustedAcceptedCandidates.has(params.artifact.hash)
          ) {
            throw new BrokerError(
              "INTERNAL",
              `incomplete checkpoint-v1 episode ${artifactEpisode} must be continued explicitly`,
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
      "--user", MUTATION_SANDBOX_USER,
      "--read-only",
      "--tmpfs",
      `/workspace:rw,exec,nosuid,nodev,size=${this.workspaceQuotaBytes},nr_inodes=${WORKSPACE_TMPFS_INODES},mode=1777`,
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,size=67108864,mode=1777",
      "--tmpfs",
      `${MUTATION_SANDBOX_HOME}:rw,exec,nosuid,nodev,size=67108864,mode=0700,uid=1000,gid=1000`,
      "-w",
      "/workspace",
    ];
    // Trusted-side env injection (WP7 contract with WP5): proxy endpoint +
    // per-run bearer reach mutation sandboxes via broker config, never over
    // the client wire protocol. Values are role-scoped and metered; the
    // upstream credentials themselves never enter any sandbox.
    for (const [k, v] of Object.entries(this.config.mutationEnv ?? {})) {
      if (k === "HOME") continue;
      argv.push("-e", `${k}=${v}`);
    }
    // The fixed uid's home is broker authority, not image/config authority.
    // Append it last so even a conflicting mutationEnv cannot steer Node's
    // homedir (and Pi agent storage) back onto the read-only image root.
    argv.push("-e", `HOME=${MUTATION_SANDBOX_HOME}`);
    for (const m of mounts) argv.push("-v", `${m.host}:${m.container}:${m.mode}`);
    argv.push(this.runtimeIdentity.executionImage, "sleep", "2147483647");

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
    let claimedResume = false;
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
      let sandboxEpoch: string;
      const requestedContinuation = params.continueEpisode;
      if (requestedContinuation !== undefined) {
        const checkpoint = this.episodeCheckpoints.get(requestedContinuation);
        if (
          checkpoint === undefined
          || checkpoint.completed
          || checkpoint.parent === undefined
          || checkpoint.epoch === undefined
        ) {
          throw new BrokerError("INTERNAL", `cannot continue non-active checkpoint-v1 episode ${requestedContinuation}`);
        }
        if (
          params.artifact.hash !== checkpoint.parent
          && this.continuationEpisodes.get(params.artifact.hash)?.has(requestedContinuation) !== true
        ) {
          throw new BrokerError(
            "INTERNAL",
            `continuation artifact ${params.artifact.hash} does not belong to episode ${requestedContinuation}`,
          );
        }
        if (
          this.resumingEpisode?.episode === requestedContinuation
          && params.artifact.hash === this.resumingEpisode.parent
        ) {
          if (this.resumingEpisode.claimedSandboxId !== null) {
            throw new BrokerError("INTERNAL", `resumed episode ${requestedContinuation} is already claimed`);
          }
          this.resumingEpisode.claimedSandboxId = sandboxId;
          claimedResume = true;
        }
        episode = requestedContinuation;
        parentHash = checkpoint.parent;
        sandboxEpoch = checkpoint.epoch;
      } else if (repair !== undefined) {
        const checkpoint = this.episodeCheckpoints.get(repair.episode);
        episode = repair.episode;
        parentHash = checkpoint?.parent ?? repair.parent;
        sandboxEpoch = checkpoint?.epoch ?? `${this.bootNonce}:ep${episode}`;
      } else {
        episode = this.episodeOrdinal;
        parentHash = params.artifact.hash;
        sandboxEpoch = `${this.bootNonce}:ep${episode}`;
        // One fsynced fact owns ordinal, exact resume generation, parent, and
        // the public boundary: a crash can strand neither side.
        startedEvents = this.journalFact(
          { t: "episode", episode, parent: parentHash, epoch: sandboxEpoch },
          [{ type: "episode.started", episode, parent: { hash: parentHash } }],
        );
        this.episodeCheckpoints.set(episode, {
          parent: parentHash,
          epoch: sandboxEpoch,
          completed: false,
        });
        this.episodeOrdinal = episode + 1;
        this.anyEpisodeStarted = true;
      }
      // A checkpoint-v1 resume deliberately reactivates the exact persisted
      // generation. Exact old evaluation facts are replayed without another
      // evaluator admission; any coordinate not in the checkpoint is new work.
      const sandboxEpochSeq = this.mintEpochSeq(sandboxEpoch);
      const reactivatesCheckpoint =
        claimedResume
        || requestedContinuation !== undefined
        || (repair !== undefined && this.episodeCheckpoints.get(repair.episode)?.epoch !== undefined);
      if (reactivatesCheckpoint) {
        this.measurementEpoch = sandboxEpoch;
      } else {
        const currentSeq = this.epochSeqByName.get(this.measurementEpoch);
        if (currentSeq === undefined || sandboxEpochSeq >= currentSeq) this.measurementEpoch = sandboxEpoch;
      }
      this.sandboxes.set(sandboxId, {
        containerId,
        expiresAtMs: this.now() + ttlSec * 1000,
        episode,
        parentHash,
        epoch: sandboxEpoch,
        lastExecStdout: null,
        lastExecExitCode: null,
        lastExecTruncated: null,
      });
    } catch (error) {
      if (
        claimedResume
        && this.resumingEpisode?.claimedSandboxId === sandboxId
      ) {
        this.resumingEpisode.claimedSandboxId = null;
      }
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
    } finally {
      this.publish(startedEvents);
    }
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
      if (containerGone(retired)) this.deleteProvenGoneSandbox(params.sandboxId);
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
    let execJournalError: string | null = null;
    let zeroUsageTurns = 0;
    let normalizedUsageTurns = 0;
    if (res.stderr.length > 0) {
      for (const line of res.stderr.toString("utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = SessionUsageAnomalyRecord.safeParse(JSON.parse(line));
          if (!parsed.success) continue;
          zeroUsageTurns += parsed.data.zeroUsageTurns;
          normalizedUsageTurns += parsed.data.normalizedUsageTurns;
        } catch {
          // Ordinary worker diagnostics are not structured anomaly records.
        }
      }
    }
    if (zeroUsageTurns > 0 || normalizedUsageTurns > 0) {
      try {
        this.emit({
          type: "mutation.usage-anomaly",
          episode: sb.episode,
          sandboxId: params.sandboxId,
          zeroUsageTurns,
          normalizedUsageTurns,
        });
      } catch (error) {
        execJournalError = error instanceof Error ? error.message : String(error);
      }
    }
    if (res.exitCode === SESSION_NO_YIELD_EXIT_CODE) {
      const record = this.parseSessionNoYieldRecord(res.stdout);
      if (record !== null) {
        try {
          // The exec result is the last moment this authoritative evidence is
          // guaranteed live: saveArtifact retires the sandbox on every shape.
          this.reportSessionNoYieldBound({ sandboxId: params.sandboxId, ...record }, _ctx);
        } catch (error) {
          // Never turn a clean bound stop into an exec failure. The optimizer
          // will retry the idempotent report and preserve this in its log.
          const message = error instanceof Error ? error.message : String(error);
          execJournalError = execJournalError === null ? message : `${execJournalError}; ${message}`;
        }
      }
    }
    const stderr = res.stderr.toString("utf8");
    return {
      exitCode: res.exitCode,
      stdout: res.stdout.toString("utf8"),
      stderr: execJournalError === null
        ? stderr
        : `${stderr}${stderr.length === 0 || stderr.endsWith("\n") ? "" : "\n"}` +
          `hone broker mutation telemetry journal failed: ${execJournalError}\n`,
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
        try {
          this.lineage.set(hash, { parent: sb.parentHash, episode: sb.episode });
          this.bindContinuationArtifact(hash, sb.episode);
          // Graduation: the hash may have been journaled as a repair snapshot
          // earlier; lineage supersedes it (replay treats the lineage line as
          // the tombstone), so descendants pair against THIS artifact.
          this.repairs.delete(hash);
        } finally {
          this.publish(events);
        }
      }
    } else if (hash !== sb.parentHash && !this.lineage.has(hash) && !this.repairs.has(hash)) {
      // Repair snapshot (no exec, or last exec failed): NOT a candidate, no
      // event; remembered so a follow-up sandbox reuses the original episode.
      this.appendState({ t: "repair", hash, parent: sb.parentHash, episode: sb.episode });
      this.repairs.set(hash, { parent: sb.parentHash, episode: sb.episode });
      this.bindContinuationArtifact(hash, sb.episode);
    }

    if (hash !== sb.parentHash && this.continuationEpisodes.get(hash)?.has(sb.episode) !== true) {
      // CAS identity is content-only: a later episode can legitimately
      // reproduce bytes whose immutable candidate lineage names an older
      // episode. Journal the fresh episode-local provenance separately rather
      // than rewriting lineage or weakening continuation admission.
      //
      // Legacy repair facts may name an episode without checkpoint-v1
      // authority. Their repair/lineage outcome remains replayable, but a
      // checkpoint-less continuation fact would make the next boot correctly
      // reject its own journal. Keep that binding process-local instead.
      if (this.episodeCheckpoints.has(sb.episode)) {
        this.appendState({
          t: "continuation",
          hash,
          parent: sb.parentHash,
          episode: sb.episode,
        });
      }
      this.bindContinuationArtifact(hash, sb.episode);
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
    this.deleteProvenGoneSandbox(params.sandboxId);
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

  private evaluationMemoKey(params: EvaluateP, epoch: string): string {
    return (
      `run:${this.config.runId}|gen:${epoch}|${params.artifact.hash}` +
      `|${this.runtimeIdentity.admittedCapsuleDigest}|${this.config.optimizerDigest}|${params.assetGroupId}|${params.seed}|wall:${this.evalTimeoutSec}` +
      (this.trustedMeasurementEpoch === undefined
        ? ""
        : `|measurementEpoch:${encodeURIComponent(this.trustedMeasurementEpoch)}`) +
      (params.recursivePlan === undefined
        ? ""
        : `|recursivePlan:${createHash("sha256").update(canonicalJson(params.recursivePlan)).digest("hex")}`)
    );
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
    // Capture the generation and full recursive-plan-sensitive memo identity
    // before resume replay or any fresh evaluator admission.
    const evalEpoch = this.measurementEpoch;
    const memoKey = this.evaluationMemoKey(params, evalEpoch);
    if (params.resume === true) {
      const resumed = this.resumingEpisode;
      if (resumed === undefined || this.measurementEpoch !== resumed.epoch) {
        throw new BrokerError("INTERNAL", "evaluation replay requested outside the resumed episode");
      }
      const legacyReplayKey = params.recursivePlan === undefined
        ? `${resumed.epoch}|${params.artifact.hash}|${params.assetGroupId}|${params.seed}`
        : undefined;
      const prior = this.replayedEvaluations.get(memoKey)
        ?? (legacyReplayKey === undefined ? undefined : this.replayedEvaluations.get(legacyReplayKey));
      if (prior !== undefined) {
        // No slot, invocation, holdout, or spend charge: this exact full
        // record was already fsynced before the killed broker acknowledged it.
        return this.redactRecord({ ...prior, cached: true }, group.visibility, ctx);
      }
    }
    if (group.visibility === "holdout") await this.chargeHoldout();
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
        this.appendState({ t: "slot", hash: params.artifact.hash });
        this.promotionSlots.add(params.artifact.hash);
      }
    }
    // Every ADMITTED privileged holdout request consumes one lifetime ledger
    // slot — this is information-query budget, not unique-computation budget,
    // so it is charged BEFORE in-flight coalescing and memo lookup: N
    // concurrent identical calls burn N slots exactly like N sequential ones.
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
      this.recordEvaluation(cached, group.visibility, epoch, memoKey);
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
    let invocationEvents: RunEvent[] = [];
    try {
    // Stage the selected group BEFORE burning the invocation: a missing or
    // non-regular host asset is trusted-side misconfiguration, not an
    // attempted evaluation.
    const stageDir = await this.stageAssets(group);

    let isolation: EvaluatorIsolationLease | undefined;
    let isolationRecord: z.infer<typeof EvaluatorIsolationRecord> | undefined;
    let isolationQuarantined = false;

    let res: CmdResult;
    let startedMs = 0;
    const evalName = `hone-${this.safeRunId}-eval-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    try {
      // Evaluators whose frozen contract consumes CAPSULE_WORKER_UID receive a
      // unique real uid. Frozen hard-coders retain uid 2000 behind the
      // starvation-bounded host FIFO. Queue waiting is real run wall clock,
      // so its entry/acquisition are durable and the budget is checked again
      // AFTER acquisition, before an invocation is burned or spawned.
      isolation = await acquireEvaluatorIsolation(
        this.manifest.id,
        evalName,
        this.closeController.signal,
        (allocationId) => this.emit({ type: "evaluator.queue.entered", allocationId }),
        this.uidClaimRecovery,
      );
      if (isolation.mode === "shared-uid-lease") {
        this.emit({
          type: "evaluator.queue.acquired",
          allocationId: isolation.allocationId,
          waitMs: isolation.waitMs,
        });
      }
      if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
      this.budgetGate();
      isolationRecord = EvaluatorIsolationRecord.parse({
        mode: isolation.mode,
        allocationId: isolation.allocationId,
        workerUid: isolation.workerUid,
        waitMs: isolation.waitMs,
      });

      // Burn the invocation DURABLY before the spawn so a crashed evaluator
      // cannot farm free retries. The projected snapshot/exhaustion are part
      // of that same fact, but publish only after this admitted evaluation
      // returns so the exact-cap invocation itself is allowed to finish.
      const budgetEvents: EmittableEvent[] = [
        { type: "evaluator.isolation", isolation: isolationRecord },
        { type: "budget.snapshot", budget: this.budgetStateNow(0, 0, 1) },
      ];
      const exhausted = this.exhaustedDimension(0, 0, 1);
      if (exhausted !== undefined && !this.exhaustedAnnounced.has(exhausted)) {
        budgetEvents.push({ type: "budget.exhausted", dimension: exhausted });
      }
      invocationEvents = this.journalFact({ t: "inv", isolation: isolationRecord }, budgetEvents);
      this.spent.evaluatorInvocations += 1;
      this.syncRecursiveUsage();

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
        // Evaluators alone receive the host's narrow cgroup2 mount profile.
        // Mutation sandboxes retain docker-default and never receive SYS_ADMIN.
        "--security-opt",
        "apparmor=hone-evaluator-cgroup",
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "KILL",
        // Trusted-parent-only reset authority. The numeric setuid selected
        // above clears these capabilities from the candidate worker, and
        // no-new-privileges prevents reacquisition through file capabilities.
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "IPC_OWNER",
        // Trusted-scorer-only namespace authority (evaluator container ONLY,
        // never mutation sandboxes/keeper): the scorer's preexec unshares
        // fresh NET+IPC namespaces per repetition BEFORE the numeric setuid
        // drop, so cross-rep loopback state (TIME_WAIT caches, SysV IPC)
        // cannot leak between repetitions. The drop strips it from the
        // candidate worker and no-new-privileges prevents reacquisition.
        "--cap-add",
        "SYS_ADMIN",
        "--read-only",
        "--tmpfs",
        "/tmp:size=2g,nosuid,nodev,noexec",
        "--shm-size",
        "16m",
        // The trusted scorer runs as ROOT inside the eval container so it can
        // drop the candidate worker to the selected unprivileged uid. Same-uid
        // signal//proc reach from candidate code to the scorer is severed.
        "--user",
        "0:0",
        // Entrypoints are baseline-relative; the candidate workspace is DATA,
        // never the working directory the evaluator executes from.
        "-w",
        "/trusted/baseline",
        "-e",
        `HONE_SEED=${params.seed}`,
        "-e",
        `CAPSULE_WORKER_UID=${isolation.workerUid}`,
        "-e",
        `CAPSULE_WORKER_GID=${isolation.workerUid}`,
        "-e",
        // libmount's fd-based move_mount path is denied by this host kernel.
        // Force the classic mount(2) path for trusted evaluator cgroup setup.
        "LIBMOUNT_FORCE_MOUNT2=always",
        "-v",
        `${workspaceDir}:/workspace:ro`,
        "-v",
        `${baselineDir}:/trusted/baseline:ro`,
        // Asset confidentiality: the assets bind mount is parented under a
        // root-owned mode=0700 tmpfs, so every dropped candidate uid is denied
        // traversal. Host-side, the staged tree is dirs 0755 / files 0644
        // under the 0700 host-only tmp parent: the Docker daemon resolves the
        // bind, while the trusted root evaluator can read the mounted files.
        "--tmpfs",
        "/capsule:mode=0700,size=1m",
        "-v",
        `${stageDir}:/capsule/assets:ro`,
      ];
      argv.push(this.runtimeIdentity.executionImage, ...this.manifest.evalEntrypoint);

      // Registration is SYNCHRONOUS with the spawn: close() either sees this
      // name in the tracked set and reaps it, or this op threw before
      // spawning. Every post-registration path — resolve, throw, timeout —
      // runs the reap finally below, so a journal append failure (which
      // throws ABOVE, before registration) can never strand a phantom
      // tracked name or repeat staging against a poisoned journal.
      if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
      this.trackedContainers.add(evalName);
      startedMs = Date.now();
      try {
        res = await this.run(argv, { timeoutMs: this.evalTimeoutSec * 1000, maxOutputBytes: 32 * 1024 * 1024 });
      } finally {
        // A timed-out `docker run` kills only the local CLI; the container (and
        // the adversarial code inside it) keeps running. Always reap by name —
        // a no-op for containers --rm already removed.
        let cleanupError: string | undefined;
        try {
          const retired = await this.removeTrackedContainer(evalName);
          if (!containerGone(retired)) {
            cleanupError = stderrText(retired) || "Docker did not prove the evaluator container absent";
          }
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : String(error);
        }
        if (cleanupError !== undefined) {
          if (isolation === undefined || isolationRecord === undefined) {
            throw new BrokerError("INTERNAL", "evaluator cleanup failed before isolation was recorded");
          }
          // The container may still be running candidate code. Retain the
          // kernel-held uid/FIFO lease, and durably name the quarantine so the
          // next invocation cannot inherit its RLIMIT_NPROC pool.
          this.quarantinedEvaluatorLeases.set(evalName, { lease: isolation, isolation: isolationRecord });
          isolationQuarantined = true;
          // The admitted invocation is complete enough to diagnose. Publish
          // its earlier transaction before the later quarantine fact; the
          // throw below skips the ordinary success-path publication.
          this.publish(invocationEvents);
          this.emit({
            type: "evaluator.isolation.quarantined",
            isolation: isolationRecord,
            evaluatorContainer: evalName,
            cleanupError: (cleanupError || "Docker cleanup failed without an error message").slice(0, 4096),
          });
          throw new BrokerError("INTERNAL", `evaluator cleanup failed: ${cleanupError}`);
        }

      }
    } finally {
      try {
        if (!isolationQuarantined) await isolation?.release();
      } finally {
        // Confidentiality teardown on EVERY path (success, error, timeout):
        // staged fixtures disappear before any untrusted process runs again.
        await rm(stageDir, { recursive: true, force: true });
      }
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
    if (isolationRecord === undefined) {
      throw new BrokerError("INTERNAL", "successful evaluator invocation lacks isolation provenance");
    }

    const record = EvaluationRecord.parse({
      capsuleId: this.manifest.id,
      artifactHash: params.artifact.hash,
      assetGroupId: params.assetGroupId,
      seed: params.seed,
      isolation: isolationRecord,
      output,
      costUsd: 0, // eval containers have no network — no LLM spend to attribute
      durationMs,
      cached: false,
      evaluatedAt: new Date().toISOString(),
    });
    const recordHash = await this.cas.putBuffer(Buffer.from(JSON.stringify(record)));
    await this.cas.indexPut(this.evaluationCacheNamespace, memoKey, recordHash);
    this.recordEvaluation(record, group.visibility, epoch, memoKey);
    return record;
    } finally {
      try {
        this.publish(invocationEvents);
      } finally {
        await releaseEvaluation();
      }
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
    let invocationEvents: RunEvent[] = [];
    try {
      if (this.closing) throw new BrokerError("INTERNAL", "broker is closed");
      const budgetEvents: EmittableEvent[] = [
        { type: "budget.snapshot", budget: this.budgetStateNow(0, 0, 1) },
      ];
      const exhausted = this.exhaustedDimension(0, 0, 1);
      if (exhausted !== undefined && !this.exhaustedAnnounced.has(exhausted)) {
        budgetEvents.push({ type: "budget.exhausted", dimension: exhausted });
      }
      invocationEvents = this.journalFact({ t: "inv" }, budgetEvents);
      this.spent.evaluatorInvocations += 1;
      this.syncRecursiveUsage();

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
          ...(params.recursivePlan === undefined ? {} : { recursivePlan: params.recursivePlan }),
          spawnRun: async (child) => await this.spawnRun(child, { privileged: true }),
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
      this.recordEvaluation(record, group.visibility, epoch, memoKey);
      return record;
    } finally {
      try {
        this.publish(invocationEvents);
      } finally {
        await releaseEvaluation();
      }
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
    try {
      this.holdoutCount = seq;
    } finally {
      this.publish(events);
    }
  }

  private recordPromotionHoldoutEvaluation(record: EvaluationRecord): void {
    const split = this.promotionHoldoutSplit;
    if (split === undefined || record.assetGroupId !== split.holdout.assetGroupId) return;
    const key = canonicalJson([record.artifactHash, record.assetGroupId, record.seed]);
    if (this.promotionHoldoutScores.has(key)) return;
    const aggregate = eligibleAggregate(record) ?? null;
    const events = this.journalFact(
      { t: "holdoutEval", splitId: split.splitId, record },
      [{
        type: "holdout.eval.completed",
        splitId: split.splitId,
        artifact: { hash: record.artifactHash },
        assetGroupId: record.assetGroupId,
        seed: record.seed,
        aggregate,
        cached: record.cached,
      }],
    );
    try {
      this.promotionHoldoutScores.set(key, aggregate);
    } finally {
      this.publish(events);
    }
  }

  /**
   * Trusted scalarization + evaluation persistence. Ordinary holdout results
   * never enter the optimizer-facing promotion table. When a trusted frozen
   * promotion split is configured, its results instead enter a disjoint
   * trusted-only journal and event surface for terminal claim assessment.
   * Ineligible outputs are recorded as null and grant no authority.
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
   * record), gate.paired only alongside that first tagged eligible record.
   * Ineligible results are explicit settled negatives; fresh eligible
   * re-measurements in later epochs are measurements, not news and not
   * authority (see registerGate: the first pair is frozen).
   */
  private recordEvaluation(record: EvaluationRecord, visibility: string, epoch: string, memoKey: string): void {
    if (visibility === "holdout" && !this.terminalHoldoutAssetGroupIds.has(record.assetGroupId)) {
      this.recordPromotionHoldoutEvaluation(record);
      return;
    }
    if (this.journaledEvaluationMemoKeys.has(memoKey)) return;
    const aggregate = eligibleAggregate(record);
    const epochSeq = this.epochSeqByName.get(epoch);
    if (epochSeq === undefined) {
      throw new BrokerError("INTERNAL", `measurement epoch was never minted by trusted code: ${epoch}`);
    }
    if (aggregate === undefined) {
      const lineage = this.lineage.get(record.artifactHash);
      const hadTrusted = (this.lifetimeCoords.get(record.artifactHash)?.size ?? 0) > 0;
      const tagged = this.anyEpisodeStarted && !hadTrusted ? lineage : undefined;
      const events: EmittableEvent[] = this.anyEpisodeStarted
        ? [{
            type: "eval.completed",
            ...(tagged !== undefined ? { episode: tagged.episode } : {}),
            artifact: { hash: record.artifactHash },
            assetGroupId: record.assetGroupId,
            seed: record.seed,
            aggregate: null,
            cached: record.cached,
          }]
        : [];
      const journaled = this.journalFact({
        t: "eval",
        record,
        memoKey,
        epoch,
        epochSeq,
        ...(this.trustedMeasurementEpoch !== undefined ? { measurementEpoch: this.trustedMeasurementEpoch } : {}),
      }, events);
      try {
        this.journaledEvaluationMemoKeys.add(memoKey);
      } finally {
        this.publish(journaled);
      }
      return;
    }
    if (
      record.artifactHash !== this.config.baselineArtifactHash &&
      this.promotionSlots.has(record.artifactHash)
    ) {
      this.trustedAcceptedCandidates.add(record.artifactHash);
    }
    const pairKey = `${record.assetGroupId}|${record.seed}`;
    if (this.trusted.get(`${epoch}|${record.artifactHash}`)?.has(pairKey) === true) return;

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
    const gate: z.infer<typeof CalibratedGateFact> | undefined =
      lin !== undefined && parentScore !== undefined
        ? {
            parent: lin.parent,
            parentScore,
            childScore: aggregate,
            ...assessPromotion(
              parentScore,
              aggregate,
              this.promotionNoiseCalibrations.get(record.assetGroupId) ?? null,
            ),
          }
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
          gateVersion: gate.gateVersion,
          calibrationEvidenceVersion: gate.calibrationEvidenceVersion,
          delta: gate.delta,
          noiseFloor: gate.noiseFloor,
          noiseEnvelope: gate.noiseEnvelope,
          decision: gate.decision,
        });
      }
    }

    const journaled = this.journalFact({
      t: "eval",
      record,
      memoKey,
      epoch,
      epochSeq,
      ...(this.trustedMeasurementEpoch !== undefined ? { measurementEpoch: this.trustedMeasurementEpoch } : {}),
      ...(gate !== undefined ? { gate } : {}),
    }, events);
    try {
      this.journaledEvaluationMemoKeys.add(memoKey);
      // Tables AFTER the durable fact, via the same helpers replay uses — a
      // crash rebuilds the exact same measurements and persisted gates.
      this.insertMeasurement(epoch, record.artifactHash, pairKey, aggregate);
      if (gate !== undefined) this.registerGate(record.artifactHash, epoch, pairKey, gate);
    } finally {
      this.publish(journaled);
    }
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
   * prove it — the ONE persisted SAME-EPOCH, PARENT-FIRST gate pair whose
   * delta exceeds its identity-bound per-capsule noise envelope, plus the
   * same calibrated improvement over the current incumbent. Claimed metrics
   * are never read.
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
  private promotionVerdictFor(hash: string): PromotionVerdictR {
    const lin = this.lineage.get(hash);
    if (lin === undefined) return { status: "refused", reason: "no-lineage" };
    if ((this.lifetimeCoords.get(hash)?.size ?? 0) === 0) return { status: "never-paired" };
    if (!this.promotionSlots.has(hash)) return { status: "refused", reason: "no-public-admission" };
    const gateEntry = this.gates.get(hash);
    if (gateEntry === undefined) return { status: "refused", reason: "no-persisted-pair" };
    if (gateEntry.gate.parent !== lin.parent) return { status: "refused", reason: "lineage-mismatch" };
    if (!("gateVersion" in gateEntry.gate) || gateEntry.gate.gateVersion !== PROMOTION_GATE_VERSION) {
      return { status: "refused", reason: "legacy-unversioned-gate" };
    }
    const gate = gateEntry.gate;
    return {
      status: gate.passed ? "promotable" : "not-promotable",
      parent: { hash: gate.parent },
      parentScore: gate.parentScore,
      childScore: gate.childScore,
      delta: gate.delta,
      gateVersion: gate.gateVersion,
      calibrationEvidenceVersion: gate.calibrationEvidenceVersion,
      noiseFloor: gate.noiseFloor,
      noiseEnvelope: gate.noiseEnvelope,
      decision: gate.decision,
    };
  }

  /**
   * Read-only optimizer view of the frozen first trusted pairing. This is
   * derived only from journal-replayed authority; later seeds cannot replace
   * a losing pair or manufacture a missing one.
   */
  getPromotionVerdict(params: GetPromotionVerdictP, _ctx: CallContext): PromotionVerdictR {
    this.budgetGate();
    return this.promotionVerdictFor(params.artifact.hash);
  }
  private promotionHoldoutScore(
    artifactHash: string,
    assetGroupId: string,
    seed: number,
  ): number {
    const score = this.promotionHoldoutScores.get(canonicalJson([artifactHash, assetGroupId, seed]));
    if (score === undefined) {
      throw new BrokerError(
        "INTERNAL",
        `missing trusted holdout measurement for ${artifactHash} at ${assetGroupId}|${seed}`,
      );
    }
    if (score === null) {
      throw new BrokerError(
        "INTERNAL",
        `ineligible trusted holdout measurement for ${artifactHash} at ${assetGroupId}|${seed}`,
      );
    }
    return score;
  }

  recordHoldoutNullControl(
    params: RecordHoldoutNullControlP,
    ctx: CallContext,
  ): z.infer<typeof HoldoutNullControlRecord> {
    if (!ctx.privileged) {
      throw new BrokerError("HOLDOUT_ACCESS_DENIED", "holdout null controls require trusted authority");
    }
    const split = this.promotionHoldoutSplit;
    if (
      split === undefined
      || params.splitId !== split.splitId
      || params.assetGroupId !== split.holdout.assetGroupId
    ) {
      throw new BrokerError("INTERNAL", "holdout null control does not match the frozen split");
    }
    const requiredRepeats = Math.max(2, split.evaluationRepeats);
    if (params.seeds.length !== requiredRepeats || new Set(params.seeds).size !== params.seeds.length) {
      throw new BrokerError(
        "INTERNAL",
        `holdout null control requires exactly ${requiredRepeats} unique measurements`,
      );
    }
    const prior = [...this.holdoutNullControls.values()].find((control) =>
      control.splitId === params.splitId
      && control.artifactHash === params.artifactHash
      && control.assetGroupId === params.assetGroupId
      && sameCanonical(control.seeds, params.seeds)
    );
    if (prior !== undefined) return prior;
    const control = buildHoldoutNullControl({
      splitId: split.splitId,
      artifactHash: params.artifactHash,
      assetGroupId: params.assetGroupId,
      seeds: params.seeds,
      scores: params.seeds.map((seed) =>
        this.promotionHoldoutScore(params.artifactHash, params.assetGroupId, seed),
      ),
      recordedAt: new Date(this.now()).toISOString(),
    });
    const events = this.journalFact(
      { t: "holdoutNullControl", control },
      [{ type: "holdout.null-control.completed", control }],
    );
    try {
      this.holdoutNullControls.set(control.controlId, control);
    } finally {
      this.publish(events);
    }
    return control;
  }

  recordPromotionHoldout(
    params: RecordPromotionHoldoutP,
    ctx: CallContext,
  ): z.infer<typeof PromotionHoldoutRecord> {
    if (!ctx.privileged) {
      throw new BrokerError("HOLDOUT_ACCESS_DENIED", "promotion holdout records require trusted authority");
    }
    const split = this.promotionHoldoutSplit;
    if (
      split === undefined
      || params.splitId !== split.splitId
      || params.assetGroupId !== split.holdout.assetGroupId
      || params.seeds.length !== split.evaluationRepeats
      || new Set(params.seeds).size !== params.seeds.length
    ) {
      throw new BrokerError("INTERNAL", "promotion holdout request does not match the frozen split protocol");
    }
    const existing = this.promotionHoldoutRecords.get(params.artifactHash);
    if (existing !== undefined) {
      if (
        existing.splitId !== params.splitId
        || existing.holdout.assetGroupId !== params.assetGroupId
        || !sameCanonical(existing.holdout.seeds, params.seeds)
        || existing.nullControl.controlId !== params.nullControlId
      ) {
        throw new BrokerError("INTERNAL", "promotion already has a different holdout record");
      }
      return existing;
    }
    if (!this.incumbentHistory.some((incumbent) => incumbent.hash === params.artifactHash)) {
      throw new BrokerError("INTERNAL", "holdout assessment requires a durably recorded in-sample promotion");
    }
    const verdict = this.promotionVerdictFor(params.artifactHash);
    if (verdict.status !== "promotable") {
      throw new BrokerError("INTERNAL", "holdout assessment requires a noise-clearing in-sample promotion");
    }
    const control = this.holdoutNullControls.get(params.nullControlId);
    if (
      control === undefined
      || control.splitId !== split.splitId
      || control.assetGroupId !== params.assetGroupId
      || params.seeds.some((seed) => !control.seeds.includes(seed))
    ) {
      throw new BrokerError("INTERNAL", "promotion holdout null control does not match its split and coordinates");
    }
    const record = buildPromotionHoldoutRecord({
      artifactHash: params.artifactHash,
      parentArtifactHash: verdict.parent.hash,
      split,
      gateVersion: verdict.gateVersion,
      noiseDecision: verdict.decision,
      trainParentScore: verdict.parentScore,
      trainChildScore: verdict.childScore,
      holdoutParentScores: params.seeds.map((seed) =>
        this.promotionHoldoutScore(verdict.parent.hash, params.assetGroupId, seed),
      ),
      holdoutChildScores: params.seeds.map((seed) =>
        this.promotionHoldoutScore(params.artifactHash, params.assetGroupId, seed),
      ),
      seeds: params.seeds,
      nullControl: control,
      recordedAt: new Date(this.now()).toISOString(),
    });
    const events = this.journalFact(
      { t: "promotionHoldout", record },
      [{ type: "promotion.holdout.completed", record }],
    );
    try {
      this.promotionHoldoutRecords.set(record.artifactHash, record);
    } finally {
      this.publish(events);
    }
    return record;
  }
  /**
   * Terminal trusted path: measure the final durable in-sample promotion on
   * the frozen holdout, ship one information-free null control, and persist
   * its generalization record. Intermediate incumbents remain optimizer
   * feedback, not publishable claims. The complete request count is checked
   * before the first holdout access, so a tight campaign budget fails without
   * a partial claim surface.
   */
  async assessPromotionHoldouts(
    ctx: CallContext,
  ): Promise<readonly z.infer<typeof PromotionHoldoutRecord>[]> {
    if (!ctx.privileged) {
      throw new BrokerError("HOLDOUT_ACCESS_DENIED", "promotion holdout assessment requires trusted authority");
    }
    const split = this.promotionHoldoutSplit;
    if (split === undefined) {
      throw new BrokerError("INTERNAL", "no frozen promotion holdout split is configured");
    }
    const evaluationSeeds = Array.from({ length: split.evaluationRepeats }, (_, seed) => seed);
    const controlSeeds = split.evaluationRepeats === 1 ? [0, 1] : evaluationSeeds;
    const incumbent = this.incumbentHistory.at(-1);
    if (incumbent === undefined) return [];
    const verdict = this.promotionVerdictFor(incumbent.hash);
    if (verdict.status !== "promotable") {
      throw new BrokerError("INTERNAL", "final durable incumbent is not promotable");
    }
    const promotions = [{ artifactHash: incumbent.hash, verdict }];
    const coordinates = new Map<string, { artifactHash: string; seed: number }>();
    const addCoordinate = (artifactHash: string, seed: number): void => {
      const key = canonicalJson([artifactHash, split.holdout.assetGroupId, seed]);
      if (!this.promotionHoldoutScores.has(key)) coordinates.set(key, { artifactHash, seed });
    };
    for (const seed of controlSeeds) addCoordinate(verdict.parent.hash, seed);
    for (const promotion of promotions) {
      for (const seed of evaluationSeeds) {
        addCoordinate(promotion.verdict.parent.hash, seed);
        addCoordinate(promotion.artifactHash, seed);
      }
    }
    const required = coordinates.size;
    const evaluatorRemaining =
      this.manifest.budget.maxEvaluatorInvocations
      - this.spent.evaluatorInvocations
      - this.pendingEvaluations;
    const ledgerState = this.ledger?.state();
    if (ledgerState === undefined) {
      throw new BrokerError("INTERNAL", "holdout ledger is not open");
    }
    const holdoutRemaining = ledgerState.budget - ledgerState.count;
    if (required > evaluatorRemaining || required > holdoutRemaining) {
      throw new BrokerError(
        "BUDGET_EXCEEDED",
        `promotion holdout requires ${required} evaluator requests before spending; `
        + `only ${Math.min(evaluatorRemaining, holdoutRemaining)} remain`,
      );
    }
    for (const coordinate of coordinates.values()) {
      await this.evaluate({
        artifact: { hash: coordinate.artifactHash },
        assetGroupId: split.holdout.assetGroupId,
        seed: coordinate.seed,
      }, ctx);
    }
    const control = this.recordHoldoutNullControl({
      splitId: split.splitId,
      artifactHash: verdict.parent.hash,
      assetGroupId: split.holdout.assetGroupId,
      seeds: controlSeeds,
    }, ctx);
    return promotions.map((promotion) =>
      this.recordPromotionHoldout({
        splitId: split.splitId,
        artifactHash: promotion.artifactHash,
        assetGroupId: split.holdout.assetGroupId,
        seeds: evaluationSeeds,
        nullControlId: control.controlId,
      }, ctx)
    );
  }



  reportIncumbent(params: ReportIncumbentP, _ctx: CallContext): Record<string, never> {
    this.budgetGate();
    const hash = params.artifact.hash;
    if (this.currentIncumbent?.hash === hash) return {}; // idempotent re-report

    const verdict = this.promotionVerdictFor(hash);
    if (verdict.status === "refused") {
      if (verdict.reason === "no-lineage") {
        throw new BrokerError("INTERNAL", `reportIncumbent: ${hash} is not a saved candidate of this run (no lineage)`);
      }
      if (verdict.reason === "no-public-admission") {
        throw new BrokerError(
          "INTERNAL",
          `reportIncumbent: insufficient authority — artifact has no public candidate evaluation admission (cap ${this.maxPublicCandidateEvaluations})`,
        );
      }
      throw new BrokerError(
        "INTERNAL",
        "reportIncumbent: insufficient authority — no persisted same-epoch parent-first gate pairing candidate and parent " +
          "(measure the parent BEFORE the candidate's first-ever evaluation, at a shared group+seed coordinate, " +
          "within the current mutation episode)",
      );
    }
    if (verdict.status === "never-paired") {
      throw new BrokerError("INTERNAL", `reportIncumbent: no trusted evaluation for artifact ${hash}`);
    }
    if (verdict.status === "not-promotable") {
      throw new BrokerError(
        "INTERNAL",
        `reportIncumbent: calibrated gate refused (${verdict.decision}; paired delta ${verdict.delta}; noise envelope ${String(verdict.noiseEnvelope)})`,
      );
    }
    const lin = this.lineage.get(hash);
    const gateEntry = this.gates.get(hash);
    if (lin === undefined || gateEntry === undefined) {
      throw new BrokerError("INTERNAL", "reportIncumbent: positive verdict lost its durable authority");
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
      if (verdict.noiseEnvelope === null || !(deltaVsInc > verdict.noiseEnvelope)) {
        throw new BrokerError(
          "INTERNAL",
          `reportIncumbent: improvement over current incumbent did not exceed noise envelope ` +
            `(paired delta ${deltaVsInc}; noise envelope ${String(verdict.noiseEnvelope)})`,
        );
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
    try {
      const promoted = { hash, aggregate, deltaVsBaseline, episode: lin.episode };
      this.incumbentHistory.push(promoted);
      this.currentIncumbent = promoted;
      this.lastIncumbent = params;
    } finally {
      this.publish(events);
    }
    return {};
  }

  private parseSessionNoYieldRecord(stdout: Buffer | null): z.infer<typeof SessionNoYieldRecord> | null {
    const lastLine = stdout
      ?.toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .at(-1);
    if (lastLine === undefined) return null;
    try {
      const parsed = SessionNoYieldRecord.safeParse(JSON.parse(lastLine));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Durable stop reason for a sealed mutation worker that consumed its
   * per-session allowance without successfully invoking yield. execOp records
   * it while sandbox evidence is live; the public call is an idempotent
   * confirmation that remains valid after saveArtifact retires the sandbox.
   */
  reportSessionNoYieldBound(params: ReportSessionNoYieldBoundP, _ctx: CallContext): Record<string, never> {
    this.state().assertUsable();
    const { type: _wireType, ...eventTrigger } = params;
    const existing = this.journalEvents.find(
      (event) => event.type === "mutation.no-yield-bound" && event.sandboxId === params.sandboxId,
    );
    if (existing !== undefined) {
      if (!sameCanonical(existing, { ...existing, ...eventTrigger })) {
        throw new BrokerError("INTERNAL", `contradictory no-yield bound report for sandbox ${params.sandboxId}`);
      }
      return {};
    }

    const sandbox = this.sandboxes.get(params.sandboxId);
    if (sandbox === undefined) {
      throw new BrokerError("SANDBOX_NOT_FOUND", `unknown no-yield bound sandbox ${params.sandboxId}`);
    }
    if (sandbox.lastExecExitCode !== SESSION_NO_YIELD_EXIT_CODE) {
      throw new BrokerError(
        "INTERNAL",
        `no-yield bound sandbox ${params.sandboxId} last exited ${String(sandbox.lastExecExitCode)}, not ${SESSION_NO_YIELD_EXIT_CODE}`,
      );
    }
    const workerRecord = this.parseSessionNoYieldRecord(sandbox.lastExecStdout);
    const { sandboxId: _sandboxId, ...reportedRecord } = params;
    if (workerRecord === null || !sameCanonical(workerRecord, reportedRecord)) {
      throw new BrokerError("INTERNAL", `no-yield bound report does not match sandbox ${params.sandboxId} worker output`);
    }
    if (params.consumedTokens > this.spent.tokens) {
      throw new BrokerError(
        "INTERNAL",
        `no-yield bound reports ${params.consumedTokens} tokens but the run has spent only ${this.spent.tokens}`,
      );
    }
    this.emit({
      type: "mutation.no-yield-bound",
      episode: sandbox.episode,
      ...eventTrigger,
    });
    return {};
  }

  /** Fsync the inner-episode commit boundary before the optimizer advances. */
  async completeEpisode(params: CompleteEpisodeP, _ctx: CallContext): Promise<Record<string, never>> {
    this.enterOp();
    try {
      const complete = async (): Promise<Record<string, never>> => {
        this.state().assertUsable();
        const checkpoint = this.episodeCheckpoints.get(params.episode);
        if (checkpoint === undefined) {
          throw new BrokerError("INTERNAL", `cannot complete unknown episode ${params.episode}`);
        }
        if (checkpoint.completed) return {};
        if (params.releaseSandboxId !== undefined) {
          const sandbox = this.sandboxes.get(params.releaseSandboxId);
          if (sandbox === undefined) {
            throw new BrokerError(
              "SANDBOX_NOT_FOUND",
              `completion release sandbox not found: ${params.releaseSandboxId}`,
            );
          }
          if (sandbox.episode !== params.episode) {
            throw new BrokerError(
              "INTERNAL",
              `completion release sandbox ${params.releaseSandboxId} belongs to episode ${sandbox.episode}, not ${params.episode}`,
            );
          }
          const retired = await this.removeTrackedContainer(sandbox.containerId);
          if (!containerGone(retired)) {
            throw new BrokerError(
              "INTERNAL",
              `sandbox retirement failed before episode completion: ${stderrText(retired)}`,
            );
          }
          this.deleteProvenGoneSandbox(params.releaseSandboxId);
        }
        if ([...this.sandboxes.values()].some((sandbox) => sandbox.episode === params.episode)) {
          throw new BrokerError("INTERNAL", `cannot complete episode ${params.episode} with an active sandbox`);
        }
        const events = this.journalFact(
          { t: "episodeComplete", episode: params.episode },
          [{ type: "episode.completed", episode: params.episode }],
        );
        try {
          checkpoint.completed = true;
          if (this.resumingEpisode?.episode === params.episode) this.resumingEpisode = undefined;
        } finally {
          this.publish(events);
        }
        return {};
      };
      return await this.serializeMutation(() =>
        params.releaseSandboxId === undefined
          ? complete()
          : this.serializeSandbox(params.releaseSandboxId, complete),
      );
    } finally {
      this.exitOp();
    }
  }

  /**
   * Ends this boot's active interval at one durable level. Local orchestration
   * calls this synchronously when pause/stop/budget abort lands; close() is
   * the idempotent fallback for ordinary completion and failures.
   */
  pauseActiveTime(): void {
    if (this.activeClockPaused || this.stateLog === undefined) return;
    try {
      this.stateLog.assertUsable();
    } catch {
      // The operation that poisoned the writer already failed. Teardown must
      // still close cleanly; only a restart can truncate and resume timing.
      return;
    }
    const nowMs = this.now();
    const activeMs = this.activeWallClockMs(nowMs);
    this.state().append(StateLine.parse({ t: "clock", activeMs }));
    this.accumulatedActiveMs = activeMs;
    this.activeSinceMs = nowMs;
    this.activeClockPaused = true;
    this.syncRecursiveUsage();
    this.emit({ type: "budget.snapshot", budget: this.budgetStateNow() });
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
        ...(budget.lifetimeSec === undefined ? {} : { lifetimeSec: budget.lifetimeSec }),
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

  async spawnRun(params: SpawnRunP, _ctx: CallContext): Promise<SpawnRunR> {
    this.enterOp();
    try {
      const recursive = this.recursive;
      if (recursive === undefined) {
        throw new BrokerError("DEPTH_EXCEEDED", "spawnRun is unavailable without trusted recursive run configuration");
      }
      if (recursive.depth === 2) {
        throw new BrokerError("DEPTH_EXCEEDED", "depth-2 runs cannot call spawnRun");
      }
      if (params.depth !== recursive.depth + 1) {
        throw new BrokerError("DEPTH_EXCEEDED", `depth-${recursive.depth} runs may spawn only depth-${recursive.depth + 1} children`);
      }

      let childAdmission: z.infer<typeof ChildRunAdmission>;
      try {
        const admitted = recursive.admitChildRun({
          parentRunId: this.config.runId,
          parentDepth: recursive.depth,
          request: params,
        });
        if (admitted === undefined) {
          throw new BrokerError("CHILD_ADMISSION_DENIED", "child run is outside the frozen development authority");
        }
        childAdmission = ChildRunAdmission.parse(admitted);
      } catch (error) {
        if (error instanceof BrokerError) throw error;
        throw new BrokerError("INTERNAL", `trusted child admission failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const wasReserved = recursive.ledger.hasChild(params.child.runId);
      if (!wasReserved) this.budgetGate();
      else this.state().assertUsable();
      const reservation = recursive.ledger.reserveChild(
        params,
        [...recursive.ancestors, this.config.runId],
        childAdmission,
      );
      if (reservation.settled !== undefined) return reservation.settled;

      const inFlight = this.inFlightChildRuns.get(params.child.runId);
      if (inFlight !== undefined) return await inFlight;
      const operation = this.launchAndSettleChild(
        reservation.request,
        reservation.admission,
        reservation.replay,
      );
      this.inFlightChildRuns.set(params.child.runId, operation);
      try {
        return await operation;
      } finally {
        if (this.inFlightChildRuns.get(params.child.runId) === operation) {
          this.inFlightChildRuns.delete(params.child.runId);
        }
      }
    } finally {
      this.exitOp();
    }
  }

  private async launchAndSettleChild(
    request: SpawnRunP,
    admission: z.infer<typeof ChildRunAdmission>,
    replay: boolean,
  ): Promise<SpawnRunR> {
    const recursive = this.recursive;
    if (recursive === undefined) throw new BrokerError("INTERNAL", "recursive launcher disappeared");
    const outcome = await recursive.launchChildRun({ request, admission, replay });
    const launchReceipt = this.readDurableLaunchReceipt(outcome.launchReceiptPath, request, admission);
    const terminal = this.readDurableChildTerminal(
      outcome.terminalEventPath,
      request,
      admission,
      launchReceipt.receiptDigest,
    );
    outcome.finalizeSettlement();
    recursive.ledger.syncRunUsage(request.child.runId, outcome.usage);
    return recursive.ledger.settleChild(request.child.runId, outcome.usage, terminal);
  }

  private readDurableLaunchReceipt(
    receiptPath: string,
    request: SpawnRunP,
    admission: z.infer<typeof ChildRunAdmission>,
  ): z.infer<typeof ChildRunLaunchReceipt> {
    let bytes: Buffer;
    const fd = openSync(receiptPath, "r");
    try {
      fsyncSync(fd);
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    journalIo.syncDir(path.dirname(receiptPath));
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
      throw new BrokerError("INTERNAL", "child launch receipt is not durably newline-terminated");
    }
    const lines = bytes.toString("utf8").split("\n");
    lines.pop();
    if (lines.length !== 1) throw new BrokerError("INTERNAL", "child launch receipt file must contain exactly one record");
    let receipt: z.infer<typeof ChildRunLaunchReceipt>;
    try {
      receipt = ChildRunLaunchReceipt.parse(JSON.parse(lines[0] ?? ""));
    } catch {
      throw new BrokerError("INTERNAL", "child launch receipt is malformed");
    }
    const { receiptDigest, ...body } = receipt;
    if (
      receiptDigest !== hashChildRunLaunchReceipt(body) ||
      !sameCanonical(receipt.child, request.child) ||
      receipt.depth !== request.depth ||
      !sameCanonical(receipt.admission, admission)
    ) {
      throw new BrokerError("INTERNAL", "child launch receipt does not match the durable reservation");
    }
    return receipt;
  }

  private readDurableChildTerminal(
    eventPath: string,
    request: SpawnRunP,
    admission: z.infer<typeof ChildRunAdmission>,
    launchReceiptDigest: string,
  ): z.infer<typeof ChildRunTerminal> {
    const expectedRunId = request.child.runId;
    let bytes: Buffer;
    let fd: number;
    try {
      fd = openSync(eventPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BrokerError("CHILD_PENDING", `child ${expectedRunId} has no durable terminal event`);
      }
      throw error;
    }
    try {
      fsyncSync(fd);
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    journalIo.syncDir(path.dirname(eventPath));
    if (bytes.length === 0) {
      throw new BrokerError("CHILD_PENDING", `child ${expectedRunId} has no durable terminal event`);
    }
    if (bytes[bytes.length - 1] !== 0x0a) {
      throw new BrokerError("INTERNAL", `child ${expectedRunId} terminal event is not durably newline-terminated`);
    }
    const rawLines = bytes.toString("utf8").split("\n");
    rawLines.pop();
    const events = rawLines.map((line, index) => {
      try {
        return RunEvent.parse(JSON.parse(line));
      } catch {
        throw new BrokerError("INTERNAL", `child ${expectedRunId} event stream is corrupt at cursor ${index}`);
      }
    });
    const started = events[0];
    if (
      started?.type !== "run.started" ||
      started.runId !== expectedRunId ||
      started.capsuleId !== request.child.capsuleId ||
      started.campaignConfigHash !== admission.campaignConfigHash ||
      started.optimizerDigest !== request.child.optimizerArtifact.hash ||
      events.some((event) => event.runId !== expectedRunId)
    ) {
      throw new BrokerError("INTERNAL", `child ${expectedRunId} event stream is not bound to its launch receipt`);
    }
    const cursor = events.length - 1;
    const event = events[cursor];
    const rawTerminal = rawLines[cursor];
    if (event === undefined || rawTerminal === undefined || event.type !== "run.finished") {
      throw new BrokerError("CHILD_PENDING", `child ${expectedRunId} has no durable terminal event`);
    }
    return ChildRunTerminal.parse({
      runId: expectedRunId,
      cursor,
      eventDigest: `sha256:${createHash("sha256").update(rawTerminal).digest("hex")}`,
      launchReceiptDigest,
      status: event.status,
    });
  }
  appendCorpusPanelEvidence(
    documentsInput: readonly z.infer<typeof CorpusPanelEvidence>[],
    ctx: CallContext,
  ): { corpusVersionHash: string } {
    if (!ctx.privileged) throw new BrokerError("INTERNAL", "appendCorpusPanelEvidence requires trusted authority");
    this.state().assertUsable();
    const corpus = this.corpus;
    if (corpus === undefined) throw new BrokerError("CORPUS_UNAVAILABLE", "no frozen corpus is configured");
    const latest = corpus.versions.get(corpus.latestVersionHash);
    if (latest === undefined) throw new BrokerError("INTERNAL", "latest corpus version is missing");
    const byId = new Map(latest.documents.map((document) => [document.id, document]));
    const added: z.infer<typeof CorpusPanelEvidence>[] = [];
    for (const documentInput of documentsInput) {
      const document = CorpusPanelEvidence.parse(documentInput);
      const existing = byId.get(document.id);
      if (existing !== undefined) {
        if (!sameCanonical(existing, document)) {
          throw new BrokerError("INTERNAL", "corpus evidence identity collision");
        }
        continue;
      }
      byId.set(document.id, document);
      added.push(document);
    }
    if (added.length === 0) return { corpusVersionHash: latest.versionHash };

    const next = this.deriveCorpusVersion(corpus, corpus.latestVersionHash, added);
    let chargedBytes = 1;
    const activeMs = this.activeWallClockMs();
    let line: StateLine;
    for (;;) {
      line = StateLine.parse({
        t: "corpusVersion",
        previousVersionHash: corpus.latestVersionHash,
        versionHash: next.versionHash,
        added,
        chargedBytes,
        activeMs,
      });
      const exact = Buffer.byteLength(`${JSON.stringify(line)}\n`, "utf8");
      if (exact === chargedBytes) break;
      chargedBytes = exact;
    }
    if (this.corpusJournalBytes + chargedBytes > corpus.maxJournalBytes) {
      throw new BrokerError("QUOTA_EXCEEDED", "corpus journal byte budget exhausted");
    }
    this.state().append(line);
    corpus.versions.set(next.versionHash, next);
    corpus.latestVersionHash = next.versionHash;
    this.corpusJournalBytes += chargedBytes;
    return { corpusVersionHash: next.versionHash };
  }

  queryCorpus(params: QueryCorpusP, _ctx: CallContext): QueryCorpusR {
    this.budgetGate();
    const corpus = this.corpus;
    if (corpus === undefined) {
      throw new BrokerError("CORPUS_UNAVAILABLE", "queryCorpus is unavailable without a frozen trusted corpus");
    }
    const response = this.corpusResponse(params, corpus);
    const transaction = this.corpusQueryTransaction(params, response);
    if (this.corpusJournalBytes + transaction.chargedBytes > corpus.maxJournalBytes) {
      throw new BrokerError("QUOTA_EXCEEDED", "corpus journal byte budget exhausted");
    }
    this.state().append(transaction.line);
    this.stagePublication(transaction.events);
    try {
      this.eventJournalFormat = true;
      this.journalEvents.push(...transaction.events);
      this.corpusJournalBytes += transaction.chargedBytes;
    } finally {
      this.publish(transaction.events);
    }
    return response;
  }

  private deriveCorpusVersion(
    corpus: FrozenCorpus,
    previousVersionHash: string,
    added: readonly z.infer<typeof CorpusPanelEvidence>[],
  ): FrozenCorpusVersion {
    if (corpus.latestVersionHash !== previousVersionHash) {
      throw new BrokerError("INTERNAL", "corpus version chain is not contiguous");
    }
    const previous = corpus.versions.get(previousVersionHash);
    if (previous === undefined) throw new BrokerError("INTERNAL", "previous corpus version is missing");
    const documents = [...previous.documents, ...added];
    validateCorpusProvenance(documents, corpus);
    return corpusVersion(corpus.snapshotHash, documents);
  }

  private corpusResponse(params: QueryCorpusP, corpus: FrozenCorpus): QueryCorpusR {
    const text = params.query.text.normalize("NFC").toLowerCase();
    const sources = [...new Set(params.query.sources)].sort();
    const queryDigest = createHash("sha256")
      .update(canonicalJson({ text, sources, pageSize: params.pageSize }))
      .digest("hex");
    let versionHash = corpus.latestVersionHash;
    let offset = 0;
    if (params.cursor !== null) {
      const parts = params.cursor.split("_");
      if (parts.length !== 4 || parts[0] !== "corpus" || parts[2] !== queryDigest) {
        throw new BrokerError("CURSOR_INVALID", "corpus cursor does not address this frozen query");
      }
      versionHash = `sha256:${parts[1] ?? ""}`;
      offset = Number(parts[3]);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new BrokerError("CURSOR_INVALID", "corpus cursor offset is invalid");
      }
    }
    const version = corpus.versions.get(versionHash);
    if (version === undefined) throw new BrokerError("CURSOR_INVALID", "corpus cursor version is unavailable");
    const sourceSet = new Set(sources);
    const matching = version.documents.filter(
      (document) =>
        sourceSet.has(document.source) &&
        (text.length === 0 || `${document.id}\n${document.content}`.normalize("NFC").toLowerCase().includes(text)),
    );
    if (offset > matching.length) throw new BrokerError("CURSOR_INVALID", "corpus cursor is beyond the deterministic result set");
    const cursorPrefix = `corpus_${version.versionHash.slice("sha256:".length)}_${queryDigest}_`;
    let end = Math.min(offset + params.pageSize, matching.length);
    let response: QueryCorpusR;
    for (;;) {
      response = QueryCorpusResult.parse({
        snapshotHash: corpus.snapshotHash,
        corpusVersionHash: version.versionHash,
        cursor: `${cursorPrefix}${offset}`,
        nextCursor: end < matching.length ? `${cursorPrefix}${end}` : null,
        documents: matching.slice(offset, end),
      });
      if (Buffer.byteLength(JSON.stringify(response), "utf8") <= corpus.maxPageBytes) break;
      if (end === offset) throw new BrokerError("QUOTA_EXCEEDED", "corpus response exceeds the page byte cap");
      end -= 1;
    }
    return response;
  }

  private corpusQueryTransaction(
    request: QueryCorpusP,
    response: QueryCorpusR,
  ): { line: StateLine; events: RunEvent[]; chargedBytes: number } {
    const at = new Date(this.now()).toISOString();
    const events = [
      RunEvent.parse({ runId: this.config.runId, at, type: "corpus.query", request }),
      RunEvent.parse({ runId: this.config.runId, at, type: "corpus.response", response }),
    ];
    const activeMs = this.activeWallClockMs();
    let chargedBytes = 1;
    let line: StateLine;
    for (;;) {
      line = StateLine.parse({ t: "corpus", request, response, chargedBytes, events, activeMs });
      const exact =
        Buffer.byteLength(`${JSON.stringify(line)}\n`, "utf8") +
        events.reduce((sum, event) => sum + Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8"), 0);
      if (exact === chargedBytes) break;
      chargedBytes = exact;
    }
    return { line, events, chargedBytes };
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
    try {
      this.spent.tokens += params.tokens;
      this.spent.usd += params.usd;
      this.syncRecursiveUsage();
    } finally {
      this.publish(events);
    }
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
   * runner's public log. A missing suffix is recoverable. Broker-exclusive
   * events always remain an exact prefix. Shared budget events may appear in
   * a different interleaving only when every exact journal event is already
   * present: historical supervisors synchronously paused the broker while
   * delivering an exact-cap snapshot, re-entering between two events in one
   * authority transaction. The sibling journal proves content and order;
   * missing or altered records still fail closed.
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
      this.appendState({ t: "migration", events: migrated });
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
    // journal record against the full public stream and permit a missing
    // suffix. Historical synchronous budget-abort re-entry could interleave a
    // later shared snapshot inside one journal transaction; accept that old
    // shape only when the complete exact journal multiset is present.
    const publicLines = alreadyLogged.map((event) => JSON.stringify(event));
    let cursor = 0;
    let missingAt: number | null = null;
    let nonPrefixGap = false;
    for (let index = 0; index < this.journalEvents.length; index += 1) {
      const found = publicLines.indexOf(JSON.stringify(this.journalEvents[index]), cursor);
      if (found >= 0) {
        if (missingAt !== null) {
          nonPrefixGap = true;
          break;
        }
        cursor = found + 1;
      } else {
        missingAt ??= index;
      }
    }
    if (nonPrefixGap) {
      const available = new Map<string, number>();
      for (const line of publicLines) available.set(line, (available.get(line) ?? 0) + 1);
      for (const event of this.journalEvents) {
        const line = JSON.stringify(event);
        const count = available.get(line) ?? 0;
        if (count === 0) {
          throw new BrokerError("INTERNAL", "broker event log has a non-prefix gap relative to the authority journal");
        }
        if (count === 1) available.delete(line);
        else available.set(line, count - 1);
      }
      return 0;
    }
    if (missingAt !== null) {
      // A real missing suffix has no occurrence anywhere in the public log.
      // Consume the matched journal prefix by multiplicity, then refuse an
      // out-of-order suffix record rather than appending a duplicate copy.
      const unmatchedPublic = new Map<string, number>();
      for (const line of publicLines) unmatchedPublic.set(line, (unmatchedPublic.get(line) ?? 0) + 1);
      for (let index = 0; index < missingAt; index += 1) {
        const line = JSON.stringify(this.journalEvents[index]);
        const count = unmatchedPublic.get(line) ?? 0;
        if (count === 0) {
          throw new BrokerError("INTERNAL", "broker event log has a non-prefix gap relative to the authority journal");
        }
        if (count === 1) unmatchedPublic.delete(line);
        else unmatchedPublic.set(line, count - 1);
      }
      for (const event of this.journalEvents.slice(missingAt)) {
        if ((unmatchedPublic.get(JSON.stringify(event)) ?? 0) > 0) {
          throw new BrokerError("INTERNAL", "broker event log has a non-prefix gap relative to the authority journal");
        }
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
 * Promotion holdouts are stricter than general same-visibility asset groups:
 * no terminal optimizer capability may reach any underlying holdout byte,
 * even through a second group name, nested root, symlink, or hard link.
 */
function assertPromotionHoldoutTerminalIsolation(
  manifest: CapsuleManifest,
  capsuleRootDir: string,
  split: z.infer<typeof PromotionHoldoutSplit>,
  terminalGroupIds: ReadonlySet<string>,
): void {
  if (terminalGroupIds.size === 0) return;
  const sealed = split.holdout.units.map((unit) => {
    const full = path.join(capsuleRootDir, unit.path);
    const link = lstatSync(full);
    if (link.isSymbolicLink()) {
      throw new BrokerError("INTERNAL", `promotion holdout unit ${unit.id} cannot be a symlink`);
    }
    const canonical = realpathSync.native(full);
    const identity = statSync(canonical);
    if (!identity.isFile()) {
      throw new BrokerError("INTERNAL", `promotion holdout unit ${unit.id} must be a regular file`);
    }
    return {
      id: unit.id,
      canonical,
      dev: identity.dev,
      ino: identity.ino,
      contentHash: unit.contentHash,
      containerHash: unit.containerHash,
    };
  });
  const sealedById = new Map(sealed.map((unit) => [unit.id, unit.contentHash]));
  const copiedLogicalUnit = (bytes: Buffer): string | undefined => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      return undefined;
    }
    const pending: unknown[] = [parsed];
    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== "object") continue;
      if ("id" in value && typeof value.id === "string") {
        const expected = sealedById.get(value.id);
        if (
          expected !== undefined
          && `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}` === expected
        ) {
          return value.id;
        }
      }
      pending.push(...(Array.isArray(value) ? value : Object.values(value)));
    }
    return undefined;
  };
  const refuseIfSealed = (candidatePath: string, groupId: string): void => {
    let link;
    try {
      link = lstatSync(candidatePath);
    } catch {
      throw new BrokerError(
        "INTERNAL",
        `terminal holdout group ${groupId} path is missing on host: ${path.relative(capsuleRootDir, candidatePath)}`,
      );
    }
    if (link.isSymbolicLink()) {
      throw new BrokerError(
        "INTERNAL",
        `terminal holdout group ${groupId} contains a symlink and cannot prove promotion holdout isolation`,
      );
    }
    const canonical = realpathSync.native(candidatePath);
    const identity = statSync(canonical);
    if (identity.isDirectory()) {
      for (const entry of readdirSync(candidatePath)) {
        refuseIfSealed(path.join(candidatePath, entry), groupId);
      }
      return;
    }
    if (!identity.isFile()) return;
    const bytes = readFileSync(candidatePath);
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const logicalUnitId = copiedLogicalUnit(bytes);
    const matched = sealed.find((unit) =>
      unit.canonical === canonical
      || (unit.dev === identity.dev && unit.ino === identity.ino)
      || unit.containerHash === fileHash
      || unit.contentHash === fileHash
      || unit.id === logicalUnitId
    );
    if (matched !== undefined) {
      throw new BrokerError(
        "INTERNAL",
        `terminal holdout group ${groupId} reaches promotion holdout unit ${matched.id}: `
        + "promotion holdout contents and scores must remain optimizer-invisible",
      );
    }
  };
  for (const groupId of terminalGroupIds) {
    const group = manifest.assetGroups.find((candidate) => candidate.id === groupId);
    if (group === undefined) throw new BrokerError("INTERNAL", `terminal holdout group ${groupId} is missing`);
    for (const root of group.paths) refuseIfSealed(path.join(capsuleRootDir, root), groupId);
  }
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
      // Same-visibility aliases are permitted here. Promotion holdout bytes
      // receive the stricter path/realpath/dev+ino terminal guard above.
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
