import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_ZERO_NOISE_ESTIMATOR,
  DIRECT_PAIRED_DELTA_SD_ESTIMATOR,
  POOLED_SCORE_SD_ESTIMATOR,
  PROMOTION_GATE_VERSION,
  PromotionNoiseCalibration,
  assessPromotion,
  canonicalJson,
  deterministicBaselineScoreHash,
} from "../src/index.js";
import type { DeterministicBaselineRun, DeterministicBaselineScore } from "../src/index.js";

const hash = (digit: string): string => `sha256:${digit.repeat(64)}`;
const identity = {
  gateVersion: PROMOTION_GATE_VERSION,
  evidenceVersion: "hone-baseline-noise-v1",
  calibratedAt: "2026-10-06T12:00:00.000Z",
  capsuleId: "cap_0123456789ab",
  admittedCapsuleDigest: hash("a"),
  executionImage: `hone-evaluator@${hash("b")}`,
  assetGroupId: "train",
  measurementEpoch: "noise:deterministic-test",
  sourceCohortSha256: [hash("c")],
};

function runNamespace(runId: string, measurementEpoch = identity.measurementEpoch): string {
  return `eval-run-${createHash("sha256").update(canonicalJson({ measurementEpoch, runId })).digest("hex")}`;
}

function deterministicInput(scores: DeterministicBaselineScore[] = [{ seed: 7, aggregate: 1 }], runCount = 3) {
  const baselineRuns: DeterministicBaselineRun[] = Array.from({ length: runCount }, (_, index) => ({
    runId: `noise-run-${index}`,
    evaluationCacheNamespace: runNamespace(`noise-run-${index}`),
    scores: scores.map((score) => ({
      ...score,
      ...(score.perExample === undefined ? {} : { perExample: { ...score.perExample } }),
    })),
  }));
  return {
    ...identity,
    estimator: DETERMINISTIC_ZERO_NOISE_ESTIMATOR,
    baselineArtifactHash: hash("d"),
    baselineRuns,
    scoreHash: deterministicBaselineScoreHash(scores),
    informationFreeMeasurements: runCount * scores.length,
    informationFreePairs: scores.length * runCount * (runCount - 1) / 2,
    informationFreePositive: 0,
    maxObservedPairDelta: 0,
    noiseFloor: 0,
    noiseEnvelope: 0,
  };
}

function pooledInput() {
  return {
    ...identity,
    estimator: POOLED_SCORE_SD_ESTIMATOR,
    estimatorMinRepeatsPerCoordinate: 3,
    sampleDepths: [7, 7, 7],
    informationFreeMeasurements: 21,
    coordinateGroups: 3,
    pooledDegreesOfFreedom: 18,
    pooledWithinCoordinateSd: 0.2,
    informationFreePairs: 63,
    informationFreePositive: 31,
    maxObservedPairDelta: 0.4,
    noiseFloor: 3 * 0.2,
    noiseEnvelope: 4.5 * 0.2,
  };
}

function directInput() {
  return {
    ...identity,
    estimator: DIRECT_PAIRED_DELTA_SD_ESTIMATOR,
    pairedDeltaTrials: 16,
    pairedDeltaDegreesOfFreedom: 15,
    pairedDeltaSd: 0.2,
    localArmBaselineHash: hash("d"),
    informationFreePairs: 16,
    informationFreePositive: 8,
    maxObservedPairDelta: 0.4,
    noiseFloor: (3 / Math.SQRT2) * 0.2,
    noiseEnvelope: (4.5 / Math.SQRT2) * 0.2,
  };
}

const perExampleScores: DeterministicBaselineScore[] = [
  { seed: 7, aggregate: 0.3, perExample: { first: 0.25, second: 0.35 } },
  { seed: 11, aggregate: 0.5, perExample: { first: 0.4, second: 0.6 } },
];

