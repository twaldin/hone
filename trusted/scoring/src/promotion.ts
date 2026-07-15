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
    this.ruleHash = `sha256:${createHash("sha256").update(canonicalJson(this.rule)).digest("hex")}`;
  }

  evaluate(stats: PairedStatsResult, negativeControls: readonly NegativeControl[]): PromotionDecision {
    const rule = this.rule;
    const reasons: string[] = [];

    if (stats.nTasks < 2 || !Number.isFinite(stats.se) || stats.se <= 0) {
      reasons.push(
        `no interval: paired SE must be finite and positive over ≥ 2 tasks (nTasks=${stats.nTasks}, se=${stats.se})`,
      );
    } else {
      const ratio = stats.meanDelta / stats.se;
      if (ratio < rule.minDeltaOverSe) {
        reasons.push(
          `mean delta ${stats.meanDelta} is ${ratio.toFixed(3)}× its standard error ${stats.se}; rule requires ≥ ${rule.minDeltaOverSe}×`,
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
