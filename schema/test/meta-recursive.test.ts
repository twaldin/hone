import { readFileSync } from "node:fs";
import {
  M2_PANEL_A_TASK_IDS,
  MetaCampaignConfigV1,
  MetaCampaignConfigV2,
  type BudgetEnvelope,
} from "../src/index.js";
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
  const child: BudgetEnvelope = {
    maxTokens: 1,
    maxUsd: 1,
    maxWallClockSec: 1,
    maxEvaluatorInvocations: 1,
  };
  const multiply = (budget: BudgetEnvelope, factor: number): BudgetEnvelope => ({
    maxTokens: budget.maxTokens * factor,
    maxUsd: budget.maxUsd * factor,
    maxWallClockSec: budget.maxWallClockSec * factor,
    maxEvaluatorInvocations: budget.maxEvaluatorInvocations * factor,
  });
  const train = Array.from({ length: 8 }, (_, index) => capsule(index + 1));
  const holdout = Array.from({ length: 12 }, (_, index) => capsule(index + 101));
  const calibratedPanelCandidate = multiply(child, 8);
  return {
    ...legacy,
    version: 2,
    seedOptimizer: target,
    controllerOptimizer: target,
    optimizerRuntime: {
      image: "hone-mutation@sha256:" + "7".repeat(64),
    },
    generation: { stage: "A", panel: "A", targetGeneration: 0, controllerGeneration: 0, outerReplicate: 0 },
    train,
    holdout,
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
      child,
      outer: { maxTokens: 1, maxUsd: 1, maxWallClockSec: 1, maxEvaluatorInvocations: 25 },
      campaign: { maxTokens: 1000, maxUsd: 1000, maxWallClockSec: 1000, maxEvaluatorInvocations: 1000 },
    },
    developmentPanel: {
      panel: "A",
      members: train.map((entry, index) => ({
        taskId: M2_PANEL_A_TASK_IDS[index],
        capsule: entry,
        calibratedInnerCeiling: child,
      })),
    },
    recursiveBudgets: {
      search: {
        identity: { envelopeId: digest(700), purpose: "search" },
        calibratedPanelCandidate,
        outerTrajectory: multiply(calibratedPanelCandidate, 12),
      },
      confirmation: {
        identity: { envelopeId: digest(701), purpose: "confirmation" },
        budget: multiply(child, 4 * 8 * 3),
      },
      terminal: {
        identity: { envelopeId: digest(702), purpose: "terminal" },
        budget: multiply(child, 3 * 12 * 3),
      },
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
  it("accepts heterogeneous capsule images with a separate optimizer runtime", () => {
    const value = draft();
    value.train = value.train.map((entry, index) => ({ ...entry, image: `hone-task-${index}@${digest(400 + index)}` }));
    value.developmentPanel.members = value.developmentPanel.members.map((member, index) => ({
      ...member,
      capsule: value.train[index]!,
    }));
    value.holdout = value.holdout.map((entry, index) => ({ ...entry, image: `hone-holdout-${index}@${digest(500 + index)}` }));
    const parsed = MetaCampaignConfigV2.parse(value);
    expect(parsed.train).toHaveLength(8);
    expect(parsed.holdout).toHaveLength(12);
    expect(new Set([...parsed.train, ...parsed.holdout].map((entry) => entry.image)).size).toBe(20);
    expect(parsed.optimizerRuntime.image).toMatch(/^hone-mutation@sha256:/);
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
  it("requires panel membership and recursive envelope authority on every V2 config", () => {
    const { developmentPanel: _panel, ...withoutPanel } = draft();
    const { recursiveBudgets: _budgets, ...withoutBudgets } = draft();
    expect(() => MetaCampaignConfigV2.parse(withoutPanel)).toThrow();
    expect(() => MetaCampaignConfigV2.parse(withoutBudgets)).toThrow();
  });

  it("rejects non-finite and inexact componentwise search envelope arithmetic", () => {
    const infinite = draft();
    infinite.recursiveBudgets.search.outerTrajectory.maxUsd = Number.POSITIVE_INFINITY;
    expect(() => MetaCampaignConfigV2.parse(infinite)).toThrow();

    const inexact = draft();
    inexact.recursiveBudgets.search.outerTrajectory.maxTokens += 1;
    expect(() => MetaCampaignConfigV2.parse(inexact)).toThrow(/must equal 12 complete-panel/);
  });

});
