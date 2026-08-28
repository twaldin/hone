import { describe, expect, it } from "vitest";
import { assessPromotion, PromotionNoiseCalibration } from "@hone/schema";
import {
  CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2,
  campaign12PromotionNoiseCalibration,
} from "../src/promotion-noise-calibration.js";

function calibrationFor(capsuleId: string) {
  const evidence = CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2.find(
    (entry) => entry.capsuleId === capsuleId,
  );
  if (evidence === undefined) throw new Error(`missing test calibration for ${capsuleId}`);
  const calibration = campaign12PromotionNoiseCalibration({
    capsuleId: evidence.capsuleId,
    capsuleDigest: evidence.capsuleDigest,
    evaluatorImage: evidence.evaluatorImage,
    assetGroupId: evidence.assetGroupId,
    measurementEpoch: evidence.measurementEpochs[0] ?? null,
  });
  if (calibration === null) throw new Error(`calibration identity did not resolve for ${capsuleId}`);
  return { evidence, calibration };
}

describe("campaign-12 promotion noise calibration", () => {
  it("refuses every capsule's largest observed identical-artifact excursion", () => {
    expect(CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2).toHaveLength(6);
    for (const evidence of CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2) {
      const { calibration } = calibrationFor(evidence.capsuleId);
      const assessment = assessPromotion(0, evidence.sensitivityThresholds.maxSpan, calibration);
      expect(assessment.passed, evidence.capsuleId).toBe(false);
      expect(assessment.noiseFloor, evidence.capsuleId).toBe(evidence.noiseFloor);
      expect(assessment.noiseEnvelope, evidence.capsuleId).toBe(evidence.noiseEnvelope);
    }
  });

  it("still promotes a gain larger than the upper confidence boundary", () => {
    for (const evidence of CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2) {
      const { calibration } = calibrationFor(evidence.capsuleId);
      expect(
        assessPromotion(0, evidence.noiseEnvelope + 0.05, calibration),
        evidence.capsuleId,
      ).toMatchObject({ decision: "promote", passed: true });
    }
  });

  it("uses capsule-specific scales rather than a global constant", () => {
    const deterministic = calibrationFor("cap_63630c40b876").calibration;
    const noisy = calibrationFor("cap_f11c10c3fc15").calibration;
    expect(deterministic.noiseEnvelope).toBe(0);
    expect(noisy.noiseEnvelope).toBe(0.030474786746530185);
    expect(assessPromotion(1, 1.001, deterministic).passed).toBe(true);
    expect(assessPromotion(1, 1.001, noisy).passed).toBe(false);
  });

  it("records a genuine statistical-confidence indeterminate region", () => {
    const simdjson = calibrationFor("cap_23de71dd36fa").calibration;
    const nearEnvelopeDelta = 0.015182317810079615;
    expect(nearEnvelopeDelta).toBeGreaterThan(simdjson.noiseFloor);
    expect(nearEnvelopeDelta).toBeLessThan(simdjson.noiseEnvelope);
    expect(assessPromotion(0, nearEnvelopeDelta, simdjson)).toMatchObject({
      decision: "refuse-indeterminate",
      passed: false,
    });
  });

  it("rejects under-powered calibrations at the schema boundary", () => {
    const calibration = calibrationFor("cap_23de71dd36fa").calibration;
    expect(() => PromotionNoiseCalibration.parse({
      ...calibration,
      sampleDepths: [3, 3],
      informationFreeMeasurements: 6,
      coordinateGroups: 2,
      pooledDegreesOfFreedom: 4,
      informationFreePairs: 2,
    })).toThrow();
  });

  it("fails closed when any measured evaluator identity dimension is stale", () => {
    const { evidence } = calibrationFor("cap_23de71dd36fa");
    const identity = {
      capsuleId: evidence.capsuleId,
      capsuleDigest: evidence.capsuleDigest,
      evaluatorImage: evidence.evaluatorImage,
      assetGroupId: evidence.assetGroupId,
      measurementEpoch: evidence.measurementEpochs[0] ?? null,
    };
    expect(campaign12PromotionNoiseCalibration(identity)).not.toBeNull();
    expect(campaign12PromotionNoiseCalibration({ ...identity, capsuleId: "cap_000000000000" })).toBeNull();
    expect(campaign12PromotionNoiseCalibration({ ...identity, capsuleDigest: `sha256:${"0".repeat(64)}` })).toBeNull();
    expect(campaign12PromotionNoiseCalibration({ ...identity, evaluatorImage: "changed-evaluator" })).toBeNull();
    expect(campaign12PromotionNoiseCalibration({ ...identity, assetGroupId: "validation" })).toBeNull();
    expect(campaign12PromotionNoiseCalibration({ ...identity, measurementEpoch: "m2:changed" })).toBeNull();
  });
});
