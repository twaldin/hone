import { z } from "zod";
import { PromotionGateDecision } from "./promotion.js";

export const HOLDOUT_SPLIT_VERSION = "promotion-holdout-split-v2" as const;
export const HOLDOUT_ASSESSMENT_VERSION = "promotion-holdout-assessment-v2" as const;
export const HOLDOUT_SEED_DOMAIN = "hone-promotion-holdout-seed-v1" as const;

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CAPSULE_ID = z.string().regex(/^cap_[0-9a-f]{12}$/);

export const HoldoutSplitUnit = z.object({
  id: z.string().min(1),
  /** Materialized bank/file path relative to capsule root. */
  path: z.string().min(1),
  /** RFC-6901 pointer inside a JSON bank; empty means the whole file. */
  selector: z.string().refine((value) => value === "" || value.startsWith("/")),
  /** Hash of the selected logical unit. */
  contentHash: SHA256,
  /** Hash of the materialized container file. */
  containerHash: SHA256,
  /** Attainable maximum for this unit, derived from its evaluator contract. */
  achievableScoreMax: z.number().finite(),
}).strict();
export type HoldoutSplitUnit = z.infer<typeof HoldoutSplitUnit>;
const HoldoutSplitPartition = z.object({ assetGroupId: z.string().min(1), units: z.array(HoldoutSplitUnit).min(1) }).strict();

export const HoldoutNoiseClass = z.enum(["deterministic-zero-noise", "noisy", "uncalibrated"]);
export type HoldoutNoiseClass = z.infer<typeof HoldoutNoiseClass>;

/** Seed selection is unrepresentable: trusted code derives it from frozen pre-split identities. */
export const HoldoutSeedDerivation = z.object({
  algorithm: z.literal("sha256-campaign-capsule-v1"),
  domain: z.literal(HOLDOUT_SEED_DOMAIN),
  campaignIdentity: SHA256,
}).strict();
export type HoldoutSeedDerivation = z.infer<typeof HoldoutSeedDerivation>;
export const HoldoutDesignEligibility = z.enum(["claim-capable", "instrumentation-only"]);
export type HoldoutDesignEligibility = z.infer<typeof HoldoutDesignEligibility>;

