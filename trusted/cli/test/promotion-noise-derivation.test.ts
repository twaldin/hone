import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DETERMINISTIC_ZERO_NOISE_ESTIMATOR, canonicalJson, runScopedEvaluationCacheNamespace } from "@hone/schema";
import {
  BASELINE_NOISE_EVIDENCE_VERSION,
  deriveBaselineNoiseCalibration,
  deriveDeterministicBaselineNoiseCalibration,
  deriveDirectPairedDeltaScales,
  deriveNoiseCalibrations,
  derivePromotionNoiseObservations,
  PROMOTION_NOISE_OBSERVATIONS_VERSION,
} from "../src/promotion-noise-derivation.js";
import type {
  BaselineNoiseRun,
  PromotionNoiseObservationsArtifact,
  RepeatedScoreGroup,
} from "../src/promotion-noise-derivation.js";

const NOISY = "cap_00000000000a";
const QUIET = "cap_00000000000b";
const NOISY_DIGEST = `sha256:${"a1".repeat(32)}`;
const QUIET_DIGEST = `sha256:${"b2".repeat(32)}`;
const ADMITTED_IMAGE = `hone-fixture@sha256:${"c3".repeat(32)}`;
const EXECUTION_IMAGE = `hone-fixture@sha256:${"d4".repeat(32)}`;
const QUIET_IMAGE = `hone-quiet@sha256:${"e5".repeat(32)}`;
const ARTIFACT_1 = `sha256:${"01".repeat(32)}`;
const ARTIFACT_2 = `sha256:${"02".repeat(32)}`;
const BASELINE = `sha256:${"0b".repeat(32)}`;
const EPOCHS = ["m2:fixture-epoch-1", "m2:fixture-epoch-2"];

function group(artifactHash: string, seed: number, observations: Array<[runId: string, score: number]>): RepeatedScoreGroup {
  return {
    artifactHash,
    assetGroupId: "train",
    seed,
    observations: observations.map(([runId, score], index) => ({
      runId,
      at: `2026-01-01T00:00:0${index}.000Z`,
      score,
    })),
  };
}

function capsule(
  capsuleId: string,
  admittedCapsuleDigest: string,
  admittedManifestImage: string,
  executionImage: string,
  groups: RepeatedScoreGroup[],
): PromotionNoiseObservationsArtifact["capsules"][number] {
  return {
    identity: {
      capsuleId,
      admittedCapsuleDigest,
      admittedManifestImage,
      executionImage,
      assetGroupId: "train",
      measurementEpochs: EPOCHS,
    },
    sourceFiles: [],
    groups,
  };
}

/**
 * NOISY was admitted under one image and executed under another. Its groups
 * cover: a varying depth-3 coordinate, a depth-2 coordinate (observed but
 * below the estimator minimum), a constant depth-4 coordinate, a depth-3
 * coordinate with two observations from the same run, and a singleton.
 * QUIET shares a coordinate key with NOISY but scores differently.
 */
const observations: PromotionNoiseObservationsArtifact = {
  version: PROMOTION_NOISE_OBSERVATIONS_VERSION,
  derivedAtCampaignTerminal: "2026-08-28T03:32:53.235Z",
  sourceRoot: "/fixture/.hone-runs",
  capsules: [
    capsule(NOISY, NOISY_DIGEST, ADMITTED_IMAGE, EXECUTION_IMAGE, [
      group(ARTIFACT_1, 0, [["run_1", 0.5], ["run_2", 0.6], ["run_3", 0.7]]),
      group(ARTIFACT_1, 1, [["run_1", 0.4], ["run_2", 0.45]]),
      group(ARTIFACT_2, 0, [["run_1", 0.2], ["run_2", 0.2], ["run_3", 0.2], ["run_4", 0.2]]),
      group(ARTIFACT_2, 1, [["run_1", 0.3], ["run_1", 0.35], ["run_2", 0.3]]),
      group(ARTIFACT_2, 2, [["run_1", 0.9]]),
    ]),
    capsule(QUIET, QUIET_DIGEST, QUIET_IMAGE, QUIET_IMAGE, [
      group(ARTIFACT_1, 0, [["run_5", 0.9], ["run_6", 0.9], ["run_7", 0.9]]),
    ]),
  ],
};

