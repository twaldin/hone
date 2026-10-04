import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  M2_CALIBRATION_DEFERRED_BINDING,
  DEFAULT_MODEL_ROUTE,
  M2_PANEL_A_TASK_IDS,
  M2_PANEL_B_TASK_IDS,
  MetaCampaignConfigV2,
  MetaCampaignConfigV2Draft,
  admissionReceiptRecordHash,
  canonicalJson,
  type AdmissionReceiptRecord,
  type AdmissionReceiptRecordBody,
  type BudgetEnvelope,
  type CapsuleManifest,
  type M2AuthorizedAdmittedCapsule,
  type M2AuthorizedDeferredCapsule,
  type M2PanelTaskId,
  type DiagnosticOrderingReport,
} from "@hone/schema";
import { selectSaturationCeiling, type SaturationCeilingReport, type SaturationCell } from "@hone/scoring";
import { describe, expect, it } from "vitest";
import { assertM2OuterAncestorCapacity } from "../src/commands/hone.js";
import { corpusProvenanceInputsDigest, type CorpusProvenanceV1 } from "../src/corpus-provenance.js";
import {
  DRAFT_WITHOUT_CALIBRATION_FLAG,
  M2_DRAFT_MUTABLE_PATHS,
  M2_DRAFT_PROMOTION,
  M2_DRAFT_PROTECTED_PATHS,
  M2_LAUNCH_DRAFT_DOCUMENT_VERSION,
  M2_LAUNCH_DRAFT_RECORD_VERSION,
  M2_OUTER_DIRECT_ENVELOPE_POLICY,
  assertM2OuterDirectEnvelope,
  deriveM2OuterDirectEnvelope,
  generateM2LaunchDraft,
  writeM2LaunchDraft,
  type M2DraftAdmittedCapsule,
  type M2LaunchDraftInputs,
} from "../src/launch-draft.js";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const DEV_LABELS = [
  ...M2_PANEL_A_TASK_IDS.map((taskId) => `panel-a-${taskId}`),
  ...M2_PANEL_B_TASK_IDS.map((taskId) => `panel-b-${taskId}`),
];
const TERMINAL_LABELS = Array.from({ length: 11 }, (_, index) => `terminal-${index}`);

const capsuleId = (label: string): string =>
  `cap_${createHash("sha256").update(`id:${label}`).digest("hex").slice(0, 12)}`;

/** Canonical identities of the four committed calibration-only capsules. */
const CALIBRATION_CAPSULE_IDS = [
  "cap_c09ffd33ce1d",
  "cap_7cd6e3af94d7",
  "cap_d413ec4d77c5",
  "cap_8ac06369aa07",
];

function orderingReport(): DiagnosticOrderingReport {
  const variant = (train: number) => ({
    train,
    validation: train,
    combined: train,
    trainTestsPass: true,
    validationTestsPass: true,
  });
  return {
    version: 1,
    variants: {
      baseline: variant(0.4),
      broken: variant(0.05),
      naive: variant(0.2),
      shortcut: variant(0.1),
      improved: variant(0.9),
    },
    stability: { aggregates: [0.4, 0.4, 0.4], spread: 0, band: 0.05 },
    failures: [],
  };
}

function manifest(label: string, role: "development" | "terminal"): CapsuleManifest {
  const assetGroups = [
    { id: "train", visibility: "public" as const, paths: ["cases/train.json"] },
    ...(role === "terminal"
      ? [{ id: "holdout", visibility: "holdout" as const, paths: ["cases/holdout.json"] }]
      : []),
  ];
  return {
    schemaVersion: 2,
    id: capsuleId(label),
    objective: `Improve ${label}`,
    baseline: { kind: "git", commit: "a".repeat(40) },
    image: `hone-task-${label.replace(/[^a-z0-9]+/g, "-")}@${digest(`image:${label}`)}`,
    evalEntrypoint: ["node", "eval.js"],
    protectedPaths: [],
    assetGroups,
    budget: { maxTokens: 1_000_000, maxUsd: 5, maxWallClockSec: 3600, maxEvaluatorInvocations: 600 },
    diagnosticOrdering: { path: "diagnostics/ordering.json", hash: digest(`ordering:${label}`) },
    contentHashes: Object.fromEntries(
      assetGroups.flatMap((group) => group.paths).map((path) => [path, digest(`${label}:${path}`)]),
    ),
  };
}

function admittedCapsule(label: string, role: "development" | "terminal"): M2DraftAdmittedCapsule {
  return {
    manifest: manifest(label, role),
    digest: digest(`capsule:${label}`),
    orderingReport: orderingReport(),
    provisional: false,
    approval: { approved: true },
  };
}

/** Rebinds inputsDigest so intentional field changes still form a self-consistent artifact. */
function bindProvenance(
  fields: Omit<CorpusProvenanceV1, "inputsDigest"> & { inputsDigest?: string },
): CorpusProvenanceV1 {
  const { inputsDigest: _stale, ...unbound } = fields;
  return { ...unbound, inputsDigest: corpusProvenanceInputsDigest(unbound) };
}

/**
 * Genuine scorer output: gains 0.5 -> 0.8 -> 0.8 -> 0.81 make the 4->8 pair
 * the first qualifying comparison, so the trusted rule selects ceiling 8.
 */
function calibrationReport(): SaturationCeilingReport {
  const gainByCap: Record<number, number> = { 2: 0.5, 4: 0.8, 8: 0.8, 12: 0.81 };
  const cells: SaturationCell[] = CALIBRATION_CAPSULE_IDS.flatMap((cal) =>
    ([2, 4, 8, 12] as const).flatMap((cap) =>
      [1, 2, 3, 4, 5].map((seed) => ({
        capsuleId: cal,
        cap,
        seed,
        status: "valid" as const,
        normalizedGain: gainByCap[cap]!,
      })),
    ),
  );
  return selectSaturationCeiling(cells, { rngSeed: 42, bootstrapSamples: 200 });
}

interface Fixture {
  inputs: M2LaunchDraftInputs;
  admittedByLabel: Map<string, M2DraftAdmittedCapsule>;
}

