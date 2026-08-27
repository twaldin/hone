import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  CasStore,
  RecursiveResourceLedger,
  hashChildRunLaunchReceipt,
  packDirAsArtifact,
  readBrokerJournalEvaluations,
  type BrokerJournalEvaluationSnapshot,
  type BrokerRecursiveConfig,
  type ChildRunLaunchInput,
  type ChildRunLaunchOutcome,
  type TrustedChildAdmissionInput,
  type TrustedEvaluationStrategy,
} from "@hone/broker";
import {
  createProxy,
  DEFAULT_UPSTREAM,
  type DispatchRecoveryReport,
  type ProxyConfig,
} from "@hone/proxy";
import {
  MetaCampaignRunner,
  MetaEnvelopeFileRecordPortV1,
  MetaResourceEnvelopeLedger,
  campaignRecordExtends,
  campaignImageRepinRecordDigest,
  campaignSourceMigrationRecordDigest,
  metaCampaignConfigHash,
  mapBounded,
  selectDeterministicBest,
  trustedPhaseMeasurementEpoch,
  type CandidateGateResult,
  type MetaArtifactIdentity,
  type MetaCandidateGate,
  type MetaCandidateGateRequest,
  type MetaChildEnvelopeRequest,
  type MetaChildRunOutcome,
  type MetaChildRunRequest,
  type MetaChildSupervisor,
  type MetaControlTransformationReceipt,
  type MetaFailureSettlement,
  type MetaMeasurement,
  type MetaReservation,
  type MetaResourceUsage,
  type MetaWorkIdentity,
  type Sha256Digest,
} from "@hone/meta";
import {
  BudgetEnvelope as BudgetEnvelopeSchema,
  CampaignPauseSignal,
  CampaignResumeSignal,
  ChildRunAdmission,
  ChildRunLaunchReceipt,
  CapsuleManifest,
  DiagnosticOrderingReport,
  EvaluationRecord,
  CampaignImageEquivalenceEvidenceV1,
  CampaignImageDistributionPreregistrationV1,
  MetaCampaignConfigV1,
  MetaCampaignConfigV2,
  ProxyTraceRecord,
  RecursiveEvaluationPlan,
  SpawnRunParams,
  campaignSourceCommits,
  canonicalJson,
  capsuleDigest,
  deriveCapsuleId,
  type CampaignImageRepinV1,
  type CampaignImageStructuralNondeterminismProofV1,
  type CampaignOptimizerRefreezeV1,
  type CampaignOptimizerRunRefreezeV1,
  type CampaignSourceMigrationV1,
  type CampaignRuntimeClosureCaptureV1,
  type BudgetEnvelope,
  type ChildRunAdmission as ChildRunAdmissionRecord,
  type CampaignPauseSignal as CampaignPauseSignalRecord,
  type CampaignResumeSignal as CampaignResumeSignalRecord,
  type ProxyPreflightResult,
  type MetaCapsuleEntry,
  type MetaCampaignConfigV1 as MetaCampaignConfig,
  type MetaCampaignConfig as AnyMetaCampaignConfig,
  type MetaCampaignConfigV2 as RecursiveMetaCampaignConfig,
  type M2CorpusCohort,
  type SpawnRunParams as SpawnRunRequest,
} from "@hone/schema";
import { extractWorkspaceArtifact } from "../artifact.js";
import {
  admitCapsule,
  authenticateCapsuleSnapshot,
  capsuleOracleDigest,
  capsuleScalarizerDigest,
  readCapsuleSnapshot,
  type AdmittedCapsule,
} from "../admission.js";
import { loadCapsule } from "../capsule.js";
import { gate2ReceiptCitesAuthorizedBasis, verifyM2AuthorizedPartialCohort } from "../m2-cohort.js";
import {
  finalizeMetaHoldout,
  selectMetaTrainWinner,
  type MetaControlAuthentications,
  type MetaHoldoutDecision,
  type MetaMeasurementEpochs,
  type MetaOptimizerIdentity,
  type MetaPromotionIdentity,
  type MetaTrainWinnerSelection,
  type TrustedMetaMeasurementRow,
} from "@hone/scoring";
import { UsageError, boolFlag, parseFlags, strFlag } from "../args.js";
import { appendEvent, EVENTS_FILE, bestArtifact, readEvents, replayRun, writeFileDurable } from "../eventlog.js";
import { contractHash } from "../contract.js";
import type { CmdIo } from "../io.js";
import { MetaJournalV1, metaWorkKey } from "../meta-journal.js";
import {
  assertM2OuterDirectEnvelope,
  deriveM2OuterDirectEnvelope,
} from "../launch-draft.js";
import {
  persistMetaSearchTrajectory,
  persistTrajectoryWithoutMaskingSearchFailure,
} from "../meta-trajectory.js";
import {
  assembleG1Authorization,
  assembleG1Record,
  assembleG2Authorization,
  assembleG2Record,
  assertG1Authorized,
  assertG2Authorized,
  readG1Record,
  readG2Record,
  readConfirmationReceipt,
  readGateThresholdsFile,
  writeAuthorization,
  writeG1Record,
  writeG2Record,
  type HumanDecision,
} from "../gate-records.js";
import {
  buildBrokenMetaControl,
  buildDegradedMetaControl,
  captureMetaControlSourceSeal,
  type MetaControlArtifact,
  type MetaControlSourceSeal,
} from "../meta-controls.js";
import {
  readOptimizerArtifactSeal,
  replaceOptimizerArtifactSeal,
  resolveCandidateOptimizer,
  type OptimizerArtifactSeal,
  type ResolvedCandidateOptimizer,
} from "../optimizer-artifact.js";
import {
  collectOptimizerSnapshot,
  optimizerOverridden,
  snapshotDigest,
  type OptimizerSnapshot,
} from "../optimizer-digest.js";
import {
  conformCandidateOptimizer,
  type CandidateConformanceReceipt,
} from "../optimizer-conformance.js";
import { CONTRACT_FILE, casRoot, loadRunConfigFile, runsRoot } from "../runs.js";
import { verifiedBootRuntimeDigest } from "../runtime-digest.js";
import {
  acquireCampaignRecordLock,
  appendRuntimeClosureCaptureRecord,
  captureRuntimeClosure,
  parseSha256Sidecar,
  restoreRuntimeClosure,
  runtimeClosureCaptureRecord,
  withRuntimeClosureCapture,
} from "../runtime-closure.js";
import {
  assertRequiredPanelCapsuleSmoke,
  runPanelCapsuleSmoke,
} from "../campaign-capsule-smoke.js";
import type { CaptureRuntimeClosureResult } from "../runtime-closure.js";
import { RUNTIME_PIN_FILE, acquireRunLock, runCommand, type TrustedRunOptions } from "../supervisor.js";
import {
  appendPreAuthorityRefusalBreadcrumb,
  classifyPreAuthorityRefusal,
  extendPreAuthorityStderrTail,
} from "../pre-authority-breadcrumb.js";
import { z } from "zod";
import type { CampaignPauseAuthority, MutationWorkerPreflightContract } from "../types.js";

const HONE_USAGE = "usage: hone hone --campaign <path> --headless [--phase freeze|search|confirmation|holdout] [--out <gitignored-path>]";
const CAMPAIGN_MIGRATE_SOURCE_USAGE =
  "usage: hone campaign migrate-source --campaign <frozen.json> "
  + "--from <oldSourceCommit> --to <newSourceCommit> --reason <text> "
  + "[--refreeze-optimizer --sealed-base <dir>]";
const CAMPAIGN_REPIN_IMAGE_USAGE =
  "usage: hone campaign repin-image --campaign <frozen.json> --capsule <id> "
  + "--from-image <immutable-image> --to-image <immutable-image> "
  + "--evidence <equivalence-record.json> --reason <text>";
const CAMPAIGN_CAPTURE_CLOSURE_USAGE =
  "usage: hone campaign capture-closure --campaign <frozen.json> --source <git-worktree> "
  + "[--source-commit <historicalCommit>] [--cas <dir>] "
  + "[--node-modules-archive <tar.zst> --archive-sha256 <sidecar>] "
  + "[--optimizer-base-digest sha256:<64hex>] [--at <iso-time>] [--restore <target> "
  + "--verify-image <immutable-image> --verify-digest sha256:<64hex>] [--dry-run]";
const CAMPAIGN_RESTORE_CLOSURE_USAGE =
  "usage: hone campaign restore-closure --campaign <frozen.json> --target <empty-path> "
  + "[--cas <dir>] [--manifest sha256:<64hex>]";
const CAMPAIGN_SMOKE_CAPSULES_USAGE =
  "usage: hone campaign smoke-capsules --campaign <frozen.json> --evidence <receipt.json>";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROXY_TRACE_FILE = "proxy-trace.ndjson";
const CampaignPauseAuthorityFileV1 = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().default(0),
  configHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  active: z.array(CampaignPauseSignal),
  resumed: z.array(CampaignResumeSignal),
}).strict();
type CampaignPauseAuthorityStateV1 = z.infer<typeof CampaignPauseAuthorityFileV1>;
const CampaignPauseLockOwner = z.object({
  pid: z.number().int().positive(),
  createdAtMs: z.number().int().nonnegative(),
  nonce: z.string().uuid(),
}).strict();
type CampaignPauseLockOwner = z.infer<typeof CampaignPauseLockOwner>;
const CAMPAIGN_PAUSE_LOCK_WAIT_MS = 5_000;

function systemErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return systemErrorCode(error) === "EPERM";
  }
}


export interface CampaignResumeProxy {
  campaignPause(): Promise<CampaignPauseSignalRecord | undefined>;
  dispatchRecovery(): Promise<DispatchRecoveryReport>;
  resume(): Promise<ProxyPreflightResult>;
  close(): Promise<void>;
  listenTcp(port: number, host?: string): Promise<number>;
}

export interface CampaignResumeCoordinatorRequest {
  /** Exact durable authority file selected by the trusted command surface. */
  readonly authorityPath: string;
  readonly pauseId: string;
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface CampaignResumeCoordinatorOptions {
  readonly createProxy?: (config: ProxyConfig) => CampaignResumeProxy;
}

export interface CampaignResumeCoordinatorResult {
  readonly pause: CampaignPauseSignalRecord;
  readonly preflight: ProxyPreflightResult;
}

/**
 * The sole campaign resume transition: reconstruct the originating run's
 * frozen proxy routes, preflight both M2 routes while admission stays closed,
 * and durably clear exactly the selected pause only after that proof passes.
 */
export async function coordinateCampaignResume(
  request: CampaignResumeCoordinatorRequest,
  options: CampaignResumeCoordinatorOptions = {},
): Promise<CampaignResumeCoordinatorResult> {
  const authority = DurableCampaignPauseAuthorityV1.openExisting(request.authorityPath);
  const pause = authority.activePauses().find((candidate) => candidate.pauseId === request.pauseId);
  if (pause === undefined) throw new UsageError(`campaign pause ${request.pauseId} is no longer active`);
  const runDir = join(runsRoot(request.root), pause.runId);
  const state = replayRun(runDir);
  if (state.runId !== pause.runId || state.finished !== null) {
    throw new UsageError(`campaign pause belongs to unavailable run ${pause.runId}`);
  }
  const config = loadRunConfigFile(runDir);
  const budget = state.lastBudget ?? {
    envelope: config.budget,
    spent: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
  };
  const baseRemaining = {
    tokens: Math.max(0, budget.envelope.maxTokens - budget.spent.tokens),
    usd: Math.max(0, budget.envelope.maxUsd - budget.spent.usd),
  };
  let recoveryComplete = false;
  let journalDeficit = { tokens: 0, usd: 0 };
  const preflightSpend = { tokens: 0, usd: 0 };
  const proxy = (options.createProxy ?? createProxy)({
    runId: pause.runId,
    routing: config.routing,
    runDir,
    casDir: casRoot(request.root),
    upstreamBaseUrl: request.env["HONE_UPSTREAM_BASE_URL"] ?? DEFAULT_UPSTREAM,
    ...(request.env["HONE_UPSTREAM_API_KEY"] === undefined
      ? {}
      : { upstreamApiKey: request.env["HONE_UPSTREAM_API_KEY"] }),
    checkBudget: () => ({
      allowed: true,
      remaining: {
        tokens: Math.max(0, baseRemaining.tokens - journalDeficit.tokens - preflightSpend.tokens),
        usd: Math.max(0, baseRemaining.usd - journalDeficit.usd - preflightSpend.usd),
      },
    }),
    // Recovery totals establish the durable journal floor. Settlements after
    // recovery are accumulated so route 2 observes route 1's exact charge.
    // The next trusted run resume reconciles the journal's absolute total.
    recordSpend: (spend) => {
      if (!recoveryComplete) return;
      preflightSpend.tokens += spend.tokens;
      preflightSpend.usd += spend.usd;
    },
    captureCampaignDispatchFence: () => authority.captureCampaignDispatchFence(),
    validateCampaignDispatchFence: (epoch, validation) =>
      authority.validateCampaignDispatchFence(epoch, validation),
    recordCampaignPause: (signal) => authority.recordCampaignPause(signal),
    recordCampaignResume: (signal) => authority.recordCampaignResume(signal),
  });
  await proxy.listenTcp(0);
  try {
    const recovery = await proxy.dispatchRecovery();
    if (recovery.poisoned !== undefined) {
      throw new UsageError(`campaign proxy dispatch journal is poisoned: ${recovery.poisoned}`);
    }
    journalDeficit = {
      tokens: Math.max(0, recovery.chargedTotals.tokens - budget.spent.tokens),
      usd: Math.max(0, recovery.chargedTotals.usd - budget.spent.usd),
    };
    recoveryComplete = true;
    const localPause = await proxy.campaignPause();
    if (localPause === undefined || localPause.pauseId !== pause.pauseId) {
      throw new UsageError("run-local proxy pause does not match the campaign authority");
    }
    const preflight = await proxy.resume();
    if (preflight.passed && authority.isCampaignPaused()) {
      throw new UsageError("frozen-route preflight passed without durably resuming campaign authority");
    }
    return { pause, preflight };
  } finally {
    await proxy.close();
  }
}
/** Durable campaign-wide pause set shared by every recursive runner/proxy. */
export class DurableCampaignPauseAuthorityV1 implements CampaignPauseAuthority {
  private readonly active = new Map<string, CampaignPauseSignalRecord>();
  private readonly resumed = new Map<string, CampaignResumeSignalRecord>();
  private revision = 0;

  private constructor(
    readonly path: string,
    readonly configHash: string,
  ) {}

  static open(path: string, configHash: Sha256Digest): DurableCampaignPauseAuthorityV1 {
    const authority = new DurableCampaignPauseAuthorityV1(path, configHash);
    if (!existsSync(path)) {
      authority.persist();
      return authority;
    }
    const state = CampaignPauseAuthorityFileV1.parse(JSON.parse(readFileSync(path, "utf8")));
    if (state.configHash !== configHash) {
      throw new UsageError(`campaign pause authority belongs to foreign config ${state.configHash}`);
    }
    authority.hydrate(state);
    return authority;
  }

  static openExisting(path: string): DurableCampaignPauseAuthorityV1 {
    if (!existsSync(path)) throw new UsageError(`campaign pause authority does not exist: ${path}`);
    const state = CampaignPauseAuthorityFileV1.parse(JSON.parse(readFileSync(path, "utf8")));
    const authority = new DurableCampaignPauseAuthorityV1(path, state.configHash);
    authority.hydrate(state);
    return authority;
  }

  private hydrate(state: CampaignPauseAuthorityStateV1): void {
    this.active.clear();
    this.resumed.clear();
    this.revision = state.revision;
    for (const signal of state.active) {
      if (this.active.has(signal.pauseId)) throw new Error(`duplicate active campaign pause ${signal.pauseId}`);
      this.active.set(signal.pauseId, signal);
    }
    for (const signal of state.resumed) {
      if (this.resumed.has(signal.pauseId) || this.active.has(signal.pauseId)) {
        throw new Error(`campaign pause ${signal.pauseId} has conflicting durable states`);
      }
      this.resumed.set(signal.pauseId, signal);
    }
  }

  private refresh(): void {
    const state = CampaignPauseAuthorityFileV1.parse(JSON.parse(readFileSync(this.path, "utf8")));
    if (state.configHash !== this.configHash) {
      throw new UsageError(`campaign pause authority belongs to foreign config ${state.configHash}`);
    }
    this.hydrate(state);
  }

  isCampaignPaused(): boolean {
    this.refresh();
    return this.active.size > 0;
  }

  activePauses(): readonly CampaignPauseSignalRecord[] {
    this.refresh();
    return [...this.active.values()].sort((left, right) => left.pauseId.localeCompare(right.pauseId));
  }

  captureCampaignDispatchFence(): { epoch: string; paused: boolean } {
    this.refresh();
    return { epoch: String(this.revision), paused: this.active.size > 0 };
  }

  validateCampaignDispatchFence(epoch: string, validation: { allowPaused: boolean }): boolean {
    this.refresh();
    return String(this.revision) === epoch && (validation.allowPaused || this.active.size === 0);
  }


