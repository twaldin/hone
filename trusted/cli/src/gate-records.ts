import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  M2_PANEL_A_TASK_IDS,
  M2_PANEL_B_TASK_IDS,
  canonicalJson,
  type MetaCampaignConfigV2,
} from "@hone/schema";
import { metaCampaignConfigHash, type MetaMeasurement } from "@hone/meta";
import { MetaMeasurementV1 } from "./meta-journal.js";
import { UsageError } from "./args.js";
import { writeFileDurable } from "./eventlog.js";

/**
 * M2 G1/G2 statistical + human authorization records (launch-tooling item 4).
 *
 * The recursive confirmation phase writes only confirmation-receipt.json — a
 * bare measurement digest with NO gate calculation and NO authorization, and
 * Stage-B / terminal dispatch require neither today. This module is the
 * additive gate plane that consumes those confirmations:
 *
 *   1. assembleG1Record  — the digest-bound Stage-A statistical record derived
 *      from the 96 Stage-A confirmations (arms seed / winner / broken-control /
 *      degraded-control over the eight Panel-A capsules at three replicates),
 *      computing the launch-spec §4 G1 criterion and binding the accepted
 *      seed (G0) and winner (G1) identities to the measurement digest.
 *   2. assembleG2Record  — the digest-bound Stage-B paired transfer evaluator
 *      over the 120 Stage-B confirmations (arms seed=G1-controller /
 *      controller-control-winner=best-G0-controller / generation-2=G2 /
 *      broken-control / degraded-control over the eight Panel-B capsules),
 *      computing paired best-so-far ordinal+token wins, paired-AUC deltas,
 *      valid-yield and the G2-vs-G1 sign/control gates (launch-spec §5).
 *   3. assembleG1Authorization / assembleG2Authorization — the durable human
 *      approval binding the accepted artifacts (statistical-record digest,
 *      control-winner + generation2 for G1; generation0/1/2 for G2). Stage-B
 *      and terminal dispatch call assertG1Authorized / assertG2Authorized and
 *      FAIL CLOSED when the record is absent, drifted, unapproved, statistically
 *      failing, or bound to different artifacts than the dispatch requested.
 *
 * OWNER-OPEN thresholds. launch-spec flags the Panel-A "2*SE analysis details",
 * the Stage-B pairing/tie-break and the durable G1/G2 approval record as open
 * decisions (§ "OPEN LAUNCH DECISIONS" #6). Every value the spec leaves open is
 * a REQUIRED typed input (GateThresholdsFileV1); this module NEVER substitutes a
 * default, so an unset threshold fails closed at schema parse. The spec-pinned
 * cardinalities (≥6/8 task signs, ≥3/4 per stratum, three replicates) are
 * encoded as constants below because the spec states them exactly.
 */

export const GATE_RECORDS_VERSION = "gate-records.v1";
export const G1_RECORD_FILE = "g1-statistical-record.v1.json";
export const G2_RECORD_FILE = "g2-statistical-record.v1.json";
export const G1_AUTHORIZATION_FILE = "g1-authorization.v1.json";
export const G2_AUTHORIZATION_FILE = "g2-authorization.v1.json";

/** launch-spec §4/§5 spec-pinned cardinalities (stated exactly, not owner-open). */
export const PANEL_CAPSULE_COUNT = 8;
export const PANEL_STRATUM_SIZE = 4;
export const MIN_TASK_SIGN_POSITIVES = 6;
export const MIN_STRATUM_POSITIVES = 3;
export const CONFIRMATION_REPLICATES = 3;
export const STAGE_A_ARMS = ["seed", "winner", "broken-control", "degraded-control"] as const;
export const STAGE_B_ARMS = [
  "seed",
  "controller-control-winner",
  "generation-2",
  "broken-control",
  "degraded-control",
] as const;

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ISO = z.string().datetime({ offset: true });
const STRATUM = z.enum(["owner", "oss"]);
type Stratum = z.infer<typeof STRATUM>;

export const OptimizerIdentity = z
  .object({ sourceArtifact: SHA256, bundleDigest: SHA256 })
  .strict();
export type OptimizerIdentity = z.infer<typeof OptimizerIdentity>;

/**
 * The Stage-A G1 gate thresholds the owner MUST supply. launch-spec §4 states
 * "paired improvement > 2*SE" but flags the 2*SE analysis details as open, and
 * says nothing about the epsilon separating a positive from a null sign.
 */
export const G1GateThresholds = z
  .object({
    /** SE multiple for the paired-improvement criterion (spec ≈ 2; analysis details open). */
    pairedImprovementSeMultiple: z.number().finite().positive(),
    /** Minimum per-capsule mean paired delta magnitude counted as a positive sign. */
    positiveSignEpsilon: z.number().finite().nonnegative(),
  })
  .strict();
export type G1GateThresholds = z.infer<typeof G1GateThresholds>;

/**
 * The Stage-B G2 transfer thresholds the owner MUST supply. launch-spec §5:
 * "higher best-so-far AUC by ordinal AND tokens in ≥2/3 pairs; paired mean AUC
 * deltas +; reaches every common threshold in ≤ G0 tokens; valid-yield not
 * lower". The 2/3 fraction, the ordinal/token tie-break and the valid-yield
 * tolerance are flagged open (#6), so all are required inputs.
 */
export const G2GateThresholds = z
  .object({
    /** Fraction of (capsule×replicate) pairs the G1-controller must win by ordinal AND tokens. */
    pairedWinFraction: z.number().finite().min(0).max(1),
    /** qNormalized margin required to count a pair as a G1-controller ordinal win. */
    ordinalWinEpsilon: z.number().finite().nonnegative(),
    /** Token slack: G1-controller tokens must be ≤ G0-controller tokens × (1 + slack). */
    tokenParityFraction: z.number().finite().nonnegative(),
    /** Allowed downward tolerance on the G1-controller valid-yield fraction. */
    validYieldToleranceFraction: z.number().finite().min(0).max(1),
    /** Epsilon separating a positive from a null sign in the G2-vs-G1 gates and paired deltas. */
    positiveSignEpsilon: z.number().finite().nonnegative(),
  })
  .strict();
