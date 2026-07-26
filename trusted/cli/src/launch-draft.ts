import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  M2_CANDIDATE_ATTEMPTS_MAX,
  M2_CANDIDATE_COUNT,
  M2_INNER_MODEL_ROUTE,
  M2_OUTER_MODEL_ROUTE,
  M2_PANEL_A_TASK_IDS,
  M2_PANEL_B_TASK_IDS,
  M2_PANEL_CAPSULE_COUNT,
  M2_SEARCH_CANDIDATE_EQUIVALENTS,
  M2_TERMINAL_CAPSULE_COUNT,
  M2_CALIBRATION_DEFERRED_BINDING,
  MetaCampaignConfigV2,
  MetaCampaignConfigV2Draft,
  canonicalJson,
  type BudgetEnvelope,
  type CapsuleManifest,
  type DiagnosticOrderingReport,
  type M2CalibrationBinding,
  type MetaCapsuleEntry,
  type MetaCampaignConfigV2 as RecursiveMetaCampaignConfig,
  type PromotionRule,
} from "@hone/schema";
import { z } from "zod";
import { capsuleOracleDigest, capsuleScalarizerDigest } from "./admission.js";
import { CorpusProvenanceV1, verifyCorpusProvenance } from "./corpus-provenance.js";
import { selectSaturationCeiling, type SaturationCeilingReport, type SaturationCell } from "@hone/scoring";
import { UsageError } from "./args.js";
import { writeFileDurable } from "./eventlog.js";

/**
 * Initial M2 launch draft generator (launch-tooling item 3).
 *
 * Freeze (`hone recursive --phase freeze`) only NORMALIZES a draft: it
 * re-derives corpus entries from installed capsules, resolves optimizer /
 * control / runtime identities, and seals protocol + analysis hashes. It
 * fills no decisions. This module fills them: it assembles a complete,
 * schema-valid MetaCampaignConfigV2 Stage-A cell from
 *   - verified admission outputs (one per corpus capsule),
 *   - the digest-bound corpus provenance artifact (corpus-provenance.v1),
 *   - the saturation calibration report (frozen inner-episode ceiling), and
 *   - the frozen launch parameters (panels, routes, budget vectors).
 *
 * The calibration report is fail-closed: without it a draft is refused
 * unless the caller explicitly opts into a NON-freezable draft via
 * `draftWithoutCalibration` (CLI surface: --draft-without-calibration).
 */

export const M2_LAUNCH_DRAFT_RECORD_VERSION = "m2-launch-draft-record.v1";
/** Wrapper document for NON-freezable drafts; MetaCampaignConfigV2 rejects it by construction. */
export const M2_LAUNCH_DRAFT_DOCUMENT_VERSION = "m2-launch-draft.v1";
export const M2_DEVELOPMENT_CAPSULE_COUNT = 16;
export const DRAFT_WITHOUT_CALIBRATION_FLAG = "--draft-without-calibration";

const BUDGET_DIMENSIONS = [
  "maxTokens",
  "maxUsd",
  "maxWallClockSec",
  "maxEvaluatorInvocations",
] as const;

/**
 * The corpus assembler's frozen artifact schema (./corpus-provenance.ts) does
 * not enforce launch cardinalities; the generator does, fail closed: exactly
 * 16 development + 11 terminal capsules, distinct identities, and role lists
 * consistent with the per-capsule role records. The inputsDigest self-binding
 * is enforced separately by verifyCorpusProvenance — the single trusted
 * chokepoint — before any drafting decision reads the artifact.
 */
