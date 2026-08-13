import { readFileSync } from "node:fs";
import {
  M2_CALIBRATION_DEFERRED_BINDING,
  M2_CALIBRATION_DEFERRED_REPORT_DIGEST,
  M2_INNER_MODEL_ROUTE,
  M2_OUTER_MODEL_ROUTE,
  M2_PANEL_A_TASK_IDS,
  M2_PANEL_B_TASK_IDS,
  M2AuthorizedPartialCohort,
  MetaCampaignConfigV1,
  MetaCampaignConfigV2,
  MetaCampaignConfigV2Draft,
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
    maxEvaluatorInvocations: 17,
  };
  const multiply = (budget: BudgetEnvelope, factor: number): BudgetEnvelope => ({
    maxTokens: budget.maxTokens * factor,
    maxUsd: budget.maxUsd * factor,
    maxWallClockSec: budget.maxWallClockSec * factor,
    maxEvaluatorInvocations: budget.maxEvaluatorInvocations * factor,
  });
  const train = Array.from({ length: 8 }, (_, index) => capsule(index + 1));
  const holdout = Array.from({ length: 11 }, (_, index) => capsule(index + 101));
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
    calibration: {
      reportDigest: digest(800),
      excludedCapsuleIds: Array.from({ length: 4 }, (_, index) => `cap_${(901 + index).toString(16).padStart(12, "0")}`),
    },
    corpusCohort: {
      developmentCapsuleIds: [
        ...train.map((entry) => entry.capsuleId),
        // The other (off-panel) development panel's eight capsules.
        ...Array.from({ length: 8 }, (_, index) => `cap_${(201 + index).toString(16).padStart(12, "0")}`),
      ],
      terminalCapsuleIds: holdout.map((entry) => entry.capsuleId),
      provenanceInputsDigest: digest(801),
    },
    train,
    holdout,
    routing: {
      outerMutation: M2_OUTER_MODEL_ROUTE,
      innerMutation: M2_INNER_MODEL_ROUTE,
    },
    modelObservation: {
      outerRequestedRoute: M2_OUTER_MODEL_ROUTE,
      innerRequestedRoute: M2_INNER_MODEL_ROUTE,
      identity: "alias-observation" as const,
      recordResponseModel: true,
      recordProviderFingerprint: true,
      driftSentinel: true,
    },
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
        budget: multiply(child, 3 * 11 * 3),
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