  private withMutationLock<T>(operation: () => T): T {
    const lockPath = `${this.path}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    const deadline = Date.now() + CAMPAIGN_PAUSE_LOCK_WAIT_MS;
    const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    while (true) {
      let created = false;
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        created = true;
        writeFileSync(ownerPath, `${canonicalJson({
          pid: process.pid,
          createdAtMs: Date.now(),
          nonce: randomUUID(),
        })}\n`, { mode: 0o600 });
        break;
      } catch (error) {
        if (created) {
          rmSync(lockPath, { recursive: true, force: true });
          throw error;
        }
        if (systemErrorCode(error) !== "EEXIST") throw error;
        let stale = false;
        let observedOwner: CampaignPauseLockOwner | null = null;
        try {
          observedOwner = CampaignPauseLockOwner.parse(JSON.parse(readFileSync(ownerPath, "utf8")));
          stale = !pidIsAlive(observedOwner.pid);
        } catch {
          try {
            stale = Date.now() - statSync(lockPath).mtimeMs >= CAMPAIGN_PAUSE_LOCK_WAIT_MS;
          } catch {
            continue;
          }
        }
        if (stale) {
          throw new Error(
            `campaign pause authority has a stale mutation lock; verify no campaign process is live, then remove ${lockPath}`,
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(`campaign pause authority mutation lock is busy: ${lockPath}`);
        }
        Atomics.wait(waitCell, 0, 0, 10);
      }
    }
    try {
      this.refresh();
      return operation();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }

  recordCampaignPause(signalInput: CampaignPauseSignalRecord): void {
    const signal = CampaignPauseSignal.parse(signalInput);
    this.withMutationLock(() => {
      const active = this.active.get(signal.pauseId);
      if (active !== undefined) {
        if (canonicalJson(active) !== canonicalJson(signal)) {
          throw new Error(`campaign pause ${signal.pauseId} changed identity`);
        }
        return;
      }
      if (this.resumed.has(signal.pauseId)) {
        throw new Error(`campaign pause ${signal.pauseId} was already durably resumed`);
      }
      const nextActive = new Map(this.active);
      nextActive.set(signal.pauseId, signal);
      const nextRevision = this.revision + 1;
      this.persistState(nextActive, this.resumed, nextRevision);
      this.active.set(signal.pauseId, signal);
      this.revision = nextRevision;
    });
  }

  recordCampaignResume(signalInput: CampaignResumeSignalRecord): void {
    const signal = CampaignResumeSignal.parse(signalInput);
    this.withMutationLock(() => {
      const prior = this.resumed.get(signal.pauseId);
      if (prior !== undefined) {
        if (canonicalJson(prior) !== canonicalJson(signal)) {
          throw new Error(`campaign resume ${signal.pauseId} changed identity`);
        }
        return;
      }
      const paused = this.active.get(signal.pauseId);
      if (paused === undefined || paused.runId !== signal.runId) {
        throw new Error(`campaign resume ${signal.pauseId} has no matching active pause`);
      }
      const nextActive = new Map(this.active);
      const nextResumed = new Map(this.resumed);
      nextActive.delete(signal.pauseId);
      nextResumed.set(signal.pauseId, signal);
      const nextRevision = this.revision + 1;
      this.persistState(nextActive, nextResumed, nextRevision);
      this.active.delete(signal.pauseId);
      this.resumed.set(signal.pauseId, signal);
      this.revision = nextRevision;
    });
  }

  private persist(): void {
    this.persistState(this.active, this.resumed, this.revision);
  }

  private persistState(
    active: ReadonlyMap<string, CampaignPauseSignalRecord>,
    resumed: ReadonlyMap<string, CampaignResumeSignalRecord>,
    revision: number,
  ): void {
    const byPauseId = <T extends { pauseId: string }>(left: T, right: T): number =>
      left.pauseId.localeCompare(right.pauseId);
    writeFileDurable(this.path, `${canonicalJson({
      version: 1,
      revision,
      configHash: this.configHash,
      active: [...active.values()].sort(byPauseId),
      resumed: [...resumed.values()].sort(byPauseId),
    })}\n`);
    chmodSync(this.path, 0o600);
  }
}

/** Synchronous fence consulted before any recursive child reservation or launch. */
export function campaignChildAdmissionAllowed(authority: CampaignPauseAuthority): boolean {
  return !authority.isCampaignPaused();
}
export interface CapsuleLocation {
  dir: string;
  digest: string;
  executionImage: string;
  terminalHoldoutAssetGroupIds: readonly string[];
}

function sha256(bytes: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bounded(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�").slice(0, 4_096);
}

function legacyMeasurementRows(rows: readonly MetaMeasurement[]): TrustedMetaMeasurementRow[] {
  const legacy: TrustedMetaMeasurementRow[] = [];
  for (const row of rows) {
    switch (row.arm) {
      case "candidate":
      case "seed":
      case "winner":
      case "broken-control":
      case "degraded-control":
        legacy.push({ ...row, arm: row.arm });
        break;
      default:
        break;
    }
  }
  return legacy;
}

function registeredMutablePath(config: AnyMetaCampaignConfig, candidatePath: string): boolean {
  return config.mutablePaths.some((configured) => {
    const normalized = configured.replace(/^\.\//, "").replace(/^optimizer\//, "").replace(/\/+$/, "");
    return candidatePath === normalized || candidatePath.startsWith(`${normalized}/`);
  });
}

/** Freeze-time guard: every configured mutable path must select at least one sealed optimizer file. */
export function assertMutablePathsResolve(
  mutablePaths: readonly string[],
  snapshot: OptimizerSnapshot,
): void {
  const optimizerPaths = [...snapshot.files.keys()]
    .filter((candidatePath) =>
      candidatePath.startsWith("optimizer/src/") || candidatePath.startsWith("optimizer/assets/"))
    .map((candidatePath) => candidatePath.slice("optimizer/".length));
  const unresolved = mutablePaths.filter((configured) => {
    const normalized = configured.replace(/^\.\//, "").replace(/^optimizer\//, "").replace(/\/+$/, "");
    return !optimizerPaths.some((candidatePath) =>
      candidatePath === normalized || candidatePath.startsWith(`${normalized}/`));
  });
  if (unresolved.length > 0) {
    throw new UsageError(`mutable paths do not select a sealed optimizer file: ${unresolved.join(", ")}`);
  }
}

/** Freeze-time guard: every optimizer-local protected path must select sealed source. */
export function assertOptimizerProtectedPathsResolve(
  protectedPaths: readonly string[],
  snapshot: OptimizerSnapshot,
): void {
  const optimizerPaths = [...snapshot.files.keys()]
    .filter((candidatePath) => candidatePath.startsWith("optimizer/"))
    .map((candidatePath) => candidatePath.slice("optimizer/".length));
  const unresolved = protectedPaths
    .map((configured) => configured.replace(/^\.\//, ""))
    .filter((configured) => configured.startsWith("optimizer/"))
    .filter((configured) => {
      const normalized = configured.replace(/^optimizer\//, "").replace(/\/+$/, "");
      return !optimizerPaths.some((candidatePath) =>
        candidatePath === normalized || candidatePath.startsWith(`${normalized}/`));
    });
  if (unresolved.length > 0) {
    throw new UsageError(`protected paths do not select a sealed optimizer file: ${unresolved.join(", ")}`);
  }
}

const ConformanceReceiptSchema = z.object({
  version: z.literal(1),
  sourceArtifact: z.string().regex(SHA256_PATTERN),
  baseDigest: z.string().regex(SHA256_PATTERN),
  mutablePaths: z.record(z.string().regex(SHA256_PATTERN)),
  runtime: z.object({
    version: z.literal(1),
    image: z.string().min(1),
    optimizerDigest: z.string().regex(SHA256_PATTERN),
    buildContractDigest: z.string().regex(SHA256_PATTERN),
    bundleDigest: z.string().regex(SHA256_PATTERN),
    bundleFiles: z.record(z.object({
      sha256: z.string().regex(SHA256_PATTERN),
      size: z.number().int().nonnegative(),
    }).strict()),
    runtimeArgv: z.array(z.string()),
    runtimeDigest: z.string().regex(SHA256_PATTERN),
  }).strict(),
  protocol: z.object({
    version: z.literal("jsonrpc-2.0"),
    methods: z.tuple([z.literal("getTask"), z.literal("getBudget"), z.literal("finish")]),
    modelEgress: z.literal(false),
    childReservations: z.literal(0),
  }).strict(),
  receiptDigest: z.string().regex(SHA256_PATTERN),
}).strict();

interface RegisteredControl {
  readonly sourceArtifact: Sha256Digest;
  readonly bundleDigest: Sha256Digest;
  readonly transformationReceipt: MetaControlTransformationReceipt;
}

function conformanceReceiptDigest(receipt: CandidateConformanceReceipt): Sha256Digest {
  const { receiptDigest: _receiptDigest, ...body } = receipt;
  return sha256(canonicalJson(body));
}

function changedOptimizerPaths(base: OptimizerSnapshot, selected: OptimizerSnapshot): string[] {
  const changed: string[] = [];
  const allPaths = new Set([...base.files.keys(), ...selected.files.keys()]);
  for (const fullPath of allPaths) {
    if (!fullPath.startsWith("optimizer/src/") && !fullPath.startsWith("optimizer/assets/")) continue;
    const before = base.files.get(fullPath);
    const after = selected.files.get(fullPath);
    if (before === undefined || after === undefined || before.mode !== after.mode || !before.bytes.equals(after.bytes)) {
      changed.push(fullPath.slice("optimizer/".length));
    }
  }
  return changed.sort();
}

function exactControlReceipt(left: MetaControlTransformationReceipt, right: MetaControlTransformationReceipt): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function conformanceFile(
  campaignDir: string,
  sourceArtifact: Sha256Digest,
  baseDigest: Sha256Digest,
): string {
  return join(
    campaignDir,
    `conformance-${sourceArtifact.slice("sha256:".length)}-${baseDigest.slice("sha256:".length)}.json`,
  );
}

function readConformanceReceipt(file: string): CandidateConformanceReceipt {
  const parsed = ConformanceReceiptSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const receipt: CandidateConformanceReceipt = parsed;
  const expected = conformanceReceiptDigest(receipt);
  if (receipt.receiptDigest !== expected) {
    throw new UsageError(`candidate conformance receipt ${file} has digest ${receipt.receiptDigest}, expected ${expected}`);
  }
  return receipt;
}

interface CandidateGateOptions {
  readonly casDir: string;
  readonly campaignDir: string;
  readonly config: AnyMetaCampaignConfig;
  readonly baseSnapshot: OptimizerSnapshot;
  readonly comparisonImage: string;
  readonly controls: readonly RegisteredControl[];
}

/** Seal accepted candidate bytes against the image that will actually boot them. */
export function imageBoundCandidateBundleDigest(
  snapshot: OptimizerSnapshot,
  image: string,
): Sha256Digest {
  return snapshotDigest(image, snapshot) as Sha256Digest;
}

interface RecursiveCandidateGate extends MetaCandidateGate {
  bundleDigestForImage(sourceArtifact: Sha256Digest, image: string): Sha256Digest;
}

class CliCandidateGate implements RecursiveCandidateGate {
  private readonly baseDigest: Sha256Digest;
  private readonly controls = new Map<Sha256Digest, RegisteredControl>();
  private readonly receipts = new Map<Sha256Digest, CandidateConformanceReceipt>();
  private readonly bundleOwners = new Map<Sha256Digest, Sha256Digest>();
  private readonly resolvedCandidateSnapshots = new Map<Sha256Digest, OptimizerSnapshot>();
  private readonly inFlight = new Map<Sha256Digest, Promise<CandidateGateResult>>();

  constructor(private readonly opts: CandidateGateOptions) {
    this.baseDigest = snapshotDigest(opts.comparisonImage, opts.baseSnapshot) as Sha256Digest;
    for (const control of opts.controls) this.controls.set(control.sourceArtifact, control);
    const historicalBaseDigests = new Set(
      (opts.config.sourceMigrationJournal?.migrations ?? [])
        .flatMap((migration) => migration.optimizerRefreeze === undefined
          ? []
          : [migration.optimizerRefreeze.fromOptimizerBaseDigest]),
    );
    for (const entry of readdirSync(opts.campaignDir)) {
      if (!/^conformance-[0-9a-f]{64}(?:-[0-9a-f]{64})?\.json$/.test(entry)) continue;
      const receipt = readConformanceReceipt(join(opts.campaignDir, entry));
      if (receipt.baseDigest !== this.baseDigest) {
        if (historicalBaseDigests.has(receipt.baseDigest)) continue;
        throw new UsageError(`candidate conformance receipt ${entry} has an unjournaled optimizer base`);
      }
      if (
        receipt.runtime.image !== opts.comparisonImage
        || receipt.runtime.optimizerDigest.length === 0
      ) {
        throw new UsageError(`candidate conformance receipt ${entry} does not belong to the frozen campaign seed/image`);
      }
      const sourceArtifact = receipt.sourceArtifact as Sha256Digest;
      const bundleDigest = receipt.runtime.optimizerDigest as Sha256Digest;
      const prior = this.bundleOwners.get(bundleDigest);
      if (prior !== undefined && prior !== sourceArtifact) {
        throw new UsageError(`candidate conformance receipts alias bundle ${bundleDigest}`);
      }
      this.receipts.set(sourceArtifact, receipt);
      this.bundleOwners.set(bundleDigest, sourceArtifact);
    }
  }

  async check(request: MetaCandidateGateRequest): Promise<CandidateGateResult> {
    const existing = this.inFlight.get(request.sourceArtifact);
    if (existing !== undefined) return await existing;
    const pending = this.checkOnce(request);
    this.inFlight.set(request.sourceArtifact, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(request.sourceArtifact) === pending) this.inFlight.delete(request.sourceArtifact);
    }
  }

  /**
   * Conformance runs once on the comparison image, while snapshot identity
   * deliberately includes the target image. Child receipts must therefore
   * seal this image-bound digest, not the comparison-image digest.
   */
  bundleDigestForImage(sourceArtifact: Sha256Digest, image: string): Sha256Digest {
    const snapshot = this.resolvedCandidateSnapshots.get(sourceArtifact);
    if (snapshot === undefined) {
      throw new UsageError(`candidate ${sourceArtifact} has no accepted conformance result`);
    }
    return imageBoundCandidateBundleDigest(snapshot, image);
  }

  private async checkOnce(request: MetaCandidateGateRequest): Promise<CandidateGateResult> {
    let selected: ResolvedCandidateOptimizer;
    try {
      selected = await resolveCandidateOptimizer({
        casDir: this.opts.casDir,
        artifactHash: request.sourceArtifact,
        image: this.opts.comparisonImage,
        baseSnapshot: this.opts.baseSnapshot,
      });
    } catch (error) {
      return { ok: false, feedback: bounded(`candidate artifact refused: ${error instanceof Error ? error.message : String(error)}`) };
    }
    const bundleDigest = selected.mergedDigest as Sha256Digest;

    let transformationReceiptHash: Sha256Digest | null = null;
    if (request.mode === "public-mutable") {
      const changed = changedOptimizerPaths(this.opts.baseSnapshot, selected.snapshot);
      const forbidden = changed.filter((candidatePath) => !registeredMutablePath(this.opts.config, candidatePath));
      if (forbidden.length > 0) {
        return { ok: false, feedback: `candidate changes paths outside the frozen mutable allowlist: ${forbidden.join(", ")}` };
      }
      const owner = this.bundleOwners.get(bundleDigest);
      if (owner !== undefined && owner !== request.sourceArtifact) {
        return { ok: false, feedback: `candidate is byte-equivalent to the already registered optimizer ${owner}` };
      }
    } else {
      const registered = this.controls.get(request.sourceArtifact);
      if (
        registered === undefined
        || registered.bundleDigest !== request.bundleDigest
        || request.bundleDigest !== bundleDigest
        || !exactControlReceipt(registered.transformationReceipt, request.transformationReceipt)
      ) {
        return { ok: false, feedback: "trusted control does not match its frozen source, bundle, and transformation receipt" };
      }
      transformationReceiptHash = sha256(canonicalJson(request.transformationReceipt));
    }

    try {
      await this.ensureConformed(selected, bundleDigest);
    } catch (error) {
      return { ok: false, feedback: bounded(`candidate conformance failed: ${error instanceof Error ? error.message : String(error)}`) };
    }
    this.bundleOwners.set(bundleDigest, request.sourceArtifact);
    this.resolvedCandidateSnapshots.set(request.sourceArtifact, selected.snapshot);
    const changedCount = changedOptimizerPaths(this.opts.baseSnapshot, selected.snapshot).length;
    return {
      ok: true,
      sourceArtifact: request.sourceArtifact,
      bundleDigest,
      transformationReceiptHash,
      feedback: changedCount === 0
        ? "candidate is byte-identical to the registered seed"
        : `candidate changes ${changedCount} frozen optimizer file(s) and passed the trusted build/protocol check`,
    };
  }

  private async ensureConformed(candidate: ResolvedCandidateOptimizer, bundleDigest: Sha256Digest): Promise<void> {
    const sourceArtifact = candidate.sourceArtifact as Sha256Digest;
    const cached = this.receipts.get(sourceArtifact);
    if (cached !== undefined) {
      if (
        cached.baseDigest !== candidate.baseDigest
        || cached.runtime.image !== this.opts.comparisonImage
        || cached.runtime.optimizerDigest !== bundleDigest
        || canonicalJson(cached.mutablePaths) !== canonicalJson(candidate.mutablePaths)
      ) {
        throw new UsageError("durable candidate conformance receipt does not reproduce the resolved optimizer");
      }
      return;
    }
    const receipt = await conformCandidateOptimizer(candidate, this.opts.comparisonImage);
    if (receipt.receiptDigest !== conformanceReceiptDigest(receipt)) {
      throw new UsageError("candidate conformance returned an invalid receipt digest");
    }
    const file = conformanceFile(this.opts.campaignDir, sourceArtifact, candidate.baseDigest as Sha256Digest);
    writeFileDurable(file, `${canonicalJson(receipt)}\n`);
    chmodSync(file, 0o600);
    this.receipts.set(sourceArtifact, receipt);
  }
}

const ZERO_USAGE: Readonly<MetaResourceUsage> = {
  tokens: 0,
  usd: 0,
  wallClockSec: 0,
  evaluatorInvocations: 0,
};

function priorAttemptSpend(request: MetaChildRunRequest): MetaResourceUsage {
  return {
    tokens: request.reservation.reserved.maxTokens - request.remainingBudget.maxTokens,
    usd: request.reservation.reserved.maxUsd - request.remainingBudget.maxUsd,
    wallClockSec: request.reservation.reserved.maxWallClockSec - request.remainingBudget.maxWallClockSec,
    evaluatorInvocations: request.reservation.reserved.maxEvaluatorInvocations - request.remainingBudget.maxEvaluatorInvocations,
  };
}

function addUsage(left: MetaResourceUsage, right: MetaResourceUsage): MetaResourceUsage {
  return {
    tokens: left.tokens + right.tokens,
    usd: left.usd + right.usd,
    wallClockSec: left.wallClockSec + right.wallClockSec,
    evaluatorInvocations: left.evaluatorInvocations + right.evaluatorInvocations,
  };
}
export interface TrustedChildDispatchPolicy {
  readonly promotion: AnyMetaCampaignConfig["promotion"];
  readonly proxyRole?: "inner-capsule-improvement";
  readonly campaignConfigHash?: Sha256Digest;
  readonly mutationWorkerPreflightContract?: MutationWorkerPreflightContract;
  readonly evaluatorTimeoutSec?: number;
  readonly sessionNoYieldMaxTokens?: number;
}

export function campaignChildDispatchPolicy(
  config: AnyMetaCampaignConfig,
  trusted: Omit<TrustedChildDispatchPolicy, "promotion" | "sessionNoYieldMaxTokens"> = {},
): TrustedChildDispatchPolicy {
  return {
    promotion: config.promotion,
    ...(config.sessionNoYieldMaxTokens === undefined
      ? {}
      : { sessionNoYieldMaxTokens: config.sessionNoYieldMaxTokens }),
    ...trusted,
  };
}

export function writeCampaignOuterRunConfig(
  configPath: string,
  config: AnyMetaCampaignConfig,
  seed?: number,
): void {
  writeFileDurable(configPath, `${JSON.stringify({
    routing: { mutation: { model: config.routing.outerMutation } },
    apply: "none",
    headless: true,
    ...(seed === undefined ? {} : { seed }),
    budget: config.budgets.outer,
    promotion: config.promotion,
    ...(config.sessionNoYieldMaxTokens === undefined
      ? {}
      : { sessionNoYieldMaxTokens: config.sessionNoYieldMaxTokens }),
  }, null, 2)}\n`);
  chmodSync(configPath, 0o600);
}


export class CliChildSupervisor implements MetaChildSupervisor {
  constructor(
    private readonly io: CmdIo,
    private readonly dispatchPolicy: TrustedChildDispatchPolicy,
    private readonly campaignDir: string,
    private readonly capsules: ReadonlyMap<string, CapsuleLocation>,
    private readonly baseSnapshot: OptimizerSnapshot,
    private readonly modelRegistry: CampaignModelRegistry,
    private readonly campaignPauseAuthority?: CampaignPauseAuthority,
    private readonly breadcrumbDir: string = campaignDir,
  ) {}

  async run(request: MetaChildRunRequest): Promise<MetaChildRunOutcome> {
    return await this.runLaunched(request, this.dispatchPolicy.campaignConfigHash);
  }

  /** Production child-command seam; overridden only by boundary tests. */
  protected async runChildCommand(args: string[], io: CmdIo, trusted: TrustedRunOptions): Promise<number> {
    return await runCommand(args, io, trusted);
  }

  private async runChildProcess(
    request: MetaChildRunRequest,
    executionRunId: string,
    runDir: string,
    mode: "start" | "resume",
    args: string[],
    trusted: TrustedRunOptions,
  ): Promise<number> {
    let stderrTail = "";
    const baseIo = this.childIo();
    const diagnosticIo: CmdIo = {
      ...baseIo,
      err: (line) => {
        baseIo.err(line);
        stderrTail = extendPreAuthorityStderrTail(stderrTail, line);
      },
    };
    let code: number;
    try {
      code = await this.runChildCommand(args, diagnosticIo, trusted);
    } catch (error) {
      diagnosticIo.err(
        `child command failed before terminalization: ${error instanceof Error ? error.message : String(error)}`,
      );
      code = 1;
    }
    if (code === 0) return code;

    let journalAuthorityEstablished = false;
    try {
      readBrokerJournalEvaluations(runDir);
      journalAuthorityEstablished = true;
    } catch {
      // Absence, a torn tail, or an unreadable journal is not established authority.
    }
    if (journalAuthorityEstablished) return code;

    const diagnostic = stderrTail.length > 0
      ? stderrTail
      : `child command exited ${code} without diagnostic stderr\n`;
    try {
      appendPreAuthorityRefusalBreadcrumb(this.breadcrumbDir, {
        childRunId: request.reservation.childRunId,
        exitCode: code,
        reasonClass: classifyPreAuthorityRefusal(diagnostic),
        stderrTail: diagnostic,
        launch: {
          executionRunId,
          mode,
          attempt: request.attempt,
          phase: request.identity.phase,
          arm: request.identity.arm,
          replicate: request.identity.replicate,
          measurementEpoch: request.identity.measurementEpoch,
          capsuleId: request.capsule.capsuleId,
          capsuleDigest: request.capsule.capsuleDigest,
          sourceArtifact: request.sourceArtifact,
          bundleDigest: request.bundleDigest,
          requestedModel: request.requestedModel,
          innerEpisodesMax: request.innerEpisodesMax,
          campaignConfigHash: trusted.campaignConfigHash ?? null,
        },
      });
    } catch {
      // Diagnostic persistence never participates in child settlement or resume.
    }
    return code;
  }

  async runLaunched(
    request: MetaChildRunRequest,
    campaignConfigHash?: Sha256Digest,
  ): Promise<MetaChildRunOutcome> {
    if (this.campaignPauseAuthority !== undefined && !campaignChildAdmissionAllowed(this.campaignPauseAuthority)) {
      return this.notRun(request, "campaign child admission is durably paused pending trusted frozen-route preflight");
    }
    const location = this.capsules.get(request.capsule.capsuleDigest);
    if (location === undefined) {
      return this.notRun(request, `registered capsule ${request.capsule.capsuleDigest} is not installed`);
    }
    const executionRunId = request.attempt === 0
      ? request.reservation.childRunId
      : `${request.reservation.childRunId}.retry1`;
    const runDir = join(runsRoot(this.io.root), executionRunId);
    const configPath = join(this.campaignDir, `child-config-${executionRunId}.json`);

    if (!existsSync(runDir)) {
      writeFileDurable(configPath, `${JSON.stringify({
        routing: { mutation: { model: request.requestedModel } },
        apply: "none",
        headless: true,
        seed: request.identity.replicate,
        budget: request.remainingBudget,
        promotion: this.dispatchPolicy.promotion,
        ...(this.dispatchPolicy.sessionNoYieldMaxTokens === undefined
          ? {}
          : { sessionNoYieldMaxTokens: this.dispatchPolicy.sessionNoYieldMaxTokens }),
      }, null, 2)}\n`);
      chmodSync(configPath, 0o600);
      if (this.campaignPauseAuthority !== undefined && !campaignChildAdmissionAllowed(this.campaignPauseAuthority)) {
        return this.notRun(request, "campaign child admission paused before durable run start", runDir);
      }
      const code = await this.runChildProcess(
        request,
        executionRunId,
        runDir,
        "start",
        [location.dir, "--headless", "--config", configPath, "--optimizer-artifact", request.sourceArtifact],
        {
          runId: executionRunId,
          capsuleImageOverride: location.executionImage,
          measurementEpoch: request.identity.measurementEpoch,
          ...(this.dispatchPolicy.evaluatorTimeoutSec === undefined
            ? {}
            : { evalTimeoutSec: this.dispatchPolicy.evaluatorTimeoutSec }),
          optimizerEpisodesMax: request.innerEpisodesMax,
          maxPublicCandidateEvaluations: 2 * request.innerEpisodesMax,
          ...(request.identity.phase === "holdout"
            ? { terminalHoldoutAssetGroupIds: location.terminalHoldoutAssetGroupIds }
            : {}),
          optimizerBaseSnapshot: this.baseSnapshot,
          ...(this.dispatchPolicy.mutationWorkerPreflightContract === undefined
            ? {}
            : { mutationWorkerPreflightContract: this.dispatchPolicy.mutationWorkerPreflightContract }),
          ...(this.dispatchPolicy.proxyRole === undefined ? {} : { proxyRole: this.dispatchPolicy.proxyRole }),
          ...(this.campaignPauseAuthority === undefined
            ? {}
            : { campaignPauseAuthority: this.campaignPauseAuthority }),
          ...(campaignConfigHash === undefined ? {} : { campaignConfigHash }),
        },
      );
      if (code !== 0 && !existsSync(join(runDir, EVENTS_FILE))) {
        return this.notRun(request, `child supervisor refused before a run started (exit ${code})`, runDir);
      }
    } else {
      let terminal = false;
      let interrupted = false;
      try {
        const replayed = replayRun(runDir);
        terminal = replayed.finished !== null;
        // A durably paused child owns an explicit retry. A replayed child
        // still marked running has lost its prior supervisor: adjudicate that
        // stale attempt negative under the run lock without starting another
        // optimizer or provider dispatch.
        interrupted = request.resume && replayed.status === "running";
      } catch {
        return this.notRun(request, "child durable state cannot be replayed", runDir);
      }
      if (!terminal) {
        if (this.campaignPauseAuthority !== undefined && !campaignChildAdmissionAllowed(this.campaignPauseAuthority)) {
          return this.notRun(request, "campaign child admission paused before durable run resume", runDir);
        }
        const code = await this.runChildProcess(
          request,
          executionRunId,
          runDir,
          "resume",
          [location.dir, "--headless", "--resume", "--optimizer-artifact", request.sourceArtifact],
          {
            runId: executionRunId,
            capsuleImageOverride: location.executionImage,
            measurementEpoch: request.identity.measurementEpoch,
            ...(this.dispatchPolicy.evaluatorTimeoutSec === undefined
              ? {}
              : { evalTimeoutSec: this.dispatchPolicy.evaluatorTimeoutSec }),
            optimizerEpisodesMax: request.innerEpisodesMax,
            maxPublicCandidateEvaluations: 2 * request.innerEpisodesMax,
            ...(request.identity.phase === "holdout"
              ? { terminalHoldoutAssetGroupIds: location.terminalHoldoutAssetGroupIds }
              : {}),
            optimizerBaseSnapshot: this.baseSnapshot,
            ...(this.dispatchPolicy.mutationWorkerPreflightContract === undefined
              ? {}
              : { mutationWorkerPreflightContract: this.dispatchPolicy.mutationWorkerPreflightContract }),
            ...(this.dispatchPolicy.proxyRole === undefined ? {} : { proxyRole: this.dispatchPolicy.proxyRole }),
            ...(this.campaignPauseAuthority === undefined
              ? {}
              : { campaignPauseAuthority: this.campaignPauseAuthority }),
            ...(interrupted ? { adjudicateInterruptedChild: true } : {}),
            ...(campaignConfigHash === undefined ? {} : { campaignConfigHash }),
          },
        );
        if (code !== 0) {
          try {
            if (replayRun(runDir).finished === null) {
              return this.notRun(request, `child infrastructure stopped before terminalization (exit ${code})`, runDir);
            }
          } catch {
            return this.notRun(request, `child infrastructure left unreplayable state (exit ${code})`, runDir);
          }
        }
      }
    }
    return await this.collectOutcome(request, runDir);
  }

  protected childIo(): CmdIo {
    return {
      root: this.io.root,
      // Recursive M2 children execute the normal command path in-process.
      // Preserve operator runtime controls, including the per-session
      // no-yield ceiling, rather than silently reverting children to defaults.
      env: { ...this.io.env },
      isTTY: false,
      out: () => {},
      err: () => {},
    };
  }

  private notRun(request: MetaChildRunRequest, feedback: string, runDir?: string): MetaChildRunOutcome {
    let runtimeBundleDigest: Sha256Digest | null = null;
    let attemptSpend: MetaResourceUsage = { ...ZERO_USAGE };
    let eventLogHash: Sha256Digest | null = null;
    let eventLogCursor: number | null = null;
    let proxyTraceHash: Sha256Digest | null = null;
    let brokerJournalHash: Sha256Digest | null = null;
    if (runDir !== undefined && existsSync(runDir)) {
      const eventPath = join(runDir, EVENTS_FILE);
      if (existsSync(eventPath)) {
        const bytes = readFileSync(eventPath);
        eventLogHash = sha256(bytes);
        try {
          const state = replayRun(runDir);
          eventLogCursor = state.cursor;
          attemptSpend = state.lastBudget?.spent ?? { ...ZERO_USAGE };
          runtimeBundleDigest = state.optimizerDigest !== null && SHA256_PATTERN.test(state.optimizerDigest)
            ? state.optimizerDigest as Sha256Digest
            : null;
        } catch {
          // The exact bytes remain authenticated; unreplayable state is not_run.
        }
      }
      const tracePath = join(runDir, PROXY_TRACE_FILE);
      if (existsSync(tracePath)) proxyTraceHash = sha256(readFileSync(tracePath));
      try {
        brokerJournalHash = readBrokerJournalEvaluations(runDir).journalHash as Sha256Digest;
      } catch {
        // A true prelaunch/infrastructure failure may have no broker journal.
      }
    }
    return {
      status: "infrastructure_not_run",
      childRunId: request.reservation.childRunId,
      measurementEpoch: request.identity.measurementEpoch,
      capsuleId: request.capsule.capsuleId,
      sourceArtifact: request.sourceArtifact,
      bundleDigest: request.bundleDigest,
      runtimeBundleDigest,
      baselineArtifactHash: null,
      bestArtifactHash: null,
      finalEvaluation: null,
      finalEvaluationHash: null,
      spend: addUsage(priorAttemptSpend(request), attemptSpend),
      eventLogHash,
      eventLogCursor,
      proxyTraceHash,
      brokerJournalHash,
      responseModel: null,
      providerFingerprint: null,
      modelDriftSentinel: null,
      feedback: bounded(feedback),
    };
  }

  private async collectOutcome(request: MetaChildRunRequest, runDir: string): Promise<MetaChildRunOutcome> {
    let events;
    let state;
    try {
      events = readEvents(runDir);
      state = replayRun(runDir);
    } catch (error) {
      return this.notRun(request, `child durable state is unavailable: ${error instanceof Error ? error.message : String(error)}`, runDir);
    }
    if (state.finished === null) return this.notRun(request, "child has no durable terminal event", runDir);
    const eventBytes = readFileSync(join(runDir, EVENTS_FILE));
    if (eventBytes.length === 0 || eventBytes[eventBytes.length - 1] !== 0x0a) {
      return this.notRun(request, "child event log has a torn tail", runDir);
    }
    const tracePath = join(runDir, PROXY_TRACE_FILE);
    const tracePresent = existsSync(tracePath);
    const traceBytes = tracePresent ? readFileSync(tracePath) : Buffer.alloc(0);
    if (traceBytes.length > 0 && traceBytes[traceBytes.length - 1] !== 0x0a) {
      return this.notRun(request, "child proxy trace has a torn tail", runDir);
    }

    let journal: BrokerJournalEvaluationSnapshot | null = null;
    try {
      journal = readBrokerJournalEvaluations(runDir);
    } catch {
      // Failure outcomes still authenticate every available non-journal artifact.
    }
    const runtimeBundleDigest = state.optimizerDigest !== null && SHA256_PATTERN.test(state.optimizerDigest)
      ? state.optimizerDigest as Sha256Digest
      : null;
    const base = {
      childRunId: request.reservation.childRunId,
      measurementEpoch: request.identity.measurementEpoch,
      capsuleId: request.capsule.capsuleId,
      sourceArtifact: request.sourceArtifact,
      bundleDigest: request.bundleDigest,
      runtimeBundleDigest,
      spend: addUsage(priorAttemptSpend(request), state.lastBudget?.spent ?? ZERO_USAGE),
      eventLogHash: sha256(eventBytes),
      eventLogCursor: state.cursor,
      proxyTraceHash: tracePresent ? sha256(traceBytes) : null,
      brokerJournalHash: journal?.journalHash as Sha256Digest | null,
      finalEvaluationHash: null,
    };
    if (state.finished.status === "failed" || state.finished.status === "stopped") {
      const candidateRan = events.some((event) => event.type === "episode.started" || event.type === "episode.candidate");
      return {
        ...base,
        status: candidateRan ? "candidate_failed" : "infrastructure_not_run",
        baselineArtifactHash: state.baselineArtifact?.hash as Sha256Digest | null,
        bestArtifactHash: null,
        finalEvaluation: null,
        responseModel: null,
        providerFingerprint: null,
        modelDriftSentinel: null,
        feedback: candidateRan
          ? `child terminated ${state.finished.status} after candidate execution`
          : `child infrastructure terminated ${state.finished.status} before candidate execution`,
      };
    }
    if (journal === null) return this.failed(request, base, "child broker evidence is unavailable");
    if (runtimeBundleDigest === null) return this.failed(request, base, "child has no authenticated runtime optimizer digest");

    const terminalJournalRecord = journal.records[journal.records.length - 1];
    const selected = bestArtifact(state) ?? state.baselineArtifact
      ?? (terminalJournalRecord === undefined ? null : { hash: terminalJournalRecord.artifactHash });
    if (selected === null) return this.failed(request, base, "child has no trusted baseline or best artifact");
    const matching = journal.records.filter((record) => record.artifactHash === selected.hash);
    const finalEvaluation = matching[matching.length - 1];
    if (finalEvaluation === undefined) return this.failed(request, base, "child best artifact has no joined trusted evaluation");
    const parsedFinal = EvaluationRecord.parse(finalEvaluation);
    const observation = await this.modelRegistry.observe(traceBytes, request.requestedModel);
    if (observation.drift !== null) return this.failed(request, base, observation.drift);
    return {
      ...base,
      status: state.finished.status === "budget" ? "budget" : "completed",
      baselineArtifactHash: (state.baselineArtifact?.hash ?? selected.hash) as Sha256Digest,
      bestArtifactHash: selected.hash as Sha256Digest,
      finalEvaluation: parsedFinal,
      finalEvaluationHash: sha256(canonicalJson(parsedFinal)),
      responseModel: observation.responseModel,
      providerFingerprint: observation.providerFingerprint,
      modelDriftSentinel: observation.sentinel,
      feedback: `child ${state.finished.status}; ${state.cursor} events; broker journal ${journal.journalHash}`,
    };
  }

  private failed(
    request: MetaChildRunRequest,
    base: Omit<MetaChildRunOutcome, "status" | "baselineArtifactHash" | "bestArtifactHash" | "finalEvaluation" | "responseModel" | "providerFingerprint" | "modelDriftSentinel" | "feedback">,
    feedback: string,
  ): MetaChildRunOutcome {
    return {
      ...base,
      status: "candidate_failed",
      baselineArtifactHash: null,
      bestArtifactHash: null,
      finalEvaluation: null,
      responseModel: null,
      providerFingerprint: null,
      modelDriftSentinel: null,
      feedback: bounded(feedback),
    };
  }
}
const SCHEDULED_BUDGET_DIMENSIONS = [
  "maxTokens",
  "maxUsd",
  "maxWallClockSec",
  "maxEvaluatorInvocations",
] as const;

export interface M2OuterAncestorCapacity {
  readonly ancestorEnvelope: BudgetEnvelope;
  readonly directOuterBudget: BudgetEnvelope;
  readonly childReservation: BudgetEnvelope;
  readonly plannedChildren: {
    readonly search: number;
    readonly confirmation: number;
    readonly terminal: number;
    readonly total: number;
  };
  readonly plannedChildReservations: BudgetEnvelope;
  readonly requiredEnvelope: BudgetEnvelope;
}

function addBudgetEnvelopes(envelopes: readonly BudgetEnvelope[]): BudgetEnvelope {
  return BudgetEnvelopeSchema.parse({
    maxTokens: envelopes.reduce((sum, envelope) => sum + envelope.maxTokens, 0),
    maxUsd: envelopes.reduce((sum, envelope) => sum + envelope.maxUsd, 0),
    maxWallClockSec: envelopes.reduce((sum, envelope) => sum + envelope.maxWallClockSec, 0),
    maxEvaluatorInvocations: envelopes.reduce((sum, envelope) => sum + envelope.maxEvaluatorInvocations, 0),
  });
}

/**
 * Freeze/launch gate for the real M2 recursive resource tree.
 *
 * The outer optimizer keeps its direct `budgets.outer` cap. The root recursive
 * ledger separately owns `budgets.campaign`, which must admit every planned
 * child reservation plus that direct outer allowance.
 */
export function assertM2OuterAncestorCapacity(
  config: RecursiveMetaCampaignConfig,
): M2OuterAncestorCapacity {
  const searchChildren = config.counts.candidates * config.developmentPanel.members.length;
  const confirmationChildren =
    (config.generation.stage === "A" ? 4 : 5) *
    config.train.length *
    config.counts.confirmationReplicates;
  const terminalChildren = 3 * config.holdout.length * config.counts.holdoutReplicates;
  const plannedChildren = {
    search: searchChildren,
    confirmation: confirmationChildren,
    terminal: terminalChildren,
    total: searchChildren + confirmationChildren + terminalChildren,
  };
  const plannedChildReservations = addBudgetEnvelopes([
    config.recursiveBudgets.search.outerTrajectory,
    config.recursiveBudgets.confirmation.budget,
    config.recursiveBudgets.terminal.budget,
  ]);
  const requiredEnvelope = addBudgetEnvelopes([
    config.budgets.outer,
    plannedChildReservations,
  ]);
  const ancestorEnvelope = config.budgets.campaign;
  for (const dimension of SCHEDULED_BUDGET_DIMENSIONS) {
    if (requiredEnvelope[dimension] > ancestorEnvelope[dimension]) {
      throw new UsageError(
        `frozen outer ancestor ${dimension} ${ancestorEnvelope[dimension]} cannot admit the full planned recursive sequence ${requiredEnvelope[dimension]}`,
      );
    }
  }
  config.developmentPanel.members.forEach((member) => {
    for (const dimension of SCHEDULED_BUDGET_DIMENSIONS) {
      if (member.calibratedInnerCeiling[dimension] > ancestorEnvelope[dimension]) {
        throw new UsageError(
          `first real child reservation ${member.taskId} ${dimension} ${member.calibratedInnerCeiling[dimension]} exceeds frozen outer ancestor ${ancestorEnvelope[dimension]}`,
        );
      }
    }
  });
  return {
    ancestorEnvelope,
    directOuterBudget: config.budgets.outer,
    childReservation: config.budgets.child,
    plannedChildren,
    plannedChildReservations,
    requiredEnvelope,
  };
}

/**
 * Per-spawn M2 bridge. Search allocation is admitted and measured one child
 * at a time; panel completeness is derived later from the durable trajectory.
 */
export class RecursiveSearchChildLauncher {
  private readonly candidateOrdinals = new Map<Sha256Digest, number>();
  private nextCandidateOrdinal = 0;

  constructor(
    private readonly root: string,
    private readonly campaignDir: string,
    private readonly config: RecursiveMetaCampaignConfig,
    private readonly configHash: Sha256Digest,
    private readonly journal: MetaJournalV1,
    private readonly gate: RecursiveCandidateGate,
    private readonly childSupervisor: CliChildSupervisor,
    private readonly envelopeLedger: MetaResourceEnvelopeLedger,
    private readonly campaignPauseAuthority: CampaignPauseAuthority,
  ) {
    const terminalMeasurements = new Set(
      this.journal.queryTrainMeasurements().map((measurement) => measurement.childRunId),
    );
    const terminalFailures = new Set(
      this.journal.queryFailureSettlements().map((failure) => failure.childRunId),
    );
    const groups = new Map<number, { artifact: Sha256Digest; childRunIds: string[] }>();
    for (const entry of readdirSync(this.campaignDir)) {
      if (!entry.startsWith("child-launch-") || !entry.endsWith(".json")) continue;
      const receipt = ChildRunLaunchReceipt.parse(
        JSON.parse(readFileSync(join(this.campaignDir, entry), "utf8")),
      );
      const schedule = receipt.child.schedule;
      if (schedule === undefined || receipt.child.purpose !== "capsule" || receipt.depth !== 1) continue;
      const artifact = receipt.child.sourceArtifact.hash as Sha256Digest;
      const group = groups.get(schedule.candidateOrdinal);
      if (group !== undefined && group.artifact !== artifact) {
        throw new Error("durable recursive child receipts disagree on candidate ordinal identity");
      }
      const resolved = group ?? { artifact, childRunIds: [] };
      if (!resolved.childRunIds.includes(receipt.child.runId)) resolved.childRunIds.push(receipt.child.runId);
      groups.set(schedule.candidateOrdinal, resolved);
      this.nextCandidateOrdinal = Math.max(this.nextCandidateOrdinal, schedule.candidateOrdinal + 1);
    }
    const latestByArtifact = new Map<Sha256Digest, { ordinal: number; childRunIds: string[] }>();
    for (const [ordinal, group] of groups) {
      const current = latestByArtifact.get(group.artifact);
      if (current === undefined || ordinal > current.ordinal) {
        latestByArtifact.set(group.artifact, { ordinal, childRunIds: group.childRunIds });
      }
    }
    for (const [artifact, latest] of latestByArtifact) {
      const hasOpenChild = latest.childRunIds.some(
        (childRunId) => !terminalMeasurements.has(childRunId) && !terminalFailures.has(childRunId),
      );
      const hasFailedChild = latest.childRunIds.some((childRunId) => terminalFailures.has(childRunId));
      // An incomplete attempt must resume its durable work identities. A
      // settled successful panel remains memoizable. A settled failed panel
      // is deliberately absent so the next outer coordinate mints a new
      // ordinal rather than replaying the same terminal child settlement.
      if (hasOpenChild || !hasFailedChild) this.candidateOrdinals.set(artifact, latest.ordinal);
    }
  }

  /**
   * Trusted adapter for the generic optimizer's evaluate request. The
   * optimizer chooses the development-panel allocation; trust derives child
   * identities, dispatches through spawnRun, and aggregates only journaled
   * normalized settlements.
   */
  evaluationStrategy(): TrustedEvaluationStrategy {
    return async (input) => {
      const started = Date.now();
      if (input.recursivePlan === undefined) {
        throw new Error(
          "recursive search evaluation requires an optimizer-authored allocation plan; refusing the synthetic capsule evaluator",
        );
      }
      const plan = RecursiveEvaluationPlan.parse(input.recursivePlan);
      const members = new Map(
        this.config.developmentPanel.members.map((member) => [member.capsule.capsuleId, member]),
      );
      if (plan.allocations.length > members.size) {
        throw new Error("recursive allocation plan exceeds the frozen development panel");
      }
      const seenCapsules = new Set<string>();
      const seenOrdinals = new Set<number>();
      for (const allocation of plan.allocations) {
        const member = members.get(allocation.capsuleId);
        if (member === undefined) {
          throw new Error(`recursive allocation names non-panel capsule ${allocation.capsuleId}`);
        }
        if (seenCapsules.has(allocation.capsuleId)) {
          throw new Error(`recursive allocation double-counts capsule ${allocation.capsuleId}`);
        }
        if (seenOrdinals.has(allocation.allocationOrdinal)) {
          throw new Error(`recursive allocation ordinal ${allocation.allocationOrdinal} is duplicated`);
        }
        seenCapsules.add(allocation.capsuleId);
        seenOrdinals.add(allocation.allocationOrdinal);
        if (allocation.innerEpisodesMax > this.config.counts.innerEpisodesMax) {
          throw new Error(
            `recursive allocation for ${allocation.capsuleId} exceeds the frozen inner episode ceiling`,
          );
        }
        for (const dimension of SCHEDULED_BUDGET_DIMENSIONS) {
          if (allocation.reservation[dimension] > member.calibratedInnerCeiling[dimension]) {
            throw new Error(
              `recursive allocation for ${allocation.capsuleId} exceeds ${dimension} ceiling`,
            );
          }
        }
      }

      const sourceArtifact = input.artifact.hash as Sha256Digest;
      let checked: CandidateGateResult;
      try {
        checked = await this.gate.check({ mode: "public-mutable", sourceArtifact });
      } catch (error) {
        checked = {
          ok: false,
          feedback: `conformance gate failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!checked.ok) {
        return EvaluationRecord.parse({
          capsuleId: input.capsuleId,
          artifactHash: sourceArtifact,
          assetGroupId: input.assetGroupId,
          seed: input.seed,
          output: {
            valid: false,
            objectives: {},
            constraints: { conformance: false },
            diagnostics: { summary: bounded(checked.feedback) },
          },
          costUsd: 0,
          durationMs: Math.max(0, Date.now() - started),
          cached: false,
          evaluatedAt: new Date().toISOString(),
        });
      }

