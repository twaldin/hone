import { z } from "zod";

/**
 * Evaluator output — RFC §7.3 shape PLUS unbounded per-example feedback blobs
 * (review amendment C9: the trusted runner passes feedback through untouched;
 * rich textual feedback is what the reflective mutation loop eats).
 */

export const PerExampleResult = z.object({
  score: z.number(),
  /** Unbounded free-form feedback (text or JSON). Trusted runtime never parses it. */
  feedback: z.unknown().optional(),
});
export type PerExampleResult = z.infer<typeof PerExampleResult>;

export const EvaluatorOutput = z.object({
  valid: z.boolean(),
  objectives: z.record(z.number()),
  constraints: z.record(z.boolean()).default({}),
  perExample: z.record(PerExampleResult).default({}),
  diagnostics: z
    .object({ summary: z.string().optional() })
    .passthrough()
    .optional(),
});
export type EvaluatorOutput = z.infer<typeof EvaluatorOutput>;

/**
 * Trusted-side evaluation record: evaluator output + measurement metadata.
 * Baselines are ALWAYS measured by the trusted runner (anti-sandbagging),
 * never taken from capsule/builder metadata.
 */
export const EvaluationRecord = z.object({
  capsuleId: z.string(),
  artifactHash: z.string(),
  assetGroupId: z.string(),
  /** Deterministic seed used for fixture sampling, memoization key component. */
  seed: z.number().int().nonnegative(),
  output: EvaluatorOutput,
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  /** True when served from the trusted memo cache; the runtime key also binds the full run, evaluator, optimizer, and measurement-epoch identity. */
  cached: z.boolean(),
  evaluatedAt: z.string().datetime(),
});
export type EvaluationRecord = z.infer<typeof EvaluationRecord>;
