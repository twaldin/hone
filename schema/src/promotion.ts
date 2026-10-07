import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import { EvaluatorScoreBits, encodeFiniteScoreBits } from "./evaluator.js";

/**
 * Versioned promotion semantics. Historical gates without this marker retain
 * their recorded decision but are never silently recomputed by the runtime.
 */
export const PROMOTION_GATE_VERSION = "noise-envelope-v3" as const;
export const POOLED_SCORE_SD_ESTIMATOR = "pooled-within-coordinate-sd-v1" as const;
export const DIRECT_PAIRED_DELTA_SD_ESTIMATOR = "direct-local-paired-delta-sd-v1" as const;
export const DETERMINISTIC_ZERO_NOISE_ESTIMATOR = "deterministic-zero-noise-v1" as const;

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

const DeterministicBaselineScoreSchema = EvaluatorScoreBits.extend({
  seed: z.number().finite().int().nonnegative().refine(
    (value) => !Object.is(value, -0),
    "negative zero cannot be preserved in JSON seed evidence",
  ),
});
export type DeterministicBaselineScore = z.infer<typeof DeterministicBaselineScoreSchema>;

const DeterministicBaselineRunSchema = z.object({
  runId: z.string().min(1),
  evaluationCacheNamespace: z.string().regex(/^eval-run-[0-9a-f]{64}$/),
  scores: z.array(DeterministicBaselineScoreSchema).min(1),
}).strict();
export type DeterministicBaselineRun = z.infer<typeof DeterministicBaselineRunSchema>;

/**
 * Bind the ordered baseline score vector, including per-example availability,
 * sorted example identities, and big-endian IEEE754 bits (including -0).
 */
