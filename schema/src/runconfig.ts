import { z } from "zod";
import { BudgetEnvelope } from "./capsule.js";
import { PromotionNoiseCalibration } from "./promotion.js";
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

/** The rule a campaign gets when none is pre-registered explicitly. */
export const DEFAULT_PROMOTION_RULE: PromotionRule = {
  minDeltaOverSe: 2,
  minSignConsistency: 0.8,
  replicates: 3,
  requireNegativeControls: true,
};

/**
 * Calibrated to more than twice the largest successful-yield segment in the
 * 80-run M2 saturation corpus: 721,625 tokens. Omitted configuration keeps
 * this engine default; a sealed run or meta-campaign may only raise it.
 */
export const DEFAULT_SESSION_NO_YIELD_MAX_TOKENS = 1_500_000;
export const SessionNoYieldMaxTokens = z
  .number()
  .int()
  .safe()
  .min(DEFAULT_SESSION_NO_YIELD_MAX_TOKENS);
export type SessionNoYieldMaxTokens = z.infer<typeof SessionNoYieldMaxTokens>;

/**
 * Trusted measurement epoch: the measurement domain a score belongs to. The
 * broker stamps it on every evaluation fact, keys the evaluator memo with it,
 * refuses to replay a journal under a different epoch, and accepts a
 * promotion-noise calibration only when that calibration was measured in the
 * same epoch. The bounds are the broker's.
 */
export const MeasurementEpoch = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "measurement epoch cannot contain control characters");
export type MeasurementEpoch = z.infer<typeof MeasurementEpoch>;

/**
 * Sealed single-capsule search. The seed loop attempts up to `episodes`
 * optimizer episodes in this one run, every measurement in the sealed
 * `measurementEpoch`. `calibrations` are the promotion-noise calibrations the
 * broker gates with; an empty list means every gate refuses as uncalibrated,
 * so the run searches but no child can become incumbent.
 */
export const SearchRunConfig = z
  .object({
    episodes: z.number().int().positive().safe(),
    measurementEpoch: MeasurementEpoch,
    calibrations: z.array(PromotionNoiseCalibration),
  })
  .strict()
  .superRefine((search, ctx) => {
    const groups = new Set<string>();
    for (const [index, calibration] of search.calibrations.entries()) {
      if (calibration.measurementEpoch !== search.measurementEpoch) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["calibrations", index, "measurementEpoch"],
          message: "a sealed calibration must be measured in the run's measurement epoch",
        });
      }
      if (groups.has(calibration.assetGroupId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["calibrations", index, "assetGroupId"],
          message: `duplicate calibration for asset group ${calibration.assetGroupId}`,
        });
      }
      groups.add(calibration.assetGroupId);
    }
  });
export type SearchRunConfig = z.infer<typeof SearchRunConfig>;

/**
 * Sealed information-free noise run: the trusted backend evaluates only the
 * frozen baseline, once per seed on `assetGroupId`, in `measurementEpoch`.
 * No optimizer starts and no model is called. `hone promotion-noise` derives
 * a promotion-noise calibration from several such runs.
 */
export const NoiseCalibrationRunConfig = z
  .object({
    measurementEpoch: MeasurementEpoch,
    assetGroupId: z.string().min(1),
    seeds: z
      .array(z.number().int().nonnegative().safe())
      .min(1)
      .refine((seeds) => new Set(seeds).size === seeds.length, "noise-calibration seeds must be distinct"),
  })
  .strict();
export type NoiseCalibrationRunConfig = z.infer<typeof NoiseCalibrationRunConfig>;

export const RunConfig = z
  .object({
    version: z.literal(RUN_CONFIG_VERSION),
    capsuleId: z.string(),
    objective: z.string().min(1),
    budget: BudgetEnvelope,
    routing: ModelRouting,
    apply: ApplyMode.default("none"),
    headless: z.boolean().default(false),
    /**
     * Runner backend sealed at run creation ("local"/"stub", or a dev-only
     * module spec). Resume reuses the stored backend; a conflicting --backend
     * flag refuses.
     */
    backend: z.string().min(1).default("local"),
    /** Improver-seat runs get the extra autonomy-ladder lock on apply:auto. */
    improverSeat: z.boolean().default(false),
    /** Deterministic base seed; episode seeds derive from it. */
    seed: z.number().int().nonnegative().default(0),
    /**
     * Optional sealed per-session no-yield ceiling. Absence retains the engine
     * default; config may raise but never weaken the default safety bound.
     */
    sessionNoYieldMaxTokens: SessionNoYieldMaxTokens.optional(),
    /**
     * Pre-registered promotion rule, frozen into the contract at campaign
     * start. The M0 seed's artifact-level incumbent stays greedy; this rule
     * governs the M1 outer champion promotion decision.
     */
    promotion: PromotionRule.default(DEFAULT_PROMOTION_RULE),
    /** Multi-episode search; absent = the M0 one-candidate probe. */
    search: SearchRunConfig.optional(),
    /** Baseline-only noise measurement for promotion calibration evidence. */
    noiseCalibration: NoiseCalibrationRunConfig.optional(),
  })
  .superRefine((config, ctx) => {
    if (config.search !== undefined && config.noiseCalibration !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["search"], message: "a run is either a search or a noise-calibration run, not both" });
    }
    if ((config.search !== undefined || config.noiseCalibration !== undefined) && config.apply !== "none") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["apply"], message: "search and noise-calibration runs support apply none only" });
    }
    for (const [index, calibration] of (config.search?.calibrations ?? []).entries()) {
      if (calibration.capsuleId !== config.capsuleId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["search", "calibrations", index, "capsuleId"],
          message: "a sealed calibration must belong to the run's capsule",
        });
      }
    }
  });
export type RunConfig = z.infer<typeof RunConfig>;
