import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  MetaCampaignConfig as MetaCampaignConfigSchema,
  canonicalJson,
  type BudgetEnvelope,
  type MetaCampaignConfig,
} from "@hone/schema";
import { z } from "zod";

export type MetaSha256DigestV1 = `sha256:${string}`;
const HASH = z.custom<MetaSha256DigestV1>(
  (value): value is MetaSha256DigestV1 =>
    typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value),
  { message: "expected a lowercase sha256 digest" },
);
const SAFE_ID = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
const Envelope = z.object({
  maxTokens: z.number().int().positive(),
  maxUsd: z.number().finite().nonnegative(),
  maxWallClockSec: z.number().int().positive(),
  maxEvaluatorInvocations: z.number().int().positive(),
}).strict();
const Usage = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().finite().nonnegative(),
  wallClockSec: z.number().finite().nonnegative(),
  evaluatorInvocations: z.number().int().nonnegative(),
}).strict();

export const MetaPhaseV1 = z.enum(["search", "confirmation", "holdout"]);
export type MetaPhaseV1 = z.infer<typeof MetaPhaseV1>;
export const MetaArmV1 = z.enum([
  "candidate",
  "seed",
  "winner",
  "broken-control",
  "degraded-control",
  "controller-control-winner",
  "generation-0",
  "generation-1",
  "generation-2",
]);
export type MetaArmV1 = z.infer<typeof MetaArmV1>;

export const MetaWorkIdentityV1 = z.object({
  phase: MetaPhaseV1,
  arm: MetaArmV1,
  sourceArtifact: HASH,
  bundleDigest: HASH,
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  replicate: z.number().int().nonnegative(),
  measurementEpoch: SAFE_ID,
}).strict();
export type MetaWorkIdentityV1 = z.infer<typeof MetaWorkIdentityV1>;

export const MetaResourceUsageV1 = Usage;
export type MetaResourceUsageV1 = z.infer<typeof MetaResourceUsageV1>;

export const MetaReservationV1 = z.object({
  configHash: HASH,
  workKey: HASH,
  childRunId: z.string().regex(/^run_meta_[0-9a-f]{64}$/),
  identity: MetaWorkIdentityV1,
  reserved: Envelope,
}).strict();
export type MetaReservationV1 = z.infer<typeof MetaReservationV1>;

export const MetaMeasurementV1 = z.object({
  configHash: HASH,
  protocolHash: HASH,
  analysisConfigHash: HASH,
  phase: MetaPhaseV1,
  arm: MetaArmV1,
  sourceArtifact: HASH,
  bundleDigest: HASH,
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  capsuleDigest: HASH,
  replicate: z.number().int().nonnegative(),
  measurementEpoch: SAFE_ID,
  requestedModel: SAFE_ID,
  responseModel: SAFE_ID,
  providerFingerprint: SAFE_ID.nullable(),
  modelDriftSentinel: SAFE_ID,
  workKey: HASH,
  childRunId: z.string().regex(/^run_meta_[0-9a-f]{64}$/),
  evidenceHash: HASH,
  reserved: Envelope,
  observed: Usage,
  qRaw: z.number().finite(),
  qBase: z.number().finite(),
  scale: z.number().finite().positive(),
  qNormalized: z.number().finite(),
}).strict();
export type MetaMeasurementV1 = z.infer<typeof MetaMeasurementV1>;

export const MetaFailureStatusV1 = z.enum(["budget", "candidate_failed", "infrastructure_not_run"]);
export type MetaFailureStatusV1 = z.infer<typeof MetaFailureStatusV1>;