function authorizedPartialDraft() {
  const value = draft();
  const allDevelopment = value.corpusCohort.developmentCapsuleIds.map((capsuleId, index) => ({
    label: `development-${index}`,
    capsuleId,
    capsuleDigest: index < value.train.length
      ? value.train[index]!.capsuleDigest
      : digest(500 + index),
    gate2ReceiptHash: digest(1_000 + index),
    role: "development" as const,
    taskId: [...M2_PANEL_A_TASK_IDS, ...M2_PANEL_B_TASK_IDS][index]!,
  }));
  const deferredDevelopmentIndexes = new Set([4, 5, 15]);
  const admittedDevelopment = allDevelopment.filter((_, index) => !deferredDevelopmentIndexes.has(index));
  const deferredDevelopment = allDevelopment
    .filter((_, index) => deferredDevelopmentIndexes.has(index))
    .map(({ gate2ReceiptHash: _receipt, ...capsule }) => ({
      ...capsule,
      reason: "recorded native blocker",
      evidence: [{ path: `capsules/${capsule.label}/diagnostics/blocker.json`, digest: digest(2_000 + Number(capsule.taskId.length)) }],
    }));
  const allTerminal = value.holdout.map((entry, index) => ({
    label: `terminal-${index}`,
    capsuleId: entry.capsuleId,
    capsuleDigest: entry.capsuleDigest,
    gate2ReceiptHash: digest(1_100 + index),
    role: "terminal" as const,
  }));
  const admittedTerminal = allTerminal.slice(0, 8);
  const deferredTerminal = allTerminal.slice(8).map(({ gate2ReceiptHash: _receipt, ...capsule }, index) => ({
    ...capsule,
    reason: "recorded native blocker",
    evidence: [{ path: `capsules/${capsule.label}/diagnostics/blocker.json`, digest: digest(2_100 + index) }],
  }));
  const partialCohort = {
    version: "m2-authorized-partial-cohort.v1" as const,
    authorization: {
      decisionKey: "bun-image-blocker" as const,
      decidedAt: "2026-08-12T18:15:41Z",
      owner: { identity: "captain" as const, kind: "owner" as const },
      deliveredVia: "first-mate" as const,
      ruling: "ADMIT THE 21 NOW, DEFER THE SIX EXPLICITLY" as const,
      supersedes: {
        rule: "atomic-16-development-11-terminal" as const,
        scope: "this-cohort-only" as const,
      },
      evidence: [{ path: "plans/m2-native-amd64-admission-evidence.json", digest: digest(2_200) }],
    },
    admitted: [...admittedDevelopment, ...admittedTerminal],
    deferred: [...deferredDevelopment, ...deferredTerminal],
  };
  const train = value.train.filter((_, index) => !deferredDevelopmentIndexes.has(index));
  const members = value.developmentPanel.members.filter((_, index) => !deferredDevelopmentIndexes.has(index));
  const child = value.budgets.child;
  const calibratedPanelCandidate = {
    maxTokens: child.maxTokens * members.length,
    maxUsd: child.maxUsd * members.length,
    maxWallClockSec: child.maxWallClockSec * members.length,
    maxEvaluatorInvocations: child.maxEvaluatorInvocations * members.length,
  };
  return {
    ...value,
    train,
    holdout: value.holdout.slice(0, 8),
    corpusCohort: {
      mode: "owner-authorized-partial" as const,
      developmentCapsuleIds: admittedDevelopment.map((capsule) => capsule.capsuleId),
      terminalCapsuleIds: admittedTerminal.map((capsule) => capsule.capsuleId),
      partialCohort,
      provenanceInputsDigest: value.corpusCohort.provenanceInputsDigest,
    },
    developmentPanel: { ...value.developmentPanel, members },
    recursiveBudgets: {
      ...value.recursiveBudgets,
      search: {
        ...value.recursiveBudgets.search,
        calibratedPanelCandidate,
        outerTrajectory: {
          maxTokens: calibratedPanelCandidate.maxTokens * 12,
          maxUsd: calibratedPanelCandidate.maxUsd * 12,
          maxWallClockSec: calibratedPanelCandidate.maxWallClockSec * 12,
          maxEvaluatorInvocations: calibratedPanelCandidate.maxEvaluatorInvocations * 12,
        },
      },
    },
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
    expect(parsed.holdout).toHaveLength(11);
    expect(new Set([...parsed.train, ...parsed.holdout].map((entry) => entry.image)).size).toBe(19);
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

  it("accepts the frozen two-role observation policy (outer=sol, inner=terra)", () => {
    const parsed = MetaCampaignConfigV2.parse(draft());
    expect(parsed.modelObservation.outerRequestedRoute).toBe(M2_OUTER_MODEL_ROUTE);
    expect(parsed.modelObservation.innerRequestedRoute).toBe(M2_INNER_MODEL_ROUTE);
    expect(parsed.routing.outerMutation).toBe(M2_OUTER_MODEL_ROUTE);
    expect(parsed.routing.innerMutation).toBe(M2_INNER_MODEL_ROUTE);
  });

  it("rejects routing drift away from the frozen per-role observation routes", () => {
    const innerDrift = draft();
    innerDrift.routing.innerMutation = M2_OUTER_MODEL_ROUTE;
    expect(() => MetaCampaignConfigV2.parse(innerDrift)).toThrow(/inner.*route/i);

    const outerDrift = draft();
    outerDrift.routing.outerMutation = M2_INNER_MODEL_ROUTE;
    expect(() => MetaCampaignConfigV2.parse(outerDrift)).toThrow(/outer.*route/i);
  });

  it("rejects observed model-identity drift in the frozen policy literals", () => {
    const swapped = draft();
    swapped.modelObservation = {
      ...swapped.modelObservation,
      outerRequestedRoute: M2_INNER_MODEL_ROUTE,
      innerRequestedRoute: M2_OUTER_MODEL_ROUTE,
    };
    swapped.routing = { outerMutation: M2_INNER_MODEL_ROUTE, innerMutation: M2_OUTER_MODEL_ROUTE };
    expect(() => MetaCampaignConfigV2.parse(swapped)).toThrow();
  });

  it("rejects an M1-style single-route observation policy on a V2 config", () => {
    const single = draft();
    const m1Policy = {
      requestedRoute: M2_OUTER_MODEL_ROUTE,
      identity: "alias-observation",
      recordResponseModel: true,
      recordProviderFingerprint: true,
      driftSentinel: true,
    };
    expect(() => MetaCampaignConfigV2.parse({ ...single, modelObservation: m1Policy })).toThrow();
  });

  it("keeps the M1 single-route config valid and unchanged", () => {
    const reparsed = MetaCampaignConfigV1.parse(legacy);
    expect(reparsed.modelObservation.requestedRoute).toBe("gpt-5.6-sol");
    expect(reparsed.routing).toEqual({ outerMutation: "gpt-5.6-sol", innerMutation: "gpt-5.6-sol" });
  });

  it("requires the calibration binding on every V2 config", () => {
    const { calibration: _calibration, ...withoutCalibration } = draft();
    expect(() => MetaCampaignConfigV2.parse(withoutCalibration)).toThrow();

    const duplicated = draft();
    duplicated.calibration.excludedCapsuleIds = Array.from({ length: 4 }, () => duplicated.calibration.excludedCapsuleIds[0]!);
    expect(() => MetaCampaignConfigV2.parse(duplicated)).toThrow(/four distinct identities/);
  });

  it("rejects calibration capsules that are registered corpus members", () => {
    const value = draft();
    value.calibration.excludedCapsuleIds = [
      value.train[0]!.capsuleId,
      ...value.calibration.excludedCapsuleIds.slice(1),
    ];
    expect(() => MetaCampaignConfigV2.parse(value)).toThrow(/must remain excluded/);
  });
  it("round-trips the four real calibration-only capsule identities outside the full cohort", () => {
    const value = draft();
    value.calibration.excludedCapsuleIds = [
      "cap_c09ffd33ce1d",
      "cap_7cd6e3af94d7",
      "cap_d413ec4d77c5",
      "cap_8ac06369aa07",
    ];
    const parsed = MetaCampaignConfigV2.parse(value);
    const roundTripped = MetaCampaignConfigV2.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped.calibration.excludedCapsuleIds).toEqual(value.calibration.excludedCapsuleIds);
    expect(roundTripped.calibration.excludedCapsuleIds.every((capsuleId) =>
      !roundTripped.corpusCohort.developmentCapsuleIds.includes(capsuleId)
      && !roundTripped.corpusCohort.terminalCapsuleIds.includes(capsuleId)
    )).toBe(true);

    roundTripped.calibration.excludedCapsuleIds[0] = roundTripped.corpusCohort.developmentCapsuleIds[0]!;
    expect(() => MetaCampaignConfigV2.parse(roundTripped)).toThrow(/registered cohort capsule/);
  });


  it("rejects per-run evaluator budgets below the complete-run floor", () => {
    // Floor = 4 * innerEpisodesMax + 1 = 17 for the fixture's ceiling of 4.
    const child = draft();
    child.budgets.child.maxEvaluatorInvocations = 16;
    expect(() => MetaCampaignConfigV2.parse(child)).toThrow(/child evaluator budget cannot fund one complete run \(needs 17\)/);

    const outer = draft();
    outer.budgets.outer.maxEvaluatorInvocations = 24;
    expect(() => MetaCampaignConfigV2.parse(outer)).toThrow(/outer evaluator budget cannot fund candidateAttemptsMax \+ 1 evaluations \(needs 25\)/);

    const ceiling = draft();
    ceiling.developmentPanel.members[0]!.calibratedInnerCeiling = {
      ...ceiling.developmentPanel.members[0]!.calibratedInnerCeiling,
      maxEvaluatorInvocations: 16,
    };
    expect(() => MetaCampaignConfigV2.parse(ceiling)).toThrow(/calibrated inner ceiling cannot fund one complete run \(needs 17\)/);
  });

  it("rejects the deferred-calibration sentinel in the official schema (the freeze path)", () => {
    const value = draft();
    value.calibration = {
      reportDigest: M2_CALIBRATION_DEFERRED_BINDING.reportDigest,
      excludedCapsuleIds: [...M2_CALIBRATION_DEFERRED_BINDING.excludedCapsuleIds],
    };
    // Serializing a deferred draft's inner config directly (bypassing the
    // non-freezable wrapper) must fail the official parse freeze performs.
    expect(() => MetaCampaignConfigV2.parse(value)).toThrow(/deferred calibration sentinel/);
    // The same content is tolerated ONLY by the draft-only schema.
    const parsed = MetaCampaignConfigV2Draft.parse(value);
    expect(parsed.calibration.reportDigest).toBe(M2_CALIBRATION_DEFERRED_REPORT_DIGEST);
  });

  it("rejects an off-panel development cohort capsule as a calibration exclusion", () => {
    const value = draft();
    // A Panel-B capsule: registered in the 16-dev cohort but absent from this cell's train(8)+holdout(11).
    const offPanel = value.corpusCohort.developmentCapsuleIds[15]!;
    expect(value.train.some((entry) => entry.capsuleId === offPanel)).toBe(false);
    value.calibration.excludedCapsuleIds = [offPanel, ...value.calibration.excludedCapsuleIds.slice(1)];
    expect(() => MetaCampaignConfigV2.parse(value)).toThrow(/registered cohort capsule/);
  });

  it("requires train and holdout members to be registered cohort capsules", () => {
    const trainDrift = draft();
    trainDrift.corpusCohort.developmentCapsuleIds = [
      `cap_${(209).toString(16).padStart(12, "0")}`,
      ...trainDrift.corpusCohort.developmentCapsuleIds.slice(1),
    ];
    expect(() => MetaCampaignConfigV2.parse(trainDrift)).toThrow(/not a registered development cohort capsule/);

    const holdoutDrift = draft();
    holdoutDrift.corpusCohort.terminalCapsuleIds = [
      `cap_${(209).toString(16).padStart(12, "0")}`,
      ...holdoutDrift.corpusCohort.terminalCapsuleIds.slice(1),
    ];
    expect(() => MetaCampaignConfigV2.parse(holdoutDrift)).toThrow(/not a registered terminal cohort capsule/);
  });

  it("rejects a 12-terminal cohort and accepts exactly 11", () => {
    const eleven = draft();
    expect(MetaCampaignConfigV2.parse(eleven).holdout).toHaveLength(11);

    const extraId = `cap_${(150).toString(16).padStart(12, "0")}`;
    const twelveCohort = draft();
    twelveCohort.corpusCohort.terminalCapsuleIds = [...twelveCohort.corpusCohort.terminalCapsuleIds, extraId];
    expect(() => MetaCampaignConfigV2.parse(twelveCohort)).toThrow(/exactly 11/);

    const twelveHoldout = draft();
    const extraEntry = { ...twelveHoldout.holdout[0]!, capsuleId: extraId };
    twelveHoldout.corpusCohort.terminalCapsuleIds = [
      ...twelveHoldout.corpusCohort.terminalCapsuleIds.slice(1),
      extraId,
    ];
    twelveHoldout.holdout = [...twelveHoldout.holdout, extraEntry];
    expect(() => MetaCampaignConfigV2.parse(twelveHoldout)).toThrow(/exactly 11 admitted terminal capsules, got 12/);
  });

  it("round-trips the exact owner-authorized 21-admitted/6-deferred cohort", () => {
    const parsed = MetaCampaignConfigV2.parse(authorizedPartialDraft());
    expect(parsed.corpusCohort).toMatchObject({ mode: "owner-authorized-partial" });
    expect(parsed.corpusCohort.developmentCapsuleIds).toHaveLength(13);
    expect(parsed.corpusCohort.terminalCapsuleIds).toHaveLength(8);
    expect(parsed.train).toHaveLength(6);
    expect(parsed.holdout).toHaveLength(8);
    expect(MetaCampaignConfigV2.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("refuses a shortened cohort without its named owner authorization", () => {
    const value = authorizedPartialDraft();
    const { authorization: _authorization, ...partialCohort } = value.corpusCohort.partialCohort;
    expect(() => MetaCampaignConfigV2.parse({
      ...value,
      corpusCohort: { ...value.corpusCohort, partialCohort },
    })).toThrow();
  });

  it("refuses a deferral without a byte-verifiable evidence pointer", () => {
    const value = structuredClone(authorizedPartialDraft());
    value.corpusCohort.partialCohort.deferred[0]!.evidence = [];
    expect(() => MetaCampaignConfigV2.parse(value)).toThrow();
  });

  it("refuses admitted ids or Gate-2 receipt bindings that do not match the policy", () => {
    const membershipDrift = structuredClone(authorizedPartialDraft());
    membershipDrift.corpusCohort.developmentCapsuleIds[0] =
      membershipDrift.corpusCohort.partialCohort.deferred[0]!.capsuleId;
    expect(() => MetaCampaignConfigV2.parse(membershipDrift)).toThrow(/authorized admitted receipt set/);

    const blanketReceipt = structuredClone(authorizedPartialDraft());
    blanketReceipt.corpusCohort.partialCohort.admitted[1]!.gate2ReceiptHash =
      blanketReceipt.corpusCohort.partialCohort.admitted[0]!.gate2ReceiptHash;
    expect(() => M2AuthorizedPartialCohort.parse(blanketReceipt.corpusCohort.partialCohort)).toThrow(/own distinct Gate-2 receipt/);
  });

  it("structurally excludes deferred tasks from panels and calibration selection", () => {
    const panelDrift = structuredClone(authorizedPartialDraft());
    const deferred = panelDrift.corpusCohort.partialCohort.deferred[0]!;
    const capsuleEntry = {
      ...panelDrift.train[0]!,
      capsuleId: deferred.capsuleId,
      capsuleDigest: deferred.capsuleDigest,
    };
    panelDrift.train.push(capsuleEntry);
    panelDrift.developmentPanel.members.push({
      taskId: "OSS-T01",
      capsule: capsuleEntry,
      calibratedInnerCeiling: panelDrift.budgets.child,
    });
    expect(() => MetaCampaignConfigV2.parse(panelDrift)).toThrow(/deferred tasks are structurally excluded|requires exactly 6 admitted/);

    const calibrationDrift = structuredClone(authorizedPartialDraft());
    calibrationDrift.calibration.excludedCapsuleIds[0] = deferred.capsuleId;
    expect(() => MetaCampaignConfigV2.parse(calibrationDrift)).toThrow(/registered cohort capsule/);
  });

});