export const LaunchCorpusProvenance = CorpusProvenanceV1.superRefine((provenance, ctx) => {
  const ids = new Set(provenance.capsules.map((capsule) => capsule.id));
  const digests = new Set(provenance.capsules.map((capsule) => capsule.digest));
  if (ids.size !== provenance.capsules.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capsules"], message: "capsule ids are not distinct" });
  }
  if (digests.size !== provenance.capsules.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capsules"], message: "capsule digests are not distinct" });
  }
  if (provenance.developmentCapsuleIds.length !== M2_DEVELOPMENT_CAPSULE_COUNT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["developmentCapsuleIds"],
      message: `launch cohort requires exactly ${M2_DEVELOPMENT_CAPSULE_COUNT} development capsules, got ${provenance.developmentCapsuleIds.length}`,
    });
  }
  if (provenance.terminalCapsuleIds.length !== M2_TERMINAL_CAPSULE_COUNT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminalCapsuleIds"],
      message: `launch cohort requires exactly ${M2_TERMINAL_CAPSULE_COUNT} terminal capsules, got ${provenance.terminalCapsuleIds.length}`,
    });
  }
  const byRole = (role: "development" | "terminal") =>
    provenance.capsules.filter((capsule) => capsule.role === role).map((capsule) => capsule.id);
  for (const [role, declared, path] of [
    ["development", provenance.developmentCapsuleIds, "developmentCapsuleIds"],
    ["terminal", provenance.terminalCapsuleIds, "terminalCapsuleIds"],
  ] as const) {
    const fromCapsules = byRole(role);
    const declaredSet = new Set(declared);
    if (declaredSet.size !== declared.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${role} capsule ids are not distinct` });
      continue;
    }
    if (
      fromCapsules.length !== declared.length
      || fromCapsules.some((id) => !declaredSet.has(id))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message: `${path} must list exactly the capsules with role "${role}"`,
      });
    }
  }
});
export type LaunchCorpusProvenance = z.infer<typeof LaunchCorpusProvenance>;

/**
 * Trusted validation of the saturation calibration report produced by
 * `selectSaturationCeiling` (trusted/scoring/src/saturation.ts). Cells carry
 * the complete frozen contract; everything else is re-derived by rerunning
 * the scorer with the recorded RNG options and requiring a canonical match,
 * so no copied statistic (including selectedCeiling) is ever trusted.
 */
const SaturationCellSchema = z.union([
  z
    .object({
      capsuleId: z.string().min(1),
      cap: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(12)]),
      seed: z.number().int(),
      status: z.literal("valid"),
      normalizedGain: z.number().finite(),
    })
    .strict(),
  z
    .object({
      capsuleId: z.string().min(1),
      cap: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(12)]),
      seed: z.number().int(),
      status: z.enum(["invalid", "incomplete"]),
    })
    .strict(),
]);

export const SaturationCalibrationReportV1 = z
  .object({
    rule: z
      .object({
        capsuleCount: z.literal(4),
        seedsPerCapsule: z.literal(5),
        practicalGainThreshold: z.literal(0.02),
      })
      .passthrough(),
    cells: z.array(SaturationCellSchema).length(80),
    bootstrap: z
      .object({
        rngSeed: z.number().int().nonnegative(),
        samples: z.number().int().positive(),
      })
      .passthrough(),
    selectedCeiling: z.union([z.literal(4), z.literal(8), z.literal(12)]),
    selectionReason: z.enum(["threshold", "fallback"]),
  })
  .passthrough();
export type SaturationCalibrationReportV1 = z.infer<typeof SaturationCalibrationReportV1>;

/**
 * The slice of a verified admission output the generator consumes.
 * `AdmittedCapsule` (./admission.js) is structurally assignable.
 */
export interface M2DraftAdmittedCapsule {
  readonly manifest: CapsuleManifest;
  readonly digest: string;
  readonly orderingReport: DiagnosticOrderingReport;
  readonly provisional: boolean;
  /** Verified Gate-2 approval; null = review-off authoring path (refused here). */
  readonly approval: { readonly approved: true } | null;
}

/** Frozen Panel-A/Panel-B task-to-capsule assignment (plan §corpus, launch-spec §3). */
export interface M2LaunchPanelAssignments {
  readonly panelA: Readonly<Record<string, string>>;
  readonly panelB: Readonly<Record<string, string>>;
}

export interface M2LaunchDraftParameters {
  /** Digest-pinned optimizer/controller runtime image. */
  readonly optimizerImage: string;
  /** One child run's four-dimensional budget slice. */
  readonly childBudget: BudgetEnvelope;
  /** Outer trajectory-generation budget. */
  readonly outerBudget: BudgetEnvelope;
  /**
   * Complete-run resource vector per Panel-A capsule at the frozen calibrated
   * inner ceiling, keyed by capsule id. Launch open decision: these vectors
   * are not plan-frozen; the calibration harness informs them.
   */
  readonly calibratedInnerCeilings: Readonly<Record<string, BudgetEnvelope>>;
  readonly childConcurrency: number;
  /** Optimizer-declared schedule metadata; defaults to the frozen M2 constants. */
  readonly candidates?: number;
  readonly candidateAttemptsMax?: number;
  readonly mutablePaths?: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly promotion?: PromotionRule;
  readonly measurementEpochNamespace?: string;
  /**
   * Explicit caller acknowledgments for generator defaults. A default used
   * WITHOUT its acknowledgment is a REQUIRED unresolved decision: the draft
   * is NON-freezable and written wrapped until the caller either supplies the
   * value or acknowledges the default deliberately.
   */
  readonly acknowledgedDefaults?: readonly M2DraftDefaultAcknowledgment[] | undefined;
}

export interface M2LaunchDraftInputs {
  /** Outer objective, verbatim. */
  readonly objective: string;
  /** Parsed JSON of the corpus-provenance.v1 artifact. */
  readonly provenance: unknown;
  /** Verified admission outputs covering every provenance capsule. */
  readonly admitted: readonly M2DraftAdmittedCapsule[];
  readonly assignments: M2LaunchPanelAssignments;
  /** Parsed JSON of the saturation calibration report; optional but fail-closed. */
  readonly calibrationReport?: unknown;
  /**
   * The four designated EXCLUDED calibration capsule identities (frozen
   * launch input). Required whenever a calibration report is supplied; the
   * report's own cell identities are never trusted as the designation.
   */
  readonly calibrationCapsuleIds?: readonly string[] | undefined;
  /** Explicit opt-in to a NON-freezable draft without calibration. */
  readonly draftWithoutCalibration?: boolean;
  readonly parameters: M2LaunchDraftParameters;
}

export interface M2LaunchCalibrationBinding {
  /** sha256 over the canonical JSON of the consumed report. */
  readonly reportDigest: string;
  readonly selectedCeiling: 4 | 8 | 12;
  readonly selectionReason: "threshold" | "fallback";
  readonly bootstrapRngSeed: number;
  readonly bootstrapSamples: number;
}

export interface M2LaunchDraft {
  readonly config: RecursiveMetaCampaignConfig;
  /**
   * False when calibration was explicitly deferred OR any REQUIRED decision
   * is unresolved; writeM2LaunchDraft never emits a bare freeze-consumable
   * file for a non-freezable draft.
   */
  readonly freezable: boolean;
  readonly calibration: M2LaunchCalibrationBinding | null;
  /** Informational notes (acknowledged defaults, placeholders); surface to the owner. */
  readonly openDecisions: readonly string[];
  /** REQUIRED decisions still unresolved; non-empty forces a NON-freezable wrapped draft. */
  readonly unresolvedDecisions: readonly string[];
}

/** Defaults a caller must either override or explicitly acknowledge. */
export type M2DraftDefaultAcknowledgment = "promotion" | "optimizerPaths" | "candidateCounts";
const KNOWN_DEFAULT_ACKNOWLEDGMENTS: readonly M2DraftDefaultAcknowledgment[] = [
  "promotion",
  "optimizerPaths",
  "candidateCounts",
];

/** Draft placeholders freeze overwrites; deterministic and recognizable. */
export const M2_DRAFT_PLACEHOLDER_COMMIT = sha256Hex(
  "hone-m2-launch-draft-placeholder:source-commit",
).slice(0, 40);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256String(value: string): string {
  return `sha256:${sha256Hex(value)}`;
}

function placeholderDigest(label: string): string {
  return sha256String(`hone-m2-launch-draft-placeholder:${label}`);
}


/** Default mutable surface: the prompt/policy/context assets and episode/search loop. */
export const M2_DRAFT_MUTABLE_PATHS: readonly string[] = [
  "optimizer/assets/prompts.ts",
  "optimizer/assets/context.ts",
  "optimizer/assets/policy.ts",
  "optimizer/src/episode.ts",
  "optimizer/src/loop.ts",
];

/** Default protected surface: broker client, entrypoints, build contract, tests, trusted code. */
export const M2_DRAFT_PROTECTED_PATHS: readonly string[] = [
  "optimizer/src/client.ts",
  "optimizer/src/main.ts",
  "optimizer/src/index.ts",
  "optimizer/src/deferred.ts",
  "optimizer/package.json",
  "optimizer/tsconfig.json",
  "optimizer/test",
  "optimizer/worker",
  "schema",
  "trusted",
  "capsules",
];

/** Default M2 promotion rule: G1 sign gate is >=6/8 panel tasks (0.75), paired delta > 2*SE. */
export const M2_DRAFT_PROMOTION: PromotionRule = {
  minDeltaOverSe: 2,
  minSignConsistency: 0.75,
  replicates: 3,
  requireNegativeControls: true,
};

function parseWith<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
  label: string,
): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new UsageError(`${label} is invalid: ${issues}`);
  }
  return result.data;
}

function addBudgets(budgets: readonly BudgetEnvelope[]): BudgetEnvelope {
  return budgets.reduce((total, budget) => ({
    maxTokens: total.maxTokens + budget.maxTokens,
    maxUsd: total.maxUsd + budget.maxUsd,
    maxWallClockSec: total.maxWallClockSec + budget.maxWallClockSec,
    maxEvaluatorInvocations: total.maxEvaluatorInvocations + budget.maxEvaluatorInvocations,
  }));
}

function multiplyBudget(budget: BudgetEnvelope, factor: number): BudgetEnvelope {
  return {
    maxTokens: budget.maxTokens * factor,
    maxUsd: budget.maxUsd * factor,
    maxWallClockSec: budget.maxWallClockSec * factor,
    maxEvaluatorInvocations: budget.maxEvaluatorInvocations * factor,
  };
}

function assertSafeBudget(budget: BudgetEnvelope, label: string): void {
  for (const dimension of BUDGET_DIMENSIONS) {
    const value = budget[dimension];
    if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
      throw new UsageError(`${label} ${dimension} is not safely representable (${value})`);
    }
  }
}

function envelopeIdentity(purpose: "search" | "confirmation" | "terminal", inputsDigest: string): string {
  return sha256String(canonicalJson({
    domain: "hone-m2-launch-envelope-v1",
    purpose,
    inputsDigest,
  }));
}

/**
 * Draft corpus entry from a verified admission output — the exact derivation
 * freeze re-applies (freezeCorpusEntries), so a clean freeze is a no-op on
 * these fields when the installed capsule has not drifted.
 */
function corpusEntry(admitted: M2DraftAdmittedCapsule): MetaCapsuleEntry {
  const id = admitted.manifest.id;
  const baseline = admitted.orderingReport.variants.baseline.train;
  const reference = admitted.orderingReport.variants.improved.train;
  if (!(reference > baseline)) {
    throw new UsageError(`capsule ${id} has no positive train reference scale (baseline ${baseline}, improved ${reference})`);
  }
  for (const [label, value] of [["baseline", baseline], ["improved", reference]] as const) {
    if (value < 0 || value > 1) {
      throw new UsageError(`capsule ${id} ${label} train aggregate ${value} is outside the registered [0, 1] range`);
    }
  }
  return {
    capsuleId: id,
    capsuleDigest: admitted.digest,
    image: admitted.manifest.image,
    oracleDigest: capsuleOracleDigest(admitted),
    scalarizerDigest: capsuleScalarizerDigest(admitted),
    qFail: 0,
    qBase: baseline,
    qReference: reference,
    scale: reference - baseline,
  };
}

interface ResolvedCalibration {
  readonly innerEpisodesMax: 4 | 8 | 12;
  readonly binding: M2LaunchCalibrationBinding | null;
  /** The block frozen INTO the config; sentinel when calibration is deferred. */
  readonly configBinding: M2CalibrationBinding;
  readonly freezable: boolean;
}

function resolveCalibration(
  inputs: M2LaunchDraftInputs,
  corpusCapsuleIds: ReadonlySet<string>,
  openDecisions: string[],
): ResolvedCalibration {
  const { calibrationReport, calibrationCapsuleIds, draftWithoutCalibration } = inputs;
  if (calibrationReport !== undefined && draftWithoutCalibration === true) {
    throw new UsageError(
      `a saturation calibration report was provided; ${DRAFT_WITHOUT_CALIBRATION_FLAG} is contradictory — drop the flag or the report`,
    );
  }
  if (calibrationReport === undefined) {
    if (draftWithoutCalibration !== true) {
      throw new UsageError(
        "saturation calibration report is required: the frozen inner-episode ceiling comes from the "
        + "4-capsule x {2,4,8,12} x 5-seed calibration (launch-spec Phase D step 1); pass "
        + `${DRAFT_WITHOUT_CALIBRATION_FLAG} to emit an explicitly NON-freezable draft`,
      );
    }
    openDecisions.push(
      "calibration DEFERRED: innerEpisodesMax defaulted to the conservative trusted maximum (12); "
      + "the draft is NON-freezable until the saturation calibration report is bound",
    );
    return {
      innerEpisodesMax: 12,
      binding: null,
      configBinding: M2_CALIBRATION_DEFERRED_BINDING,
      freezable: false,
    };
  }

  // The designated excluded capsules are a frozen launch input; the report's
  // own cell identities are candidate-influenced evidence, never the designation.
  if (calibrationCapsuleIds === undefined) {
    throw new UsageError(
      "the four designated excluded calibration capsule identities must be supplied (calibrationCapsuleIds); "
      + "a calibration report is not accepted on its own authority",
    );
  }
  const designated = new Set(calibrationCapsuleIds);
  if (designated.size !== 4 || calibrationCapsuleIds.length !== 4) {
    throw new UsageError(`exactly 4 distinct calibration capsule identities are required, got ${calibrationCapsuleIds.length}`);
  }
  for (const capsuleId of designated) {
    if (!/^cap_[0-9a-f]{12}$/.test(capsuleId)) {
      throw new UsageError(
        `calibration capsule identity ${JSON.stringify(capsuleId)} must be a cap_<12 hex> capsule id`,
      );
    }
    if (corpusCapsuleIds.has(capsuleId)) {
      throw new UsageError(
        `calibration capsule ${capsuleId} is part of the frozen corpus; calibration capsules must be the 4 excluded capsules`,
      );
    }
  }

  const report = parseWith(SaturationCalibrationReportV1, calibrationReport, "saturation calibration report");
  const cellCapsules = new Set(report.cells.map((cell) => cell.capsuleId));
  const undesignated = [...cellCapsules].filter((capsuleId) => !designated.has(capsuleId));
  const uncovered = [...designated].filter((capsuleId) => !cellCapsules.has(capsuleId));
  if (undesignated.length > 0 || uncovered.length > 0) {
    throw new UsageError(
      "calibration report cells do not match the designated excluded capsules"
      + (undesignated.length > 0 ? `; undesignated: ${undesignated.join(", ")}` : "")
      + (uncovered.length > 0 ? `; uncovered: ${uncovered.join(", ")}` : ""),
    );
  }

  // Never trust a copied statistic: rerun the trusted scorer with the
  // recorded RNG options and require the whole report to match canonically.
  const cells: SaturationCell[] = report.cells;
  let recomputed: SaturationCeilingReport;
  try {
    recomputed = selectSaturationCeiling(cells, {
      rngSeed: report.bootstrap.rngSeed,
      bootstrapSamples: report.bootstrap.samples,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`saturation calibration report is invalid: ${message}`);
  }
  if (canonicalJson(recomputed) !== canonicalJson(calibrationReport)) {
    throw new UsageError(
      "saturation calibration report does not match the trusted recomputation "
      + `(rngSeed ${report.bootstrap.rngSeed}, samples ${report.bootstrap.samples}); refusing a drifted or hand-edited report`,
    );
  }

  const reportDigest = sha256String(canonicalJson(recomputed));
  return {
    innerEpisodesMax: recomputed.selectedCeiling,
    binding: {
      reportDigest,
      selectedCeiling: recomputed.selectedCeiling,
      selectionReason: recomputed.selectionReason,
      bootstrapRngSeed: recomputed.bootstrap.rngSeed,
      bootstrapSamples: recomputed.bootstrap.samples,
    },
    configBinding: {
      reportDigest,
      excludedCapsuleIds: [...calibrationCapsuleIds].sort(),
    },
    freezable: true,
  };
}

function indexAdmitted(
  admitted: readonly M2DraftAdmittedCapsule[],
  provenance: CorpusProvenanceV1,
): Map<string, M2DraftAdmittedCapsule> {
  const byId = new Map<string, M2DraftAdmittedCapsule>();
  for (const capsule of admitted) {
    const id = capsule.manifest.id;
    if (byId.has(id)) throw new UsageError(`duplicate admission output for capsule ${id}`);
    byId.set(id, capsule);
  }
  for (const registered of provenance.capsules) {
    const found = byId.get(registered.id);
    if (found === undefined) {
      throw new UsageError(`provenance capsule ${registered.id} has no admission output`);
    }
    if (found.provisional) {
      throw new UsageError(`capsule ${registered.id} admission is provisional; provisional capsules are quarantined from campaigns`);
    }
    if (found.approval === null) {
      throw new UsageError(`capsule ${registered.id} has no verified Gate-2 approval; review-off admission is refused for launch drafts`);
    }
    if (found.digest !== registered.digest) {
      throw new UsageError(
        `capsule ${registered.id} identity drift: admission digest ${found.digest} != provenance digest ${registered.digest}`,
      );
    }
  }
  return byId;
}

function resolvePanelAssignment(
  assignments: M2LaunchPanelAssignments,
  provenance: CorpusProvenanceV1,
): { panelA: ReadonlyMap<string, string> } {
  const development = new Set(provenance.developmentCapsuleIds);
  const seen = new Set<string>();
  const resolve = (
    mapping: Readonly<Record<string, string>>,
    expected: readonly string[],
    label: string,
  ): Map<string, string> => {
    const keys = Object.keys(mapping);
    const expectedSet = new Set(expected);
    const missing = expected.filter((taskId) => mapping[taskId] === undefined);
    const unknown = keys.filter((taskId) => !expectedSet.has(taskId));
    if (missing.length > 0 || unknown.length > 0) {
      throw new UsageError(
        `${label} assignment must map exactly the frozen task ids`
        + (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "")
        + (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""),
      );
    }
    const resolved = new Map<string, string>();
    for (const taskId of expected) {
      const capsuleId = mapping[taskId]!;
      if (!development.has(capsuleId)) {
        throw new UsageError(`${label} task ${taskId} maps to ${capsuleId}, which is not a development capsule`);
      }
      if (seen.has(capsuleId)) {
        throw new UsageError(`capsule ${capsuleId} is assigned to more than one panel task`);
      }
      seen.add(capsuleId);
      resolved.set(taskId, capsuleId);
    }
    return resolved;
  };
  const panelA = resolve(assignments.panelA, M2_PANEL_A_TASK_IDS, "Panel-A");
  resolve(assignments.panelB, M2_PANEL_B_TASK_IDS, "Panel-B");
  if (seen.size !== M2_DEVELOPMENT_CAPSULE_COUNT) {
    const unassigned = provenance.developmentCapsuleIds.filter((id) => !seen.has(id));
    throw new UsageError(`development capsules missing a panel assignment: ${unassigned.join(", ")}`);
  }
  return { panelA };
}

function checkTerminalCapsule(
  admitted: M2DraftAdmittedCapsule,
  innerEpisodesMax: number,
  terminalContentHashes: ReadonlySet<string>,
): void {
  const id = admitted.manifest.id;
  const holdoutGroups = admitted.manifest.assetGroups.filter((group) => group.visibility === "holdout");
  if (holdoutGroups.length === 0) {
    throw new UsageError(`terminal capsule ${id} has no holdout asset group`);
  }
  // Mirrors the non-freeze phase gate (resolveRegisteredCapsules): 3 terminal
  // arms x 3 replicates, (4 * innerEpisodesMax + 1) accesses per run.
  const requiredLifetimeAccesses = (4 * innerEpisodesMax + 1) * 3 * 3;
  if (admitted.manifest.budget.maxEvaluatorInvocations < requiredLifetimeAccesses) {
    throw new UsageError(
      `terminal capsule ${id} lifetime budget ${admitted.manifest.budget.maxEvaluatorInvocations} `
      + `cannot cover ${requiredLifetimeAccesses} accesses`,
    );
  }
  for (const [path, hash] of Object.entries(admitted.manifest.contentHashes)) {
    if (!terminalContentHashes.has(hash)) {
      throw new UsageError(
        `terminal capsule ${id} content hash for ${path} is missing from provenance.terminalContentHashes`,
      );
    }
  }
}

/** Assemble and schema-validate the initial (Stage-A) M2 campaign draft. */
export function generateM2LaunchDraft(inputs: M2LaunchDraftInputs): M2LaunchDraft {
  const openDecisions: string[] = [];
  // Digest-verify FIRST (branded chokepoint), then launch-cardinality checks.
  const provenance = parseWith(
    LaunchCorpusProvenance,
    verifyCorpusProvenance(
      parseWith(CorpusProvenanceV1, inputs.provenance, "corpus provenance artifact"),
    ),
    "corpus provenance artifact",
  );
  const corpusCapsuleIds = new Set(provenance.capsules.map((capsule) => capsule.id));

  const calibration = resolveCalibration(inputs, corpusCapsuleIds, openDecisions);
  const admittedById = indexAdmitted(inputs.admitted, provenance);
  const { panelA } = resolvePanelAssignment(inputs.assignments, provenance);

  const terminalContentHashes = new Set(provenance.terminalContentHashes);
  for (const capsuleId of provenance.terminalCapsuleIds) {
    checkTerminalCapsule(
      admittedById.get(capsuleId)!,
      calibration.innerEpisodesMax,
      terminalContentHashes,
    );
  }

  // Train = Panel A in frozen task order; holdout = the provenance terminal order.
  const train = M2_PANEL_A_TASK_IDS.map((taskId) => corpusEntry(admittedById.get(panelA.get(taskId)!)!));
  const holdout = provenance.terminalCapsuleIds.map((capsuleId) => corpusEntry(admittedById.get(capsuleId)!));

  const parameters = inputs.parameters;
  const ceilings = parameters.calibratedInnerCeilings;
  const panelCapsuleIds = new Set(panelA.values());
  const missingCeilings = [...panelCapsuleIds].filter((capsuleId) => ceilings[capsuleId] === undefined);
  if (missingCeilings.length > 0) {
    throw new UsageError(`calibrated inner ceiling vectors missing for Panel-A capsules: ${missingCeilings.join(", ")}`);
  }
  const unknownCeilings = Object.keys(ceilings).filter((capsuleId) => !panelCapsuleIds.has(capsuleId));
  if (unknownCeilings.length > 0) {
    throw new UsageError(`calibrated inner ceiling vectors name non-Panel-A capsules: ${unknownCeilings.join(", ")}`);
  }

  // B3 — per-run evaluator floors BEFORE any aggregate arithmetic: one complete
  // child run needs 4 * innerEpisodesMax + 1 evaluator invocations; the outer
  // trajectory needs candidateAttemptsMax + 1 (every attempt plus baseline).
  // The M2 schema superRefine rechecks the same invariants at freeze.
  const candidateAttemptsMax = parameters.candidateAttemptsMax ?? M2_CANDIDATE_ATTEMPTS_MAX;
  const perRunEvaluatorFloor = 4 * calibration.innerEpisodesMax + 1;
  if (parameters.childBudget.maxEvaluatorInvocations < perRunEvaluatorFloor) {
    throw new UsageError(
      `child budget maxEvaluatorInvocations ${parameters.childBudget.maxEvaluatorInvocations} cannot fund one `
      + `complete run at innerEpisodesMax ${calibration.innerEpisodesMax} (needs ${perRunEvaluatorFloor})`,
    );
  }
  if (parameters.outerBudget.maxEvaluatorInvocations < candidateAttemptsMax + 1) {
    throw new UsageError(
      `outer budget maxEvaluatorInvocations ${parameters.outerBudget.maxEvaluatorInvocations} cannot fund `
      + `candidateAttemptsMax + 1 evaluations (needs ${candidateAttemptsMax + 1})`,
    );
  }
  for (const capsuleId of panelCapsuleIds) {
    const ceiling = ceilings[capsuleId]!;
    if (ceiling.maxEvaluatorInvocations < perRunEvaluatorFloor) {
      throw new UsageError(
        `calibrated inner ceiling for ${capsuleId} (maxEvaluatorInvocations ${ceiling.maxEvaluatorInvocations}) `
        + `cannot fund one complete run at innerEpisodesMax ${calibration.innerEpisodesMax} (needs ${perRunEvaluatorFloor})`,
      );
    }
  }

  const members = M2_PANEL_A_TASK_IDS.map((taskId, index) => ({
    taskId,
    capsule: train[index]!,
    calibratedInnerCeiling: ceilings[panelA.get(taskId)!]!,
  }));

  const calibratedPanelCandidate = addBudgets(members.map((member) => member.calibratedInnerCeiling));
  const outerTrajectory = multiplyBudget(calibratedPanelCandidate, M2_SEARCH_CANDIDATE_EQUIVALENTS);
  assertSafeBudget(outerTrajectory, "search outer trajectory");
  const confirmationRuns = 4 * M2_PANEL_CAPSULE_COUNT * 3;
  const terminalRuns = 3 * M2_TERMINAL_CAPSULE_COUNT * 3;
  const confirmationBudget = multiplyBudget(parameters.childBudget, confirmationRuns);
  const terminalBudget = multiplyBudget(parameters.childBudget, terminalRuns);
  const campaignBudget = addBudgets([
    parameters.outerBudget,
    outerTrajectory,
    confirmationBudget,
    terminalBudget,
  ]);
  assertSafeBudget(campaignBudget, "campaign budget");

  const optimizerIdentity = {
    sourceCommit: M2_DRAFT_PLACEHOLDER_COMMIT,
    sourceArtifact: placeholderDigest("target-source"),
    bundleDigest: placeholderDigest("target-bundle"),
  };
  const acknowledged = new Set(parameters.acknowledgedDefaults ?? []);
  for (const acknowledgment of acknowledged) {
    if (!KNOWN_DEFAULT_ACKNOWLEDGMENTS.includes(acknowledgment)) {
      throw new UsageError(`unknown default acknowledgment "${acknowledgment}"; known: ${KNOWN_DEFAULT_ACKNOWLEDGMENTS.join(", ")}`);
    }
  }
  const unresolvedDecisions: string[] = [];
  const recordDefault = (key: M2DraftDefaultAcknowledgment, message: string): void => {
    if (acknowledged.has(key)) openDecisions.push(`${message} (default explicitly acknowledged: "${key}")`);
    else unresolvedDecisions.push(`${message} — REQUIRED: supply the value or acknowledge the default ("${key}")`);
  };
  openDecisions.push(
    "seedOptimizer/controllerOptimizer/trustedRuntime/controls and protocol/analysis hashes are deterministic "
    + "placeholders; `hone recursive --phase freeze` resolves and seals the real identities",
  );
  if (parameters.promotion === undefined) {
    recordDefault(
      "promotion",
      "promotion rule defaulted to the M2 G1 gate reading (delta > 2*SE, >=6/8 sign consistency, 3 replicates)",
    );
  }
  if (parameters.mutablePaths === undefined || parameters.protectedPaths === undefined) {
    recordDefault(
      "optimizerPaths",
      "mutable/protected optimizer paths defaulted from the current optimizer tree",
    );
  }
  if (parameters.candidates === undefined || parameters.candidateAttemptsMax === undefined) {
    recordDefault(
      "candidateCounts",
      `counts.candidates/candidateAttemptsMax defaulted to the frozen M2 constants (${M2_CANDIDATE_COUNT}/${M2_CANDIDATE_ATTEMPTS_MAX})`,
    );
  }
  openDecisions.push(
    "budget vectors (child/outer/per-capsule calibrated ceilings) are launch open decision #4 — caller-supplied, not plan-frozen",
  );

  const config = {
    version: 2,
    objective: inputs.objective,
    seedOptimizer: optimizerIdentity,
    controllerOptimizer: optimizerIdentity,
    optimizerRuntime: { image: parameters.optimizerImage },
    generation: {
      stage: "A",
      panel: "A",
      targetGeneration: 0,
      controllerGeneration: 0,
      outerReplicate: 0,
    },
    trustedRuntime: {
      sourceCommit: M2_DRAFT_PLACEHOLDER_COMMIT,
      digest: placeholderDigest("trusted-runtime"),
    },
    mutablePaths: [...(parameters.mutablePaths ?? M2_DRAFT_MUTABLE_PATHS)],
    protectedPaths: [...(parameters.protectedPaths ?? M2_DRAFT_PROTECTED_PATHS)],
    train,
    holdout,
    routing: {
      outerMutation: M2_OUTER_MODEL_ROUTE,
      innerMutation: M2_INNER_MODEL_ROUTE,
    },
    modelObservation: {
      outerRequestedRoute: M2_OUTER_MODEL_ROUTE,
      innerRequestedRoute: M2_INNER_MODEL_ROUTE,
      identity: "alias-observation",
      recordResponseModel: true,
      recordProviderFingerprint: true,
      driftSentinel: true,
    },
    calibration: calibration.configBinding,
    corpusCohort: {
      developmentCapsuleIds: [...provenance.developmentCapsuleIds],
      terminalCapsuleIds: [...provenance.terminalCapsuleIds],
      provenanceInputsDigest: provenance.inputsDigest,
    },
    counts: {
      candidates: parameters.candidates ?? M2_CANDIDATE_COUNT,
      candidateAttemptsMax,
      innerEpisodesMax: calibration.innerEpisodesMax,
      searchReplicates: 1,
      confirmationReplicates: 3,
      holdoutReplicates: 3,
      childConcurrency: parameters.childConcurrency,
    },
    budgets: {
      campaign: campaignBudget,
      outer: parameters.outerBudget,
      child: parameters.childBudget,
    },
    developmentPanel: {
      panel: "A",
      members,
    },
    recursiveBudgets: {
      search: {
        identity: { envelopeId: envelopeIdentity("search", provenance.inputsDigest), purpose: "search" },
        calibratedPanelCandidate,
        outerTrajectory,
      },
      confirmation: {
        identity: { envelopeId: envelopeIdentity("confirmation", provenance.inputsDigest), purpose: "confirmation" },
        budget: confirmationBudget,
      },
      terminal: {
        identity: { envelopeId: envelopeIdentity("terminal", provenance.inputsDigest), purpose: "terminal" },
        budget: terminalBudget,
      },
    },
    controls: {
      brokenSourceArtifact: placeholderDigest("broken-source"),
      brokenBundleDigest: placeholderDigest("broken-bundle"),
      degradedSourceArtifact: placeholderDigest("degraded-source"),
      degradedBundleDigest: placeholderDigest("degraded-bundle"),
    },
    promotion: parameters.promotion ?? M2_DRAFT_PROMOTION,
    measurementEpochNamespace:
      parameters.measurementEpochNamespace
      ?? `m2-launch-${provenance.inputsDigest.slice("sha256:".length, "sha256:".length + 12)}`,
    allowedClaim: "recursive-transfer-frozen-corpus",
    protocolHash: placeholderDigest("protocol-hash"),
    analysisConfigHash: placeholderDigest("analysis-config-hash"),
    invariants: {
      apply: "none",
      terminalHoldoutPhases: 1,
      holdoutFeedbackToOptimizer: false,
      holdoutSearchEligible: false,
    },
  };

  return {
    // Deferred drafts carry the reserved sentinel, which the OFFICIAL schema
    // (and therefore freeze) rejects; they validate only under the draft-only
    // schema and are emitted wrapped. Calibrated drafts must be official-valid.
    config: parseWith(
      calibration.binding === null ? MetaCampaignConfigV2Draft : MetaCampaignConfigV2,
      config,
      "generated M2 draft",
    ),
    freezable: calibration.freezable && unresolvedDecisions.length === 0,
    calibration: calibration.binding,
    openDecisions,
    unresolvedDecisions,
  };
}

/**
 * Persist the draft next to a sidecar generation record bound to the config
 * by digest. Only a freezable draft is written as a bare campaign file that
 * `hone recursive --campaign <path> --phase freeze` can consume; a draft with
 * deferred calibration or unresolved REQUIRED decisions is written WRAPPED
 * (m2-launch-draft.v1), which MetaCampaignConfigV2 rejects — so freeze fails
 * closed on it mechanically instead of relying on anyone reading the sidecar.
 */
export function writeM2LaunchDraft(
  outputPath: string,
  draft: M2LaunchDraft,
): { configPath: string; recordPath: string; configDigest: string } {
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const configDigest = sha256String(canonicalJson(draft.config));
  if (draft.freezable) {
    writeFileDurable(outputPath, `${JSON.stringify(draft.config, null, 2)}\n`);
  } else {
    const reasons = [
      ...(draft.calibration === null
        ? ["calibration deferred: the saturation calibration report is not bound"]
        : []),
      ...(draft.unresolvedDecisions.length > 0
        ? [`unresolved REQUIRED decisions: ${draft.unresolvedDecisions.join(" | ")}`]
        : []),
    ];
    writeFileDurable(outputPath, `${JSON.stringify({
      version: M2_LAUNCH_DRAFT_DOCUMENT_VERSION,
      freezable: false,
      reason: `not freeze-consumable — ${reasons.join("; ")}`,
      configDigest,
      config: draft.config,
    }, null, 2)}\n`);
  }
  const recordPath = `${outputPath}.record.json`;
  writeFileDurable(recordPath, `${JSON.stringify({
    version: M2_LAUNCH_DRAFT_RECORD_VERSION,
    configDigest,
    freezable: draft.freezable,
    calibration: draft.calibration,
    openDecisions: draft.openDecisions,
    unresolvedDecisions: draft.unresolvedDecisions,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return { configPath: outputPath, recordPath, configDigest };
}
