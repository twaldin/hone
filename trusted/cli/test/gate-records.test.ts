import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  M2_INNER_MODEL_ROUTE,
  M2_OUTER_MODEL_ROUTE,
  M2_PANEL_A_TASK_IDS,
  M2_PANEL_B_TASK_IDS,
  MetaCampaignConfigV1,
  MetaCampaignConfigV2,
  canonicalJson,
  type BudgetEnvelope,
  type MetaCampaignConfigV1 as LegacyConfig,
  type MetaCampaignConfigV2 as RecursiveConfig,
} from "@hone/schema";
import { metaCampaignConfigHash, type MetaMeasurement } from "@hone/meta";
import { describe, expect, it } from "vitest";
import {
  GATE_RECORDS_VERSION,
  assembleG1Authorization,
  assembleG1Record,
  assembleG2Authorization,
  assembleG2Record,
  assertG1Authorized,
  assertG2Authorized,
  readG1Record,
  readConfirmationReceipt,
  readGateThresholdsFile,
  verifyAuthorization,
  verifyG1Record,
  verifyG2Record,
  writeAuthorization,
  writeG1Record,
  writeG2Record,
  type G1GateThresholds,
  type G2GateThresholds,
  type HumanDecision,
  type OptimizerIdentity,
} from "../src/gate-records.js";

const fixturePath = fileURLToPath(new URL("../../../schema/fixtures/meta-campaign.m1.json", import.meta.url));

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
const sha = (content: string): `sha256:${string}` => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const hex64 = (value: string): string => createHash("sha256").update(value).digest("hex");

const G1_THRESHOLDS: G1GateThresholds = { pairedImprovementSeMultiple: 2, positiveSignEpsilon: 0 };
const G2_THRESHOLDS: G2GateThresholds = {
  pairedWinFraction: 2 / 3,
  ordinalWinEpsilon: 0,
  tokenParityFraction: 0,
  validYieldToleranceFraction: 0,
  positiveSignEpsilon: 0,
};

const HUMAN: HumanDecision = {
  approver: "owner",
  decision: "approved",
  diffConfinedIntelligible: true,
  mechanismPlausible: true,
  reason: "confined intelligible diff, plausible mechanism",
  decidedAt: "2026-07-24T00:00:00.000Z",
};

const ID = {
  seed: { sourceArtifact: digest("id:seed:src"), bundleDigest: digest("id:seed:bundle") },
  winner: { sourceArtifact: digest("id:winner:src"), bundleDigest: digest("id:winner:bundle") },
  target: { sourceArtifact: digest("id:target:src"), bundleDigest: digest("id:target:bundle") },
  controlWinner: { sourceArtifact: digest("id:cw:src"), bundleDigest: digest("id:cw:bundle") },
  gen0: { sourceArtifact: digest("id:g0:src"), bundleDigest: digest("id:g0:bundle") },
  gen1: { sourceArtifact: digest("id:g1:src"), bundleDigest: digest("id:g1:bundle") },
  gen2: { sourceArtifact: digest("id:g2:src"), bundleDigest: digest("id:g2:bundle") },
  broken: { sourceArtifact: digest("id:broken:src"), bundleDigest: digest("id:broken:bundle") },
  degraded: { sourceArtifact: digest("id:degraded:src"), bundleDigest: digest("id:degraded:bundle") },
} satisfies Record<string, OptimizerIdentity>;

function legacyConfig(): LegacyConfig {
  return MetaCampaignConfigV1.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
}

function multiply(budget: BudgetEnvelope, factor: number): BudgetEnvelope {
  return {
    maxTokens: budget.maxTokens * factor,
    maxUsd: budget.maxUsd * factor,
    maxWallClockSec: budget.maxWallClockSec * factor,
    maxEvaluatorInvocations: budget.maxEvaluatorInvocations * factor,
  };
}

