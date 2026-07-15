import { createHash } from "node:crypto";
import { PromotionRule } from "@hone/schema";
import type { z } from "zod";
import type { PairedStatsResult } from "./paired.js";

/**
 * Pre-registered promotion rule (review IV.2 / C2): frozen and hashed at
 * construction, consumes intervals — never point scores — and requires
 * negative controls ranked below the champion. Trusted code: the optimizer
 * cannot route around this gate.
 */

/**
 * Promotion gate implementation VERSION — hashed together with the rule.
 *
 * v1 compared meanDelta/SE against `rule.minDeltaOverSe` as a fixed z-style
 * threshold. The required real M0 A-A null (run m0-noise-mrm7x4dw-09b0a9,
 * git 25a03e6) failed it honestly: 70/1000 = 7% false promotions at
 * nTasks=2, because the paired SE has nTasks−1 degrees of freedom and the
 * null ratio is t(1)-like (Cauchy-tailed) — 2×SE has nowhere near 95%
 * coverage there.
 *
 * v2 adds finite-sample interval control: the effective threshold is
 * max(rule.minDeltaOverSe, t₀.₉₇₅ at df = nTasks−1). The schema field is a
 * LOWER BOUND on the required evidence; a finite task count may demand a
 * strictly stricter threshold. For large nTasks the t critical value decays
 * to 1.96, so the gate converges to the original pre-registered 2×SE rule.
 */
export const PROMOTION_GATE_VERSION = 2;

/**
 * Two-sided 95% Student-t critical values (t₀.₉₇₅) for df 1..30 — reviewed
 * deterministic table, no dependency. Index df−1.
 */
const T95_TWO_SIDED: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** Normal asymptote beyond the tabulated range (t₀.₉₇₅ → z₀.₉₇₅). */
const T95_ASYMPTOTE = 1.96;

/** Two-sided 95% Student-t critical value at `df` degrees of freedom. */
export function criticalT95(df: number): number {
  if (!Number.isInteger(df) || df < 1) throw new Error(`criticalT95: df must be an integer ≥ 1, got ${df}`);
  return df <= T95_TWO_SIDED.length ? T95_TWO_SIDED[df - 1]! : T95_ASYMPTOTE;
}

/** Rule as authored (zod input — defaults may be omitted). */
export type PromotionRuleInput = z.input<typeof PromotionRule>;

/** A negative control (broken/degraded candidate) paired against the champion. */
export interface NegativeControl {
  id: string;
  /** Paired mean delta of control vs champion; must be < 0 (ranked below). */
  meanDelta: number;
}

export interface PromotionDecision {
  promote: boolean;
  /** Failed criteria, human-readable. Empty ⇔ promote. */
  reasons: string[];
  /** Hash of the frozen rule — logged so the decision is auditable. */
  ruleHash: string;
}

/** Deterministic JSON with recursively sorted keys — the hash input. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export class PromotionGate {
  readonly rule: Readonly<PromotionRule>;
  readonly ruleHash: string;

  constructor(rule: PromotionRuleInput) {
    this.rule = Object.freeze(PromotionRule.parse(rule));
    // The hash binds the COMPLETE gate semantics — {version, rule} — so a v1
    // fixed-z decision and a v2 finite-t decision over identical rule fields
    // can never share a hash; the revision stays auditable in every log.
    this.ruleHash = `sha256:${createHash("sha256")
      .update(canonicalJson({ version: PROMOTION_GATE_VERSION, rule: this.rule }))
      .digest("hex")}`;
  }

  evaluate(stats: PairedStatsResult, negativeControls: readonly NegativeControl[]): PromotionDecision {
    const rule = this.rule;
    const reasons: string[] = [];

    if (stats.nTasks < 2 || !Number.isFinite(stats.se) || stats.se <= 0) {
      reasons.push(
        `no interval: paired SE must be finite and positive over ≥ 2 tasks (nTasks=${stats.nTasks}, se=${stats.se})`,
      );
    } else {
      // Finite-sample interval control (v2): rule.minDeltaOverSe is a lower
      // bound; with few tasks the t critical value at df = nTasks−1 is
      // stricter and governs. This closes the t(1) heavy-tail path that
      // false-promoted 7% of A-A nulls at nTasks=2.
      const df = stats.nTasks - 1;
      const tCrit = criticalT95(df);
      const effectiveMin = Math.max(rule.minDeltaOverSe, tCrit);
      const ratio = stats.meanDelta / stats.se;
      if (ratio < effectiveMin) {
        reasons.push(
          `mean delta ${stats.meanDelta} is ${ratio.toFixed(3)}× its standard error ${stats.se}; ` +
            `effective threshold is ${effectiveMin}× = max(rule minDeltaOverSe ${rule.minDeltaOverSe} — a lower bound — ` +
            `and two-sided 95% t critical value ${tCrit} at df=${df})`,
        );
      }
    }

    if (stats.signConsistency < rule.minSignConsistency) {
      reasons.push(
        `sign consistency ${stats.signConsistency} below the pre-registered minimum ${rule.minSignConsistency}`,
      );
    }

    if (stats.minReplicates < rule.replicates) {
      reasons.push(`replicates per arm per task ${stats.minReplicates} below the pre-registered ${rule.replicates}`);
    }

    if (rule.requireNegativeControls) {
      if (negativeControls.length === 0) {
        reasons.push("rule requires negative controls, none supplied");
      }
      for (const control of negativeControls) {
        if (!(control.meanDelta < 0)) {
          reasons.push(
            `negative control "${control.id}" is not ranked below the champion (meanDelta=${control.meanDelta}) — the gate cannot discriminate`,
          );
        }
      }
    }

    return { promote: reasons.length === 0, reasons, ruleHash: this.ruleHash };
  }
}

/** One-shot convenience over `new PromotionGate(rule).evaluate(...)`. */
export function evaluatePromotion(
  rule: PromotionRuleInput,
  stats: PairedStatsResult,
  negativeControls: readonly NegativeControl[],
): PromotionDecision {
  return new PromotionGate(rule).evaluate(stats, negativeControls);
}
