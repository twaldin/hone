import { z } from "zod";
import { ArtifactRef, BudgetState } from "./broker.js";

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

export const RunEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run.started"), capsuleId: z.string(), contractHash: z.string(), optimizerDigest: z.string() }),
  z.object({ ...base, type: z.literal("run.resumed"), fromCursor: z.number().int().nonnegative() }),
  z.object({ ...base, type: z.literal("episode.started"), episode: z.number().int().nonnegative(), parent: ArtifactRef }),
  z.object({ ...base, type: z.literal("episode.candidate"), episode: z.number().int().nonnegative(), candidate: ArtifactRef, sessionTrace: z.string() }),
  z.object({ ...base, type: z.literal("episode.invalid"), episode: z.number().int().nonnegative(), reason: z.string(), repaired: z.boolean() }),
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
  z.object({ ...base, type: z.literal("delivery.applied"), mode: z.enum(["none", "branch", "pr", "auto"]), ref: z.string().optional() }),
  z.object({ ...base, type: z.literal("run.finished"), best: ArtifactRef.optional(), status: z.enum(["completed", "stopped", "failed", "budget"]) }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
