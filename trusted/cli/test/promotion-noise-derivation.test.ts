import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2 } from "@hone/broker";
import {
  deriveNoiseCalibrations,
  derivePromotionNoiseObservations,
  type PromotionNoiseObservationsArtifact,
} from "../src/promotion-noise-derivation.js";

const observationsPath = fileURLToPath(new URL(
  "../../../data/campaign-12-promotion-noise-observations.v1.json",
  import.meta.url,
));

function comparableCommittedCalibration(entry: typeof CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2[number]) {
  const {
    measurementEpochs,
    deltaDistribution,
    sensitivityThresholds,
    ...fields
  } = entry;
  return { ...fields, measurementEpochs, deltaDistribution, sensitivityThresholds };
}

describe("campaign-12 promotion-noise derivation", () => {
  it("re-derives every identity, rate, sample depth, distribution, and threshold from checked-in observations", () => {
    const observations = JSON.parse(
      readFileSync(observationsPath, "utf8"),
    ) as PromotionNoiseObservationsArtifact;
    const derived = deriveNoiseCalibrations(observations);
    expect(derived).toEqual(
      CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2
        .map(comparableCommittedCalibration)
        .sort((left, right) => left.capsuleId.localeCompare(right.capsuleId)),
    );
    expect(derived.find((entry) => entry.capsuleId === "cap_93f9f6942024")).toMatchObject({
      evaluatorImage: "hone-biome-task@sha256:e540584bba29bf04d6a687cfca8c3dcd2acc8a5977d1cefca4c41fdb727cf1e9",
      informationFreePairs: 129,
      informationFreePositive: 53,
    });
    expect(observations.capsules.every((capsule) => capsule.sourceFiles.length === 11)).toBe(true);
  });

  it("fails loudly when the requested journal evidence root is absent", () => {
    expect(() => derivePromotionNoiseObservations("/definitely/missing/campaign-12-evidence")).toThrow(
      /evidence root does not exist/,
    );
  });
});