      let candidateOrdinal = this.candidateOrdinals.get(sourceArtifact);
      if (candidateOrdinal === undefined) {
        candidateOrdinal = this.nextCandidateOrdinal;
        this.nextCandidateOrdinal += 1;
        this.candidateOrdinals.set(sourceArtifact, candidateOrdinal);
      }

      const childResults = await mapBounded(
        plan.allocations,
        this.config.counts.searchChildConcurrency ?? 1,
        async (allocation): Promise<
          | { kind: "measurement"; value: MetaMeasurement }
          | { kind: "failure"; value: MetaFailureSettlement }
        > => {
          const member = members.get(allocation.capsuleId);
          if (member === undefined) throw new Error(`recursive allocation lost panel capsule ${allocation.capsuleId}`);
          const runtimeBundleDigest = this.gate.bundleDigestForImage(sourceArtifact, member.capsule.image);
          const identity: MetaWorkIdentity = {
            phase: "search",
            arm: "candidate",
            sourceArtifact,
            bundleDigest: runtimeBundleDigest,
            capsuleId: allocation.capsuleId,
            replicate: 0,
            measurementEpoch: `m2:${sha256(canonicalJson({
              candidateOrdinal,
              allocationOrdinal: allocation.allocationOrdinal,
              innerEpisodesMax: allocation.innerEpisodesMax,
              reserved: allocation.reservation,
            })).slice("sha256:".length)}`,
          };
          const runId = `run_meta_${metaWorkKey(this.configHash, identity).slice("sha256:".length)}`;
          await input.spawnRun(SpawnRunParams.parse({
            child: {
              runId,
              capsuleId: allocation.capsuleId,
              sourceArtifact: { hash: sourceArtifact },
              optimizerArtifact: { hash: runtimeBundleDigest },
              purpose: "capsule",
              schedule: {
                candidateOrdinal,
                allocationOrdinal: allocation.allocationOrdinal,
                innerEpisodesMax: allocation.innerEpisodesMax,
              },
            },
            depth: 1,
            reservation: allocation.reservation,
          }));
          const workKey = metaWorkKey(this.configHash, identity);
          const measurement = this.journal.queryTrainMeasurements().find((row) => row.workKey === workKey);
          if (measurement !== undefined) return { kind: "measurement", value: measurement };
          const failure = this.journal.queryFailureSettlements().find((row) => row.workKey === workKey);
          if (failure === undefined) {
            throw new Error(`recursive child ${runId} returned without a trusted settlement`);
          }
          return { kind: "failure", value: failure };
        },
      );
      const measurements: MetaMeasurement[] = [];
      const failures: string[] = [];
      let costUsd = 0;
      for (const result of childResults) {
        costUsd += result.value.observed.usd;
        if (result.kind === "measurement") measurements.push(result.value);
        else failures.push(`${result.value.capsuleId}=${result.value.status}`);
      }

      if (
        failures.length > 0
        && this.candidateOrdinals.get(sourceArtifact) === candidateOrdinal
      ) {
        this.candidateOrdinals.delete(sourceArtifact);
      }
      if (failures.length > 0) {
        return EvaluationRecord.parse({
          capsuleId: input.capsuleId,
          artifactHash: sourceArtifact,
          assetGroupId: input.assetGroupId,
          seed: input.seed,
          output: {
            valid: false,
            objectives: {},
            constraints: { allChildrenValid: false },
            diagnostics: { summary: bounded(`recursive child settlement failed: ${failures.join("; ")}`) },
          },
          costUsd,
          durationMs: Math.max(0, Date.now() - started),
          cached: false,
          evaluatedAt: new Date().toISOString(),
        });
      }
      if (measurements.length !== plan.allocations.length) {
        throw new Error("recursive evaluation settlement cardinality mismatch");
      }
      const normalizedGain =
        measurements.reduce((sum, measurement) => sum + measurement.qNormalized, 0) / measurements.length;
      const perExample = Object.fromEntries(
        measurements.map((measurement) => [
          measurement.capsuleId,
          {
            score: measurement.qNormalized,
            feedback: `${measurement.capsuleId}: trusted normalized gain ${measurement.qNormalized}`,
          },
        ]),
      );
      return EvaluationRecord.parse({
        capsuleId: input.capsuleId,
        artifactHash: sourceArtifact,
        assetGroupId: input.assetGroupId,
        seed: input.seed,
        output: {
          valid: true,
          objectives: { normalizedGain },
          constraints: {
            allChildrenValid: true,
            fullPanel: measurements.length === members.size,
          },
          perExample,
          diagnostics: {
            summary: bounded(
              `recursive development evaluation scored ${measurements.length}/${members.size} frozen panel capsules`,
            ),
          },
        },
        costUsd,
        durationMs: Math.max(0, Date.now() - started),
        cached: false,
        evaluatedAt: new Date().toISOString(),
      });
    };
  }


  brokerConfig(
    ledger: BrokerRecursiveConfig["ledger"],
    depth: BrokerRecursiveConfig["depth"] = 0,
    ancestors: readonly string[] = [],
  ): BrokerRecursiveConfig {
    return {
      depth,
      ancestors,
      ledger,
      ...(depth === 0
        ? {
            resourceEnvelope: assertM2OuterAncestorCapacity(this.config).ancestorEnvelope,
            evaluationTask: {
              depth,
              innerEpisodesMax: this.config.counts.innerEpisodesMax,
              members: this.config.developmentPanel.members.map((member) => ({
                capsuleId: member.capsule.capsuleId,
                calibratedInnerCeiling: member.calibratedInnerCeiling,
              })),
            },
          }
        : {}),
      admitChildRun: (input) => this.admitChildRun(input),
      launchChildRun: (input) => this.launchChildRun(input),
    };
  }

  admitChildRun(input: TrustedChildAdmissionInput): ChildRunAdmissionRecord | undefined {
    if (!campaignChildAdmissionAllowed(this.campaignPauseAuthority)) return undefined;
    const request = SpawnRunParams.parse(input.request);
    if (input.parentDepth !== 0 || request.depth !== 1 || request.child.purpose !== "capsule") return undefined;
    const identity = this.scheduledIdentity(request);
    if (identity === null) return undefined;
    const expectedRunId = `run_meta_${metaWorkKey(this.configHash, identity).slice("sha256:".length)}`;
    if (request.child.runId !== expectedRunId) return undefined;
    const member = this.config.developmentPanel.members.find(
      (candidate) => candidate.capsule.capsuleId === request.child.capsuleId,
    );
    if (member === undefined) return undefined;
    for (const dimension of SCHEDULED_BUDGET_DIMENSIONS) {
      if (request.reservation[dimension] > member.calibratedInnerCeiling[dimension]) return undefined;
    }
    return ChildRunAdmission.parse({
      campaignConfigHash: this.configHash,
      cohort: this.config.generation.stage === "A" ? "panel-a" : "panel-b",
      capsuleProvenanceHash: member.capsule.capsuleDigest,
      sourceProvenanceHash: request.child.sourceArtifact.hash,
      optimizerProvenanceHash: request.child.optimizerArtifact.hash,
    });
  }

  async launchChildRun(input: ChildRunLaunchInput): Promise<ChildRunLaunchOutcome> {
    const request = SpawnRunParams.parse(input.request);
    const admission = ChildRunAdmission.parse(input.admission);
    const schedule = request.child.schedule;
    if (schedule === undefined) throw new Error("recursive search child has no valid schedule identity");
    const admitted = this.admitChildRun({
      parentRunId: request.child.runId,
      parentDepth: 0,
      request,
    });
    if (admitted === undefined || canonicalJson(admitted) !== canonicalJson(admission)) {
      throw new Error("recursive child launch no longer reproduces trusted admission");
    }
    const identity = this.scheduledIdentity(request);
    if (identity === null) throw new Error("recursive search child has no valid schedule identity");
    const capsule = this.config.developmentPanel.members.find(
      (member) => member.capsule.capsuleId === request.child.capsuleId,
    )?.capsule;
    if (capsule === undefined) throw new Error("recursive launch capsule left the frozen panel");
    const gate = await this.gate.check({
      mode: "public-mutable",
      sourceArtifact: identity.sourceArtifact,
    });
    if (!gate.ok) {
      throw new Error(`recursive child optimizer conformance refused: ${gate.feedback}`);
    }
    if (this.gate.bundleDigestForImage(identity.sourceArtifact, capsule.image) !== identity.bundleDigest) {
      throw new Error("recursive child optimizer conformance does not match its image-bound launch digest");
    }

    const envelopeRequest: MetaChildEnvelopeRequest = {
      purpose: "search",
      envelope: this.config.recursiveBudgets.search.identity,
      reservationId: sha256(canonicalJson({
        domain: "hone-m2-search-envelope-reservation-v1",
        configHash: this.configHash,
        identity,
      })),
      parentReservationId: null,
      reserved: BudgetEnvelopeSchema.parse(request.reservation),
    };
    const sliced = this.envelopeLedger.reserveSearchDescendant({
      reservationId: envelopeRequest.reservationId,
      parentReservationId: null,
      reserved: envelopeRequest.reserved,
    });
    if (
      canonicalJson(sliced.envelope) !== canonicalJson(envelopeRequest.envelope)
      || canonicalJson(sliced.reserved) !== canonicalJson(envelopeRequest.reserved)
    ) {
      throw new Error("recursive envelope ledger returned a foreign search slice");
    }
    const reservation: MetaReservation = this.journal.reserveChild(identity, envelopeRequest);
    if (reservation.childRunId !== request.child.runId) {
      throw new Error(`recursive child run id ${request.child.runId} does not match ${reservation.childRunId}`);
    }

    const receiptPath = join(this.campaignDir, `child-launch-${request.child.runId}.json`);
    if (!existsSync(receiptPath)) {
      const body = {
        child: request.child,
        depth: request.depth,
        admission,
        launchedAt: new Date().toISOString(),
      };
      const receipt = ChildRunLaunchReceipt.parse({
        ...body,
        receiptDigest: hashChildRunLaunchReceipt(body),
      });
      writeFileDurable(receiptPath, `${canonicalJson(receipt)}\n`);
      chmodSync(receiptPath, 0o600);
    }

    const outcome = await this.childSupervisor.runLaunched({
      identity,
      reservation,
      sourceArtifact: identity.sourceArtifact,
      bundleDigest: identity.bundleDigest,
      capsule,
      innerEpisodesMax: schedule.innerEpisodesMax,
      requestedModel: this.config.routing.innerMutation,
      remainingBudget: envelopeRequest.reserved,
      attempt: 0,
      resume: input.replay,
    }, admission.campaignConfigHash as Sha256Digest);
    if (
      outcome.childRunId !== reservation.childRunId
      || outcome.measurementEpoch !== identity.measurementEpoch
      || outcome.capsuleId !== identity.capsuleId
      || outcome.sourceArtifact !== identity.sourceArtifact
      || outcome.bundleDigest !== identity.bundleDigest
    ) {
      throw new Error("recursive child outcome does not match its durable launch identity");
    }

    const evidenceHash = sha256(canonicalJson({
      domain: "hone-m2-search-child-evidence-v1",
      identity,
      reservation,
      outcome,
    }));
    const terminalEventPath = join(runsRoot(this.root), request.child.runId, EVENTS_FILE);
    let childFinished = false;
    try {
      childFinished = replayRun(join(runsRoot(this.root), request.child.runId)).finished !== null;
    } catch {
      // Missing or unreplayable child state is necessarily nonterminal.
    }
    if (!childFinished) {
      this.journal.recordChildPending(identity, {
        evidenceHash,
        observed: outcome.spend,
      });
      return {
        launchReceiptPath: receiptPath,
        terminalEventPath,
        usage: { ...outcome.spend },
        finalizeSettlement: () => {},
      };
    }
    let finalizeMetaSettlement: () => void;
    if (outcome.status === "completed" && outcome.finalEvaluation !== null) {
      const finalEvaluation = EvaluationRecord.parse(outcome.finalEvaluation);
      const objectives = Object.values(finalEvaluation.output.objectives);
      const qRaw = objectives[0];
      const constraintsPass = Object.values(finalEvaluation.output.constraints).every((value) => value);
      if (
        !finalEvaluation.output.valid
        || !constraintsPass
        || objectives.length !== 1
        || typeof qRaw !== "number"
        || !Number.isFinite(qRaw)
      ) {
        throw new Error("recursive child final evaluation is not a finite scalar");
      }
      const responseModel = outcome.responseModel;
      const modelDriftSentinel = outcome.modelDriftSentinel;
      if (responseModel === null || modelDriftSentinel === null) {
        throw new Error("recursive child completion has no authenticated model observation");
      }
      finalizeMetaSettlement = () => {
        this.journal.settleChild(identity, {
          evidenceHash,
          observed: outcome.spend,
          qRaw,
          responseModel,
          providerFingerprint: outcome.providerFingerprint,
          modelDriftSentinel,
        });
      };
    } else {
      finalizeMetaSettlement = () => {
        this.journal.settleChildFailure(identity, {
          evidenceHash,
          observed: outcome.spend,
          status: outcome.status === "budget"
            ? "budget"
            : outcome.status === "infrastructure_not_run"
              ? "infrastructure_not_run"
              : "candidate_failed",
        });
      };
    }
    const finalizeSettlement = (): void => {
      finalizeMetaSettlement();
      this.envelopeLedger.settleDescendant(envelopeRequest.reservationId, outcome.spend);
    };
    return {
      launchReceiptPath: receiptPath,
      terminalEventPath,
      usage: { ...outcome.spend },
      finalizeSettlement,
    };
  }

  private scheduledIdentity(request: SpawnRunRequest): MetaWorkIdentity | null {
    const schedule = request.child.schedule;
    if (schedule === undefined || schedule.innerEpisodesMax > this.config.counts.innerEpisodesMax) return null;
    const member = this.config.developmentPanel.members.find(
      (candidate) => candidate.capsule.capsuleId === request.child.capsuleId,
    );
    if (member === undefined) return null;
    return {
      phase: "search",
      arm: "candidate",
      sourceArtifact: request.child.sourceArtifact.hash as Sha256Digest,
      bundleDigest: request.child.optimizerArtifact.hash as Sha256Digest,
      capsuleId: member.capsule.capsuleId,
      replicate: 0,
      measurementEpoch: `m2:${sha256(canonicalJson({
        candidateOrdinal: schedule.candidateOrdinal,
        allocationOrdinal: schedule.allocationOrdinal,
        innerEpisodesMax: schedule.innerEpisodesMax,
        reserved: request.reservation,
      })).slice("sha256:".length)}`,
    };
  }
}

interface ModelObservation {
  responseModel: string;
  providerFingerprint: string | null;
  sentinel: string;
  drift: string | null;
}


const ModelIdentitySchema = z.object({
  version: z.literal(1),
  configHash: z.string().regex(SHA256_PATTERN),
  requestedModel: z.string().min(1),
  responseModel: z.string().min(1),
  providerFingerprint: z.string().min(1).nullable(),
}).strict();

type CampaignModelIdentity = z.infer<typeof ModelIdentitySchema>;

export class CampaignModelRegistry {
  private readonly file: string;
  private identity: CampaignModelIdentity | null;

