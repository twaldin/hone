import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  BudgetEnvelope,
  EvaluationRecord,
  MetaCampaignConfig as MetaCampaignConfigSchema,
  canonicalJson,
  type MetaCampaignConfig,
} from "@hone/schema";
import { z } from "zod";

export type Sha256Digest = `sha256:${string}`;
const DIGEST = z.custom<Sha256Digest>(
  (value): value is Sha256Digest => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value),
  { message: "expected a lowercase sha256 digest" },
);
const SAFE_ID = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
const ResourceUsage = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().finite().nonnegative(),
  wallClockSec: z.number().finite().nonnegative(),
  evaluatorInvocations: z.number().int().nonnegative(),
}).strict();

export type MetaPhase = "search" | "confirmation" | "holdout";
export type MetaArm =
  | "candidate"
  | "seed"
  | "winner"
  | "broken-control"
  | "degraded-control"
  | "controller-control-winner"
  | "generation-0"
  | "generation-1"
  | "generation-2";

export interface MetaArtifactIdentity {
  readonly sourceArtifact: Sha256Digest;
  readonly bundleDigest: Sha256Digest;
}

export interface MetaControlTransformation {
  readonly path: string;
  readonly beforeSha256: Sha256Digest;
  readonly afterSha256: Sha256Digest;
  readonly mode: 0o644 | 0o755;
}

export interface MetaControlTransformationReceipt {
  readonly version: 1;
  readonly kind: "broken" | "degraded";
  readonly transformation: "broken-no-candidate-v1" | "degraded-blind-restart-v1";
  readonly sourceSealHash: Sha256Digest;
  readonly artifactDigest: Sha256Digest;
  readonly files: number;
  readonly transformedFiles: readonly MetaControlTransformation[];
}

export interface MetaTrustedControlArtifact extends MetaArtifactIdentity {
  readonly transformationReceipt: MetaControlTransformationReceipt;
}

const ControlReceipt = z.object({
  version: z.literal(1),
  kind: z.enum(["broken", "degraded"]),
  transformation: z.enum(["broken-no-candidate-v1", "degraded-blind-restart-v1"]),
  sourceSealHash: DIGEST,
  artifactDigest: DIGEST,
  files: z.number().int().positive(),
  transformedFiles: z.array(z.object({
    path: z.string().min(1),
    beforeSha256: DIGEST,
    afterSha256: DIGEST,
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
  }).strict()).min(1),
}).strict();

export interface MetaWorkIdentity extends MetaArtifactIdentity {
  phase: MetaPhase;
  arm: MetaArm;
  capsuleId: string;
  replicate: number;
  measurementEpoch: string;
}

export interface MetaReservation {
  configHash: Sha256Digest;
  workKey: Sha256Digest;
  childRunId: string;
  identity: MetaWorkIdentity;
  reserved: BudgetEnvelope;
}

export interface MetaMeasurement extends MetaWorkIdentity {
  configHash: Sha256Digest;
  protocolHash: Sha256Digest;
  analysisConfigHash: Sha256Digest;
  capsuleDigest: Sha256Digest;
  requestedModel: string;
  responseModel: string;
  providerFingerprint: string | null;
  modelDriftSentinel: string;
  workKey: Sha256Digest;
  childRunId: string;
  evidenceHash: Sha256Digest;
  reserved: BudgetEnvelope;
  observed: MetaResourceUsage;
  qRaw: number;
  qBase: number;
  scale: number;
  qNormalized: number;
}

export interface MetaResourceUsage {
  tokens: number;
  usd: number;
  wallClockSec: number;
  evaluatorInvocations: number;
}

export type MetaFailureStatus = "budget" | "candidate_failed" | "infrastructure_not_run";

export interface MetaFailureSettlement extends MetaWorkIdentity {
  configHash: Sha256Digest;
  protocolHash: Sha256Digest;
  analysisConfigHash: Sha256Digest;
  capsuleDigest: Sha256Digest;
  workKey: Sha256Digest;
  childRunId: string;
  evidenceHash: Sha256Digest;
  reserved: BudgetEnvelope;
  observed: MetaResourceUsage;
  status: MetaFailureStatus;
}

export interface MetaJournalPort {
  readonly configHash: Sha256Digest;
  reserveChild(identity: MetaWorkIdentity): MetaReservation;
  settleChild(
    identity: MetaWorkIdentity,
    input: {
      evidenceHash: string;
      observed: MetaResourceUsage;
      qRaw: number;
      responseModel: string;
      providerFingerprint: string | null;
      modelDriftSentinel: string;
    },
  ): MetaMeasurement;
  settleChildFailure(
    identity: MetaWorkIdentity,
    input: { evidenceHash: string; observed: MetaResourceUsage; status: MetaFailureStatus },
  ): MetaFailureSettlement;
  queryTrainMeasurements(): readonly MetaMeasurement[];
  queryHoldoutMeasurements(): readonly MetaMeasurement[];
  queryFailureSettlements(): readonly MetaFailureSettlement[];
  latchTerminalHoldout(): void;
}

export interface CandidateGateAccepted extends MetaArtifactIdentity {
  ok: true;
  /** Null for public mutable candidates; exact receipt hash for a trusted control. */
  transformationReceiptHash: Sha256Digest | null;
  /** Bounded, protected-data-free conformance feedback. */
  feedback: string;
}

export interface CandidateGateRejected {
  ok: false;
  feedback: string;
}

export type CandidateGateResult = CandidateGateAccepted | CandidateGateRejected;

export type MetaCandidateGateRequest =
  | { readonly mode: "public-mutable"; readonly sourceArtifact: Sha256Digest }
  | {
      readonly mode: "trusted-control";
      readonly sourceArtifact: Sha256Digest;
      readonly bundleDigest: Sha256Digest;
      readonly transformationReceipt: MetaControlTransformationReceipt;
    };

export interface MetaCandidateGate {
  check(request: MetaCandidateGateRequest): Promise<CandidateGateResult>;
}

export type MetaChildStatus = "completed" | "budget" | "candidate_failed" | "infrastructure_not_run";

export interface MetaChildRunRequest {
  identity: MetaWorkIdentity;
  reservation: MetaReservation;
  sourceArtifact: Sha256Digest;
  bundleDigest: Sha256Digest;
  capsule: MetaCampaignConfig["train"][number] | MetaCampaignConfig["holdout"][number];
  innerEpisodesMax: number;
  requestedModel: string;
  /** Cumulative child envelope left after every prior authenticated attempt. */
  remainingBudget: BudgetEnvelope;
  /** Zero for the original prelaunch receipt, one for its single infrastructure retry. */
  attempt: 0 | 1;
  /** True after a durable prelaunch receipt already exists; resume this exact child id. */
  resume: boolean;
}

export interface MetaChildRunOutcome {
  status: MetaChildStatus;
  childRunId: string;
  measurementEpoch: string;
  capsuleId: string;
  sourceArtifact: Sha256Digest;
  bundleDigest: Sha256Digest;
  /** Capsule-image-bound optimizer closure actually executed, when launch reached it. */
  runtimeBundleDigest: Sha256Digest | null;
  baselineArtifactHash: Sha256Digest | null;
  bestArtifactHash: Sha256Digest | null;
  finalEvaluation: EvaluationRecord | null;
  finalEvaluationHash: Sha256Digest | null;
  /** Cumulative authenticated spend for this child id, not per-attempt incremental spend. */
  spend: MetaResourceUsage;
  eventLogHash: Sha256Digest | null;
  eventLogCursor: number | null;
  proxyTraceHash: Sha256Digest | null;
  brokerJournalHash: Sha256Digest | null;
  responseModel: string | null;
  providerFingerprint: string | null;
  modelDriftSentinel: string | null;
  feedback: string;
}

