import { z } from "zod";

/**
 * Versioned promotion semantics. Historical gates without this marker retain
 * their recorded decision but are never silently recomputed by the runtime.
 */
export const PROMOTION_GATE_VERSION = "noise-envelope-v2" as const;

export const PromotionGateDecision = z.enum([
  "promote",
  "refuse-no-improvement",
  "refuse-within-noise",
  "refuse-indeterminate",
  "refuse-uncalibrated",
]);
export type PromotionGateDecision = z.infer<typeof PromotionGateDecision>;

/**
 * Identity-bound, minimum-powered calibration of the score noise scale.
 * Pooled within-coordinate standard deviation converges with additional
 * measurements; unlike max-minus-min, under-measurement cannot mechanically
 * shrink an order statistic while remaining schema-valid.
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
  estimator: z.literal("pooled-within-coordinate-sd-v1"),
  estimatorMinRepeatsPerCoordinate: z.literal(3),
  sampleDepths: z.array(z.number().int().min(3)).min(3),
  informationFreeMeasurements: z.number().int().min(21),
  coordinateGroups: z.number().int().min(3),
  pooledDegreesOfFreedom: z.number().int().min(18),
  pooledWithinCoordinateSd: z.number().finite().nonnegative(),
  /** Deltas at or below 3 pooled score SD are noise-attributable. */
  noiseFloor: z.number().finite().nonnegative(),
  /** Deltas above 3 SD but at or below 4.5 SD are indeterminate and cannot promote. */
  noiseEnvelope: z.number().finite().nonnegative(),
  informationFreePairs: z.number().int().min(3),
  informationFreePositive: z.number().int().nonnegative(),
}).strict().superRefine((calibration, ctx) => {
  const measurements = calibration.sampleDepths.reduce((sum, depth) => sum + depth, 0);
  const degreesOfFreedom = calibration.sampleDepths.reduce((sum, depth) => sum + depth - 1, 0);
  const close = (left: number, right: number): boolean =>
    Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
  if (calibration.sampleDepths.length !== calibration.coordinateGroups) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "coordinateGroups must equal sampleDepths.length" });
  }
  if (measurements !== calibration.informationFreeMeasurements) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "informationFreeMeasurements must equal the sample-depth sum" });
  }
  if (degreesOfFreedom !== calibration.pooledDegreesOfFreedom) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pooledDegreesOfFreedom must equal sum(depth - 1)" });
  }
  if (!close(calibration.noiseFloor, 3 * calibration.pooledWithinCoordinateSd)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noiseFloor must be 3 pooled SD" });
  }
  if (!close(calibration.noiseEnvelope, 4.5 * calibration.pooledWithinCoordinateSd)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noiseEnvelope must be 4.5 pooled SD" });
  }
  if (calibration.informationFreePositive > calibration.informationFreePairs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "positive null pairs cannot exceed all null pairs" });
  }
});
export type PromotionNoiseCalibration = z.infer<typeof PromotionNoiseCalibration>;

export interface PromotionGateAssessment {
  gateVersion: typeof PROMOTION_GATE_VERSION;
  calibrationEvidenceVersion: string | null;
  delta: number;
  noiseEnvelope: number | null;
  noiseFloor: number | null;
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
      noiseFloor: calibration?.noiseFloor ?? null,
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
      noiseFloor: null,
      noiseEnvelope: null,
      decision: "refuse-uncalibrated",
      passed: false,
    };
  }
  const passed = delta > calibration.noiseEnvelope;
  const decision: PromotionGateDecision = passed
    ? "promote"
    : delta > calibration.noiseFloor
      ? "refuse-indeterminate"
      : "refuse-within-noise";
  return {
    gateVersion: PROMOTION_GATE_VERSION,
    calibrationEvidenceVersion: calibration.evidenceVersion,
    delta,
    noiseFloor: calibration.noiseFloor,
    noiseEnvelope: calibration.noiseEnvelope,
    decision,
    passed,
  };
}