  constructor(
    campaignDir: string,
    private readonly configHash: Sha256Digest,
    private readonly root: string,
  ) {
    this.file = join(campaignDir, "model-identity.json");
    this.identity = existsSync(this.file)
      ? ModelIdentitySchema.parse(JSON.parse(readFileSync(this.file, "utf8")))
      : null;
    if (this.identity !== null && this.identity.configHash !== configHash) {
      throw new UsageError("durable model identity belongs to a different campaign configuration");
    }
  }

  async observe(traceBytes: Buffer, requestedModel: string): Promise<ModelObservation> {
    const observation = await observeModels(traceBytes, this.root, requestedModel);
    if (observation.drift !== null) return observation;
    const candidate: CampaignModelIdentity = {
      version: 1,
      configHash: this.configHash,
      requestedModel,
      responseModel: observation.responseModel,
      providerFingerprint: observation.providerFingerprint,
    };
    if (this.identity === null) {
      writeFileDurable(this.file, `${canonicalJson(candidate)}\n`);
      chmodSync(this.file, 0o600);
      this.identity = candidate;
    } else if (canonicalJson(this.identity) !== canonicalJson(candidate)) {
      return {
        ...observation,
        sentinel: `drift:${sha256(canonicalJson({ expected: this.identity, observed: candidate }))}`,
        drift: `campaign model identity drift: expected ${this.identity.responseModel}/${this.identity.providerFingerprint ?? "none"}, observed ${candidate.responseModel}/${candidate.providerFingerprint ?? "none"}`,
      };
    }
    return {
      ...observation,
      sentinel: `stable:${sha256(canonicalJson(candidate))}`,
    };
  }
}

async function observeModels(traceBytes: Buffer, root: string, requestedModel: string): Promise<ModelObservation> {
  const traces = traceBytes.length === 0
    ? []
    : traceBytes.toString("utf8").split("\n").filter((line) => line.length > 0).map((line) => ProxyTraceRecord.parse(JSON.parse(line)));
  const cas = new CasStore(casRoot(root));
  const responseModels: string[] = [];
  const fingerprints: string[] = [];
  for (const trace of traces) {
    if (trace.model !== requestedModel) {
      return {
        responseModel: trace.model,
        providerFingerprint: null,
        sentinel: `drift:${sha256(trace.model)}`,
        drift: `proxy requested model drifted from ${requestedModel} to ${trace.model}`,
      };
    }
    const body = (await cas.readBuffer(trace.responseBody)).toString("utf8");
    for (const observed of parseResponseObservations(body)) {
      if (observed.model !== null) responseModels.push(observed.model);
      if (observed.fingerprint !== null) fingerprints.push(observed.fingerprint);
    }
  }
  const distinctModels = [...new Set(responseModels)];
  const distinctFingerprints = [...new Set(fingerprints)];
  if (distinctModels.some((model) => model !== requestedModel) || distinctModels.length > 1 || distinctFingerprints.length > 1) {
    return {
      responseModel: distinctModels.join(",") || requestedModel,
      providerFingerprint: distinctFingerprints.length === 1 ? distinctFingerprints[0]! : null,
      sentinel: `drift:${sha256(canonicalJson({ distinctModels, distinctFingerprints }))}`,
      drift: `provider identity drift: models=${distinctModels.join(",") || "none"} fingerprints=${distinctFingerprints.join(",") || "none"}`,
    };
  }
  return {
    responseModel: distinctModels[0] ?? requestedModel,
    providerFingerprint: distinctFingerprints[0] ?? null,
    sentinel: "unregistered",
    drift: null,
  };
}

function parseResponseObservations(body: string): Array<{ model: string | null; fingerprint: string | null }> {
  const payloads = body.startsWith("data:")
    ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter((line) => line !== "[DONE]")
    : [body];
  const observations: Array<{ model: string | null; fingerprint: string | null }> = [];
  for (const payload of payloads) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      observations.push({
        model: typeof record["model"] === "string" ? record["model"] : null,
        fingerprint: typeof record["system_fingerprint"] === "string" ? record["system_fingerprint"] : null,
      });
    } catch {
      // A non-JSON upstream error has no provider identity observation.
    }
  }
  return observations;
}

export interface DiscoveredCapsule {
  readonly dir: string;
  readonly admitted: AdmittedCapsule;
}


export function discoverCapsules(
  root: string,
  cohort?: M2CorpusCohort,
): Map<string, DiscoveredCapsule> {
  const found = new Map<string, DiscoveredCapsule>();
  const capsuleRoot = join(root, "capsules");
  if (cohort !== undefined && "mode" in cohort) {
    const policy = verifyM2AuthorizedPartialCohort(root, cohort.partialCohort);
    for (const deferred of policy.deferred) {
      const dir = join(capsuleRoot, deferred.label);
      const manifest = loadCapsule(dir);
      if (
        manifest.id !== deferred.capsuleId
        || capsuleDigest(manifest) !== deferred.capsuleDigest
      ) {
        throw new UsageError(`deferred capsule ${deferred.label} does not match its authorized identity`);
      }
    }
    for (const authorized of policy.admitted) {
      const dir = join(capsuleRoot, authorized.label);
      const admitted = admitCapsule(dir, {
        review: "required",
        allowMissingGitBaselineWithOwnerReceipt: true,
      });
      if (admitted.provisional) {
        throw new UsageError(`authorized cohort capsule ${authorized.label} is provisional`);
      }
      if (
        admitted.manifest.id !== authorized.capsuleId
        || admitted.digest !== authorized.capsuleDigest
        || admitted.approval?.receipt.recordHash !== authorized.gate2ReceiptHash
      ) {
        throw new UsageError(`authorized cohort capsule ${authorized.label} does not reproduce its Gate-2 receipt binding`);
      }
      const basis = admitted.approval.receipt.approvalBasis;
      if (!gate2ReceiptCitesAuthorizedBasis(policy, authorized, basis)) {
        throw new UsageError(`authorized cohort capsule ${authorized.label} receipt does not cite the owner authorization`);
      }
      if (found.has(admitted.manifest.id)) {
        throw new UsageError(`duplicate admitted capsule id ${admitted.manifest.id}`);
      }
      found.set(admitted.manifest.id, { dir, admitted });
    }
    return found;
  }
  for (const entry of readdirSync(capsuleRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(capsuleRoot, entry.name);
    try {
      const admitted = admitCapsule(dir, { review: "required" });
      // Delegated Gate-2 approvals are private quarantine only: they cannot
      // contribute corpus statistics, optimizer promotion, or terminal work.
      if (admitted.provisional) continue;
      if (found.has(admitted.manifest.id)) {
        throw new UsageError(`duplicate admitted capsule id ${admitted.manifest.id}`);
      }
      found.set(admitted.manifest.id, { dir, admitted });
    } catch (error) {
      if (error instanceof UsageError && (
        error.message.startsWith("duplicate admitted capsule id")
        || existsSync(join(dir, "manifest.json"))
      )) {
        throw error;
      }
      // Non-capsule tool/test directories are outside the registered corpus.
    }
  }
  return found;
}

interface FrozenCorpus {
  readonly train: MetaCapsuleEntry[];
  readonly holdout: MetaCapsuleEntry[];
}

function freezeCorpusEntries(root: string, config: AnyMetaCampaignConfig): FrozenCorpus {
  const discovered = discoverCapsules(root, config.version === 2 ? config.corpusCohort : undefined);
  const normalize = (entry: MetaCapsuleEntry): MetaCapsuleEntry => {
    const found = discovered.get(entry.capsuleId);
    if (found === undefined) throw new UsageError(`campaign capsule id ${entry.capsuleId} is not installed`);
    const baseline = found.admitted.orderingReport.variants.baseline.train;
    const reference = found.admitted.orderingReport.variants.improved.train;
    if (!(reference > baseline)) {
      throw new UsageError(`campaign capsule ${entry.capsuleId} has no positive train reference scale`);
    }
    return {
      ...entry,
      capsuleDigest: found.admitted.digest,
      image: found.admitted.manifest.image,
      oracleDigest: capsuleOracleDigest(found.admitted),
      scalarizerDigest: capsuleScalarizerDigest(found.admitted),
      qFail: 0,
      qBase: baseline,
      qReference: reference,
      scale: reference - baseline,
    };
  };
  return {
    train: config.train.map(normalize),
    holdout: config.holdout.map(normalize),
  };
}

export function campaignAdmittedCapsuleImage(
  config: AnyMetaCampaignConfig,
  capsuleId: string,
  registeredImage: string,
): string {
  return config.imageRepinJournal?.repins
    .find((repin) => repin.capsuleId === capsuleId)?.fromImage
    ?? registeredImage;
}

export function resolveRegisteredCapsuleLocation(
  config: AnyMetaCampaignConfig,
  registered: MetaCapsuleEntry,
  capsule: DiscoveredCapsule,
): CapsuleLocation {
  const admitted = capsule.admitted;
  const admittedImage = campaignAdmittedCapsuleImage(
    config,
    registered.capsuleId,
    registered.image,
  );
  if (
    admitted.digest !== registered.capsuleDigest
    || admitted.manifest.image !== admittedImage
    || capsuleOracleDigest(admitted) !== registered.oracleDigest
    || capsuleScalarizerDigest(admitted) !== registered.scalarizerDigest
  ) {
    throw new UsageError(`registered campaign capsule ${registered.capsuleId} has identity drift`);
  }
  const terminalHoldoutAssetGroupIds = admitted.manifest.assetGroups
    .filter((group) => group.visibility === "holdout")
    .map((group) => group.id);
  if (config.holdout.some((entry) => entry.capsuleId === registered.capsuleId)) {
    const terminalArms = config.version === 2 ? 3 : 2;
    const requiredLifetimeAccesses =
      (4 * config.counts.innerEpisodesMax + 1) * terminalArms * config.counts.holdoutReplicates;
    if (terminalHoldoutAssetGroupIds.length === 0) {
      throw new UsageError(`terminal holdout capsule ${registered.capsuleId} has no holdout asset group`);
    }
    if (admitted.manifest.budget.maxEvaluatorInvocations < requiredLifetimeAccesses) {
      throw new UsageError(
        `terminal holdout capsule ${registered.capsuleId} lifetime budget ${admitted.manifest.budget.maxEvaluatorInvocations} cannot cover ${requiredLifetimeAccesses} accesses`,
      );
    }
  }
  return {
    dir: capsule.dir,
    digest: admitted.digest,
    executionImage: registered.image,
    terminalHoldoutAssetGroupIds,
  };
}

export function resolveRegisteredCapsules(root: string, config: AnyMetaCampaignConfig): Map<string, CapsuleLocation> {
  metaCampaignConfigHash(config);
  const discovered = discoverCapsules(root, config.version === 2 ? config.corpusCohort : undefined);
  const found = new Map<string, CapsuleLocation>();
  for (const registered of [...config.train, ...config.holdout]) {
    const capsule = discovered.get(registered.capsuleId);
    if (capsule === undefined) throw new UsageError(`registered campaign capsule ${registered.capsuleId} is not installed`);
    found.set(
      registered.capsuleDigest,
      resolveRegisteredCapsuleLocation(config, registered, capsule),
    );
  }
  return found;
}

export async function captureSeedCandidate(root: string, cas: CasStore): Promise<{ artifactHash: Sha256Digest }> {
  const snapshot = collectOptimizerSnapshot(root);
  const staging = mkdtempSync(join(tmpdir(), "hone-meta-seed-"));
  chmodSync(staging, 0o700);
  try {
    for (const [fullPath, file] of snapshot.files) {
      if (!fullPath.startsWith("optimizer/")) continue;
      const candidatePath = fullPath.slice("optimizer/".length);
      if (
        candidatePath !== "package.json" &&
        candidatePath !== "tsconfig.json" &&
        !candidatePath.startsWith("src/") &&
        !candidatePath.startsWith("assets/") &&
        !candidatePath.startsWith("worker/")
      ) continue;
      const destination = join(staging, candidatePath);
      mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(destination, file.bytes, { mode: file.mode });
    }
    const artifactHash = await packDirAsArtifact(staging, cas) as Sha256Digest;
    return { artifactHash };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function materializeOptimizerSource(snapshot: OptimizerSnapshot, optimizerDir: string): void {
  mkdirSync(optimizerDir, { recursive: true, mode: 0o700 });
  for (const [fullPath, file] of snapshot.files) {
    if (!fullPath.startsWith("optimizer/")) continue;
    const candidatePath = fullPath.slice("optimizer/".length);
    const destination = join(optimizerDir, candidatePath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file.bytes, { mode: file.mode });
  }
}

async function resolveRegisteredOptimizer(
  identity: { sourceCommit: string; sourceArtifact: string; bundleDigest: string },
  commit: string,
  rootSnapshot: OptimizerSnapshot,
  casDir: string,
  image: string,
): Promise<ResolvedCandidateOptimizer> {
  if (identity.sourceCommit !== commit) {
    throw new UsageError(`optimizer base commit drift: ${commit} != registered ${identity.sourceCommit}`);
  }
  const resolved = await resolveCandidateOptimizer({
    casDir,
    artifactHash: identity.sourceArtifact,
    image,
    baseSnapshot: rootSnapshot,
  });
  if (resolved.mergedDigest !== identity.bundleDigest) {
    throw new UsageError(`optimizer bundle drift: ${resolved.mergedDigest} != registered ${identity.bundleDigest}`);
  }
  return resolved;
}
export function sourceCommit(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new UsageError("official meta campaigns require a git worktree with a committed HEAD");
  }
}

export function assertCleanSourceTree(root: string): void {
  let status: string;
  try {
    status = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new UsageError("official meta campaigns could not verify source worktree cleanliness");
  }
  if (status.length > 0) throw new UsageError("official meta campaigns require a clean source worktree");
}

/** A tracked campaign would make the post-migration coordinator tree dirty forever. */
export function assertCampaignPathUntracked(root: string, campaignPath: string): void {
  const repoRelative = relative(resolve(root), resolve(campaignPath));
  if (repoRelative === ".." || repoRelative.startsWith(`..${sep}`)) return;
  let tracked: string;
  try {
    tracked = execFileSync("git", ["-C", root, "ls-files", "-z", "--", repoRelative], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new UsageError("campaign source migration could not verify that the campaign file is runtime state");
  }
  if (tracked.length > 0) {
    throw new UsageError(
      `campaign file ${campaignPath} is git-tracked; migration would dirty the coordinator worktree — `
      + "copy it to an ignored runtime path such as .hone-runs/campaign-frozen.json and retry",
    );
  }
}

const CAMPAIGN_SESSION_FILE = "campaign-session.v1.json";

/**
 * The ordinary recursive coordinator's fail-closed source gate. Calling the
 * campaign hash first also authenticates an optional migration journal.
 */
export function assertRecursiveCampaignSourceIdentity(
  configInput: RecursiveMetaCampaignConfig,
  commit: string,
  bootDigest: string,
): void {
  const config = MetaCampaignConfigV2.parse(configInput);
  metaCampaignConfigHash(config);
  if (
    campaignSourceCommits(config).some((pin) => pin !== commit)
    || config.trustedRuntime.digest !== bootDigest
  ) {
    throw new UsageError("recursive campaign trusted runtime identity drift");
  }
}

function sourceMigrationFrozenProjection(configInput: RecursiveMetaCampaignConfig): string {
  const config = MetaCampaignConfigV2.parse(configInput);
  const {
    sourceMigrationJournal: _journal,
    seedOptimizer: _seedOptimizer,
    controllerOptimizer: _controllerOptimizer,
    trustedRuntime: _trustedRuntime,
    controls: _controls,
    ...frozen
  } = config;
  return canonicalJson(frozen);
}

/** Mutation guard: migration may touch only journal-authenticated engine identities. */
export function assertCampaignSourceMigrationOnly(
  before: RecursiveMetaCampaignConfig,
  after: RecursiveMetaCampaignConfig,
): void {
  if (sourceMigrationFrozenProjection(before) !== sourceMigrationFrozenProjection(after)) {
    throw new UsageError("source migration attempted to alter frozen campaign fields");
  }
}

interface CampaignRunPin {
  readonly runDir: string;
  readonly runId: string;
  readonly pinPath: string;
  readonly pinnedDigest: string;
}

function campaignSealedRun(runDir: string, campaignConfigHash: Sha256Digest): boolean {
  const sealPath = join(runDir, CAMPAIGN_SESSION_FILE);
  if (!existsSync(sealPath)) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sealPath, "utf8"));
  } catch (error) {
    throw new UsageError(
      `cannot authenticate campaign run seal ${sealPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== "object") {
    throw new UsageError(`cannot authenticate campaign run seal ${sealPath}: expected an object`);
  }
  return (raw as Record<string, unknown>)["campaignConfigHash"] === campaignConfigHash;
}

function nonterminalCampaignRunPins(
  root: string,
  campaignConfigHash: Sha256Digest,
  fromBootDigest: string,
  toBootDigest: string,
): CampaignRunPin[] {
  const base = runsRoot(root);
  if (!existsSync(base)) return [];
  const pins: CampaignRunPin[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(base, entry.name);
    if (!campaignSealedRun(runDir, campaignConfigHash)) continue;
    const eventPath = join(runDir, EVENTS_FILE);
    if (existsSync(eventPath)) {
      let terminal: boolean;
      try {
        terminal = replayRun(runDir).finished !== null;
      } catch (error) {
        throw new UsageError(
          `cannot replay campaign run ${entry.name} before source migration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (terminal) continue;
    }
    const pinPath = join(runDir, RUNTIME_PIN_FILE);
    if (!existsSync(pinPath)) {
      throw new UsageError(`nonterminal campaign run ${entry.name} has no ${RUNTIME_PIN_FILE}; refusing migration`);
    }
    const pinnedDigest = readFileSync(pinPath, "utf8").trim();
    if (pinnedDigest !== fromBootDigest && pinnedDigest !== toBootDigest) {
      throw new UsageError(
        `nonterminal campaign run ${entry.name} has foreign runtime pin ${pinnedDigest}; `
        + `restore it to the campaign source digest ${fromBootDigest} before retrying `
        + `(only that digest or the exact target digest ${toBootDigest} is accepted)`,
      );
    }
    pins.push({ runDir, runId: entry.name, pinPath, pinnedDigest });
  }
  return pins.sort((left, right) => left.runId.localeCompare(right.runId));
}

function registeredCampaignConfigNeedsReconciliation(
  registeredConfigPath: string,
  config: RecursiveMetaCampaignConfig,
): boolean {
  if (!existsSync(registeredConfigPath)) return false;
  const registered = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(registeredConfigPath, "utf8")));
  if (canonicalJson(registered) === canonicalJson(config)) return false;
  if (!campaignRecordExtends(registered, config)) {
    throw new UsageError("recursive cell state belongs to a different configuration");
  }
  return true;
}

