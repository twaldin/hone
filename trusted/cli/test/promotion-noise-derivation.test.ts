import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveDirectPairedDeltaScales,
  deriveNoiseCalibrations,
  derivePromotionNoiseObservations,
  PROMOTION_NOISE_OBSERVATIONS_VERSION,
  type PromotionNoiseObservationsArtifact,
  type RepeatedScoreGroup,
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
