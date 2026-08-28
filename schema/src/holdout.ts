import { z } from "zod";
import { PromotionGateDecision } from "./promotion.js";

export const HOLDOUT_SPLIT_VERSION = "promotion-holdout-split-v1" as const;
export const HOLDOUT_ASSESSMENT_VERSION = "promotion-holdout-assessment-v1" as const;

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CAPSULE_ID = z.string().regex(/^cap_[0-9a-f]{12}$/);

/**
 * One independently materialized evaluation unit. `path` is capsule-root
 * relative and must be covered by the named asset group in the frozen
 * capsule manifest. Binding the bytes prevents a split from being silently
 * redrawn while retaining its identity.
 */
export const HoldoutSplitUnit = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  contentHash: SHA256,
}).strict();
export type HoldoutSplitUnit = z.infer<typeof HoldoutSplitUnit>;

const HoldoutSplitPartition = z.object({
  assetGroupId: z.string().min(1),
  units: z.array(HoldoutSplitUnit).min(1),
}).strict();

export const HoldoutNoiseClass = z.enum([
  "deterministic-zero-noise",
  "noisy",
  "uncalibrated",
]);
export type HoldoutNoiseClass = z.infer<typeof HoldoutNoiseClass>;

/**
 * Frozen, content-bound assignment produced by sha256-rank-v1. The mutable
 * optimizer receives neither this record nor the holdout asset group. A
 * trusted broker validates the record against the capsule manifest before
 * opening any optimizer capability.
 */
export const PromotionHoldoutSplit = z.object({
  version: z.literal(HOLDOUT_SPLIT_VERSION),
  splitId: SHA256,
  capsuleId: CAPSULE_ID,
  capsuleDigest: SHA256,
  seed: z.string().min(16),
  algorithm: z.literal("sha256-rank-v1"),
  frozenAt: z.string().datetime(),
  populationDigest: SHA256,
  noiseClass: HoldoutNoiseClass,
  /** Null means no information-free calibration exists; claims then fail closed. */
  noiseEnvelope: z.number().finite().nonnegative().nullable(),
  /** Repeated full-split measurements required for each artifact. */
  evaluationRepeats: z.number().int().positive(),
  train: HoldoutSplitPartition,
  holdout: HoldoutSplitPartition,
}).strict().superRefine((split, ctx) => {
  if (split.train.assetGroupId === split.holdout.assetGroupId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "train and holdout asset groups must differ" });
  }
  const units = [...split.train.units, ...split.holdout.units];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate split unit id ${unit.id}` });
    if (paths.has(unit.path)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate split unit path ${unit.path}` });
    ids.add(unit.id);
    paths.add(unit.path);
  }
  if (split.noiseClass === "deterministic-zero-noise") {
    if (split.noiseEnvelope !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deterministic split requires a literal zero noise envelope" });
    }
    if (split.evaluationRepeats !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deterministic split requires exactly one promotion measurement" });
    }
    if (split.holdout.units.length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deterministic split requires at least two holdout units" });
    }
  } else {
    if (split.noiseClass === "noisy" && !(split.noiseEnvelope !== null && split.noiseEnvelope > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noisy split requires a positive measured noise envelope" });
    }
    if (split.noiseClass === "uncalibrated" && split.noiseEnvelope !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "uncalibrated split must not claim a noise envelope" });
    }
    if (split.evaluationRepeats < 3) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noisy or uncalibrated split requires at least three promotion measurements" });
    }
    if (split.holdout.units.length < 8) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "noisy or uncalibrated split requires at least eight holdout units" });
    }
  }
});
export type PromotionHoldoutSplit = z.infer<typeof PromotionHoldoutSplit>;

export const HoldoutNullControlRecord = z.object({
  controlId: SHA256,
  splitId: SHA256,
  artifactHash: SHA256,
  assetGroupId: z.string().min(1),
  seeds: z.array(z.number().int().nonnegative()).min(2),
  scores: z.array(z.number().finite()).min(2),
  observedSpan: z.number().finite().nonnegative(),
  informationFree: z.literal(true),
  recordedAt: z.string().datetime(),
}).strict().superRefine((control, ctx) => {
  if (control.seeds.length !== control.scores.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "null-control seeds and scores must have equal length" });
  }
  if (new Set(control.seeds).size !== control.seeds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "null-control seeds must be unique" });
  }
  const span = Math.max(...control.scores) - Math.min(...control.scores);
  if (Math.abs(span - control.observedSpan) > Number.EPSILON * Math.max(1, Math.abs(span)) * 8) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "null-control observedSpan must equal max(scores) - min(scores)" });
  }
});
export type HoldoutNullControlRecord = z.infer<typeof HoldoutNullControlRecord>;

