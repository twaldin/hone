import { z } from "zod";
import { BudgetEnvelope } from "./capsule.js";
import {
  PROMOTION_GATE_VERSION,
  PromotionGateDecision,
  PromotionNoiseCalibration,
} from "./promotion.js";
import {
  HoldoutNullControlRecord,
  PromotionHoldoutRecord,
  RecordHoldoutNullControlParams,
  RecordPromotionHoldoutParams,
} from "./holdout.js";

/**
 * Contract 2 — Broker wire protocol (JSON-RPC 2.0 over unix socket).
 *
 * The trusted daemon is a sandbox BROKER (review IV.1): the mutable optimizer
 * runs in an unprivileged container as a broker CLIENT. createSandbox/evaluate
 * spawn SIBLING containers — no nesting, no docker socket, quotas and depth
 * caps enforced centrally. This file defines method names + param/result
 * schemas; transport framing is newline-delimited JSON-RPC.
 */

export const BROKER_PROTOCOL_VERSION = 1;

// ---------- shared ----------

export const SandboxRef = z.object({ sandboxId: z.string().min(1) });
export type SandboxRef = z.infer<typeof SandboxRef>;

export const ArtifactRef = z.object({
  /** CAS hash of the artifact snapshot (tar of the candidate tree). */
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const BudgetState = z.object({
  envelope: BudgetEnvelope,
  spent: z.object({
    tokens: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
    wallClockSec: z.number().nonnegative(),
    evaluatorInvocations: z.number().int().nonnegative(),
  }),
  /** Total elapsed time since run start, including pauses and offline gaps (operator observability only). */
  lifetimeSec: z.number().nonnegative().optional(),
});
export type BudgetState = z.infer<typeof BudgetState>;

export const RunDepth = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type RunDepth = z.infer<typeof RunDepth>;

/**
 * Development-only recursive task surface. Trusted orchestration derives it
 * from the frozen panel; terminal identities have no representation here.
 */
export const RecursiveTaskMember = z.object({
  capsuleId: z.string().min(1),
  calibratedInnerCeiling: BudgetEnvelope,
}).strict();
export type RecursiveTaskMember = z.infer<typeof RecursiveTaskMember>;

export const RecursiveTask = z.object({
  depth: RunDepth,
  innerEpisodesMax: z.number().int().positive(),
  members: z.array(RecursiveTaskMember).min(1),
}).strict();
export type RecursiveTask = z.infer<typeof RecursiveTask>;

// ---------- methods ----------

export const GetTaskResult = z.object({
  capsuleId: z.string(),
  objective: z.string(),
  baselineArtifact: ArtifactRef,
  /** Asset group ids visible to the optimizer (never contents of protected/holdout). */
  visibleAssetGroups: z.array(z.string()),
  budget: BudgetState,
  /** Exact capsule/evaluator/group/measurement-epoch calibrations trusted for this run. */
  promotionGateCalibrations: z.array(PromotionNoiseCalibration),
  /** Present only when trusted orchestration configured a development-panel recursive evaluator. */
  recursiveTask: RecursiveTask.optional(),
});

/** Longest authenticated mutation-sandbox claim the public wire admits. */
export const MAX_SANDBOX_TTL_SEC = 86_400;

export const CreateSandboxParams = z.object({
  /** Artifact to unpack into /workspace inside the sandbox. */
  artifact: ArtifactRef,
  /** "mutation" sandboxes get proxy access + writable workspace; no protected mounts ever. */
  role: z.literal("mutation"),
  /**
   * Continue this exact incomplete checkpoint-v1 episode (one-repair flow).
   * The broker validates that the artifact belongs to the episode and never
   * mints a second episode boundary.
   */
  continueEpisode: z.number().int().nonnegative().optional(),
  ttlSec: z.number().int().positive().max(MAX_SANDBOX_TTL_SEC).optional(),
});

export const ExecParams = z.object({
  sandboxId: z.string(),
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  timeoutSec: z.number().int().positive().max(3_600).optional(),
  stdin: z.string().optional(),
});
export const ExecResult = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

export const PutFileParams = z.object({
  sandboxId: z.string(),
  path: z.string(),
  contentBase64: z.string(),
});
export const GetFileParams = z.object({ sandboxId: z.string(), path: z.string() });
export const GetFileResult = z.object({ contentBase64: z.string() });

export const SaveArtifactParams = z.object({ sandboxId: z.string() });

export const RecursiveEvaluationAllocation = z.object({
  capsuleId: z.string().min(1),
  allocationOrdinal: z.number().int().nonnegative(),
  innerEpisodesMax: z.number().int().positive(),
  reservation: BudgetEnvelope,
}).strict();
export type RecursiveEvaluationAllocation = z.infer<typeof RecursiveEvaluationAllocation>;

/**
 * Optimizer-authored allocation policy for one recursive candidate score.
 * Trusted orchestration derives child identities and enforces membership,
 * per-capsule ceilings, and ancestor budget reservations.
 */
export const RecursiveEvaluationPlan = z.object({
  allocations: z.array(RecursiveEvaluationAllocation).min(1).max(100),
}).strict();
export type RecursiveEvaluationPlan = z.infer<typeof RecursiveEvaluationPlan>;

export const EvaluateParams = z.object({
  artifact: ArtifactRef,
  assetGroupId: z.string(),
  seed: z.number().int().nonnegative(),
  recursivePlan: RecursiveEvaluationPlan.optional(),
  /**
   * Continue the one journaled-but-incomplete episode. The broker accepts
   * this only for exact evaluation facts already held by that checkpoint;
   * new coordinates are charged normally.
   */
  resume: z.literal(true).optional(),
});

export const ReportIncumbentParams = z.object({
  artifact: ArtifactRef,
  /** Optimizer's own claimed metrics — display only; trusted scores come from EvaluationRecords. */
  claimed: z.record(z.number()).optional(),
});

export const GetPromotionVerdictParams = z.object({ artifact: ArtifactRef }).strict();
export const PromotionVerdictRefusalReason = z.enum([
  "no-lineage",
  "no-public-admission",
  "no-persisted-pair",
  "lineage-mismatch",
  "legacy-unversioned-gate",
]);
const PromotionPair = z.object({
  parent: ArtifactRef,
  parentScore: z.number(),
  childScore: z.number(),
  delta: z.number(),
  gateVersion: z.literal(PROMOTION_GATE_VERSION),
  calibrationEvidenceVersion: z.string().nullable(),
  noiseFloor: z.number().nonnegative().nullable(),
  noiseEnvelope: z.number().nonnegative().nullable(),
  decision: PromotionGateDecision,
});
export const PromotionVerdict = z.discriminatedUnion("status", [
  z.object({ status: z.literal("never-paired") }).strict(),
  PromotionPair.extend({ status: z.literal("promotable") }).strict(),
  PromotionPair.extend({ status: z.literal("not-promotable") }).strict(),
  z.object({
    status: z.literal("refused"),
    reason: PromotionVerdictRefusalReason,
  }).strict(),
]);
export type PromotionVerdict = z.infer<typeof PromotionVerdict>;
export const SESSION_NO_YIELD_RECORD_TYPE = "hone.mutation.no-yield-bound.v1" as const;
export const SESSION_NO_YIELD_EXIT_CODE = 4;

export const SESSION_USAGE_ANOMALY_RECORD_TYPE = "hone.mutation.usage-anomaly.v1" as const;
export const SessionUsageAnomalyRecord = z.object({
  type: z.literal(SESSION_USAGE_ANOMALY_RECORD_TYPE),
  zeroUsageTurns: z.number().int().nonnegative(),
  normalizedUsageTurns: z.number().int().nonnegative(),
}).strict();
export type SessionUsageAnomalyRecord = z.infer<typeof SessionUsageAnomalyRecord>;

const SessionNoYieldRecordFields = z.object({
  type: z.literal(SESSION_NO_YIELD_RECORD_TYPE),
  limitTokens: z.number().int().positive(),
  modelCalls: z.number().int().positive(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  consumedTokens: z.number().int().positive(),
}).strict();

export const SessionNoYieldRecord = SessionNoYieldRecordFields.superRefine((value, ctx) => {
  if (value.consumedTokens < value.limitTokens) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consumedTokens must reach limitTokens" });
  }
  if (value.consumedTokens < value.promptTokens + value.completionTokens) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consumedTokens cannot be less than promptTokens + completionTokens" });
  }
});
export type SessionNoYieldRecord = z.infer<typeof SessionNoYieldRecord>;

export const ReportSessionNoYieldBoundParams = SessionNoYieldRecordFields.extend({
  sandboxId: z.string().min(1),
}).superRefine((value, ctx) => {
  if (value.consumedTokens < value.limitTokens) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consumedTokens must reach limitTokens" });
  }
  if (value.consumedTokens < value.promptTokens + value.completionTokens) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "consumedTokens cannot be less than promptTokens + completionTokens" });
  }
});
export type ReportSessionNoYieldBoundParams = z.infer<typeof ReportSessionNoYieldBoundParams>;


