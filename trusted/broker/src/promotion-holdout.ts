import { createHash } from "node:crypto";
import {
  HOLDOUT_ASSESSMENT_VERSION,
  HOLDOUT_SPLIT_VERSION,
  HoldoutNullControlRecord,
  PromotionHoldoutRecord,
  PromotionHoldoutSplit,
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
  /** Destination if sha256-rank-v1 assigns this unit to train. */
  trainPath: string;
  /** Destination if sha256-rank-v1 assigns this unit to holdout. */
  holdoutPath: string;
}

export interface CreatePromotionHoldoutSplitInput {
  capsuleId: string;
  capsuleDigest: string;
  seed: string;
  frozenAt: string;
  trainAssetGroupId: string;
  holdoutAssetGroupId: string;
  units: readonly PromotionHoldoutSourceUnit[];
  holdoutUnits: number;
  noiseClass: HoldoutNoiseClass;
  noiseEnvelope: number | null;
  evaluationRepeats: number;
}

function holdoutIdsFor(
  seed: string,
  capsuleDigest: string,
  units: readonly { id: string; contentHash: string }[],
  holdoutUnits: number,
): ReadonlySet<string> {
  const ranked = units.map((unit) => ({
    unit,
    rank: digest(`${seed}\0${capsuleDigest}\0${unit.id}\0${unit.contentHash}`),
  })).sort((left, right) =>
    left.rank < right.rank
      ? -1
      : left.rank > right.rank
        ? 1
        : left.unit.id < right.unit.id
          ? -1
          : left.unit.id > right.unit.id
            ? 1
            : 0,
  );
  return new Set(ranked.slice(0, holdoutUnits).map(({ unit }) => unit.id));
}

/**
 * Stable seed-ranked assignment. Callers materialize each unit at the one
 * returned destination path before freezing the capsule manifest.
 */
export function createPromotionHoldoutSplit(
  input: CreatePromotionHoldoutSplitInput,
): PromotionHoldoutSplitT {
  if (new Set(input.units.map((unit) => unit.id)).size !== input.units.length) {
    throw new Error("holdout split unit ids must be unique");
  }
  if (!Number.isInteger(input.holdoutUnits) || input.holdoutUnits <= 0 || input.holdoutUnits >= input.units.length) {
    throw new Error("holdout unit count must leave non-empty train and holdout partitions");
  }
  const population = [...input.units].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const identityPopulation = population.map(({ id, contentHash }) => ({ id, contentHash }));
  const holdoutIds = holdoutIdsFor(input.seed, input.capsuleDigest, identityPopulation, input.holdoutUnits);
  const withoutIdentity = {
    version: HOLDOUT_SPLIT_VERSION,
    capsuleId: input.capsuleId,
    capsuleDigest: input.capsuleDigest,
    seed: input.seed,
    algorithm: "sha256-rank-v1" as const,
    frozenAt: input.frozenAt,
    populationDigest: digest(identityPopulation),
    noiseClass: input.noiseClass,
    noiseEnvelope: input.noiseEnvelope,
    evaluationRepeats: input.evaluationRepeats,
    train: {
      assetGroupId: input.trainAssetGroupId,
      units: population.filter((unit) => !holdoutIds.has(unit.id)).map((unit) => ({
        id: unit.id,
        path: unit.trainPath,
        contentHash: unit.contentHash,
      })),
    },
    holdout: {
      assetGroupId: input.holdoutAssetGroupId,
      units: population.filter((unit) => holdoutIds.has(unit.id)).map((unit) => ({
        id: unit.id,
        path: unit.holdoutPath,
        contentHash: unit.contentHash,
      })),
    },
  };
  return PromotionHoldoutSplit.parse({
    ...withoutIdentity,
    splitId: digest(withoutIdentity),
  });
}

