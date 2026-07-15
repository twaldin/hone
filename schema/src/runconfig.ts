import { z } from "zod";
import { BudgetEnvelope } from "./capsule.js";
import { ModelRouting } from "./proxy.js";

/**
 * Contract 5 — Run config / contract.
 *
 * The contract is rendered to .hone/contract.md for approval and hashed into
 * run.started. Delivery policy is per-run and immutable once started; the
 * ladder (review IV.2) gates when `auto` is eligible on improver-seat runs.
 */

export const RUN_CONFIG_VERSION = 1;

export const ApplyMode = z.enum(["none", "branch", "pr", "auto"]);
export type ApplyMode = z.infer<typeof ApplyMode>;

export const RunConfig = z.object({
  version: z.literal(RUN_CONFIG_VERSION),
  capsuleId: z.string(),
  objective: z.string().min(1),
  budget: BudgetEnvelope,
  routing: ModelRouting,
  apply: ApplyMode.default("none"),
  headless: z.boolean().default(false),
  /** Improver-seat runs get the extra autonomy-ladder lock on apply:auto. */
  improverSeat: z.boolean().default(false),
  /** Deterministic base seed; episode seeds derive from it. */
  seed: z.number().int().nonnegative().default(0),
});
export type RunConfig = z.infer<typeof RunConfig>;

/** Pre-registered promotion rule — frozen at campaign start, trusted-enforced. */
export const PromotionRule = z.object({
  /** Minimum paired mean delta, in units of its own standard error. */
  minDeltaOverSe: z.number().positive(),
  /** Minimum fraction of tasks with a positive paired delta (sign consistency). */
  minSignConsistency: z.number().min(0).max(1),
  /** Replicates per arm per task. */
  replicates: z.number().int().positive(),
  /** Negative controls (broken/degraded candidates) must rank below champion. */
  requireNegativeControls: z.boolean().default(true),
});
export type PromotionRule = z.infer<typeof PromotionRule>;
