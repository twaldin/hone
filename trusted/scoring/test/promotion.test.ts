import { describe, expect, it } from "vitest";
import type { EvaluationRecord, PromotionRule } from "@hone/schema";
import {
  PROMOTION_GATE_VERSION,
  PromotionGate,
  criticalT95,
  evaluatePromotion,
  pairedStats,
  type NegativeControl,
} from "../src/index.js";

function rec(capsuleId: string, seed: number, aggregate: number): EvaluationRecord {
  return {
    capsuleId,
    artifactHash: "sha256:" + "e".repeat(64),
    assetGroupId: "train",
    seed,
    output: { valid: true, objectives: { aggregate }, constraints: {}, perExample: {} },
    costUsd: 0,
    durationMs: 1,
    cached: false,
    evaluatedAt: "2026-07-14T12:00:00.000Z",
  };
}
const pairs = (champ: number[], chall: number[], reps = 1) =>
  champ.flatMap((c, t) =>
    Array.from({ length: reps }, (_, s) => ({
      champion: rec(`cap_${String(t).padStart(12, "0")}`, s, c),
      challenger: rec(`cap_${String(t).padStart(12, "0")}`, s, chall[t]! + s * 1e-9),
    })),
  );

const rule: PromotionRule = { minDeltaOverSe: 2, minSignConsistency: 0.8, replicates: 1, requireNegativeControls: true };
const winner = pairedStats(pairs([0.5, 0.5, 0.5, 0.5, 0.5], [0.6, 0.61, 0.59, 0.62, 0.58]));
const control: NegativeControl = { id: "broken-hone", meanDelta: -0.2 };

