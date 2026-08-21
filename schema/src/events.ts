import { z } from "zod";
import { ArtifactRef, BudgetState, QueryCorpusParams, QueryCorpusResult } from "./broker.js";
import { CampaignPauseReason } from "./proxy.js";
import { EvaluatorIsolationRecord } from "./evaluator.js";

/**
 * Contract 4 — Event log. Append-only NDJSON, one file per run.
 * `cursor` = 0-based line index; attach/resume/UI/sync all read the same
 * stream. Replay of this file MUST be sufficient to reconstruct run state
 * (that is the resumability contract — no other state store in the seed).
 */

export const EVENT_LOG_VERSION = 1;

const base = {
  runId: z.string(),
  at: z.string().datetime(),
} as const;

/**
 * Every durable way a run can stop spending. Supervisors consume this single
 * taxonomy instead of inferring an outcome from nullable candidates or sidecars.
 */
export const RunPauseReason = CampaignPauseReason.or(z.literal("operator"));
export type RunPauseReason = z.infer<typeof RunPauseReason>;
export const RunStopReason = z.enum(["operator", "budget-exhausted", "session-no-yield-bound"]);
export type RunStopReason = z.infer<typeof RunStopReason>;
export const RunFailureReason = z.literal("crash");
export type RunFailureReason = z.infer<typeof RunFailureReason>;
export const RunOutcomeReason = z.union([RunPauseReason, RunStopReason, RunFailureReason]);
export type RunOutcomeReason = z.infer<typeof RunOutcomeReason>;

export const RunEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("run.started"),
    capsuleId: z.string(),
    contractHash: z.string(),
    optimizerDigest: z.string(),
    /** Version 1 advances resume only after episode.completed, never episode.started. */
    checkpointVersion: z.literal(1).optional(),
    /** Campaign identity a spawned child was admitted under. Broker settlement
     * verification REQUIRES it to match ChildRunAdmission.campaignConfigHash
     * for recursive children; absent for plain standalone runs. */
    campaignConfigHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  }),
  z.object({ ...base, type: z.literal("run.resumed"), fromCursor: z.number().int().nonnegative() }),
  z.object({
    ...base,
    type: z.literal("run.paused"),
    reason: RunPauseReason,
    pauseId: z.string().min(1).optional(),
    providerStatus: z.number().int().nullable().optional(),
  }),
  z.object({ ...base, type: z.literal("episode.started"), episode: z.number().int().nonnegative(), parent: ArtifactRef }),
  z.object({ ...base, type: z.literal("episode.candidate"), episode: z.number().int().nonnegative(), candidate: ArtifactRef, sessionTrace: z.string() }),
  z.object({ ...base, type: z.literal("episode.invalid"), episode: z.number().int().nonnegative(), reason: z.string(), repaired: z.boolean() }),
  z.object({
    ...base,
    type: z.literal("mutation.no-yield-bound"),
    episode: z.number().int().nonnegative(),
    sandboxId: z.string().min(1),
    limitTokens: z.number().int().positive(),
    modelCalls: z.number().int().positive(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    consumedTokens: z.number().int().positive(),
  }),
  z.object({
    ...base,
    type: z.literal("mutation.usage-anomaly"),
    episode: z.number().int().nonnegative(),
    sandboxId: z.string().min(1),
    zeroUsageTurns: z.number().int().nonnegative(),
    normalizedUsageTurns: z.number().int().nonnegative(),
  }),
  z.object({ ...base, type: z.literal("episode.completed"), episode: z.number().int().nonnegative() }),
  z.object({
    ...base,
    type: z.literal("evaluator.queue.entered"),
    allocationId: z.string().regex(/^[0-9a-f]{32}$/),
  }),
  z.object({
    ...base,
    type: z.literal("evaluator.queue.acquired"),
    allocationId: z.string().regex(/^[0-9a-f]{32}$/),
    waitMs: z.number().int().nonnegative(),
  }),
  z.object({ ...base, type: z.literal("evaluator.isolation"), isolation: EvaluatorIsolationRecord }),
  z.object({ ...base, type: z.literal("eval.completed"), episode: z.number().int().nonnegative().optional(), artifact: ArtifactRef, assetGroupId: z.string(), seed: z.number().int(), aggregate: z.number(), cached: z.boolean() }),
  z.object({
    ...base,
    type: z.literal("probe.completed"),
    /** Verdict of the promotion probe: candidate approved against baseline. */
    approved: z.boolean(),
    /** Trusted-measured baseline at the same coordinate. Never builder-supplied. */
    baseline: z.object({ artifact: ArtifactRef, aggregate: z.number().finite() }),
    /** Null when the probe never produced a measurable candidate. */
    candidate: z
      .object({ artifact: ArtifactRef, aggregate: z.number().finite(), delta: z.number().finite() })
      .nullable(),
    /** Eval coordinate the probe was measured at. */
    assetGroupId: z.string().min(1),
    seed: z.number().int(),
    budget: BudgetState,
  }),
  z.object({ ...base, type: z.literal("gate.paired"), episode: z.number().int().nonnegative(), parentScore: z.number(), childScore: z.number(), passed: z.boolean() }),
  z.object({ ...base, type: z.literal("incumbent.new"), artifact: ArtifactRef, aggregate: z.number(), deltaVsBaseline: z.number(), episode: z.number().int().nonnegative() }),
  z.object({ ...base, type: z.literal("budget.snapshot"), budget: BudgetState }),
  z.object({ ...base, type: z.literal("budget.exhausted"), dimension: z.string() }),
  z.object({ ...base, type: z.literal("holdout.accessed"), capsuleId: z.string(), ledgerCount: z.number().int().positive(), ledgerBudget: z.number().int().positive() }),
  z.object({ ...base, type: z.literal("corpus.query"), request: QueryCorpusParams }),
  z.object({ ...base, type: z.literal("corpus.response"), response: QueryCorpusResult }),
  z.object({ ...base, type: z.literal("delivery.applied"), mode: z.enum(["none", "branch", "pr", "auto"]), ref: z.string().optional() }),
  z.object({
    ...base,
    type: z.literal("run.finished"),
    best: ArtifactRef.optional(),
    status: z.enum(["completed", "stopped", "failed", "budget"]),
    /** Optional only for replay compatibility with version-0 run logs. */
    reason: z.union([RunStopReason, RunFailureReason]).optional(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