/** A valid V2 campaign config for the requested stage; capsuleIds are cap_000000000001..08. */
function buildConfig(stage: "A" | "B"): RecursiveConfig {
  const legacy = legacyConfig();
  const capsule = (index: number) => ({
    ...legacy.train[0]!,
    capsuleId: `cap_${index.toString(16).padStart(12, "0")}`,
    capsuleDigest: digest(`recursive:capsule:${index}`),
    image: `hone-task-${index}@${digest(`recursive:image:${index}`)}`,
    oracleDigest: digest(`recursive:oracle:${index}`),
    scalarizerDigest: digest(`recursive:scalarizer:${index}`),
  });
  const train = Array.from({ length: 8 }, (_, index) => capsule(index + 1));
  const holdout = Array.from({ length: 11 }, (_, index) => capsule(index + 101));
  const child = { ...legacy.budgets.child };
  const calibratedPanelCandidate = multiply(child, 8);
  const target = {
    sourceCommit: "1".repeat(40),
    sourceArtifact: digest("recursive:target-source"),
    bundleDigest: digest("recursive:target-bundle"),
  };
  const controller = stage === "A"
    ? target
    : { sourceCommit: "1".repeat(40), sourceArtifact: digest("recursive:controller-source"), bundleDigest: digest("recursive:controller-bundle") };
  const panelTasks = stage === "A" ? M2_PANEL_A_TASK_IDS : M2_PANEL_B_TASK_IDS;
  const confirmationRuns = (stage === "A" ? 4 : 5) * 8 * 3;
  return MetaCampaignConfigV2.parse({
    ...legacy,
    version: 2,
    seedOptimizer: target,
    controllerOptimizer: controller,
    optimizerRuntime: { image: `hone-optimizer@${digest("recursive:optimizer-image")}` },
    generation: stage === "A"
      ? { stage: "A", panel: "A", targetGeneration: 0, controllerGeneration: 0, outerReplicate: 0 }
      : { stage: "B", panel: "B", targetGeneration: 1, controllerGeneration: 0, outerReplicate: 0 },
    calibration: {
      reportDigest: digest("recursive:calibration-report"),
      excludedCapsuleIds: Array.from({ length: 4 }, (_, index) => `cap_${(2001 + index).toString(16).padStart(12, "0")}`),
    },
    corpusCohort: {
      developmentCapsuleIds: [
        ...train.map((entry) => entry.capsuleId),
        ...Array.from({ length: 8 }, (_, index) => `cap_${(2101 + index).toString(16).padStart(12, "0")}`),
      ],
      terminalCapsuleIds: holdout.map((entry) => entry.capsuleId),
      provenanceInputsDigest: digest("recursive:corpus-provenance"),
    },
    train,
    holdout,
    routing: { outerMutation: M2_OUTER_MODEL_ROUTE, innerMutation: M2_INNER_MODEL_ROUTE },
    modelObservation: {
      outerRequestedRoute: M2_OUTER_MODEL_ROUTE,
      innerRequestedRoute: M2_INNER_MODEL_ROUTE,
      identity: "alias-observation",
      recordResponseModel: true,
      recordProviderFingerprint: true,
      driftSentinel: true,
    },
    counts: {
      candidates: 37,
      candidateAttemptsMax: 91,
      innerEpisodesMax: 8,
      searchReplicates: 5,
      confirmationReplicates: 3,
      holdoutReplicates: 3,
      childConcurrency: 2,
    },
    budgets: { ...legacy.budgets, outer: { ...legacy.budgets.outer, maxEvaluatorInvocations: 92 } },
    developmentPanel: {
      panel: stage,
      members: train.map((entry, index) => ({
        taskId: panelTasks[index],
        capsule: entry,
        calibratedInnerCeiling: child,
      })),
    },
    recursiveBudgets: {
      search: {
        identity: { envelopeId: digest("recursive:search-envelope"), purpose: "search" },
        calibratedPanelCandidate,
        outerTrajectory: multiply(calibratedPanelCandidate, 12),
      },
      confirmation: {
        identity: { envelopeId: digest("recursive:confirmation-envelope"), purpose: "confirmation" },
        budget: multiply(child, confirmationRuns),
      },
      terminal: {
        identity: { envelopeId: digest("recursive:terminal-envelope"), purpose: "terminal" },
        budget: multiply(child, 3 * 11 * 3),
      },
    },
    allowedClaim: "recursive-transfer-frozen-corpus",
  });
}

interface ArmSpec {
  arm: string;
  identity: OptimizerIdentity;
  score: (capIndex: number, rep: number) => number;
  tokens?: (capIndex: number, rep: number) => number;
  /** Replicate indices to emit; defaults to all confirmationReplicates. */
  reps?: (capIndex: number) => number[];
}

