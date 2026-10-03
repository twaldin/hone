import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_12_JOURNAL_NOISE_EVIDENCE_V2,
  CAMPAIGN_12_JOURNAL_OBSERVATIONS_SHA256,
  CAMPAIGN_12_LOCAL_NULL_SHA256,
  CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3,
} from "@hone/broker";
import {
  deriveDirectPairedDeltaScales,
  deriveNoiseCalibrations,
  derivePromotionNoiseObservations,
  type PromotionNoiseObservationsArtifact,
} from "../src/promotion-noise-derivation.js";

const observationsPath = fileURLToPath(new URL(
  "../../../data/campaign-12-promotion-noise-observations.v2.json",
  import.meta.url,
));
const localTrialsPath = fileURLToPath(new URL(
  "../../../data/campaign-12-local-production-null-trials.v1.ndjson",
  import.meta.url,
));

function comparableJournalCalibration(entry: typeof CAMPAIGN_12_JOURNAL_NOISE_EVIDENCE_V2[number]) {
  const {
    measurementEpochs,
    deltaDistribution,
    sensitivityThresholds,
    ...fields
  } = entry;
  return { ...fields, measurementEpochs, deltaDistribution, sensitivityThresholds };
}

describe("campaign-12 promotion-noise derivation", () => {
  it("re-derives every execution identity, rate, sample depth, distribution, and journal threshold", () => {
    const observationBytes = readFileSync(observationsPath);
    expect(`sha256:${createHash("sha256").update(observationBytes).digest("hex")}`).toBe(
      CAMPAIGN_12_JOURNAL_OBSERVATIONS_SHA256,
    );
    const observations = JSON.parse(observationBytes.toString("utf8")) as PromotionNoiseObservationsArtifact;
    const derived = deriveNoiseCalibrations(observations);
    expect(derived).toEqual(
      CAMPAIGN_12_JOURNAL_NOISE_EVIDENCE_V2
        .map(comparableJournalCalibration)
        .sort((left, right) => left.capsuleId.localeCompare(right.capsuleId)),
    );
    const biome = observations.capsules.find((capsule) => capsule.identity.capsuleId === "cap_93f9f6942024");
    expect(biome?.identity).toMatchObject({
      admittedManifestImage: "hone-biome-task@sha256:e540584bba29bf04d6a687cfca8c3dcd2acc8a5977d1cefca4c41fdb727cf1e9",
      executionImage: "hone-biome-task@sha256:545f0775d78c4e956a43133e46bfd36e1cf3347dcf6dcf56956bca6131bd5107",
    });
    expect(observations.capsules.every((capsule) => capsule.sourceFiles.length === 11)).toBe(true);
    expect(observations.capsules.every((capsule) =>
      capsule.sourceFiles.every((source) => source.campaignSessionSha256.startsWith("sha256:"))
    )).toBe(true);
  });

  it("re-derives every identity-matched local paired-delta SD and rejects the admitted-image substitute", () => {
    const scales = deriveDirectPairedDeltaScales(readFileSync(localTrialsPath));
    expect(scales).toHaveLength(5);
    expect(scales.every((scale) => scale.sourceCohortSha256 === CAMPAIGN_12_LOCAL_NULL_SHA256)).toBe(true);
    for (const evidence of CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3) {
      const scale = scales.find((candidate) =>
        candidate.capsuleId === evidence.capsuleId
        && candidate.admittedCapsuleDigest === evidence.admittedCapsuleDigest
        && candidate.executionImage === evidence.executionImage
      );
      if (evidence.estimator === "direct-local-paired-delta-sd-v1") {
        expect(scale, evidence.capsuleId).toMatchObject({
          pairedDeltaTrials: evidence.pairedDeltaTrials,
          pairedDeltaDegreesOfFreedom: evidence.pairedDeltaDegreesOfFreedom,
          pairedDeltaSd: evidence.pairedDeltaSd,
          baselineArtifactHash: evidence.localArmBaselineHash,
          informationFreePositive: evidence.informationFreePositive,
        });
      } else {
        expect(scale, evidence.capsuleId).toBeUndefined();
      }
    }
    expect(CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3.find(
      (entry) => entry.capsuleId === "cap_93f9f6942024"
    )?.estimator).toBe("direct-local-paired-delta-sd-v1");
  });

  it("fails loudly when the requested journal evidence root is absent", () => {
    expect(() => derivePromotionNoiseObservations("/definitely/missing/campaign-12-evidence")).toThrow(
      /evidence root does not exist/,
    );
  });
});
