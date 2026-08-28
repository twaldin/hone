import { z } from "zod";

/**
 * Versioned promotion semantics. Historical gates without this marker retain
 * their recorded decision but are never silently recomputed by the runtime.
 */
export const PROMOTION_GATE_VERSION = "noise-envelope-v1" as const;

export const PromotionGateDecision = z.enum([
  "promote",
  "refuse-no-improvement",
  "refuse-within-noise",
  "refuse-uncalibrated",
]);
export type PromotionGateDecision = z.infer<typeof PromotionGateDecision>;

/**
 * A capsule-specific bound derived from uncached, coordinate-matched repeated
 * measurements of byte-identical artifacts. The evidence version identifies
 * the immutable derivation cohort; the envelope is the largest within-
 * coordinate score span in that cohort.
 */
export const PromotionNoiseCalibration = z.object({
  gateVersion: z.literal(PROMOTION_GATE_VERSION),
  evidenceVersion: z.string().min(1),
  calibratedAt: z.string().datetime(),
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  capsuleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evaluatorImage: z.string().min(1),
  assetGroupId: z.string().min(1),
  measurementEpoch: z.string().min(1).nullable(),
  noiseEnvelope: z.number().finite().nonnegative(),
  informationFreePairs: z.number().int().positive(),
  informationFreePositive: z.number().int().nonnegative(),
}).strict();
export type PromotionNoiseCalibration = z.infer<typeof PromotionNoiseCalibration>;

export interface PromotionGateAssessment {
  gateVersion: typeof PROMOTION_GATE_VERSION;
  calibrationEvidenceVersion: string | null;
  delta: number;
  noiseEnvelope: number | null;
  decision: PromotionGateDecision;
  passed: boolean;
}

/** Pure, allocation-light gate shared by the trusted broker and optimizer. */
export function assessPromotion(
  parentScore: number,
  childScore: number,
  calibration: PromotionNoiseCalibration | null,
): PromotionGateAssessment {
  const delta = childScore - parentScore;
  if (!(delta > 0)) {
    return {
      gateVersion: PROMOTION_GATE_VERSION,
      calibrationEvidenceVersion: calibration?.evidenceVersion ?? null,
      delta,
      noiseEnvelope: calibration?.noiseEnvelope ?? null,
      decision: "refuse-no-improvement",
      passed: false,
    };
  }
  if (calibration === null) {
    return {
      gateVersion: PROMOTION_GATE_VERSION,
      calibrationEvidenceVersion: null,
      delta,
      noiseEnvelope: null,
      decision: "refuse-uncalibrated",
      passed: false,
    };
  }
  const passed = delta > calibration.noiseEnvelope;
  return {
    gateVersion: PROMOTION_GATE_VERSION,
    calibrationEvidenceVersion: calibration.evidenceVersion,
    delta,
    noiseEnvelope: calibration.noiseEnvelope,
    decision: passed ? "promote" : "refuse-within-noise",
    passed,
  };
}