function reconcileRegisteredCampaignConfig(
  registeredConfigPath: string,
  config: RecursiveMetaCampaignConfig,
  preflightResult?: boolean,
): void {
  const needsReconciliation = preflightResult
    ?? registeredCampaignConfigNeedsReconciliation(registeredConfigPath, config);
  if (!needsReconciliation) return;
  writeFileDurable(registeredConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(registeredConfigPath, 0o600);
}

export interface CampaignSourceMigrationRequest {
  readonly root: string;
  readonly campaignPath: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly at: string;
  readonly bootDigest: Sha256Digest;
  readonly operator?: string;
  readonly refreezeOptimizer?: boolean;
  readonly sealedBase?: string;
}

interface PreparedCampaignOptimizerRefreeze {
  readonly baseSnapshot: OptimizerSnapshot;
  readonly fromOptimizerBaseDigest: Sha256Digest;
  readonly optimizerBaseDigest: Sha256Digest;
  readonly seed: ResolvedCandidateOptimizer;
  readonly controller: ResolvedCandidateOptimizer;
  readonly broken: RegisteredControl;
  readonly degraded: RegisteredControl;
}

export interface PlannedOptimizerRunRefreeze {
  readonly runDir: string;
  readonly pauseBeforeMigration: boolean;
  readonly record: CampaignOptimizerRunRefreezeV1;
  readonly expectedSeal: OptimizerArtifactSeal;
  readonly replacement: ResolvedCandidateOptimizer;
  readonly oldContract: string;
  readonly newContract: string;
}

async function prepareCampaignOptimizerRefreeze(
  root: string,
  config: RecursiveMetaCampaignConfig,
  sealedBase: string,
): Promise<PreparedCampaignOptimizerRefreeze> {
  const priorClosure = config.runtimeClosureJournal?.captures.at(-1);
  if (priorClosure === undefined) {
    throw new UsageError("optimizer refreeze requires a captured current runtime closure");
  }
  const image = config.optimizerRuntime.image;
  const baseSnapshot = collectOptimizerSnapshot(sealedBase);
  const optimizerBaseDigest = snapshotDigest(image, baseSnapshot) as Sha256Digest;
  if (optimizerBaseDigest !== priorClosure.optimizerBaseDigest) {
    throw new UsageError("optimizer refreeze sealed base does not match the captured optimizer base digest");
  }
  const casDir = casRoot(root);
  const cas = new CasStore(casDir);
  const localSeed = await captureSeedCandidate(root, cas);
  const seedSource = config.generation.stage === "A"
    ? localSeed.artifactHash
    : config.seedOptimizer.sourceArtifact as Sha256Digest;
  const controllerSource = config.generation.controllerGeneration === 0
    ? localSeed.artifactHash
    : config.controllerOptimizer.sourceArtifact as Sha256Digest;
  const seed = await resolveCandidateOptimizer({
    casDir,
    artifactHash: seedSource,
    image,
    baseSnapshot,
  });
  const controller = await resolveCandidateOptimizer({
    casDir,
    artifactHash: controllerSource,
    image,
    baseSnapshot,
  });
  // The journal explicitly authorizes engine-source changes. Scientific
  // candidate diffs remain governed by the frozen mutable allowlist after
  // the refreeze; this seed/controller rebuild is not a candidate admission.
  const controls = await prepareRecursiveControls(seed.snapshot, cas, casDir, image);
  return {
    baseSnapshot,
    fromOptimizerBaseDigest: priorClosure.optimizerBaseDigest as Sha256Digest,
    optimizerBaseDigest,
    seed,
    controller,
    broken: controls.broken,
    degraded: controls.degraded,
  };
}

function migratedRunSourceArtifact(
  config: RecursiveMetaCampaignConfig,
  configHash: Sha256Digest,
  runId: string,
  sourceArtifact: string,
  prepared: PreparedCampaignOptimizerRefreeze,
): Sha256Digest {
  if (runId === `run_recursive_outer_${configHash.slice("sha256:".length)}`) {
    return prepared.controller.sourceArtifact as Sha256Digest;
  }
  if (sourceArtifact === config.seedOptimizer.sourceArtifact) {
    return prepared.seed.sourceArtifact as Sha256Digest;
  }
  if (sourceArtifact === config.controllerOptimizer.sourceArtifact) {
    return prepared.controller.sourceArtifact as Sha256Digest;
  }
  if (sourceArtifact === config.controls.brokenSourceArtifact) {
    return prepared.broken.sourceArtifact;
  }
  if (sourceArtifact === config.controls.degradedSourceArtifact) {
    return prepared.degraded.sourceArtifact;
  }
  return sourceArtifact as Sha256Digest;
}

function migratedContract(
  oldContract: string,
  fromOptimizerDigest: string,
  optimizerDigest: string,
): string {
  const oldLine = `- optimizer digest: \`${fromOptimizerDigest}\``;
  const newLine = `- optimizer digest: \`${optimizerDigest}\``;
  if (oldContract.split(oldLine).length !== 2) {
    throw new UsageError("run contract does not contain exactly one sealed optimizer digest");
  }
  return oldContract.replace(oldLine, newLine);
}

async function planOptimizerRunRefreezes(
  root: string,
  config: RecursiveMetaCampaignConfig,
  configHash: Sha256Digest,
  runs: readonly CampaignRunPin[],
  prepared: PreparedCampaignOptimizerRefreeze,
): Promise<PlannedOptimizerRunRefreeze[]> {
  const planned: PlannedOptimizerRunRefreeze[] = [];
  for (const run of runs) {
    const state = replayRun(run.runDir);
    if ((state.status !== "paused" && state.status !== "running") || state.finished !== null) {
      throw new UsageError(`optimizer refreeze requires nonterminal run ${run.runId} to be paused or lock-proven offline`);
    }
    const expectedSeal = readOptimizerArtifactSeal(run.runDir);
    if (expectedSeal === null) {
      throw new UsageError(`optimizer refreeze run ${run.runId} has no optimizer artifact seal`);
    }
    if (
      expectedSeal.runId !== run.runId
      || expectedSeal.mergedDigest !== state.optimizerDigest
      || expectedSeal.sourceMigrationRecordDigest !== undefined
    ) {
      throw new UsageError(`optimizer refreeze run ${run.runId} does not match its current event seal`);
    }
    const image = authenticateCapsuleSnapshot(run.runDir).image;
    const sourceArtifact = migratedRunSourceArtifact(
      config,
      configHash,
      run.runId,
      expectedSeal.sourceArtifact,
      prepared,
    );
    const replacement = await resolveCandidateOptimizer({
      casDir: casRoot(root),
      artifactHash: sourceArtifact,
      image,
      baseSnapshot: prepared.baseSnapshot,
    });
    const forbidden = changedOptimizerPaths(prepared.baseSnapshot, replacement.snapshot)
      .filter((candidatePath) => !registeredMutablePath(config, candidatePath));
    if (forbidden.length > 0) {
      throw new UsageError(
        `refrozen run ${run.runId} changes paths outside the frozen mutable allowlist: ${forbidden.join(", ")}`,
      );
    }
    const oldContract = readFileSync(join(run.runDir, CONTRACT_FILE), "utf8");
    if (contractHash(oldContract) !== state.contractHash) {
      throw new UsageError(`optimizer refreeze run ${run.runId} contract does not match its event seal`);
    }
    const newContract = migratedContract(oldContract, expectedSeal.mergedDigest, replacement.mergedDigest);
    planned.push({
      pauseBeforeMigration: state.status === "running",
      runDir: run.runDir,
      expectedSeal,
      replacement,
      oldContract,
      newContract,
      record: {
        runId: run.runId,
        image,
        from: {
          sourceArtifact: expectedSeal.sourceArtifact,
          baseDigest: expectedSeal.baseDigest,
          bundleDigest: expectedSeal.mergedDigest,
          contractHash: state.contractHash as Sha256Digest,
        },
        to: {
          sourceArtifact: replacement.sourceArtifact,
          baseDigest: replacement.baseDigest,
          bundleDigest: replacement.mergedDigest,
          contractHash: contractHash(newContract) as Sha256Digest,
        },
      },
    });
  }
  return planned.sort((left, right) => left.record.runId.localeCompare(right.record.runId));
}

function applyOptimizerRunRefreeze(
  plan: PlannedOptimizerRunRefreeze,
  migration: CampaignSourceMigrationV1,
): void {
  const { record, runDir } = plan;
  const contractPath = join(runDir, CONTRACT_FILE);
  const currentContract = readFileSync(contractPath, "utf8");
  const currentContractHash = contractHash(currentContract);
  if (
    currentContractHash !== record.from.contractHash
    && currentContractHash !== record.to.contractHash
  ) {
    throw new UsageError(`optimizer refreeze run ${record.runId} contract changed before commit`);
  }
  if (currentContractHash === record.from.contractHash) {
    writeFileDurable(contractPath, plan.newContract);
    chmodSync(contractPath, 0o600);
  }
  replaceOptimizerArtifactSeal(
    runDir,
    plan.expectedSeal,
    plan.replacement,
    migration.recordDigest,
  );

  let before = replayRun(runDir);
  if (
    before.optimizerDigest === record.to.bundleDigest
    && before.contractHash === record.to.contractHash
  ) {
    const linked = readEvents(runDir).some((event) =>
      event.type === "run.optimizer-migrated"
      && event.sourceMigrationRecordDigest === migration.recordDigest
    );
    if (!linked) {
      throw new UsageError(`optimizer refreeze run ${record.runId} lacks its journal-linked event`);
    }
    return;
  }
  if (before.status === "running" && plan.pauseBeforeMigration) {
    appendEvent(runDir, {
      type: "run.paused",
      runId: record.runId,
      at: migration.at,
      reason: "operator",
    });
    before = replayRun(runDir);
  }
  if (
    before.status !== "paused"
    || before.optimizerDigest !== record.from.bundleDigest
    || before.contractHash !== record.from.contractHash
  ) {
    throw new UsageError(`optimizer refreeze run ${record.runId} event seal changed before commit`);
  }
  appendEvent(runDir, {
    type: "run.optimizer-migrated",
    runId: record.runId,
    at: migration.at,
    fromSourceArtifact: record.from.sourceArtifact,
    sourceArtifact: record.to.sourceArtifact,
    fromBaseDigest: record.from.baseDigest,
    baseDigest: record.to.baseDigest,
    fromOptimizerDigest: record.from.bundleDigest,
    optimizerDigest: record.to.bundleDigest,
    fromContractHash: record.from.contractHash,
    contractHash: record.to.contractHash,
    sourceMigrationRecordDigest: migration.recordDigest,
  });
  const after = replayRun(runDir);
  if (
    after.optimizerDigest !== record.to.bundleDigest
    || after.contractHash !== record.to.contractHash
    || after.status !== "paused"
  ) {
    throw new UsageError(`optimizer refreeze run ${record.runId} did not seal the replacement`);
  }
}

export function applyOptimizerRunRefreezes(
  plans: readonly PlannedOptimizerRunRefreeze[],
  migration: CampaignSourceMigrationV1,
): void {
  for (const plan of plans) applyOptimizerRunRefreeze(plan, migration);
}

async function recoverOptimizerRunRefreezes(
  root: string,
  config: RecursiveMetaCampaignConfig,
  runs: readonly CampaignRunPin[],
  migration: CampaignSourceMigrationV1,
  sealedBase: string,
): Promise<void> {
  const refreeze = migration.optimizerRefreeze;
  if (refreeze === undefined) return;
  const byRunId = new Map(runs.map((run) => [run.runId, run]));
  if (
    canonicalJson([...byRunId.keys()].sort())
    !== canonicalJson(refreeze.runs.map((run) => run.runId))
  ) {
    throw new UsageError("campaign run set does not match the recorded optimizer refreeze");
  }
  const completelyApplied = refreeze.runs.every((record) => {
    const run = byRunId.get(record.runId);
    if (run === undefined) return false;
    const state = replayRun(run.runDir);
    const seal = readOptimizerArtifactSeal(run.runDir);
    const contract = readFileSync(join(run.runDir, CONTRACT_FILE), "utf8");
    return state.status === "paused"
      && state.optimizerDigest === record.to.bundleDigest
      && state.contractHash === record.to.contractHash
      && seal?.sourceArtifact === record.to.sourceArtifact
      && seal.baseDigest === record.to.baseDigest
      && seal.mergedDigest === record.to.bundleDigest
      && seal.sourceMigrationRecordDigest === migration.recordDigest
      && contractHash(contract) === record.to.contractHash
      && readEvents(run.runDir).some((event) =>
        event.type === "run.optimizer-migrated"
        && event.sourceMigrationRecordDigest === migration.recordDigest
      );
  });
  if (completelyApplied) return;

  const prepared = await prepareCampaignOptimizerRefreeze(root, config, sealedBase);
  if (
    prepared.optimizerBaseDigest !== refreeze.optimizerBaseDigest
    || prepared.fromOptimizerBaseDigest !== refreeze.fromOptimizerBaseDigest
    || prepared.seed.sourceArtifact !== refreeze.seed.to.sourceArtifact
    || prepared.seed.mergedDigest !== refreeze.seed.to.bundleDigest
    || prepared.controller.sourceArtifact !== refreeze.controller.to.sourceArtifact
    || prepared.controller.mergedDigest !== refreeze.controller.to.bundleDigest
    || prepared.broken.sourceArtifact !== refreeze.controls.broken.to.sourceArtifact
    || prepared.broken.bundleDigest !== refreeze.controls.broken.to.bundleDigest
    || prepared.degraded.sourceArtifact !== refreeze.controls.degraded.to.sourceArtifact
    || prepared.degraded.bundleDigest !== refreeze.controls.degraded.to.bundleDigest
  ) {
    throw new UsageError("recorded optimizer refreeze does not reproduce from the current source");
  }
  for (const record of refreeze.runs) {
    const run = byRunId.get(record.runId);
    if (run === undefined) throw new UsageError(`recorded optimizer run ${record.runId} is missing`);
    if (readCapsuleSnapshot(run.runDir).image !== record.image) {
      throw new UsageError(`recorded optimizer run ${record.runId} image changed during recovery`);
    }
    const currentSeal = readOptimizerArtifactSeal(run.runDir);
    if (currentSeal === null || currentSeal.runId !== record.runId) {
      throw new UsageError(`recorded optimizer run ${record.runId} has no matching artifact seal`);
    }
    const currentIsFrom =
      currentSeal.sourceArtifact === record.from.sourceArtifact
      && currentSeal.baseDigest === record.from.baseDigest
      && currentSeal.mergedDigest === record.from.bundleDigest
      && currentSeal.sourceMigrationRecordDigest === undefined;
    const currentIsTo =
      currentSeal.sourceArtifact === record.to.sourceArtifact
      && currentSeal.baseDigest === record.to.baseDigest
      && currentSeal.mergedDigest === record.to.bundleDigest
      && currentSeal.sourceMigrationRecordDigest === migration.recordDigest;
    if (!currentIsFrom && !currentIsTo) {
      throw new UsageError(`recorded optimizer run ${record.runId} artifact seal diverged during recovery`);
    }
    const replacement = await resolveCandidateOptimizer({
      casDir: casRoot(root),
      artifactHash: record.to.sourceArtifact,
      image: record.image,
      baseSnapshot: prepared.baseSnapshot,
    });
    if (
      replacement.baseDigest !== record.to.baseDigest
      || replacement.mergedDigest !== record.to.bundleDigest
    ) {
      throw new UsageError(`recorded optimizer run ${record.runId} replacement no longer reproduces`);
    }
    const currentContract = readFileSync(join(run.runDir, CONTRACT_FILE), "utf8");
    const currentContractHash = contractHash(currentContract);
    if (
      currentContractHash !== record.from.contractHash
      && currentContractHash !== record.to.contractHash
    ) {
      throw new UsageError(`recorded optimizer run ${record.runId} contract diverged during recovery`);
    }
    const newContract = currentContractHash === record.to.contractHash
      ? currentContract
      : migratedContract(currentContract, record.from.bundleDigest, record.to.bundleDigest);
    if (contractHash(newContract) !== record.to.contractHash) {
      throw new UsageError(`recorded optimizer run ${record.runId} contract does not reproduce`);
    }
    applyOptimizerRunRefreeze({
      pauseBeforeMigration: replayRun(run.runDir).status === "running",
      runDir: run.runDir,
      record,
      expectedSeal: currentSeal,
      replacement,
      oldContract: currentContract,
      newContract,
    }, migration);
  }
}

export interface CampaignSourceMigrationResult {
  readonly configHash: Sha256Digest;
  readonly campaignPath: string;
  readonly migration: CampaignSourceMigrationV1;
  readonly repinnedRuns: readonly string[];
}

/**
 * Sanctioned frozen-campaign source transition. Every guard and run pin is
 * preflighted before mutation; the campaign file is the durable commit point.
 *
 * On the supported single-operator host, write authority over the campaign
 * file is the migration trust anchor. Record digests authenticate continuity
 * and tamper evidence; they deliberately do not claim a separate signer.
 * A retry accepts only the exact journal head and completes any run-seal or
 * runtime-pin writes named by that record. Every foreign pin or divergent
 * sidecar refuses, so a killed transaction remains fail-closed and recoverable.
 */
export async function migrateCampaignSource(
  request: CampaignSourceMigrationRequest,
): Promise<CampaignSourceMigrationResult> {
  if (!/^[0-9a-f]{40}$/.test(request.from) || !/^[0-9a-f]{40}$/.test(request.to)) {
    throw new UsageError("--from and --to must be full lowercase git commit ids");
  }
  if (request.from === request.to) throw new UsageError("source migration requires different --from and --to commits");
  if (request.reason.trim().length === 0) throw new UsageError("--reason must contain non-whitespace text");
  if ((request.refreezeOptimizer === true) !== (request.sealedBase !== undefined)) {
    throw new UsageError("--refreeze-optimizer requires exactly one --sealed-base <dir>");
  }

  const campaignRecordLock = acquireCampaignRecordLock(request.campaignPath);
  try {
    const originalBytes = readFileSync(request.campaignPath);
    const config = MetaCampaignConfigV2.parse(JSON.parse(originalBytes.toString("utf8")));
    const configHash = metaCampaignConfigHash(config);
    const lastMigration = config.sourceMigrationJournal?.migrations.at(-1);
    const recovering =
      lastMigration?.from === request.from
      && lastMigration.to === request.to
      && lastMigration.bootDigest === request.bootDigest
      && lastMigration.reason === request.reason
      && campaignSourceCommits(config).every((pin) => pin === request.to);
    if (recovering && lastMigration !== undefined) {
      if ((lastMigration.optimizerRefreeze !== undefined) !== (request.refreezeOptimizer === true)) {
        throw new UsageError("migration recovery must repeat the original --refreeze-optimizer choice");
      }
      const plannedRuns = nonterminalCampaignRunPins(
        request.root,
        configHash,
        lastMigration.fromBootDigest,
        lastMigration.bootDigest,
      );
      const releases: Array<() => Promise<void>> = [];
      try {
        for (const run of plannedRuns) releases.push(await acquireRunLock(run.runDir, run.runId));
        const lockedRuns = nonterminalCampaignRunPins(
          request.root,
          configHash,
          lastMigration.fromBootDigest,
          lastMigration.bootDigest,
        );
        if (
          canonicalJson(lockedRuns.map(({ runId, pinnedDigest }) => ({ runId, pinnedDigest })))
          !== canonicalJson(plannedRuns.map(({ runId, pinnedDigest }) => ({ runId, pinnedDigest })))
        ) {
          throw new UsageError("campaign run set changed during source migration recovery; retry");
        }
        await recoverOptimizerRunRefreezes(
          request.root,
          config,
          lockedRuns,
          lastMigration,
          request.sealedBase!,
        );
        for (const run of lockedRuns) {
          writeFileDurable(run.pinPath, `${request.bootDigest}\n`);
        }
        const registeredConfigPath = join(
          runsRoot(request.root),
          `recursive-cell-${configHash.slice("sha256:".length)}`,
          "campaign.json",
        );
        reconcileRegisteredCampaignConfig(registeredConfigPath, config);
        return {
          configHash,
          campaignPath: request.campaignPath,
          migration: lastMigration,
          repinnedRuns: lockedRuns.map(({ runId }) => runId),
        };
      } finally {
        for (const release of releases.reverse()) await release();
      }
    }
    const pins = campaignSourceCommits(config);
    if (pins.some((pin) => pin !== request.from)) {
      throw new UsageError(
        `--from ${request.from} does not exactly match the campaign's current sourceCommit`,
      );
    }

    const prepared = request.refreezeOptimizer === true
      ? await prepareCampaignOptimizerRefreeze(request.root, config, request.sealedBase!)
      : undefined;
    const plannedRuns = nonterminalCampaignRunPins(
      request.root,
      configHash,
      config.trustedRuntime.digest,
      request.bootDigest,
    );
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const run of plannedRuns) releases.push(await acquireRunLock(run.runDir, run.runId));
      const lockedRuns = nonterminalCampaignRunPins(
        request.root,
        configHash,
        config.trustedRuntime.digest,
        request.bootDigest,
      );
      if (
        canonicalJson(lockedRuns.map(({ runId, pinnedDigest }) => ({ runId, pinnedDigest })))
        !== canonicalJson(plannedRuns.map(({ runId, pinnedDigest }) => ({ runId, pinnedDigest })))
      ) {
        throw new UsageError("campaign run set changed during source migration; retry");
      }
      if (prepared !== undefined) {
        const outerRunId = `run_recursive_outer_${configHash.slice("sha256:".length)}`;
        const nonterminalChildren = lockedRuns
          .map((run) => run.runId)
          .filter((runId) => runId !== outerRunId);
        if (nonterminalChildren.length > 0) {
          throw new UsageError(
            `optimizer refreeze requires every child run to be terminal; still open: ${nonterminalChildren.join(", ")}`,
          );
        }
      }
      const runRefreezes = prepared === undefined
        ? []
        : await planOptimizerRunRefreezes(request.root, config, configHash, lockedRuns, prepared);
      const optimizerRefreeze = prepared === undefined
        ? undefined
        : {
          optimizerImage: config.optimizerRuntime.image,
          fromOptimizerBaseDigest: prepared.fromOptimizerBaseDigest,
          optimizerBaseDigest: prepared.optimizerBaseDigest,
          seed: {
            from: {
              sourceArtifact: config.seedOptimizer.sourceArtifact,
              bundleDigest: config.seedOptimizer.bundleDigest,
            },
            to: {
              sourceArtifact: prepared.seed.sourceArtifact,
              bundleDigest: prepared.seed.mergedDigest,
            },
          },
          controller: {
            from: {
              sourceArtifact: config.controllerOptimizer.sourceArtifact,
              bundleDigest: config.controllerOptimizer.bundleDigest,
            },
            to: {
              sourceArtifact: prepared.controller.sourceArtifact,
              bundleDigest: prepared.controller.mergedDigest,
            },
          },
          controls: {
            broken: {
              from: {
                sourceArtifact: config.controls.brokenSourceArtifact,
                bundleDigest: config.controls.brokenBundleDigest,
              },
              to: {
                sourceArtifact: prepared.broken.sourceArtifact,
                bundleDigest: prepared.broken.bundleDigest,
              },
            },
            degraded: {
              from: {
                sourceArtifact: config.controls.degradedSourceArtifact,
                bundleDigest: config.controls.degradedBundleDigest,
              },
              to: {
                sourceArtifact: prepared.degraded.sourceArtifact,
                bundleDigest: prepared.degraded.bundleDigest,
              },
            },
          },
          runs: runRefreezes.map(({ record }) => record),
        } satisfies CampaignOptimizerRefreezeV1;
      const previous = config.sourceMigrationJournal?.migrations.at(-1);
      const body = {
        version: 1,
        at: request.at,
        from: request.from,
        to: request.to,
        fromBootDigest: config.trustedRuntime.digest,
        bootDigest: request.bootDigest,
        reason: request.reason,
        ...(optimizerRefreeze === undefined ? {} : { optimizerRefreeze }),
        ...(request.operator === undefined ? {} : { operator: request.operator }),
        previousRecordDigest: previous?.recordDigest ?? null,
      } as const;
      const migration = {
        ...body,
        recordDigest: campaignSourceMigrationRecordDigest(body),
      } satisfies CampaignSourceMigrationV1;
      const migrated = MetaCampaignConfigV2.parse({
        ...config,
        seedOptimizer: {
          ...config.seedOptimizer,
          sourceCommit: request.to,
          ...(optimizerRefreeze === undefined ? {} : optimizerRefreeze.seed.to),
        },
        controllerOptimizer: {
          ...config.controllerOptimizer,
          sourceCommit: request.to,
          ...(optimizerRefreeze === undefined ? {} : optimizerRefreeze.controller.to),
        },
        trustedRuntime: {
          ...config.trustedRuntime,
          sourceCommit: request.to,
          digest: request.bootDigest,
        },
        controls: optimizerRefreeze === undefined
          ? config.controls
          : {
            brokenSourceArtifact: optimizerRefreeze.controls.broken.to.sourceArtifact,
            brokenBundleDigest: optimizerRefreeze.controls.broken.to.bundleDigest,
            degradedSourceArtifact: optimizerRefreeze.controls.degraded.to.sourceArtifact,
            degradedBundleDigest: optimizerRefreeze.controls.degraded.to.bundleDigest,
          },
        sourceMigrationJournal: {
          version: 1,
          campaignConfigHash: config.sourceMigrationJournal?.campaignConfigHash ?? configHash,
          migrations: [...(config.sourceMigrationJournal?.migrations ?? []), migration],
        },
      });
      assertCampaignSourceMigrationOnly(config, migrated);
      if (metaCampaignConfigHash(migrated) !== configHash) {
        throw new UsageError("source migration changed the frozen campaign identity");
      }
      const registeredConfigPath = join(
        runsRoot(request.root),
        `recursive-cell-${configHash.slice("sha256:".length)}`,
        "campaign.json",
      );
      if (!readFileSync(request.campaignPath).equals(originalBytes)) {
        throw new UsageError("campaign file changed during source migration; retry");
      }
      const registeredNeedsReconciliation =
        registeredCampaignConfigNeedsReconciliation(registeredConfigPath, migrated);

      // The journal is the transaction commit point. Any interruption after
      // this write is fail-closed: ordinary resume sees a mismatched run seal
      // or runtime pin until this same command completes the recorded plan.
      writeFileDurable(request.campaignPath, `${JSON.stringify(migrated, null, 2)}\n`);
      chmodSync(request.campaignPath, 0o600);
      applyOptimizerRunRefreezes(runRefreezes, migration);
      for (const run of lockedRuns) {
        writeFileDurable(run.pinPath, `${request.bootDigest}\n`);
      }
      reconcileRegisteredCampaignConfig(
        registeredConfigPath,
        migrated,
        registeredNeedsReconciliation,
      );
      return {
        configHash,
        campaignPath: request.campaignPath,
        migration,
        repinnedRuns: lockedRuns.map(({ runId }) => runId),
      };
    } finally {
      for (const release of releases.reverse()) await release();
    }
  } finally {
    campaignRecordLock.release();
  }
}

function repinCampaignCapsuleImage(
  config: RecursiveMetaCampaignConfig,
  capsuleId: string,
  image: string,
): RecursiveMetaCampaignConfig {
  const replace = <T extends MetaCapsuleEntry>(capsule: T): T => (
    capsule.capsuleId === capsuleId ? { ...capsule, image } : capsule
  );
  return MetaCampaignConfigV2.parse({
    ...config,
    train: config.train.map(replace),
    holdout: config.holdout.map(replace),
    developmentPanel: {
      ...config.developmentPanel,
      members: config.developmentPanel.members.map((member) => ({
        ...member,
        capsule: replace(member.capsule),
      })),
    },
  });
}

function imageRepinFrozenProjection(
  configInput: RecursiveMetaCampaignConfig,
  capsuleId: string,
): string {
  const config = MetaCampaignConfigV2.parse(configInput);
  const { imageRepinJournal: _journal, ...withoutJournal } = config;
  return canonicalJson(repinCampaignCapsuleImage(
    MetaCampaignConfigV2.parse(withoutJournal),
    capsuleId,
    "hone-repin-projection@sha256:0000000000000000000000000000000000000000000000000000000000000000",
  ));
}

/** Mutation guard: an image re-pin may touch only one capsule image and its journal. */
export function assertCampaignImageRepinOnly(
  before: RecursiveMetaCampaignConfig,
  after: RecursiveMetaCampaignConfig,
  capsuleId: string,
): void {
  if (imageRepinFrozenProjection(before, capsuleId) !== imageRepinFrozenProjection(after, capsuleId)) {
    throw new UsageError("campaign image re-pin attempted to alter frozen campaign fields");
  }
}

function currentCampaignCapsuleImage(
  config: RecursiveMetaCampaignConfig,
  capsuleId: string,
): string {
  const matches = [...config.train, ...config.holdout]
    .filter((capsule) => capsule.capsuleId === capsuleId);
  if (matches.length !== 1) {
    throw new UsageError(`--capsule ${capsuleId} must name exactly one campaign corpus entry`);
  }
  return matches[0]!.image;
}

export interface CampaignImageRepinRequest {
  readonly root: string;
  readonly campaignPath: string;
  readonly capsuleId: string;
  readonly fromImage: string;
  readonly toImage: string;
  readonly evidencePath: string;
  readonly reason: string;
  readonly at: string;
  readonly operator?: string;
}

export interface CampaignImageRepinResult {
  readonly configHash: Sha256Digest;
  readonly campaignPath: string;
  readonly repin: CampaignImageRepinV1;
}

type DistributionEvidence = Extract<
  z.infer<typeof CampaignImageEquivalenceEvidenceV1>,
  { evidenceMode: "distribution" }
>;

interface VerifiedDistributionEvidenceFiles {
  readonly files: readonly { path: string; bytes: Buffer }[];
}

function installedCampaignCapsule(
  root: string,
  config: RecursiveMetaCampaignConfig,
  capsuleId: string,
): DiscoveredCapsule {
  const registered = [...config.train, ...config.holdout]
    .find((entry) => entry.capsuleId === capsuleId);
  if (registered === undefined) {
    throw new UsageError(`distribution evidence names unknown capsule ${capsuleId}`);
  }
  if ("mode" in config.corpusCohort) {
    const policy = verifyM2AuthorizedPartialCohort(root, config.corpusCohort.partialCohort);
    const authorized = policy.admitted.find((entry) => entry.capsuleId === capsuleId);
    if (authorized === undefined) {
      throw new UsageError(`distribution evidence capsule ${capsuleId} is not admitted`);
    }
    const dir = join(root, "capsules", authorized.label);
    const admitted = admitCapsule(dir, {
      review: "required",
      allowMissingGitBaselineWithOwnerReceipt: true,
    });
    if (
      admitted.provisional
      || admitted.manifest.id !== authorized.capsuleId
      || admitted.digest !== authorized.capsuleDigest
      || admitted.approval?.receipt.recordHash !== authorized.gate2ReceiptHash
      || !gate2ReceiptCitesAuthorizedBasis(
        policy,
        authorized,
        admitted.approval.receipt.approvalBasis,
      )
    ) {
      throw new UsageError(`distribution evidence capsule ${capsuleId} failed admission binding`);
    }
    const capsule = { dir, admitted };
    resolveRegisteredCapsuleLocation(config, registered, capsule);
    return capsule;
  }
  const capsule = discoverCapsules(root).get(capsuleId);
  if (capsule === undefined) {
    throw new UsageError(`distribution evidence capsule ${capsuleId} is not installed`);
  }
  resolveRegisteredCapsuleLocation(config, registered, capsule);
  return capsule;
}

function installedEvaluatorSourcePath(capsule: DiscoveredCapsule): string {
  const entrypoint = capsule.admitted.manifest.evalEntrypoint;
  const source = [...entrypoint].reverse().find((arg) => !arg.startsWith("-"));
  if (source === undefined || source === entrypoint[0]) {
    throw new UsageError("distribution evidence requires a capsule evaluator source entrypoint");
  }
  if (source.startsWith("/trusted/baseline/")) {
    return resolve(capsule.dir, "baseline", source.slice("/trusted/baseline/".length));
  }
  if (source.startsWith("/trusted/")) {
    return resolve(capsule.dir, source.slice("/trusted/".length));
  }
  return resolve(capsule.dir, "baseline", source);
}

function evidenceFileWithin(root: string, input: string, label: string): string {
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new UsageError(`${label} must stay inside ${root}`);
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new UsageError(`${label} must name an existing regular file`);
  }
  return path;
}

export function verifyStructuralNondeterminism(
  root: string,
  proof: CampaignImageStructuralNondeterminismProofV1,
  installedEvaluatorPath: string,
): { path: string; bytes: Buffer } {
  const sourcePath = evidenceFileWithin(root, proof.evaluatorSourcePath, "evaluator source");
  if (sourcePath !== installedEvaluatorPath) {
    throw new UsageError("structural proof source must match the installed capsule evaluator");
  }
  const sourceBytes = readFileSync(sourcePath);
  if (sha256(sourceBytes) !== proof.evaluatorSourceSha256) {
    throw new UsageError("evaluator source hash does not match structural nondeterminism proof");
  }
  const source = sourceBytes.toString("utf8");
  if (source.includes(proof.seedEnvironmentVariable)) {
    throw new UsageError(
      `distribution evidence is forbidden because the evaluator reads ${proof.seedEnvironmentVariable}`,
    );
  }
  const lines = source.split(/\r?\n/);
  const verifyCitations = (
    citations: readonly { line: number; exactSourceLine: string }[],
    label: string,
    signal: RegExp,
  ): void => {
    for (const citation of citations) {
      if (lines[citation.line - 1] !== citation.exactSourceLine) {
        throw new UsageError(`${label} source citation does not match evaluator line ${citation.line}`);
      }
      if (!signal.test(citation.exactSourceLine)) {
        throw new UsageError(`${label} source citation does not contain the required nondeterminism signal`);
      }
    }
  };
  verifyCitations(proof.entropySources, "entropy", /secrets\.|random\.|urandom|nonce/i);
  verifyCitations(proof.timingSources, "timing", /time\.|monotonic|perf_counter|elapsed|wall/i);
  return { path: sourcePath, bytes: sourceBytes };
}

