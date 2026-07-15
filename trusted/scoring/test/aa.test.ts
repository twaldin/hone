import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EvaluationRecord } from "@hone/schema";
import { aaFalsePromotionRate, pairedStats, PromotionGate, type AaSampleContext, type EvaluationPair } from "../src/index.js";

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

describe("M0 regression — measured A-A null from run m0-noise-mrm7x4dw-09b0a9 (git 25a03e6)", () => {
  // Exact measured 5-score pools (seeds 0..4) for the one baseline artifact:
  // task 0 = train, task 1 = validation. Copied verbatim from the report's
  // evaluations.perSeed — the test is hermetic; the ignored report is not read.
  const M0_POOLS: readonly (readonly number[])[] = [
    [0.017990504573556203, 0.0179464924508419, 0.017973430531192314, 0.01790527050021656, 0.017979542019141235],
    [0.024111024738302327, 0.023809426323254723, 0.02395982616947213, 0.023780551265041854, 0.023813754610432895],
  ];
  // Report methodology, verbatim: index = sha256('m0-aa-v1|'+trial+'|'+task+'|'+arm+'|'+replicate).readUInt32BE(0) % 5
  const m0Sample = ({ trial, task, arm, replicate }: AaSampleContext): number => {
    const h = createHash("sha256").update(`m0-aa-v1|${trial}|${task}|${arm}|${replicate}`).digest();
    return M0_POOLS[task]![h.readUInt32BE(0) % 5]!;
  };
  const m0Rule = { minDeltaOverSe: 2, minSignConsistency: 0.8, replicates: 3, requireNegativeControls: true };
  const TRIALS = 1000;
  const TASKS = 2;

  function m0Record(task: number, seed: number, aggregate: number): EvaluationRecord {
    return {
      capsuleId: `aa-task-${task}`,
      artifactHash: `sha256:${"a".repeat(64)}`,
      assetGroupId: "aa",
      seed,
      output: { valid: true, objectives: { aggregate }, constraints: {}, perExample: {} },
      costUsd: 0,
      durationMs: 0,
      cached: false,
      evaluatedAt: "1970-01-01T00:00:00.000Z",
    };
  }

  it("v1 fixed-z semantics false-promote 70/1000 = 7% on these draws — the pre-registered gate failure", () => {
    let v1Promotions = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const trialPairs: EvaluationPair[] = [];
      for (let task = 0; task < TASKS; task += 1) {
        for (let replicate = 0; replicate < m0Rule.replicates; replicate += 1) {
          trialPairs.push({
            champion: m0Record(task, replicate, m0Sample({ trial, task, arm: 0, replicate })),
            challenger: m0Record(task, replicate, m0Sample({ trial, task, arm: 1, replicate })),
          });
        }
      }
      const stats = pairedStats(trialPairs);
      // Old v1 gate: fixed threshold meanDelta/se ≥ rule.minDeltaOverSe, no df correction.
      const v1Promote =
        stats.nTasks >= 2 &&
        Number.isFinite(stats.se) &&
        stats.se > 0 &&
        stats.meanDelta / stats.se >= m0Rule.minDeltaOverSe &&
        stats.signConsistency >= m0Rule.minSignConsistency &&
        stats.minReplicates >= m0Rule.replicates;
      if (v1Promote) v1Promotions += 1;
    }
    expect(v1Promotions).toBe(70);
    expect(v1Promotions / TRIALS).toBeGreaterThan(0.05); // fails the pre-registered α = 0.05 gate
  });

  it("revised finite-t gate holds the same measured null at 7/1000 = 0.7% ≤ 5%", () => {
    const report = aaFalsePromotionRate({ rule: m0Rule, trials: TRIALS, tasks: TASKS, sample: m0Sample });
    expect(report.trials).toBe(TRIALS);
    expect(report.promotions).toBe(7);
    expect(report.rate).toBe(0.007);
    expect(report.rate).toBeLessThanOrEqual(0.05);
    // The revised gate is a different pre-registered object: its hash must not
    // collide with the v1 hash recorded in the M0 report.
    expect(report.ruleHash).not.toBe("sha256:cc0be34d5480be12b6ae369a9d7411e1178db228f9faa0343da9940533fb0160");
    expect(report.ruleHash).toBe(new PromotionGate(m0Rule).ruleHash);
  });
});