export interface MetaChildSupervisor {
  run(request: MetaChildRunRequest): Promise<MetaChildRunOutcome>;
}

export interface MetaChildEvidenceV1 extends MetaWorkIdentity {
  version: 1;
  configHash: Sha256Digest;
  workKey: Sha256Digest;
  childRunId: string;
  capsuleDigest: Sha256Digest;
  transformationReceiptHash: Sha256Digest | null;
  runtimeBundleDigest: Sha256Digest | null;
  attempt: 0 | 1;
  baselineArtifactHash: Sha256Digest | null;
  bestArtifactHash: Sha256Digest | null;
  finalEvaluationHash: Sha256Digest | null;
  eventLogHash: Sha256Digest | null;
  eventLogCursor: number | null;
  proxyTraceHash: Sha256Digest | null;
  brokerJournalHash: Sha256Digest | null;
  spend: MetaResourceUsage;
  status: MetaChildStatus;
}

interface StoredCompletion {
  evidence: MetaChildEvidenceV1;
  outcome: MetaChildRunOutcome;
  qRaw: number;
}

interface StoredFailure {
  evidence: MetaChildEvidenceV1;
  outcome: MetaChildRunOutcome;
  attempt: 0 | 1;
  terminal: boolean;
  reason: string;
}

const WorkIdentity = z.object({
  phase: z.enum(["search", "confirmation", "holdout"]),
  arm: z.enum([
    "candidate",
    "seed",
    "winner",
    "broken-control",
    "degraded-control",
    "controller-control-winner",
    "generation-0",
    "generation-1",
    "generation-2",
  ]),
  sourceArtifact: DIGEST,
  bundleDigest: DIGEST,
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  replicate: z.number().int().nonnegative(),
  measurementEpoch: SAFE_ID,
}).strict();
const CandidateLine = z.object({
  v: z.literal(1),
  t: z.literal("candidate"),
  seq: z.number().int().positive(),
  sourceArtifact: DIGEST,
  bundleDigest: DIGEST,
  transformationReceiptHash: DIGEST.nullable(),
  measurementEpoch: SAFE_ID,
}).strict();
const ReceiptLine = z.object({
  v: z.literal(1),
  t: z.literal("receipt"),
  seq: z.number().int().positive(),
  workKey: DIGEST,
  childRunId: SAFE_ID,
  identity: WorkIdentity,
  reserved: BudgetEnvelope,
}).strict();
const RetryLine = z.object({
  v: z.literal(1),
  t: z.literal("retry"),
  seq: z.number().int().positive(),
  workKey: DIGEST,
  attempt: z.literal(1),
  remainingBudget: z.object({
    maxTokens: z.number().int().nonnegative(),
    maxUsd: z.number().finite().nonnegative(),
    maxWallClockSec: z.number().finite().nonnegative(),
    maxEvaluatorInvocations: z.number().int().nonnegative(),
  }).strict(),
}).strict();
const Evidence = WorkIdentity.extend({
  version: z.literal(1),
  configHash: DIGEST,
  workKey: DIGEST,
  childRunId: SAFE_ID,
  capsuleDigest: DIGEST,
  transformationReceiptHash: DIGEST.nullable(),
  runtimeBundleDigest: DIGEST.nullable(),
  attempt: z.union([z.literal(0), z.literal(1)]),
  baselineArtifactHash: DIGEST.nullable(),
  bestArtifactHash: DIGEST.nullable(),
  finalEvaluationHash: DIGEST.nullable(),
  eventLogHash: DIGEST.nullable(),
  eventLogCursor: z.number().int().nonnegative().nullable(),
  proxyTraceHash: DIGEST.nullable(),
  brokerJournalHash: DIGEST.nullable(),
  spend: ResourceUsage,
  status: z.enum(["completed", "budget", "candidate_failed", "infrastructure_not_run"]),
}).strict();
const Outcome = z.object({
  status: z.enum(["completed", "budget", "candidate_failed", "infrastructure_not_run"]),
  childRunId: SAFE_ID,
  measurementEpoch: SAFE_ID,
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  sourceArtifact: DIGEST,
  bundleDigest: DIGEST,
  runtimeBundleDigest: DIGEST.nullable(),
  baselineArtifactHash: DIGEST.nullable(),
  bestArtifactHash: DIGEST.nullable(),
  finalEvaluation: EvaluationRecord.nullable(),
  finalEvaluationHash: DIGEST.nullable(),
  spend: ResourceUsage,
  eventLogHash: DIGEST.nullable(),
  eventLogCursor: z.number().int().nonnegative().nullable(),
  proxyTraceHash: DIGEST.nullable(),
  brokerJournalHash: DIGEST.nullable(),
  responseModel: SAFE_ID.nullable(),
  providerFingerprint: SAFE_ID.nullable(),
  modelDriftSentinel: SAFE_ID.nullable(),
  feedback: z.string(),
}).strict();
const CompletionLine = z.object({
  v: z.literal(1),
  t: z.literal("completion"),
  seq: z.number().int().positive(),
  workKey: DIGEST,
  evidence: Evidence,
  outcome: Outcome,
  qRaw: z.number().finite(),
}).strict();
const FailureLine = z.object({
  v: z.literal(1),
  t: z.literal("failure"),
  seq: z.number().int().positive(),
  workKey: DIGEST,
  evidence: Evidence,
  outcome: Outcome,
  attempt: z.union([z.literal(0), z.literal(1)]),
  terminal: z.boolean(),
  reason: z.string().max(4_096),
}).strict();
const Header = z.object({ v: z.literal(1), t: z.literal("header"), configHash: DIGEST }).strict();
const JoinLine = z.discriminatedUnion("t", [CandidateLine, ReceiptLine, RetryLine, CompletionLine, FailureLine]);
type JoinLine = z.infer<typeof JoinLine>;

function sha256(value: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
    if (wrote <= 0) throw new Error("meta join write made no progress");
    offset += wrote;
  }
}