function verifyDistributionEvidence(
  request: CampaignImageRepinRequest,
  evidence: DistributionEvidence,
  config: RecursiveMetaCampaignConfig,
): VerifiedDistributionEvidenceFiles {
  const evidenceDir = dirname(request.evidencePath);
  const preRegistrationPath = evidenceFileWithin(
    evidenceDir,
    evidence.preRegistrationPath,
    "distribution pre-registration",
  );
  const preRegistrationBytes = readFileSync(preRegistrationPath);
  if (sha256(preRegistrationBytes) !== evidence.preRegistrationSha256) {
    throw new UsageError("distribution pre-registration hash does not match evidence");
  }
  let preRegistration: z.infer<typeof CampaignImageDistributionPreregistrationV1>;
  try {
    preRegistration = CampaignImageDistributionPreregistrationV1.parse(
      JSON.parse(preRegistrationBytes.toString("utf8")),
    );
  } catch (error) {
    throw new UsageError(
      `invalid distribution pre-registration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    preRegistration.capsuleId !== evidence.capsuleId
    || preRegistration.fromImage !== evidence.fromImage
    || preRegistration.toImage !== evidence.toImage
    || preRegistration.baseline.artifact !== evidence.baseline.artifact
    || preRegistration.baseline.historicalScore !== evidence.baseline.historicalScore
    || preRegistration.settledCandidate.artifact !== evidence.settledCandidate.artifact
    || preRegistration.settledCandidate.historicalScore !== evidence.settledCandidate.historicalScore
    || canonicalJson(preRegistration.structuralNondeterminism)
      !== canonicalJson(evidence.structuralNondeterminism)
  ) {
    throw new UsageError("distribution evidence does not match its pre-registration");
  }
  if (
    preRegistration.measurementPlan.k !== evidence.k
    || evidence.baseline.rawScores.length < preRegistration.measurementPlan.replicatesPerArtifact
    || evidence.settledCandidate.rawScores.length < preRegistration.measurementPlan.replicatesPerArtifact
  ) {
    throw new UsageError("distribution evidence does not satisfy its pre-registered measurement plan");
  }
  const registeredAt = Date.parse(preRegistration.registeredAt);
  const measurementStartedAt = Date.parse(evidence.measurementStartedAt);
  const measurementCompletedAt = Date.parse(evidence.measurementCompletedAt);
  const generatedAt = Date.parse(evidence.generatedAt);
  if (!(
    registeredAt < measurementStartedAt
    && measurementStartedAt <= measurementCompletedAt
    && measurementCompletedAt <= generatedAt
  )) {
    throw new UsageError("distribution measurement was not performed after pre-registration");
  }
  const capsule = installedCampaignCapsule(request.root, config, evidence.capsuleId);
  const source = verifyStructuralNondeterminism(
    request.root,
    evidence.structuralNondeterminism,
    installedEvaluatorSourcePath(capsule),
  );
  return {
    files: [
      { path: preRegistrationPath, bytes: preRegistrationBytes },
      source,
    ],
  };
}

/**
 * Sanctioned frozen-campaign image replacement. Exact replay remains the
 * default; the distribution arm additionally verifies a prior registration
 * and evaluator-source proof. Evidence bytes are hashed before the append-only
 * record becomes the durable commit point under the shared campaign lock.
 */
export function repinCampaignImage(request: CampaignImageRepinRequest): CampaignImageRepinResult {
  if (!/^cap_[0-9a-f]{12}$/.test(request.capsuleId)) {
    throw new UsageError("--capsule must be a canonical capsule id");
  }
  if (request.fromImage === request.toImage) {
    throw new UsageError("campaign image re-pin requires different --from-image and --to-image");
  }
  if (request.reason.trim().length === 0) throw new UsageError("--reason must contain non-whitespace text");
  if (!existsSync(request.evidencePath) || !statSync(request.evidencePath).isFile()) {
    throw new UsageError("--evidence must name an existing regular file");
  }

  const evidenceBytes = readFileSync(request.evidencePath);
  let evidence: z.infer<typeof CampaignImageEquivalenceEvidenceV1>;
  try {
    evidence = CampaignImageEquivalenceEvidenceV1.parse(JSON.parse(evidenceBytes.toString("utf8")));
  } catch (error) {
    throw new UsageError(
      `invalid image equivalence evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    evidence.capsuleId !== request.capsuleId
    || evidence.fromImage !== request.fromImage
    || evidence.toImage !== request.toImage
  ) {
    throw new UsageError("image equivalence evidence identity does not match the requested re-pin");
  }
  let distributionFiles: VerifiedDistributionEvidenceFiles = { files: [] };
  const evidenceSha256 = sha256(evidenceBytes);
  const evidencePath = relative(dirname(request.campaignPath), request.evidencePath).split(sep).join("/");
  if (evidencePath.length === 0) throw new UsageError("--evidence must not be the campaign file");

  const campaignRecordLock = acquireCampaignRecordLock(request.campaignPath);
  try {
    const originalBytes = readFileSync(request.campaignPath);
    const config = MetaCampaignConfigV2.parse(JSON.parse(originalBytes.toString("utf8")));
    const configHash = metaCampaignConfigHash(config);
    const currentImage = currentCampaignCapsuleImage(config, request.capsuleId);
    if (currentImage !== request.fromImage) {
      throw new UsageError(
        `--from-image ${request.fromImage} does not exactly match capsule ${request.capsuleId} image ${currentImage}`,
      );
    }
    if ("evidenceMode" in evidence && evidence.evidenceMode === "distribution") {
      distributionFiles = verifyDistributionEvidence(request, evidence, config);
    }

    const previous = config.imageRepinJournal?.repins.at(-1);
    const body = {
      version: 1,
      at: request.at,
      capsuleId: request.capsuleId,
      fromImage: request.fromImage,
      toImage: request.toImage,
      evidencePath,
      evidenceSha256,
      reason: request.reason,
      ...(request.operator === undefined ? {} : { operator: request.operator }),
      previousRecordDigest: previous?.recordDigest ?? null,
    } as const;
    const repin = {
      ...body,
      recordDigest: campaignImageRepinRecordDigest(body),
    } satisfies CampaignImageRepinV1;
    const migrated = MetaCampaignConfigV2.parse({
      ...repinCampaignCapsuleImage(config, request.capsuleId, request.toImage),
      imageRepinJournal: {
        version: 1,
        campaignConfigHash: config.imageRepinJournal?.campaignConfigHash ?? configHash,
        repins: [...(config.imageRepinJournal?.repins ?? []), repin],
      },
    });
    assertCampaignImageRepinOnly(config, migrated, request.capsuleId);
    if (metaCampaignConfigHash(migrated) !== configHash) {
      throw new UsageError("campaign image re-pin changed the frozen campaign identity");
    }

    const registeredConfigPath = join(
      runsRoot(request.root),
      `recursive-cell-${configHash.slice("sha256:".length)}`,
      "campaign.json",
    );
    const registeredNeedsReconciliation =
      registeredCampaignConfigNeedsReconciliation(registeredConfigPath, migrated);
    if (!readFileSync(request.campaignPath).equals(originalBytes)) {
      throw new UsageError("campaign file changed during image re-pin; retry");
    }
    if (!readFileSync(request.evidencePath).equals(evidenceBytes)) {
      throw new UsageError("image equivalence evidence changed during re-pin; retry");
    }
    for (const file of distributionFiles.files) {
      if (!readFileSync(file.path).equals(file.bytes)) {
        throw new UsageError("distribution evidence input changed during re-pin; retry");
      }
    }
    writeFileDurable(request.campaignPath, `${JSON.stringify(migrated, null, 2)}\n`);
    chmodSync(request.campaignPath, 0o600);
    reconcileRegisteredCampaignConfig(
      registeredConfigPath,
      migrated,
      registeredNeedsReconciliation,
    );
    return { configHash, campaignPath: request.campaignPath, repin };
  } finally {
    campaignRecordLock.release();
  }
}


/** Explicit operator front door for frozen-campaign source and closure records. */
export async function campaignCommand(args: string[], io: CmdIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "migrate-source") {
    const { positionals, flags } = parseFlags(rest, {
      booleans: ["refreeze-optimizer"],
      strings: ["campaign", "from", "to", "reason", "sealed-base"],
    });
    const campaignFlag = strFlag(flags, "campaign");
    const from = strFlag(flags, "from");
    const to = strFlag(flags, "to");
    const reason = strFlag(flags, "reason");
    const sealedBaseFlag = strFlag(flags, "sealed-base");
    if (
      positionals.length !== 0
      || campaignFlag === undefined
      || from === undefined
      || to === undefined
      || reason === undefined
    ) {
      throw new UsageError(CAMPAIGN_MIGRATE_SOURCE_USAGE);
    }
    if (!/^[0-9a-f]{40}$/.test(from) || !/^[0-9a-f]{40}$/.test(to)) {
      throw new UsageError("--from and --to must be full lowercase git commit ids");
    }

    assertCleanSourceTree(io.root);
    const resolvedCommit = sourceCommit(io.root);
    if (resolvedCommit !== to) {
      throw new UsageError(`--to ${to} does not resolve to the clean working tree HEAD ${resolvedCommit}`);
    }
    const campaignPath = resolve(io.root, campaignFlag);
    assertCampaignPathUntracked(io.root, campaignPath);
    const bootDigest = verifiedBootRuntimeDigest() as Sha256Digest;
    const operator = io.env["USER"] ?? io.env["LOGNAME"];
    const result = await migrateCampaignSource({
      root: io.root,
      campaignPath,
      from,
      to,
      reason,
      at: new Date().toISOString(),
      bootDigest,
      ...(operator === undefined || operator.trim().length === 0 ? {} : { operator }),
      ...(boolFlag(flags, "refreeze-optimizer") ? { refreezeOptimizer: true } : {}),
      ...(sealedBaseFlag === undefined ? {} : { sealedBase: resolve(io.root, sealedBaseFlag) }),
    });
    io.out(canonicalJson({
      command: "campaign.migrate-source",
      ...result,
    }));
    return 0;
  }

  if (subcommand === "repin-image") {
    const { positionals, flags } = parseFlags(rest, {
      booleans: [],
      strings: ["campaign", "capsule", "from-image", "to-image", "evidence", "reason"],
    });
    const campaignFlag = strFlag(flags, "campaign");
    const capsuleId = strFlag(flags, "capsule");
    const fromImage = strFlag(flags, "from-image");
    const toImage = strFlag(flags, "to-image");
    const evidenceFlag = strFlag(flags, "evidence");
    const reason = strFlag(flags, "reason");
    if (
      positionals.length !== 0
      || campaignFlag === undefined
      || capsuleId === undefined
      || fromImage === undefined
      || toImage === undefined
      || evidenceFlag === undefined
      || reason === undefined
    ) {
      throw new UsageError(CAMPAIGN_REPIN_IMAGE_USAGE);
    }
    const campaignPath = resolve(io.root, campaignFlag);
    assertCampaignPathUntracked(io.root, campaignPath);
    const operator = io.env["USER"] ?? io.env["LOGNAME"];
    const result = repinCampaignImage({
      root: io.root,
      campaignPath,
      capsuleId,
      fromImage,
      toImage,
      evidencePath: resolve(io.root, evidenceFlag),
      reason,
      at: new Date().toISOString(),
      ...(operator === undefined || operator.trim().length === 0 ? {} : { operator }),
    });
    io.out(canonicalJson({ command: "campaign.repin-image", ...result }));
    return 0;
  }

  if (subcommand === "capture-closure") {
    const { positionals, flags } = parseFlags(rest, {
      booleans: ["dry-run"],
      strings: [
        "campaign",
        "source",
        "source-commit",
        "cas",
        "node-modules-archive",
        "archive-sha256",
        "optimizer-base-digest",
        "at",
        "restore",
        "verify-image",
        "verify-digest",
      ],
    });
    const campaignFlag = strFlag(flags, "campaign");
    const sourceFlag = strFlag(flags, "source");
    const casFlag = strFlag(flags, "cas");
    const archiveFlag = strFlag(flags, "node-modules-archive");
    const sidecarFlag = strFlag(flags, "archive-sha256");
    const restoreFlag = strFlag(flags, "restore");
    const verifyImage = strFlag(flags, "verify-image");
    const verifyDigest = digestFlag(strFlag(flags, "verify-digest"), "--verify-digest");
    const dryRun = boolFlag(flags, "dry-run");
    if (
      positionals.length !== 0
      || campaignFlag === undefined
      || sourceFlag === undefined
      || (archiveFlag === undefined) !== (sidecarFlag === undefined)
      || (dryRun && casFlag === undefined)
      || ((verifyImage === undefined) !== (verifyDigest === undefined))
      || (verifyImage !== undefined && restoreFlag === undefined)
    ) {
      throw new UsageError(CAMPAIGN_CAPTURE_CLOSURE_USAGE);
    }

    const campaignPath = resolve(io.root, campaignFlag);
    const originalBytes = readFileSync(campaignPath);
    const config = MetaCampaignConfigV2.parse(JSON.parse(originalBytes.toString("utf8")));
    const configHash = metaCampaignConfigHash(config);
    if (!dryRun) assertCampaignPathUntracked(io.root, campaignPath);
    const sourceCommitFlag = strFlag(flags, "source-commit");
    if (sourceCommitFlag !== undefined && !/^[0-9a-f]{40}$/.test(sourceCommitFlag)) {
      throw new UsageError("--source-commit must be a full lowercase git commit id");
    }
    const captureSourceCommit = sourceCommitFlag ?? config.trustedRuntime.sourceCommit;
    const campaignSourceLineage = new Set<string>([config.trustedRuntime.sourceCommit]);
    for (const migration of config.sourceMigrationJournal?.migrations ?? []) {
      campaignSourceLineage.add(migration.from);
      campaignSourceLineage.add(migration.to);
    }
    if (!campaignSourceLineage.has(captureSourceCommit)) {
      throw new UsageError("--source-commit is not present in the campaign source-migration lineage");
    }
    const priorCapture = config.runtimeClosureJournal?.captures.at(-1);
    const explicitBaseDigest = digestFlag(
      strFlag(flags, "optimizer-base-digest"),
      "--optimizer-base-digest",
    );
    const optimizerBaseDigest = explicitBaseDigest
      ?? (priorCapture?.optimizerBaseDigest as Sha256Digest | undefined)
      ?? config.seedOptimizer.bundleDigest as Sha256Digest;
    const casDir = casFlag === undefined ? casRoot(io.root) : resolve(io.root, casFlag);
    const sourceRoot = resolve(io.root, sourceFlag);
    const archivePath = archiveFlag === undefined ? undefined : resolve(io.root, archiveFlag);
    const sidecarPath = sidecarFlag === undefined ? undefined : resolve(io.root, sidecarFlag);
    const capture = await captureRuntimeClosure({
      sourceRoot,
      sourceCommit: captureSourceCommit,
      campaignBootDigest: config.trustedRuntime.digest as Sha256Digest,
      ...(captureSourceCommit === config.trustedRuntime.sourceCommit
        ? { expectedBootDigest: config.trustedRuntime.digest as Sha256Digest }
        : {}),
      optimizerImage: config.optimizerRuntime.image,
      optimizerBaseDigest,
      campaignConfigHash: configHash,
      capturedAt: strFlag(flags, "at") ?? new Date().toISOString(),
      casDir,
      previousRecordDigest: priorCapture?.recordDigest as Sha256Digest | undefined ?? null,
      ...(archivePath === undefined || sidecarPath === undefined
        ? {}
        : {
          nodeModulesArchive: archivePath,
          nodeModulesArchiveSha256: parseSha256Sidecar(sidecarPath, archivePath),
        }),
    });
    withRuntimeClosureCapture(config, capture.record);

    let verifiedOptimizerIdentity: { image: string; digest: string } | undefined;
    const restored = restoreFlag === undefined
      ? undefined
      : restoreRuntimeClosure({
        casDir,
        targetDir: resolve(io.root, restoreFlag),
        campaignConfigHash: configHash,
        record: capture.record,
      });
    if (restored !== undefined && verifyImage !== undefined && verifyDigest !== undefined) {
      const digest = snapshotDigest(
        verifyImage,
        collectOptimizerSnapshot(restored.targetDir),
      );
      if (digest !== verifyDigest) {
        throw new UsageError(`restored optimizer identity mismatch: ${digest} != sealed ${verifyDigest}`);
      }
      verifiedOptimizerIdentity = { image: verifyImage, digest };
    }
    if (!dryRun) {
      const acquired = acquireCampaignRecordLock(campaignPath);
      try {
        appendRuntimeClosureCaptureRecord(campaignPath, capture.record, acquired.lock, originalBytes);
      } finally {
        acquired.release();
      }
    }
    io.out(canonicalJson({
      command: "campaign.capture-closure",
      campaignPath,
      casDir,
      configHash,
      dryRun,
      recordAppended: !dryRun,
      marginalBytes: capture.marginalBytes,
      reusedBytes: capture.reusedBytes,
      record: capture.record,
      ...(restored === undefined ? {} : { restored }),
      ...(verifiedOptimizerIdentity === undefined ? {} : { verifiedOptimizerIdentity }),
    }));
    return 0;
  }

  if (subcommand === "smoke-capsules") {
    const { positionals, flags } = parseFlags(rest, {
      booleans: [],
      strings: ["campaign", "evidence"],
    });
    const campaignFlag = strFlag(flags, "campaign");
    const evidenceFlag = strFlag(flags, "evidence");
    if (positionals.length !== 0 || campaignFlag === undefined || evidenceFlag === undefined) {
      throw new UsageError(CAMPAIGN_SMOKE_CAPSULES_USAGE);
    }
    assertCleanSourceTree(io.root);
    const campaignPath = resolve(io.root, campaignFlag);
    const config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    const source = sourceCommit(io.root);
    const runtimeDigest = verifiedBootRuntimeDigest() as Sha256Digest;
    const result = await runPanelCapsuleSmoke({
      root: io.root,
      config,
      sourceCommit: source,
      runtimeDigest,
      evidencePath: resolve(io.root, evidenceFlag),
      capsules: resolveRegisteredCapsules(io.root, config),
    });
    io.out(canonicalJson({
      command: "campaign.smoke-capsules",
      campaignPath,
      evidencePath: resolve(io.root, evidenceFlag),
      guardPath: result.guardPath,
      campaignConfigHash: result.receipt.campaignConfigHash,
      capsules: result.receipt.capsules.length,
      dispatch: result.receipt.dispatch,
      ignitionEligible: result.receipt.ignitionEligible,
    }));
    return 0;
  }

  if (subcommand === "restore-closure") {
    const { positionals, flags } = parseFlags(rest, {
      booleans: [],
      strings: ["campaign", "target", "cas", "manifest"],
    });
    const campaignFlag = strFlag(flags, "campaign");
    const targetFlag = strFlag(flags, "target");
    if (positionals.length !== 0 || campaignFlag === undefined || targetFlag === undefined) {
      throw new UsageError(CAMPAIGN_RESTORE_CLOSURE_USAGE);
    }
    const campaignPath = resolve(io.root, campaignFlag);
    const config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    const configHash = metaCampaignConfigHash(config);
    const record = runtimeClosureCaptureRecord(config, strFlag(flags, "manifest"));
    const casFlag = strFlag(flags, "cas");
    const result = restoreRuntimeClosure({
      casDir: casFlag === undefined ? casRoot(io.root) : resolve(io.root, casFlag),
      targetDir: resolve(io.root, targetFlag),
      campaignConfigHash: configHash,
      record,
    });
    io.out(canonicalJson({
      command: "campaign.restore-closure",
      campaignPath,
      manifestArtifact: record.manifestArtifact,
      ...result,
    }));
    return 0;
  }

  throw new UsageError(
    `${CAMPAIGN_MIGRATE_SOURCE_USAGE}\n${CAMPAIGN_REPIN_IMAGE_USAGE}\n`
    + `${CAMPAIGN_CAPTURE_CLOSURE_USAGE}\n${CAMPAIGN_RESTORE_CLOSURE_USAGE}\n`
    + CAMPAIGN_SMOKE_CAPSULES_USAGE,
  );
}

async function prepareControl(
  control: MetaControlArtifact,
  cas: CasStore,
  casDir: string,
  image: string,
  baseSnapshot: OptimizerSnapshot,
): Promise<RegisteredControl> {
  const sourceArtifact = await cas.putBuffer(control.bytes) as Sha256Digest;
  if (sourceArtifact !== control.digest || sourceArtifact !== control.receipt.artifactDigest) {
    throw new UsageError("trusted control source artifact digest is not self-consistent");
  }
  const resolved = await resolveCandidateOptimizer({
    casDir,
    artifactHash: sourceArtifact,
    image,
    baseSnapshot,
  });
  return {
    sourceArtifact,
    bundleDigest: resolved.mergedDigest as Sha256Digest,
    transformationReceipt: control.receipt,
  };
}