export const PromotionHoldoutSplit = z.object({
  version: z.literal(HOLDOUT_SPLIT_VERSION),
  splitId: SHA256,
  capsuleId: CAPSULE_ID,
  capsuleDigest: SHA256,
  seedDerivation: HoldoutSeedDerivation,
  algorithm: z.enum(["sha256-rank-v2", "sealed-groups-all-units-v1"]),
  frozenAt: z.string().datetime(),
  populationDigest: SHA256,
  noiseClass: HoldoutNoiseClass,
  noiseEnvelope: z.number().finite().nonnegative().nullable(),
  evaluationRepeats: z.number().int().positive(),
  minimumDetectableEffect: z.number().finite().positive().max(1),
  claimMinimumHoldoutUnits: z.number().int().positive(),
  designEligibility: HoldoutDesignEligibility,
  achievableScoreMax: z.number().finite(),
  train: HoldoutSplitPartition,
  holdout: HoldoutSplitPartition,
}).strict().superRefine((split, ctx) => {
  if (split.train.assetGroupId === split.holdout.assetGroupId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "train and holdout asset groups must differ" });
  const units = [...split.train.units, ...split.holdout.units];
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const unit of units) {
    const identity = `${unit.path}\u0000${unit.selector}`;
    if (ids.has(unit.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate split unit id ${unit.id}` });
    if (identities.has(identity)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate split unit location ${unit.path}#${unit.selector}` });
    ids.add(unit.id);
    identities.add(identity);
  }
  const derivedAchievableMax = split.holdout.units.reduce((sum, unit) => sum + unit.achievableScoreMax, 0)
    / split.holdout.units.length;
  if (Math.abs(split.achievableScoreMax - derivedAchievableMax) > Number.EPSILON * Math.max(1, Math.abs(derivedAchievableMax)) * 8) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "achievableScoreMax must equal the mean of holdout unit maxima" });
  }
  const requiredUnits = Math.ceil(1 / split.minimumDetectableEffect);
  if (split.claimMinimumHoldoutUnits !== requiredUnits) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "claimMinimumHoldoutUnits must equal ceil(1 / minimumDetectableEffect)" });
  const expectedEligibility = split.holdout.units.length >= requiredUnits ? "claim-capable" : "instrumentation-only";
  if (split.designEligibility !== expectedEligibility) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `designEligibility must be ${expectedEligibility}` });
  if (split.noiseClass === "deterministic-zero-noise") {
    if (split.noiseEnvelope !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deterministic split requires a literal zero noise envelope" });
    if (split.evaluationRepeats !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deterministic split requires exactly one promotion measurement" });
    if (split.holdout.units.length < 2) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deterministic instrumentation requires at least two holdout units" });
  } else {
    if (split.noiseClass === "noisy" && !(split.noiseEnvelope !== null && split.noiseEnvelope > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noisy split requires a positive measured noise envelope" });
    if (split.noiseClass === "uncalibrated" && split.noiseEnvelope !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "uncalibrated split must not claim a noise envelope" });
    if (split.evaluationRepeats < 3) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noisy or uncalibrated split requires at least three promotion measurements" });
    if (split.holdout.units.length < 8) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noisy or uncalibrated split requires at least eight holdout units" });
  }
});
export type PromotionHoldoutSplit = z.infer<typeof PromotionHoldoutSplit>;

/** Redacted run-event identity; unit ids, paths and hashes remain in trusted split authority only. */
export const PromotionHoldoutSplitSummary = z.object({
  version: z.literal(HOLDOUT_SPLIT_VERSION), splitId: SHA256, capsuleId: CAPSULE_ID, capsuleDigest: SHA256,
  seedDerivation: HoldoutSeedDerivation, algorithm: z.enum(["sha256-rank-v2", "sealed-groups-all-units-v1"]), frozenAt: z.string().datetime(),
  populationDigest: SHA256, noiseClass: HoldoutNoiseClass, evaluationRepeats: z.number().int().positive(),
  minimumDetectableEffect: z.number().finite().positive(), claimMinimumHoldoutUnits: z.number().int().positive(),
  designEligibility: HoldoutDesignEligibility, trainAssetGroupId: z.string().min(1), holdoutAssetGroupId: z.string().min(1),
  trainUnits: z.number().int().positive(), holdoutUnits: z.number().int().positive(),
}).strict();
export type PromotionHoldoutSplitSummary = z.infer<typeof PromotionHoldoutSplitSummary>;

export const HoldoutNullControlRecord = z.object({
  controlId: SHA256, splitId: SHA256, artifactHash: SHA256, assetGroupId: z.string().min(1),
  seeds: z.array(z.number().int().nonnegative()).min(2), scores: z.array(z.number().finite()).min(2),
  estimator: z.literal("sample-sd-v1"), sampleStandardDeviation: z.number().finite().nonnegative(),
  informationFree: z.literal(true), recordedAt: z.string().datetime(),
}).strict().superRefine((control, ctx) => {
  if (control.seeds.length !== control.scores.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "null-control seeds and scores must have equal length" });
  if (new Set(control.seeds).size !== control.seeds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "null-control seeds must be unique" });
  if (control.scores.length >= 2) {
    const mean = control.scores.reduce((sum, score) => sum + score, 0) / control.scores.length;
    const variance = control.scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / (control.scores.length - 1);
    const sd = Math.sqrt(variance);
    if (Math.abs(sd - control.sampleStandardDeviation) > Number.EPSILON * Math.max(1, Math.abs(sd)) * 8) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sampleStandardDeviation does not match the recorded scores" });
  }
});
export type HoldoutNullControlRecord = z.infer<typeof HoldoutNullControlRecord>;

export const HoldoutGeneralizationStatus = z.enum(["supported", "overfit", "indeterminate", "unmeasurable"]);
export type HoldoutGeneralizationStatus = z.infer<typeof HoldoutGeneralizationStatus>;
const ScorePair = z.object({ parentScore: z.number().finite(), childScore: z.number().finite(), delta: z.number().finite() }).strict();