function ensureOwnerFile(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("meta join is not a single-link regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("meta join permissions are not owner-only");
}

function createJoinHeader(file: string, configHash: Sha256Digest): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.tmp-${randomUUID()}`;
  const fd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeAll(fd, Buffer.from(`${JSON.stringify({ v: 1, t: "header", configHash })}\n`));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  const dirFd = openSync(path.dirname(file), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Durable candidate-to-child-run sidecar. Completion is persisted before journal settlement. */
export class MetaJoinStoreV1 {
  private readonly candidatesByIdentity = new Map<string, z.infer<typeof CandidateLine>>();
  private readonly receipts = new Map<string, z.infer<typeof ReceiptLine>>();
  private readonly retries = new Map<string, z.infer<typeof RetryLine>>();
  private readonly completions = new Map<string, StoredCompletion>();
  private readonly failures = new Map<string, z.infer<typeof FailureLine>>();
  private nextSeq = 1;
  private closed = false;

  private constructor(
    readonly path: string,
    readonly configHash: Sha256Digest,
    private readonly fd: number,
  ) {}

  static open(file: string, configHashInput: string): MetaJoinStoreV1 {
    const configHash = DIGEST.parse(configHashInput);
    try {
      lstatSync(file);
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      createJoinHeader(file, configHash);
    }
    ensureOwnerFile(file);
    chmodSync(file, 0o600);
    const bytes = readFileSync(file);
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) throw new Error("meta join has a torn unterminated tail");
    const lines = bytes.toString("utf8").split("\n");
    lines.pop();
    const first = lines.shift();
    let header: z.infer<typeof Header>;
    try {
      header = Header.parse(JSON.parse(first ?? ""));
    } catch (error) {
      throw new Error(`meta join header is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (header.configHash !== configHash) throw new Error(`meta join belongs to foreign campaign config ${header.configHash}`);
    const fd = openSync(file, "a", 0o600);
    const store = new MetaJoinStoreV1(file, configHash, fd);
    try {
      for (let index = 0; index < lines.length; index += 1) {
        let line: JoinLine;
        try {
          line = JoinLine.parse(JSON.parse(lines[index] ?? ""));
        } catch (error) {
          throw new Error(`meta join is corrupt at line ${index + 2}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (line.seq !== store.nextSeq) throw new Error(`meta join sequence discontinuity at ${line.seq}; expected ${store.nextSeq}`);
        store.apply(line);
        store.nextSeq += 1;
      }
      return store;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  ensureCandidate(
    identityInput: MetaArtifactIdentity,
    transformationReceiptHashInput: Sha256Digest | null,
    mintEpoch: () => string,
  ): string {
    this.assertOpen();
    const sourceArtifact = DIGEST.parse(identityInput.sourceArtifact);
    const bundleDigest = DIGEST.parse(identityInput.bundleDigest);
    const transformationReceiptHash = transformationReceiptHashInput === null ? null : DIGEST.parse(transformationReceiptHashInput);
    const key = canonicalJson({ sourceArtifact, bundleDigest });
    const prior = this.candidatesByIdentity.get(key);
    if (prior !== undefined) {
      if (prior.transformationReceiptHash !== transformationReceiptHash) {
        throw new Error(`candidate identity ${key} was admitted under a different gate mode or transformation receipt`);
      }
      return prior.measurementEpoch;
    }
    const line = CandidateLine.parse({
      v: 1,
      t: "candidate",
      seq: this.nextSeq,
      sourceArtifact,
      bundleDigest,
      transformationReceiptHash,
      measurementEpoch: SAFE_ID.parse(mintEpoch()),
    });
    this.append(line);
    this.candidatesByIdentity.set(key, line);
    return line.measurementEpoch;
  }

  receipt(reservation: MetaReservation): boolean {
    this.assertOpen();
    const prior = this.receipts.get(reservation.workKey);
    const candidate = ReceiptLine.parse({
      v: 1,
      t: "receipt",
      seq: this.nextSeq,
      workKey: reservation.workKey,
      childRunId: reservation.childRunId,
      identity: reservation.identity,
      reserved: reservation.reserved,
    });
    if (prior !== undefined) {
      if (!same({ ...prior, seq: 0 }, { ...candidate, seq: 0 })) throw new Error(`conflicting child receipt ${reservation.workKey}`);
      return true;
    }
    this.append(candidate);
    this.receipts.set(reservation.workKey, candidate);
    return false;
  }

  completion(workKey: string): StoredCompletion | undefined {
    const found = this.completions.get(workKey);
    return found === undefined
      ? undefined
      : { evidence: structuredClone(found.evidence), outcome: structuredClone(found.outcome), qRaw: found.qRaw };
  }

  failure(workKey: string): StoredFailure | undefined {
    const found = this.failures.get(workKey);
    return found === undefined
      ? undefined
      : {
          evidence: structuredClone(found.evidence),
          outcome: structuredClone(found.outcome),
          attempt: found.attempt,
          terminal: found.terminal,
          reason: found.reason,
        };
  }

  retryStarted(workKey: string): boolean {
    return this.retries.has(workKey);
  }

  startRetry(workKeyInput: string, remainingBudget: BudgetEnvelope): void {
    this.assertOpen();
    const workKey = DIGEST.parse(workKeyInput);
    const prior = this.retries.get(workKey);
    const line = RetryLine.parse({ v: 1, t: "retry", seq: this.nextSeq, workKey, attempt: 1, remainingBudget });
    if (prior !== undefined) {
      if (!same({ ...prior, seq: 0 }, { ...line, seq: 0 })) throw new Error(`conflicting retry receipt ${workKey}`);
      return;
    }
    const failure = this.failures.get(workKey);
    if (failure === undefined || failure.terminal || failure.outcome.status !== "infrastructure_not_run") {
      throw new Error(`retry requires a nonterminal infrastructure outcome for ${workKey}`);
    }
    if (this.completions.has(workKey)) throw new Error(`completed child cannot retry ${workKey}`);
    this.append(line);
    this.retries.set(workKey, line);
  }

  recordCompletion(workKeyInput: string, completion: StoredCompletion): void {
    this.assertOpen();
    const workKey = DIGEST.parse(workKeyInput);
    const line = CompletionLine.parse({ v: 1, t: "completion", seq: this.nextSeq, workKey, ...completion });
    const prior = this.completions.get(workKey);
    if (prior !== undefined) {
      if (!same(prior, completion)) throw new Error(`conflicting child completion ${workKey}`);
      return;
    }
    const failure = this.failures.get(workKey);
    if (failure?.terminal === true) throw new Error(`terminal child failure already recorded for ${workKey}`);
    this.append(line);
    this.completions.set(workKey, structuredClone(completion));
  }

  recordFailure(workKeyInput: string, failure: StoredFailure): void {
    this.assertOpen();
    const workKey = DIGEST.parse(workKeyInput);
    const line = FailureLine.parse({
      v: 1,
      t: "failure",
      seq: this.nextSeq,
      workKey,
      evidence: failure.evidence,
      outcome: failure.outcome,
      attempt: failure.attempt,
      terminal: failure.terminal,
      reason: failure.reason.slice(0, 4_096),
    });
    const prior = this.failures.get(workKey);
    if (prior !== undefined && prior.attempt === line.attempt) {
      if (!same({ ...prior, seq: 0 }, { ...line, seq: 0 })) throw new Error(`conflicting child failure ${workKey}`);
      return;
    }
    if (prior?.terminal === true || this.completions.has(workKey)) throw new Error(`child already terminal for ${workKey}`);
    if (line.attempt === 1 && !this.retries.has(workKey)) throw new Error(`retry outcome lacks retry receipt ${workKey}`);
    if (!line.terminal && (line.attempt !== 0 || line.outcome.status !== "infrastructure_not_run")) {
      throw new Error("only the first infrastructure outcome may remain retryable");
    }
    this.append(line);
    this.failures.set(workKey, line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  private apply(line: JoinLine): void {
    switch (line.t) {
      case "candidate": {
        const key = canonicalJson({ sourceArtifact: line.sourceArtifact, bundleDigest: line.bundleDigest });
        if (this.candidatesByIdentity.has(key)) throw new Error(`duplicate candidate identity ${key}`);
        this.candidatesByIdentity.set(key, line);
        break;
      }
      case "receipt":
        if (this.receipts.has(line.workKey)) throw new Error(`duplicate child receipt ${line.workKey}`);
        this.receipts.set(line.workKey, line);
        break;
      case "retry": {
        const failure = this.failures.get(line.workKey);
        const receipt = this.receipts.get(line.workKey);
        if (receipt === undefined || failure === undefined || failure.terminal || failure.outcome.status !== "infrastructure_not_run") {
          throw new Error(`retry without retryable infrastructure outcome ${line.workKey}`);
        }
        if (!same(line.remainingBudget, remainingChildBudget(receipt.reserved, failure.evidence.spend))) {
          throw new Error(`retry receipt renews or corrupts the remaining child budget ${line.workKey}`);
        }
        if (this.retries.has(line.workKey)) throw new Error(`duplicate retry receipt ${line.workKey}`);
        this.retries.set(line.workKey, line);
        break;
      }
      case "completion": {
        if (!this.receipts.has(line.workKey)) throw new Error(`completion without receipt ${line.workKey}`);
        if (this.completions.has(line.workKey) || this.failures.get(line.workKey)?.terminal === true) {
          throw new Error(`duplicate terminal child state ${line.workKey}`);
        }
        this.completions.set(line.workKey, { evidence: line.evidence, outcome: line.outcome, qRaw: line.qRaw });
        break;
      }
      case "failure": {
        if (!this.receipts.has(line.workKey)) throw new Error(`failure without receipt ${line.workKey}`);
        const prior = this.failures.get(line.workKey);
        if (prior?.terminal === true || prior?.attempt === line.attempt || this.completions.has(line.workKey)) {
          throw new Error(`duplicate child outcome ${line.workKey}`);
        }
        if (line.attempt === 1 && !this.retries.has(line.workKey)) throw new Error(`retry outcome without retry receipt ${line.workKey}`);
        if (!line.terminal && (line.attempt !== 0 || line.outcome.status !== "infrastructure_not_run")) {
          throw new Error("invalid nonterminal child outcome");
        }
        this.failures.set(line.workKey, line);
        break;
      }
    }
  }

  private append(line: JoinLine): void {
    writeAll(this.fd, Buffer.from(`${JSON.stringify(line)}\n`));
    fsyncSync(this.fd);
    this.nextSeq += 1;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("meta join is closed");
  }
}

interface ChildResult {
  capsuleId: string;
  replicate: number;
  status: MetaChildStatus;
  measurement: MetaMeasurement | null;
  failureSettlement: MetaFailureSettlement | null;
  observed: MetaResourceUsage;
  feedback: string;
  valid: boolean;
}

export interface MetaSearchEvaluationInput {
  sourceArtifact: Sha256Digest;
  outerCapsuleId: string;
  assetGroupId: string;
  seed: number;
}

export interface MetaConfirmationArtifacts {
  seed: MetaArtifactIdentity;
  winner: MetaArtifactIdentity;
  brokenControl: MetaTrustedControlArtifact;
  degradedControl: MetaTrustedControlArtifact;
}

export interface MetaTerminalHoldoutArtifacts {
  seed: MetaArtifactIdentity;
  winner: MetaArtifactIdentity;
}

export interface MetaRecursiveConfirmationArtifacts {
  target: MetaArtifactIdentity;
  controlControllerWinner: MetaArtifactIdentity;
  generation2: MetaArtifactIdentity;
  brokenControl: MetaTrustedControlArtifact;
  degradedControl: MetaTrustedControlArtifact;
}

export interface MetaRecursiveTerminalArtifacts {
  generation0: MetaArtifactIdentity;
  generation1: MetaArtifactIdentity;
  generation2: MetaArtifactIdentity;
}

export interface MetaPhaseResult {
  phase: "confirmation" | "holdout";
  measurements: readonly MetaMeasurement[];
}

export interface MetaCampaignRunnerOptions {
  config: MetaCampaignConfig;
  journal: MetaJournalPort;
  joinPath: string;
  candidateGate: MetaCandidateGate;
  childSupervisor: MetaChildSupervisor;
  now?: () => Date;
  mintMeasurementEpoch?: () => string;
  childConcurrency?: number;
}

interface ChildWorkItem extends MetaArtifactIdentity {
  phase: MetaPhase;
  arm: MetaArm;
  capsule: MetaCampaignConfig["train"][number] | MetaCampaignConfig["holdout"][number];
  replicate: number;
  measurementEpoch: string;
  transformationReceiptHash: Sha256Digest | null;
}

interface TrustedPhaseArm {
  readonly arm: Exclude<MetaArm, "candidate">;
  readonly artifact: MetaArtifactIdentity;
  readonly gateRequest: MetaCandidateGateRequest;
}

/** Trusted M1 outer evaluator. Holdout execution is available only through the separate terminal method. */
export class MetaCampaignRunner {
  readonly config: MetaCampaignConfig;
  readonly joins: MetaJoinStoreV1;
  private readonly now: () => Date;
  private readonly mintMeasurementEpoch: () => string;
  private readonly childConcurrency: number;
  private readonly searchInFlight = new Map<string, Promise<ChildResult[]>>();

  constructor(private readonly opts: MetaCampaignRunnerOptions) {
    this.config = MetaCampaignConfigSchema.parse(opts.config);
    if (opts.journal.configHash !== metaCampaignConfigHash(this.config)) {
      throw new Error(`meta journal config hash ${opts.journal.configHash} does not match campaign`);
    }
    this.joins = MetaJoinStoreV1.open(opts.joinPath, opts.journal.configHash);
    this.now = opts.now ?? (() => new Date());
    this.mintMeasurementEpoch = opts.mintMeasurementEpoch ?? (() => `${this.config.measurementEpochNamespace}:${randomUUID()}`);
    this.childConcurrency = opts.childConcurrency ?? this.config.counts.childConcurrency;
    if (!Number.isInteger(this.childConcurrency) || this.childConcurrency <= 0 || this.childConcurrency > this.config.counts.childConcurrency) {
      throw new Error(`child concurrency must be in [1, ${this.config.counts.childConcurrency}]`);
    }
  }

  async evaluateSearchCandidate(input: MetaSearchEvaluationInput): Promise<EvaluationRecord> {
    const sourceArtifact = DIGEST.parse(input.sourceArtifact);
    const started = this.now().getTime();
    let gate: CandidateGateResult;
    try {
      gate = await this.opts.candidateGate.check({ mode: "public-mutable", sourceArtifact });
    } catch (error) {
      gate = { ok: false, feedback: `conformance gate failed closed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!gate.ok) return this.invalidRecord(input, gate.feedback, started);
    this.validateGateResult({ mode: "public-mutable", sourceArtifact }, gate);
    const artifact: MetaArtifactIdentity = { sourceArtifact, bundleDigest: gate.bundleDigest };
    const candidateEpoch = this.joins.ensureCandidate(artifact, gate.transformationReceiptHash, this.mintMeasurementEpoch);
    const work = this.config.train.flatMap((capsule) =>
      Array.from({ length: this.config.counts.searchReplicates }, (_, replicate): ChildWorkItem => ({
        phase: "search",
        arm: "candidate",
        ...artifact,
        transformationReceiptHash: gate.transformationReceiptHash,
        capsule,
        replicate,
        measurementEpoch: childMeasurementEpoch(candidateEpoch, "search", "candidate", capsule.capsuleId, replicate),
      })),
    );
    const inFlightKey = canonicalJson(artifact);
    const existing = this.searchInFlight.get(inFlightKey);
    const pending = existing ?? mapBounded(work, this.childConcurrency, (item) => this.executeChild(item));
    if (existing === undefined) this.searchInFlight.set(inFlightKey, pending);
    let results: ChildResult[];
    try {
      results = await pending;
    } finally {
      if (existing === undefined && this.searchInFlight.get(inFlightKey) === pending) this.searchInFlight.delete(inFlightKey);
    }
    if (results.length !== this.config.train.length * this.config.counts.searchReplicates) {
      throw new Error("meta runner internal cardinality error");
    }
    const failures = results.filter((result) => result.status !== "completed" || !result.valid || result.measurement === null);
    if (failures.length > 0) {
      const infrastructure = failures.some((failure) => failure.status === "infrastructure_not_run");
      const summary = failures
        .map((failure) => `${failure.capsuleId}[${failure.replicate}]=${failure.status}: ${bounded(failure.feedback)}`)
        .join("; ");
      return this.invalidRecord(
        input,
        `${infrastructure ? "infrastructure not_run" : "candidate invalid"}; ${summary}`,
        started,
        results,
      );
    }

    const perExample: Record<string, { score: number; feedback: string }> = {};
    const capsuleMeans: number[] = [];
    for (const capsule of this.config.train) {
      const rows = results.filter((result) => result.capsuleId === capsule.capsuleId);
      if (rows.length !== this.config.counts.searchReplicates) throw new Error(`missing search replicate for ${capsule.capsuleId}`);
      const scores = rows.map((row) => {
        if (row.measurement === null) throw new Error(`missing completed measurement for ${row.capsuleId}`);
        return row.measurement.qNormalized;
      });
      const score = mean(scores);
      capsuleMeans.push(score);
      perExample[capsule.capsuleId] = {
        score,
        feedback: bounded(`${capsule.capsuleId}: normalized gain ${score}; ${rows.map((row) => row.feedback).join(" | ")}`),
      };
    }
    const normalizedGain = mean(capsuleMeans);
    return EvaluationRecord.parse({
      capsuleId: input.outerCapsuleId,
      artifactHash: sourceArtifact,
      assetGroupId: input.assetGroupId,
      seed: input.seed,
      output: {
        valid: true,
        objectives: { normalizedGain },
        constraints: { complete: true, allChildrenValid: true },
        perExample,
        diagnostics: { summary: bounded(`train-only meta evaluation completed; ${gate.feedback}`) },
      },
      costUsd: results.reduce((sum, result) => sum + result.observed.usd, 0),
      durationMs: Math.max(0, this.now().getTime() - started),
      cached: false,
      evaluatedAt: this.now().toISOString(),
    });
  }

  async runConfirmation(artifacts: MetaConfirmationArtifacts): Promise<MetaPhaseResult> {
    this.assertRegisteredPair("confirmation seed", artifacts.seed, {
      sourceArtifact: this.config.seedOptimizer.sourceArtifact as Sha256Digest,
      bundleDigest: this.config.seedOptimizer.bundleDigest as Sha256Digest,
    });
    this.assertRegisteredPair("confirmation broken control", artifacts.brokenControl, {
      sourceArtifact: this.config.controls.brokenSourceArtifact as Sha256Digest,
      bundleDigest: this.config.controls.brokenBundleDigest as Sha256Digest,
    });
    this.assertRegisteredPair("confirmation degraded control", artifacts.degradedControl, {
      sourceArtifact: this.config.controls.degradedSourceArtifact as Sha256Digest,
      bundleDigest: this.config.controls.degradedBundleDigest as Sha256Digest,
    });
    this.validateControlReceipt("broken", artifacts.brokenControl);
    this.validateControlReceipt("degraded", artifacts.degradedControl);
    const arms: readonly TrustedPhaseArm[] = [
      { arm: "seed", artifact: artifacts.seed, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.seed.sourceArtifact } },
      { arm: "winner", artifact: artifacts.winner, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.winner.sourceArtifact } },
      {
        arm: "broken-control",
        artifact: artifacts.brokenControl,
        gateRequest: {
          mode: "trusted-control",
          sourceArtifact: artifacts.brokenControl.sourceArtifact,
          bundleDigest: artifacts.brokenControl.bundleDigest,
          transformationReceipt: artifacts.brokenControl.transformationReceipt,
        },
      },
      {
        arm: "degraded-control",
        artifact: artifacts.degradedControl,
        gateRequest: {
          mode: "trusted-control",
          sourceArtifact: artifacts.degradedControl.sourceArtifact,
          bundleDigest: artifacts.degradedControl.bundleDigest,
          transformationReceipt: artifacts.degradedControl.transformationReceipt,
        },
      },
    ];
    return {
      phase: "confirmation",
      measurements: await this.runTrustedPhase("confirmation", this.config.train, this.config.counts.confirmationReplicates, arms),
    };
  }

  async runTerminalHoldout(artifacts: MetaTerminalHoldoutArtifacts): Promise<MetaPhaseResult> {
    this.assertRegisteredPair("holdout seed", artifacts.seed, {
      sourceArtifact: this.config.seedOptimizer.sourceArtifact as Sha256Digest,
      bundleDigest: this.config.seedOptimizer.bundleDigest as Sha256Digest,
    });
    this.opts.journal.latchTerminalHoldout();
    const arms: readonly TrustedPhaseArm[] = [
      { arm: "seed", artifact: artifacts.seed, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.seed.sourceArtifact } },
      { arm: "winner", artifact: artifacts.winner, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.winner.sourceArtifact } },
    ];
    return {
      phase: "holdout",
      measurements: await this.runTrustedPhase("holdout", this.config.holdout, this.config.counts.holdoutReplicates, arms),
    };
  }

  async runRecursiveConfirmation(artifacts: MetaRecursiveConfirmationArtifacts): Promise<MetaPhaseResult> {
    if (this.config.version !== 2 || this.config.generation.stage !== "B") {
      throw new Error("recursive confirmation requires a stage-B M2 campaign");
    }
    this.assertRegisteredPair("recursive confirmation target", artifacts.target, {
      sourceArtifact: this.config.seedOptimizer.sourceArtifact as Sha256Digest,
      bundleDigest: this.config.seedOptimizer.bundleDigest as Sha256Digest,
    });
    this.assertRegisteredPair("recursive confirmation broken control", artifacts.brokenControl, {
      sourceArtifact: this.config.controls.brokenSourceArtifact as Sha256Digest,
      bundleDigest: this.config.controls.brokenBundleDigest as Sha256Digest,
    });
    this.assertRegisteredPair("recursive confirmation degraded control", artifacts.degradedControl, {
      sourceArtifact: this.config.controls.degradedSourceArtifact as Sha256Digest,
      bundleDigest: this.config.controls.degradedBundleDigest as Sha256Digest,
    });
    this.validateControlReceipt("broken", artifacts.brokenControl);
    this.validateControlReceipt("degraded", artifacts.degradedControl);
    const arms: readonly TrustedPhaseArm[] = [
      { arm: "seed", artifact: artifacts.target, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.target.sourceArtifact } },
      {
        arm: "controller-control-winner",
        artifact: artifacts.controlControllerWinner,
        gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.controlControllerWinner.sourceArtifact },
      },
      { arm: "generation-2", artifact: artifacts.generation2, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.generation2.sourceArtifact } },
      {
        arm: "broken-control",
        artifact: artifacts.brokenControl,
        gateRequest: {
          mode: "trusted-control",
          sourceArtifact: artifacts.brokenControl.sourceArtifact,
          bundleDigest: artifacts.brokenControl.bundleDigest,
          transformationReceipt: artifacts.brokenControl.transformationReceipt,
        },
      },
      {
        arm: "degraded-control",
        artifact: artifacts.degradedControl,
        gateRequest: {
          mode: "trusted-control",
          sourceArtifact: artifacts.degradedControl.sourceArtifact,
          bundleDigest: artifacts.degradedControl.bundleDigest,
          transformationReceipt: artifacts.degradedControl.transformationReceipt,
        },
      },
    ];
    return {
      phase: "confirmation",
      measurements: await this.runTrustedPhase("confirmation", this.config.train, this.config.counts.confirmationReplicates, arms),
    };
  }

  async runRecursiveTerminal(artifacts: MetaRecursiveTerminalArtifacts): Promise<MetaPhaseResult> {
    if (this.config.version !== 2) throw new Error("recursive terminal requires an M2 campaign");
    this.assertRegisteredPair("recursive terminal G1", artifacts.generation1, {
      sourceArtifact: this.config.seedOptimizer.sourceArtifact as Sha256Digest,
      bundleDigest: this.config.seedOptimizer.bundleDigest as Sha256Digest,
    });
    this.opts.journal.latchTerminalHoldout();
    const arms: readonly TrustedPhaseArm[] = [
      { arm: "generation-0", artifact: artifacts.generation0, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.generation0.sourceArtifact } },
      { arm: "generation-1", artifact: artifacts.generation1, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.generation1.sourceArtifact } },
      { arm: "generation-2", artifact: artifacts.generation2, gateRequest: { mode: "public-mutable", sourceArtifact: artifacts.generation2.sourceArtifact } },
    ];
    return {
      phase: "holdout",
      measurements: await this.runTrustedPhase("holdout", this.config.holdout, this.config.counts.holdoutReplicates, arms),
    };
  }

  close(): void {
    this.joins.close();
  }

  private async runTrustedPhase(
    phase: "confirmation" | "holdout",
    capsules: MetaCampaignConfig["train"] | MetaCampaignConfig["holdout"],
    replicates: number,
    arms: readonly TrustedPhaseArm[],
  ): Promise<MetaMeasurement[]> {
    const gated = await Promise.all(arms.map(async ({ arm, artifact, gateRequest }) => {
      const gate = await this.opts.candidateGate.check(gateRequest);
      if (!gate.ok) throw new Error(`${phase} ${arm} failed conformance: ${bounded(gate.feedback)}`);
      this.validateGateResult(gateRequest, gate);
      this.assertRegisteredPair(`${phase} ${arm} gate`, gate, artifact);
      const candidateEpoch = this.joins.ensureCandidate(artifact, gate.transformationReceiptHash, this.mintMeasurementEpoch);
      return { arm, ...artifact, transformationReceiptHash: gate.transformationReceiptHash, candidateEpoch };
    }));
    const work = gated.flatMap((candidate) => capsules.flatMap((capsule) =>
      Array.from({ length: replicates }, (_, replicate): ChildWorkItem => ({
        phase,
        arm: candidate.arm,
        sourceArtifact: candidate.sourceArtifact,
        bundleDigest: candidate.bundleDigest,
        transformationReceiptHash: candidate.transformationReceiptHash,
        capsule,
        replicate,
        measurementEpoch: trustedPhaseMeasurementEpoch(this.opts.journal.configHash, phase, capsule.capsuleId, replicate),
      })),
    ));
    const results = await mapBounded(work, this.childConcurrency, (item) => this.executeChild(item));
    const failed = results.find((result) => result.status !== "completed" || !result.valid || result.measurement === null);
    if (failed !== undefined) {
      throw new Error(`${phase} failed closed at ${failed.capsuleId}[${failed.replicate}]: ${failed.status}: ${bounded(failed.feedback)}`);
    }
    return results.map((result) => {
      if (result.measurement === null) throw new Error(`missing ${phase} measurement`);
      return result.measurement;
    });
  }

  private async executeChild(item: ChildWorkItem): Promise<ChildResult> {
    const identity: MetaWorkIdentity = {
      phase: item.phase,
      arm: item.arm,
      sourceArtifact: item.sourceArtifact,
      bundleDigest: item.bundleDigest,
      capsuleId: item.capsule.capsuleId,
      replicate: item.replicate,
      measurementEpoch: item.measurementEpoch,
    };
    const reservation = this.opts.journal.reserveChild(identity);
    const receiptExisted = this.joins.receipt(reservation);
    const stored = this.joins.completion(reservation.workKey);
    if (stored !== undefined) return this.settleStored(identity, stored);
    const priorFailure = this.joins.failure(reservation.workKey);
    if (priorFailure?.terminal === true) return this.settleFailureStored(identity, priorFailure);

    const attempt: 0 | 1 = priorFailure === undefined ? 0 : 1;
    const priorObserved = priorFailure?.evidence.spend ?? ZERO_USAGE;
    const remainingBudget = remainingChildBudget(reservation.reserved, priorObserved);
    if (attempt === 1 && !this.joins.retryStarted(reservation.workKey)) {
      this.joins.startRetry(reservation.workKey, remainingBudget);
    }

    let outcome: MetaChildRunOutcome;
    try {
      outcome = await this.opts.childSupervisor.run({
        identity,
        reservation,
        sourceArtifact: item.sourceArtifact,
        bundleDigest: item.bundleDigest,
        capsule: item.capsule,
        innerEpisodesMax: this.config.counts.innerEpisodesMax,
        requestedModel: this.config.routing.innerMutation,
        remainingBudget,
        attempt,
        resume: receiptExisted || attempt === 1,
      });
    } catch (error) {
      outcome = infrastructureOutcome(
        item,
        reservation,
        priorFailure?.outcome,
        `child supervisor infrastructure not_run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let reason = validateOutcomeIdentity(outcome, item, reservation);
    const parsedSpend = ResourceUsage.safeParse(outcome.spend);
    if (!parsedSpend.success) reason = reason ?? `invalid child spend: ${parsedSpend.error.message}`;
    if (reason === null) reason = validateFinalEvaluationHash(outcome);
    const spend = parsedSpend.success ? parsedSpend.data : priorObserved;
    if (reason === null) reason = validateCumulativeSpend(priorObserved, spend, reservation.reserved);
    if (reason !== null) {
      outcome = { ...outcome, status: "candidate_failed", spend, feedback: reason };
      return this.recordFailure(identity, item, reservation, outcome, attempt, true, reason);
    }

    if (outcome.status === "infrastructure_not_run") {
      const terminal = attempt === 1;
      const infrastructureReason = bounded(outcome.feedback || "child did not run because trusted infrastructure failed");
      return this.recordFailure(identity, item, reservation, { ...outcome, spend }, attempt, terminal, infrastructureReason);
    }
    if (outcome.status === "candidate_failed" || outcome.status === "budget") {
      const failureReason = bounded(outcome.feedback || `child terminated ${outcome.status}`);
      return this.recordFailure(identity, item, reservation, { ...outcome, spend }, attempt, true, failureReason);
    }

    let completion: StoredCompletion;
    try {
      completion = buildCompletion(this.opts.journal.configHash, item, reservation, { ...outcome, spend }, attempt);
    } catch (error) {
      const failureReason = `invalid child evidence: ${error instanceof Error ? error.message : String(error)}`;
      const failedOutcome: MetaChildRunOutcome = { ...outcome, status: "candidate_failed", spend, feedback: failureReason };
      return this.recordFailure(identity, item, reservation, failedOutcome, attempt, true, failureReason);
    }
    this.joins.recordCompletion(reservation.workKey, completion);
    return this.settleStored(identity, completion);
  }

  private recordFailure(
    identity: MetaWorkIdentity,
    item: ChildWorkItem,
    reservation: MetaReservation,
    outcome: MetaChildRunOutcome,
    attempt: 0 | 1,
    terminal: boolean,
    reason: string,
  ): ChildResult {
    const failure: StoredFailure = {
      evidence: buildEvidence(this.opts.journal.configHash, item, reservation, outcome, attempt),
      outcome,
      attempt,
      terminal,
      reason,
    };
    this.joins.recordFailure(reservation.workKey, failure);
    if (terminal) return this.settleFailureStored(identity, failure);
    return {
      capsuleId: identity.capsuleId,
      replicate: identity.replicate,
      status: outcome.status,
      measurement: null,
      failureSettlement: null,
      observed: { ...failure.evidence.spend },
      feedback: bounded(reason),
      valid: false,
    };
  }

  private settleStored(identity: MetaWorkIdentity, stored: StoredCompletion): ChildResult {
    const outcome = stored.outcome;
    const measurement = this.opts.journal.settleChild(identity, {
      evidenceHash: metaEvidenceHash(stored.evidence),
      observed: stored.evidence.spend,
      qRaw: stored.qRaw,
      responseModel: requireString(outcome.responseModel, "response model"),
      providerFingerprint: outcome.providerFingerprint,
      modelDriftSentinel: requireString(outcome.modelDriftSentinel, "model drift sentinel"),
    });
    const expected = (stored.qRaw - measurement.qBase) / measurement.scale;
    if (!Number.isFinite(measurement.qNormalized) || Math.abs(measurement.qNormalized - expected) > 1e-12 * Math.max(1, Math.abs(expected))) {
      throw new Error(`journal normalization mismatch for ${measurement.workKey}`);
    }
    return {
      capsuleId: identity.capsuleId,
      replicate: identity.replicate,
      status: "completed",
      measurement,
      failureSettlement: null,
      observed: { ...stored.evidence.spend },
      feedback: bounded(outcome.feedback),
      valid: true,
    };
  }

  private settleFailureStored(identity: MetaWorkIdentity, stored: StoredFailure): ChildResult {
    if (!stored.terminal || stored.outcome.status === "completed") throw new Error("cannot settle a nonterminal or completed failure");
    const status = stored.outcome.status;
    const settlement = this.opts.journal.settleChildFailure(identity, {
      evidenceHash: metaEvidenceHash(stored.evidence),
      observed: stored.evidence.spend,
      status,
    });
    return {
      capsuleId: identity.capsuleId,
      replicate: identity.replicate,
      status,
      measurement: null,
      failureSettlement: settlement,
      observed: { ...stored.evidence.spend },
      feedback: bounded(stored.reason),
      valid: false,
    };
  }

  private validateGateResult(request: MetaCandidateGateRequest, gate: CandidateGateAccepted): void {
    if (gate.sourceArtifact !== request.sourceArtifact) {
      throw new Error(`gate source artifact ${gate.sourceArtifact} does not match requested ${request.sourceArtifact}`);
    }
    if (request.mode === "public-mutable") {
      if (gate.transformationReceiptHash !== null) throw new Error("public mutable gate returned a trusted-control receipt");
      return;
    }
    if (gate.bundleDigest !== request.bundleDigest) {
      throw new Error(`trusted-control gate bundle ${gate.bundleDigest} does not match registered ${request.bundleDigest}`);
    }
    const expectedReceiptHash = sha256(canonicalJson(request.transformationReceipt));
    if (gate.transformationReceiptHash !== expectedReceiptHash) {
      throw new Error(`trusted-control gate receipt ${gate.transformationReceiptHash ?? "null"} does not match exact ${expectedReceiptHash}`);
    }
  }

  private validateControlReceipt(kind: "broken" | "degraded", artifact: MetaTrustedControlArtifact): void {
    const receipt = ControlReceipt.parse(artifact.transformationReceipt);
    const expectedTransformation = kind === "broken" ? "broken-no-candidate-v1" : "degraded-blind-restart-v1";
    if (
      receipt.kind !== kind ||
      receipt.transformation !== expectedTransformation ||
      receipt.artifactDigest !== artifact.sourceArtifact
    ) {
      throw new Error(`${kind} control transformation receipt does not bind its exact registered source artifact`);
    }
  }

  private assertRegisteredPair(label: string, actual: MetaArtifactIdentity, expected: MetaArtifactIdentity): void {
    if (actual.sourceArtifact !== expected.sourceArtifact) {
      throw new Error(`${label} source artifact ${actual.sourceArtifact} does not match registered ${expected.sourceArtifact}`);
    }
    if (actual.bundleDigest !== expected.bundleDigest) {
      throw new Error(`${label} bundle digest ${actual.bundleDigest} does not match registered ${expected.bundleDigest}`);
    }
  }

  private invalidRecord(
    input: MetaSearchEvaluationInput,
    summary: string,
    started: number,
    results: readonly ChildResult[] = [],
  ): EvaluationRecord {
    const perExample: Record<string, { score: number; feedback: string }> = {};
    for (const result of results) {
      if (result.measurement === null || perExample[result.capsuleId] !== undefined) continue;
      perExample[result.capsuleId] = { score: result.measurement.qNormalized, feedback: bounded(result.feedback) };
    }
    return EvaluationRecord.parse({
      capsuleId: input.outerCapsuleId,
      artifactHash: input.sourceArtifact,
      assetGroupId: input.assetGroupId,
      seed: input.seed,
      output: {
        valid: false,
        objectives: {},
        constraints: { complete: false },
        perExample,
        diagnostics: { summary: bounded(summary) },
      },
      costUsd: results.reduce((sum, result) => sum + result.observed.usd, 0),
      durationMs: Math.max(0, this.now().getTime() - started),
      cached: false,
      evaluatedAt: this.now().toISOString(),
    });
  }
}

const ZERO_USAGE: Readonly<MetaResourceUsage> = {
  tokens: 0,
  usd: 0,
  wallClockSec: 0,
  evaluatorInvocations: 0,
};

function validateOutcomeIdentity(
  outcome: MetaChildRunOutcome,
  item: ChildWorkItem,
  reservation: MetaReservation,
): string | null {
  if (outcome.childRunId !== reservation.childRunId) return `child run id mismatch: ${outcome.childRunId}`;
  if (outcome.measurementEpoch !== item.measurementEpoch) return `measurement epoch mismatch: ${outcome.measurementEpoch}`;
  if (outcome.capsuleId !== item.capsule.capsuleId) return `capsule id mismatch: ${outcome.capsuleId}`;
  if (outcome.sourceArtifact !== item.sourceArtifact) return `source artifact mismatch: ${outcome.sourceArtifact}`;
  if (outcome.bundleDigest !== item.bundleDigest) return `bundle digest mismatch: ${outcome.bundleDigest}`;
  return null;
}

function validateFinalEvaluationHash(outcome: MetaChildRunOutcome): string | null {
  if (outcome.finalEvaluation === null) return null;
  const parsed = EvaluationRecord.safeParse(outcome.finalEvaluation);
  if (!parsed.success) return `invalid final evaluation: ${parsed.error.message}`;
  const calculated = sha256(canonicalJson(parsed.data));
  return outcome.finalEvaluationHash === calculated
    ? null
    : `final evaluation hash ${outcome.finalEvaluationHash ?? "null"} does not match ${calculated}`;
}

function validateCumulativeSpend(
  previous: MetaResourceUsage,
  current: MetaResourceUsage,
  reserved: BudgetEnvelope,
): string | null {
  if (
    current.tokens < previous.tokens ||
    current.usd < previous.usd ||
    current.wallClockSec < previous.wallClockSec ||
    current.evaluatorInvocations < previous.evaluatorInvocations
  ) {
    return "child cumulative spend decreased across attempts";
  }
  if (current.tokens > reserved.maxTokens) return "child spend exceeds reserved maxTokens";
  if (current.usd > reserved.maxUsd) return "child spend exceeds reserved maxUsd";
  if (current.wallClockSec > reserved.maxWallClockSec) return "child spend exceeds reserved maxWallClockSec";
  if (current.evaluatorInvocations > reserved.maxEvaluatorInvocations) {
    return "child spend exceeds reserved maxEvaluatorInvocations";
  }
  return null;
}

function remainingChildBudget(reserved: BudgetEnvelope, observed: MetaResourceUsage): BudgetEnvelope {
  return {
    maxTokens: Math.max(0, reserved.maxTokens - observed.tokens),
    maxUsd: Math.max(0, reserved.maxUsd - observed.usd),
    maxWallClockSec: Math.max(0, reserved.maxWallClockSec - observed.wallClockSec),
    maxEvaluatorInvocations: Math.max(0, reserved.maxEvaluatorInvocations - observed.evaluatorInvocations),
  };
}

function infrastructureOutcome(
  item: ChildWorkItem,
  reservation: MetaReservation,
  previous: MetaChildRunOutcome | undefined,
  feedback: string,
): MetaChildRunOutcome {
  return {
    status: "infrastructure_not_run",
    childRunId: reservation.childRunId,
    measurementEpoch: item.measurementEpoch,
    capsuleId: item.capsule.capsuleId,
    sourceArtifact: item.sourceArtifact,
    bundleDigest: item.bundleDigest,
    runtimeBundleDigest: previous?.runtimeBundleDigest ?? null,
    baselineArtifactHash: previous?.baselineArtifactHash ?? null,
    bestArtifactHash: previous?.bestArtifactHash ?? null,
    finalEvaluation: previous?.finalEvaluation ?? null,
    finalEvaluationHash: previous?.finalEvaluationHash ?? null,
    spend: previous?.spend ?? { ...ZERO_USAGE },
    eventLogHash: previous?.eventLogHash ?? null,
    eventLogCursor: previous?.eventLogCursor ?? null,
    proxyTraceHash: previous?.proxyTraceHash ?? null,
    brokerJournalHash: previous?.brokerJournalHash ?? null,
    responseModel: previous?.responseModel ?? null,
    providerFingerprint: previous?.providerFingerprint ?? null,
    modelDriftSentinel: previous?.modelDriftSentinel ?? null,
    feedback: bounded(feedback),
  };
}

function buildEvidence(
  configHash: Sha256Digest,
  item: ChildWorkItem,
  reservation: MetaReservation,
  outcome: MetaChildRunOutcome,
  attempt: 0 | 1,
): MetaChildEvidenceV1 {
  const finalEvaluationHash = outcome.finalEvaluation === null
    ? outcome.finalEvaluationHash
    : sha256(canonicalJson(EvaluationRecord.parse(outcome.finalEvaluation)));
  return Evidence.parse({
    version: 1,
    configHash,
    workKey: reservation.workKey,
    childRunId: reservation.childRunId,
    phase: item.phase,
    arm: item.arm,
    sourceArtifact: item.sourceArtifact,
    bundleDigest: item.bundleDigest,
    capsuleId: item.capsule.capsuleId,
    capsuleDigest: item.capsule.capsuleDigest,
    replicate: item.replicate,
    measurementEpoch: item.measurementEpoch,
    transformationReceiptHash: item.transformationReceiptHash,
    runtimeBundleDigest: outcome.runtimeBundleDigest,
    attempt,
    baselineArtifactHash: outcome.baselineArtifactHash,
    bestArtifactHash: outcome.bestArtifactHash,
    finalEvaluationHash,
    eventLogHash: outcome.eventLogHash,
    eventLogCursor: outcome.eventLogCursor,
    proxyTraceHash: outcome.proxyTraceHash,
    brokerJournalHash: outcome.brokerJournalHash,
    spend: outcome.spend,
    status: outcome.status,
  });
}

function buildCompletion(
  configHash: Sha256Digest,
  item: ChildWorkItem,
  reservation: MetaReservation,
  outcome: MetaChildRunOutcome,
  attempt: 0 | 1,
): StoredCompletion {
  if (outcome.status !== "completed") throw new Error(`cannot measure ${outcome.status} work`);
  const runtimeBundleDigest = DIGEST.parse(outcome.runtimeBundleDigest);
  const baselineArtifactHash = DIGEST.parse(outcome.baselineArtifactHash);
  const bestArtifactHash = DIGEST.parse(outcome.bestArtifactHash);
  DIGEST.parse(outcome.eventLogHash);
  DIGEST.parse(outcome.proxyTraceHash);
  DIGEST.parse(outcome.brokerJournalHash);
  z.number().int().nonnegative().parse(outcome.eventLogCursor);
  const finalEvaluation = EvaluationRecord.parse(outcome.finalEvaluation);
  if (finalEvaluation.capsuleId !== item.capsule.capsuleId) throw new Error("final evaluation capsule id does not match child capsule");
  if (finalEvaluation.artifactHash !== bestArtifactHash) throw new Error("final evaluation is not joined to the selected best artifact");
  SAFE_ID.parse(requireString(outcome.responseModel, "response model"));
  SAFE_ID.parse(requireString(outcome.modelDriftSentinel, "model drift sentinel"));
  if (outcome.providerFingerprint !== null) SAFE_ID.parse(outcome.providerFingerprint);
  const objectives = Object.values(finalEvaluation.output.objectives);
  const constraintsPass = Object.values(finalEvaluation.output.constraints).every((value) => value === true);
  const evaluatorValid = finalEvaluation.output.valid && constraintsPass && objectives.length === 1 && Number.isFinite(objectives[0]);
  if (!evaluatorValid) throw new Error("final evaluation is invalid; invalid work is not measurable");
  const qRaw = objectives[0] as number;
  const evidence = buildEvidence(
    configHash,
    item,
    reservation,
    { ...outcome, runtimeBundleDigest, baselineArtifactHash, bestArtifactHash, finalEvaluation },
    attempt,
  );
  return {
    evidence,
    outcome: { ...outcome, runtimeBundleDigest, baselineArtifactHash, bestArtifactHash, finalEvaluation },
    qRaw,
  };
}

function requireString(value: string | null, label: string): string {
  if (value === null) throw new Error(`child ${label} is missing`);
  return value;
}

export function childMeasurementEpoch(
  candidateEpoch: string,
  phase: MetaPhase,
  arm: MetaArm,
  capsuleId: string,
  replicate: number,
): string {
  const base = SAFE_ID.parse(candidateEpoch);
  const suffix = createHash("sha256")
    .update(canonicalJson({ phase, arm, capsuleId, replicate }))
    .digest("hex")
    .slice(0, 32);
  return SAFE_ID.parse(`${base}:child:${suffix}`);
}

/** Paired confirmation/holdout coordinate shared by every arm and stable across resume. */
export function trustedPhaseMeasurementEpoch(
  configHash: Sha256Digest,
  phase: "confirmation" | "holdout",
  capsuleId: string,
  replicate: number,
): string {
  if (!Number.isSafeInteger(replicate) || replicate < 0) throw new Error("replicate must be a nonnegative safe integer");
  return `${phase}:${sha256(canonicalJson({ configHash, phase, capsuleId, replicate })).slice("sha256:".length)}`;
}

export function metaCampaignConfigHash(configInput: MetaCampaignConfig): Sha256Digest {
  const config = MetaCampaignConfigSchema.parse(configInput);
  return sha256(canonicalJson(config));
}

export function metaEvidenceHash(evidence: MetaChildEvidenceV1): Sha256Digest {
  return sha256(canonicalJson(Evidence.parse(evidence)));
}

export function normalizedGain(qRaw: number, qBase: number, scale: number): number {
  if (!Number.isFinite(qRaw) || !Number.isFinite(qBase) || !Number.isFinite(scale) || scale <= 0) {
    throw new Error("normalization inputs must be finite and scale must be positive");
  }
  const value = (qRaw - qBase) / scale;
  if (!Number.isFinite(value)) throw new Error("normalized gain is nonfinite");
  return value;
}

export function selectDeterministicBest(records: readonly EvaluationRecord[]): EvaluationRecord {
  if (records.length === 0) throw new Error("cannot select a best evaluation from an empty set");
  const eligible = records.map((record) => {
    const parsed = EvaluationRecord.parse(record);
    const values = Object.values(parsed.output.objectives);
    const constraintsPass = Object.values(parsed.output.constraints).every((value) => value === true);
    if (!parsed.output.valid || !constraintsPass || values.length !== 1 || !Number.isFinite(values[0])) return null;
    return { record: parsed, score: values[0] as number };
  }).filter((entry): entry is { record: EvaluationRecord; score: number } => entry !== null);
  if (eligible.length === 0) throw new Error("no valid finite single-objective evaluation");
  eligible.sort((left, right) => right.score - left.score || left.record.artifactHash.localeCompare(right.record.artifactHash));
  return eligible[0]!.record;
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()));
  return results;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("mean requires at least one value");
  const value = values.reduce((sum, current) => sum + current, 0) / values.length;
  if (!Number.isFinite(value)) throw new Error("mean is nonfinite");
  return value;
}

function bounded(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�").slice(0, 4_096);
}