interface NullTrialOverrides {
  capsuleId?: string;
  capsuleDigest?: string;
  image?: string;
  baselineArtifact?: string;
  gateEvents?: number;
  evalAssetGroupIds?: string[];
  evalSeeds?: number[];
}

function nullTrial(parentScore: number, childScore: number, trial: number, overrides: NullTrialOverrides = {}) {
  return {
    version: 1,
    trial,
    capsuleId: NOISY,
    capsuleDigest: NOISY_DIGEST,
    image: EXECUTION_IMAGE,
    baselineArtifact: BASELINE,
    parentScore,
    childScore,
    gateEvents: 1,
    evalAssetGroupIds: ["train", "train"],
    evalSeeds: [trial, trial],
    ...overrides,
  };
}

/** NOISY: six +1/16, six -1/16 and four zero paired deltas. QUIET: sixteen identical pairs. */
function nullCohort(): object[] {
  const quiet = Array.from({ length: 16 }, (_, trial) =>
    nullTrial(0.7, 0.7, trial, { capsuleId: QUIET, capsuleDigest: QUIET_DIGEST, image: QUIET_IMAGE })
  );
  const noisy = Array.from({ length: 16 }, (_, trial) =>
    nullTrial(0.5, trial < 6 ? 0.5625 : trial < 12 ? 0.4375 : 0.5, trial)
  );
  // Cohort order is not capsule order: scales come back sorted by capsule id.
  return [...quiet, ...noisy];
}