export const MetaFailureSettlementV1 = z.object({
  configHash: HASH,
  protocolHash: HASH,
  analysisConfigHash: HASH,
  phase: MetaPhaseV1,
  arm: MetaArmV1,
  sourceArtifact: HASH,
  bundleDigest: HASH,
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  capsuleDigest: HASH,
  replicate: z.number().int().nonnegative(),
  measurementEpoch: SAFE_ID,
  workKey: HASH,
  childRunId: z.string().regex(/^run_meta_[0-9a-f]{64}$/),
  evidenceHash: HASH,
  reserved: Envelope,
  observed: Usage,
  status: MetaFailureStatusV1,
}).strict();
export type MetaFailureSettlementV1 = z.infer<typeof MetaFailureSettlementV1>;

const HeaderLine = z.object({
  v: z.literal(1),
  t: z.literal("header"),
  configHash: HASH,
}).strict();
const ReservationLine = z.object({
  v: z.literal(1),
  t: z.literal("reservation"),
  seq: z.number().int().positive(),
  reservation: MetaReservationV1,
}).strict();
const SettlementLine = z.object({
  v: z.literal(1),
  t: z.literal("settlement"),
  seq: z.number().int().positive(),
  measurement: MetaMeasurementV1,
}).strict();
const FailureSettlementLine = z.object({
  v: z.literal(1),
  t: z.literal("failure-settlement"),
  seq: z.number().int().positive(),
  failure: MetaFailureSettlementV1,
}).strict();
const MeasurementLine = z.object({
  v: z.literal(1),
  t: z.literal("measurement"),
  seq: z.number().int().positive(),
  measurement: MetaMeasurementV1,
}).strict();
const TerminalLine = z.object({
  v: z.literal(1),
  t: z.literal("terminal-holdout"),
  seq: z.number().int().positive(),
}).strict();
const JournalLine = z.discriminatedUnion("t", [
  ReservationLine,
  SettlementLine,
  FailureSettlementLine,
  MeasurementLine,
  TerminalLine,
]);
type JournalLine = z.infer<typeof JournalLine>;

const DIMS = ["maxTokens", "maxUsd", "maxWallClockSec", "maxEvaluatorInvocations"] as const;
const USAGE_DIMS = ["tokens", "usd", "wallClockSec", "evaluatorInvocations"] as const;
type BudgetDimension = (typeof DIMS)[number];
type UsageDimension = (typeof USAGE_DIMS)[number];

const BUDGET_TO_USAGE: Readonly<Record<BudgetDimension, UsageDimension>> = {
  maxTokens: "tokens",
  maxUsd: "usd",
  maxWallClockSec: "wallClockSec",
  maxEvaluatorInvocations: "evaluatorInvocations",
};

export interface MetaJournalBudgetStateV1 {
  campaign: BudgetEnvelope;
  outerReserved: BudgetEnvelope;
  committed: BudgetEnvelope;
  remaining: BudgetEnvelope;
  reservations: number;
  settlements: number;
  measurements: number;
  failureSettlements: number;
  openReservations: number;
  terminalHoldoutLatched: boolean;
}

export interface MetaSettlementInputV1 {
  evidenceHash: string;
  observed: MetaResourceUsageV1;
  qRaw: number;
  responseModel: string;
  providerFingerprint: string | null;
  modelDriftSentinel: string;
}

export interface MetaFailureSettlementInputV1 {
  evidenceHash: string;
  observed: MetaResourceUsageV1;
  status: MetaFailureStatusV1;
}