export type G2GateThresholds = z.infer<typeof G2GateThresholds>;

/** Owner threshold file: both gate blocks are required — an absent block fails closed. */
export const GateThresholdsFileV1 = z
  .object({
    version: z.literal(GATE_RECORDS_VERSION),
    g1: G1GateThresholds,
    g2: G2GateThresholds,
  })
  .strict();
export type GateThresholdsFileV1 = z.infer<typeof GateThresholdsFileV1>;

const HumanDecision = z
  .object({
    approver: z.string().min(1).max(256),
    decision: z.literal("approved"),
    /** launch-spec §4/§5 human criterion: confined intelligible diff with a plausible mechanism. */
    diffConfinedIntelligible: z.literal(true),
    mechanismPlausible: z.literal(true),
    reason: z.string().min(1).max(4096),
    decidedAt: ISO,
  })
  .strict();
export type HumanDecision = z.infer<typeof HumanDecision>;

const G1PerCapsule = z
  .object({
    taskId: z.string(),
    capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
    stratum: STRATUM,
    seedMean: z.number().finite(),
    winnerMean: z.number().finite(),
    meanDelta: z.number().finite(),
    signPositive: z.boolean(),
  })
  .strict();

const G1Criteria = z
  .object({
    pairedImprovement: z.boolean(),
    taskSigns: z.boolean(),
    stratumSigns: z.boolean(),
    controlsBelow: z.boolean(),
    cardinalityComplete: z.boolean(),
    artifactsBound: z.boolean(),
  })
  .strict();

export const G1StatisticalRecordV1 = z
  .object({
    version: z.literal(`${GATE_RECORDS_VERSION}/g1-statistical`),
    stage: z.literal("A"),
    configHash: SHA256,
    measurementCount: z.number().int().nonnegative(),
    measurementHash: SHA256,
    seed: OptimizerIdentity,
    winner: OptimizerIdentity,
    thresholds: G1GateThresholds,
    stats: z
      .object({
        pairedSampleSize: z.number().int().nonnegative(),
        pairedMeanDelta: z.number().finite(),
        pairedStandardError: z.number().finite().nonnegative(),
        pairedImprovementThreshold: z.number().finite(),
        perCapsule: z.array(G1PerCapsule),
        taskSignPositives: z.number().int().nonnegative(),
        ownerSignPositives: z.number().int().nonnegative(),
        ossSignPositives: z.number().int().nonnegative(),
        seedMean: z.number().finite(),
        winnerMean: z.number().finite(),
        brokenControlMean: z.number().finite(),
        degradedControlMean: z.number().finite(),
      })
      .strict(),
    criteria: G1Criteria,
    pass: z.boolean(),
    generatedAt: ISO,
    inputsDigest: SHA256,
  })
  .strict();
export type G1StatisticalRecordV1 = z.infer<typeof G1StatisticalRecordV1>;

const G2Pair = z
  .object({
    taskId: z.string(),
    capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
    stratum: STRATUM,
    replicate: z.number().int().nonnegative(),
    g1Score: z.number().finite(),
    g0Score: z.number().finite(),
    ordinalWin: z.boolean(),
    g1Tokens: z.number().int().nonnegative(),
    g0Tokens: z.number().int().nonnegative(),
    tokenWin: z.boolean(),
    pairWin: z.boolean(),
  })
  .strict();

const G2SignPerCapsule = z
  .object({
    taskId: z.string(),
    capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
    stratum: STRATUM,
    g1Mean: z.number().finite(),
    g2Mean: z.number().finite(),
    meanDelta: z.number().finite(),
    signPositive: z.boolean(),
  })
  .strict();

const G2Criteria = z
  .object({
    pairedAucWinFraction: z.boolean(),
    pairedMeanAucPositive: z.boolean(),
    tokenParity: z.boolean(),
    validYieldNotLower: z.boolean(),
    g2SignGate: z.boolean(),
    g2ControlsBelow: z.boolean(),
    cardinalityComplete: z.boolean(),
    artifactsBound: z.boolean(),
  })
  .strict();

export const G2StatisticalRecordV1 = z
  .object({
    version: z.literal(`${GATE_RECORDS_VERSION}/g2-statistical`),
    stage: z.literal("B"),
    configHash: SHA256,
    measurementCount: z.number().int().nonnegative(),
    measurementHash: SHA256,
    target: OptimizerIdentity,
    controlWinner: OptimizerIdentity,
    generation2: OptimizerIdentity,
    thresholds: G2GateThresholds,
    transfer: z
      .object({
        pairs: z.array(G2Pair),
        pairWinCount: z.number().int().nonnegative(),
        pairWinFraction: z.number().finite().min(0).max(1),
        tokenWinCount: z.number().int().nonnegative(),
        pairedAucSampleSize: z.number().int().nonnegative(),
        pairedMeanAucDelta: z.number().finite(),
        g1ValidYield: z.number().finite().min(0).max(1),
        g0ValidYield: z.number().finite().min(0).max(1),
      })
      .strict(),
    g2Sign: z
      .object({
        perCapsule: z.array(G2SignPerCapsule),
        taskSignPositives: z.number().int().nonnegative(),
        ownerSignPositives: z.number().int().nonnegative(),
        ossSignPositives: z.number().int().nonnegative(),
        g1Mean: z.number().finite(),
        g2Mean: z.number().finite(),
        brokenControlMean: z.number().finite(),
        degradedControlMean: z.number().finite(),
      })
      .strict(),
    criteria: G2Criteria,
    pass: z.boolean(),
    generatedAt: ISO,
    inputsDigest: SHA256,
  })
  .strict();