/** Training noise and holdout generalization remain explicitly distinct. */
export const PromotionHoldoutRecord = z.object({
  version: z.literal(HOLDOUT_ASSESSMENT_VERSION), artifactHash: SHA256, parentArtifactHash: SHA256, splitId: SHA256,
  training: ScorePair.extend({ gateVersion: z.string().min(1), noiseDecision: PromotionGateDecision }).strict(),
  holdout: ScorePair.extend({
    assetGroupId: z.string().min(1), seeds: z.array(z.number().int().nonnegative()).min(1),
    parentScores: z.array(z.number().finite()).min(1), childScores: z.array(z.number().finite()).min(1),
    achievableScoreMax: z.number().finite(), headroom: z.number().finite().nonnegative(),
    minimumDetectableEffect: z.number().finite().positive(), holdoutUnits: z.number().int().positive(),
    claimMinimumHoldoutUnits: z.number().int().positive(), designEligibility: HoldoutDesignEligibility,
    noiseClass: HoldoutNoiseClass,
  }).strict(),
  generalizationGap: z.number().finite(), nullControl: HoldoutNullControlRecord,
  status: HoldoutGeneralizationStatus, claimable: z.boolean(), recordedAt: z.string().datetime(),
}).strict().superRefine((record, ctx) => {
  const close = (left: number, right: number): boolean => Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
  if (!close(record.training.delta, record.training.childScore - record.training.parentScore)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "training delta does not match its score pair" });
  if (!close(record.holdout.delta, record.holdout.childScore - record.holdout.parentScore)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "holdout delta does not match its score pair" });
  if (record.holdout.seeds.length !== record.holdout.parentScores.length || record.holdout.seeds.length !== record.holdout.childScores.length || new Set(record.holdout.seeds).size !== record.holdout.seeds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "holdout seeds and score arrays must have equal unique coordinates" });
  } else {
    const parentMean = record.holdout.parentScores.reduce((sum, score) => sum + score, 0) / record.holdout.parentScores.length;
    const childMean = record.holdout.childScores.reduce((sum, score) => sum + score, 0) / record.holdout.childScores.length;
    if (!close(record.holdout.parentScore, parentMean) || !close(record.holdout.childScore, childMean)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "holdout score pair must equal the repeated-score means" });
  }
  if (!close(record.holdout.headroom, record.holdout.achievableScoreMax - record.holdout.parentScore)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "holdout headroom must equal achievable maximum - parent score" });
  if (!close(record.generalizationGap, record.training.delta - record.holdout.delta)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "generalizationGap must equal training.delta - holdout.delta" });
  if (record.nullControl.splitId !== record.splitId || record.nullControl.assetGroupId !== record.holdout.assetGroupId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "null control must use the promotion split and holdout asset group" });
  const designMeasurable = record.holdout.designEligibility === "claim-capable" && record.holdout.holdoutUnits >= record.holdout.claimMinimumHoldoutUnits;
  const hasHeadroom = record.holdout.headroom >= record.training.delta;
  const deterministic = record.holdout.noiseClass === "deterministic-zero-noise" && record.nullControl.sampleStandardDeviation === 0;
  const expectedStatus: HoldoutGeneralizationStatus = !designMeasurable || !hasHeadroom
    ? "unmeasurable"
    : !deterministic || record.training.delta < record.holdout.minimumDetectableEffect
      ? "indeterminate"
      : record.holdout.delta <= 0 ? "overfit" : record.holdout.delta < record.holdout.minimumDetectableEffect ? "indeterminate" : "supported";
  if (record.status !== expectedStatus) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `status must be ${expectedStatus} for the recorded instrument` });
  if (record.claimable !== (record.training.noiseDecision === "promote" && record.status === "supported")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "claimable requires both the in-sample noise gate and measurable deterministic holdout support" });
});
export type PromotionHoldoutRecord = z.infer<typeof PromotionHoldoutRecord>;

export const RecordHoldoutNullControlParams = z.object({ splitId: SHA256, artifactHash: SHA256, assetGroupId: z.string().min(1), seeds: z.array(z.number().int().nonnegative()).min(2).max(32) }).strict();
export const RecordPromotionHoldoutParams = z.object({ splitId: SHA256, artifactHash: SHA256, assetGroupId: z.string().min(1), seeds: z.array(z.number().int().nonnegative()).min(1).max(32), nullControlId: SHA256 }).strict();