function makeMeasurement(
  config: RecursiveConfig,
  spec: ArmSpec,
  capIndex: number,
  replicate: number,
): MetaMeasurement {
  const member = config.developmentPanel.members[capIndex]!;
  const key = `${spec.arm}:${member.capsule.capsuleId}:${replicate}`;
  return {
    configHash: metaCampaignConfigHash(config),
    protocolHash: digest("protocol"),
    analysisConfigHash: digest("analysis"),
    phase: "confirmation",
    arm: spec.arm as MetaMeasurement["arm"],
    sourceArtifact: spec.identity.sourceArtifact as `sha256:${string}`,
    bundleDigest: spec.identity.bundleDigest as `sha256:${string}`,
    capsuleId: member.capsule.capsuleId,
    capsuleDigest: member.capsule.capsuleDigest as `sha256:${string}`,
    replicate,
    measurementEpoch: `m2:${key}`,
    requestedModel: M2_INNER_MODEL_ROUTE,
    responseModel: M2_INNER_MODEL_ROUTE,
    providerFingerprint: null,
    modelDriftSentinel: "stable:x",
    workKey: sha(`workkey:${key}`),
    childRunId: `run_meta_${hex64(key)}`,
    evidenceHash: sha(`evidence:${key}`),
    reserved: { maxTokens: 1000, maxUsd: 1, maxWallClockSec: 60, maxEvaluatorInvocations: 40 },
    observed: {
      tokens: spec.tokens ? spec.tokens(capIndex, replicate) : 100,
      usd: 0.1,
      wallClockSec: 1,
      evaluatorInvocations: 4,
    },
    qRaw: spec.score(capIndex, replicate),
    qBase: 0,
    scale: 1,
    qNormalized: spec.score(capIndex, replicate),
  };
}

function buildMeasurements(config: RecursiveConfig, specs: readonly ArmSpec[]): MetaMeasurement[] {
  const reps = config.counts.confirmationReplicates;
  const out: MetaMeasurement[] = [];
  for (const spec of specs) {
    for (let capIndex = 0; capIndex < config.developmentPanel.members.length; capIndex += 1) {
      const replicates = spec.reps ? spec.reps(capIndex) : Array.from({ length: reps }, (_, r) => r);
      for (const replicate of replicates) {
        out.push(makeMeasurement(config, spec, capIndex, replicate));
      }
    }
  }
  return out;
}

function receiptFor(measurements: readonly MetaMeasurement[]): { measurementCount: number; measurementHash: string } {
  return { measurementCount: measurements.length, measurementHash: sha(canonicalJson(measurements)) };
}

const constant = (value: number) => () => value;