export type G2StatisticalRecordV1 = z.infer<typeof G2StatisticalRecordV1>;

export const AuthorizationGateRecordV1 = z.discriminatedUnion("gate", [
  z
    .object({
      version: z.literal(`${GATE_RECORDS_VERSION}/authorization`),
      gate: z.literal("G1"),
      configHash: SHA256,
      /** inputsDigest of the G1 statistical record this authorization certifies. */
      statisticalRecordDigest: SHA256,
      statisticalPass: z.literal(true),
      acceptedArtifacts: z
        .object({
          /** The Stage-A validated winner (record.winner); the Stage-B target MUST equal it. */
          target: OptimizerIdentity,
          controlWinner: OptimizerIdentity,
          generation2: OptimizerIdentity,
        })
        .strict(),
      humanDecision: HumanDecision,
      generatedAt: ISO,
      inputsDigest: SHA256,
    })
    .strict(),
  z
    .object({
      version: z.literal(`${GATE_RECORDS_VERSION}/authorization`),
      gate: z.literal("G2"),
      configHash: SHA256,
      statisticalRecordDigest: SHA256,
      statisticalPass: z.literal(true),
      acceptedArtifacts: z
        .object({
          generation0: OptimizerIdentity,
          generation1: OptimizerIdentity,
          generation2: OptimizerIdentity,
        })
        .strict(),
      humanDecision: HumanDecision,
      generatedAt: ISO,
      inputsDigest: SHA256,
    })
    .strict(),
]);
export type AuthorizationGateRecordV1 = z.infer<typeof AuthorizationGateRecordV1>;

declare const GATE_RECORD_VERIFIED: unique symbol;
export type VerifiedG1Record = G1StatisticalRecordV1 & { readonly [GATE_RECORD_VERIFIED]: "g1" };
export type VerifiedG2Record = G2StatisticalRecordV1 & { readonly [GATE_RECORD_VERIFIED]: "g2" };
export type VerifiedAuthorization = AuthorizationGateRecordV1 & { readonly [GATE_RECORD_VERIFIED]: "auth" };

function refuse(why: string): never {
  throw new UsageError(`gate record refused: ${why}`);
}

