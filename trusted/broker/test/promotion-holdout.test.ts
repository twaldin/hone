import { readFileSync } from "node:fs";
import { PromotionHoldoutRecord } from "@hone/schema";
import { describe, expect, test } from "vitest";
import {
  assertPromotionHoldoutSplitIdentity,
  buildHoldoutNullControl,
  buildPromotionHoldoutRecord,
  createPromotionHoldoutSplit,
  derivePromotionHoldoutSeed,
  promotionHoldoutSplitSummary,
} from "../src/promotion-holdout.js";

const HASH = (digit: string) => `sha256:${digit.repeat(64)}`;
const CAPSULE_DIGEST = HASH("a");
const CAMPAIGN_IDENTITY = HASH("b");
const FROZEN_AT = "2026-08-28T00:00:00.000Z";

function units(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index.toString().padStart(2, "0")}`,
    achievableScoreMax: 1,
    contentHash: HASH(((index % 9) + 1).toString()),
    trainPath: `assets/train/case-${index}.json`,
    holdoutPath: `assets/holdout/case-${index}.json`,
  }));
}

function deterministicSplit(inputUnits = units(12), holdoutUnits = 2, minimumDetectableEffect = 0.05) {
  return createPromotionHoldoutSplit({
    capsuleId: "cap_0123456789ab",
    capsuleDigest: CAPSULE_DIGEST,
    campaignIdentity: CAMPAIGN_IDENTITY,
    frozenAt: FROZEN_AT,
    trainAssetGroupId: "train",
    holdoutAssetGroupId: "holdout",
    units: inputUnits,
    holdoutUnits,
    noiseClass: "deterministic-zero-noise",
    noiseEnvelope: 0,
    evaluationRepeats: 1,
    minimumDetectableEffect,
  });
}

describe("frozen promotion holdout split", () => {
  test("derives its seed from pre-split identities and is input-order independent", () => {
    const forward = deterministicSplit();
    const reversed = deterministicSplit([...units(12)].reverse());

    expect(reversed).toEqual(forward);
    expect(derivePromotionHoldoutSeed(CAMPAIGN_IDENTITY, CAPSULE_DIGEST)).toMatch(/^sha256:/);
    expect(forward.seedDerivation).toEqual({
      algorithm: "sha256-campaign-capsule-v1",
      domain: "hone-promotion-holdout-seed-v1",
      campaignIdentity: CAMPAIGN_IDENTITY,
    });
    expect(forward.designEligibility).toBe("instrumentation-only");
    expect(() => assertPromotionHoldoutSplitIdentity(forward)).not.toThrow();
  });

  test("rejects assignment or byte tampering under a retained split identity", () => {
    const split = deterministicSplit();
    const tampered = structuredClone(split);
    tampered.holdout.units[0]!.contentHash = HASH("f");
    expect(() => assertPromotionHoldoutSplitIdentity(tampered)).toThrow(/identity|population/);
  });

  test("redacts unit identities and paths from the event summary", () => {
    const summary = promotionHoldoutSplitSummary(deterministicSplit());
    expect(summary).toMatchObject({ holdoutUnits: 2, trainUnits: 10 });
    expect(JSON.stringify(summary)).not.toContain("case-00");
    expect(JSON.stringify(summary)).not.toContain("assets/holdout");
  });
});

describe("promotion holdout assessment", () => {
  test("marks a saturated instrument unmeasurable rather than overfit", () => {
    const split = deterministicSplit(units(25), 20, 0.05);
    const nullControl = buildHoldoutNullControl({
      splitId: split.splitId,
      artifactHash: HASH("1"),
      assetGroupId: "holdout",
      seeds: [0, 1],
      scores: [0.8, 0.8],
      recordedAt: FROZEN_AT,
    });
    const record = buildPromotionHoldoutRecord({
      artifactHash: HASH("2"),
      parentArtifactHash: HASH("1"),
      split,
      gateVersion: "noise-envelope-v2",
      noiseDecision: "promote",
      trainParentScore: 0.3,
      trainChildScore: 0.6,
      holdoutParentScores: [0.8],
      holdoutChildScores: [0.8],
      seeds: [0],
      nullControl,
      recordedAt: FROZEN_AT,
    });

    expect(record.holdout.headroom).toBeCloseTo(0.2);
    expect(record.training.noiseDecision).toBe("promote");
    expect(record.status).toBe("unmeasurable");
    expect(record.claimable).toBe(false);
    expect(record.nullControl).toMatchObject({ estimator: "sample-sd-v1", sampleStandardDeviation: 0 });
  });

  test("can record overfit only when granularity, headroom, and deterministic null support it", () => {
    const split = deterministicSplit(units(25), 20, 0.05);
    const nullControl = buildHoldoutNullControl({
      splitId: split.splitId,
      artifactHash: HASH("1"),
      assetGroupId: "holdout",
      seeds: [0, 1],
      scores: [0.2, 0.2],
      recordedAt: FROZEN_AT,
    });
    const record = buildPromotionHoldoutRecord({
      artifactHash: HASH("2"),
      parentArtifactHash: HASH("1"),
      split,
      gateVersion: "noise-envelope-v2",
      noiseDecision: "promote",
      trainParentScore: 0.3,
      trainChildScore: 0.6,
      holdoutParentScores: [0.2],
      holdoutChildScores: [0.2],
      seeds: [0],
      nullControl,
      recordedAt: FROZEN_AT,
    });
    expect(record.status).toBe("overfit");
    expect(record.claimable).toBe(false);
  });

  test("parses the corrected real-data record and resolves every receipt citation", () => {
    const results = JSON.parse(readFileSync(
      new URL("../../../data/hone-m2-holdout/corrected-pilot-results.v2.json", import.meta.url),
      "utf8",
    ));
    const record = PromotionHoldoutRecord.parse(results.promotionRecord);
    const receipts = readFileSync(
      new URL("../../../data/hone-m2-holdout/corrected-pilot-evaluations.v2.ndjson", import.meta.url),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const cited = new Set(results.receiptDigests);

    expect(record).toMatchObject({
      status: "unmeasurable",
      claimable: false,
      holdout: { assetGroupId: "promotion-holdout", holdoutUnits: 20 },
    });
    expect(receipts).toHaveLength(3);
    expect(receipts.every((row) => cited.has(row.recordDigest))).toBe(true);
    expect(receipts.every((row) => row.record.assetGroupId === record.holdout.assetGroupId)).toBe(true);
  });

  test("parses the corrected tradeup record and resolves every receipt citation", () => {
    const results = JSON.parse(readFileSync(
      new URL("../../../data/hone-m2-holdout/corrected-tradeup-results.v2.json", import.meta.url),
      "utf8",
    ));
    const record = PromotionHoldoutRecord.parse(results.promotionRecord);
    const receipts = readFileSync(
      new URL("../../../data/hone-m2-holdout/corrected-tradeup-evaluations.v2.ndjson", import.meta.url),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const cited = new Set(results.receiptDigests);

    expect(record).toMatchObject({
      status: "supported",
      claimable: true,
      holdout: { assetGroupId: "promotion-holdout", holdoutUnits: 20 },
    });
    expect(receipts).toHaveLength(3);
    expect(receipts.every((row) => cited.has(row.recordDigest))).toBe(true);
    expect(receipts.every((row) => row.record.assetGroupId === record.holdout.assetGroupId)).toBe(true);
  });
});