export const HoldoutGeneralizationStatus = z.enum([
  "supported",
  "overfit",
  "indeterminate",
]);
export type HoldoutGeneralizationStatus = z.infer<typeof HoldoutGeneralizationStatus>;

const ScorePair = z.object({
  parentScore: z.number().finite(),
  childScore: z.number().finite(),
  delta: z.number().finite(),
}).strict();

/**
 * Trusted terminal assessment. Training noise and holdout generalization are
 * deliberately separate: a noise-clearing in-sample promotion may still be
 * recorded as overfit on the frozen holdout.
 */
export const PromotionHoldoutRecord = z.object({
  version: z.literal(HOLDOUT_ASSESSMENT_VERSION),
  artifactHash: SHA256,
  parentArtifactHash: SHA256,
  splitId: SHA256,
  training: ScorePair.extend({
    gateVersion: z.string().min(1),
    noiseDecision: PromotionGateDecision,
  }).strict(),
  holdout: ScorePair.extend({
    assetGroupId: z.string().min(1),
    seeds: z.array(z.number().int().nonnegative()).min(1),
    parentScores: z.array(z.number().finite()).min(1),
    childScores: z.array(z.number().finite()).min(1),
  }).strict(),
  /** training.delta - holdout.delta; positive values are a holdout drop. */
  generalizationGap: z.number().finite(),
  nullControl: HoldoutNullControlRecord,
  status: HoldoutGeneralizationStatus,
  claimable: z.boolean(),
  recordedAt: z.string().datetime(),
}).strict().superRefine((record, ctx) => {
  const close = (left: number, right: number): boolean =>
    Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
  if (!close(record.training.delta, record.training.childScore - record.training.parentScore)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "training delta does not match its score pair" });
  }
  if (!close(record.holdout.delta, record.holdout.childScore - record.holdout.parentScore)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "holdout delta does not match its score pair" });
  }
  if (
    record.holdout.seeds.length !== record.holdout.parentScores.length
    || record.holdout.seeds.length !== record.holdout.childScores.length
    || new Set(record.holdout.seeds).size !== record.holdout.seeds.length
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "holdout seeds and score arrays must have equal unique coordinates" });
  } else {
    const parentMean = record.holdout.parentScores.reduce((sum, score) => sum + score, 0)
      / record.holdout.parentScores.length;
    const childMean = record.holdout.childScores.reduce((sum, score) => sum + score, 0)
      / record.holdout.childScores.length;
    if (!close(record.holdout.parentScore, parentMean) || !close(record.holdout.childScore, childMean)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "holdout score pair must equal the repeated-score means" });
    }
  }
  if (!close(record.generalizationGap, record.training.delta - record.holdout.delta)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "generalizationGap must equal training.delta - holdout.delta" });
  }
  if (record.nullControl.splitId !== record.splitId || record.nullControl.assetGroupId !== record.holdout.assetGroupId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "null control must use the promotion split and holdout asset group" });
  }
  const expectedStatus: HoldoutGeneralizationStatus = record.holdout.delta <= 0
    ? "overfit"
    : record.holdout.delta > record.nullControl.observedSpan
      ? "supported"
      : "indeterminate";
  if (record.status !== expectedStatus) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `status must be ${expectedStatus} for the recorded scores` });
  }
  if (record.claimable !== (record.training.noiseDecision === "promote" && record.status === "supported")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "claimable requires both the in-sample noise gate and holdout support" });
  }
});
export type PromotionHoldoutRecord = z.infer<typeof PromotionHoldoutRecord>;

export const RecordHoldoutNullControlParams = z.object({
  splitId: SHA256,
  artifactHash: SHA256,
  assetGroupId: z.string().min(1),
  seeds: z.array(z.number().int().nonnegative()).min(2).max(32),
}).strict();

export const RecordPromotionHoldoutParams = z.object({
  splitId: SHA256,
  artifactHash: SHA256,
  assetGroupId: z.string().min(1),
  seeds: z.array(z.number().int().nonnegative()).min(1).max(32),
  nullControlId: SHA256,
}).strict();