describe("deterministic zero-noise calibration evidence", () => {
  it("accepts three independent baseline runs on one seed and survives JSON publication", () => {
    const input = deterministicInput();
    expect(PromotionNoiseCalibration.parse(input)).toEqual(input);
    expect(PromotionNoiseCalibration.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  it("accepts multiple seeds and derives counts per seed, not by pooling coordinates", () => {
    const input = deterministicInput(perExampleScores, 4);
    expect(input.informationFreeMeasurements).toBe(8);
    expect(input.informationFreePairs).toBe(12);
    expect(PromotionNoiseCalibration.parse(input)).toEqual(input);
  });

  it("accepts identical per-example scores regardless of object insertion order", () => {
    const input = deterministicInput(perExampleScores);
    input.baselineRuns[1]!.scores[0]!.perExample = { second: 0.35, first: 0.25 };
    expect(PromotionNoiseCalibration.safeParse(input).success).toBe(true);
  });

  it.each([0, 1, 2])("refuses only %i baseline runs", (runCount) => {
    expect(PromotionNoiseCalibration.safeParse(deterministicInput(undefined, runCount)).success).toBe(false);
  });

  it("refuses no seed coordinates even when there are three runs", () => {
    expect(PromotionNoiseCalibration.safeParse(deterministicInput([])).success).toBe(false);
  });

  it.each(["runId", "evaluationCacheNamespace"] as const)("refuses duplicate %s identities", (field) => {
    const input = deterministicInput();
    input.baselineRuns[2]![field] = input.baselineRuns[0]![field];
    expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
  });

  it.each(["eval", `eval-${"a".repeat(64)}`, "eval-run-short", `eval-run-${"A".repeat(64)}`])(
    "refuses cache namespace %s that is not run-scoped",
    (namespace) => {
      const input = deterministicInput();
      input.baselineRuns[1]!.evaluationCacheNamespace = namespace;
      expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
    },
  );

  it("refuses well-formed cache namespaces bound to another run or measurement epoch", () => {
    const changedRun = deterministicInput();
    changedRun.baselineRuns[1]!.runId = "another-run";
    const changedEpoch = { ...deterministicInput(), measurementEpoch: "noise:another-epoch" };
    const fabricatedNamespace = deterministicInput();
    fabricatedNamespace.baselineRuns[1]!.evaluationCacheNamespace = `eval-run-${"f".repeat(64)}`;
    for (const input of [changedRun, changedEpoch, fabricatedNamespace]) {
      expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
    }
  });

  it("refuses duplicate seeds even when every run and the hash agree", () => {
    const input = deterministicInput([{ seed: 7, aggregate: 1 }, { seed: 7, aggregate: 1 }]);
    expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
  });

  it("refuses missing, different, or reordered seed coordinates", () => {
    const missing = deterministicInput(perExampleScores);
    missing.baselineRuns[1]!.scores.pop();
    const changed = deterministicInput(perExampleScores);
    changed.baselineRuns[1]!.scores[0]!.seed = 8;
    const reordered = deterministicInput(perExampleScores);
    reordered.baselineRuns[1]!.scores.reverse();
    for (const input of [missing, changed, reordered]) {
      expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
    }
  });

  it("refuses bitwise aggregate disagreement even below a typical epsilon tolerance", () => {
    const input = deterministicInput(perExampleScores);
    input.baselineRuns[1]!.scores[0]!.aggregate = 0.30000000000000004;
    expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
  });

  it("refuses changed per-example availability, identities, or score bits", () => {
    const unavailable = deterministicInput(perExampleScores);
    delete unavailable.baselineRuns[1]!.scores[0]!.perExample;
    const missing = deterministicInput(perExampleScores);
    delete missing.baselineRuns[1]!.scores[0]!.perExample!.second;
    const renamed = deterministicInput(perExampleScores);
    renamed.baselineRuns[1]!.scores[0]!.perExample = { first: 0.25, renamed: 0.35 };
    const changed = deterministicInput(perExampleScores);
    changed.baselineRuns[1]!.scores[0]!.perExample!.first = 0.25000000000000006;
    const newlyAvailable = deterministicInput();
    newlyAvailable.baselineRuns[1]!.scores[0]!.perExample = {};
    for (const input of [unavailable, missing, renamed, changed, newlyAvailable]) {
      expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
    }
  });

  it.each([NaN, Infinity, -Infinity])("refuses nonfinite score evidence %s without throwing from safeParse", (value) => {
    for (const field of ["seed", "aggregate", "perExample"] as const) {
      const input = deterministicInput(perExampleScores);
      if (field === "perExample") input.baselineRuns[0]!.scores[0]!.perExample!.first = value;
      else input.baselineRuns[0]!.scores[0]![field] = value;
      expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
    }
  });

  it.each([-1, 0.5])("refuses invalid seed coordinate %s", (seed) => {
    const input = deterministicInput([{ seed, aggregate: 1 }]);
    expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
  });

  it.each(["seed", "aggregate", "perExample"] as const)("fails closed on signed-zero %s evidence before JSON can erase it", (field) => {
    const input = deterministicInput();
    for (const run of input.baselineRuns) {
      if (field === "perExample") run.scores[0]!.perExample = { example: -0 };
      else run.scores[0]![field] = -0;
    }
    input.scoreHash = deterministicBaselineScoreHash(input.baselineRuns[0]!.scores);
    expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
    expect(PromotionNoiseCalibration.safeParse(JSON.parse(JSON.stringify(input))).success).toBe(false);
  });

  it.each(["noiseFloor", "noiseEnvelope", "maxObservedPairDelta", "informationFreePositive"] as const)(
    "requires literal positive zero for %s",
    (field) => {
      for (const value of [Number.MIN_VALUE, -0, -1, NaN, Infinity]) {
        expect(PromotionNoiseCalibration.safeParse({ ...deterministicInput(), [field]: value }).success).toBe(false);
      }
    },
  );

  it.each(["informationFreeMeasurements", "informationFreePairs"] as const)("refuses inconsistent %s counts", (field) => {
    const input = deterministicInput(perExampleScores, 4);
    expect(PromotionNoiseCalibration.safeParse({ ...input, [field]: input[field] + 1 }).success).toBe(false);
  });

  it("refuses a tampered hash or changed scores even when all repeats agree", () => {
    const input = deterministicInput(perExampleScores);
    expect(PromotionNoiseCalibration.safeParse({ ...input, scoreHash: hash("e") }).success).toBe(false);
    for (const run of input.baselineRuns) run.scores[0]!.aggregate = 0.4;
    expect(PromotionNoiseCalibration.safeParse(input).success).toBe(false);
  });

  it.each([
    ["gateVersion", "noise-envelope-v2"],
    ["evidenceVersion", ""],
    ["calibratedAt", "not-a-timestamp"],
    ["capsuleId", "cap_invalid"],
    ["admittedCapsuleDigest", "not-a-digest"],
    ["executionImage", hash("a")],
    ["assetGroupId", ""],
    ["measurementEpoch", null],
    ["sourceCohortSha256", []],
    ["baselineArtifactHash", "not-a-hash"],
  ])("refuses malformed or absent identity %s", (field, value) => {
    const input = deterministicInput();
    expect(PromotionNoiseCalibration.safeParse({ ...input, [field as string]: value }).success).toBe(false);
    const missing: Record<string, unknown> = { ...input };
    delete missing[field as string];
    expect(PromotionNoiseCalibration.safeParse(missing).success).toBe(false);
  });

  it("rejects trusted booleans and pooled fields as substitutes for deterministic evidence", () => {
    const input = deterministicInput();
    expect(PromotionNoiseCalibration.safeParse({ ...input, deterministic: true }).success).toBe(false);
    expect(PromotionNoiseCalibration.safeParse({ ...input, pooledWithinCoordinateSd: 0 }).success).toBe(false);
    expect(PromotionNoiseCalibration.safeParse({ ...input, baselineRuns: undefined }).success).toBe(false);
  });
});

describe("bitwise baseline score hashing", () => {
  it("ignores example object order but binds score order, seeds, examples, and available score bits", () => {
    const original = deterministicBaselineScoreHash(perExampleScores);
    expect(deterministicBaselineScoreHash([
      { ...perExampleScores[0]!, perExample: { second: 0.35, first: 0.25 } },
      perExampleScores[1]!,
    ])).toBe(original);
    for (const changed of [
      [...perExampleScores].reverse(),
      [{ ...perExampleScores[0]!, seed: 8 }, perExampleScores[1]!],
      [{ ...perExampleScores[0]!, aggregate: 0.30000000000000004 }, perExampleScores[1]!],
      [{ ...perExampleScores[0]!, perExample: { first: 0.25, renamed: 0.35 } }, perExampleScores[1]!],
      [{ ...perExampleScores[0]!, perExample: { first: 0.25000000000000006, second: 0.35 } }, perExampleScores[1]!],
    ]) {
      expect(deterministicBaselineScoreHash(changed)).not.toBe(original);
    }
    expect(deterministicBaselineScoreHash([{ seed: 7, aggregate: 1 }])).not.toBe(
      deterministicBaselineScoreHash([{ seed: 7, aggregate: 1, perExample: {} }]),
    );
  });

  it("distinguishes positive and negative zero rather than letting JSON normalize their bits", () => {
    expect(deterministicBaselineScoreHash([{ seed: 7, aggregate: 0 }])).not.toBe(
      deterministicBaselineScoreHash([{ seed: 7, aggregate: -0 }]),
    );
    expect(deterministicBaselineScoreHash([{ seed: 7, aggregate: 1, perExample: { example: 0 } }])).not.toBe(
      deterministicBaselineScoreHash([{ seed: 7, aggregate: 1, perExample: { example: -0 } }]),
    );
  });

  it.each([NaN, Infinity, -Infinity])("refuses nonfinite hash inputs %s", (aggregate) => {
    expect(() => deterministicBaselineScoreHash([{ seed: 7, aggregate }])).toThrow(RangeError);
  });
});

describe("promotion gate boundaries", () => {
  it("promotes only strictly better scores at a zero envelope", () => {
    const calibration = PromotionNoiseCalibration.parse(deterministicInput());
    expect(assessPromotion(1, 1 + Number.EPSILON, calibration)).toMatchObject({ decision: "promote", passed: true });
    for (const child of [1, 0.9]) {
      expect(assessPromotion(1, child, calibration)).toMatchObject({ decision: "refuse-no-improvement", passed: false });
    }
    const smallestGain = assessPromotion(0, Number.MIN_VALUE, calibration);
    expect(smallestGain).toMatchObject({ decision: "promote", passed: true, delta: Number.MIN_VALUE, noiseFloor: 0, noiseEnvelope: 0 });
  });

  it("keeps improvement uncalibrated when no calibration is supplied", () => {
    expect(assessPromotion(0, 1, null)).toMatchObject({ decision: "refuse-uncalibrated", passed: false, delta: 1 });
    expect(assessPromotion(1, 1, null)).toMatchObject({ decision: "refuse-no-improvement", passed: false, delta: 0 });
  });

  it.each([[NaN, 1], [1, NaN], [Infinity, 1], [1, Infinity], [-Infinity, 1], [1, -Infinity]])(
    "refuses nonfinite inputs %s -> %s without returning nonfinite gate facts",
    (parent, child) => {
      const calibration = PromotionNoiseCalibration.parse(deterministicInput());
      expect(() => assessPromotion(parent!, child!, calibration)).toThrow(RangeError);
      expect(() => assessPromotion(parent!, child!, null)).toThrow(RangeError);
    },
  );

  it("refuses finite-input subtraction overflow rather than inventing a finite delta", () => {
    const calibration = PromotionNoiseCalibration.parse(deterministicInput());
    expect(() => assessPromotion(-Number.MAX_VALUE, Number.MAX_VALUE, calibration)).toThrow(RangeError);
    expect(() => assessPromotion(Number.MAX_VALUE, -Number.MAX_VALUE, calibration)).toThrow(RangeError);
  });

  it("refuses invalid numeric noise bounds even for equal scores", () => {
    const calibration = PromotionNoiseCalibration.parse(pooledInput());
    if (calibration.estimator !== POOLED_SCORE_SD_ESTIMATOR) throw new Error("expected pooled calibration");
    for (const invalid of [
      { ...calibration, noiseFloor: NaN },
      { ...calibration, noiseEnvelope: Infinity },
      { ...calibration, noiseFloor: -1 },
      { ...calibration, noiseFloor: 2, noiseEnvelope: 1 },
    ]) {
      expect(() => assessPromotion(1, 1, invalid)).toThrow(RangeError);
      expect(() => assessPromotion(1, 2, invalid)).toThrow(RangeError);
    }
  });
});

describe("existing pooled and direct estimator contracts", () => {
  it("preserves the old powered pooled and direct fixtures, including nullable epochs", () => {
    for (const input of [pooledInput(), directInput()]) {
      expect(PromotionNoiseCalibration.parse(input)).toEqual(input);
      expect(PromotionNoiseCalibration.safeParse({ ...input, measurementEpoch: null }).success).toBe(true);
    }
  });

  it("preserves existing zero-scale pooled and direct calibrations without migrating their estimator", () => {
    const zeroBounds = { informationFreePositive: 0, maxObservedPairDelta: 0, noiseFloor: 0, noiseEnvelope: 0 };
    for (const input of [
      { ...pooledInput(), ...zeroBounds, pooledWithinCoordinateSd: 0 },
      { ...directInput(), ...zeroBounds, pairedDeltaSd: 0 },
    ]) {
      const calibration = PromotionNoiseCalibration.parse(input);
      expect(calibration.estimator).toBe(input.estimator);
      expect(assessPromotion(1, 1, calibration).passed).toBe(false);
      expect(assessPromotion(1, 1 + Number.EPSILON, calibration).passed).toBe(true);
    }
  });

  it("preserves pooled floor, indeterminate, envelope-equality, and promotion decisions", () => {
    const calibration = PromotionNoiseCalibration.parse(pooledInput());
    expect(assessPromotion(0, 0.5, calibration)).toMatchObject({ decision: "refuse-within-noise", passed: false });
    expect(assessPromotion(0, 0.75, calibration)).toMatchObject({ decision: "refuse-indeterminate", passed: false });
    expect(assessPromotion(0, calibration.noiseEnvelope, calibration).passed).toBe(false);
    expect(assessPromotion(0, 1, calibration)).toMatchObject({ decision: "promote", passed: true });
  });

  it("preserves direct-delta boundaries and rejects under-powered direct trials", () => {
    const calibration = PromotionNoiseCalibration.parse(directInput());
    expect(assessPromotion(0, calibration.noiseFloor / 2, calibration).decision).toBe("refuse-within-noise");
    expect(assessPromotion(0, (calibration.noiseFloor + calibration.noiseEnvelope) / 2, calibration).decision).toBe("refuse-indeterminate");
    expect(assessPromotion(0, calibration.noiseEnvelope, calibration).passed).toBe(false);
    expect(assessPromotion(0, 1, calibration).passed).toBe(true);
    expect(PromotionNoiseCalibration.safeParse({ ...directInput(), pairedDeltaTrials: 15, pairedDeltaDegreesOfFreedom: 14 }).success).toBe(false);
  });

  it("does not relax the original pooled measurement or count invariants", () => {
    expect(PromotionNoiseCalibration.safeParse({ ...pooledInput(), sampleDepths: [3, 3, 3], informationFreeMeasurements: 9, pooledDegreesOfFreedom: 6 }).success).toBe(false);
    expect(PromotionNoiseCalibration.safeParse({ ...pooledInput(), informationFreeMeasurements: 22 }).success).toBe(false);
    expect(PromotionNoiseCalibration.safeParse({ ...pooledInput(), pooledDegreesOfFreedom: 19 }).success).toBe(false);
    expect(PromotionNoiseCalibration.safeParse({ ...pooledInput(), noiseEnvelope: 0.4 }).success).toBe(false);
  });
});
