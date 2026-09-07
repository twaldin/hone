import { describe, expect, it } from "vitest";
import type { EvaluationRecord } from "@hone/schema";
import { pairedStats } from "../src/index.js";

/** Synthetic EvaluationRecord factory. */
function rec(opts: {
  capsuleId?: string | undefined;
  assetGroupId?: string | undefined;
  seed?: number | undefined;
  artifactHash?: string | undefined;
  objectives?: Record<string, number> | undefined;
  perExample?: Record<string, { score: number }> | undefined;
}): EvaluationRecord {
  return {
    capsuleId: opts.capsuleId ?? "cap_0123456789ab",
    artifactHash: opts.artifactHash ?? "sha256:" + "e".repeat(64),
    assetGroupId: opts.assetGroupId ?? "train",
    seed: opts.seed ?? 0,
    output: {
      valid: true,
      objectives: opts.objectives ?? { aggregate: 0 },
      constraints: {},
      perExample: opts.perExample ?? {},
    },
    costUsd: 0,
    durationMs: 1,
    cached: false,
    evaluatedAt: "2026-07-14T12:00:00.000Z",
  };
}

const pair = (
  task: string,
  seed: number,
  champ: number,
  chall: number,
  perEx?: { champ: Record<string, { score: number }>; chall: Record<string, { score: number }> },
) => ({
  champion: rec({ capsuleId: task, seed, objectives: { aggregate: champ }, perExample: perEx?.champ }),
  challenger: rec({ capsuleId: task, seed, objectives: { aggregate: chall }, perExample: perEx?.chall }),
});

describe("pairedStats: golden values", () => {
  it("3 tasks x 1 replicate — mean, paired SE, sign consistency reproduced exactly", () => {
    const s = pairedStats([
      pair("cap_00000000000a", 0, 0.5, 0.6),
      pair("cap_00000000000b", 0, 0.6, 0.65),
      pair("cap_00000000000c", 0, 0.7, 0.75),
    ]);
    // deltas [0.1, 0.05, 0.05]: mean 1/15, sd sqrt(1/1200), se 1/60 — hand-computed
    expect(s.nTasks).toBe(3);
    expect(s.deltas.map((d) => Math.round(d * 1e12) / 1e12)).toEqual([0.1, 0.05, 0.05]);
    expect(s.meanDelta).toBeCloseTo(0.06666666666666667, 12);
    expect(s.se).toBeCloseTo(0.01666666666666667, 12);
    expect(s.signConsistency).toBe(1);
    expect(s.minReplicates).toBe(1);
  });

  it("2 tasks x 2 replicates — per-task deltas average per-seed deltas; SE over tasks", () => {
    const s = pairedStats([
      pair("cap_00000000000a", 0, 0.5, 0.6),
      pair("cap_00000000000a", 1, 0.54, 0.56),
      pair("cap_00000000000b", 0, 0.7, 0.65),
      pair("cap_00000000000b", 1, 0.7, 0.71),
    ]);
    // task deltas [0.06, -0.02]: mean 0.02, se 0.04 — hand-computed
    expect(s.nTasks).toBe(2);
    expect(s.deltas[0]).toBeCloseTo(0.06, 12);
    expect(s.deltas[1]).toBeCloseTo(-0.02, 12);
    expect(s.meanDelta).toBeCloseTo(0.02, 12);
    expect(s.se).toBeCloseTo(0.04, 12);
    expect(s.signConsistency).toBe(0.5);
    expect(s.minReplicates).toBe(2);
  });

  it("single task: SE is NaN — no interval from one task", () => {
    const s = pairedStats([pair("cap_00000000000a", 0, 0.5, 0.6)]);
    expect(s.nTasks).toBe(1);
    expect(Number.isNaN(s.se)).toBe(true);
  });
});

describe("pairedStats: pairing integrity", () => {
  it("rejects a pair whose capsule/assetGroup/seed keys do not match", () => {
    expect(() =>
      pairedStats([
        {
          champion: rec({ capsuleId: "cap_00000000000a", seed: 0, objectives: { aggregate: 0.5 } }),
          challenger: rec({ capsuleId: "cap_00000000000a", seed: 1, objectives: { aggregate: 0.6 } }),
        },
      ]),
    ).toThrow(/pair/i);
  });

  it("rejects duplicate (capsule, assetGroup, seed) pairs — a replicate must be a distinct seed", () => {
    expect(() => pairedStats([pair("cap_00000000000a", 0, 0.5, 0.6), pair("cap_00000000000a", 0, 0.5, 0.6)])).toThrow(
      /duplicate/i,
    );
  });

  it("rejects an empty pair set", () => {
    expect(() => pairedStats([])).toThrow();
  });

  it("ties count against sign consistency (conservative)", () => {
    const s = pairedStats([pair("cap_00000000000a", 0, 0.5, 0.5), pair("cap_00000000000b", 0, 0.5, 0.6)]);
    expect(s.signConsistency).toBe(0.5);
  });
});

describe("pairedStats: per-example vectors preserved (logged, never used for selection)", () => {
  it("carries per-example deltas for matched example keys", () => {
    const s = pairedStats([
      pair("cap_00000000000a", 0, 0.5, 0.6, {
        champ: { ex1: { score: 0.4 }, ex2: { score: 0.6 }, champOnly: { score: 1 } },
        chall: { ex1: { score: 0.5 }, ex2: { score: 0.7 } },
      }),
    ]);
    const task = s.perTask[0]!;
    expect(task.perExampleDeltas["ex1"]).toHaveLength(1);
    expect(task.perExampleDeltas["ex1"]![0]).toBeCloseTo(0.1, 12);
    expect(task.perExampleDeltas["ex2"]).toHaveLength(1);
    expect(task.perExampleDeltas["ex2"]![0]).toBeCloseTo(0.1, 12);
    expect(task.perExampleDeltas["champOnly"]).toBeUndefined(); // unmatched keys dropped
  });

  it("custom score extractor overrides the default mean-of-objectives", () => {
    const p = {
      champion: rec({ objectives: { runtime: 2, correctness: 1 } }),
      challenger: rec({ objectives: { runtime: 1, correctness: 1 } }),
    };
    const byRuntime = pairedStats([p], { score: (r) => -(r.output.objectives["runtime"] ?? 0) });
    expect(byRuntime.meanDelta).toBe(1);
    const byMean = pairedStats([p]); // default: mean of objective values
    expect(byMean.meanDelta).toBeCloseTo(-0.5, 12);
  });
});
