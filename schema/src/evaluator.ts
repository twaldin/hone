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

/** Lossless, JSON-safe big-endian IEEE754 evidence for finite evaluator scores. */
const FiniteScoreBits = z.string().refine((value) => {
  // Refine may run after a dirty string check: never decode malformed bytes.
  if (value.length !== 16 || !/^[0-9a-f]{16}$/.test(value)) return false;
  return Number.isFinite(Buffer.from(value, "hex").readDoubleBE());
}, "score bits must encode a finite double as 16 lowercase hexadecimal digits");

export const EvaluatorScoreBits = z.object({
  aggregateBits: FiniteScoreBits,
  perExampleBits: z.record(z.string().min(1), FiniteScoreBits).optional(),
}).strict();
export type EvaluatorScoreBits = z.infer<typeof EvaluatorScoreBits>;

export function encodeFiniteScoreBits(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("score bits require a finite number");
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value);
  return bytes.toString("hex");
}

/** Host real-uid pool reserved for collision-free evaluator invocations. */
export const RESERVED_EVALUATOR_UID_MIN = 20_000;
export const RESERVED_EVALUATOR_UID_MAX = 20_031;

/**
 * Host identity/isolation selected for one real (uncached) evaluator
 * invocation. This is trusted provenance, not evaluator-authored output.
 */
export const EvaluatorIsolationRecord = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("reserved-uid"),
    allocationId: z.string().regex(/^[0-9a-f]{32}$/),
    workerUid: z.number().int().min(RESERVED_EVALUATOR_UID_MIN).max(RESERVED_EVALUATOR_UID_MAX),
    waitMs: z.number().int().nonnegative(),
  }),
  z.object({
    mode: z.literal("shared-uid-lease"),
    allocationId: z.string().regex(/^[0-9a-f]{32}$/),
    workerUid: z.literal(2000),
    waitMs: z.number().int().nonnegative(),
  }),
]);
export type EvaluatorIsolationRecord = z.infer<typeof EvaluatorIsolationRecord>;
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
  /** Host isolation chosen for uncached execution; absent only on legacy/cached records. */
  isolation: EvaluatorIsolationRecord.optional(),
  output: EvaluatorOutput,
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  /** True when served from the trusted memo cache; the runtime key also binds the full run, evaluator, optimizer, and measurement-epoch identity. */
  cached: z.boolean(),
  evaluatedAt: z.string().datetime(),
});
export type EvaluationRecord = z.infer<typeof EvaluationRecord>;