export const FinishParams = z.object({ best: ArtifactRef });
export const CompleteEpisodeParams = z.object({
  episode: z.number().int().nonnegative(),
  /**
   * A resumed episode with a journaled candidate claims a fresh sandbox only
   * to reactivate its measurement epoch. No mutation/save follows, so the
   * broker retires this exact sandbox atomically with the completion boundary.
   */
  releaseSandboxId: z.string().min(1).optional(),
}).strict();


/** Componentwise trusted resource accounting for recursive child runs. */
export const ResourceUsage = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  wallClockSec: z.number().nonnegative(),
  evaluatorInvocations: z.number().int().nonnegative(),
});
export type ResourceUsage = z.infer<typeof ResourceUsage>;

export const ChildRunSpec = z.object({
  /** Durable identity: retries and crash recovery reuse this exact run id. */
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  capsuleId: z.string().min(1),
  sourceArtifact: ArtifactRef,
  optimizerArtifact: ArtifactRef,
  purpose: z.enum(["capsule", "delegated", "self-ab"]),
  /** Optimizer-authored schedule identity; trusted meta decides when it is required. */
  schedule: z
    .object({
      candidateOrdinal: z.number().int().nonnegative(),
      allocationOrdinal: z.number().int().nonnegative(),
      innerEpisodesMax: z.number().int().positive(),
    })
    .strict()
    .optional(),
});
export type ChildRunSpec = z.infer<typeof ChildRunSpec>;