/** A fully-passing Stage-A measurement set: winner clearly beats seed, controls below both. */
function passingG1Specs(): ArmSpec[] {
  return [
    { arm: "seed", identity: ID.seed, score: constant(0.1) },
    { arm: "winner", identity: ID.winner, score: constant(0.3) },
    { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
    { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
  ];
}

/** A fully-passing Stage-B measurement set: G1-controller beats G0-controller by score AND tokens; G2 beats G1. */
function passingG2Specs(): ArmSpec[] {
  return [
    { arm: "seed", identity: ID.target, score: constant(0.3), tokens: constant(90) },
    { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
    { arm: "generation-2", identity: ID.gen2, score: constant(0.4), tokens: constant(90) },
    { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
    { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
  ];
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hone-gate-records-"));
}

describe("assembleG1Record: Stage-A statistical gate", () => {
  it("passes when winner beats seed across every capsule with controls below", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
      generatedAt: HUMAN.decidedAt,
    });
    expect(measurements).toHaveLength(96);
    expect(record.criteria).toEqual({
      pairedImprovement: true,
      taskSigns: true,
      stratumSigns: true,
      controlsBelow: true,
      cardinalityComplete: true,
      artifactsBound: true,
    });
    expect(record.pass).toBe(true);
    expect(record.stats.taskSignPositives).toBe(8);
    expect(record.stats.ownerSignPositives).toBe(4);
    expect(record.stats.ossSignPositives).toBe(4);
    // Digest binding round-trips.
    expect(verifyG1Record(record)).toEqual(record);
  });

  it("fails paired-improvement when the mean delta is within 2*SE", () => {
    const config = buildConfig("A");
    // seed constant, winner = seed + high-variance near-zero-mean noise.
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1) },
      {
        arm: "winner",
        identity: ID.winner,
        score: (capIndex, rep) => 0.1 + (((capIndex * 3 + rep) % 2 === 0) ? 0.3 : -0.28),
      },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(-0.1) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.criteria.pairedImprovement).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails task-signs when fewer than 6/8 capsules improve", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1) },
      { arm: "winner", identity: ID.winner, score: (capIndex) => (capIndex < 5 ? 0.3 : 0.05) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.01) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.stats.taskSignPositives).toBe(5);
    expect(record.criteria.taskSigns).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails stratum-signs when a stratum has fewer than 3/4 positive even with 6/8 overall", () => {
    const config = buildConfig("A");
    // Owner (capIndex 0-3): only 0,1 improve. OSS (capIndex 4-7): all improve. Total 6/8.
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1) },
      { arm: "winner", identity: ID.winner, score: (capIndex) => (capIndex === 2 || capIndex === 3 ? 0.05 : 0.3) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.01) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.stats.taskSignPositives).toBe(6);
    expect(record.criteria.taskSigns).toBe(true);
    expect(record.stats.ownerSignPositives).toBe(2);
    expect(record.criteria.stratumSigns).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails controls-below when a control is not under both G0 and G1", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1) },
      { arm: "winner", identity: ID.winner, score: constant(0.3) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.2) }, // above seed 0.1
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.criteria.controlsBelow).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("refuses when the measurement digest does not match the confirmation receipt", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    expect(() =>
      assembleG1Record({
        config,
        measurements,
        receipt: { measurementCount: measurements.length, measurementHash: sha("tampered") },
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.winner,
      }),
    ).toThrow(/measurement digest does not match/);
  });

  it("refuses when a measurement carries a foreign configHash", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    measurements[0] = { ...measurements[0]!, configHash: digest("foreign") };
    expect(() =>
      assembleG1Record({
        config,
        measurements,
        receipt: receiptFor(measurements),
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.winner,
      }),
    ).toThrow(/does not belong to campaign/);
  });

  it("refuses an unexpected arm and a duplicate replicate", () => {
    const config = buildConfig("A");
    const base = buildMeasurements(config, passingG1Specs());
    const foreignArm = [{ ...base[0]!, arm: "generation-0" as MetaMeasurement["arm"] }];
    expect(() =>
      assembleG1Record({
        config,
        measurements: foreignArm,
        receipt: receiptFor(foreignArm),
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.winner,
      }),
    ).toThrow(/unexpected arm/);
    const dup = [base[0]!, { ...base[0]! }];
    expect(() =>
      assembleG1Record({
        config,
        measurements: dup,
        receipt: receiptFor(dup),
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.winner,
      }),
    ).toThrow(/duplicate measurement/);
  });

  it("refuses when the accepted winner identity does not match the winner arm", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    expect(() =>
      assembleG1Record({
        config,
        measurements,
        receipt: receiptFor(measurements),
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.seed, // wrong — winner arm carries ID.winner
      }),
    ).toThrow(/does not carry|not the accepted/);
  });

  it("marks cardinality incomplete when a replicate is missing", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1), reps: (capIndex) => (capIndex === 0 ? [0, 1] : [0, 1, 2]) },
      { arm: "winner", identity: ID.winner, score: constant(0.3) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.criteria.cardinalityComplete).toBe(false);
    expect(record.pass).toBe(false);
  });
});

