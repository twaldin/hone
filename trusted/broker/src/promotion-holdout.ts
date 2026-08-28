import { createHash } from "node:crypto";
import {
  HOLDOUT_ASSESSMENT_VERSION,
  HOLDOUT_SEED_DOMAIN,
  HOLDOUT_SPLIT_VERSION,
  HoldoutNullControlRecord,
  PromotionHoldoutRecord,
  PromotionHoldoutSplit,
  PromotionHoldoutSplitSummary,
  canonicalJson,
  type HoldoutGeneralizationStatus,
  type HoldoutNoiseClass,
  type PromotionGateDecision,
  type PromotionHoldoutSplit as PromotionHoldoutSplitT,
} from "@hone/schema";

const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex")}`;

export interface PromotionHoldoutSourceUnit {
  id: string;
  contentHash: string;
  trainPath: string;
  holdoutPath: string;
}

export interface CreatePromotionHoldoutSplitInput {
  capsuleId: string;
  capsuleDigest: string;
  campaignIdentity: string;
  frozenAt: string;
  trainAssetGroupId: string;
  holdoutAssetGroupId: string;
  units: readonly PromotionHoldoutSourceUnit[];
  holdoutUnits: number;
  noiseClass: HoldoutNoiseClass;
  noiseEnvelope: number | null;
  evaluationRepeats: number;
  minimumDetectableEffect: number;
  achievableScoreMax: number;
}

export function derivePromotionHoldoutSeed(campaignIdentity: string, capsuleDigest: string): `sha256:${string}` {
  return digest(`${HOLDOUT_SEED_DOMAIN}\0${campaignIdentity}\0${capsuleDigest}`);
}

function holdoutIdsFor(
  derivedSeed: string,
  capsuleDigest: string,
  units: readonly { id: string; contentHash: string }[],
  holdoutUnits: number,
): ReadonlySet<string> {
  const ranked = units.map((unit) => ({
    unit,
    rank: digest(`${derivedSeed}\0${capsuleDigest}\0${unit.id}\0${unit.contentHash}`),
  })).sort((left, right) =>
    left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.unit.id.localeCompare(right.unit.id),
  );
  return new Set(ranked.slice(0, holdoutUnits).map(({ unit }) => unit.id));
}

export function createPromotionHoldoutSplit(input: CreatePromotionHoldoutSplitInput): PromotionHoldoutSplitT {
  if (new Set(input.units.map((unit) => unit.id)).size !== input.units.length) throw new Error("holdout split unit ids must be unique");
  if (!Number.isInteger(input.holdoutUnits) || input.holdoutUnits <= 0 || input.holdoutUnits >= input.units.length) {
    throw new Error("holdout unit count must leave non-empty train and holdout partitions");
  }
  const population = [...input.units].sort((left, right) => left.id.localeCompare(right.id));
  const identityPopulation = population.map(({ id, contentHash }) => ({ id, contentHash }));
  const derivedSeed = derivePromotionHoldoutSeed(input.campaignIdentity, input.capsuleDigest);
  const holdoutIds = holdoutIdsFor(derivedSeed, input.capsuleDigest, identityPopulation, input.holdoutUnits);
  const claimMinimumHoldoutUnits = Math.ceil(1 / input.minimumDetectableEffect);
  const withoutIdentity = {
    version: HOLDOUT_SPLIT_VERSION,
    capsuleId: input.capsuleId,
    capsuleDigest: input.capsuleDigest,
    seedDerivation: {
      algorithm: "sha256-campaign-capsule-v1" as const,
      domain: HOLDOUT_SEED_DOMAIN,
      campaignIdentity: input.campaignIdentity,
    },
    algorithm: "sha256-rank-v2" as const,
    frozenAt: input.frozenAt,
    populationDigest: digest(identityPopulation),
    noiseClass: input.noiseClass,
    noiseEnvelope: input.noiseEnvelope,
    evaluationRepeats: input.evaluationRepeats,
    minimumDetectableEffect: input.minimumDetectableEffect,
    claimMinimumHoldoutUnits,
    designEligibility: input.holdoutUnits >= claimMinimumHoldoutUnits ? "claim-capable" as const : "instrumentation-only" as const,
    achievableScoreMax: input.achievableScoreMax,
    train: {
      assetGroupId: input.trainAssetGroupId,
      units: population.filter((unit) => !holdoutIds.has(unit.id)).map((unit) => ({ id: unit.id, path: unit.trainPath, contentHash: unit.contentHash })),
    },
    holdout: {
      assetGroupId: input.holdoutAssetGroupId,
      units: population.filter((unit) => holdoutIds.has(unit.id)).map((unit) => ({ id: unit.id, path: unit.holdoutPath, contentHash: unit.contentHash })),
    },
  };
  return PromotionHoldoutSplit.parse({ ...withoutIdentity, splitId: digest(withoutIdentity) });
}

