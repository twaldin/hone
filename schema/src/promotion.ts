import { z } from "zod";

/**
 * Versioned promotion semantics. Historical gates without this marker retain
 * their recorded decision but are never silently recomputed by the runtime.
 */
export const PROMOTION_GATE_VERSION = "noise-envelope-v3" as const;
export const POOLED_SCORE_SD_ESTIMATOR = "pooled-within-coordinate-sd-v1" as const;
export const DIRECT_PAIRED_DELTA_SD_ESTIMATOR = "direct-local-paired-delta-sd-v1" as const;

export const PromotionGateDecision = z.enum([
  "promote",
  "refuse-no-improvement",
  "refuse-within-noise",
  "refuse-indeterminate",
  "refuse-uncalibrated",
]);
export type PromotionGateDecision = z.infer<typeof PromotionGateDecision>;

const CalibrationIdentity = z.object({
  gateVersion: z.literal(PROMOTION_GATE_VERSION),
  evidenceVersion: z.string().min(1),
  calibratedAt: z.string().datetime(),
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  admittedCapsuleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  executionImage: z.string().min(1).refine((value) => !/^sha256:/.test(value), "execution image cannot be an admitted digest"),
  assetGroupId: z.string().min(1),
  measurementEpoch: z.string().min(1).nullable(),
  sourceCohortSha256: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)).min(1),
  maxObservedPairDelta: z.number().finite().nonnegative(),
  noiseFloor: z.number().finite().nonnegative(),
  noiseEnvelope: z.number().finite().nonnegative(),
  informationFreePairs: z.number().int().min(3),
  informationFreePositive: z.number().int().nonnegative(),
});

const PooledScoreCalibration = CalibrationIdentity.extend({
  estimator: z.literal(POOLED_SCORE_SD_ESTIMATOR),
  estimatorMinRepeatsPerCoordinate: z.literal(3),
  sampleDepths: z.array(z.number().int().min(3)).min(3),
  informationFreeMeasurements: z.number().int().min(21),
  coordinateGroups: z.number().int().min(3),
  pooledDegreesOfFreedom: z.number().int().min(18),
  pooledWithinCoordinateSd: z.number().finite().nonnegative(),
}).strict();

const DirectDeltaCalibration = CalibrationIdentity.extend({
  estimator: z.literal(DIRECT_PAIRED_DELTA_SD_ESTIMATOR),
  pairedDeltaTrials: z.number().int().min(16),
  pairedDeltaDegreesOfFreedom: z.number().int().min(15),
  pairedDeltaSd: z.number().finite().nonnegative(),
  localArmBaselineHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

/**
 * Identity-bound, cohort-bound, minimum-powered calibration of the quantity
 * the gate compares. A schedule-faithful local arm uses its direct paired-
 * delta SD; only capsules without one may infer delta noise from pooled score
 * SD. Max observed excursion is a conservative tail guard, not the estimator.
 */
export const PromotionNoiseCalibration = z.discriminatedUnion("estimator", [
  PooledScoreCalibration,
  DirectDeltaCalibration,
]).superRefine((calibration, ctx) => {
  const close = (left: number, right: number): boolean =>
    Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
  if (calibration.informationFreePositive > calibration.informationFreePairs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "positive null pairs cannot exceed all null pairs" });
  }
  let expectedFloor: number;
  let scaleBoundary: number;
  if (calibration.estimator === POOLED_SCORE_SD_ESTIMATOR) {
    const measurements = calibration.sampleDepths.reduce((sum, depth) => sum + depth, 0);
    const degreesOfFreedom = calibration.sampleDepths.reduce((sum, depth) => sum + depth - 1, 0);
    if (calibration.sampleDepths.length !== calibration.coordinateGroups) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "coordinateGroups must equal sampleDepths.length" });
    }
    if (measurements !== calibration.informationFreeMeasurements) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "informationFreeMeasurements must equal the sample-depth sum" });
    }
    if (degreesOfFreedom !== calibration.pooledDegreesOfFreedom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pooledDegreesOfFreedom must equal sum(depth - 1)" });
    }
    expectedFloor = 3 * calibration.pooledWithinCoordinateSd;
    scaleBoundary = 4.5 * calibration.pooledWithinCoordinateSd;
  } else {
    if (calibration.pairedDeltaDegreesOfFreedom !== calibration.pairedDeltaTrials - 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pairedDeltaDegreesOfFreedom must equal pairedDeltaTrials - 1" });
    }
    expectedFloor = (3 / Math.SQRT2) * calibration.pairedDeltaSd;
    scaleBoundary = (4.5 / Math.SQRT2) * calibration.pairedDeltaSd;
  }
  const expectedEnvelope = Math.max(scaleBoundary, calibration.maxObservedPairDelta);
  if (!close(calibration.noiseFloor, expectedFloor)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noiseFloor does not match the estimator" });
  }
  if (!close(calibration.noiseEnvelope, expectedEnvelope)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noiseEnvelope must equal max(scale boundary, observed pair delta)" });
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
