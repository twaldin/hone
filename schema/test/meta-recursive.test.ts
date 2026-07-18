import { readFileSync } from "node:fs";
import { MetaCampaignConfigV1, MetaCampaignConfigV2 } from "../src/index.js";
import { describe, expect, it } from "vitest";

const legacy = MetaCampaignConfigV1.parse(JSON.parse(readFileSync(new URL("../fixtures/meta-campaign.m1.json", import.meta.url), "utf8")));
const digest = (index: number) => `sha256:${index.toString(16).padStart(64, "0")}`;
const capsule = (index: number) => ({
  ...legacy.train[0]!,
  capsuleId: `cap_${index.toString(16).padStart(12, "0")}`,
  capsuleDigest: digest(100 + index),
  oracleDigest: digest(200 + index),
  scalarizerDigest: digest(300 + index),
});

function draft() {
  const target = {
    sourceCommit: "1".repeat(40),
    sourceArtifact: digest(1),
    bundleDigest: digest(2),
  };
  return {
    ...legacy,
    version: 2,
    seedOptimizer: target,
    controllerOptimizer: target,
    generation: { stage: "A", panel: "A", targetGeneration: 0, controllerGeneration: 0, outerReplicate: 0 },
    train: Array.from({ length: 8 }, (_, index) => capsule(index + 1)),
    holdout: Array.from({ length: 12 }, (_, index) => capsule(index + 101)),
    counts: {
      candidates: 12,
      candidateAttemptsMax: 24,
      innerEpisodesMax: 4,
      searchReplicates: 1,
      confirmationReplicates: 3,
      holdoutReplicates: 3,
      childConcurrency: 4,
    },
    budgets: {
      child: { maxTokens: 1, maxUsd: 1, maxWallClockSec: 1, maxEvaluatorInvocations: 1 },
      outer: { maxTokens: 1, maxUsd: 1, maxWallClockSec: 1, maxEvaluatorInvocations: 25 },
      campaign: { maxTokens: 1000, maxUsd: 1000, maxWallClockSec: 1000, maxEvaluatorInvocations: 1000 },
    },
    controls: {
      brokenSourceArtifact: digest(3),
      brokenBundleDigest: digest(4),
      degradedSourceArtifact: digest(5),
      degradedBundleDigest: digest(6),
    },
    allowedClaim: "recursive-transfer-frozen-corpus",
  };
}

describe("MetaCampaignConfigV2 recursive cells", () => {
  it("accepts the exact stage-A 8/12, 12-candidate, four-inner-episode design", () => {
    const parsed = MetaCampaignConfigV2.parse(draft());
    expect(parsed.train).toHaveLength(8);
    expect(parsed.holdout).toHaveLength(12);
    expect(parsed.counts).toMatchObject({ candidates: 12, candidateAttemptsMax: 24, innerEpisodesMax: 4 });
  });

  it("requires a stage-B G1 controller to equal the exact G1 target", () => {
    const value = draft();
    value.generation = { stage: "B", panel: "B", targetGeneration: 1, controllerGeneration: 1, outerReplicate: 2 };
    value.controllerOptimizer = { ...value.controllerOptimizer, sourceArtifact: digest(9), bundleDigest: digest(10) };
    expect(() => MetaCampaignConfigV2.parse(value)).toThrow(/G1 controller must equal/);
  });

  it("requires the stage-B G0 control controller to differ from G1", () => {
    const value = draft();
    value.generation = { stage: "B", panel: "B", targetGeneration: 1, controllerGeneration: 0, outerReplicate: 0 };
    expect(() => MetaCampaignConfigV2.parse(value)).toThrow(/G0 control controller must differ/);
  });
});