export function assertPromotionHoldoutSplitIdentity(splitInput: PromotionHoldoutSplitT): void {
  const split = PromotionHoldoutSplit.parse(splitInput);
  const { splitId, ...withoutIdentity } = split;
  if (digest(withoutIdentity) !== splitId) {
    throw new Error("holdout split identity does not match its frozen assignment");
  }
  const population = [...split.train.units, ...split.holdout.units]
    .map(({ id, contentHash }) => ({ id, contentHash }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (digest(population) !== split.populationDigest) {
    throw new Error("holdout population digest does not match its units");
  }
  const expectedHoldout = holdoutIdsFor(
    split.seed,
    split.capsuleDigest,
    population,
    split.holdout.units.length,
  );
  if (
    split.holdout.units.some((unit) => !expectedHoldout.has(unit.id))
    || split.train.units.some((unit) => expectedHoldout.has(unit.id))
  ) {
    throw new Error("holdout split is not the canonical seeded assignment");
  }
}

export function buildHoldoutNullControl(input: {
  splitId: string;
  artifactHash: string;
  assetGroupId: string;
  seeds: readonly number[];
  scores: readonly number[];
  recordedAt: string;
}) {
  const withoutIdentity = {
    splitId: input.splitId,
    artifactHash: input.artifactHash,
    assetGroupId: input.assetGroupId,
    seeds: [...input.seeds],
    scores: [...input.scores],
    observedSpan: Math.max(...input.scores) - Math.min(...input.scores),
    informationFree: true as const,
    recordedAt: input.recordedAt,
  };
  return HoldoutNullControlRecord.parse({
    ...withoutIdentity,
    controlId: digest(withoutIdentity),
  });
}

export function buildPromotionHoldoutRecord(input: {
  artifactHash: string;
  parentArtifactHash: string;
  splitId: string;
  gateVersion: string;
  noiseDecision: PromotionGateDecision;
  trainParentScore: number;
  trainChildScore: number;
  holdoutParentScores: readonly number[];
  holdoutChildScores: readonly number[];
  assetGroupId: string;
  seeds: readonly number[];
  nullControl: HoldoutNullControlRecord;
  recordedAt: string;
}) {
  if (
    input.seeds.length === 0
    || input.seeds.length !== input.holdoutParentScores.length
    || input.seeds.length !== input.holdoutChildScores.length
  ) {
    throw new Error("holdout seeds and repeated scores must have equal non-zero length");
  }
  const holdoutParentScore = input.holdoutParentScores.reduce((sum, score) => sum + score, 0)
    / input.holdoutParentScores.length;
  const holdoutChildScore = input.holdoutChildScores.reduce((sum, score) => sum + score, 0)
    / input.holdoutChildScores.length;
  const trainingDelta = input.trainChildScore - input.trainParentScore;
  const holdoutDelta = holdoutChildScore - holdoutParentScore;
  const status: HoldoutGeneralizationStatus = holdoutDelta <= 0
    ? "overfit"
    : holdoutDelta > input.nullControl.observedSpan
      ? "supported"
      : "indeterminate";
  return PromotionHoldoutRecord.parse({
    version: HOLDOUT_ASSESSMENT_VERSION,
    artifactHash: input.artifactHash,
    parentArtifactHash: input.parentArtifactHash,
    splitId: input.splitId,
    training: {
      parentScore: input.trainParentScore,
      childScore: input.trainChildScore,
      delta: trainingDelta,
      gateVersion: input.gateVersion,
      noiseDecision: input.noiseDecision,
    },
    holdout: {
      parentScore: holdoutParentScore,
      childScore: holdoutChildScore,
      delta: holdoutDelta,
      assetGroupId: input.assetGroupId,
      seeds: [...input.seeds],
      parentScores: [...input.holdoutParentScores],
      childScores: [...input.holdoutChildScores],
    },
    generalizationGap: trainingDelta - holdoutDelta,
    nullControl: input.nullControl,
    status,
    claimable: input.noiseDecision === "promote" && status === "supported",
    recordedAt: input.recordedAt,
  });
}
