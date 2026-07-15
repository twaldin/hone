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

/**
 * Strict relative tolerance for recomputed-vs-recorded numeric cross-checks.
 * The ordering tool computes its aggregates in IEEE-754 doubles and canonical
 * JSON round-trips them exactly, so an honest report recomputes bit-identical;
 * the tolerance only absorbs benign re-association of the same arithmetic.
 */
const SPREAD_MATCH_TOLERANCE = 1e-9;

function closeEnough(recomputed: number, recorded: number): boolean {
  return (
    Number.isFinite(recomputed) &&
    Math.abs(recomputed - recorded) <= SPREAD_MATCH_TOLERANCE * Math.max(1, Math.abs(recorded))
  );
}

/**
 * Authoritative pure validation of the SEMANTIC invariants a
 * DiagnosticOrderingReport claims to prove — recomputed from the recorded
 * aggregates, never trusted from `failures: []` or the recorded booleans
 * alone. Returns human-readable labels of every violated invariant; empty
 * means the report is internally consistent with the ordering tool's
 * contract (capsules/tools/ordering-check.ts):
 *
 *  1. discrimination — broken < naive < baseline < improved on the combined
 *     train+validation aggregate;
 *  2. split integrity — the shortcut (train-memorizing cheat) beats the
 *     baseline on train but loses to it on validation;
 *  3. constraint gates — baseline and improved pass the trusted suite on
 *     BOTH splits;
 *  4. stability — >=3 repeated-baseline aggregates whose first entry is the
 *     baseline's own combined aggregate, whose recomputed relative spread
 *     ((max-min)/mean) matches the recorded spread within strict tolerance,
 *     and whose spread lies strictly under the allowed band (the tool
 *     asserts `spread < band`, so a failures-free report AT the band is a
 *     forgery);
 *  5. bookkeeping — zero recorded failures and every aggregate finite (the
 *     schema already enforces finiteness; re-checked so callers holding a
 *     hand-built object fail closed too).
 *
 * Schema parsing already guarantees shape: exactly the five required
 * variants, >=3 stability aggregates, no unknown keys.
 */
export function validateDiagnosticOrdering(report: DiagnosticOrderingReport): string[] {
  const violations: string[] = [];
  const check = (label: string, ok: boolean): void => {
    if (!ok) violations.push(label);
  };

  const v = report.variants;

  // 5a. Finiteness, re-checked without trusting the parse path.
  for (const [name, s] of Object.entries(v)) {
    for (const field of ["train", "validation", "combined"] as const) {
      check(`${name}.${field} is not a finite number`, Number.isFinite(s[field]));
    }
  }
  for (const [i, agg] of report.stability.aggregates.entries()) {
    check(`stability.aggregates[${i}] is not a finite number`, Number.isFinite(agg));
  }
  check("stability.spread is not a finite number", Number.isFinite(report.stability.spread));
  check("stability.band is not a finite number", Number.isFinite(report.stability.band));

  // 1. Discrimination ordering on the combined aggregate.
  check(
    `broken(${v.broken.combined}) < naive(${v.naive.combined}) violated`,
    v.broken.combined < v.naive.combined,
  );
  check(
    `naive(${v.naive.combined}) < baseline(${v.baseline.combined}) violated`,
    v.naive.combined < v.baseline.combined,
  );
  check(
    `baseline(${v.baseline.combined}) < improved(${v.improved.combined}) violated`,
    v.baseline.combined < v.improved.combined,
  );

  // 2. Split integrity: train advantage that fails to transfer to validation.
  check(
    `shortcut must beat baseline on train (${v.shortcut.train} > ${v.baseline.train}) violated`,
    v.shortcut.train > v.baseline.train,
  );
  check(
    `shortcut must NOT beat baseline on validation (${v.shortcut.validation} < ${v.baseline.validation}) violated`,
    v.shortcut.validation < v.baseline.validation,
  );

  // 3. Constraint gates for the correct candidates, on both splits.
  for (const name of ["baseline", "improved"] as const) {
    check(`${name} trainTestsPass must be true`, v[name].trainTestsPass === true);
    check(`${name} validationTestsPass must be true`, v[name].validationTestsPass === true);
  }

  // 4. Stability, recomputed from the recorded aggregates.
  const aggs = report.stability.aggregates;
  check(`stability requires >=3 aggregates, got ${aggs.length}`, aggs.length >= 3);
  check(
    `stability.aggregates[0] (${aggs[0]}) must equal baseline.combined (${v.baseline.combined})`,
    aggs[0] === v.baseline.combined,
  );
  if (aggs.length > 0) {
    const mean = aggs.reduce((a, b) => a + b, 0) / aggs.length;
    const recomputed = (Math.max(...aggs) - Math.min(...aggs)) / mean;
    check(
      `recorded spread ${report.stability.spread} does not recompute from aggregates (got ${recomputed})`,
      closeEnough(recomputed, report.stability.spread),
    );
  }
  check(
    `stability spread ${report.stability.spread} must lie strictly under band ${report.stability.band}`,
    report.stability.spread < report.stability.band,
  );

  // 5b. A report that recorded failures proves nothing.
  check(
    `report records ${report.failures.length} failure(s): ${report.failures.join("; ")}`,
    report.failures.length === 0,
  );

  return violations;
}