export const metaJournalIo = {
  write(fd: number, buffer: Buffer, offset: number, length: number): number {
    return writeSync(fd, buffer, offset, length);
  },
  fsync(fd: number): void {
    fsyncSync(fd);
  },
  syncDir(path: string): void {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
};

export function metaCampaignConfigHash(config: MetaCampaignConfig): MetaSha256DigestV1 {
  const parsed = MetaCampaignConfigSchema.parse(config);
  return `sha256:${createHash("sha256").update(canonicalJson(parsed)).digest("hex")}`;
}

export function metaWorkKey(configHash: string, identity: MetaWorkIdentityV1): MetaSha256DigestV1 {
  const hash = HASH.parse(configHash);
  const parsed = MetaWorkIdentityV1.parse(identity);
  return `sha256:${createHash("sha256").update(canonicalJson({ configHash: hash, ...parsed })).digest("hex")}`;
}

function childRunId(workKey: string): string {
  return `run_meta_${workKey.slice("sha256:".length)}`;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = metaJournalIo.write(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error("meta journal write made no progress");
    offset += written;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function ensureOwnerOnly(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("meta journal must be a regular file, never a symlink");
  if ((stat.mode & 0o077) !== 0) throw new Error("meta journal is not owner-only (expected mode 0600)");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("meta journal is not owned by the current user");
  }
}

function publishHeader(path: string, configHash: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeAll(fd, Buffer.from(`${JSON.stringify(HeaderLine.parse({ v: 1, t: "header", configHash }))}\n`));
    metaJournalIo.fsync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
    metaJournalIo.syncDir(dir);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  } finally {
    unlinkSync(temp);
  }
}

function normalizedScore(qRaw: number, qBase: number, scale: number): number {
  const value = (qRaw - qBase) / scale;
  if (!Number.isFinite(value)) throw new Error("normalized score is not finite");
  return Object.is(value, -0) ? 0 : value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function copyEnvelope(envelope: BudgetEnvelope): BudgetEnvelope {
  return { ...envelope };
}

function copyUsage(usage: MetaResourceUsageV1): MetaResourceUsageV1 {
  return { ...usage };
}

function copyIdentity(identity: MetaWorkIdentityV1): MetaWorkIdentityV1 {
  return { ...identity };
}

function copyReservation(reservation: MetaReservationV1): MetaReservationV1 {
  return { ...reservation, identity: copyIdentity(reservation.identity), reserved: copyEnvelope(reservation.reserved) };
}

function copyMeasurement(measurement: MetaMeasurementV1): MetaMeasurementV1 {
  return { ...measurement, reserved: copyEnvelope(measurement.reserved), observed: copyUsage(measurement.observed) };
}

function copyFailureSettlement(failure: MetaFailureSettlementV1): MetaFailureSettlementV1 {
  return { ...failure, reserved: copyEnvelope(failure.reserved), observed: copyUsage(failure.observed) };
}

type MetaDurableSettlementV1 =
  | { readonly kind: "measurement"; readonly value: MetaMeasurementV1 }
  | { readonly kind: "failure"; readonly value: MetaFailureSettlementV1 };

export class MetaJournalV1 {
  private readonly config: MetaCampaignConfig;
  private readonly configHashValue: MetaSha256DigestV1;
  private readonly reservationsByKey = new Map<string, MetaReservationV1>();
  private readonly settlementsByKey = new Map<string, MetaDurableSettlementV1>();
  private readonly measurementsByKey = new Map<string, MetaMeasurementV1>();
  private readonly failuresByKey = new Map<string, MetaFailureSettlementV1>();
  private nextSeq = 1;
  private terminalHoldout = false;
  private poisoned: Error | undefined;
  private closed = false;

  private constructor(
    readonly path: string,
    config: MetaCampaignConfig,
    private readonly fd: number,
  ) {
    this.config = config;
    this.configHashValue = metaCampaignConfigHash(config);
  }

  static open(path: string, configInput: MetaCampaignConfig): MetaJournalV1 {
    const config = MetaCampaignConfigSchema.parse(configInput);
    const configHash = metaCampaignConfigHash(config);
    try {
      lstatSync(path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      publishHeader(path, configHash);
    }
    ensureOwnerOnly(path);
    chmodSync(path, 0o600);
    const bytes = readFileSync(path);
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
      throw new Error("meta journal has a torn unterminated tail");
    }
    const textLines = bytes.toString("utf8").split("\n");
    textLines.pop();
    const first = textLines.shift();
    if (first === undefined) throw new Error("meta journal is missing its header");
    let header: z.infer<typeof HeaderLine>;
    try {
      header = HeaderLine.parse(JSON.parse(first));
    } catch (error) {
      throw new Error(`meta journal header is corrupt: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (header.configHash !== configHash) {
      throw new Error(`meta journal belongs to foreign campaign config ${header.configHash}`);
    }
    const replayed: JournalLine[] = [];
    for (let index = 0; index < textLines.length; index += 1) {
      const text = textLines[index];
      try {
        replayed.push(JournalLine.parse(JSON.parse(text ?? "")));
      } catch (error) {
        throw new Error(`meta journal is corrupt at line ${index + 2}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const fd = openSync(path, "a", 0o600);
    const journal = new MetaJournalV1(path, config, fd);
    try {
      for (const line of replayed) journal.applyReplay(line);
      journal.recoverMeasurements();
      return journal;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  get configHash(): MetaSha256DigestV1 {
    return this.configHashValue;
  }

  reserveChild(identityInput: MetaWorkIdentityV1): MetaReservationV1 {
    this.assertUsable();
    const identity = MetaWorkIdentityV1.parse(identityInput);
    this.validateIdentity(identity);
    const workKey = metaWorkKey(this.configHashValue, identity);
    const duplicate = this.reservationsByKey.get(workKey);
    if (duplicate !== undefined) return copyReservation(duplicate);
    if (identity.phase === "holdout" && !this.terminalHoldout) {
      throw new Error("holdout child reservation requires the explicit terminal holdout latch");
    }
    if (identity.phase !== "holdout" && this.terminalHoldout) {
      throw new Error("terminal holdout is latched; train/search work is closed");
    }
    const reserved = copyEnvelope(this.config.budgets.child);
    const committed = this.computeCommitted();
    for (const dimension of DIMS) {
      if (committed[dimension] + reserved[dimension] > this.config.budgets.campaign[dimension]) {
        throw new Error(`campaign budget exhausted: ${dimension}`);
      }
    }
    const reservation = MetaReservationV1.parse({
      configHash: this.configHashValue,
      workKey,
      childRunId: childRunId(workKey),
      identity,
      reserved,
    });
    this.append({ v: 1, t: "reservation", seq: this.nextSeq, reservation });
    this.nextSeq += 1;
    this.reservationsByKey.set(workKey, reservation);
    return copyReservation(reservation);
  }

  settleChild(identityInput: MetaWorkIdentityV1, input: MetaSettlementInputV1): MetaMeasurementV1 {
    this.assertUsable();
    const identity = MetaWorkIdentityV1.parse(identityInput);
    this.validateIdentity(identity);
    const workKey = metaWorkKey(this.configHashValue, identity);
    const reservation = this.reservationsByKey.get(workKey);
    if (reservation === undefined) throw new Error(`no durable reservation for ${workKey}`);
    if (identity.phase === "holdout" && !this.terminalHoldout) {
      throw new Error("holdout measurement requires the explicit terminal holdout latch");
    }
    const evidenceHash = HASH.parse(input.evidenceHash);
    const observed = Usage.parse(input.observed);
    const qRaw = z.number().finite().parse(input.qRaw);
    for (const dimension of DIMS) {
      const observedDimension = BUDGET_TO_USAGE[dimension];
      if (observed[observedDimension] > reservation.reserved[dimension]) {
        throw new Error(`observed child resources exceed reservation: ${dimension}`);
      }
    }
    const capsule = this.registeredCapsule(identity);
    const measurement = MetaMeasurementV1.parse({
      configHash: this.configHashValue,
      protocolHash: this.config.protocolHash,
      analysisConfigHash: this.config.analysisConfigHash,
      ...identity,
      capsuleDigest: capsule.capsuleDigest,
      workKey,
      childRunId: reservation.childRunId,
      evidenceHash,
      reserved: reservation.reserved,
      observed,
      qRaw,
      qBase: capsule.qBase,
      scale: capsule.scale,
      qNormalized: normalizedScore(qRaw, capsule.qBase, capsule.scale),
      requestedModel: this.config.modelObservation.requestedRoute,
      responseModel: SAFE_ID.parse(input.responseModel),
      providerFingerprint: input.providerFingerprint === null ? null : SAFE_ID.parse(input.providerFingerprint),
      modelDriftSentinel: SAFE_ID.parse(input.modelDriftSentinel),
    });
    const priorSettlement = this.settlementsByKey.get(workKey);
    if (priorSettlement !== undefined) {
      if (priorSettlement.kind !== "measurement" || !sameJson(priorSettlement.value, measurement)) {
        throw new Error(`conflicting duplicate settlement for ${workKey}`);
      }
      const priorMeasurement = this.measurementsByKey.get(workKey);
      if (priorMeasurement === undefined) this.appendMeasurement(measurement);
      return copyMeasurement(measurement);
    }
    this.append({ v: 1, t: "settlement", seq: this.nextSeq, measurement });
    this.nextSeq += 1;
    this.settlementsByKey.set(workKey, { kind: "measurement", value: measurement });
    this.appendMeasurement(measurement);
    return copyMeasurement(measurement);
  }

  settleChildFailure(identityInput: MetaWorkIdentityV1, input: MetaFailureSettlementInputV1): MetaFailureSettlementV1 {
    this.assertUsable();
    const identity = MetaWorkIdentityV1.parse(identityInput);
    this.validateIdentity(identity);
    const workKey = metaWorkKey(this.configHashValue, identity);
    const reservation = this.reservationsByKey.get(workKey);
    if (reservation === undefined) throw new Error(`no durable reservation for ${workKey}`);
    if (identity.phase === "holdout" && !this.terminalHoldout) {
      throw new Error("holdout failure settlement requires the explicit terminal holdout latch");
    }
    const observed = Usage.parse(input.observed);
    this.validateObserved(observed, reservation);
    const capsule = this.registeredCapsule(identity);
    const failure = MetaFailureSettlementV1.parse({
      configHash: this.configHashValue,
      protocolHash: this.config.protocolHash,
      analysisConfigHash: this.config.analysisConfigHash,
      ...identity,
      capsuleDigest: capsule.capsuleDigest,
      workKey,
      childRunId: reservation.childRunId,
      evidenceHash: HASH.parse(input.evidenceHash),
      reserved: reservation.reserved,
      observed,
      status: input.status,
    });
    const prior = this.settlementsByKey.get(workKey);
    if (prior !== undefined) {
      if (prior.kind !== "failure" || !sameJson(prior.value, failure)) {
        throw new Error(`conflicting duplicate settlement for ${workKey}`);
      }
      return copyFailureSettlement(failure);
    }
    this.append({ v: 1, t: "failure-settlement", seq: this.nextSeq, failure });
    this.nextSeq += 1;
    this.settlementsByKey.set(workKey, { kind: "failure", value: failure });
    this.failuresByKey.set(workKey, failure);
    return copyFailureSettlement(failure);
  }

  latchTerminalHoldout(): void {
    this.assertUsable();
    if (this.terminalHoldout) return;
    if (this.openReservationCount() !== 0) {
      throw new Error("cannot latch terminal holdout while train/search reservations remain open");
    }
    this.append({ v: 1, t: "terminal-holdout", seq: this.nextSeq });
    this.nextSeq += 1;
    this.terminalHoldout = true;
  }

  queryTrainMeasurements(): readonly MetaMeasurementV1[] {
    return [...this.measurementsByKey.values()]
      .filter((measurement) => measurement.phase !== "holdout")
      .map(copyMeasurement);
  }

  queryHoldoutMeasurements(): readonly MetaMeasurementV1[] {
    if (!this.terminalHoldout) throw new Error("terminal holdout has not been latched");
    return [...this.measurementsByKey.values()]
      .filter((measurement) => measurement.phase === "holdout")
      .map(copyMeasurement);
  }

  queryFailureSettlements(): readonly MetaFailureSettlementV1[] {
    return [...this.failuresByKey.values()].map(copyFailureSettlement);
  }

  budgetState(): MetaJournalBudgetStateV1 {
    const committed = this.computeCommitted();
    const campaign = copyEnvelope(this.config.budgets.campaign);
    return {
      campaign,
      outerReserved: copyEnvelope(this.config.budgets.outer),
      committed,
      remaining: {
        maxTokens: campaign.maxTokens - committed.maxTokens,
        maxUsd: campaign.maxUsd - committed.maxUsd,
        maxWallClockSec: campaign.maxWallClockSec - committed.maxWallClockSec,
        maxEvaluatorInvocations: campaign.maxEvaluatorInvocations - committed.maxEvaluatorInvocations,
      },
      reservations: this.reservationsByKey.size,
      settlements: this.settlementsByKey.size,
      measurements: this.measurementsByKey.size,
      failureSettlements: this.failuresByKey.size,
      openReservations: this.openReservationCount(),
      terminalHoldoutLatched: this.terminalHoldout,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  private validateIdentity(identity: MetaWorkIdentityV1): void {
    const permittedArm =
      (identity.phase === "search" && identity.arm === "candidate") ||
      (identity.phase === "confirmation" && identity.arm !== "candidate") ||
      (identity.phase === "holdout" && (identity.arm === "seed" || identity.arm === "winner"));
    if (!permittedArm) throw new Error(`arm ${identity.arm} is invalid for ${identity.phase}`);
    const maxReplicates = identity.phase === "search"
      ? this.config.counts.searchReplicates
      : identity.phase === "confirmation"
        ? this.config.counts.confirmationReplicates
        : this.config.counts.holdoutReplicates;
    if (identity.replicate >= maxReplicates) {
      throw new Error(`replicate ${identity.replicate} is outside ${identity.phase} protocol cardinality ${maxReplicates}`);
    }
    const registered = identity.arm === "seed"
      ? {
          sourceArtifact: this.config.seedOptimizer.sourceArtifact,
          bundleDigest: this.config.seedOptimizer.bundleDigest,
        }
      : identity.arm === "broken-control"
        ? {
            sourceArtifact: this.config.controls.brokenSourceArtifact,
            bundleDigest: this.config.controls.brokenBundleDigest,
          }
        : identity.arm === "degraded-control"
          ? {
              sourceArtifact: this.config.controls.degradedSourceArtifact,
              bundleDigest: this.config.controls.degradedBundleDigest,
            }
          : null;
    if (registered !== null) {
      if (identity.sourceArtifact !== registered.sourceArtifact) {
        throw new Error(`${identity.arm} source artifact does not match the registered source domain`);
      }
      if (identity.bundleDigest !== registered.bundleDigest) {
        throw new Error(`${identity.arm} bundle digest does not match the registered bundle domain`);
      }
    }
    this.registeredCapsule(identity);
  }

  private registeredCapsule(identity: MetaWorkIdentityV1) {
    const corpus = identity.phase === "holdout" ? this.config.holdout : this.config.train;
    const capsule = corpus.find((entry) => entry.capsuleId === identity.capsuleId);
    if (capsule === undefined) throw new Error(`${identity.capsuleId} is not registered in the ${identity.phase === "holdout" ? "holdout" : "train"} corpus`);
    return capsule;
  }

  private applyReplay(line: JournalLine): void {
    if (line.seq !== this.nextSeq) throw new Error(`meta journal sequence corruption: expected ${this.nextSeq}, got ${line.seq}`);
    this.nextSeq += 1;
    if (line.t === "terminal-holdout") {
      if (this.terminalHoldout) throw new Error("meta journal contains duplicate terminal holdout latches");
      if (this.openReservationCount() !== 0) throw new Error("meta journal latched terminal holdout with open train/search reservations");
      this.terminalHoldout = true;
      return;
    }
    if (line.t === "reservation") {
      const reservation = line.reservation;
      this.validateIdentity(reservation.identity);
      const expectedKey = metaWorkKey(this.configHashValue, reservation.identity);
      if (reservation.configHash !== this.configHashValue || reservation.workKey !== expectedKey || reservation.childRunId !== childRunId(expectedKey)) {
        throw new Error("meta journal reservation identity is corrupt");
      }
      if (!sameJson(reservation.reserved, this.config.budgets.child)) throw new Error("meta journal reservation is not the full registered child envelope");
      if (this.reservationsByKey.has(expectedKey)) throw new Error(`duplicate reservation line for ${expectedKey}`);
      if (reservation.identity.phase === "holdout" ? !this.terminalHoldout : this.terminalHoldout) {
        throw new Error("meta journal reservation violates terminal holdout ordering");
      }
      const committed = this.computeCommitted();
      for (const dimension of DIMS) {
        if (committed[dimension] + reservation.reserved[dimension] > this.config.budgets.campaign[dimension]) {
          throw new Error(`meta journal reservation exceeds campaign budget: ${dimension}`);
        }
      }
      this.reservationsByKey.set(expectedKey, reservation);
      return;
    }
    if (line.t === "failure-settlement") {
      const failure = line.failure;
      this.validateFailureSettlement(failure);
      if (this.settlementsByKey.has(failure.workKey)) throw new Error(`duplicate settlement line for ${failure.workKey}`);
      this.settlementsByKey.set(failure.workKey, { kind: "failure", value: failure });
      this.failuresByKey.set(failure.workKey, failure);
      return;
    }
    const measurement = line.measurement;
    this.validateMeasurement(measurement);
    if (line.t === "settlement") {
      if (this.settlementsByKey.has(measurement.workKey)) throw new Error(`duplicate settlement line for ${measurement.workKey}`);
      this.settlementsByKey.set(measurement.workKey, { kind: "measurement", value: measurement });
      return;
    }
    const settlement = this.settlementsByKey.get(measurement.workKey);
    if (settlement === undefined || settlement.kind !== "measurement" || !sameJson(settlement.value, measurement)) {
      throw new Error("measurement has no identical durable settlement");
    }
    if (this.measurementsByKey.has(measurement.workKey)) throw new Error(`duplicate measurement line for ${measurement.workKey}`);
    this.measurementsByKey.set(measurement.workKey, measurement);
  }

  private validateMeasurement(measurement: MetaMeasurementV1): void {
    const identity = MetaWorkIdentityV1.parse({
      phase: measurement.phase,
      arm: measurement.arm,
      sourceArtifact: measurement.sourceArtifact,
      bundleDigest: measurement.bundleDigest,
      capsuleId: measurement.capsuleId,
      replicate: measurement.replicate,
      measurementEpoch: measurement.measurementEpoch,
    });
    this.validateIdentity(identity);
    const reservation = this.reservationsByKey.get(measurement.workKey);
    if (reservation === undefined) throw new Error(`measurement has no reservation: ${measurement.workKey}`);
    if (measurement.phase === "holdout" && !this.terminalHoldout) throw new Error("holdout measurement precedes terminal latch");
    const capsule = this.registeredCapsule(identity);
    const expectedKey = metaWorkKey(this.configHashValue, identity);
    const expectedNormalized = normalizedScore(measurement.qRaw, capsule.qBase, capsule.scale);
    if (
      measurement.configHash !== this.configHashValue ||
      measurement.protocolHash !== this.config.protocolHash ||
      measurement.analysisConfigHash !== this.config.analysisConfigHash ||
      measurement.workKey !== expectedKey ||
      measurement.childRunId !== reservation.childRunId ||
      measurement.capsuleDigest !== capsule.capsuleDigest ||
      measurement.requestedModel !== this.config.modelObservation.requestedRoute ||
      measurement.qBase !== capsule.qBase ||
      measurement.scale !== capsule.scale ||
      measurement.qNormalized !== expectedNormalized ||
      !sameJson(measurement.reserved, reservation.reserved)
    ) {
      throw new Error("measurement identity or exact normalization is corrupt");
    }
    this.validateObserved(measurement.observed, reservation);
  }

  private validateFailureSettlement(failure: MetaFailureSettlementV1): void {
    const identity = MetaWorkIdentityV1.parse({
      phase: failure.phase,
      arm: failure.arm,
      sourceArtifact: failure.sourceArtifact,
      bundleDigest: failure.bundleDigest,
      capsuleId: failure.capsuleId,
      replicate: failure.replicate,
      measurementEpoch: failure.measurementEpoch,
    });
    this.validateIdentity(identity);
    const reservation = this.reservationsByKey.get(failure.workKey);
    if (reservation === undefined) throw new Error(`failure settlement has no reservation: ${failure.workKey}`);
    if (failure.phase === "holdout" && !this.terminalHoldout) throw new Error("holdout failure precedes terminal latch");
    const capsule = this.registeredCapsule(identity);
    const expectedKey = metaWorkKey(this.configHashValue, identity);
    if (
      failure.configHash !== this.configHashValue ||
      failure.protocolHash !== this.config.protocolHash ||
      failure.analysisConfigHash !== this.config.analysisConfigHash ||
      failure.workKey !== expectedKey ||
      failure.childRunId !== reservation.childRunId ||
      failure.capsuleDigest !== capsule.capsuleDigest ||
      !sameJson(failure.reserved, reservation.reserved)
    ) {
      throw new Error("failure settlement identity is corrupt");
    }
    this.validateObserved(failure.observed, reservation);
  }

  private validateObserved(observed: MetaResourceUsageV1, reservation: MetaReservationV1): void {
    for (const dimension of DIMS) {
      const observedDimension = BUDGET_TO_USAGE[dimension];
      if (observed[observedDimension] > reservation.reserved[dimension]) {
        throw new Error(`observed child resources exceed reservation: ${dimension}`);
      }
    }
  }

  private appendMeasurement(measurement: MetaMeasurementV1): void {
    this.append({ v: 1, t: "measurement", seq: this.nextSeq, measurement });
    this.nextSeq += 1;
    this.measurementsByKey.set(measurement.workKey, measurement);
  }

  private recoverMeasurements(): void {
    for (const [workKey, settlement] of this.settlementsByKey) {
      if (settlement.kind === "measurement" && !this.measurementsByKey.has(workKey)) {
        this.appendMeasurement(settlement.value);
      }
    }
  }

  private computeCommitted(): BudgetEnvelope {
    const committed = copyEnvelope(this.config.budgets.outer);
    for (const [workKey, reservation] of this.reservationsByKey) {
      const settlement = this.settlementsByKey.get(workKey);
      if (settlement === undefined) {
        for (const dimension of DIMS) committed[dimension] += reservation.reserved[dimension];
      } else {
        for (const dimension of DIMS) committed[dimension] += settlement.value.observed[BUDGET_TO_USAGE[dimension]];
      }
    }
    return committed;
  }

  private openReservationCount(): number {
    let count = 0;
    for (const key of this.reservationsByKey.keys()) {
      if (!this.settlementsByKey.has(key)) count += 1;
    }
    return count;
  }

  private append(line: JournalLine): void {
    this.assertUsable();
    try {
      writeAll(this.fd, Buffer.from(`${JSON.stringify(JournalLine.parse(line))}\n`));
      metaJournalIo.fsync(this.fd);
    } catch (error) {
      this.poisoned = error instanceof Error ? error : new Error(String(error));
      throw this.poisoned;
    }
  }

  private assertUsable(): void {
    if (this.closed) throw new Error("meta journal is closed");
    if (this.poisoned !== undefined) throw new Error(`meta journal is unusable after append failure: ${this.poisoned.message}`);
  }
}
