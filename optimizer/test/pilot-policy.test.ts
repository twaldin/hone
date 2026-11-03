import { describe, expect, it } from "vitest";
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
  it("promotes only gains beyond calibrated uncertainty", () => {
    expect(pilotPolicy(request()).gate.passed).toBe(true);
    expect(pilotPolicy(request(0.2, 0.21)).gate.passed).toBe(false);
    expect(pilotPolicy(request(0.2, 0.2)).gate.passed).toBe(false);
  });

  it("admits equivalent projected calibration bounds for full-selection sizes", () => {
    for (const n of [45, 90, 300]) {
      const scale = Math.sqrt(8 / n);
      const projected = {
        ...calibration,
        pairedDeltaSd: calibration.pairedDeltaSd * scale,
        maxObservedPairDelta: calibration.maxObservedPairDelta * scale,
        noiseFloor: calibration.noiseFloor * scale,
        noiseEnvelope: calibration.noiseEnvelope * scale,
      };
      expect(pilotPolicy({ ...request(0.2, 0.2 + 0.04 * scale), calibration: projected }).gate.passed).toBe(true);
      expect(pilotPolicy({ ...request(0.2, 0.2 + 0.02 * scale), calibration: projected }).gate.passed).toBe(false);
    }
  });


  it("refuses bare bounds, forged estimator bounds, and nonfinite scores", () => {
    expect(() => pilotPolicy({ ...request(), calibration: { noiseFloor: 0, noiseEnvelope: 0 } })).toThrow();
    expect(() => pilotPolicy({ ...request(), calibration: { ...calibration, noiseFloor: 0 } })).toThrow();
    expect(() => pilotPolicy({ ...request(), childScore: Number.NaN })).toThrow();
    expect(() => pilotPolicy({ ...request(), episode: -1 })).toThrow();
  });
});