function fixture(): Fixture {
  const admittedByLabel = new Map<string, M2DraftAdmittedCapsule>();
  for (const label of DEV_LABELS) admittedByLabel.set(label, admittedCapsule(label, "development"));
  for (const label of TERMINAL_LABELS) admittedByLabel.set(label, admittedCapsule(label, "terminal"));

  const record = (label: string, role: "development" | "terminal") => ({
    id: admittedByLabel.get(label)!.manifest.id,
    digest: admittedByLabel.get(label)!.digest,
    role,
  });
  const capsules = [
    ...DEV_LABELS.map((label) => record(label, "development")),
    ...TERMINAL_LABELS.map((label) => record(label, "terminal")),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const terminalContentHashes = [
    ...new Set(
      TERMINAL_LABELS.flatMap((label) => Object.values(admittedByLabel.get(label)!.manifest.contentHashes)),
    ),
  ].sort();
  const provenance = bindProvenance({
    version: "corpus-provenance.v1",
    capsules,
    developmentCapsuleIds: DEV_LABELS.map((label) => admittedByLabel.get(label)!.manifest.id),
    terminalCapsuleIds: TERMINAL_LABELS.map((label) => admittedByLabel.get(label)!.manifest.id),
    terminalContentHashes,
    publicSnapshotDigest: digest("public-snapshot"),
    docHashes: { "docs/objective.md": digest("docs/objective.md") },
    panelDocs: [],
    generatedAt: "2026-07-22T00:00:00.000Z",
  });

  const panelA = Object.fromEntries(
    M2_PANEL_A_TASK_IDS.map((taskId) => [taskId, admittedByLabel.get(`panel-a-${taskId}`)!.manifest.id]),
  );
  const panelB = Object.fromEntries(
    M2_PANEL_B_TASK_IDS.map((taskId) => [taskId, admittedByLabel.get(`panel-b-${taskId}`)!.manifest.id]),
  );

  const ceiling: BudgetEnvelope = {
    maxTokens: 2_000_000,
    maxUsd: 3,
    maxWallClockSec: 2400,
    maxEvaluatorInvocations: 50,
  };
  const inputs: M2LaunchDraftInputs = {
    objective: "Improve the recursive optimizer end to end.",
    provenance,
    admitted: [...admittedByLabel.values()],
    assignments: { panelA, panelB },
    calibrationReport: calibrationReport(),
    calibrationCapsuleIds: CALIBRATION_CAPSULE_IDS,
    parameters: {
      optimizerImage: `hone-optimizer@${digest("optimizer-image")}`,
      // Evaluator floor: a child must fund a complete run even at the
      // deferred ceiling of 12 (4*12+1 = 49). Outer is plan-derived below.
      childBudget: { maxTokens: 1_000_000, maxUsd: 2, maxWallClockSec: 1800, maxEvaluatorInvocations: 49 },
      calibratedInnerCeilings: Object.fromEntries(
        Object.values(panelA).map((id) => [id, ceiling]),
      ),
      childConcurrency: 4,
      acknowledgedDefaults: ["promotion", "optimizerPaths", "candidateCounts"],
    },
  };
  return { inputs, admittedByLabel };
}

function partialFixture(): Fixture {
  const base = fixture();
  const deferredLabels = new Set<string>([
    "panel-a-OSS-T01",
    "panel-a-OSS-T03",
    "panel-b-OSS-T08",
    "terminal-8",
    "terminal-9",
    "terminal-10",
  ]);
  const authorization = {
    decisionKey: "bun-image-blocker" as const,
    decidedAt: "2026-08-12T18:15:41Z",
    owner: { identity: "captain" as const, kind: "owner" as const },
    deliveredVia: "first-mate" as const,
    ruling: "ADMIT THE 21 NOW, DEFER THE SIX EXPLICITLY" as const,
    supersedes: {
      rule: "atomic-16-development-11-terminal" as const,
      scope: "this-cohort-only" as const,
    },
    evidence: [{ path: "plans/m2-native-amd64-admission-evidence.json", digest: digest("authorization") }],
  };
  const taskByLabel: ReadonlyMap<string, M2PanelTaskId> = new Map([
    ...M2_PANEL_A_TASK_IDS.map((taskId) => [`panel-a-${taskId}`, taskId] as const),
    ...M2_PANEL_B_TASK_IDS.map((taskId) => [`panel-b-${taskId}`, taskId] as const),
  ]);
  const admitted: M2DraftAdmittedCapsule[] = [];
  const policyAdmitted: M2AuthorizedAdmittedCapsule[] = [];
  const policyDeferred: M2AuthorizedDeferredCapsule[] = [];
  for (const [index, [label, capsule]] of [...base.admittedByLabel.entries()].entries()) {
    const taskId = taskByLabel.get(label);
    if (deferredLabels.has(label)) {
      const binding = {
        label: label.toLowerCase(),
        capsuleId: capsule.manifest.id,
        capsuleDigest: capsule.digest,
        reason: "recorded native blocker",
        evidence: [{ path: `capsules/${label}/diagnostics/blocker.json`, digest: digest(`blocker:${label}`) }],
      };
      policyDeferred.push(taskId === undefined
        ? { ...binding, role: "terminal" }
        : { ...binding, role: "development", taskId });
      continue;
    }
    const body: AdmissionReceiptRecordBody = {
      v: 1,
      sequence: 1,
      previousReceiptHash: digest(`gate1:${label}`),
      capsuleDigest: capsule.digest,
      action: "gate2-approve",
      identities: {
        author: { identity: "hone-native-migration", kind: "agent" },
        "adversarial-validator": { identity: "hone-native-migration-adv-f1", kind: "agent" },
        "final-reviewer": { identity: "captain", kind: "owner" },
      },
      approvalBasis: {
        authorizationKey: authorization.decisionKey,
        authorizedBy: authorization.owner,
        authorizedAt: authorization.decidedAt,
        deliveredVia: authorization.deliveredVia,
        reviewEvidence: [
          "data/hone-native-migration/review-f1.md",
          "data/hone-native-migration/review-f2.md",
        ],
      },
      provisional: false,
      timestamp: new Date(Date.parse("2026-08-13T00:00:00Z") + index * 1_000).toISOString(),
    };
    const receipt: AdmissionReceiptRecord = {
      ...body,
      recordHash: admissionReceiptRecordHash(body),
    };
    admitted.push({ ...capsule, approval: { approved: true as const, receipt } });
    const binding = {
      label: label.toLowerCase(),
      capsuleId: capsule.manifest.id,
      capsuleDigest: capsule.digest,
      gate2ReceiptHash: receipt.recordHash,
    };
    policyAdmitted.push(taskId === undefined
      ? { ...binding, role: "terminal" }
      : { ...binding, role: "development", taskId });
  }
  const partialCohort = {
    version: "m2-authorized-partial-cohort.v1" as const,
    authorization,
    admitted: policyAdmitted,
    deferred: policyDeferred,
  };
  const admittedIds = new Set(policyAdmitted.map((capsule) => capsule.capsuleId));
  const original = base.inputs.provenance as CorpusProvenanceV1;
  const capsules = original.capsules.filter((capsule) => admittedIds.has(capsule.id));
  const developmentCapsuleIds = capsules.filter((capsule) => capsule.role === "development").map((capsule) => capsule.id);
  const terminalCapsuleIds = capsules.filter((capsule) => capsule.role === "terminal").map((capsule) => capsule.id);
  const admittedTerminalLabels = policyAdmitted
    .filter((capsule) => capsule.role === "terminal")
    .map((capsule) => capsule.label);
  const terminalContentHashes = [
    ...new Set(
      admittedTerminalLabels.flatMap((label) =>
        Object.values(base.admittedByLabel.get(label)!.manifest.contentHashes)
      ),
    ),
  ].sort();
  const provenance = bindProvenance({
    ...original,
    capsules,
    developmentCapsuleIds,
    terminalCapsuleIds,
    terminalContentHashes,
    partialCohort,
  });
  const deferredPanelAIds = new Set(
    policyDeferred
      .filter((capsule) => capsule.role === "development" && capsule.label.startsWith("panel-a-"))
      .map((capsule) => capsule.capsuleId),
  );
  return {
    admittedByLabel: new Map(admitted.map((capsule) => [
      policyAdmitted.find((binding) => binding.capsuleId === capsule.manifest.id)!.label,
      capsule,
    ])),
    inputs: {
      ...base.inputs,
      provenance,
      admitted,
      parameters: {
        ...base.inputs.parameters,
        calibratedInnerCeilings: Object.fromEntries(
          Object.entries(base.inputs.parameters.calibratedInnerCeilings)
            .filter(([capsuleId]) => !deferredPanelAIds.has(capsuleId)),
        ),
      },
    },
  };
}

const DIMENSIONS = ["maxTokens", "maxUsd", "maxWallClockSec", "maxEvaluatorInvocations"] as const;

describe("generateM2LaunchDraft", () => {
  it("produces a schema-valid stage-A draft with exact envelope arithmetic", () => {
    const { inputs, admittedByLabel } = fixture();
    const draft = generateM2LaunchDraft(inputs);
    // The generated config must round-trip the frozen M2 rules unchanged.
    expect(MetaCampaignConfigV2.parse(draft.config)).toEqual(draft.config);
    expect(draft.freezable).toBe(true);

    const config = draft.config;
    expect(config.generation).toEqual({
      stage: "A",
      panel: "A",
      targetGeneration: 0,
      controllerGeneration: 0,
      outerReplicate: 0,
    });
    expect(config.train).toHaveLength(8);
    expect(config.holdout).toHaveLength(11);
    // Train follows the frozen Panel-A task order; holdout follows the provenance terminal order.
    expect(config.developmentPanel.members.map((member) => member.taskId)).toEqual([...M2_PANEL_A_TASK_IDS]);
    config.train.forEach((entry, index) => {
      const label = `panel-a-${M2_PANEL_A_TASK_IDS[index]}`;
      const admitted = admittedByLabel.get(label)!;
      expect(entry.capsuleId).toBe(admitted.manifest.id);
      expect(entry.capsuleDigest).toBe(admitted.digest);
      expect(entry.image).toBe(admitted.manifest.image);
      expect(entry.qFail).toBe(0);
      expect(entry.qBase).toBe(0.4);
      expect(entry.qReference).toBe(0.9);
      expect(entry.scale).toBe(0.5);
    });
    expect(config.holdout.map((entry) => entry.capsuleId)).toEqual(
      TERMINAL_LABELS.map((label) => admittedByLabel.get(label)!.manifest.id),
    );

    // Envelope arithmetic: candidate = componentwise ceiling sum, trajectory = 12 candidates,
    // judging pools fund child x runs exactly (stage A: 4*8*3; terminal: 3*11*3).
    const search = config.recursiveBudgets.search;
    for (const dimension of DIMENSIONS) {
      const memberSum = config.developmentPanel.members.reduce(
        (sum, member) => sum + member.calibratedInnerCeiling[dimension],
        0,
      );
      expect(search.calibratedPanelCandidate[dimension]).toBe(memberSum);
      expect(search.outerTrajectory[dimension]).toBe(memberSum * 12);
      expect(config.recursiveBudgets.confirmation.budget[dimension]).toBe(config.budgets.child[dimension] * 96);
      expect(config.recursiveBudgets.terminal.budget[dimension]).toBe(config.budgets.child[dimension] * 99);
      expect(config.budgets.campaign[dimension]).toBe(
        config.budgets.outer[dimension]
        + search.outerTrajectory[dimension]
        + config.recursiveBudgets.confirmation.budget[dimension]
        + config.recursiveBudgets.terminal.budget[dimension],
      );
    }
    expect(config.counts).toMatchObject({ searchChildConcurrency: 3, childConcurrency: 4 });
    expect(config.outerBudgetDerivation).toEqual(deriveM2OuterDirectEnvelope(12));
    expect(config.budgets.outer).toEqual({
      maxTokens: 22_500_000,
      maxUsd: 113,
      maxWallClockSec: 137_343,
      maxEvaluatorInvocations: 27,
    });
    expect(assertM2OuterDirectEnvelope(config)).toEqual(config.outerBudgetDerivation);
    const ancestorCapacity = assertM2OuterAncestorCapacity(config);
    expect(ancestorCapacity.plannedChildren).toEqual({
      search: 12 * config.developmentPanel.members.length,
      confirmation: 4 * config.train.length * 3,
      terminal: 3 * config.holdout.length * 3,
      total:
        12 * config.developmentPanel.members.length
        + 4 * config.train.length * 3
        + 3 * config.holdout.length * 3,
    });
    expect(ancestorCapacity.ancestorEnvelope).toEqual(config.budgets.campaign);
    expect(ancestorCapacity.directOuterBudget).toEqual(config.budgets.outer);
    expect(ancestorCapacity.requiredEnvelope).toEqual(config.budgets.campaign);
    const undersizedAncestor = {
      ...config,
      budgets: {
        ...config.budgets,
        campaign: {
          ...config.budgets.campaign,
          maxTokens: config.budgets.campaign.maxTokens - 1,
        },
      },
    };
    expect(() => assertM2OuterAncestorCapacity(undersizedAncestor)).toThrow(
      "cannot admit the full planned recursive sequence",
    );
    const envelopeIds = [
      search.identity.envelopeId,
      config.recursiveBudgets.confirmation.identity.envelopeId,
      config.recursiveBudgets.terminal.identity.envelopeId,
    ];
    expect(new Set(envelopeIds).size).toBe(3);

    // The bound ceiling comes from the verified recomputation, not the copied field.
    expect(config.counts.innerEpisodesMax).toBe(8);
    expect(draft.calibration).toMatchObject({
      selectedCeiling: 8,
      selectionReason: "threshold",
      bootstrapRngSeed: 42,
      bootstrapSamples: 200,
    });
    // B1 — the calibration binding is frozen INSIDE the config, not only the sidecar.
    expect(config.calibration).toEqual({
      reportDigest: draft.calibration!.reportDigest,
      excludedCapsuleIds: [...CALIBRATION_CAPSULE_IDS].sort(),
    });
    // B2 (round 4) — the full 28-capsule cohort is bound into the config from
    // the verified provenance artifact.
    const provenance = inputs.provenance as CorpusProvenanceV1;
    expect(config.corpusCohort).toEqual({
      developmentCapsuleIds: provenance.developmentCapsuleIds,
      terminalCapsuleIds: provenance.terminalCapsuleIds,
      provenanceInputsDigest: provenance.inputsDigest,
    });
    expect(draft.unresolvedDecisions).toEqual([]);
  });

  it("derives Campaign-8's outer direct envelope and rejects the preserved insufficient freeze", () => {
    const derivation = deriveM2OuterDirectEnvelope(12);
    expect(derivation).toMatchObject({
      projectionBasis: "campaign-8-observed-panel-mean",
      projectionReceiptSha256: "sha256:c5c474a3b1f5b9721e2b049a672124e69665524970e2c0ba8f60e592fabea77b",
      projectionReceiptCommit: "d91251332",
      projectionMeanField: "outerEnvelopeArithmetic.firstTwoProjectionMeanSec",
      plannedEpisodes: 12,
      plannedDirectEvaluations: 24,
      retryHeadroomEvaluations: 3,
      totalDirectEvaluations: 27,
      searchChildConcurrency: 3,
      confirmationTerminalChildConcurrency: 4,
    });
    expect(derivation).not.toHaveProperty("projectionReceiptPath");
    expect(derivation.derived).toEqual({
      maxTokens: 22_500_000,
      maxUsd: 113,
      maxWallClockSec: 137_343,
      maxEvaluatorInvocations: 27,
    });
    const observedPlannedWall =
      M2_OUTER_DIRECT_ENVELOPE_POLICY.projectedPanelMeanWallClockSec
      * derivation.plannedDirectEvaluations;
    expect(observedPlannedWall).toBeCloseTo(97_666.08, 6);
    expect(derivation.derived.maxWallClockSec).toBeGreaterThanOrEqual(
      observedPlannedWall * 1.25,
    );

    // The Campaign-11 freeze carried the pre-derivation $25/5M outer envelope.
    const preserved = structuredClone(generateM2LaunchDraft(fixture().inputs).config);
    preserved.budgets.outer = {
      maxTokens: 5_000_000,
      maxUsd: 25,
      maxWallClockSec: 86_400,
      maxEvaluatorInvocations: 25,
    };
    expect(() => assertM2OuterDirectEnvelope(preserved)).toThrow(
      /frozen outer direct maxTokens 5000000 cannot cover the planned search phase/,
    );
  });

  it("makes every outer derivation and concurrency guard load-bearing", () => {
    const config = generateM2LaunchDraft(fixture().inputs).config;
    for (const dimension of DIMENSIONS) {
      const mutated = structuredClone(config);
      mutated.budgets.outer[dimension] -= 1;
      expect(() => assertM2OuterDirectEnvelope(mutated)).toThrow(
        new RegExp(`outer direct ${dimension}|must equal the freeze-time derivation`),
      );
    }

    const oversized = structuredClone(config);
    oversized.budgets.outer.maxTokens += 1;
    expect(() => assertM2OuterDirectEnvelope(oversized)).toThrow(
      /must equal the freeze-time derivation exactly/,
    );

    const missingEvidence = structuredClone(config);
    delete missingEvidence.outerBudgetDerivation;
    expect(() => assertM2OuterDirectEnvelope(missingEvidence)).toThrow(
      /missing its exact freeze-time derivation evidence/,
    );

    const missingSearchBound = structuredClone(config);
    delete missingSearchBound.counts.searchChildConcurrency;
    expect(() => assertM2OuterDirectEnvelope(missingSearchBound)).toThrow(
      /SEARCH\/judging concurrency bounds/,
    );

    const forgedArithmetic = structuredClone(config);
    forgedArithmetic.outerBudgetDerivation!.derived.maxWallClockSec -= 1;
    forgedArithmetic.budgets.outer.maxWallClockSec -= 1;
    expect(() => MetaCampaignConfigV2.parse(forgedArithmetic)).toThrow(
      /derived maxWallClockSec must equal/,
    );
  });

  it("drafts both tiers on the default route unless routes and evaluator timeout are configured", () => {
    const draft = generateM2LaunchDraft(fixture().inputs);
    expect(draft.config.routing).toEqual({
      outerMutation: DEFAULT_MODEL_ROUTE,
      innerMutation: DEFAULT_MODEL_ROUTE,
    });
    expect(draft.config.modelObservation.outerRequestedRoute).toBe(DEFAULT_MODEL_ROUTE);
    expect(draft.config.modelObservation.innerRequestedRoute).toBe(DEFAULT_MODEL_ROUTE);
    expect(draft.config.modelObservation.driftSentinel).toBe(true);
    expect(draft.config.evaluatorTimeoutSec).toBe(2700);

    const { inputs } = fixture();
    const configured = generateM2LaunchDraft({
      ...inputs,
      parameters: {
        ...inputs.parameters,
        routes: { outer: { model: "openai-codex/gpt-6-astra", reasoningEffort: "high" }, inner: { model: DEFAULT_MODEL_ROUTE } },
        evaluatorTimeoutSec: 28_800,
      },
    });
    expect(configured.config.routing).toEqual({
      outerMutation: "openai-codex/gpt-6-astra",
      innerMutation: DEFAULT_MODEL_ROUTE,
      outerReasoningEffort: "high",
    });
    expect(configured.config.modelObservation.outerRequestedRoute).toBe("openai-codex/gpt-6-astra");
    expect(configured.config.evaluatorTimeoutSec).toBe(28_800);
  });

  it("is deterministic for identical inputs", () => {
    expect(generateM2LaunchDraft(fixture().inputs)).toEqual(generateM2LaunchDraft(fixture().inputs));
  });

  it("refuses a provenance artifact whose inputsDigest does not recompute", () => {
    const { inputs } = fixture();
    const provenance = inputs.provenance as CorpusProvenanceV1;
    // Field drift without rebinding the self-digest must refuse.
    const drifted = { ...provenance, generatedAt: "2026-07-23T00:00:00.000Z" };
    expect(() => generateM2LaunchDraft({ ...inputs, provenance: drifted })).toThrow(/inputsDigest mismatch/);
    // Same drift with a rebound digest is a different, self-consistent artifact and passes.
    const rebound = bindProvenance(drifted);
    expect(generateM2LaunchDraft({ ...inputs, provenance: rebound }).freezable).toBe(true);
  });

  it("refuses to draft without a calibration report unless explicitly overridden", () => {
    const { inputs } = fixture();
    const withoutReport: M2LaunchDraftInputs = { ...inputs, calibrationReport: undefined };
    expect(() => generateM2LaunchDraft(withoutReport)).toThrow(DRAFT_WITHOUT_CALIBRATION_FLAG);
    expect(() => generateM2LaunchDraft(withoutReport)).toThrow(/calibration report is required/);
  });

  it("emits an explicitly NON-freezable draft when calibration is deferred", () => {
    const { inputs } = fixture();
    const draft = generateM2LaunchDraft({
      ...inputs,
      calibrationReport: undefined,
      draftWithoutCalibration: true,
    });
    expect(draft.freezable).toBe(false);
    expect(draft.calibration).toBeNull();
    // Conservative trusted maximum, and the deferral is surfaced as an open decision.
    expect(draft.config.counts.innerEpisodesMax).toBe(12);
    expect(draft.openDecisions.join("\n")).toMatch(/NON-freezable/);
    // The config carries the schema-reserved sentinel binding; the OFFICIAL
    // schema (freeze's entry parse) refuses it even when the wrapper is
    // bypassed, while the draft-only schema round-trips it.
    expect(draft.config.calibration).toEqual(M2_CALIBRATION_DEFERRED_BINDING);
    expect(() => MetaCampaignConfigV2.parse(draft.config)).toThrow(/deferred calibration sentinel/);
    expect(MetaCampaignConfigV2Draft.parse(draft.config)).toEqual(draft.config);
  });

  it("rejects a calibration report combined with the skip flag", () => {
    const { inputs } = fixture();
    expect(() => generateM2LaunchDraft({ ...inputs, draftWithoutCalibration: true })).toThrow(/contradictory/);
  });

  it("requires the designated excluded calibration capsules as a frozen input", () => {
    const { inputs } = fixture();
    expect(() => generateM2LaunchDraft({ ...inputs, calibrationCapsuleIds: undefined }))
      .toThrow(/designated excluded calibration capsule identities must be supplied/);
    expect(() => generateM2LaunchDraft({ ...inputs, calibrationCapsuleIds: CALIBRATION_CAPSULE_IDS.slice(0, 3) }))
      .toThrow(/exactly 4 distinct/);
    expect(() =>
      generateM2LaunchDraft({ ...inputs, calibrationCapsuleIds: [...CALIBRATION_CAPSULE_IDS.slice(0, 3), "cal-x"] }),
    ).toThrow(/must be a cap_<12 hex> capsule id/);
    const swapped = [...CALIBRATION_CAPSULE_IDS.slice(0, 3), capsuleId("cal-x")];
    expect(() => generateM2LaunchDraft({ ...inputs, calibrationCapsuleIds: swapped })).toThrow(
      new RegExp(`undesignated: ${CALIBRATION_CAPSULE_IDS[3]}; uncovered: ${capsuleId("cal-x")}`),
    );
  });

  it("rejects designated calibration capsules that overlap the frozen corpus", () => {
    const { inputs, admittedByLabel } = fixture();
    const corpusId = admittedByLabel.get("terminal-0")!.manifest.id;
    expect(() =>
      generateM2LaunchDraft({
        ...inputs,
        calibrationCapsuleIds: [...CALIBRATION_CAPSULE_IDS.slice(0, 3), corpusId],
      }),
    ).toThrow(/part of the frozen corpus/);
  });

  it("distinguishes two valid reports selecting the same ceiling inside the frozen config", () => {
    const { inputs } = fixture();
    const baseline = generateM2LaunchDraft(inputs);
    const report = inputs.calibrationReport as SaturationCeilingReport;
    const reseeded = selectSaturationCeiling(report.cells, { rngSeed: 43, bootstrapSamples: 200 });
    const other = generateM2LaunchDraft({ ...inputs, calibrationReport: reseeded });
    expect(other.config.counts.innerEpisodesMax).toBe(baseline.config.counts.innerEpisodesMax);
    expect(other.config.calibration.reportDigest).not.toBe(baseline.config.calibration.reportDigest);
  });

  it("treats unacknowledged defaults as REQUIRED unresolved decisions and wraps the output", async () => {
    const { inputs } = fixture();
    const unacknowledged = generateM2LaunchDraft({
      ...inputs,
      parameters: { ...inputs.parameters, acknowledgedDefaults: undefined },
    });
    expect(unacknowledged.freezable).toBe(false);
    expect(unacknowledged.unresolvedDecisions).toHaveLength(3);
    expect(unacknowledged.unresolvedDecisions.join("\n")).toMatch(/REQUIRED/);
    // The config itself still validates; only the emission is gated.
    expect(MetaCampaignConfigV2.parse(unacknowledged.config)).toEqual(unacknowledged.config);

    const dir = await mkdtemp(join(tmpdir(), "hone-launch-draft-unresolved-"));
    const outputPath = join(dir, "draft.json");
    const { configPath } = writeM2LaunchDraft(outputPath, unacknowledged);
    const document = JSON.parse(readFileSync(configPath, "utf8"));
    expect(() => MetaCampaignConfigV2.parse(document)).toThrow();
    expect(document.reason).toMatch(/unresolved REQUIRED decisions/);

    const partial = generateM2LaunchDraft({
      ...inputs,
      parameters: { ...inputs.parameters, acknowledgedDefaults: ["promotion"] },
    });
    expect(partial.freezable).toBe(false);
    expect(partial.unresolvedDecisions).toHaveLength(2);

    // Explicitly supplied values need no acknowledgment.
    const explicit = generateM2LaunchDraft({
      ...inputs,
      parameters: {
        ...inputs.parameters,
        acknowledgedDefaults: undefined,
        promotion: M2_DRAFT_PROMOTION,
        mutablePaths: M2_DRAFT_MUTABLE_PATHS,
        protectedPaths: M2_DRAFT_PROTECTED_PATHS,
        candidates: 12,
        candidateAttemptsMax: 24,
      },
    });
    expect(explicit.freezable).toBe(true);
    expect(explicit.unresolvedDecisions).toEqual([]);
  });

  it("refuses per-child budgets below the evaluator floors before aggregate arithmetic", () => {
    const { inputs, admittedByLabel } = fixture();
    // Floor at the calibrated ceiling of 8 is 4*8+1 = 33.
    expect(() =>
      generateM2LaunchDraft({
        ...inputs,
        parameters: {
          ...inputs.parameters,
          childBudget: { ...inputs.parameters.childBudget, maxEvaluatorInvocations: 32 },
        },
      }),
    ).toThrow(/cannot fund one complete run at innerEpisodesMax 8 \(needs 33\)/);


    const panelId = admittedByLabel.get("panel-a-OWN-T01")!.manifest.id;
    expect(() =>
      generateM2LaunchDraft({
        ...inputs,
        parameters: {
          ...inputs.parameters,
          calibratedInnerCeilings: {
            ...inputs.parameters.calibratedInnerCeilings,
            [panelId]: {
              ...inputs.parameters.calibratedInnerCeilings[panelId]!,
              maxEvaluatorInvocations: 20,
            },
          },
        },
      }),
    ).toThrow(new RegExp(`calibrated inner ceiling for ${panelId}`));
  });

  it("rejects any calibration report that does not match the trusted recomputation", () => {
    const { inputs } = fixture();
    const report = inputs.calibrationReport as SaturationCeilingReport;

    // A copied-but-tampered ceiling never survives the rerun.
    const flippedCeiling = { ...report, selectedCeiling: 12, selectionReason: "fallback" };
    expect(() => generateM2LaunchDraft({ ...inputs, calibrationReport: flippedCeiling }))
      .toThrow(/does not match the trusted recomputation/);

    // A tampered cell changes the recomputed statistics.
    const tamperedCells = structuredClone(report);
    const firstValid = tamperedCells.cells.find((cell) => cell.status === "valid");
    if (firstValid === undefined || firstValid.status !== "valid") throw new Error("fixture must contain valid cells");
    firstValid.normalizedGain += 0.5;
    expect(() => generateM2LaunchDraft({ ...inputs, calibrationReport: tamperedCells }))
      .toThrow(/does not match the trusted recomputation/);

    // A cell set violating the frozen 4x4x5 contract is refused by the scorer rerun.
    const duplicated = structuredClone(report);
    duplicated.cells[1] = structuredClone(duplicated.cells[0]!);
    expect(() => generateM2LaunchDraft({ ...inputs, calibrationReport: duplicated }))
      .toThrow(/saturation calibration report is invalid|saturation calibration report does not match|is invalid/);
  });

  it("rejects admission drift, provisional admissions, and review-off admissions", () => {
    const base = fixture();
    const drifted = base.inputs.admitted.map((capsule) =>
      capsule.manifest.id === base.admittedByLabel.get("panel-a-OWN-T01")!.manifest.id
        ? { ...capsule, digest: digest("drifted") }
        : capsule,
    );
    expect(() => generateM2LaunchDraft({ ...base.inputs, admitted: drifted })).toThrow(/identity drift/);

    const provisional = base.inputs.admitted.map((capsule) =>
      capsule.manifest.id === base.admittedByLabel.get("terminal-3")!.manifest.id
        ? { ...capsule, provisional: true }
        : capsule,
    );
    expect(() => generateM2LaunchDraft({ ...base.inputs, admitted: provisional })).toThrow(/provisional/);

    const unreviewed = base.inputs.admitted.map((capsule) =>
      capsule.manifest.id === base.admittedByLabel.get("panel-b-OSS-T02")!.manifest.id
        ? { ...capsule, approval: null }
        : capsule,
    );
    expect(() => generateM2LaunchDraft({ ...base.inputs, admitted: unreviewed })).toThrow(/Gate-2 approval/);

    const missing = base.inputs.admitted.filter(
      (capsule) => capsule.manifest.id !== base.admittedByLabel.get("terminal-7")!.manifest.id,
    );
    expect(() => generateM2LaunchDraft({ ...base.inputs, admitted: missing })).toThrow(/no admission output/);
  });

  it("rejects incomplete or overlapping panel assignments", () => {
    const { inputs, admittedByLabel } = fixture();
    const { ["OWN-T01"]: _dropped, ...partialPanelA } = inputs.assignments.panelA;
    expect(() =>
      generateM2LaunchDraft({ ...inputs, assignments: { ...inputs.assignments, panelA: partialPanelA } }),
    ).toThrow(/missing: OWN-T01/);

    const duplicated = {
      ...inputs.assignments.panelA,
      "OWN-T03": inputs.assignments.panelA["OWN-T01"]!,
    };
    expect(() =>
      generateM2LaunchDraft({ ...inputs, assignments: { ...inputs.assignments, panelA: duplicated } }),
    ).toThrow(/more than one panel task/);

    const terminalId = admittedByLabel.get("terminal-0")!.manifest.id;
    const nonDevelopment = { ...inputs.assignments.panelA, "OWN-T01": terminalId };
    expect(() =>
      generateM2LaunchDraft({ ...inputs, assignments: { ...inputs.assignments, panelA: nonDevelopment } }),
    ).toThrow(/not a development capsule/);
  });

  it("rejects terminal capsules that cannot support the fixed terminal shell", () => {
    const base = fixture();
    const targetId = base.admittedByLabel.get("terminal-5")!.manifest.id;

    const withoutHoldout = base.inputs.admitted.map((capsule) =>
      capsule.manifest.id === targetId
        ? {
            ...capsule,
            manifest: {
              ...capsule.manifest,
              assetGroups: capsule.manifest.assetGroups.filter((group) => group.visibility !== "holdout"),
            },
          }
        : capsule,
    );
    expect(() => generateM2LaunchDraft({ ...base.inputs, admitted: withoutHoldout })).toThrow(/no holdout asset group/);

    // (4 * 8 + 1) * 3 * 3 = 297 lifetime accesses at the calibrated ceiling of 8.
    const underfunded = base.inputs.admitted.map((capsule) =>
      capsule.manifest.id === targetId
        ? {
            ...capsule,
            manifest: {
              ...capsule.manifest,
              budget: { ...capsule.manifest.budget, maxEvaluatorInvocations: 296 },
            },
          }
        : capsule,
    );
    expect(() => generateM2LaunchDraft({ ...base.inputs, admitted: underfunded })).toThrow(/cannot cover 297 accesses/);
  });

  it("rejects a terminal content hash missing from the provenance denylist", () => {
    const { inputs } = fixture();
    const provenance = inputs.provenance as CorpusProvenanceV1;
    // Rebound digest: the artifact is self-consistent, so the semantic check itself must fire.
    const truncated = bindProvenance({
      ...provenance,
      terminalContentHashes: provenance.terminalContentHashes.slice(1),
    });
    expect(() => generateM2LaunchDraft({ ...inputs, provenance: truncated }))
      .toThrow(/missing from provenance.terminalContentHashes/);
  });

  it("rejects missing and unassigned calibrated ceiling vectors", () => {
    const { inputs, admittedByLabel } = fixture();
    const panelId = admittedByLabel.get("panel-a-OSS-T01")!.manifest.id;
    const { [panelId]: _dropped, ...withoutOne } = inputs.parameters.calibratedInnerCeilings;
    expect(() =>
      generateM2LaunchDraft({
        ...inputs,
        parameters: { ...inputs.parameters, calibratedInnerCeilings: withoutOne },
      }),
    ).toThrow(new RegExp(`missing for Panel-A capsules: ${panelId}`));

    const terminalId = admittedByLabel.get("terminal-1")!.manifest.id;
    const withUnknown = {
      ...inputs.parameters.calibratedInnerCeilings,
      [terminalId]: inputs.parameters.childBudget,
    };
    expect(() =>
      generateM2LaunchDraft({
        ...inputs,
        parameters: { ...inputs.parameters, calibratedInnerCeilings: withUnknown },
      }),
    ).toThrow(/non-Panel-A capsules/);
  });

  it("rejects a capsule without a positive train reference scale", () => {
    const base = fixture();
    const targetId = base.admittedByLabel.get("panel-a-OWN-T06")!.manifest.id;
    const flat = base.inputs.admitted.map((capsule) => {
      if (capsule.manifest.id !== targetId) return capsule;
      const report = orderingReport();
      report.variants.improved.train = report.variants.baseline.train;
      return { ...capsule, orderingReport: report };
    });
    expect(() => generateM2LaunchDraft({ ...base.inputs, admitted: flat })).toThrow(/no positive train reference scale/);
  });

  it("accepts nonnegative raw performance scalars above one before normalization", () => {
    const base = fixture();
    const targetId = base.admittedByLabel.get("panel-a-OWN-T06")!.manifest.id;
    const rawPerformance = base.inputs.admitted.map((capsule) => {
      if (capsule.manifest.id !== targetId) return capsule;
      const report = orderingReport();
      report.variants.baseline.train = 100;
      report.variants.improved.train = 125;
      return { ...capsule, orderingReport: report };
    });
    const draft = generateM2LaunchDraft({ ...base.inputs, admitted: rawPerformance });
    const entry = draft.config.train.find((capsule) => capsule.capsuleId === targetId);
    expect(entry).toMatchObject({ qBase: 100, qReference: 125, scale: 25 });
  });

  it("rejects a provenance cohort with broken cardinality", () => {
    const { inputs } = fixture();
    const provenance = inputs.provenance as CorpusProvenanceV1;
    const dropped = provenance.developmentCapsuleIds[0]!;
    // Rebound digest: cardinality itself must be the refusal, not digest drift.
    const truncated = bindProvenance({
      ...provenance,
      capsules: provenance.capsules.filter((capsule) => capsule.id !== dropped),
      developmentCapsuleIds: provenance.developmentCapsuleIds.filter((id) => id !== dropped),
    });
    expect(() => generateM2LaunchDraft({ ...inputs, provenance: truncated }))
      .toThrow(/exactly 16 admitted development capsules/);
  });

  it("generates and round-trips the authorized 21-capsule cohort with deferrals excluded", () => {
    const { inputs } = partialFixture();
    const draft = generateM2LaunchDraft(inputs);
    expect(draft.config.corpusCohort).toMatchObject({ mode: "owner-authorized-partial" });
    expect(draft.config.train).toHaveLength(6);
    expect(draft.config.holdout).toHaveLength(8);
    expect(draft.config.developmentPanel.members.map((member) => member.taskId))
      .not.toContain("OSS-T01");
    expect(draft.config.developmentPanel.members.map((member) => member.taskId))
      .not.toContain("OSS-T03");
    expect(MetaCampaignConfigV2.parse(JSON.parse(JSON.stringify(draft.config)))).toEqual(draft.config);
  });

  it("refuses a partial cohort when an actual Gate-2 receipt or owner basis drifts", () => {
    const receiptDrift = partialFixture();
    const driftedAdmissions = receiptDrift.inputs.admitted.map((capsule, index) =>
      index === 0 && capsule.approval !== null && capsule.approval.receipt !== undefined
        ? {
            ...capsule,
            approval: {
              ...capsule.approval,
              receipt: { ...capsule.approval.receipt, recordHash: digest("foreign-receipt") },
            },
          }
        : capsule
    );
    expect(() => generateM2LaunchDraft({ ...receiptDrift.inputs, admitted: driftedAdmissions }))
      .toThrow(/does not reproduce its authorized Gate-2 receipt/);

    const basisDrift = partialFixture();
    const wrongBasis = basisDrift.inputs.admitted.map((capsule, index) =>
      index === 0 && capsule.approval !== null && capsule.approval.receipt !== undefined
        ? {
            ...capsule,
            approval: {
              ...capsule.approval,
              receipt: {
                ...capsule.approval.receipt,
                approvalBasis: {
                  ...capsule.approval.receipt.approvalBasis!,
                  authorizationKey: "unrelated-decision",
                },
              },
            },
          }
        : capsule
    );
    expect(() => generateM2LaunchDraft({ ...basisDrift.inputs, admitted: wrongBasis }))
      .toThrow(/does not cite the owner authorization/);
  });

  it("refuses a panel assignment that tries to seat a deferred task under another capsule", () => {
    const { inputs } = partialFixture();
    const assignments = {
      ...inputs.assignments,
      panelA: {
        ...inputs.assignments.panelA,
        "OSS-T01": inputs.assignments.panelA["OWN-T01"]!,
      },
    };
    expect(() => generateM2LaunchDraft({ ...inputs, assignments }))
      .toThrow(/authorized 21\+6 cohort partition|more than one panel task/);
  });
});

describe("writeM2LaunchDraft", () => {
  it("persists a freeze-consumable config plus a digest-bound generation record", async () => {
    const draft = generateM2LaunchDraft(fixture().inputs);
    const dir = await mkdtemp(join(tmpdir(), "hone-launch-draft-"));
    const outputPath = join(dir, "m2", "campaign-draft.json");
    const { configPath, recordPath, configDigest } = writeM2LaunchDraft(outputPath, draft);
    const persisted = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(configPath, "utf8")));
    expect(persisted).toEqual(draft.config);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.version).toBe(M2_LAUNCH_DRAFT_RECORD_VERSION);
    expect(record.freezable).toBe(true);
    expect(record.calibration.selectedCeiling).toBe(8);
    expect(Array.isArray(record.openDecisions)).toBe(true);
    expect(record.unresolvedDecisions).toEqual([]);
    // The record is bound to the exact emitted config.
    expect(record.configDigest).toBe(configDigest);
    expect(record.configDigest).toBe(
      `sha256:${createHash("sha256").update(canonicalJson(draft.config)).digest("hex")}`,
    );
  });

  it("never emits a bare freeze-consumable file for a NON-freezable draft", async () => {
    const { inputs } = fixture();
    const draft = generateM2LaunchDraft({
      ...inputs,
      calibrationReport: undefined,
      draftWithoutCalibration: true,
    });
    const dir = await mkdtemp(join(tmpdir(), "hone-launch-draft-nf-"));
    const outputPath = join(dir, "campaign-draft.json");
    const { configPath, recordPath, configDigest } = writeM2LaunchDraft(outputPath, draft);

    const document = JSON.parse(readFileSync(configPath, "utf8"));
    // The wrapper is mechanically non-freeze-consumable: freeze's entry parse fails closed.
    expect(() => MetaCampaignConfigV2.parse(document)).toThrow();
    expect(document.version).toBe(M2_LAUNCH_DRAFT_DOCUMENT_VERSION);
    expect(document.freezable).toBe(false);
    expect(document.configDigest).toBe(configDigest);
    // Even the extracted inner config cannot reach freeze: the official schema
    // rejects the sentinel; only the draft-only schema round-trips it.
    expect(() => MetaCampaignConfigV2.parse(document.config)).toThrow(/deferred calibration sentinel/);
    expect(MetaCampaignConfigV2Draft.parse(document.config)).toEqual(draft.config);

    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.freezable).toBe(false);
    expect(record.configDigest).toBe(configDigest);
    expect(record.calibration).toBeNull();
  });
});
