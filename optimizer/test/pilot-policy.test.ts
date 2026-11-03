import { describe, expect, it } from "vitest";
import { assessPromotion, PromotionGateCalibration } from "@hone/schema";
import { episodeRand } from "../src/loop.js";
import { pilotPolicy } from "../src/pilot-policy.js";

const calibration = {
  gateVersion: "noise-envelope-v3",
  evidenceVersion: "pilot-control-v1",
  calibratedAt: "2026-11-03T00:00:00.000Z",
  capsuleId: "cap_000000000000",
  admittedCapsuleDigest: `sha256:${"0".repeat(64)}`,
  executionImage: "python@sha256:test-image",
  assetGroupId: "synthetic-development",
  measurementEpoch: "test-epoch",
  sourceCohortSha256: [`sha256:${"1".repeat(64)}`],
  estimator: "direct-local-paired-delta-sd-v1",
  maxObservedPairDelta: 0.01,
  noiseFloor: (3 / Math.SQRT2) * 0.01,
  noiseEnvelope: (4.5 / Math.SQRT2) * 0.01,
  informationFreePairs: 16,
  informationFreePositive: 8,
  pairedDeltaTrials: 16,
  pairedDeltaDegreesOfFreedom: 15,
  pairedDeltaSd: 0.01,
  localArmBaselineHash: `sha256:${"2".repeat(64)}`,
} as const;

function request(parentScore = 0.2, childScore = 0.4) {
  return { seed: 0, episode: 0, parentScore, childScore, calibration };
}

describe("pilot native policy", () => {
  it("uses the exact native promotion assessment", () => {
    const parsed = PromotionGateCalibration.parse(calibration);
    expect(pilotPolicy(request()).gate).toEqual(assessPromotion(0.2, 0.4, parsed));
    expect(pilotPolicy(request(0.2, 0.21)).gate.passed).toBe(false);
    expect(pilotPolicy(request(0.2, 0.2)).gate.passed).toBe(false);
  });

  it("uses native episode randomness for predeclared epsilon0.1 restarts", () => {
    let seedParents = 0;
    let incumbentParents = 0;
    for (let episode = 0; episode < 100; episode += 1) {
      const result = pilotPolicy({ ...request(), seed: 7, episode });
      const draw = episodeRand(7, episode);
      expect(result.draw).toBe(draw);
      expect(result.parent).toBe(draw < 0.1 ? "seed" : "incumbent");
      expect(result.epsilon).toBe(0.1);
      if (result.parent === "seed") seedParents += 1;
      else incumbentParents += 1;
    }
    expect(seedParents).toBeGreaterThan(0);
    expect(incumbentParents).toBeGreaterThan(0);
  });

  it("refuses bare bounds, forged estimator bounds, and nonfinite scores", () => {
    expect(() => pilotPolicy({ ...request(), calibration: { noiseFloor: 0, noiseEnvelope: 0 } })).toThrow();
    expect(() => pilotPolicy({ ...request(), calibration: { ...calibration, noiseFloor: 0 } })).toThrow();
    expect(() => pilotPolicy({ ...request(), childScore: Number.NaN })).toThrow();
    expect(() => pilotPolicy({ ...request(), episode: -1 })).toThrow();
  });
});