describe("PromotionGate: rule frozen at construction", () => {
  it("hashes the rule deterministically and freezes it", () => {
    const g1 = new PromotionGate(rule);
    const g2 = new PromotionGate({ ...rule });
    expect(g1.ruleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(g1.ruleHash).toBe(g2.ruleHash);
    expect(new PromotionGate({ ...rule, minDeltaOverSe: 3 }).ruleHash).not.toBe(g1.ruleHash);
    expect(Object.isFrozen(g1.rule)).toBe(true);
  });

  it("zod-rejects malformed rules at construction", () => {
    expect(() => new PromotionGate({ ...rule, minSignConsistency: 1.5 })).toThrow();
  });

  it("decision carries the rule hash — auditable against run.started", () => {
    const d = evaluatePromotion(rule, winner, [control]);
    expect(d.ruleHash).toBe(new PromotionGate(rule).ruleHash);
  });
});

describe("evaluatePromotion: consumes intervals, not points", () => {
  it("promotes a strong sign-consistent winner with a passing negative control", () => {
    const d = evaluatePromotion(rule, winner, [control]);
    expect(d.promote).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it("refuses when the interval is too wide (meanDelta/SE below threshold)", () => {
    // deltas [0.1, -0.08, 0.09, -0.07, 0.1]: mean positive but SE-dominated
    const noisy = pairedStats(pairs([0.5, 0.5, 0.5, 0.5, 0.5], [0.6, 0.42, 0.59, 0.43, 0.6]));
    const d = evaluatePromotion({ ...rule, minSignConsistency: 0 }, noisy, [control]);
    expect(d.promote).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/standard error/i);
  });

  it("refuses on sign inconsistency even with a huge mean", () => {
    const lopsided = pairedStats(pairs([0.5, 0.5, 0.5, 0.5, 0.5], [1.5, 0.49, 0.52, 0.48, 0.52]));
    const d = evaluatePromotion(rule, lopsided, [control]);
    expect(d.promote).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/sign consistency/i);
  });

  it("refuses a point estimate: single task has no interval", () => {
    const single = pairedStats(pairs([0.5], [0.9]));
    const d = evaluatePromotion(rule, single, [control]);
    expect(d.promote).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/interval/i);
  });

  it("refuses degenerate SE=0 — identical deltas cannot form an interval", () => {
    const degenerate = pairedStats(pairs([0.5, 0.5, 0.5], [0.6, 0.6, 0.6]));
    const d = evaluatePromotion(rule, degenerate, [control]);
    expect(d.promote).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/interval/i);
  });

  it("refuses when replication is below the pre-registered floor", () => {
    const d = evaluatePromotion({ ...rule, replicates: 3 }, winner, [control]);
    expect(d.promote).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/replicate/i);
  });

  it("requireNegativeControls: refuses with no controls, and with a control ranked at/above champion", () => {
    expect(evaluatePromotion(rule, winner, []).promote).toBe(false);
    const cheater = evaluatePromotion(rule, winner, [control, { id: "degraded-hone", meanDelta: 0.01 }]);
    expect(cheater.promote).toBe(false);
    expect(cheater.reasons.join(" ")).toMatch(/degraded-hone/);
  });

  it("requireNegativeControls=false skips the control gate", () => {
    const d = evaluatePromotion({ ...rule, requireNegativeControls: false }, winner, []);
    expect(d.promote).toBe(true);
  });

  it("every failed criterion is reported, not just the first", () => {
    const noisy = pairedStats(pairs([0.5, 0.5, 0.5, 0.5], [0.6, 0.42, 0.59, 0.43]));
    const d = evaluatePromotion({ ...rule, replicates: 3 }, noisy, []);
    expect(d.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("finite-sample interval control (gate v2, post-M0 A-A null failure)", () => {
  it("criticalT95: reviewed two-sided 95% table for df 1..30, 1.96 asymptote beyond", () => {
    expect(criticalT95(1)).toBe(12.706);
    expect(criticalT95(2)).toBe(4.303);
    expect(criticalT95(3)).toBe(3.182);
    expect(criticalT95(10)).toBe(2.228);
    expect(criticalT95(30)).toBe(2.042);
    expect(criticalT95(31)).toBe(1.96);
    expect(criticalT95(1_000_000)).toBe(1.96);
    expect(() => criticalT95(0)).toThrow();
    expect(() => criticalT95(1.5)).toThrow();
    expect(() => criticalT95(Number.NaN)).toThrow();
  });

  it("nTasks=2 (df=1): ratio 3 — which v1 fixed-z promoted — is refused, naming t critical and lower-bound semantics", () => {
    const twoTask = pairedStats(pairs([0.5, 0.5], [0.6, 0.7])); // deltas [0.1, 0.2] → meanDelta/se = 3
    expect(twoTask.meanDelta / twoTask.se).toBeCloseTo(3, 10);
    expect(twoTask.meanDelta / twoTask.se).toBeGreaterThanOrEqual(rule.minDeltaOverSe); // v1 would have promoted
    const d = evaluatePromotion(rule, twoTask, [control]);
    expect(d.promote).toBe(false);
    expect(d.reasons.join(" ")).toContain("12.706");
    expect(d.reasons.join(" ")).toMatch(/lower bound/i);
  });

  it("nTasks=2: a genuinely huge effect clears the t(1) threshold and promotes", () => {
    const huge = pairedStats(pairs([0.5, 0.5], [0.6, 0.601])); // deltas [0.1, 0.101] → ratio ≈ 201
    expect(huge.meanDelta / huge.se).toBeGreaterThan(criticalT95(1));
    const d = evaluatePromotion(rule, huge, [control]);
    expect(d.promote).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  // 32 tasks (df=31 → t floor 1.96); alternate ±j around mean m so ratio = m·√31/j exactly.
  const largeN = (m: number, j: number) =>
    pairedStats(
      pairs(
        Array.from({ length: 32 }, () => 0.5),
        Array.from({ length: 32 }, (_, t) => 0.5 + m + (t % 2 === 0 ? j : -j)),
      ),
    );

  it("large n converges to the pre-registered rule: minDeltaOverSe=2 still binds above the 1.96 t floor", () => {
    const s = largeN((1.98 * 0.1) / Math.sqrt(31), 0.1); // ratio ≈ 1.98: above t floor, below rule
    const ratio = s.meanDelta / s.se;
    expect(ratio).toBeGreaterThan(1.96);
    expect(ratio).toBeLessThan(2);
    const d = evaluatePromotion({ ...rule, minSignConsistency: 0 }, s, [control]);
    expect(d.promote).toBe(false);
  });

  it("large n: t critical stays a floor under a loose rule (minDeltaOverSe=0.5 cannot buy < 1.96)", () => {
    const loose = { ...rule, minDeltaOverSe: 0.5, minSignConsistency: 0 };
    const below = largeN((1.9 * 0.1) / Math.sqrt(31), 0.1); // ratio ≈ 1.9 < 1.96
    expect(evaluatePromotion(loose, below, [control]).promote).toBe(false);
    const above = largeN((2.5 * 0.1) / Math.sqrt(31), 0.1); // ratio ≈ 2.5 > 1.96
    expect(evaluatePromotion(loose, above, [control]).promote).toBe(true);
  });

  it("v2 gate hash covers {version, rule} — cannot collide with a v1 fixed-z hash of the same fields", () => {
    expect(PROMOTION_GATE_VERSION).toBe(2);
    const m0 = new PromotionGate({ minDeltaOverSe: 2, minSignConsistency: 0.8, replicates: 3, requireNegativeControls: true });
    // v1 hashed the bare rule fields; recorded in .hone-runs/m0-noise-mrm7x4dw-09b0a9 (git 25a03e6).
    expect(m0.ruleHash).not.toBe("sha256:cc0be34d5480be12b6ae369a9d7411e1178db228f9faa0343da9940533fb0160");
    // Golden v2: sha256 of canonical {"rule":{…},"version":2}.
    expect(m0.ruleHash).toBe("sha256:18398d06e85155146952d32edd1ce66fffc007333ef5a3f798e89e47ab83ca34");
  });
});