export const SpawnRunParams = z.object({
  child: ChildRunSpec,
  /** Requested child depth. Trusted broker state, not this value, decides whether it is admissible. */
  depth: z.union([z.literal(1), z.literal(2)]),
  /** Reserved atomically from every ancestor before the child launcher is called. */
  reservation: BudgetEnvelope,
});
export type SpawnRunParams = z.infer<typeof SpawnRunParams>;

export const ChildRunAdmission = z.object({
  campaignConfigHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  cohort: z.enum(["panel-a", "panel-b", "delegated-development"]),
  capsuleProvenanceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sourceProvenanceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  optimizerProvenanceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type ChildRunAdmission = z.infer<typeof ChildRunAdmission>;

export const ChildRunLaunchReceipt = z.object({
  child: ChildRunSpec,
  depth: z.union([z.literal(1), z.literal(2)]),
  admission: ChildRunAdmission,
  launchedAt: z.string().datetime(),
  receiptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type ChildRunLaunchReceipt = z.infer<typeof ChildRunLaunchReceipt>;

export const ChildRunTerminal = z.object({
  runId: z.string().min(1),
  cursor: z.number().int().nonnegative(),
  eventDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  launchReceiptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: z.enum(["completed", "stopped", "failed", "budget"]),
});
export type ChildRunTerminal = z.infer<typeof ChildRunTerminal>;

export const SpawnRunResult = z.object({
  child: ChildRunSpec,
  depth: z.union([z.literal(1), z.literal(2)]),
  reservation: BudgetEnvelope,
  /** Direct usage of this run; nested descendant usage is accounted by its own ancestor settlement. */
  usage: ResourceUsage,
  terminal: ChildRunTerminal,
});
export type SpawnRunResult = z.infer<typeof SpawnRunResult>;

export const CorpusSource = z.enum(["public-snapshot", "panel-evidence"]);
export type CorpusSource = z.infer<typeof CorpusSource>;

export const CorpusCursor = z.string().regex(/^corpus_[0-9a-f]{64}_[0-9a-f]{64}_[0-9]+$/);
export type CorpusCursor = z.infer<typeof CorpusCursor>;

export const CorpusQuery = z.object({
  text: z.string().max(4_096).default(""),
  sources: z.array(CorpusSource).min(1).max(2).default(["public-snapshot", "panel-evidence"]),
});
export type CorpusQuery = z.infer<typeof CorpusQuery>;

export const QueryCorpusParams = z.object({
  query: CorpusQuery,
  cursor: CorpusCursor.nullable().default(null),
  pageSize: z.number().int().positive().max(100).default(50),
});
export type QueryCorpusParams = z.infer<typeof QueryCorpusParams>;

export const CorpusPublicProvenance = z.object({
  campaignConfigHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  cohort: z.literal("public-history"),
});
export type CorpusPublicProvenance = z.infer<typeof CorpusPublicProvenance>;

export const CorpusPanelProvenance = z.object({
  campaignConfigHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  cohort: z.enum(["panel-a", "panel-b"]),
  capsuleId: z.string().min(1),
});
export type CorpusPanelProvenance = z.infer<typeof CorpusPanelProvenance>;

export const CorpusPublicDocument = z.object({
  source: z.literal("public-snapshot"),
  provenance: CorpusPublicProvenance,
  id: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  content: z.string(),
});
export type CorpusPublicDocument = z.infer<typeof CorpusPublicDocument>;

export const CorpusPanelEvidence = z.object({
  source: z.literal("panel-evidence"),
  provenance: CorpusPanelProvenance,
  id: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  content: z.string(),
  usage: ResourceUsage,
});
export type CorpusPanelEvidence = z.infer<typeof CorpusPanelEvidence>;

/** No terminal source variant exists: terminal identities/evidence cannot be represented on this wire. */
export const CorpusDocument = z.discriminatedUnion("source", [CorpusPublicDocument, CorpusPanelEvidence]);
export type CorpusDocument = z.infer<typeof CorpusDocument>;

export const QueryCorpusResult = z.object({
  snapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  corpusVersionHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  cursor: CorpusCursor,
  nextCursor: CorpusCursor.nullable(),
  documents: z.array(CorpusDocument),
});
export type QueryCorpusResult = z.infer<typeof QueryCorpusResult>;

export const BrokerMethods = {
  getTask: { params: z.object({}), result: GetTaskResult },
  createSandbox: { params: CreateSandboxParams, result: SandboxRef },
  exec: { params: ExecParams, result: ExecResult },
  putFile: { params: PutFileParams, result: z.object({}) },
  getFile: { params: GetFileParams, result: GetFileResult },
  saveArtifact: { params: SaveArtifactParams, result: ArtifactRef },
  evaluate: {
    params: EvaluateParams,
    // EvaluationRecord defined in evaluator.ts; kept loose here to avoid a cycle — runner re-validates.
    result: z.object({}).passthrough(),
  },
  getPromotionVerdict: { params: GetPromotionVerdictParams, result: PromotionVerdict },
  reportIncumbent: { params: ReportIncumbentParams, result: z.object({}) },
  recordHoldoutNullControl: {
    params: RecordHoldoutNullControlParams,
    result: HoldoutNullControlRecord,
  },
  recordPromotionHoldout: {
    params: RecordPromotionHoldoutParams,
    result: PromotionHoldoutRecord,
  },
  reportSessionNoYieldBound: { params: ReportSessionNoYieldBoundParams, result: z.object({}) },
  completeEpisode: { params: CompleteEpisodeParams, result: z.object({}) },
  getBudget: { params: z.object({}), result: BudgetState },
  finish: { params: FinishParams, result: z.object({}) },
  spawnRun: { params: SpawnRunParams, result: SpawnRunResult },
  queryCorpus: { params: QueryCorpusParams, result: QueryCorpusResult },
} as const;
export type BrokerMethodName = keyof typeof BrokerMethods;

/** Reserved optimizer exits interpreted only by the trusted container supervisor. */
export const OPTIMIZER_STORAGE_EXHAUSTED_EXIT_CODE = 73;
export const OPTIMIZER_CHILD_PENDING_EXIT_CODE = 75;

export const BrokerErrorCode = z.enum([
  "BUDGET_EXCEEDED",
  "SANDBOX_NOT_FOUND",
  "CHILD_ADMISSION_DENIED",
  "PROTECTED_PATH_VIOLATION",
  "HOLDOUT_ACCESS_DENIED",
  "DEPTH_EXCEEDED",
  "RESERVATION_EXCEEDED",
  "CORPUS_UNAVAILABLE",
  "CURSOR_INVALID",
  "NOT_IMPLEMENTED",
  "QUOTA_EXCEEDED",
  "STORAGE_EXHAUSTED",
  "CHILD_PENDING",
  "INTERNAL",
]);
export type BrokerErrorCode = z.infer<typeof BrokerErrorCode>;
