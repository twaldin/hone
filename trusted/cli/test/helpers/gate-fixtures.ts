import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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
import type {
  G1GateThresholds,
  G2GateThresholds,
  HumanDecision,
  OptimizerIdentity,
} from "../../src/gate-records.js";

/**
 * Offline gate-record fixtures shared by the gate-records unit tests and the
 * recursive-command integration tests. Nothing here touches a provider or a
 * campaign runtime: configs are synthetic V2 cells, measurements are hand-built
 * confirmation rows, and approvals are synthetic owner decisions.
 */

const fixturePath = fileURLToPath(new URL("../../../../schema/fixtures/meta-campaign.m1.json", import.meta.url));

export function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
export const sha = (content: string): `sha256:${string}` => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const hex64 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const G1_THRESHOLDS: G1GateThresholds = { pairedImprovementSeMultiple: 2, positiveSignEpsilon: 0 };
export const G2_THRESHOLDS: G2GateThresholds = {
  pairedWinFraction: 2 / 3,
  ordinalWinEpsilon: 0,
  tokenParityFraction: 0,
  validYieldToleranceFraction: 0,
  positiveSignEpsilon: 0,
};

export const HUMAN: HumanDecision = {
  approver: "owner",
  decision: "approved",
  diffConfinedIntelligible: true,
  mechanismPlausible: true,
  reason: "confined intelligible diff, plausible mechanism",
  decidedAt: "2026-07-24T00:00:00.000Z",
};

/**
 * Synthetic optimizer identities. `seed`/`winner` are the Stage-A G0/G1 pair
 * the passing G1 record validates; the default Stage-B config targets `winner`
 * and (for controllerGeneration 0) controls with `seed`, so a G1 search
 * approval assembled from the passing G1 record accepts `buildConfig("B")`.
 */
export const ID = {
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

const SOURCE_COMMIT = "1".repeat(40);

export interface BuildConfigOptions {
  /** Stage-B target (seedOptimizer); defaults to ID.winner. Ignored for stage A (always ID.seed). */
  target?: OptimizerIdentity;
  /** Stage-B controller; defaults to ID.seed for controllerGeneration 0 and to the target for 1. */
  controller?: OptimizerIdentity;
  /** Stage-B controller generation; defaults to 0. */
  controllerGeneration?: 0 | 1;
}

/**
 * A valid V2 campaign config for the requested stage; capsuleIds are
 * cap_000000000001..08. Stage A is the G0 cell (target == controller == ID.seed).
 * Stage B defaults to the cell a passing G1 record opens: target ID.winner,
 * controller ID.seed (generation 0) or ID.winner (generation 1).
 */
export function buildConfig(stage: "A" | "B", options: BuildConfigOptions = {}): RecursiveConfig {
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
  const controllerGeneration = options.controllerGeneration ?? 0;
  const targetIdentity = stage === "A" ? ID.seed : options.target ?? ID.winner;
  const controllerIdentity = stage === "A"
    ? targetIdentity
    : options.controller ?? (controllerGeneration === 1 ? targetIdentity : ID.seed);
  const target = { sourceCommit: SOURCE_COMMIT, ...targetIdentity };
  const controller = { sourceCommit: SOURCE_COMMIT, ...controllerIdentity };
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
      : { stage: "B", panel: "B", targetGeneration: 1, controllerGeneration, outerReplicate: 0 },
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

export interface ArmSpec {
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

export function buildMeasurements(config: RecursiveConfig, specs: readonly ArmSpec[]): MetaMeasurement[] {
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

export function receiptFor(measurements: readonly MetaMeasurement[]): { measurementCount: number; measurementHash: string } {
  return { measurementCount: measurements.length, measurementHash: sha(canonicalJson(measurements)) };
}

export const constant = (value: number) => () => value;

/** A fully-passing Stage-A measurement set: winner clearly beats seed, controls below both. */
export function passingG1Specs(): ArmSpec[] {
  return [
    { arm: "seed", identity: ID.seed, score: constant(0.1) },
    { arm: "winner", identity: ID.winner, score: constant(0.3) },
    { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
    { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
  ];
}

/** A fully-passing Stage-B measurement set: G1-controller beats G0-controller by score AND tokens; G2 beats G1. */
export function passingG2Specs(): ArmSpec[] {
  return [
    { arm: "seed", identity: ID.target, score: constant(0.3), tokens: constant(90) },
    { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
    { arm: "generation-2", identity: ID.gen2, score: constant(0.4), tokens: constant(90) },
    { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
    { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
  ];
}

export function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hone-gate-records-"));
}
