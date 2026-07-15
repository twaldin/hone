import { describe, expect, it } from "vitest";
import type { EvaluationRecord, PromotionRule } from "@hone/schema";
import { PromotionGate, evaluatePromotion, pairedStats, type NegativeControl } from "../src/index.js";

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