export function createSyntheticCapsule(
  campaignDir: string,
  config: AnyMetaCampaignConfig,
  baselineArtifactHash: Sha256Digest,
  casDir: string,
): string {
  const capsuleDir = join(campaignDir, "outer-capsule");
  mkdirSync(capsuleDir, { recursive: true, mode: 0o700 });
  chmodSync(capsuleDir, 0o700);
  const baselineDir = join(capsuleDir, "baseline");
  if (!existsSync(baselineDir)) extractWorkspaceArtifact(casDir, baselineArtifactHash, baselineDir);
  const asset = Buffer.from("trusted meta task; protected corpus coordinates are not present\n");
  writeFileSync(join(capsuleDir, "meta-task.txt"), asset, { mode: 0o600 });
  const summary = (value: number, passes: boolean) => ({
    train: value,
    validation: value,
    combined: value,
    trainTestsPass: passes,
    validationTestsPass: passes,
  });
  const ordering = DiagnosticOrderingReport.parse({
    version: 1,
    variants: {
      broken: summary(0, false),
      naive: summary(0.25, false),
      baseline: summary(0.5, true),
      shortcut: { train: 0.75, validation: 0.25, combined: 0.5, trainTestsPass: true, validationTestsPass: false },
      improved: summary(1, true),
    },
    stability: { aggregates: [0.5, 0.5, 0.5], spread: 0, band: 0.01 },
    failures: [],
  });
  const orderingBytes = Buffer.from(`${JSON.stringify(ordering, null, 2)}\n`);
  writeFileSync(join(capsuleDir, "ordering.json"), orderingBytes, { mode: 0o600 });
  const draft = {
    schemaVersion: 2 as const,
    id: "cap_000000000000",
    objective: config.objective,
    baseline: { kind: "cas" as const, hash: baselineArtifactHash },
    image: config.version === 2 ? config.optimizerRuntime.image : config.train[0]!.image,
    evalEntrypoint: ["/bin/false"],
    protectedPaths: config.protectedPaths.map((candidatePath) => candidatePath.replace(/^optimizer\//, "")),
    assetGroups: [{ id: "meta-train", visibility: "public" as const, paths: ["meta-task.txt"] }],
    budget: config.budgets.outer,
    diagnosticOrdering: { path: "ordering.json", hash: sha256(orderingBytes) },
    contentHashes: { "meta-task.txt": sha256(asset) },
    meta: { evaluatorSource: "meta" as const, provenance: "trusted synthetic M1 meta task" },
  };
  const manifest = CapsuleManifest.parse({ ...draft, id: deriveCapsuleId(draft) });
  writeFileSync(join(capsuleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  // This validates the just-authored trusted synthetic task before its
  // campaign/config seal exists, so it genuinely precedes Gate 2. Its later
  // run-boundary byte recheck uses the same explicit trusted bypass.
  admitCapsule(capsuleDir, { review: "off" });
  return capsuleDir;
}

interface FrozenCampaignIdentities {
  readonly sourceCommit: string;
  readonly runtimeDigest: Sha256Digest;
  readonly seedSourceArtifact: Sha256Digest;
  readonly seedBundleDigest: Sha256Digest;
  readonly brokenControl: RegisteredControl;
  readonly degradedControl: RegisteredControl;
}

function freezeCampaignConfig(
  draft: MetaCampaignConfig,
  identities: FrozenCampaignIdentities,
): MetaCampaignConfig {
  const identified = {
    ...draft,
    seedOptimizer: {
      sourceCommit: identities.sourceCommit,
      sourceArtifact: identities.seedSourceArtifact,
      bundleDigest: identities.seedBundleDigest,
    },
    trustedRuntime: {
      sourceCommit: identities.sourceCommit,
      digest: identities.runtimeDigest,
    },
    controls: {
      brokenSourceArtifact: identities.brokenControl.sourceArtifact,
      brokenBundleDigest: identities.brokenControl.bundleDigest,
      degradedSourceArtifact: identities.degradedControl.sourceArtifact,
      degradedBundleDigest: identities.degradedControl.bundleDigest,
    },
  };
  const { protocolHash: _protocolHash, analysisConfigHash: _analysisConfigHash, ...protocolFields } = identified;
  const protocolHash = sha256(canonicalJson({
    domain: "hone-m1-protocol-v1",
    config: protocolFields,
  }));
  const analysisConfigHash = sha256(canonicalJson({
    domain: "hone-m1-analysis-v1",
    train: identified.train.map(({ capsuleId, capsuleDigest, scalarizerDigest, qFail, qBase, qReference, scale }) => ({
      capsuleId,
      capsuleDigest,
      scalarizerDigest,
      qFail,
      qBase,
      qReference,
      scale,
    })),
    holdout: identified.holdout.map(({ capsuleId, capsuleDigest, scalarizerDigest, qFail, qBase, qReference, scale }) => ({
      capsuleId,
      capsuleDigest,
      scalarizerDigest,
      qFail,
      qBase,
      qReference,
      scale,
    })),
    promotion: identified.promotion,
    allowedClaim: identified.allowedClaim,
  }));
  return MetaCampaignConfigV1.parse({ ...identified, protocolHash, analysisConfigHash });
}

interface FrozenRecursiveIdentities {
  readonly sourceCommit: string;
  readonly runtimeDigest: Sha256Digest;
  readonly target: ResolvedCandidateOptimizer;
  readonly controller: ResolvedCandidateOptimizer;
  readonly brokenControl: RegisteredControl;
  readonly degradedControl: RegisteredControl;
}

export function freezeRecursiveCampaignConfig(
  draft: RecursiveMetaCampaignConfig,
  corpus: FrozenCorpus,
  identities: FrozenRecursiveIdentities,
  enforceOuterEnvelope: typeof assertM2OuterDirectEnvelope = assertM2OuterDirectEnvelope,
): RecursiveMetaCampaignConfig {
  const outerBudgetDerivation = deriveM2OuterDirectEnvelope(draft.counts.candidates);
  if (draft.counts.childConcurrency !== outerBudgetDerivation.confirmationTerminalChildConcurrency) {
    throw new UsageError(
      `recursive freeze requires confirmation/terminal child concurrency `
      + `${outerBudgetDerivation.confirmationTerminalChildConcurrency}`,
    );
  }
  const campaignBudget = Object.fromEntries(SCHEDULED_BUDGET_DIMENSIONS.map((dimension) => {
    const derived =
      draft.budgets.campaign[dimension]
      - draft.budgets.outer[dimension]
      + outerBudgetDerivation.derived[dimension];
    if (!Number.isFinite(derived) || Math.abs(derived) > Number.MAX_SAFE_INTEGER || derived <= 0) {
      throw new UsageError(`derived recursive campaign ${dimension} is not a safe positive value`);
    }
    return [dimension, derived];
  })) as BudgetEnvelope;
  const identified = {
    ...draft,
    train: corpus.train,
    holdout: corpus.holdout,
    counts: {
      ...draft.counts,
      searchChildConcurrency: outerBudgetDerivation.searchChildConcurrency,
    },
    budgets: {
      ...draft.budgets,
      campaign: campaignBudget,
      outer: outerBudgetDerivation.derived,
    },
    outerBudgetDerivation,
    preIgnitionGates: {
      panelCapsuleSmoke: {
        version: 1,
        required: true,
      },
    },
    seedOptimizer: {
      sourceCommit: identities.sourceCommit,
      sourceArtifact: identities.target.sourceArtifact,
      bundleDigest: identities.target.mergedDigest,
    },
    controllerOptimizer: {
      sourceCommit: identities.sourceCommit,
      sourceArtifact: identities.controller.sourceArtifact,
      bundleDigest: identities.controller.mergedDigest,
    },
    trustedRuntime: {
      sourceCommit: identities.sourceCommit,
      digest: identities.runtimeDigest,
    },
    controls: {
      brokenSourceArtifact: identities.brokenControl.sourceArtifact,
      brokenBundleDigest: identities.brokenControl.bundleDigest,
      degradedSourceArtifact: identities.degradedControl.sourceArtifact,
      degradedBundleDigest: identities.degradedControl.bundleDigest,
    },
  };
  enforceOuterEnvelope(identified);
  const { protocolHash: _protocolHash, analysisConfigHash: _analysisConfigHash, ...protocolFields } = identified;
  const protocolHash = sha256(canonicalJson({ domain: "hone-m2-recursive-protocol-v1", config: protocolFields }));
  const analysisConfigHash = sha256(canonicalJson({
    domain: "hone-m2-recursive-analysis-v1",
    generation: identified.generation,
    train: identified.train.map(({ capsuleId, capsuleDigest, scalarizerDigest, qFail, qBase, qReference, scale }) => ({
      capsuleId,
      capsuleDigest,
      scalarizerDigest,
      qFail,
      qBase,
      qReference,
      scale,
    })),
    holdout: identified.holdout.map(({ capsuleId, capsuleDigest, scalarizerDigest, qFail, qBase, qReference, scale }) => ({
      capsuleId,
      capsuleDigest,
      scalarizerDigest,
      qFail,
      qBase,
      qReference,
      scale,
    })),
    promotion: identified.promotion,
    allowedClaim: identified.allowedClaim,
    trajectoryContract: 1,
  }));
  return MetaCampaignConfigV2.parse({ ...identified, protocolHash, analysisConfigHash });
}

function writeFrozenCampaign(root: string, outFlag: string, config: AnyMetaCampaignConfig): string {
  const rootPath = resolve(root);
  const outputPath = resolve(root, outFlag);
  const relativePath = relative(rootPath, outputPath);
  if (
    relativePath.length === 0
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
  ) {
    throw new UsageError("frozen campaign output must be a file beneath the repository root");
  }
  try {
    execFileSync("git", ["-C", rootPath, "check-ignore", "--quiet", "--", relativePath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new UsageError("frozen campaign output must be gitignored so its embedded source commit cannot create a self-reference");
  }
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileDurable(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(outputPath, 0o600);
  return outputPath;
}

/** The only freeze publication path: a recursive frozen config cannot be written before its closure record is attached. */
export function writeFrozenRecursiveCampaignWithClosure(
  root: string,
  outFlag: string,
  frozenConfig: RecursiveMetaCampaignConfig,
  closureRecord: CampaignRuntimeClosureCaptureV1,
): { config: RecursiveMetaCampaignConfig; outputPath: string } {
  const config = withRuntimeClosureCapture(frozenConfig, closureRecord);
  return { config, outputPath: writeFrozenCampaign(root, outFlag, config) };
}

function phaseEpochs(
  configHash: Sha256Digest,
  phase: "confirmation" | "holdout",
  capsules: readonly { readonly capsuleId: string }[],
  replicates: number,
): MetaMeasurementEpochs {
  return {
    byCapsule: Object.fromEntries(capsules.map((capsule) => [
      capsule.capsuleId,
      Array.from(
        { length: replicates },
        (_, replicate) => trustedPhaseMeasurementEpoch(configHash, phase, capsule.capsuleId, replicate),
      ),
    ])),
  };
}

function promotionIdentity(
  configHash: Sha256Digest,
  config: MetaCampaignConfig,
  rows: readonly TrustedMetaMeasurementRow[],
): MetaPromotionIdentity {
  const row = rows.find((candidate) => candidate.phase === "confirmation");
  if (row === undefined) throw new UsageError("confirmation produced no trusted measurement identity");
  return {
    configHash,
    protocolHash: config.protocolHash as Sha256Digest,
    analysisConfigHash: config.analysisConfigHash as Sha256Digest,
    requestedModel: config.modelObservation.requestedRoute,
    responseModel: row.responseModel,
    providerFingerprint: row.providerFingerprint,
    modelDriftSentinel: row.modelDriftSentinel,
  };
}

function controlAuthentications(
  seal: MetaControlSourceSeal,
  broken: RegisteredControl,
  degraded: RegisteredControl,
): MetaControlAuthentications {
  return {
    broken: {
      sourceArtifact: broken.sourceArtifact,
      bundleDigest: broken.bundleDigest,
      sourceSeal: seal,
      receipt: broken.transformationReceipt,
    },
    degraded: {
      sourceArtifact: degraded.sourceArtifact,
      bundleDigest: degraded.bundleDigest,
      sourceSeal: seal,
      receipt: degraded.transformationReceipt,
    },
  };
}

async function selectedSearchWinner(
  outerRunDir: string,
  config: AnyMetaCampaignConfig,
  gate: MetaCandidateGate,
): Promise<MetaOptimizerIdentity> {
  if (!existsSync(outerRunDir)) throw new UsageError("search has not run");
  const state = replayRun(outerRunDir);
  if (state.finished?.status !== "completed") throw new UsageError("search has not completed successfully");
  const selected = bestArtifact(state);
  if (selected === null || selected.hash === config.seedOptimizer.sourceArtifact) {
    throw new UsageError("search produced no non-seed incumbent for confirmation");
  }
  const sourceArtifact = selected.hash as Sha256Digest;
  const checked = await gate.check({ mode: "public-mutable", sourceArtifact });
  if (!checked.ok) throw new UsageError(`selected search incumbent failed conformance: ${checked.feedback}`);
  return { sourceArtifact, bundleDigest: checked.bundleDigest };
}

function assertExactSearchCardinality(journal: MetaJournalV1, config: AnyMetaCampaignConfig): void {
  if (config.version === 2) return;
  const sourceArtifacts = new Set(
    journal.queryTrainMeasurements()
      .filter((measurement) => measurement.phase === "search")
      .map((measurement) => measurement.sourceArtifact),
  );
  if (sourceArtifacts.size !== config.counts.candidates) {
    throw new UsageError(
      `search admitted ${sourceArtifacts.size} unique optimizer source artifacts; frozen campaign requires exactly ${config.counts.candidates}`,
    );
  }
}

export interface SearchCommandRunBoundaryInput {
  readonly exitCode: number;
  readonly outerRunDir: string;
  readonly persistTrajectory: () => string;
  readonly reportSecondaryFailure: (message: string) => void;
}

/**
 * Shared legacy/recursive CLI boundary. Partial trajectory evidence must be
 * attempted after a failed optimizer run without replacing its exit status.
 */
export function completeSearchCommandRun(input: SearchCommandRunBoundaryInput): number {
  const hasPartialTrajectory = existsSync(join(input.outerRunDir, EVENTS_FILE))
    && readEvents(input.outerRunDir).some(
      (event) => event.type === "eval.completed" || event.type === "episode.invalid",
    );
  if (input.exitCode !== 0) {
    if (hasPartialTrajectory) {
      const persistence = persistTrajectoryWithoutMaskingSearchFailure(
        input.exitCode,
        input.persistTrajectory,
      );
      if (persistence.persistenceError !== null) {
        input.reportSecondaryFailure(
          `search optimizer exited ${input.exitCode}; partial trajectory persistence also failed `
          + `without replacing the primary failure: ${persistence.persistenceError}`,
        );
      }
    }
    return input.exitCode;
  }
  if (hasPartialTrajectory) input.persistTrajectory();
  return input.exitCode;
}

/** Official train-only outer campaign entrypoint. Confirmation/holdout remain separate trusted runner methods. */
export async function honeCommand(args: string[], io: CmdIo): Promise<number> {
  const { positionals, flags } = parseFlags(args, { booleans: ["headless"], strings: ["campaign", "phase", "out"] });
  if (positionals.length !== 0) throw new UsageError(HONE_USAGE);
  const campaignFlag = strFlag(flags, "campaign");
  if (campaignFlag === undefined || !boolFlag(flags, "headless")) throw new UsageError(HONE_USAGE);
  const phaseFlag = strFlag(flags, "phase");
  let phase: "freeze" | "search" | "confirmation" | "holdout";
  if (phaseFlag === undefined || phaseFlag === "search") phase = "search";
  else if (phaseFlag === "freeze" || phaseFlag === "confirmation" || phaseFlag === "holdout") phase = phaseFlag;
  else throw new UsageError(HONE_USAGE);
  const outFlag = strFlag(flags, "out");
  if ((phase === "freeze") !== (outFlag !== undefined)) throw new UsageError(HONE_USAGE);
  if (optimizerOverridden(io.env)) throw new UsageError("official meta campaigns refuse HONE_OPTIMIZER_CMD");

  const campaignPath = resolve(io.root, campaignFlag);
  let config = MetaCampaignConfigV1.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
  if (phase === "freeze") {
    const corpus = freezeCorpusEntries(io.root, config);
    config = MetaCampaignConfigV1.parse({ ...config, train: corpus.train, holdout: corpus.holdout });
  }
  const requiredOuterEvaluations = config.counts.candidateAttemptsMax + 1;
  if (config.budgets.outer.maxEvaluatorInvocations < requiredOuterEvaluations) {
    throw new UsageError(
      `outer maxEvaluatorInvocations ${config.budgets.outer.maxEvaluatorInvocations} cannot cover ${requiredOuterEvaluations} baseline-plus-attempt evaluations`,
    );
  }
  const requiredChildEvaluations = 4 * config.counts.innerEpisodesMax + 1;
  if (config.budgets.child.maxEvaluatorInvocations < requiredChildEvaluations) {
    throw new UsageError(
      `child maxEvaluatorInvocations ${config.budgets.child.maxEvaluatorInvocations} cannot cover the fixed ${requiredChildEvaluations}-invocation worst case for ${config.counts.innerEpisodesMax} episodes`,
    );
  }

  assertCleanSourceTree(io.root);
  const commit = sourceCommit(io.root);
  const runtimeDigest = verifiedBootRuntimeDigest() as Sha256Digest;
  if (phase !== "freeze") {
    if (config.seedOptimizer.sourceCommit !== commit) {
      throw new UsageError(`seed optimizer source commit drift: ${commit} != registered ${config.seedOptimizer.sourceCommit}`);
    }
    if (config.trustedRuntime.sourceCommit !== commit) {
      throw new UsageError(`trusted runtime source commit drift: ${commit} != registered ${config.trustedRuntime.sourceCommit}`);
    }
    if (config.trustedRuntime.digest !== runtimeDigest) {
      throw new UsageError(`trusted runtime drift: ${runtimeDigest} != registered ${config.trustedRuntime.digest}`);
    }
  }

  const capsules = resolveRegisteredCapsules(io.root, config);
  const casDir = casRoot(io.root);
  const cas = new CasStore(casDir);
  const seedSnapshot = collectOptimizerSnapshot(io.root);
  assertMutablePathsResolve(config.mutablePaths, seedSnapshot);
  assertOptimizerProtectedPathsResolve(config.protectedPaths, seedSnapshot);
  const seed = await captureSeedCandidate(io.root, cas);
  const comparisonImage = config.train[0]!.image;
  const sealedSeedDigest = snapshotDigest(comparisonImage, seedSnapshot) as Sha256Digest;
  if (phase !== "freeze") {
    if (seed.artifactHash !== config.seedOptimizer.sourceArtifact) {
      throw new UsageError(`seed optimizer source artifact drift: ${seed.artifactHash} != registered ${config.seedOptimizer.sourceArtifact}`);
    }
    if (sealedSeedDigest !== config.seedOptimizer.bundleDigest) {
      throw new UsageError(`seed optimizer bundle drift: ${sealedSeedDigest} != registered ${config.seedOptimizer.bundleDigest}`);
    }
  }

  const optimizerDir = join(io.root, "optimizer");
  const controlSeal: MetaControlSourceSeal = await captureMetaControlSourceSeal(optimizerDir);
  const [brokenArtifact, degradedArtifact] = await Promise.all([
    buildBrokenMetaControl(optimizerDir, controlSeal),
    buildDegradedMetaControl(optimizerDir, controlSeal),
  ]);
  const [brokenControl, degradedControl] = await Promise.all([
    prepareControl(brokenArtifact, cas, casDir, comparisonImage, seedSnapshot),
    prepareControl(degradedArtifact, cas, casDir, comparisonImage, seedSnapshot),
  ]);
  if (phase === "freeze") {
    if (outFlag === undefined) throw new UsageError(HONE_USAGE);
    const frozen = freezeCampaignConfig(config, {
      sourceCommit: commit,
      runtimeDigest,
      seedSourceArtifact: seed.artifactHash,
      seedBundleDigest: sealedSeedDigest,
      brokenControl,
      degradedControl,
    });
    const outputPath = writeFrozenCampaign(io.root, outFlag, frozen);
    io.out(canonicalJson({
      phase,
      outputPath,
      configHash: metaCampaignConfigHash(frozen),
      sourceCommit: commit,
      seedSourceArtifact: seed.artifactHash,
      seedBundleDigest: sealedSeedDigest,
      runtimeDigest,
      controls: frozen.controls,
      protocolHash: frozen.protocolHash,
      analysisConfigHash: frozen.analysisConfigHash,
    }));
    return 0;
  }
  if (
    brokenControl.sourceArtifact !== config.controls.brokenSourceArtifact
    || brokenControl.bundleDigest !== config.controls.brokenBundleDigest
    || degradedControl.sourceArtifact !== config.controls.degradedSourceArtifact
    || degradedControl.bundleDigest !== config.controls.degradedBundleDigest
  ) {
    throw new UsageError("trusted control artifacts do not match the frozen campaign configuration");
  }

  const configHash = metaCampaignConfigHash(config);
  const campaignDir = join(runsRoot(io.root), `meta-campaign-${configHash.slice("sha256:".length)}`);
  mkdirSync(campaignDir, { recursive: true, mode: 0o700 });
  chmodSync(campaignDir, 0o700);
  const registeredConfigPath = join(campaignDir, "campaign.json");
  if (existsSync(registeredConfigPath)) {
    const registered = MetaCampaignConfigV1.parse(JSON.parse(readFileSync(registeredConfigPath, "utf8")));
    if (canonicalJson(registered) !== canonicalJson(config)) {
      throw new UsageError("durable campaign state belongs to a different configuration");
    }
  } else {
    writeFileDurable(registeredConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    chmodSync(registeredConfigPath, 0o600);
  }

  const syntheticCapsule = createSyntheticCapsule(campaignDir, config, seed.artifactHash, casDir);
  const journal = MetaJournalV1.open(join(campaignDir, "meta-journal.ndjson"), config);
  const gate = new CliCandidateGate({
    casDir,
    campaignDir,
    config,
    baseSnapshot: seedSnapshot,
    comparisonImage,
    controls: [brokenControl, degradedControl],
  });
  const modelRegistry = new CampaignModelRegistry(campaignDir, configHash, io.root);
  const outerRunId = `run_meta_outer_${configHash.slice("sha256:".length)}`;
  const outerRunDir = join(runsRoot(io.root), outerRunId);
  const runner = new MetaCampaignRunner({
    config,
    journal,
    joinPath: join(campaignDir, "candidate-child-joins.ndjson"),
    candidateGate: gate,
    childSupervisor: new CliChildSupervisor(
      io,
      campaignChildDispatchPolicy(config),
      campaignDir,
      capsules,
      seedSnapshot,
      modelRegistry,
      undefined,
      outerRunDir,
    ),
  });
  const strategy: TrustedEvaluationStrategy = async (request) => await runner.evaluateSearchCandidate({
    sourceArtifact: request.artifact.hash as Sha256Digest,
    outerCapsuleId: request.capsuleId,
    assetGroupId: request.assetGroupId,
    seed: request.seed,
  });
  try {
    const seedIdentity: MetaOptimizerIdentity = {
      sourceArtifact: config.seedOptimizer.sourceArtifact as Sha256Digest,
      bundleDigest: config.seedOptimizer.bundleDigest as Sha256Digest,
    };
    const authentications = controlAuthentications(controlSeal, brokenControl, degradedControl);

    if (phase !== "search") {
      assertExactSearchCardinality(journal, config);
      const winner = await selectedSearchWinner(outerRunDir, config, gate);
      if (phase === "confirmation") {
        await runner.runConfirmation({
          seed: seedIdentity,
          winner,
          brokenControl,
          degradedControl,
        });
      }
      const trainRows = legacyMeasurementRows(journal.queryTrainMeasurements());
      const identity = promotionIdentity(configHash, config, trainRows);
      const selection: MetaTrainWinnerSelection = selectMetaTrainWinner({
        config,
        identity,
        candidate: winner,
        controlAuthentications: authentications,
        epochs: phaseEpochs(configHash, "confirmation", config.train, config.counts.confirmationReplicates),
        rows: trainRows,
      });
      const selectionPath = join(campaignDir, "train-selection.json");
      if (phase === "confirmation") {
        writeFileDurable(selectionPath, `${canonicalJson(selection)}\n`);
        chmodSync(selectionPath, 0o600);
        io.out(canonicalJson({ campaign: configHash, phase, selection }));
        return 0;
      }
      if (!existsSync(selectionPath)) {
        throw new UsageError("terminal holdout requires a durable explicit confirmation decision");
      }
      const registeredSelection: unknown = JSON.parse(readFileSync(selectionPath, "utf8"));
      if (canonicalJson(registeredSelection) !== canonicalJson(selection)) {
        throw new UsageError("durable train selection no longer reproduces from the trusted measurement journal");
      }
      if (selection.status !== "selected") {
        throw new UsageError("terminal holdout refuses because the frozen train-selection gate did not pass");
      }
      await runner.runTerminalHoldout({ seed: seedIdentity, winner });
      const holdoutRows = legacyMeasurementRows(journal.queryHoldoutMeasurements());
      const decision: MetaHoldoutDecision = finalizeMetaHoldout({
        config,
        identity,
        selectedWinner: winner,
        selection,
        epochs: phaseEpochs(configHash, "holdout", config.holdout, config.counts.holdoutReplicates),
        rows: holdoutRows,
      });
      const decisionPath = join(campaignDir, "holdout-decision.json");
      writeFileDurable(decisionPath, `${canonicalJson(decision)}\n`);
      chmodSync(decisionPath, 0o600);
      io.out(canonicalJson({ campaign: configHash, phase, decision }));
      return 0;
    }

    if (existsSync(outerRunDir) && replayRun(outerRunDir).finished !== null) {
      const terminal = replayRun(outerRunDir).finished;
      if (terminal?.status === "completed") assertExactSearchCardinality(journal, config);
      const trajectoryPath = persistMetaSearchTrajectory({
        root: io.root,
        campaignDir,
        outerRunId,
        configHash,
        config,
        journal,
      });
      io.out(JSON.stringify({ campaign: configHash, runId: outerRunId, phase, status: terminal?.status, trajectoryPath }));
      return terminal?.status === "completed" ? 0 : 1;
    }
    const configFile = join(campaignDir, "outer-config.json");
    if (!existsSync(configFile)) {
      writeCampaignOuterRunConfig(configFile, config);
    }
    const resume = existsSync(outerRunDir);
    const code = await runCommand(
      resume
        ? [syntheticCapsule, "--headless", "--resume"]
        : [syntheticCapsule, "--headless", "--config", configFile],
      io,
      {
        runId: outerRunId,
        evaluationStrategy: strategy,
        optimizerEpisodesMax: config.counts.candidateAttemptsMax,
        maxPublicCandidateEvaluations: config.counts.candidateAttemptsMax,
        trustedValidPublicCandidateTarget: config.counts.candidates - 1,
        optimizerBaseSnapshot: seedSnapshot,
        // Trusted synthetic meta task; see createSyntheticCapsule.
        admissionReview: "off",
      },
    );
    const boundaryCode = completeSearchCommandRun({
      exitCode: code,
      outerRunDir,
      persistTrajectory: () => persistMetaSearchTrajectory({
        root: io.root,
        campaignDir,
        outerRunId,
        configHash,
        config,
        journal,
      }),
      reportSecondaryFailure: io.err,
    });
    if (boundaryCode === 0) {
      const terminal = replayRun(outerRunDir).finished;
      if (terminal?.status !== "completed") throw new UsageError("search returned success without a completed terminal event");
      assertExactSearchCardinality(journal, config);
    }
    return boundaryCode;
  } finally {
    runner.close();
    journal.close();
  }
}

const RECURSIVE_USAGE =
  "usage: hone recursive --campaign <path> --headless "
  + "[--phase freeze|search|confirmation|terminal|authorize] "
  + "[--out <gitignored-path>] [--sealed-base <dir>] "
  + "[--target-artifact sha256:<64hex>] [--controller-artifact sha256:<64hex>] "
  + "[--control-winner sha256:<64hex>] [--generation0 sha256:<64hex>] [--generation1 sha256:<64hex>] "
  + "[--generation2 sha256:<64hex>] [--gate-thresholds <path>] [--gate G1|G2] [--approver <name>] "
  + "[--reason <text>] [--record-dir <stage-a-cell-dir>] [--attest-diff-confined] [--attest-mechanism-plausible]";

function digestFlag(value: string | undefined, label: string): Sha256Digest | undefined {
  if (value === undefined) return undefined;
  if (!SHA256_PATTERN.test(value)) throw new UsageError(`${label} must be a lowercase sha256 digest`);
  return value as Sha256Digest;
}

function recursiveOptimizerImage(config: RecursiveMetaCampaignConfig): string {
  return config.optimizerRuntime.image;
}

/**
 * Select the optimizer base closure for recursive coordination.
 *
 * An unmigrated campaign may continue from its authenticated live tree. A
 * source migration still forbids that fallback. An explicit --sealed-base is
 * accepted when either the historical outer optimizer seal or a durable
 * runtime-closure record binds its digest; when both exist they must agree.
 */
export function recursiveOptimizerBaseSnapshot(
  configInput: RecursiveMetaCampaignConfig,
  root: string,
  outerRunDir: string,
  sealedBaseFlag: string | undefined,
): OptimizerSnapshot {
  const config = MetaCampaignConfigV2.parse(configInput);
  metaCampaignConfigHash(config);
  const closureRecord = config.runtimeClosureJournal?.captures.at(-1);
  if (config.sourceMigrationJournal === undefined && sealedBaseFlag === undefined) {
    return collectOptimizerSnapshot(root);
  }
  if (
    config.sourceMigrationJournal === undefined
    && sealedBaseFlag !== undefined
    && closureRecord === undefined
  ) {
    throw new UsageError(
      "--sealed-base is valid only after an explicit campaign source migration or runtime closure capture",
    );
  }
  if (config.sourceMigrationJournal !== undefined && sealedBaseFlag === undefined) {
    throw new UsageError(
      "migrated recursive campaigns require --sealed-base <dir>; refusing to fall back to the current source tree",
    );
  }
  if (sealedBaseFlag === undefined) throw new UsageError("sealed optimizer base path is missing");

  const outerSeal = readOptimizerArtifactSeal(outerRunDir);
  if (outerSeal !== null && (
    outerSeal.runId !== basename(outerRunDir)
    || outerSeal.sourceArtifact !== config.controllerOptimizer.sourceArtifact
    || outerSeal.mergedDigest !== config.controllerOptimizer.bundleDigest
  )) {
    throw new UsageError("sealed outer optimizer identity does not match the frozen campaign controller");
  }
  if (
    outerSeal === null
    && closureRecord === undefined
    && config.sourceMigrationJournal !== undefined
  ) {
    throw new UsageError(
      `migrated recursive campaign has no sealed outer optimizer base identity in ${outerRunDir}`,
    );
  }
  if (
    outerSeal !== null
    && closureRecord !== undefined
    && outerSeal.baseDigest !== closureRecord.optimizerBaseDigest
  ) {
    throw new UsageError("runtime closure optimizer identity disagrees with the sealed outer base");
  }

  const expectedDigest = closureRecord?.optimizerBaseDigest ?? outerSeal?.baseDigest;
  if (expectedDigest === undefined) throw new UsageError("campaign has no sealed optimizer base identity");
  const sealedBaseRoot = resolve(root, sealedBaseFlag);
  const snapshot = collectOptimizerSnapshot(sealedBaseRoot);
  const actualDigest = snapshotDigest(recursiveOptimizerImage(config), snapshot);
  if (actualDigest !== expectedDigest) {
    throw new UsageError(
      `sealed optimizer base digest mismatch: ${actualDigest} != campaign seal ${expectedDigest}`,
    );
  }
  return snapshot;
}

const LEGACY_CAMPAIGN11_SOURCE_ARTIFACT =
  "sha256:499ee208f5b7376a3cfc583e44b7971f7b1b9d378499429ddd67caf04d5f36e2";
const LEGACY_CAMPAIGN11_BUNDLE_DIGEST =
  "sha256:fe92e17955adebe53c9ed4076ae1dcdfb2e328d19818d7273fb4f4d850f0d6dc";

/**
 * Exact compatibility allowlist for Campaign 11's migrated pre-toolbelt
 * worker. The base closure has already been authenticated against the outer
 * optimizer seal before this check. No migration record or any identity drift
 * leaves the modern full-toolbelt contract in force.
 */
export function recursiveMutationWorkerPreflightContract(
  config: RecursiveMetaCampaignConfig,
  baseSnapshot: OptimizerSnapshot,
): MutationWorkerPreflightContract | undefined {
  if (
    config.sourceMigrationJournal !== undefined
    && config.seedOptimizer.sourceArtifact === LEGACY_CAMPAIGN11_SOURCE_ARTIFACT
    && config.seedOptimizer.bundleDigest === LEGACY_CAMPAIGN11_BUNDLE_DIGEST
    && config.controllerOptimizer.sourceArtifact === LEGACY_CAMPAIGN11_SOURCE_ARTIFACT
    && config.controllerOptimizer.bundleDigest === LEGACY_CAMPAIGN11_BUNDLE_DIGEST
    && snapshotDigest(config.optimizerRuntime.image, baseSnapshot) === LEGACY_CAMPAIGN11_BUNDLE_DIGEST
  ) {
    return "legacy-selftest";
  }
  return undefined;
}

async function prepareRecursiveControls(
  targetSnapshot: OptimizerSnapshot,
  cas: CasStore,
  casDir: string,
  comparisonImage: string,
): Promise<{
  seal: MetaControlSourceSeal;
  broken: RegisteredControl;
  degraded: RegisteredControl;
}> {
  const scratch = mkdtempSync(join(tmpdir(), "hone-recursive-controls-"));
  chmodSync(scratch, 0o700);
  try {
    const optimizerDir = join(scratch, "optimizer");
    materializeOptimizerSource(targetSnapshot, optimizerDir);
    const seal = await captureMetaControlSourceSeal(optimizerDir);
    const [brokenArtifact, degradedArtifact] = await Promise.all([
      buildBrokenMetaControl(optimizerDir, seal),
      buildDegradedMetaControl(optimizerDir, seal),
    ]);
    const [broken, degraded] = await Promise.all([
      prepareControl(brokenArtifact, cas, casDir, comparisonImage, targetSnapshot),
      prepareControl(degradedArtifact, cas, casDir, comparisonImage, targetSnapshot),
    ]);
    return { seal, broken, degraded };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function checkedPublicIdentity(
  sourceArtifact: Sha256Digest,
  gate: MetaCandidateGate,
): Promise<MetaOptimizerIdentity> {
  const checked = await gate.check({ mode: "public-mutable", sourceArtifact });
  if (!checked.ok) throw new UsageError(`optimizer artifact ${sourceArtifact} failed conformance: ${checked.feedback}`);
  return { sourceArtifact, bundleDigest: checked.bundleDigest };
}

export function recursivePhaseReceipt(
  campaignDir: string,
  phase: string,
  config: RecursiveMetaCampaignConfig,
  body: Record<string, unknown>,
): string {
  const receipt = {
    version: 1,
    configHash: metaCampaignConfigHash(config),
    phase,
    sourceMigrationJournal: config.sourceMigrationJournal ?? null,
    imageRepinJournal: config.imageRepinJournal ?? null,
    runtimeClosureJournal: config.runtimeClosureJournal ?? null,
    ...body,
  };
  const output = join(campaignDir, `${phase}-receipt.json`);
  writeFileDurable(output, `${canonicalJson(receipt)}\n`);
  chmodSync(output, 0o600);
  return output;
}

export interface RecursiveCommandOptions {
  /** Test-only observation at the trusted dispatch-policy boundary. */
  readonly observeMutationWorkerPreflightContract?: (
    contract: MutationWorkerPreflightContract | undefined,
  ) => void;
  /** Test seam at the freeze-time CAS capture boundary; production always uses the durable capturer. */
  readonly captureFrozenRuntimeClosure?: typeof captureRuntimeClosure;
  /** Test-only prepared freeze inputs; publication still traverses the command's production call site. */
  readonly preparedFreezePublication?: {
    readonly frozenConfig: RecursiveMetaCampaignConfig;
    readonly closureCapture: CaptureRuntimeClosureResult;
  };
}

/** Execute one frozen recursive generation cell; orchestration composes these durable cells. */
export async function recursiveCommand(
  args: string[],
  io: CmdIo,
  options: RecursiveCommandOptions = {},
): Promise<number> {
  const { positionals, flags } = parseFlags(args, {
    booleans: ["headless", "attest-diff-confined", "attest-mechanism-plausible"],
    strings: [
      "campaign",
      "phase",
      "out",
      "sealed-base",
      "target-artifact",
      "controller-artifact",
      "control-winner",
      "generation0",
      "generation1",
      "generation2",
      "gate-thresholds",
      "gate",
      "approver",
      "reason",
      "record-dir",
    ],
  });
  if (positionals.length !== 0 || !boolFlag(flags, "headless")) throw new UsageError(RECURSIVE_USAGE);
  const campaignFlag = strFlag(flags, "campaign");
  if (campaignFlag === undefined) throw new UsageError(RECURSIVE_USAGE);
  const phaseFlag = strFlag(flags, "phase") ?? "search";
  if (!["freeze", "search", "confirmation", "terminal", "authorize"].includes(phaseFlag)) throw new UsageError(RECURSIVE_USAGE);
  const phase = phaseFlag as "freeze" | "search" | "confirmation" | "terminal" | "authorize";
  const outFlag = strFlag(flags, "out");
  const sealedBaseFlag = strFlag(flags, "sealed-base");
  if ((phase === "freeze") !== (outFlag !== undefined)) throw new UsageError(RECURSIVE_USAGE);
  if (optimizerOverridden(io.env)) throw new UsageError("official recursive campaigns refuse HONE_OPTIMIZER_CMD");

  const campaignPath = resolve(io.root, campaignFlag);
  let config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
  assertCleanSourceTree(io.root);
  const commit = sourceCommit(io.root);
  const runtimeDigest = verifiedBootRuntimeDigest() as Sha256Digest;
  if (phase !== "freeze") assertRecursiveCampaignSourceIdentity(config, commit, runtimeDigest);
  if (phase === "search") assertRequiredPanelCapsuleSmoke(io.root, config);
  let rootSnapshot: OptimizerSnapshot;
  if (phase === "freeze") {
    if (sealedBaseFlag !== undefined) {
      throw new UsageError("--sealed-base is valid only after an explicit campaign source migration");
    }
    rootSnapshot = collectOptimizerSnapshot(io.root);
  } else {
    const preflightConfigHash = metaCampaignConfigHash(config);
    const hashBody = preflightConfigHash.slice("sha256:".length);
    const preflightCampaignDir = join(runsRoot(io.root), `recursive-cell-${hashBody}`);
    const preflightRegisteredConfigPath = join(preflightCampaignDir, "campaign.json");
    if (existsSync(preflightRegisteredConfigPath)) {
      registeredCampaignConfigNeedsReconciliation(preflightRegisteredConfigPath, config);
    }
    rootSnapshot = recursiveOptimizerBaseSnapshot(
      config,
      io.root,
      join(runsRoot(io.root), `run_recursive_outer_${hashBody}`),
      sealedBaseFlag,
    );
  }
  const mutationWorkerPreflightContract = phase === "freeze"
    ? undefined
    : recursiveMutationWorkerPreflightContract(config, rootSnapshot);
  options.observeMutationWorkerPreflightContract?.(mutationWorkerPreflightContract);
  const casDir = casRoot(io.root);
  const cas = new CasStore(casDir);
  assertMutablePathsResolve(config.mutablePaths, rootSnapshot);
  assertOptimizerProtectedPathsResolve(config.protectedPaths, rootSnapshot);

  if (phase === "freeze") {
    let frozenConfig: RecursiveMetaCampaignConfig;
    let closureCapture: CaptureRuntimeClosureResult;
    if (options.preparedFreezePublication !== undefined) {
      frozenConfig = options.preparedFreezePublication.frozenConfig;
      closureCapture = options.preparedFreezePublication.closureCapture;
    } else {
      const localSeed = await captureSeedCandidate(io.root, cas);
      const corpus = freezeCorpusEntries(io.root, config);
      config = MetaCampaignConfigV2.parse({ ...config, train: corpus.train, holdout: corpus.holdout });
      const comparisonImage = recursiveOptimizerImage(config);
      const explicitTarget = digestFlag(strFlag(flags, "target-artifact"), "--target-artifact");
      const targetSource = explicitTarget
        ?? (config.generation.stage === "A" ? localSeed.artifactHash : config.seedOptimizer.sourceArtifact as Sha256Digest);
      const explicitController = digestFlag(strFlag(flags, "controller-artifact"), "--controller-artifact");
      const controllerSource = explicitController
        ?? (config.generation.controllerGeneration === 1 ? targetSource : localSeed.artifactHash);
      const target = await resolveCandidateOptimizer({
        casDir,
        artifactHash: targetSource,
        image: comparisonImage,
        baseSnapshot: rootSnapshot,
      });
      const controller = await resolveCandidateOptimizer({
        casDir,
        artifactHash: controllerSource,
        image: comparisonImage,
        baseSnapshot: rootSnapshot,
      });
      const controls = await prepareRecursiveControls(target.snapshot, cas, casDir, comparisonImage);
      frozenConfig = freezeRecursiveCampaignConfig(config, corpus, {
        sourceCommit: commit,
        runtimeDigest,
        target,
        controller,
        brokenControl: controls.broken,
        degradedControl: controls.degraded,
      });
      const frozenConfigHash = metaCampaignConfigHash(frozenConfig);
      closureCapture = await (options.captureFrozenRuntimeClosure ?? captureRuntimeClosure)({
        sourceRoot: io.root,
        sourceCommit: commit,
        campaignBootDigest: runtimeDigest,
        expectedBootDigest: runtimeDigest,
        optimizerImage: comparisonImage,
        optimizerBaseDigest: snapshotDigest(comparisonImage, rootSnapshot) as Sha256Digest,
        campaignConfigHash: frozenConfigHash,
        capturedAt: new Date().toISOString(),
        casDir,
        previousRecordDigest: null,
      });
    }
    if (outFlag === undefined) throw new UsageError(RECURSIVE_USAGE);
    const publication = writeFrozenRecursiveCampaignWithClosure(
      io.root,
      outFlag,
      frozenConfig,
      closureCapture.record,
    );
    const frozen = publication.config;
    const outputPath = publication.outputPath;
    const outerAncestorCapacity = assertM2OuterAncestorCapacity(frozen);
    io.out(canonicalJson({
      phase,
      outputPath,
      configHash: metaCampaignConfigHash(frozen),
      generation: frozen.generation,
      target: frozen.seedOptimizer,
      controller: frozen.controllerOptimizer,
      controls: frozen.controls,
      outerAncestorCapacity,
      runtimeClosure: {
        manifestArtifact: closureCapture.record.manifestArtifact,
        closureDigest: closureCapture.record.closureDigest,
        marginalBytes: closureCapture.marginalBytes,
        reusedBytes: closureCapture.reusedBytes,
      },
    }));
    return 0;
  }

  assertM2OuterAncestorCapacity(config);
  const comparisonImage = recursiveOptimizerImage(config);
  const target = await resolveRegisteredOptimizer(config.seedOptimizer, commit, rootSnapshot, casDir, comparisonImage);
  const controller = await resolveRegisteredOptimizer(config.controllerOptimizer, commit, rootSnapshot, casDir, comparisonImage);
  const controls = await prepareRecursiveControls(target.snapshot, cas, casDir, comparisonImage);
  if (
    controls.broken.sourceArtifact !== config.controls.brokenSourceArtifact
    || controls.broken.bundleDigest !== config.controls.brokenBundleDigest
    || controls.degraded.sourceArtifact !== config.controls.degradedSourceArtifact
    || controls.degraded.bundleDigest !== config.controls.degradedBundleDigest
  ) {
    throw new UsageError("recursive trusted controls do not match the frozen target-specific controls");
  }
  const capsules = resolveRegisteredCapsules(io.root, config);
  const configHash = metaCampaignConfigHash(config);
  const hashBody = configHash.slice("sha256:".length);
  const campaignDir = join(runsRoot(io.root), `recursive-cell-${hashBody}`);
  const outerRunId = `run_recursive_outer_${hashBody}`;
  const outerRunDir = join(runsRoot(io.root), outerRunId);
  mkdirSync(campaignDir, { recursive: true, mode: 0o700 });
  chmodSync(campaignDir, 0o700);
  const registeredConfigPath = join(campaignDir, "campaign.json");
  if (existsSync(registeredConfigPath)) {
    reconcileRegisteredCampaignConfig(registeredConfigPath, config);
  } else {
    writeFileDurable(registeredConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    chmodSync(registeredConfigPath, 0o600);
  }
  const campaignPauseAuthority = DurableCampaignPauseAuthorityV1.open(
    join(campaignDir, "campaign-pause.v1.json"),
    configHash,
  );
  const envelopeRecordPort = MetaEnvelopeFileRecordPortV1.open(
    join(campaignDir, "resource-envelope.v1.ndjson"),
    configHash,
  );
  const envelopeLedger = new MetaResourceEnvelopeLedger(config.recursiveBudgets, envelopeRecordPort);

  const syntheticCapsule = createSyntheticCapsule(campaignDir, config, target.sourceArtifact as Sha256Digest, casDir);
  const journal = MetaJournalV1.open(join(campaignDir, "meta-journal.ndjson"), config);
  const gate = new CliCandidateGate({
    casDir,
    campaignDir,
    config,
    baseSnapshot: target.snapshot,
    comparisonImage,
    controls: [controls.broken, controls.degraded],
  });
  const modelRegistry = new CampaignModelRegistry(campaignDir, configHash, io.root);
  const childSupervisor = new CliChildSupervisor(
    io,
    campaignChildDispatchPolicy(config, {
      proxyRole: "inner-capsule-improvement",
      campaignConfigHash: configHash,
      evaluatorTimeoutSec: config.evaluatorTimeoutSec,
      ...(mutationWorkerPreflightContract === undefined
        ? {}
        : { mutationWorkerPreflightContract }),
    }),
    campaignDir,
    capsules,
    target.snapshot,
    modelRegistry,
    campaignPauseAuthority,
    outerRunDir,
  );
  const recursiveResourceLedger = RecursiveResourceLedger.open(
    join(campaignDir, "recursive-resource.v1.ndjson"),
  );
  const recursiveLauncher = new RecursiveSearchChildLauncher(
    io.root,
    campaignDir,
    config,
    configHash,
    journal,
    gate,
    childSupervisor,
    envelopeLedger,
    campaignPauseAuthority,
  );
  const recursiveBroker = recursiveLauncher.brokerConfig(recursiveResourceLedger);
  const recursiveEvaluationStrategy = recursiveLauncher.evaluationStrategy();
  const runner = new MetaCampaignRunner({
    config,
    journal,
    joinPath: join(campaignDir, "candidate-child-joins.ndjson"),
    candidateGate: gate,
    childSupervisor,
    envelopeLedger,
  });

  try {
    const targetIdentity: MetaOptimizerIdentity = {
      sourceArtifact: target.sourceArtifact as Sha256Digest,
      bundleDigest: target.mergedDigest as Sha256Digest,
    };
    if (phase === "confirmation") {
      assertExactSearchCardinality(journal, config);
      if (config.generation.stage === "A") {
        const thresholdsPath = strFlag(flags, "gate-thresholds");
        if (thresholdsPath === undefined) throw new UsageError(RECURSIVE_USAGE);
        const thresholds = readGateThresholdsFile(resolve(io.root, thresholdsPath));
        const winner = await selectedSearchWinner(outerRunDir, config, gate);
        const result = await runner.runConfirmation({
          seed: targetIdentity,
          winner,
          brokenControl: controls.broken,
          degradedControl: controls.degraded,
        });
        const measurementHash = sha256(canonicalJson(result.measurements));
        const receiptPath = recursivePhaseReceipt(campaignDir, phase, config, {
          generation: config.generation,
          winner,
          measurementCount: result.measurements.length,
          measurementHash,
        });
        const g1Record = assembleG1Record({
          config,
          measurements: result.measurements,
          receipt: readConfirmationReceipt(receiptPath),
          thresholds: thresholds.g1,
          seed: targetIdentity,
          winner,
        });
        const g1RecordPath = writeG1Record(campaignDir, g1Record);
        io.out(canonicalJson({ configHash, phase, winner, receiptPath, g1RecordPath, g1Pass: g1Record.pass }));
        return 0;
      }
      const thresholdsPath = strFlag(flags, "gate-thresholds");
      if (thresholdsPath === undefined) throw new UsageError(RECURSIVE_USAGE);
      const thresholds = readGateThresholdsFile(resolve(io.root, thresholdsPath));
      const controlWinner = digestFlag(strFlag(flags, "control-winner"), "--control-winner");
      const generation2 = digestFlag(strFlag(flags, "generation2"), "--generation2");
      if (controlWinner === undefined || generation2 === undefined) throw new UsageError(RECURSIVE_USAGE);
      const controlWinnerIdentity = await checkedPublicIdentity(controlWinner, gate);
      const generation2Identity = await checkedPublicIdentity(generation2, gate);
      // Fail closed: Stage B cannot run without the accepted G1 human authorization.
      assertG1Authorized(campaignDir, configHash, {
        target: targetIdentity,
        controlWinner: controlWinnerIdentity,
        generation2: generation2Identity,
      });
      const result = await runner.runRecursiveConfirmation({
        target: targetIdentity,
        controlControllerWinner: controlWinnerIdentity,
        generation2: generation2Identity,
        brokenControl: controls.broken,
        degradedControl: controls.degraded,
      });
      const measurementHash = sha256(canonicalJson(result.measurements));
      const receiptPath = recursivePhaseReceipt(campaignDir, phase, config, {
        generation: config.generation,
        controlWinner: controlWinnerIdentity,
        generation2: generation2Identity,
        measurementCount: result.measurements.length,
        measurementHash,
      });
      const g2Record = assembleG2Record({
        config,
        measurements: result.measurements,
        receipt: readConfirmationReceipt(receiptPath),
        thresholds: thresholds.g2,
        target: targetIdentity,
        controlWinner: controlWinnerIdentity,
        generation2: generation2Identity,
      });
      const g2RecordPath = writeG2Record(campaignDir, g2Record);
      io.out(canonicalJson({ configHash, phase, controlWinner: controlWinnerIdentity, generation2: generation2Identity, receiptPath, g2RecordPath, g2Pass: g2Record.pass }));
      return 0;
    }

    if (phase === "terminal") {
      const generation0 = digestFlag(strFlag(flags, "generation0"), "--generation0");
      const generation1 = digestFlag(strFlag(flags, "generation1"), "--generation1");
      const generation2 = digestFlag(strFlag(flags, "generation2"), "--generation2");
      if (generation0 === undefined || generation1 === undefined || generation2 === undefined) throw new UsageError(RECURSIVE_USAGE);
      const identities = {
        generation0: await checkedPublicIdentity(generation0, gate),
        generation1: await checkedPublicIdentity(generation1, gate),
        generation2: await checkedPublicIdentity(generation2, gate),
      };
      // Fail closed: terminal requires both accepted dev-gate authorizations (G1 + G2).
      assertG2Authorized(campaignDir, configHash, {
        generation0: identities.generation0,
        generation1: identities.generation1,
        generation2: identities.generation2,
      });
      const result = await runner.runRecursiveTerminal(identities);
      const receiptPath = recursivePhaseReceipt(campaignDir, phase, config, {
        generation: config.generation,
        artifacts: identities,
        measurementCount: result.measurements.length,
        measurementHash: sha256(canonicalJson(result.measurements)),
      });
      io.out(canonicalJson({ configHash, phase, artifacts: identities, receiptPath }));
      return 0;
    }

    if (phase === "authorize") {
      const gateFlag = strFlag(flags, "gate");
      if (gateFlag !== "G1" && gateFlag !== "G2") throw new UsageError(RECURSIVE_USAGE);
      const approver = strFlag(flags, "approver");
      const reason = strFlag(flags, "reason");
      if (approver === undefined || reason === undefined) throw new UsageError(RECURSIVE_USAGE);
      if (!boolFlag(flags, "attest-diff-confined") || !boolFlag(flags, "attest-mechanism-plausible")) {
        throw new UsageError("authorization requires --attest-diff-confined and --attest-mechanism-plausible");
      }
      const humanDecision: HumanDecision = {
        approver,
        decision: "approved",
        diffConfinedIntelligible: true,
        mechanismPlausible: true,
        reason,
        decidedAt: new Date().toISOString(),
      };
      if (gateFlag === "G1") {
        const controlWinner = digestFlag(strFlag(flags, "control-winner"), "--control-winner");
        const generation2 = digestFlag(strFlag(flags, "generation2"), "--generation2");
        const recordDir = strFlag(flags, "record-dir");
        if (controlWinner === undefined || generation2 === undefined || recordDir === undefined) throw new UsageError(RECURSIVE_USAGE);
        // The G1 statistical record lives in the (separate) stage-A cell directory.
        const authorization = assembleG1Authorization({
          config,
          record: readG1Record(resolve(io.root, recordDir)),
          controlWinner: await checkedPublicIdentity(controlWinner, gate),
          generation2: await checkedPublicIdentity(generation2, gate),
          humanDecision,
        });
        const authorizationPath = writeAuthorization(campaignDir, authorization);
        io.out(canonicalJson({ configHash, phase, gate: gateFlag, authorizationPath }));
        return 0;
      }
      const generation0 = digestFlag(strFlag(flags, "generation0"), "--generation0");
      const generation1 = digestFlag(strFlag(flags, "generation1"), "--generation1");
      const generation2 = digestFlag(strFlag(flags, "generation2"), "--generation2");
      if (generation0 === undefined || generation1 === undefined || generation2 === undefined) throw new UsageError(RECURSIVE_USAGE);
      const authorization = assembleG2Authorization({
        config,
        record: readG2Record(campaignDir),
        generation0: await checkedPublicIdentity(generation0, gate),
        generation1: await checkedPublicIdentity(generation1, gate),
        generation2: await checkedPublicIdentity(generation2, gate),
        humanDecision,
      });
      const authorizationPath = writeAuthorization(campaignDir, authorization);
      io.out(canonicalJson({ configHash, phase, gate: gateFlag, authorizationPath }));
      return 0;
    }

    if (existsSync(outerRunDir) && replayRun(outerRunDir).finished !== null) {
      const terminal = replayRun(outerRunDir).finished;
      if (terminal?.status !== "completed") {
        io.out(canonicalJson({ configHash, phase, runId: outerRunId, status: terminal?.status }));
        return 1;
      }
      assertExactSearchCardinality(journal, config);
      const trajectoryPath = persistMetaSearchTrajectory({ root: io.root, campaignDir, outerRunId, configHash, config, journal });
      const winner = await selectedSearchWinner(outerRunDir, config, gate);
      const receiptPath = recursivePhaseReceipt(campaignDir, phase, config, {
        generation: config.generation,
        target: targetIdentity,
        controller: config.controllerOptimizer,
        winner,
        trajectoryPath,
      });
      io.out(canonicalJson({ configHash, phase, runId: outerRunId, status: "completed", winner, trajectoryPath, receiptPath }));
      return 0;
    }

    const outerConfigPath = join(campaignDir, "outer-config.json");
    if (!existsSync(outerConfigPath)) {
      writeCampaignOuterRunConfig(
        outerConfigPath,
        config,
        config.generation.outerReplicate,
      );
    }
    const resume = existsSync(outerRunDir);
    const commandArgs = resume
      ? [syntheticCapsule, "--headless", "--resume", "--optimizer-artifact", controller.sourceArtifact]
      : [syntheticCapsule, "--headless", "--config", outerConfigPath, "--optimizer-artifact", controller.sourceArtifact];
    const code = await runCommand(commandArgs, io, {
      runId: outerRunId,
      evalTimeoutSec: config.evaluatorTimeoutSec,
      recursiveBroker,
      evaluationStrategy: recursiveEvaluationStrategy,
      optimizerEpisodesMax: config.counts.candidateAttemptsMax,
      maxPublicCandidateEvaluations: config.counts.candidateAttemptsMax,
      optimizerBaseSnapshot: rootSnapshot,
      ...(mutationWorkerPreflightContract === undefined
        ? {}
        : { mutationWorkerPreflightContract }),
      proxyRole: "outer-optimizer",
      campaignPauseAuthority,
      campaignConfigHash: configHash,
      hasUnsettledPendingChild: () => journal.queryPendingChildren().length !== 0,
      // The synthetic outer task is trusted campaign machinery rather than a
      // corpus capsule; its manifest bytes were validated before campaign seal.
      admissionReview: "off",
    });
    const boundaryCode = completeSearchCommandRun({
      exitCode: code,
      outerRunDir,
      persistTrajectory: () =>
        persistMetaSearchTrajectory({ root: io.root, campaignDir, outerRunId, configHash, config, journal }),
      reportSecondaryFailure: io.err,
    });
    if (boundaryCode !== 0) return boundaryCode;
    const terminal = replayRun(outerRunDir).finished;
    if (terminal?.status !== "completed") throw new UsageError("recursive search returned success without a completed terminal event");
    assertExactSearchCardinality(journal, config);
    const trajectoryPath = persistMetaSearchTrajectory({ root: io.root, campaignDir, outerRunId, configHash, config, journal });
    const winner = await selectedSearchWinner(outerRunDir, config, gate);
    const receiptPath = recursivePhaseReceipt(campaignDir, phase, config, {
      generation: config.generation,
      target: targetIdentity,
      controller: config.controllerOptimizer,
      winner,
      trajectoryPath,
    });
    io.out(canonicalJson({ configHash, phase, runId: outerRunId, status: "completed", winner, trajectoryPath, receiptPath }));
    return 0;
  } finally {
    runner.close();
    recursiveResourceLedger.close();
    envelopeRecordPort.close();
    journal.close();
  }
}
