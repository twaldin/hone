import { z } from "zod";

/**
 * Persisted diagnostic-ordering report — the compact, schema-validated
 * summary of a capsule's ordering check (broken < naive < baseline <
 * improved, split integrity, baseline stability). The capsule manifest pins
 * this file by path+hash (`diagnosticOrdering`), making the evidence that the
 * evaluator discriminates part of the capsule's content address.
 *
 * Strict everywhere: unknown keys are tampering, non-finite aggregates are
 * measurement bugs.
 */

export const DIAGNOSTIC_ORDERING_REPORT_VERSION = 1;

const aggregate = z.number().finite();

/** Per-variant aggregates plus trusted-suite pass flags for each split. */
export const OrderingVariantSummary = z
  .object({
    train: aggregate,
    validation: aggregate,
    combined: aggregate,
    trainTestsPass: z.boolean(),
    validationTestsPass: z.boolean(),
  })
  .strict();
export type OrderingVariantSummary = z.infer<typeof OrderingVariantSummary>;

export const DiagnosticOrderingReport = z
  .object({
    version: z.literal(DIAGNOSTIC_ORDERING_REPORT_VERSION),
    variants: z
      .object({
        baseline: OrderingVariantSummary,
        broken: OrderingVariantSummary,
        naive: OrderingVariantSummary,
        shortcut: OrderingVariantSummary,
        improved: OrderingVariantSummary,
      })
      .strict(),
    /** Repeated-baseline stability evidence: >=3 aggregates, relative spread, allowed band. */
    stability: z
      .object({
        aggregates: z.array(aggregate).min(3),
        spread: z.number().finite().nonnegative(),
        band: z.number().finite().positive(),
      })
      .strict(),
    /** Human-readable labels of every violated invariant; empty = ordering holds. */
    failures: z.array(z.string()),
  })
  .strict();
export type DiagnosticOrderingReport = z.infer<typeof DiagnosticOrderingReport>;
