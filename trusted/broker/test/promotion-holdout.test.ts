import { describe, expect, test } from "vitest";
import {
  assertPromotionHoldoutSplitIdentity,
  buildHoldoutNullControl,
  buildPromotionHoldoutRecord,
  createPromotionHoldoutSplit,
} from "../src/promotion-holdout.js";

const HASH = (digit: string) => `sha256:${digit.repeat(64)}`;
const CAPSULE_DIGEST = HASH("a");
const FROZEN_AT = "2026-08-28T00:00:00.000Z";
const SEED = "hone-m2-promotion-holdout-2026-08-28";

function units(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index.toString().padStart(2, "0")}`,
    contentHash: HASH(((index % 9) + 1).toString()),
    trainPath: `assets/train/case-${index}.json`,
    holdoutPath: `assets/holdout/case-${index}.json`,
  }));
}

function deterministicSplit(inputUnits = units(12)) {
  return createPromotionHoldoutSplit({
    capsuleId: "cap_0123456789ab",
    capsuleDigest: CAPSULE_DIGEST,
    seed: SEED,
    frozenAt: FROZEN_AT,
    trainAssetGroupId: "train",
    holdoutAssetGroupId: "holdout",
    units: inputUnits,
    holdoutUnits: 2,
    noiseClass: "deterministic-zero-noise",
    noiseEnvelope: 0,
    evaluationRepeats: 1,
  });
}

describe("frozen promotion holdout split", () => {
  test("is independent of input order and binds the seeded assignment", () => {
    const forward = deterministicSplit();
    const reversed = deterministicSplit([...units(12)].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.train.units).toHaveLength(10);
    expect(forward.holdout.units).toHaveLength(2);
    expect(forward.holdout.units.every((unit) => unit.path.startsWith("assets/holdout/"))).toBe(true);
    expect(forward.train.units.every((unit) => unit.path.startsWith("assets/train/"))).toBe(true);
    expect(() => assertPromotionHoldoutSplitIdentity(forward)).not.toThrow();
  });

  test("rejects assignment or byte tampering under a retained split identity", () => {
    const split = deterministicSplit();
    const tampered = structuredClone(split);
    tampered.holdout.units[0]!.contentHash = HASH("f");

    expect(() => assertPromotionHoldoutSplitIdentity(tampered)).toThrow(/identity|population/);
  });

  test("changes identity when the pre-evaluation seed changes", () => {
    const original = deterministicSplit();
    const reseeded = createPromotionHoldoutSplit({
      capsuleId: original.capsuleId,
      capsuleDigest: original.capsuleDigest,
      seed: "different-m2-holdout-seed-0001",
      frozenAt: original.frozenAt,
      trainAssetGroupId: original.train.assetGroupId,
      holdoutAssetGroupId: original.holdout.assetGroupId,
      units: units(12),
      holdoutUnits: 2,
      noiseClass: "deterministic-zero-noise",
      noiseEnvelope: 0,
      evaluationRepeats: 1,
    });

    expect(reseeded.splitId).not.toBe(original.splitId);
  });
});

describe("promotion holdout assessment", () => {
  test("keeps in-sample noise clearance separate from holdout overfitting", () => {
    const split = deterministicSplit();
    const nullControl = buildHoldoutNullControl({
      splitId: split.splitId,
      artifactHash: HASH("1"),
      assetGroupId: "holdout",
      seeds: [0, 1],
      scores: [0.5, 0.5],
      recordedAt: FROZEN_AT,
    });
    const record = buildPromotionHoldoutRecord({
      artifactHash: HASH("2"),
      parentArtifactHash: HASH("1"),
      splitId: split.splitId,
      gateVersion: "noise-envelope-v2",
      noiseDecision: "promote",
      trainParentScore: 0.5,
      trainChildScore: 0.8,
      holdoutParentScores: [0.5],
      holdoutChildScores: [0.4],
      assetGroupId: "holdout",
      seeds: [0],
      nullControl,
      recordedAt: FROZEN_AT,
    });

    expect(record.training.noiseDecision).toBe("promote");
    expect(record.status).toBe("overfit");
    expect(record.generalizationGap).toBeCloseTo(0.4);
    expect(record.claimable).toBe(false);
    expect(record.nullControl.informationFree).toBe(true);
  });
});
