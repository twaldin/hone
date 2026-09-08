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
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  CasStore,
  RecursiveResourceLedger,
  hashChildRunLaunchReceipt,
  packDirAsArtifact,
  readBrokerJournalEvaluations,
  type BrokerJournalEvaluationSnapshot,
  type BrokerRecursiveConfig,
  type BrokerCorpusConfig,
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
  metaCampaignConfigHash,
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
  MetaCampaignConfigV1,
  MetaCampaignConfigV2,
  ProxyTraceRecord,
  SpawnRunParams,
  canonicalJson,
  deriveCapsuleId,
  type BudgetEnvelope,
  type ChildRunAdmission as ChildRunAdmissionRecord,
  type CampaignPauseSignal as CampaignPauseSignalRecord,
  type CampaignResumeSignal as CampaignResumeSignalRecord,
  type ProxyPreflightResult,
  type MetaCapsuleEntry,
  type MetaCampaignConfigV1 as MetaCampaignConfig,
  type MetaCampaignConfig as AnyMetaCampaignConfig,
  type MetaCampaignConfigV2 as RecursiveMetaCampaignConfig,
  type SpawnRunParams as SpawnRunRequest,
} from "@hone/schema";
import { extractWorkspaceArtifact } from "../artifact.js";
import { admitCapsule, capsuleOracleDigest, capsuleScalarizerDigest, type AdmittedCapsule } from "../admission.js";
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
import type { Flags } from "../args.js";
import {
  buildBrokerCorpusConfig,
  corpusCohortFenceError,
  type BuildBrokerCorpusConfigInputs,
} from "../corpus-provenance.js";
import { EVENTS_FILE, bestArtifact, readEvents, replayRun, writeFileDurable } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { MetaJournalV1, metaWorkKey } from "../meta-journal.js";
import { persistMetaSearchTrajectory } from "../meta-trajectory.js";
import {
  assembleG1Authorization,
  assembleG1Record,
  assembleG1SearchApproval,
  assembleG2Authorization,
  assembleG2Record,
  assertG1Authorized,
  assertG1SearchApproved,
  assertG2Authorized,
  readG1Record,
  readG2Record,
  readConfirmationReceipt,
  readGateThresholdsFile,
  writeAuthorization,
  writeG1Record,
  writeG1SearchApproval,
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
import { resolveCandidateOptimizer, type ResolvedCandidateOptimizer } from "../optimizer-artifact.js";
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
import { casRoot, loadRunConfigFile, runsRoot } from "../runs.js";
import { verifiedBootRuntimeDigest } from "../runtime-digest.js";
import { runCommand } from "../supervisor.js";
import { z } from "zod";
import type { CampaignPauseAuthority } from "../types.js";

const HONE_USAGE = "usage: hone hone --campaign <path> --headless [--phase freeze|search|confirmation|holdout] [--out <gitignored-path>]";
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
interface CapsuleLocation {
  dir: string;
  digest: string;
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

function conformanceFile(campaignDir: string, sourceArtifact: Sha256Digest): string {
  return join(campaignDir, `conformance-${sourceArtifact.slice("sha256:".length)}.json`);
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

class CliCandidateGate implements MetaCandidateGate {
  private readonly baseDigest: Sha256Digest;
  private readonly controls = new Map<Sha256Digest, RegisteredControl>();
  private readonly receipts = new Map<Sha256Digest, CandidateConformanceReceipt>();
  private readonly bundleOwners = new Map<Sha256Digest, Sha256Digest>();
  private readonly inFlight = new Map<Sha256Digest, Promise<CandidateGateResult>>();

  constructor(private readonly opts: CandidateGateOptions) {
    this.baseDigest = snapshotDigest(opts.comparisonImage, opts.baseSnapshot) as Sha256Digest;
    for (const control of opts.controls) this.controls.set(control.sourceArtifact, control);
    for (const entry of readdirSync(opts.campaignDir)) {
      if (!/^conformance-[0-9a-f]{64}\.json$/.test(entry)) continue;
      const receipt = readConformanceReceipt(join(opts.campaignDir, entry));
      if (
        receipt.baseDigest !== this.baseDigest
        || receipt.runtime.image !== opts.comparisonImage
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
    const file = conformanceFile(this.opts.campaignDir, sourceArtifact);
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

export class CliChildSupervisor implements MetaChildSupervisor {
  constructor(
    private readonly io: CmdIo,
    private readonly config: AnyMetaCampaignConfig,
    private readonly campaignDir: string,
    private readonly capsules: ReadonlyMap<string, CapsuleLocation>,
    private readonly baseSnapshot: OptimizerSnapshot,
    private readonly modelRegistry: CampaignModelRegistry,
    private readonly campaignPauseAuthority?: CampaignPauseAuthority,
    private readonly corpus?: BrokerCorpusConfig,
  ) {}

  async run(request: MetaChildRunRequest): Promise<MetaChildRunOutcome> {
    return await this.runLaunched(
      request,
      this.config.version === 2 ? metaCampaignConfigHash(this.config) : undefined,
    );
  }

  async runLaunched(
    request: MetaChildRunRequest,
    campaignConfigHash?: Sha256Digest,
  ): Promise<MetaChildRunOutcome> {
    if (this.config.version === 2) {
      if (this.corpus === undefined) throw new UsageError("recursive child requires verified corpus provenance");
      if (campaignConfigHash !== metaCampaignConfigHash(this.config)
        || this.corpus.provenance.campaignConfigHash !== campaignConfigHash) {
        throw new UsageError("recursive child corpus campaign identity drift");
      }
      const corpusError = corpusCohortFenceError(this.corpus, this.config.corpusCohort);
      if (corpusError !== null) throw new UsageError(corpusError);
    }
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
        promotion: this.config.promotion,
      }, null, 2)}\n`);
      chmodSync(configPath, 0o600);
      if (this.campaignPauseAuthority !== undefined && !campaignChildAdmissionAllowed(this.campaignPauseAuthority)) {
        return this.notRun(request, "campaign child admission paused before durable run start", runDir);
      }
      const code = await runCommand(
        [location.dir, "--headless", "--config", configPath, "--optimizer-artifact", request.sourceArtifact],
        this.childIo(),
        {
          runId: executionRunId,
          measurementEpoch: request.identity.measurementEpoch,
          optimizerEpisodesMax: request.innerEpisodesMax,
          maxPublicCandidateEvaluations: 2 * request.innerEpisodesMax,
          ...(request.identity.phase === "holdout"
            ? { terminalHoldoutAssetGroupIds: location.terminalHoldoutAssetGroupIds }
            : {}),
          optimizerBaseSnapshot: this.baseSnapshot,
          ...(this.config.version === 2 ? { proxyRole: "inner-capsule-improvement" as const } : {}),
          ...(this.campaignPauseAuthority === undefined
            ? {}
            : { campaignPauseAuthority: this.campaignPauseAuthority }),
          ...(campaignConfigHash === undefined ? {} : { campaignConfigHash }),
          ...(this.config.version === 2 ? { corpus: this.corpus, corpusCohort: this.config.corpusCohort } : {}),
        },
      );
      if (code !== 0 && !existsSync(join(runDir, EVENTS_FILE))) {
        return this.notRun(request, `child supervisor refused before a run started (exit ${code})`, runDir);
      }
    } else {
      let terminal = false;
      try {
        terminal = replayRun(runDir).finished !== null;
      } catch {
        return this.notRun(request, "child durable state cannot be replayed", runDir);
      }
      if (!terminal) {
        if (this.campaignPauseAuthority !== undefined && !campaignChildAdmissionAllowed(this.campaignPauseAuthority)) {
          return this.notRun(request, "campaign child admission paused before durable run resume", runDir);
        }
        const code = await runCommand(
          [location.dir, "--headless", "--resume", "--optimizer-artifact", request.sourceArtifact],
          this.childIo(),
          {
            runId: executionRunId,
            measurementEpoch: request.identity.measurementEpoch,
            optimizerEpisodesMax: request.innerEpisodesMax,
            maxPublicCandidateEvaluations: 2 * request.innerEpisodesMax,
            ...(request.identity.phase === "holdout"
              ? { terminalHoldoutAssetGroupIds: location.terminalHoldoutAssetGroupIds }
              : {}),
            optimizerBaseSnapshot: this.baseSnapshot,
            ...(this.config.version === 2 ? { proxyRole: "inner-capsule-improvement" as const } : {}),
            ...(this.campaignPauseAuthority === undefined
              ? {}
              : { campaignPauseAuthority: this.campaignPauseAuthority }),
            ...(campaignConfigHash === undefined ? {} : { campaignConfigHash }),
            ...(this.config.version === 2 ? { corpus: this.corpus, corpusCohort: this.config.corpusCohort } : {}),
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

  private childIo(): CmdIo {
    return {
      root: this.io.root,
      env: this.io.env,
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

/**
 * Per-spawn M2 bridge. Search allocation is admitted and measured one child
 * at a time; panel completeness is derived later from the durable trajectory.
 */
export class RecursiveSearchChildLauncher {
  constructor(
    private readonly root: string,
    private readonly campaignDir: string,
    private readonly config: RecursiveMetaCampaignConfig,
    private readonly configHash: Sha256Digest,
    private readonly journal: MetaJournalV1,
    private readonly gate: MetaCandidateGate,
    private readonly childSupervisor: CliChildSupervisor,
    private readonly envelopeLedger: MetaResourceEnvelopeLedger,
    private readonly campaignPauseAuthority: CampaignPauseAuthority,
  ) {}

  brokerConfig(
    ledger: BrokerRecursiveConfig["ledger"],
    depth: BrokerRecursiveConfig["depth"] = 0,
    ancestors: readonly string[] = [],
  ): BrokerRecursiveConfig {
    return {
      depth,
      ancestors,
      ledger,
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
    const gate = await this.gate.check({
      mode: "public-mutable",
      sourceArtifact: identity.sourceArtifact,
    });
    if (!gate.ok || gate.bundleDigest !== identity.bundleDigest) {
      throw new Error(`recursive child optimizer conformance refused: ${gate.feedback}`);
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

    const capsule = this.config.developmentPanel.members.find(
      (member) => member.capsule.capsuleId === request.child.capsuleId,
    )?.capsule;
    if (capsule === undefined) throw new Error("recursive launch capsule left the frozen panel");
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
      if (outcome.responseModel === null || outcome.modelDriftSentinel === null) {
        throw new Error("recursive child completion has no authenticated model observation");
      }
      this.journal.settleChild(identity, {
        evidenceHash,
        observed: outcome.spend,
        qRaw,
        responseModel: outcome.responseModel,
        providerFingerprint: outcome.providerFingerprint,
        modelDriftSentinel: outcome.modelDriftSentinel,
      });
    } else {
      this.journal.settleChildFailure(identity, {
        evidenceHash,
        observed: outcome.spend,
        status: outcome.status === "budget"
          ? "budget"
          : outcome.status === "infrastructure_not_run"
            ? "infrastructure_not_run"
            : "candidate_failed",
      });
    }
    this.envelopeLedger.settleDescendant(envelopeRequest.reservationId, outcome.spend);
    return {
      launchReceiptPath: receiptPath,
      terminalEventPath: join(runsRoot(this.root), request.child.runId, EVENTS_FILE),
      usage: { ...outcome.spend },
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

class CampaignModelRegistry {
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

interface DiscoveredCapsule {
  readonly dir: string;
  readonly admitted: AdmittedCapsule;
}


export function discoverCapsules(root: string): Map<string, DiscoveredCapsule> {
  const found = new Map<string, DiscoveredCapsule>();
  const capsuleRoot = join(root, "capsules");
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
  const discovered = discoverCapsules(root);
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

function resolveRegisteredCapsules(root: string, config: AnyMetaCampaignConfig): Map<string, CapsuleLocation> {
  const discovered = discoverCapsules(root);
  const found = new Map<string, CapsuleLocation>();
  for (const registered of [...config.train, ...config.holdout]) {
    const capsule = discovered.get(registered.capsuleId);
    if (capsule === undefined) throw new UsageError(`registered campaign capsule ${registered.capsuleId} is not installed`);
    const admitted = capsule.admitted;
    if (
      admitted.digest !== registered.capsuleDigest
      || admitted.manifest.image !== registered.image
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
    found.set(registered.capsuleDigest, {
      dir: capsule.dir,
      digest: admitted.digest,
      terminalHoldoutAssetGroupIds,
    });
  }
  return found;
}

async function captureSeedCandidate(root: string, cas: CasStore): Promise<{ artifactHash: Sha256Digest }> {
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

function sourceCommit(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new UsageError("official meta campaigns require a git worktree with a committed HEAD");
  }
}

function assertCleanSourceTree(root: string): void {
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

function freezeRecursiveCampaignConfig(
  draft: RecursiveMetaCampaignConfig,
  corpus: FrozenCorpus,
  identities: FrozenRecursiveIdentities,
): RecursiveMetaCampaignConfig {
  const identified = {
    ...draft,
    train: corpus.train,
    holdout: corpus.holdout,
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
  const runner = new MetaCampaignRunner({
    config,
    journal,
    joinPath: join(campaignDir, "candidate-child-joins.ndjson"),
    candidateGate: gate,
    childSupervisor: new CliChildSupervisor(io, config, campaignDir, capsules, seedSnapshot, modelRegistry),
  });
  const strategy: TrustedEvaluationStrategy = async (request) => await runner.evaluateSearchCandidate({
    sourceArtifact: request.artifact.hash as Sha256Digest,
    outerCapsuleId: request.capsuleId,
    assetGroupId: request.assetGroupId,
    seed: request.seed,
  });
  const outerRunId = `run_meta_outer_${configHash.slice("sha256:".length)}`;
  const outerRunDir = join(runsRoot(io.root), outerRunId);
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
      writeFileDurable(configFile, `${JSON.stringify({
        routing: { mutation: { model: config.routing.outerMutation } },
        apply: "none",
        headless: true,
        budget: config.budgets.outer,
        promotion: config.promotion,
      }, null, 2)}\n`);
      chmodSync(configFile, 0o600);
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
    if (
      existsSync(join(outerRunDir, EVENTS_FILE))
      && readEvents(outerRunDir).some((event) => event.type === "eval.completed" || event.type === "episode.invalid")
    ) {
      persistMetaSearchTrajectory({
        root: io.root,
        campaignDir,
        outerRunId,
        configHash,
        config,
        journal,
      });
    }
    if (code === 0) {
      const terminal = replayRun(outerRunDir).finished;
      if (terminal?.status !== "completed") throw new UsageError("search returned success without a completed terminal event");
      assertExactSearchCardinality(journal, config);
    }
    return code;
  } finally {
    runner.close();
    journal.close();
  }
}

const RECURSIVE_USAGE =
  "usage: hone recursive --campaign <path> --headless "
  + "[--phase freeze|search|approve-search|confirmation|terminal|authorize] "
  + "[--out <gitignored-path>] [--target-artifact sha256:<64hex>] [--controller-artifact sha256:<64hex>] "
  + "[--control-winner sha256:<64hex>] [--generation0 sha256:<64hex>] [--generation1 sha256:<64hex>] "
  + "[--generation2 sha256:<64hex>] [--gate-thresholds <path>] [--gate G1|G2] [--approver <name>] "
  + "[--reason <text>] [--record-dir <stage-a-cell-dir>] [--attest-diff-confined] [--attest-mechanism-plausible]";

function recursiveHumanDecision(flags: Flags): HumanDecision {
  const approver = strFlag(flags, "approver");
  const reason = strFlag(flags, "reason");
  if (approver === undefined || reason === undefined) throw new UsageError(RECURSIVE_USAGE);
  if (!boolFlag(flags, "attest-diff-confined") || !boolFlag(flags, "attest-mechanism-plausible")) {
    throw new UsageError("authorization requires --attest-diff-confined and --attest-mechanism-plausible");
  }
  return {
    approver,
    decision: "approved",
    diffConfinedIntelligible: true,
    mechanismPlausible: true,
    reason,
    decidedAt: new Date().toISOString(),
  };
}

function digestFlag(value: string | undefined, label: string): Sha256Digest | undefined {
  if (value === undefined) return undefined;
  if (!SHA256_PATTERN.test(value)) throw new UsageError(`${label} must be a lowercase sha256 digest`);
  return value as Sha256Digest;
}

function recursiveOptimizerImage(config: RecursiveMetaCampaignConfig): string {
  return config.optimizerRuntime.image;
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

function recursivePhaseReceipt(
  campaignDir: string,
  phase: string,
  configHash: Sha256Digest,
  body: Record<string, unknown>,
): string {
  const receipt = {
    version: 1,
    configHash,
    phase,
    ...body,
  };
  const output = join(campaignDir, `${phase}-receipt.json`);
  writeFileDurable(output, `${canonicalJson(receipt)}\n`);
  chmodSync(output, 0o600);
  return output;
}

export interface TrustedRecursiveOptions {
  /** Existing assembled artifact and exact document bytes; never read from optimizer flags/config. */
  corpus?: Omit<BuildBrokerCorpusConfigInputs, "campaignConfigHash">;
}

function recursiveCorpus(config: RecursiveMetaCampaignConfig, inputs: TrustedRecursiveOptions["corpus"]): BrokerCorpusConfig {
  if (inputs === undefined) throw new UsageError("recursive execution requires verified corpus provenance and document bytes");
  const corpus = buildBrokerCorpusConfig({ ...inputs, campaignConfigHash: metaCampaignConfigHash(config) });
  const cohortError = corpusCohortFenceError(corpus, config.corpusCohort);
  if (cohortError !== null) throw new UsageError(cohortError);
  for (const [entries, role] of [[config.train, "development"], [config.holdout, "terminal"]] as const) {
    for (const entry of entries) {
      const record = inputs.provenance.capsules.find((capsule) => capsule.id === entry.capsuleId);
      if (record?.digest !== entry.capsuleDigest || record.role !== role) {
        throw new UsageError(`recursive corpus capsule ${entry.capsuleId} differs from the frozen ${role} identity`);
      }
    }
  }
  const panelIds = new Set(config.developmentPanel.members.map((member) => member.capsule.capsuleId));
  const panel = config.developmentPanel.panel === "A" ? "panel-a" : "panel-b";
  for (const document of corpus.panelEvidence) {
    if ((document.provenance.cohort === panel) !== panelIds.has(document.provenance.capsuleId)) {
      throw new UsageError(`recursive corpus document ${document.id} differs from the frozen panel assignment`);
    }
  }
  return corpus;
}

/** Execute one frozen recursive generation cell; orchestration composes these durable cells. */
export async function recursiveCommand(args: string[], io: CmdIo, trusted: TrustedRecursiveOptions = {}): Promise<number> {
  const { positionals, flags } = parseFlags(args, {
    booleans: ["headless", "attest-diff-confined", "attest-mechanism-plausible"],
    strings: [
      "campaign",
      "phase",
      "out",
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
  if (!["freeze", "search", "approve-search", "confirmation", "terminal", "authorize"].includes(phaseFlag)) throw new UsageError(RECURSIVE_USAGE);
  const phase = phaseFlag as "freeze" | "search" | "approve-search" | "confirmation" | "terminal" | "authorize";
  const outFlag = strFlag(flags, "out");
  if ((phase === "freeze") !== (outFlag !== undefined)) throw new UsageError(RECURSIVE_USAGE);
  if (optimizerOverridden(io.env)) throw new UsageError("official recursive campaigns refuse HONE_OPTIMIZER_CMD");

  const campaignPath = resolve(io.root, campaignFlag);
  let config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
  const configHash = metaCampaignConfigHash(config);
  const hashBody = configHash.slice("sha256:".length);
  const campaignDir = join(runsRoot(io.root), `recursive-cell-${hashBody}`);
  if (phase === "search" && config.generation.stage === "B") {
    // Refuse before preparing optimizers, controls, ledgers or resumed work.
    assertG1SearchApproved(campaignDir, config);
  }
  // Non-executing freeze/approval/authorization remain independent of document availability.
  // Every executing phase verifies before optimizer preparation or any child dispatch.
  const corpus = phase === "search" || phase === "confirmation" || phase === "terminal"
    ? recursiveCorpus(config, trusted.corpus) : undefined;
  assertCleanSourceTree(io.root);
  const commit = sourceCommit(io.root);
  const runtimeDigest = verifiedBootRuntimeDigest() as Sha256Digest;
  if (phase !== "freeze" && (config.trustedRuntime.sourceCommit !== commit || config.trustedRuntime.digest !== runtimeDigest)) {
    throw new UsageError("recursive campaign trusted runtime identity drift");
  }
  if (phase === "approve-search") {
    const recordDir = strFlag(flags, "record-dir");
    if (recordDir === undefined) throw new UsageError(RECURSIVE_USAGE);
    const sourceRecordDir = resolve(io.root, recordDir);
    const approval = assembleG1SearchApproval({
      config,
      record: readG1Record(sourceRecordDir),
      recordDir: sourceRecordDir,
      humanDecision: recursiveHumanDecision(flags),
    });
    mkdirSync(campaignDir, { recursive: true, mode: 0o700 });
    chmodSync(campaignDir, 0o700);
    const approvalPath = writeG1SearchApproval(campaignDir, approval);
    io.out(canonicalJson({ configHash, phase, gate: "G1", approvalPath }));
    return 0;
  }
  const casDir = casRoot(io.root);
  const cas = new CasStore(casDir);
  const rootSnapshot = collectOptimizerSnapshot(io.root);
  assertMutablePathsResolve(config.mutablePaths, rootSnapshot);
  assertOptimizerProtectedPathsResolve(config.protectedPaths, rootSnapshot);
  const localSeed = await captureSeedCandidate(io.root, cas);

  if (phase === "freeze") {
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
    const frozen = freezeRecursiveCampaignConfig(config, corpus, {
      sourceCommit: commit,
      runtimeDigest,
      target,
      controller,
      brokenControl: controls.broken,
      degradedControl: controls.degraded,
    });
    if (outFlag === undefined) throw new UsageError(RECURSIVE_USAGE);
    const outputPath = writeFrozenCampaign(io.root, outFlag, frozen);
    io.out(canonicalJson({
      phase,
      outputPath,
      configHash: metaCampaignConfigHash(frozen),
      generation: frozen.generation,
      target: frozen.seedOptimizer,
      controller: frozen.controllerOptimizer,
      controls: frozen.controls,
    }));
    return 0;
  }

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
  mkdirSync(campaignDir, { recursive: true, mode: 0o700 });
  chmodSync(campaignDir, 0o700);
  const registeredConfigPath = join(campaignDir, "campaign.json");
  if (existsSync(registeredConfigPath)) {
    const registered = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(registeredConfigPath, "utf8")));
    if (canonicalJson(registered) !== canonicalJson(config)) throw new UsageError("recursive cell state belongs to a different configuration");
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
    config,
    campaignDir,
    capsules,
    target.snapshot,
    modelRegistry,
    campaignPauseAuthority,
    corpus,
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
  const runner = new MetaCampaignRunner({
    config,
    journal,
    joinPath: join(campaignDir, "candidate-child-joins.ndjson"),
    candidateGate: gate,
    childSupervisor,
    envelopeLedger,
  });
  const outerRunId = `run_recursive_outer_${hashBody}`;
  const outerRunDir = join(runsRoot(io.root), outerRunId);

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
        const receiptPath = recursivePhaseReceipt(campaignDir, phase, configHash, {
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
      // The later artifact-bound G1 authorization remains required for confirmation.
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
      const receiptPath = recursivePhaseReceipt(campaignDir, phase, configHash, {
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
      const receiptPath = recursivePhaseReceipt(campaignDir, phase, configHash, {
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
      const humanDecision = recursiveHumanDecision(flags);
      if (gateFlag === "G1") {
        const controlWinner = digestFlag(strFlag(flags, "control-winner"), "--control-winner");
        const generation2 = digestFlag(strFlag(flags, "generation2"), "--generation2");
        const recordDir = strFlag(flags, "record-dir");
        if (controlWinner === undefined || generation2 === undefined || recordDir === undefined) throw new UsageError(RECURSIVE_USAGE);
        // The G1 statistical record lives in the (separate) stage-A cell directory.
        const authorization = assembleG1Authorization({
          configHash,
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
        configHash,
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
      const receiptPath = recursivePhaseReceipt(campaignDir, phase, configHash, {
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
      writeFileDurable(outerConfigPath, `${JSON.stringify({
        routing: { mutation: { model: config.routing.outerMutation } },
        apply: "none",
        headless: true,
        seed: config.generation.outerReplicate,
        budget: config.budgets.outer,
        promotion: config.promotion,
      }, null, 2)}\n`);
      chmodSync(outerConfigPath, 0o600);
    }
    const resume = existsSync(outerRunDir);
    const commandArgs = resume
      ? [syntheticCapsule, "--headless", "--resume", "--optimizer-artifact", controller.sourceArtifact]
      : [syntheticCapsule, "--headless", "--config", outerConfigPath, "--optimizer-artifact", controller.sourceArtifact];
    // Preparation awaits artifact resolution; refresh approval at the launch boundary.
    if (config.generation.stage === "B") assertG1SearchApproved(campaignDir, config);
    const code = await runCommand(commandArgs, io, {
      runId: outerRunId,
      recursiveBroker,
      optimizerEpisodesMax: config.counts.candidateAttemptsMax,
      maxPublicCandidateEvaluations: config.counts.candidateAttemptsMax,
      optimizerBaseSnapshot: rootSnapshot,
      proxyRole: "outer-optimizer",
      campaignPauseAuthority,
      campaignConfigHash: configHash,
      corpus,
      corpusCohort: config.corpusCohort,
      // The synthetic outer task is trusted campaign machinery rather than a
      // corpus capsule; its manifest bytes were validated before campaign seal.
      admissionReview: "off",
    });
    if (
      existsSync(join(outerRunDir, EVENTS_FILE))
      && readEvents(outerRunDir).some((event) => event.type === "eval.completed" || event.type === "episode.invalid")
    ) {
      persistMetaSearchTrajectory({ root: io.root, campaignDir, outerRunId, configHash, config, journal });
    }
    if (code !== 0) return code;
    const terminal = replayRun(outerRunDir).finished;
    if (terminal?.status !== "completed") throw new UsageError("recursive search returned success without a completed terminal event");
    assertExactSearchCardinality(journal, config);
    const trajectoryPath = persistMetaSearchTrajectory({ root: io.root, campaignDir, outerRunId, configHash, config, journal });
    const winner = await selectedSearchWinner(outerRunDir, config, gate);
    const receiptPath = recursivePhaseReceipt(campaignDir, phase, configHash, {
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