export function assertPromotionHoldoutSplitIdentity(splitInput: PromotionHoldoutSplitT): void {
  const split = PromotionHoldoutSplit.parse(splitInput);
  const { splitId, ...withoutIdentity } = split;
  if (digest(withoutIdentity) !== splitId) throw new Error("holdout split identity does not match its frozen assignment");
  const population = [...split.train.units, ...split.holdout.units]
    .map(({ id, contentHash }) => ({ id, contentHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (digest(population) !== split.populationDigest) throw new Error("holdout population digest does not match its units");
  const derivedSeed = derivePromotionHoldoutSeed(split.seedDerivation.campaignIdentity, split.capsuleDigest);
  const expectedHoldout = holdoutIdsFor(derivedSeed, split.capsuleDigest, population, split.holdout.units.length);
  if (split.holdout.units.some((unit) => !expectedHoldout.has(unit.id))
    || split.train.units.some((unit) => expectedHoldout.has(unit.id))) {
    throw new Error("holdout split is not the canonical derived-seed assignment");
  }
}

export function promotionHoldoutSplitSummary(splitInput: PromotionHoldoutSplitT) {
  const split = PromotionHoldoutSplit.parse(splitInput);
  return PromotionHoldoutSplitSummary.parse({
    version: split.version,
    splitId: split.splitId,
    capsuleId: split.capsuleId,
    capsuleDigest: split.capsuleDigest,
    seedDerivation: split.seedDerivation,
    algorithm: split.algorithm,
    frozenAt: split.frozenAt,
    populationDigest: split.populationDigest,
    noiseClass: split.noiseClass,
    evaluationRepeats: split.evaluationRepeats,
    minimumDetectableEffect: split.minimumDetectableEffect,
    claimMinimumHoldoutUnits: split.claimMinimumHoldoutUnits,
    designEligibility: split.designEligibility,
    trainAssetGroupId: split.train.assetGroupId,
    holdoutAssetGroupId: split.holdout.assetGroupId,
    trainUnits: split.train.units.length,
    holdoutUnits: split.holdout.units.length,
  });
}

export function buildHoldoutNullControl(input: {
  splitId: string;
  artifactHash: string;
  assetGroupId: string;
  seeds: readonly number[];
  scores: readonly number[];
  recordedAt: string;
}) {
  const mean = input.scores.reduce((sum, score) => sum + score, 0) / input.scores.length;
  const variance = input.scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / (input.scores.length - 1);
  const withoutIdentity = {
    splitId: input.splitId,
    artifactHash: input.artifactHash,
    assetGroupId: input.assetGroupId,
    seeds: [...input.seeds],
    scores: [...input.scores],
    estimator: "sample-sd-v1" as const,
    sampleStandardDeviation: Math.sqrt(variance),
    informationFree: true as const,
    recordedAt: input.recordedAt,
  };
  return HoldoutNullControlRecord.parse({ ...withoutIdentity, controlId: digest(withoutIdentity) });
}

export function buildPromotionHoldoutRecord(input: {
  artifactHash: string;
  parentArtifactHash: string;
  split: PromotionHoldoutSplitT;
  gateVersion: string;
  noiseDecision: PromotionGateDecision;
  trainParentScore: number;
  trainChildScore: number;
  holdoutParentScores: readonly number[];
  holdoutChildScores: readonly number[];
  seeds: readonly number[];
  nullControl: HoldoutNullControlRecord;
  recordedAt: string;
}) {
  if (input.seeds.length === 0
    || input.seeds.length !== input.holdoutParentScores.length
    || input.seeds.length !== input.holdoutChildScores.length) {
    throw new Error("holdout seeds and repeated scores must have equal non-zero length");
  }
  const split = PromotionHoldoutSplit.parse(input.split);
  const holdoutParentScore = input.holdoutParentScores.reduce((sum, score) => sum + score, 0) / input.holdoutParentScores.length;
  const holdoutChildScore = input.holdoutChildScores.reduce((sum, score) => sum + score, 0) / input.holdoutChildScores.length;
  const trainingDelta = input.trainChildScore - input.trainParentScore;
  const holdoutDelta = holdoutChildScore - holdoutParentScore;
  const headroom = split.achievableScoreMax - holdoutParentScore;
  const designMeasurable = split.designEligibility === "claim-capable" && split.holdout.units.length >= split.claimMinimumHoldoutUnits;
  const deterministic = split.noiseClass === "deterministic-zero-noise" && input.nullControl.sampleStandardDeviation === 0;
  const status: HoldoutGeneralizationStatus = !designMeasurable || headroom < trainingDelta
    ? "unmeasurable"
    : !deterministic || trainingDelta < split.minimumDetectableEffect
      ? "indeterminate"
      : holdoutDelta <= 0 ? "overfit" : holdoutDelta < split.minimumDetectableEffect ? "indeterminate" : "supported";
  return PromotionHoldoutRecord.parse({
    version: HOLDOUT_ASSESSMENT_VERSION,
    artifactHash: input.artifactHash,
    parentArtifactHash: input.parentArtifactHash,
    splitId: split.splitId,
    training: { parentScore: input.trainParentScore, childScore: input.trainChildScore, delta: trainingDelta, gateVersion: input.gateVersion, noiseDecision: input.noiseDecision },
    holdout: {
      parentScore: holdoutParentScore,
      childScore: holdoutChildScore,
      delta: holdoutDelta,
      assetGroupId: split.holdout.assetGroupId,
      seeds: [...input.seeds],
      parentScores: [...input.holdoutParentScores],
      childScores: [...input.holdoutChildScores],
      achievableScoreMax: split.achievableScoreMax,
      headroom,
      minimumDetectableEffect: split.minimumDetectableEffect,
      holdoutUnits: split.holdout.units.length,
      claimMinimumHoldoutUnits: split.claimMinimumHoldoutUnits,
      designEligibility: split.designEligibility,
      noiseClass: split.noiseClass,
    },
    generalizationGap: trainingDelta - holdoutDelta,
    nullControl: input.nullControl,
    status,
    claimable: input.noiseDecision === "promote" && status === "supported",
    recordedAt: input.recordedAt,
  });
}
