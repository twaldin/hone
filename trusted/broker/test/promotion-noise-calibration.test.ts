import { describe, expect, it } from "vitest";
import { assessPromotion } from "@hone/schema";
import {
  CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V1,
  campaign12PromotionNoiseCalibration,
} from "../src/promotion-noise-calibration.js";

function calibrationFor(capsuleId: string) {
  const evidence = CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V1.find(
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
  it("refuses the full observed identical-artifact span on every capsule", () => {
    expect(CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V1).toHaveLength(6);
    for (const evidence of CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V1) {
      const { calibration } = calibrationFor(evidence.capsuleId);
      const assessment = assessPromotion(0, evidence.noiseEnvelope, calibration);
      expect(assessment, evidence.capsuleId).toMatchObject({
        noiseEnvelope: evidence.noiseEnvelope,
        passed: false,
      });
      expect(assessment.decision, evidence.capsuleId).toBe(
        evidence.noiseEnvelope === 0 ? "refuse-no-improvement" : "refuse-within-noise",
      );
    }
  });

  it("still promotes a gain larger than each measured envelope", () => {
    for (const evidence of CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V1) {
      const { calibration } = calibrationFor(evidence.capsuleId);
      expect(
        assessPromotion(1, 1 + evidence.noiseEnvelope + 0.05, calibration),
        evidence.capsuleId,
      ).toMatchObject({ decision: "promote", passed: true });
    }
  });

  it("uses capsule-specific spans rather than a global constant", () => {
    const deterministic = calibrationFor("cap_63630c40b876").calibration;
    const noisy = calibrationFor("cap_f11c10c3fc15").calibration;
    expect(deterministic.noiseEnvelope).toBe(0);
    expect(noisy.noiseEnvelope).toBe(0.026365621172253995);
    expect(assessPromotion(1, 1.001, deterministic).passed).toBe(true);
    expect(assessPromotion(1, 1.001, noisy).passed).toBe(false);
  });

  it("fails closed when any calibrated evaluator identity dimension is stale", () => {
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
