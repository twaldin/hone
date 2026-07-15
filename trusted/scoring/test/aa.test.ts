import { describe, expect, it } from "vitest";
import { aaFalsePromotionRate, PromotionGate } from "../src/index.js";

/** Deterministic mulberry32 PRNG + Box-Muller normal — test-owned, seeded. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng: () => number): () => number {
  return () => {
    const u = Math.max(rng(), Number.MIN_VALUE);
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

const rule = { minDeltaOverSe: 2, minSignConsistency: 0.8, replicates: 3, requireNegativeControls: true };

describe("A-A null harness — the promotion rule must not promote noise", () => {
  it("false-promotes ≤ 10% over 200 synthetic null trials (both arms = same artifact)", () => {
    const normal = gaussian(mulberry32(1913)); // fixed seed
    const report = aaFalsePromotionRate({
      rule,
      trials: 200,
      tasks: 10,
      // ONE artifact: both pseudo-arms draw from the identical distribution.
      sample: ({ task }) => 0.5 + 0.05 * task + 0.2 * normal(),
    });
    expect(report.trials).toBe(200);
    expect(report.rate).toBe(report.promotions / report.trials);
    expect(report.rate).toBeLessThanOrEqual(0.1);
    expect(report.ruleHash).toBe(new PromotionGate(rule).ruleHash);
  });

  it("sanity: a genuine large effect is promoted nearly always (the rule is not vacuous)", () => {
    const normal = gaussian(mulberry32(7));
    const report = aaFalsePromotionRate({
      rule,
      trials: 50,
      tasks: 10,
      sample: ({ arm }) => (arm === 1 ? 0.5 : 0) + 0.05 * normal(),
    });
    expect(report.rate).toBeGreaterThan(0.9);
  });

  it("validates its inputs", () => {
    expect(() => aaFalsePromotionRate({ rule, trials: 0, tasks: 10, sample: () => 0 })).toThrow();
    expect(() => aaFalsePromotionRate({ rule, trials: 10, tasks: 0, sample: () => 0 })).toThrow();
  });
});