describe("assembleG2Record: Stage-B paired transfer gate", () => {
  it("passes when the G1-controller wins on ordinal + tokens and G2 improves over G1", () => {
    const config = buildConfig("B");
    const measurements = buildMeasurements(config, passingG2Specs());
    const record = assembleG2Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
      generatedAt: HUMAN.decidedAt,
    });
    expect(measurements).toHaveLength(120);
    expect(record.criteria).toEqual({
      pairedAucWinFraction: true,
      pairedMeanAucPositive: true,
      tokenParity: true,
      validYieldNotLower: true,
      g2SignGate: true,
      g2ControlsBelow: true,
      cardinalityComplete: true,
      artifactsBound: true,
    });
    expect(record.pass).toBe(true);
    expect(record.transfer.pairWinCount).toBe(24);
    expect(record.transfer.pairWinFraction).toBe(1);
    expect(verifyG2Record(record)).toEqual(record);
  });

  it("fails the win fraction when the G1-controller wins too few pairs", () => {
    const config = buildConfig("B");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.target, score: (capIndex) => (capIndex < 3 ? 0.3 : 0.05), tokens: constant(90) },
      { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
      { arm: "generation-2", identity: ID.gen2, score: constant(0.4), tokens: constant(90) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.02) },
    ]);
    const record = assembleG2Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    expect(record.transfer.pairWinCount).toBe(9);
    expect(record.criteria.pairedAucWinFraction).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails token parity when the G1-controller spends more tokens", () => {
    const config = buildConfig("B");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.target, score: constant(0.3), tokens: constant(200) },
      { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
      { arm: "generation-2", identity: ID.gen2, score: constant(0.4), tokens: constant(90) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.02) },
    ]);
    const record = assembleG2Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    expect(record.criteria.tokenParity).toBe(false);
    expect(record.criteria.pairedAucWinFraction).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails valid-yield and cardinality when the G1-controller produced fewer measurements", () => {
    const config = buildConfig("B");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.target, score: constant(0.3), tokens: constant(90), reps: (capIndex) => (capIndex < 2 ? [0] : [0, 1, 2]) },
      { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
      { arm: "generation-2", identity: ID.gen2, score: constant(0.4), tokens: constant(90) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.02) },
    ]);
    const record = assembleG2Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    expect(record.transfer.g1ValidYield).toBeLessThan(1);
    expect(record.transfer.g0ValidYield).toBe(1);
    expect(record.criteria.validYieldNotLower).toBe(false);
    expect(record.criteria.cardinalityComplete).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("requires a stage-B config", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    expect(() =>
      assembleG2Record({
        config,
        measurements,
        receipt: receiptFor(measurements),
        thresholds: G2_THRESHOLDS,
        target: ID.target,
        controlWinner: ID.controlWinner,
        generation2: ID.gen2,
      }),
    ).toThrow(/requires a stage-B/);
  });
});

describe("digest tamper refusal", () => {
  it("refuses a G1 record whose statistic drifted after assembly", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    const tampered = { ...record, pass: false };
    expect(() => verifyG1Record(tampered)).toThrow(/inputsDigest mismatch/);
  });

  it("refuses an authorization record tampered on disk", () => {
    const config = buildConfig("A");
    const dir = tmp();
    const measurements = buildMeasurements(config, passingG1Specs());
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    const authorization = assembleG1Authorization({
      configHash: metaCampaignConfigHash(buildConfig("B")),
      record,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
      humanDecision: HUMAN,
    });
    const path = writeAuthorization(dir, authorization);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, canonicalJson({ ...onDisk, acceptedArtifacts: { ...onDisk.acceptedArtifacts, generation2: ID.gen0 } }));
    expect(() => verifyAuthorization(JSON.parse(readFileSync(path, "utf8")))).toThrow(/inputsDigest mismatch/);
  });
});

describe("human authorization assembly fails closed on failing statistics", () => {
  it("refuses to authorize Stage B from a failing G1 record", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.3) },
      { arm: "winner", identity: ID.winner, score: constant(0.1) }, // winner worse than seed
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.pass).toBe(false);
    expect(() =>
      assembleG1Authorization({
        configHash: metaCampaignConfigHash(buildConfig("B")),
        record,
        controlWinner: ID.controlWinner,
        generation2: ID.gen2,
        humanDecision: HUMAN,
      }),
    ).toThrow(/did not pass/);
  });
});