function sha256Text(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** Canonical digest over every field except the self-binding inputsDigest. */
function inputsDigestOf(record: { inputsDigest: string }): string {
  const { inputsDigest: _omit, ...rest } = record;
  return sha256Text(canonicalJson(rest));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample (n-1) standard deviation; zero for fewer than two observations. */
function sampleStdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - m) * (value - m), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

interface PanelMemberInfo {
  taskId: string;
  stratum: Stratum;
}

/** capsuleId → {taskId, stratum}, sourced from the frozen development panel. */
function panelIndex(config: MetaCampaignConfigV2): Map<string, PanelMemberInfo> {
  const index = new Map<string, PanelMemberInfo>();
  for (const member of config.developmentPanel.members) {
    index.set(member.capsule.capsuleId, {
      taskId: member.taskId,
      stratum: member.taskId.startsWith("OWN-") ? "owner" : "oss",
    });
  }
  return index;
}

type Grid = Map<string, Map<string, Map<number, MetaMeasurement>>>;

function buildGrid(
  measurements: readonly MetaMeasurement[],
  expectedArms: readonly string[],
  capsuleIds: ReadonlySet<string>,
  replicates: number,
): Grid {
  const grid: Grid = new Map(expectedArms.map((arm) => [arm, new Map()]));
  for (const measurement of measurements) {
    const armMap = grid.get(measurement.arm);
    if (armMap === undefined) refuse(`unexpected arm ${measurement.arm} in confirmation measurement set`);
    if (!capsuleIds.has(measurement.capsuleId)) {
      refuse(`measurement capsule ${measurement.capsuleId} is not a frozen panel member`);
    }
    if (!Number.isInteger(measurement.replicate) || measurement.replicate < 0 || measurement.replicate >= replicates) {
      refuse(`measurement replicate ${measurement.replicate} out of range for ${measurement.arm}/${measurement.capsuleId}`);
    }
    let capMap = armMap.get(measurement.capsuleId);
    if (capMap === undefined) {
      capMap = new Map();
      armMap.set(measurement.capsuleId, capMap);
    }
    if (capMap.has(measurement.replicate)) {
      refuse(`duplicate measurement ${measurement.arm}/${measurement.capsuleId}/replicate ${measurement.replicate}`);
    }
    capMap.set(measurement.replicate, measurement);
  }
  return grid;
}

function armMeasurements(grid: Grid, arm: string): MetaMeasurement[] {
  const armMap = grid.get(arm);
  if (armMap === undefined) return [];
  return [...armMap.values()].flatMap((capMap) => [...capMap.values()]);
}

function isComplete(
  grid: Grid,
  arms: readonly string[],
  capsuleIds: readonly string[],
  replicates: number,
): boolean {
  for (const arm of arms) {
    const armMap = grid.get(arm);
    if (armMap === undefined) return false;
    for (const capsuleId of capsuleIds) {
      const capMap = armMap.get(capsuleId);
      if (capMap === undefined || capMap.size !== replicates) return false;
    }
  }
  return true;
}

/** All present measurements of an arm must share one accepted identity; refuse on drift. */
function boundIdentity(grid: Grid, arm: string, expected: OptimizerIdentity, label: string): boolean {
  const rows = armMeasurements(grid, arm);
  if (rows.length === 0) return false;
  for (const row of rows) {
    if (row.sourceArtifact !== expected.sourceArtifact || row.bundleDigest !== expected.bundleDigest) {
      refuse(`${label} arm carries ${row.sourceArtifact}/${row.bundleDigest}, not the accepted ${expected.sourceArtifact}/${expected.bundleDigest}`);
    }
  }
  return true;
}

export interface ConfirmationInputSet {
  measurementCount: number;
  measurementHash: string;
}

/** The subset of confirmation-receipt.json the gate records bind against. */
const ConfirmationReceiptBinding = z
  .object({ measurementCount: z.number().int().nonnegative(), measurementHash: SHA256 })
  .passthrough();

/**
 * Read the INDEPENDENTLY-persisted confirmation-receipt.json and return its
 * measurement count + digest. Assembling a gate record against this (rather than
 * a value synthesized from the same in-memory array) makes the digest cross-check
 * a real check: the measurements handed to the record must reproduce the digest
 * the confirmation phase already committed to disk.
 */
export function readConfirmationReceipt(path: string): ConfirmationInputSet {
  const parsed = ConfirmationReceiptBinding.safeParse(readJson(path));
  if (!parsed.success) refuse(`${path} is not a readable confirmation receipt with a bound measurement digest`);
  return { measurementCount: parsed.data.measurementCount, measurementHash: parsed.data.measurementHash };
}

/**
 * Cross-check the confirmation-receipt binding: the count and digest of the
 * measurement set MUST reproduce what confirmation-receipt.json recorded, and
 * every measurement MUST validate and belong to this exact campaign config.
 */
function validateMeasurementBinding(
  config: MetaCampaignConfigV2,
  measurements: readonly MetaMeasurement[],
  receipt: ConfirmationInputSet,
  configHash: string,
): void {
  if (receipt.measurementCount !== measurements.length) {
    refuse(`receipt measurementCount ${receipt.measurementCount} does not match ${measurements.length} measurements`);
  }
  if (sha256Text(canonicalJson(measurements)) !== receipt.measurementHash) {
    refuse("measurement digest does not match confirmation-receipt measurementHash — tampered or stale");
  }
  for (const measurement of measurements) {
    const parsed = MetaMeasurementV1.safeParse(measurement);
    if (!parsed.success) refuse("confirmation measurement is not a valid MetaMeasurementV1 record");
    if (parsed.data.configHash !== configHash) {
      refuse(`measurement configHash ${parsed.data.configHash} does not belong to campaign ${configHash}`);
    }
    if (parsed.data.phase !== "confirmation") {
      refuse(`measurement phase ${parsed.data.phase} is not a confirmation measurement`);
    }
  }
}

export interface G1RecordInputs {
  config: MetaCampaignConfigV2;
  measurements: readonly MetaMeasurement[];
  receipt: ConfirmationInputSet;
  thresholds: G1GateThresholds;
  /** Accepted G0 seed identity — must match the seed-arm measurements. */
  seed: OptimizerIdentity;
  /** Accepted G1 winner identity — must match the winner-arm measurements. */
  winner: OptimizerIdentity;
  generatedAt?: string;
}

export function assembleG1Record(inputs: G1RecordInputs): VerifiedG1Record {
  const { config } = inputs;
  if (config.version !== 2 || config.generation.stage !== "A") {
    refuse("G1 record requires a stage-A M2 campaign config");
  }
  const thresholds = G1GateThresholds.parse(inputs.thresholds);
  const seed = OptimizerIdentity.parse(inputs.seed);
  const winner = OptimizerIdentity.parse(inputs.winner);
  const configHash = metaCampaignConfigHash(config);
  validateMeasurementBinding(config, inputs.measurements, inputs.receipt, configHash);

  const panel = panelIndex(config);
  const capsuleIds = [...panel.keys()];
  const replicates = config.counts.confirmationReplicates;
  const grid = buildGrid(inputs.measurements, STAGE_A_ARMS, new Set(capsuleIds), replicates);

  const perCapsule = capsuleIds.map((capsuleId) => {
    const info = panel.get(capsuleId)!;
    const seedRows = [...(grid.get("seed")?.get(capsuleId)?.values() ?? [])];
    const winnerRows = [...(grid.get("winner")?.get(capsuleId)?.values() ?? [])];
    const seedMean = mean(seedRows.map((row) => row.qNormalized));
    const winnerMean = mean(winnerRows.map((row) => row.qNormalized));
    const meanDelta = winnerMean - seedMean;
    return {
      taskId: info.taskId,
      capsuleId,
      stratum: info.stratum,
      seedMean,
      winnerMean,
      meanDelta,
      signPositive: meanDelta > thresholds.positiveSignEpsilon,
    };
  });

  const pairedDeltas: number[] = [];
  for (const capsuleId of capsuleIds) {
    const seedCap = grid.get("seed")?.get(capsuleId);
    const winnerCap = grid.get("winner")?.get(capsuleId);
    if (seedCap === undefined || winnerCap === undefined) continue;
    for (const [replicate, seedRow] of seedCap) {
      const winnerRow = winnerCap.get(replicate);
      if (winnerRow === undefined) continue;
      pairedDeltas.push(winnerRow.qNormalized - seedRow.qNormalized);
    }
  }
  const pairedMeanDelta = mean(pairedDeltas);
  const pairedStandardError = pairedDeltas.length < 2 ? 0 : sampleStdDev(pairedDeltas) / Math.sqrt(pairedDeltas.length);
  const pairedImprovementThreshold = thresholds.pairedImprovementSeMultiple * pairedStandardError;

  const seedMean = mean(armMeasurements(grid, "seed").map((row) => row.qNormalized));
  const winnerMean = mean(armMeasurements(grid, "winner").map((row) => row.qNormalized));
  const brokenControlMean = mean(armMeasurements(grid, "broken-control").map((row) => row.qNormalized));
  const degradedControlMean = mean(armMeasurements(grid, "degraded-control").map((row) => row.qNormalized));

  const taskSignPositives = perCapsule.filter((entry) => entry.signPositive).length;
  const ownerSignPositives = perCapsule.filter((entry) => entry.stratum === "owner" && entry.signPositive).length;
  const ossSignPositives = perCapsule.filter((entry) => entry.stratum === "oss" && entry.signPositive).length;

  const cardinalityComplete = isComplete(grid, STAGE_A_ARMS, capsuleIds, replicates);
  const artifactsBound = boundIdentity(grid, "seed", seed, "confirmation seed") && boundIdentity(grid, "winner", winner, "confirmation winner");

  const criteria = {
    pairedImprovement: pairedDeltas.length >= 2 && pairedMeanDelta > pairedImprovementThreshold,
    taskSigns: taskSignPositives >= MIN_TASK_SIGN_POSITIVES,
    stratumSigns: ownerSignPositives >= MIN_STRATUM_POSITIVES && ossSignPositives >= MIN_STRATUM_POSITIVES,
    controlsBelow:
      brokenControlMean < seedMean &&
      brokenControlMean < winnerMean &&
      degradedControlMean < seedMean &&
      degradedControlMean < winnerMean,
    cardinalityComplete,
    artifactsBound,
  };
  const pass = Object.values(criteria).every(Boolean);

  const body = {
    version: `${GATE_RECORDS_VERSION}/g1-statistical` as const,
    stage: "A" as const,
    configHash,
    measurementCount: inputs.measurements.length,
    measurementHash: inputs.receipt.measurementHash,
    seed,
    winner,
    thresholds,
    stats: {
      pairedSampleSize: pairedDeltas.length,
      pairedMeanDelta,
      pairedStandardError,
      pairedImprovementThreshold,
      perCapsule,
      taskSignPositives,
      ownerSignPositives,
      ossSignPositives,
      seedMean,
      winnerMean,
      brokenControlMean,
      degradedControlMean,
    },
    criteria,
    pass,
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
  };
  const record = G1StatisticalRecordV1.parse({ ...body, inputsDigest: sha256Text(canonicalJson(body)) });
  return record as VerifiedG1Record;
}

export interface G2RecordInputs {
  config: MetaCampaignConfigV2;
  measurements: readonly MetaMeasurement[];
  receipt: ConfirmationInputSet;
  thresholds: G2GateThresholds;
  /** Accepted G1-controller (target) identity — must match the seed-arm measurements. */
  target: OptimizerIdentity;
  /** Accepted best-G0-controller identity — must match the controller-control-winner arm. */
  controlWinner: OptimizerIdentity;
  /** Accepted G2 identity — must match the generation-2 arm. */
  generation2: OptimizerIdentity;
  generatedAt?: string;
}

export function assembleG2Record(inputs: G2RecordInputs): VerifiedG2Record {
  const { config } = inputs;
  if (config.version !== 2 || config.generation.stage !== "B") {
    refuse("G2 record requires a stage-B M2 campaign config");
  }
  const thresholds = G2GateThresholds.parse(inputs.thresholds);
  const target = OptimizerIdentity.parse(inputs.target);
  const controlWinner = OptimizerIdentity.parse(inputs.controlWinner);
  const generation2 = OptimizerIdentity.parse(inputs.generation2);
  const configHash = metaCampaignConfigHash(config);
  validateMeasurementBinding(config, inputs.measurements, inputs.receipt, configHash);

  const panel = panelIndex(config);
  const capsuleIds = [...panel.keys()];
  const replicates = config.counts.confirmationReplicates;
  const grid = buildGrid(inputs.measurements, STAGE_B_ARMS, new Set(capsuleIds), replicates);

  // Paired transfer: G1-controller (seed arm) vs best-G0-controller (controller-control-winner arm).
  const pairs: z.infer<typeof G2Pair>[] = [];
  const aucDeltas: number[] = [];
  for (const capsuleId of capsuleIds) {
    const info = panel.get(capsuleId)!;
    const g1Cap = grid.get("seed")?.get(capsuleId);
    const g0Cap = grid.get("controller-control-winner")?.get(capsuleId);
    if (g1Cap === undefined || g0Cap === undefined) continue;
    for (const [replicate, g1Row] of g1Cap) {
      const g0Row = g0Cap.get(replicate);
      if (g0Row === undefined) continue;
      const ordinalWin = g1Row.qNormalized > g0Row.qNormalized + thresholds.ordinalWinEpsilon;
      const tokenWin = g1Row.observed.tokens <= g0Row.observed.tokens * (1 + thresholds.tokenParityFraction);
      const pairWin = ordinalWin && tokenWin;
      aucDeltas.push(g1Row.qNormalized - g0Row.qNormalized);
      pairs.push({
        taskId: info.taskId,
        capsuleId,
        stratum: info.stratum,
        replicate,
        g1Score: g1Row.qNormalized,
        g0Score: g0Row.qNormalized,
        ordinalWin,
        g1Tokens: g1Row.observed.tokens,
        g0Tokens: g0Row.observed.tokens,
        tokenWin,
        pairWin,
      });
    }
  }
  pairs.sort((a, b) => (a.capsuleId === b.capsuleId ? a.replicate - b.replicate : a.capsuleId.localeCompare(b.capsuleId)));
  const pairWinCount = pairs.filter((pair) => pair.pairWin).length;
  const tokenWinCount = pairs.filter((pair) => pair.tokenWin).length;
  const pairWinFraction = pairs.length === 0 ? 0 : pairWinCount / pairs.length;
  const pairedMeanAucDelta = mean(aucDeltas);

  const expectedPerArm = capsuleIds.length * replicates;
  const g1Present = armMeasurements(grid, "seed").length;
  const g0Present = armMeasurements(grid, "controller-control-winner").length;
  const g1ValidYield = expectedPerArm === 0 ? 0 : g1Present / expectedPerArm;
  const g0ValidYield = expectedPerArm === 0 ? 0 : g0Present / expectedPerArm;

  // G2-vs-G1 sign / control gates on Panel B (generation-2 vs seed).
  const signPerCapsule = capsuleIds.map((capsuleId) => {
    const info = panel.get(capsuleId)!;
    const g1Mean = mean([...(grid.get("seed")?.get(capsuleId)?.values() ?? [])].map((row) => row.qNormalized));
    const g2Mean = mean([...(grid.get("generation-2")?.get(capsuleId)?.values() ?? [])].map((row) => row.qNormalized));
    const meanDelta = g2Mean - g1Mean;
    return {
      taskId: info.taskId,
      capsuleId,
      stratum: info.stratum,
      g1Mean,
      g2Mean,
      meanDelta,
      signPositive: meanDelta > thresholds.positiveSignEpsilon,
    };
  });
  const taskSignPositives = signPerCapsule.filter((entry) => entry.signPositive).length;
  const ownerSignPositives = signPerCapsule.filter((entry) => entry.stratum === "owner" && entry.signPositive).length;
  const ossSignPositives = signPerCapsule.filter((entry) => entry.stratum === "oss" && entry.signPositive).length;

  const g1Mean = mean(armMeasurements(grid, "seed").map((row) => row.qNormalized));
  const g2Mean = mean(armMeasurements(grid, "generation-2").map((row) => row.qNormalized));
  const brokenControlMean = mean(armMeasurements(grid, "broken-control").map((row) => row.qNormalized));
  const degradedControlMean = mean(armMeasurements(grid, "degraded-control").map((row) => row.qNormalized));

  const cardinalityComplete = isComplete(grid, STAGE_B_ARMS, capsuleIds, replicates);
  const artifactsBound =
    boundIdentity(grid, "seed", target, "recursive confirmation target") &&
    boundIdentity(grid, "controller-control-winner", controlWinner, "control-controller winner") &&
    boundIdentity(grid, "generation-2", generation2, "generation-2");

  const criteria = {
    pairedAucWinFraction: pairs.length > 0 && pairWinFraction >= thresholds.pairedWinFraction,
    pairedMeanAucPositive: aucDeltas.length > 0 && pairedMeanAucDelta > thresholds.positiveSignEpsilon,
    tokenParity: pairs.length > 0 && tokenWinCount === pairs.length,
    validYieldNotLower: g1ValidYield >= g0ValidYield - thresholds.validYieldToleranceFraction,
    g2SignGate:
      taskSignPositives >= MIN_TASK_SIGN_POSITIVES &&
      ownerSignPositives >= MIN_STRATUM_POSITIVES &&
      ossSignPositives >= MIN_STRATUM_POSITIVES,
    g2ControlsBelow:
      brokenControlMean < g1Mean &&
      brokenControlMean < g2Mean &&
      degradedControlMean < g1Mean &&
      degradedControlMean < g2Mean,
    cardinalityComplete,
    artifactsBound,
  };
  const pass = Object.values(criteria).every(Boolean);

  const body = {
    version: `${GATE_RECORDS_VERSION}/g2-statistical` as const,
    stage: "B" as const,
    configHash,
    measurementCount: inputs.measurements.length,
    measurementHash: inputs.receipt.measurementHash,
    target,
    controlWinner,
    generation2,
    thresholds,
    transfer: {
      pairs,
      pairWinCount,
      pairWinFraction,
      tokenWinCount,
      pairedAucSampleSize: aucDeltas.length,
      pairedMeanAucDelta,
      g1ValidYield,
      g0ValidYield,
    },
    g2Sign: {
      perCapsule: signPerCapsule,
      taskSignPositives,
      ownerSignPositives,
      ossSignPositives,
      g1Mean,
      g2Mean,
      brokenControlMean,
      degradedControlMean,
    },
    criteria,
    pass,
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
  };
  const record = G2StatisticalRecordV1.parse({ ...body, inputsDigest: sha256Text(canonicalJson(body)) });
  return record as VerifiedG2Record;
}

// ---------------------------------------------------------------------------
// Persistence + verification chokepoints.
// ---------------------------------------------------------------------------

export function verifyG1Record(record: G1StatisticalRecordV1, source = "G1 record"): VerifiedG1Record {
  const parsed = G1StatisticalRecordV1.parse(record);
  if (inputsDigestOf(parsed) !== parsed.inputsDigest) refuse(`${source} inputsDigest mismatch — drifted since assembly`);
  return parsed as VerifiedG1Record;
}

export function verifyG2Record(record: G2StatisticalRecordV1, source = "G2 record"): VerifiedG2Record {
  const parsed = G2StatisticalRecordV1.parse(record);
  if (inputsDigestOf(parsed) !== parsed.inputsDigest) refuse(`${source} inputsDigest mismatch — drifted since assembly`);
  return parsed as VerifiedG2Record;
}

export function verifyAuthorization(record: AuthorizationGateRecordV1, source = "authorization record"): VerifiedAuthorization {
  const parsed = AuthorizationGateRecordV1.parse(record);
  if (inputsDigestOf(parsed) !== parsed.inputsDigest) refuse(`${source} inputsDigest mismatch — drifted since assembly`);
  return parsed as VerifiedAuthorization;
}

function writeRecord(path: string, record: unknown): string {
  writeFileDurable(path, `${canonicalJson(record)}\n`);
  chmodSync(path, 0o600);
  return path;
}

export function writeG1Record(campaignDir: string, record: G1StatisticalRecordV1): string {
  return writeRecord(join(campaignDir, G1_RECORD_FILE), verifyG1Record(record, "G1 record to persist"));
}

export function writeG2Record(campaignDir: string, record: G2StatisticalRecordV1): string {
  return writeRecord(join(campaignDir, G2_RECORD_FILE), verifyG2Record(record, "G2 record to persist"));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    refuse(`${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readG1Record(campaignDir: string): VerifiedG1Record {
  const path = join(campaignDir, G1_RECORD_FILE);
  const parsed = G1StatisticalRecordV1.safeParse(readJson(path));
  if (!parsed.success) refuse(`${path} is not a valid G1 statistical record`);
  return verifyG1Record(parsed.data, path);
}

export function readG2Record(campaignDir: string): VerifiedG2Record {
  const path = join(campaignDir, G2_RECORD_FILE);
  const parsed = G2StatisticalRecordV1.safeParse(readJson(path));
  if (!parsed.success) refuse(`${path} is not a valid G2 statistical record`);
  return verifyG2Record(parsed.data, path);
}

export function writeAuthorization(campaignDir: string, record: AuthorizationGateRecordV1): string {
  const verified = verifyAuthorization(record, "authorization to persist");
  const file = verified.gate === "G1" ? G1_AUTHORIZATION_FILE : G2_AUTHORIZATION_FILE;
  return writeRecord(join(campaignDir, file), verified);
}

function readAuthorization(campaignDir: string, gate: "G1" | "G2"): VerifiedAuthorization {
  const path = join(campaignDir, gate === "G1" ? G1_AUTHORIZATION_FILE : G2_AUTHORIZATION_FILE);
  if (!existsSync(path)) refuse(`${gate} authorization record ${path} is absent — dispatch fails closed`);
  const parsed = AuthorizationGateRecordV1.safeParse(readJson(path));
  if (!parsed.success) refuse(`${path} is not a valid authorization record`);
  const verified = verifyAuthorization(parsed.data, path);
  if (verified.gate !== gate) refuse(`${path} authorizes ${verified.gate}, not ${gate}`);
  return verified;
}

// ---------------------------------------------------------------------------
// Human authorization assembly.
// ---------------------------------------------------------------------------

export interface G1AuthorizationInputs {
  /** configHash of the STAGE-B cell this authorization opens (not the stage-A record's hash). */
  configHash: string;
  /** The stage-A G1 statistical record being certified; produced in the stage-A cell. */
  record: G1StatisticalRecordV1;
  controlWinner: OptimizerIdentity;
  generation2: OptimizerIdentity;
  humanDecision: HumanDecision;
  generatedAt?: string;
}

/** Human authorization to open Stage B. Fails closed if the G1 statistics did not pass. */
export function assembleG1Authorization(inputs: G1AuthorizationInputs): VerifiedAuthorization {
  const record = verifyG1Record(inputs.record, "G1 record for authorization");
  if (!record.pass) refuse("G1 statistical gate did not pass — Stage B cannot be authorized");
  const humanDecision = HumanDecision.parse(inputs.humanDecision);
  const body = {
    version: `${GATE_RECORDS_VERSION}/authorization` as const,
    gate: "G1" as const,
    configHash: inputs.configHash,
    statisticalRecordDigest: record.inputsDigest,
    statisticalPass: true as const,
    acceptedArtifacts: {
      // The Stage-B target is fixed to the identity Stage A actually validated.
      target: record.winner,
      controlWinner: OptimizerIdentity.parse(inputs.controlWinner),
      generation2: OptimizerIdentity.parse(inputs.generation2),
    },
    humanDecision,
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
  };
  return verifyAuthorization(
    AuthorizationGateRecordV1.parse({ ...body, inputsDigest: sha256Text(canonicalJson(body)) }),
    "assembled G1 authorization",
  );
}

export interface G2AuthorizationInputs {
  /** configHash of the TERMINAL cell this authorization opens. */
  configHash: string;
  /** The stage-B G2 statistical record being certified. */
  record: G2StatisticalRecordV1;
  generation0: OptimizerIdentity;
  generation1: OptimizerIdentity;
  generation2: OptimizerIdentity;
  humanDecision: HumanDecision;
  generatedAt?: string;
}

/** Human authorization to open the terminal shell. Fails closed if the G2 statistics did not pass. */
export function assembleG2Authorization(inputs: G2AuthorizationInputs): VerifiedAuthorization {
  const record = verifyG2Record(inputs.record, "G2 record for authorization");
  if (!record.pass) refuse("G2 statistical gate did not pass — terminal cannot be authorized");
  const generation0 = OptimizerIdentity.parse(inputs.generation0);
  const generation1 = OptimizerIdentity.parse(inputs.generation1);
  const generation2 = OptimizerIdentity.parse(inputs.generation2);
  // Terminal artifacts MUST be the exact identities the G2 record validated:
  // G1 == record.target, G2 == record.generation2, G0 == record.controlWinner.
  if (!sameIdentity(generation2, record.generation2)) refuse("terminal generation2 is not the G2 the record validated");
  if (!sameIdentity(generation1, record.target)) refuse("terminal generation1 is not the G1 target the record validated");
  if (!sameIdentity(generation0, record.controlWinner)) refuse("terminal generation0 is not the G0 controller the record validated");
  const humanDecision = HumanDecision.parse(inputs.humanDecision);
  const body = {
    version: `${GATE_RECORDS_VERSION}/authorization` as const,
    gate: "G2" as const,
    configHash: inputs.configHash,
    statisticalRecordDigest: record.inputsDigest,
    statisticalPass: true as const,
    acceptedArtifacts: { generation0, generation1, generation2 },
    humanDecision,
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
  };
  return verifyAuthorization(
    AuthorizationGateRecordV1.parse({ ...body, inputsDigest: sha256Text(canonicalJson(body)) }),
    "assembled G2 authorization",
  );
}

// ---------------------------------------------------------------------------
// Dispatch guards — fail closed when the accepted authorization is missing or
// bound to different artifacts than the dispatch requested.
// ---------------------------------------------------------------------------

function sameIdentity(a: OptimizerIdentity, b: OptimizerIdentity): boolean {
  return a.sourceArtifact === b.sourceArtifact && a.bundleDigest === b.bundleDigest;
}

export interface StageBExpectation {
  /** The Stage-B target/G1 the dispatch will run — MUST equal the Stage-A validated winner. */
  target: OptimizerIdentity;
  controlWinner: OptimizerIdentity;
  generation2: OptimizerIdentity;
}

/**
 * Stage-B dispatch guard. Returns the verified G1 authorization or throws.
 * The G1 statistical record is produced in the (separate) stage-A cell, so the
 * authorization is self-sufficient: its schema pins statisticalPass to true,
 * assembleG1Authorization refuses a failing record, and inputsDigest binds the
 * whole token. The guard verifies gate, campaign binding and accepted artifacts.
 */
export function assertG1Authorized(
  campaignDir: string,
  configHash: string,
  expected: StageBExpectation,
): VerifiedAuthorization {
  const authorization = readAuthorization(campaignDir, "G1");
  if (authorization.gate !== "G1") refuse("G1 authorization record does not authorize the G1 gate");
  if (authorization.configHash !== configHash) {
    refuse(`G1 authorization is bound to ${authorization.configHash}, not the dispatched campaign ${configHash}`);
  }
  if (!sameIdentity(authorization.acceptedArtifacts.target, expected.target)) {
    refuse("Stage-B target does not match the Stage-A validated winner bound in the G1 authorization");
  }
  if (!sameIdentity(authorization.acceptedArtifacts.controlWinner, expected.controlWinner)) {
    refuse("Stage-B --control-winner does not match the accepted G1 authorization");
  }
  if (!sameIdentity(authorization.acceptedArtifacts.generation2, expected.generation2)) {
    refuse("Stage-B --generation2 does not match the accepted G1 authorization");
  }
  return authorization;
}

export interface TerminalExpectation {
  generation0: OptimizerIdentity;
  generation1: OptimizerIdentity;
  generation2: OptimizerIdentity;
}

/**
 * Terminal dispatch guard. Requires BOTH development gate authorizations
 * (launch-spec step 9: "iff both dev gates pass"): the G1 authorization must be
 * present and approved, and the G2 authorization must be present, approved, and
 * bound to the exact generation0/1/2 the terminal dispatch requested.
 */
export function assertG2Authorized(
  campaignDir: string,
  configHash: string,
  expected: TerminalExpectation,
): VerifiedAuthorization {
  // Both development gates must have been authorized.
  const g1Authorization = readAuthorization(campaignDir, "G1");
  if (g1Authorization.gate !== "G1") refuse("G1 authorization record does not authorize the G1 gate");
  if (g1Authorization.configHash !== configHash) {
    refuse(`G1 authorization is bound to ${g1Authorization.configHash}, not the dispatched campaign ${configHash}`);
  }
  const authorization = readAuthorization(campaignDir, "G2");
  if (authorization.gate !== "G2") refuse("G2 authorization record does not authorize the G2 gate");
  if (authorization.configHash !== configHash) {
    refuse(`G2 authorization is bound to ${authorization.configHash}, not the dispatched campaign ${configHash}`);
  }
  const record = readG2Record(campaignDir);
  if (record.configHash !== configHash) refuse("G2 statistical record does not belong to the dispatched campaign");
  if (record.inputsDigest !== authorization.statisticalRecordDigest) {
    refuse("G2 authorization statisticalRecordDigest does not match the on-disk G2 record — drifted");
  }
  if (!record.pass) refuse("on-disk G2 statistical record does not pass — terminal fails closed");
  // Belt-and-suspenders: the accepted terminal artifacts must equal the identities
  // the on-disk G2 record actually validated (a passing record for candidate G
  // cannot authorize dispatch of a different, unvalidated G').
  if (!sameIdentity(authorization.acceptedArtifacts.generation2, record.generation2)) {
    refuse("G2 authorization generation2 does not match the identity the on-disk G2 record validated");
  }
  if (!sameIdentity(authorization.acceptedArtifacts.generation1, record.target)) {
    refuse("G2 authorization generation1 does not match the G1 target the on-disk G2 record validated");
  }
  if (!sameIdentity(authorization.acceptedArtifacts.generation0, record.controlWinner)) {
    refuse("G2 authorization generation0 does not match the G0 controller the on-disk G2 record validated");
  }
  if (!sameIdentity(authorization.acceptedArtifacts.generation0, expected.generation0)) {
    refuse("terminal --generation0 does not match the accepted G2 authorization");
  }
  if (!sameIdentity(authorization.acceptedArtifacts.generation1, expected.generation1)) {
    refuse("terminal --generation1 does not match the accepted G2 authorization");
  }
  if (!sameIdentity(authorization.acceptedArtifacts.generation2, expected.generation2)) {
    refuse("terminal --generation2 does not match the accepted G2 authorization");
  }
  // The generation2 that G1 authorized for Stage B must be the generation2 reaching terminal.
  if (!sameIdentity(g1Authorization.acceptedArtifacts.generation2, expected.generation2)) {
    refuse("terminal --generation2 does not match the generation2 accepted at the G1 gate");
  }
  return authorization;
}

/** Load + validate the owner-supplied gate-thresholds file; fails closed if any block is unset. */
export function readGateThresholdsFile(path: string): GateThresholdsFileV1 {
  const parsed = GateThresholdsFileV1.safeParse(readJson(path));
  if (!parsed.success) {
    refuse(`${path} is not a complete ${GATE_RECORDS_VERSION} gate-thresholds file (owner input required)`);
  }
  return parsed.data;
}