export function deterministicBaselineScoreHash(scores: readonly DeterministicBaselineScore[]): string {
  const identity = scores.map((score) => ({
    seed: encodeFiniteScoreBits(score.seed),
    aggregateBits: score.aggregateBits,
    perExampleBits: score.perExampleBits === undefined
      ? null
      : Object.keys(score.perExampleBits).sort().map((id) => [id, score.perExampleBits![id]!]),
  }));
  return `sha256:${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
}

/** One cache identity formula shared by trusted execution and evidence validation. */
export function runScopedEvaluationCacheNamespace(measurementEpoch: string, runId: string): string {
  const identity = canonicalJson({ measurementEpoch, runId });
  return `eval-run-${createHash("sha256").update(identity).digest("hex")}`;
}

const LiteralPositiveZero = z.literal(0).refine((value) => !Object.is(value, -0));
const DeterministicZeroNoiseCalibration = CalibrationIdentity.extend({
  estimator: z.literal(DETERMINISTIC_ZERO_NOISE_ESTIMATOR),
  measurementEpoch: z.string().min(1),
  baselineArtifactHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  baselineRuns: z.array(DeterministicBaselineRunSchema).min(3),
  scoreHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  informationFreeMeasurements: z.number().int().safe().min(3),
  informationFreePairs: z.number().int().safe().min(3),
  informationFreePositive: LiteralPositiveZero,
  maxObservedPairDelta: LiteralPositiveZero,
  noiseFloor: LiteralPositiveZero,
  noiseEnvelope: LiteralPositiveZero,
}).strict();

/**
 * Identity-bound, cohort-bound calibration of the quantity the gate compares.
 * Bitwise-identical fresh baseline repeats establish deterministic zero noise.
 * Otherwise a schedule-faithful local arm uses its direct paired-delta SD; only
 * capsules without one may infer delta noise from pooled score SD. Max observed
 * excursion is a conservative tail guard, not the estimator.
 */
export const PromotionNoiseCalibration = z.discriminatedUnion("estimator", [
  PooledScoreCalibration,
  DirectDeltaCalibration,
  DeterministicZeroNoiseCalibration,
]).superRefine((calibration, ctx) => {
  if (calibration.estimator === DETERMINISTIC_ZERO_NOISE_ESTIMATOR) {
    const baseline = calibration.baselineRuns[0];
    if (baseline === undefined) return;
    const runIds = new Set<string>();
    const namespaces = new Set<string>();
    for (const [runIndex, run] of calibration.baselineRuns.entries()) {
      if (runIds.has(run.runId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baselineRuns", runIndex, "runId"], message: "baseline run IDs must be unique" });
      }
      if (namespaces.has(run.evaluationCacheNamespace)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baselineRuns", runIndex, "evaluationCacheNamespace"], message: "baseline runs must use distinct run-scoped evaluation caches" });
      }
      const expectedNamespace = runScopedEvaluationCacheNamespace(calibration.measurementEpoch, run.runId);
      if (run.evaluationCacheNamespace !== expectedNamespace) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baselineRuns", runIndex, "evaluationCacheNamespace"], message: "run-scoped cache namespace must bind the run ID and measurement epoch" });
      }
      runIds.add(run.runId);
      namespaces.add(run.evaluationCacheNamespace);
      const seeds = new Set<number>();
      if (run.scores.length !== baseline.scores.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baselineRuns", runIndex, "scores"], message: "baseline runs must have the same seed coordinates" });
      }
      for (const [scoreIndex, score] of run.scores.entries()) {
        const path = ["baselineRuns", runIndex, "scores", scoreIndex];
        if (seeds.has(score.seed)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "seed"], message: "baseline seed coordinates must be unique" });
        }
        seeds.add(score.seed);
        const expected = baseline.scores[scoreIndex];
        if (expected === undefined) continue;
        if (!Object.is(score.seed, expected.seed)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "seed"], message: "baseline runs must have the same ordered seed coordinates" });
        }
        if (score.aggregateBits !== expected.aggregateBits) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "aggregateBits"], message: "baseline aggregate scores must have identical IEEE754 bits" });
        }
        if ((score.perExampleBits === undefined) !== (expected.perExampleBits === undefined)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "perExampleBits"], message: "baseline per-example availability must match" });
        } else if (score.perExampleBits !== undefined && expected.perExampleBits !== undefined) {
          const keys = Object.keys(score.perExampleBits).sort();
          const expectedKeys = Object.keys(expected.perExampleBits).sort();
          if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "perExampleBits"], message: "baseline per-example identities must match" });
          } else if (keys.some((key) => score.perExampleBits![key] !== expected.perExampleBits![key])) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, "perExampleBits"], message: "baseline per-example scores must have identical IEEE754 bits" });
          }
        }
      }
    }
    const runCount = calibration.baselineRuns.length;
    const seedCount = baseline.scores.length;
    if (calibration.informationFreeMeasurements !== runCount * seedCount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "informationFreeMeasurements must equal runCount * seedCount" });
    }
    if (calibration.informationFreePairs !== seedCount * runCount * (runCount - 1) / 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "informationFreePairs must equal seedCount * choose(runCount, 2)" });
    }
    // Number refinements can be dirty rather than aborted: never encode a
    // nonfinite seed and turn safeParse into an exception.
    const finiteBaseline = baseline.scores.every((score) => Number.isFinite(score.seed));
    if (finiteBaseline && calibration.scoreHash !== deterministicBaselineScoreHash(baseline.scores)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scoreHash"], message: "scoreHash must bind the baseline score evidence" });
    }
    return;
  }
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

type LegacyPromotionNoiseCalibration = Exclude<
  PromotionNoiseCalibration,
  { estimator: typeof DETERMINISTIC_ZERO_NOISE_ESTIMATOR }
>;

/** Optimizer-facing gate metadata, not evidence admissible as a calibration. */
export const PromotionGateCalibration = z.union([
  PromotionNoiseCalibration.refine(
    (calibration): calibration is LegacyPromotionNoiseCalibration =>
      calibration.estimator !== DETERMINISTIC_ZERO_NOISE_ESTIMATOR,
  ),
  DeterministicZeroNoiseCalibration.omit({ baselineRuns: true, scoreHash: true }),
]);
export type PromotionGateCalibration = z.infer<typeof PromotionGateCalibration>;

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
  calibration: PromotionGateCalibration | null,
): PromotionGateAssessment {
  if (!Number.isFinite(parentScore) || !Number.isFinite(childScore)) {
    throw new RangeError("promotion scores must be finite");
  }
  if (calibration !== null && (
    !Number.isFinite(calibration.noiseFloor)
    || !Number.isFinite(calibration.noiseEnvelope)
    || calibration.noiseFloor < 0
    || calibration.noiseEnvelope < calibration.noiseFloor
  )) {
    throw new RangeError("promotion calibration must have finite ordered noise bounds");
  }
  const delta = childScore - parentScore;
  if (!Number.isFinite(delta)) {
    throw new RangeError("promotion score delta must be finite");
  }
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