describe("dispatch guards fail closed", () => {
  function seededStageB(): { dir: string; stageBHash: string } {
    const stageA = buildConfig("A");
    const stageB = buildConfig("B");
    const stageBHash = metaCampaignConfigHash(stageB);
    const dir = tmp();
    const measurements = buildMeasurements(stageA, passingG1Specs());
    const record = assembleG1Record({
      config: stageA,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    const authorization = assembleG1Authorization({
      configHash: stageBHash,
      record,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
      humanDecision: HUMAN,
    });
    writeAuthorization(dir, authorization);
    return { dir, stageBHash };
  }

  const STAGE_B_EXPECT = { target: ID.winner, controlWinner: ID.controlWinner, generation2: ID.gen2 };
  // Terminal artifacts MUST be the identities the G2 record validated:
  // G0 == controlWinner, G1 == target, G2 == generation2.
  const TERMINAL_EXPECT = { generation0: ID.controlWinner, generation1: ID.target, generation2: ID.gen2 };

  function seededG2(dir: string, stageBHash: string): void {
    const stageB = buildConfig("B");
    const measurements = buildMeasurements(stageB, passingG2Specs());
    const g2Record = assembleG2Record({
      config: stageB,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    writeG2Record(dir, g2Record);
    writeAuthorization(dir, assembleG2Authorization({
      configHash: stageBHash,
      record: g2Record,
      generation0: ID.controlWinner,
      generation1: ID.target,
      generation2: ID.gen2,
      humanDecision: HUMAN,
    }));
  }

  it("Stage B refuses when the G1 authorization is absent", () => {
    const stageBHash = metaCampaignConfigHash(buildConfig("B"));
    expect(() => assertG1Authorized(tmp(), stageBHash, STAGE_B_EXPECT)).toThrow(/absent/);
  });

  it("Stage B accepts the matching G1 authorization and refuses mismatched artifacts", () => {
    const { dir, stageBHash } = seededStageB();
    expect(assertG1Authorized(dir, stageBHash, STAGE_B_EXPECT).gate).toBe("G1");
    expect(() => assertG1Authorized(dir, stageBHash, { ...STAGE_B_EXPECT, controlWinner: ID.seed }))
      .toThrow(/control-winner/);
    expect(() => assertG1Authorized(dir, metaCampaignConfigHash(buildConfig("A")), STAGE_B_EXPECT))
      .toThrow(/not the dispatched campaign/);
  });

  it("Stage B refuses when the dispatched target is not the Stage-A validated winner", () => {
    const { dir, stageBHash } = seededStageB();
    // The G1 authorization binds target = record.winner (ID.winner); a different Stage-B target fails closed.
    expect(() => assertG1Authorized(dir, stageBHash, { ...STAGE_B_EXPECT, target: ID.target }))
      .toThrow(/Stage-B target does not match/);
  });

  it("terminal requires both G1 and G2 authorizations and the matching artifacts", () => {
    const { dir, stageBHash } = seededStageB();
    // G2 authorization missing → fail closed.
    expect(() => assertG2Authorized(dir, stageBHash, TERMINAL_EXPECT)).toThrow(/G2 authorization/);
    seededG2(dir, stageBHash);
    expect(assertG2Authorized(dir, stageBHash, TERMINAL_EXPECT).gate).toBe("G2");
    // Mismatched terminal artifact → fail closed.
    expect(() => assertG2Authorized(dir, stageBHash, { ...TERMINAL_EXPECT, generation0: ID.gen0 }))
      .toThrow(/generation0/);
  });

  it("terminal refuses when the G1 dev gate authorization is absent", () => {
    const stageBHash = metaCampaignConfigHash(buildConfig("B"));
    const dir = tmp();
    seededG2(dir, stageBHash);
    // No G1 authorization present.
    expect(() => assertG2Authorized(dir, stageBHash, TERMINAL_EXPECT)).toThrow(/absent/);
  });

  it("terminal refuses when the on-disk G2 record drifted from the authorization", () => {
    const { dir, stageBHash } = seededStageB();
    seededG2(dir, stageBHash);
    // Overwrite the persisted G2 record with a different validated set (different G2 identity).
    const stageB = buildConfig("B");
    const drifted = buildMeasurements(stageB, [
      { arm: "seed", identity: ID.target, score: constant(0.3), tokens: constant(90) },
      { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
      { arm: "generation-2", identity: ID.gen0, score: constant(0.4), tokens: constant(90) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    writeG2Record(dir, assembleG2Record({
      config: stageB,
      measurements: drifted,
      receipt: receiptFor(drifted),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen0,
    }));
    expect(() => assertG2Authorized(dir, stageBHash, TERMINAL_EXPECT)).toThrow(/drifted/);
  });

  it("refuses to authorize terminal for artifacts the G2 record did not validate", () => {
    const stageB = buildConfig("B");
    const measurements = buildMeasurements(stageB, passingG2Specs());
    const g2Record = assembleG2Record({
      config: stageB,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    const configHash = metaCampaignConfigHash(stageB);
    // Wrong G2 (generation2 != record.generation2).
    expect(() => assembleG2Authorization({ configHash, record: g2Record, generation0: ID.controlWinner, generation1: ID.target, generation2: ID.gen0, humanDecision: HUMAN }))
      .toThrow(/generation2 is not the G2/);
    // Wrong G1 (generation1 != record.target).
    expect(() => assembleG2Authorization({ configHash, record: g2Record, generation0: ID.controlWinner, generation1: ID.gen1, generation2: ID.gen2, humanDecision: HUMAN }))
      .toThrow(/generation1 is not the G1 target/);
    // Wrong G0 (generation0 != record.controlWinner).
    expect(() => assembleG2Authorization({ configHash, record: g2Record, generation0: ID.gen0, generation1: ID.target, generation2: ID.gen2, humanDecision: HUMAN }))
      .toThrow(/generation0 is not the G0 controller/);
  });

  it("round-trips a persisted G1 record and reads it back verified", () => {
    const config = buildConfig("A");
    const dir = tmp();
    const measurements = buildMeasurements(config, passingG1Specs());
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    writeG1Record(dir, record);
    expect(readG1Record(dir)).toEqual(record);
  });
});

describe("owner threshold file fails closed when unset", () => {
  it("refuses a thresholds file missing the g2 block", () => {
    const dir = tmp();
    const path = join(dir, "gate-thresholds.json");
    writeFileSync(path, JSON.stringify({ version: GATE_RECORDS_VERSION, g1: G1_THRESHOLDS }));
    expect(() => readGateThresholdsFile(path)).toThrow(/owner input required/);
  });

  it("loads a complete thresholds file", () => {
    const dir = tmp();
    const path = join(dir, "gate-thresholds.json");
    writeFileSync(path, JSON.stringify({ version: GATE_RECORDS_VERSION, g1: G1_THRESHOLDS, g2: G2_THRESHOLDS }));
    expect(readGateThresholdsFile(path)).toEqual({ version: GATE_RECORDS_VERSION, g1: G1_THRESHOLDS, g2: G2_THRESHOLDS });
  });
});

describe("gate records bind against the independently persisted confirmation receipt", () => {
  it("reads the persisted receipt and refuses when the measurement set does not reproduce its digest", () => {
    const config = buildConfig("A");
    const dir = tmp();
    const measurements = buildMeasurements(config, passingG1Specs());
    const receiptPath = join(dir, "confirmation-receipt.json");
    // The confirmation phase persists this; the gate binds against it, not an inline value.
    writeFileSync(receiptPath, canonicalJson({ version: 1, phase: "confirmation", ...receiptFor(measurements) }));
    const persisted = readConfirmationReceipt(receiptPath);
    expect(persisted.measurementCount).toBe(96);
    // Assembling against the persisted receipt with the confirmed set succeeds.
    expect(assembleG1Record({ config, measurements, receipt: persisted, thresholds: G1_THRESHOLDS, seed: ID.seed, winner: ID.winner }).pass).toBe(true);
    // A tampered persisted receipt digest is refused.
    const tamperedPath = join(dir, "tampered-receipt.json");
    writeFileSync(tamperedPath, canonicalJson({ version: 1, phase: "confirmation", measurementCount: 96, measurementHash: sha("not-the-set") }));
    expect(() =>
      assembleG1Record({ config, measurements, receipt: readConfirmationReceipt(tamperedPath), thresholds: G1_THRESHOLDS, seed: ID.seed, winner: ID.winner }),
    ).toThrow(/measurement digest does not match/);
  });

  it("refuses a malformed confirmation receipt", () => {
    const dir = tmp();
    const path = join(dir, "confirmation-receipt.json");
    writeFileSync(path, JSON.stringify({ version: 1, phase: "confirmation", measurementCount: 96 }));
    expect(() => readConfirmationReceipt(path)).toThrow(/bound measurement digest/);
  });
});