function ndjson(rows: readonly object[]): Buffer {
  return Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

describe("promotion-noise derivation", () => {
  it("derives execution identity, rates, sample depths, distribution, and thresholds from raw observations", () => {
    // NOISY estimator coordinates (depth >= 3): SSE 0.02 + 0 + 1/600 over 2 + 3 + 2 dof.
    const pooledSd = Math.sqrt((0.02 + 1 / 600) / 7);
    const [noisy, quiet] = deriveNoiseCalibrations(observations);
    expect(noisy).toEqual({
      capsuleId: NOISY,
      admittedCapsuleDigest: NOISY_DIGEST,
      executionImage: EXECUTION_IMAGE,
      assetGroupId: "train",
      measurementEpochs: EPOCHS,
      estimator: "pooled-within-coordinate-sd-v1",
      estimatorMinRepeatsPerCoordinate: 3,
      sampleDepths: [3, 4, 3],
      informationFreeMeasurements: 10,
      coordinateGroups: 3,
      pooledDegreesOfFreedom: 7,
      pooledWithinCoordinateSd: expect.closeTo(pooledSd, 12),
      noiseFloor: expect.closeTo(3 * pooledSd, 12),
      noiseEnvelope: expect.closeTo(4.5 * pooledSd, 12),
      // Cross-run pairs only: 3 + 1 + 6 + 2 (the same-run pair is skipped).
      informationFreePairs: 12,
      informationFreePositive: 4,
      observedInformationFreeMeasurements: 12,
      observedCoordinateGroups: 4,
      // Sorted deltas: -0.05, 0 x7, 0.05, 0.1, 0.1, 0.2 (linear interpolation).
      deltaDistribution: {
        min: expect.closeTo(-0.05, 12),
        p05: expect.closeTo(-0.0225, 12),
        median: 0,
        p95: expect.closeTo(0.145, 12),
        max: expect.closeTo(0.2, 12),
      },
      sensitivityThresholds: {
        maxSpan: expect.closeTo(0.2, 12),
        p99: expect.closeTo(0.189, 12),
        threeSd: expect.closeTo(3 * pooledSd, 12),
        p95: expect.closeTo(0.145, 12),
        twoSd: expect.closeTo(2 * pooledSd, 12),
      },
    });
    expect(noisy?.executionImage).not.toBe(ADMITTED_IMAGE);
    expect(quiet).toMatchObject({
      capsuleId: QUIET,
      executionImage: QUIET_IMAGE,
      sampleDepths: [3],
      pooledDegreesOfFreedom: 2,
      pooledWithinCoordinateSd: 0,
      informationFreePairs: 3,
      informationFreePositive: 0,
      deltaDistribution: { min: 0, p05: 0, median: 0, p95: 0, max: 0 },
      sensitivityThresholds: { maxSpan: 0, p99: 0, threeSd: 0, p95: 0, twoSd: 0 },
    });
  });

  it("refuses an observation artifact of another version", () => {
    expect(() => deriveNoiseCalibrations({
      ...observations,
      version: "campaign-12-promotion-noise-observations-v1",
    } as unknown as PromotionNoiseObservationsArtifact)).toThrow(/unsupported observation artifact/);
  });

  it("derives each identity-matched local paired-delta SD from the exact cohort bytes", () => {
    const bytes = ndjson(nullCohort());
    const scales = deriveDirectPairedDeltaScales(bytes);
    const sourceCohortSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect(scales).toEqual([
      {
        capsuleId: NOISY,
        admittedCapsuleDigest: NOISY_DIGEST,
        executionImage: EXECUTION_IMAGE,
        assetGroupId: "train",
        baselineArtifactHash: BASELINE,
        pairedDeltaTrials: 16,
        pairedDeltaDegreesOfFreedom: 15,
        // Twelve deltas of magnitude 1/16 around a zero mean over 15 dof.
        pairedDeltaSd: Math.sqrt((12 / 256) / 15),
        informationFreePositive: 6,
        maxObservedLocalPairDelta: 0.0625,
        sourceCohortSha256,
      },
      {
        capsuleId: QUIET,
        admittedCapsuleDigest: QUIET_DIGEST,
        executionImage: QUIET_IMAGE,
        assetGroupId: "train",
        baselineArtifactHash: BASELINE,
        pairedDeltaTrials: 16,
        pairedDeltaDegreesOfFreedom: 15,
        pairedDeltaSd: 0,
        informationFreePositive: 0,
        maxObservedLocalPairDelta: 0,
        sourceCohortSha256,
      },
    ]);
  });

  it("rejects an admitted-image substitute or any other evaluator identity drift within a capsule cohort", () => {
    for (const drift of [
      { image: ADMITTED_IMAGE },
      { capsuleDigest: QUIET_DIGEST },
      { baselineArtifact: `sha256:${"0c".repeat(32)}` },
    ]) {
      const cohort = nullCohort();
      cohort[19] = nullTrial(0.5, 0.5625, 3, drift);
      expect(() => deriveDirectPairedDeltaScales(ndjson(cohort)), JSON.stringify(drift)).toThrow(
        `${NOISY} local null trials disagree on evaluator identity`,
      );
    }
  });

  it("rejects trials that are not schedule-faithful single-gate train pairs", () => {
    for (const unfaithful of [
      { gateEvents: 2 },
      { evalAssetGroupIds: ["train", "promotion-holdout"] },
      { evalSeeds: [3, 4] },
      { evalSeeds: [3] },
    ]) {
      const cohort = nullCohort();
      cohort[19] = nullTrial(0.5, 0.5625, 3, unfaithful);
      expect(() => deriveDirectPairedDeltaScales(ndjson(cohort)), JSON.stringify(unfaithful)).toThrow(
        /missing schedule-faithful paired evidence/,
      );
    }
  });

  it("requires exactly sixteen local null trials per capsule", () => {
    expect(() => deriveDirectPairedDeltaScales(ndjson(nullCohort().slice(0, -1)))).toThrow(
      `${NOISY} has 15 local null trials, expected 16`,
    );
  });

  it("fails loudly when the requested journal evidence root is absent", () => {
    expect(() => derivePromotionNoiseObservations("/definitely/missing/campaign-12-evidence")).toThrow(
      /evidence root does not exist/,
    );
  });
});

describe("baseline-only noise runs -> sealed-epoch promotion calibration", () => {
  const identity = {
    capsuleId: NOISY,
    admittedCapsuleDigest: NOISY_DIGEST,
    executionImage: EXECUTION_IMAGE,
    assetGroupId: "train",
    measurementEpoch: "compress-2026-10",
    seeds: [0, 1, 2],
  };
  const fact = (seed: number, score: number, over: Partial<BaselineNoiseRun["facts"][number]["record"]> = {}) => ({
    measurementEpoch: identity.measurementEpoch,
    aggregate: score,
    record: {
      capsuleId: NOISY,
      artifactHash: BASELINE,
      assetGroupId: "train",
      seed,
      output: { valid: true, objectives: { score }, constraints: {}, perExample: {} },
      costUsd: 0,
      durationMs: 1,
      cached: false,
      evaluatedAt: "2026-10-05T00:00:00.000Z",
      ...over,
    },
  });
  // R repeats × three seeds; each seed alternates ±0.01 around its own level.
  const cohort = (repeats: number): BaselineNoiseRun[] =>
    Array.from({ length: repeats }, (_, repeat) => ({
      runId: `run_noise_r${repeat}`,
      facts: identity.seeds.map((seed) => fact(seed, 0.5 + seed * 0.1 + (repeat % 2 === 0 ? 0.01 : -0.01))),
    }));

  it("derives a schema-valid pooled-score calibration bound to the sealed epoch and admitted identity", () => {
    const { calibration, observations } = deriveBaselineNoiseCalibration(cohort(7), identity, "2026-10-05T01:00:00.000Z");
    expect(calibration).toMatchObject({
      evidenceVersion: BASELINE_NOISE_EVIDENCE_VERSION,
      calibratedAt: "2026-10-05T01:00:00.000Z",
      capsuleId: NOISY,
      admittedCapsuleDigest: NOISY_DIGEST,
      executionImage: EXECUTION_IMAGE,
      assetGroupId: "train",
      measurementEpoch: "compress-2026-10",
      estimator: "pooled-within-coordinate-sd-v1",
      sampleDepths: [7, 7, 7],
      informationFreeMeasurements: 21,
      coordinateGroups: 3,
      pooledDegreesOfFreedom: 18,
      informationFreePairs: 63,
    });
    if (calibration.estimator !== "pooled-within-coordinate-sd-v1") throw new Error("unexpected estimator");
    // Four +0.01 and three −0.01 per coordinate: pooled variance 0.0001 × 8/7.
    expect(calibration.pooledWithinCoordinateSd).toBeCloseTo(0.01 * Math.sqrt(8 / 7), 12);
    expect(calibration.maxObservedPairDelta).toBeCloseTo(0.02, 12);
    expect(calibration.noiseEnvelope).toBeCloseTo(4.5 * 0.01 * Math.sqrt(8 / 7), 12);
    expect(calibration.sourceCohortSha256).toEqual([
      `sha256:${createHash("sha256").update(canonicalJson(observations)).digest("hex")}`,
    ]);
    expect(observations.identity.baselineArtifactHash).toBe(BASELINE);
    expect(observations.runIds).toHaveLength(7);
  });

  it("never lowers the schema minimums and refuses an unfaithful cohort", () => {
    // Six repeats: 18 measurements, 15 degrees of freedom — below the minimums.
    expect(() => deriveBaselineNoiseCalibration(cohort(6), identity, "2026-10-05T01:00:00.000Z")).toThrow();
    const runs = cohort(7);
    const replace = (index: number, facts: BaselineNoiseRun["facts"]) =>
      runs.map((run, at) => (at === index ? { ...run, facts } : run));
    const first = runs[0]?.facts ?? [];
    expect(() => deriveBaselineNoiseCalibration(replace(3, first.slice(1)), identity, "t"))
      .toThrow(/run_noise_r3 holds 0 measurements of seed 0/);
    expect(() => deriveBaselineNoiseCalibration(replace(2, first.map((f) => ({ ...f, measurementEpoch: "other" }))), identity, "t"))
      .toThrow(/run_noise_r2 holds 0 measurements/);
    expect(() => deriveBaselineNoiseCalibration(replace(1, [fact(0, 0.51, { cached: true }), ...first.slice(1)]), identity, "t"))
      .toThrow(/memo hit/);
    expect(() => deriveBaselineNoiseCalibration(replace(4, [fact(0, 0.51, { artifactHash: ARTIFACT_1 }), ...first.slice(1)]), identity, "t"))
      .toThrow(/not the cohort baseline/);
    expect(() => deriveBaselineNoiseCalibration(replace(5, [{ ...fact(0, 0.51), aggregate: null }, ...first.slice(1)]), identity, "t"))
      .toThrow(/not eligible/);
  });
});

describe("deterministic baseline-only calibration", () => {
  const identity = {
    capsuleId: NOISY,
    admittedCapsuleDigest: NOISY_DIGEST,
    executionImage: EXECUTION_IMAGE,
    assetGroupId: "train",
    measurementEpoch: "compress-2026-10",
    baselineArtifactHash: BASELINE,
    seeds: [0],
  };
  const at = "2026-10-05T01:00:00.000Z";
  function cohort(seeds = [0]): BaselineNoiseRun[] {
    return Array.from({ length: 3 }, (_, repeat) => ({
      runId: `run_noise_r${repeat}`,
      facts: seeds.map((seed) => ({
        evaluationCacheNamespace: runScopedEvaluationCacheNamespace(identity.measurementEpoch, `run_noise_r${repeat}`),
        measurementEpoch: identity.measurementEpoch,
        aggregate: 0.5 + seed,
        scoreBits: {
          aggregateBits: seed === 0 ? "3fe0000000000000" : "3ff8000000000000",
          perExampleBits: { a: "3fd0000000000000", b: "3fe8000000000000" },
        },
        record: {
          capsuleId: NOISY,
          artifactHash: BASELINE,
          assetGroupId: "train",
          seed,
          output: {
            valid: true, objectives: { score: 0.5 + seed }, constraints: {},
            perExample: { a: { score: 0.25 }, b: { score: 0.75 } },
          },
          costUsd: 0,
          durationMs: 1,
          cached: false,
          evaluatedAt: at,
        },
      })),
    }));
  }

  it.each([{ seeds: [0] }, { seeds: [0, 1] }])("accepts identical fresh vectors for $seeds", ({ seeds }) => {
    const { calibration, observations } = deriveDeterministicBaselineNoiseCalibration(cohort(seeds), { ...identity, seeds }, at);
    expect(calibration).toMatchObject({
      estimator: DETERMINISTIC_ZERO_NOISE_ESTIMATOR,
      capsuleId: NOISY, admittedCapsuleDigest: NOISY_DIGEST,
      executionImage: EXECUTION_IMAGE, assetGroupId: "train",
      measurementEpoch: identity.measurementEpoch, baselineArtifactHash: BASELINE,
      maxObservedPairDelta: 0, noiseFloor: 0, noiseEnvelope: 0, informationFreePositive: 0,
    });
    expect(calibration.informationFreePairs).toBe(seeds.length === 1 ? 3 : 6);
    expect(observations.baselineRuns).toHaveLength(3);
    expect(observations.baselineRuns[0]?.scores[0]).toEqual({
      seed: 0, aggregateBits: "3fe0000000000000", perExampleBits: { a: "3fd0000000000000", b: "3fe8000000000000" },
    });
    expect(observations.identity.baselineArtifactHash).toBe(BASELINE);
    expect(observations.version).toBe("hone-deterministic-zero-noise-observations-v1");
  });

  it("refuses a common wrong artifact instead of learning baseline identity from the first fact", () => {
    const runs = cohort().map((run) => ({
      ...run, facts: run.facts.map((fact) => ({ ...fact, record: { ...fact.record, artifactHash: ARTIFACT_1 } })),
    }));
    expect(() => deriveDeterministicBaselineNoiseCalibration(runs, identity, at)).toThrow(/not the admitted baseline/);
    const { baselineArtifactHash: _hash, ...missing } = identity;
    expect(() => deriveDeterministicBaselineNoiseCalibration(cohort(), missing, at)).toThrow(/admitted baseline artifact hash/);
  });

  it.each(["0000000000000000", "8000000000000000"])("preserves equal finite signed-zero vectors %s after JSON roundtrip", (zeroBits) => {
    const runs = cohort().map((run) => ({
      ...run,
      facts: run.facts.map((fact) => ({
        ...fact, aggregate: -0,
        scoreBits: { aggregateBits: zeroBits, perExampleBits: { a: zeroBits, b: zeroBits } },
        record: { ...fact.record, output: { ...fact.record.output, perExample: { a: { score: -0 }, b: { score: -0 } } } },
      })),
    }));
    const journalRuns = JSON.parse(JSON.stringify(runs)) as BaselineNoiseRun[];
    const { calibration, observations } = deriveDeterministicBaselineNoiseCalibration(journalRuns, identity, at);
    expect(calibration.noiseEnvelope).toBe(0);
    expect(JSON.parse(JSON.stringify(observations)).baselineRuns[0].scores[0]).toEqual({
      seed: 0, aggregateBits: zeroBits, perExampleBits: { a: zeroBits, b: zeroBits },
    });
  });

  it.each(["aggregate", "example"])("refuses mixed signed-zero %s bits even when JSON journal numbers are all zero", (coordinate) => {
    const runs = cohort().map((run, repeat) => ({
      ...run,
      facts: run.facts.map((fact) => ({
        ...fact, aggregate: 0,
        scoreBits: {
          aggregateBits: coordinate === "aggregate" && repeat === 1 ? "8000000000000000" : "0000000000000000",
          perExampleBits: { a: coordinate === "example" && repeat === 1 ? "8000000000000000" : "0000000000000000" },
        },
        record: { ...fact.record, output: { ...fact.record.output, perExample: { a: { score: -0 } } } },
      })),
    }));
    expect(() => deriveDeterministicBaselineNoiseCalibration(JSON.parse(JSON.stringify(runs)), identity, at)).toThrow();
  });

  const invalidFacts: Array<[string, (fact: BaselineNoiseRun["facts"][number]) => BaselineNoiseRun["facts"][number]]> = [
    ["missing trusted score bits", (fact) => {
      const missing = { ...fact };
      delete missing.scoreBits;
      return missing;
    }],
    ["invalid trusted score bits", (fact) => ({ ...fact, scoreBits: { aggregateBits: "invalid" } })],
    ["nonfinite trusted score bits", (fact) => ({ ...fact, scoreBits: { ...fact.scoreBits!, aggregateBits: "7ff0000000000000" } })],
    ["aggregate bits tampered", (fact) => ({ ...fact, scoreBits: { ...fact.scoreBits!, aggregateBits: "3fe8000000000000" } })],
    ["example bits tampered", (fact) => ({ ...fact, scoreBits: { ...fact.scoreBits!, perExampleBits: { a: "3fd0000000000000", b: "3fd0000000000000" } } })],
    ["missing example bit stamp", (fact) => ({ ...fact, scoreBits: { aggregateBits: "3fe0000000000000" } })],
    ["different example bit keys", (fact) => ({ ...fact, scoreBits: { ...fact.scoreBits!, perExampleBits: { a: "3fd0000000000000", c: "3fe8000000000000" } } })],
    ["aggregate differs", (fact) => ({ ...fact, aggregate: 0.5000000000000001 })],
    ["example score differs despite equal aggregate", (fact) => ({
      ...fact, record: { ...fact.record, output: { ...fact.record.output, perExample: { a: { score: 0.25 }, b: { score: 0.76 } } } },
    })],
    ["example availability differs", (fact) => ({
      ...fact, record: { ...fact.record, output: { ...fact.record.output, perExample: {} } },
    })],
    ["example score is nonfinite", (fact) => ({
      ...fact, record: { ...fact.record, output: { ...fact.record.output, perExample: { a: { score: Infinity } } } },
    })],
    ["aggregate is nonfinite", (fact) => ({ ...fact, aggregate: NaN })],
    ["aggregate is ineligible", (fact) => ({ ...fact, aggregate: null })],
    ["memo hit", (fact) => ({ ...fact, record: { ...fact.record, cached: true } })],
    ["wrong capsule", (fact) => ({ ...fact, record: { ...fact.record, capsuleId: QUIET } })],
    ["wrong group", (fact) => ({ ...fact, record: { ...fact.record, assetGroupId: "validation" } })],
    ["wrong epoch", (fact) => ({ ...fact, measurementEpoch: "other" })],
    ["wrong artifact", (fact) => ({ ...fact, record: { ...fact.record, artifactHash: ARTIFACT_1 } })],
    ["unplanned seed", (fact) => ({ ...fact, record: { ...fact.record, seed: 2 } })],
    ["missing cache namespace", (fact) => {
      const missing = { ...fact };
      delete missing.evaluationCacheNamespace;
      return missing;
    }],
    ["shared cache namespace", (fact) => ({ ...fact, evaluationCacheNamespace: `eval-run-${"1".repeat(64)}` })],
    ["non-run cache namespace", (fact) => ({ ...fact, evaluationCacheNamespace: "eval" })],
    ["signed-zero aggregate", (fact) => ({ ...fact, aggregate: -0 })],
  ];
  it.each(invalidFacts)("refuses %s", (_name, change) => {
    const runs = cohort();
    runs[1] = { ...runs[1]!, facts: runs[1]!.facts.map(change) };
    expect(() => deriveDeterministicBaselineNoiseCalibration(runs, identity, at)).toThrow();
  });

  it("refuses missing, duplicate or extraneous measurements and non-distinct runs", () => {
    const runs = cohort();
    const first = runs[0]!;
    for (const facts of [[], [...first.facts, ...first.facts], [
      ...first.facts,
      { ...first.facts[0]!, record: { ...first.facts[0]!.record, artifactHash: ARTIFACT_1, assetGroupId: "validation" } },
    ]]) {
      expect(() => deriveDeterministicBaselineNoiseCalibration([{ ...first, facts }, ...runs.slice(1)], identity, at)).toThrow();
    }
    expect(() => deriveDeterministicBaselineNoiseCalibration(runs.slice(1), identity, at)).toThrow();
    expect(() => deriveDeterministicBaselineNoiseCalibration([first, first, runs[2]!], identity, at)).toThrow();
    expect(() => deriveDeterministicBaselineNoiseCalibration(cohort(), { ...identity, seeds: [0, 0] }, at)).toThrow();
  });

  it("requires one consistent cache namespace within a multi-seed run", () => {
    const runs = cohort([0, 1]);
    runs[0] = {
      ...runs[0]!,
      facts: runs[0]!.facts.map((fact, index) => index === 0 ? fact : { ...fact, evaluationCacheNamespace: `eval-run-${"9".repeat(64)}` }),
    };
    expect(() => deriveDeterministicBaselineNoiseCalibration(runs, { ...identity, seeds: [0, 1] }, at)).toThrow(/inconsistent/);
  });
});
