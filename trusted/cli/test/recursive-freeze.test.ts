import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MetaCampaignConfigV2 } from "@hone/schema";
import { describe, expect, it, vi } from "vitest";
import { assertM2OuterDirectEnvelope } from "../src/launch-draft.js";
import { freezeRecursiveCampaignConfig } from "../src/commands/hone.js";

const preservedPath = fileURLToPath(new URL(
  "../../../data/m2-refreeze-final/campaign-frozen.json",
  import.meta.url,
));

function preservedConfig(): MetaCampaignConfigV2 {
  return MetaCampaignConfigV2.parse(JSON.parse(readFileSync(preservedPath, "utf8")));
}

function freezeInputs(config: MetaCampaignConfigV2) {
  const target = {
    sourceArtifact: config.seedOptimizer.sourceArtifact,
    baseDigest: config.seedOptimizer.bundleDigest,
    mergedDigest: config.seedOptimizer.bundleDigest,
    mutablePaths: {},
    snapshot: { files: new Map() },
  };
  return {
    corpus: { train: config.train, holdout: config.holdout },
    identities: {
      sourceCommit: config.trustedRuntime.sourceCommit,
      runtimeDigest: config.trustedRuntime.digest,
      target,
      controller: {
        ...target,
        sourceArtifact: config.controllerOptimizer.sourceArtifact,
        mergedDigest: config.controllerOptimizer.bundleDigest,
      },
      brokenControl: {
        sourceArtifact: config.controls.brokenSourceArtifact,
        bundleDigest: config.controls.brokenBundleDigest,
        transformationReceipt: {},
      },
      degradedControl: {
        sourceArtifact: config.controls.degradedSourceArtifact,
        bundleDigest: config.controls.degradedBundleDigest,
        transformationReceipt: {},
      },
    },
  };
}

describe("recursive freeze envelope enforcement", () => {
  it("executes the freeze-time envelope gate before emitting a frozen config", () => {
    const config = preservedConfig();
    const { corpus, identities } = freezeInputs(config);
    const enforced = vi.fn((_candidate: Parameters<typeof assertM2OuterDirectEnvelope>[0]) => {
      throw new Error("freeze-envelope-gate-reached");
    });
    expect(() => freezeRecursiveCampaignConfig(
      config,
      corpus,
      identities as never,
      enforced,
    )).toThrow("freeze-envelope-gate-reached");
    expect(enforced).toHaveBeenCalledOnce();
  });

  it("derives the preserved draft into an exact sufficient outer envelope", () => {
    const config = preservedConfig();
    const { corpus, identities } = freezeInputs(config);
    const frozen = freezeRecursiveCampaignConfig(config, corpus, identities as never);
    expect(frozen.budgets.outer).toEqual({
      maxTokens: 22_500_000,
      maxUsd: 113,
      maxWallClockSec: 137_343,
      maxEvaluatorInvocations: 27,
    });
    expect(frozen.counts).toMatchObject({ searchChildConcurrency: 3, childConcurrency: 4 });
    expect(assertM2OuterDirectEnvelope(frozen)).toEqual(frozen.outerBudgetDerivation);
  });

  it("schema-refuses an outer budget that differs from its recorded derivation", () => {
    const config = preservedConfig();
    const { corpus, identities } = freezeInputs(config);
    const frozen = freezeRecursiveCampaignConfig(config, corpus, identities as never);
    const mismatched = structuredClone(frozen);
    mismatched.budgets.outer.maxTokens += 1;
    expect(() => MetaCampaignConfigV2.parse(mismatched)).toThrow(
      /outer direct budget must equal its freeze derivation/,
    );
  });

  it("schema-refuses search concurrency above judging even without derivation evidence", () => {
    const config = preservedConfig();
    const overcommitted = structuredClone(config);
    overcommitted.counts.searchChildConcurrency = 3;
    overcommitted.counts.childConcurrency = 2;
    delete overcommitted.outerBudgetDerivation;
    expect(() => MetaCampaignConfigV2.parse(overcommitted)).toThrow(
      /search child concurrency cannot exceed the confirmation\/terminal child concurrency/,
    );
  });
});
