import { describe, expect, it } from "vitest";
import type { EvaluationRecord } from "@hone/schema";
import { mde, mdeTable, noiseFloor, tasksNeeded, POWER_CONSTANT } from "../src/index.js";

function rec(capsuleId: string, seed: number, aggregate: number, artifactHash = "sha256:" + "e".repeat(64)): EvaluationRecord {
  return {
    capsuleId,
    artifactHash,
    assetGroupId: "train",
    seed,
    output: { valid: true, objectives: { aggregate }, constraints: {}, perExample: {} },
    costUsd: 0,
    durationMs: 1,
    cached: false,
    evaluatedAt: "2026-07-14T12:00:00.000Z",
  };
}

describe("MDE table — review IV.2 formula n = 7.85·(τ²+2σ²/k)/δ²", () => {
  it("reproduces the review's task-count table for σ=0.2 τ=0.1 δ=0.05", () => {
    // Hand-computed: 7.85·(0.01+0.08/k)/0.0025
    expect(tasksNeeded(0.2, 0.1, 1, 0.05)).toBeCloseTo(282.6, 6);
    expect(tasksNeeded(0.2, 0.1, 3, 0.05)).toBeCloseTo(115.13333333333333, 6);
    expect(tasksNeeded(0.2, 0.1, 10, 0.05)).toBeCloseTo(56.52, 6);
    expect(tasksNeeded(0.2, 0.1, Number.POSITIVE_INFINITY, 0.05)).toBeCloseTo(31.4, 6);
  });

  it("mde solves the same formula for δ — hand-computed values within 1e-6 (σ=0.2, τ=0.1, k=1/3/10, n=10)", () => {
    // δ = sqrt(7.85·(τ²+2σ²/k)/n), hand-computed:
    expect(Math.abs(mde(0.2, 0.1, 1, 10) - 0.2658006772000403)).toBeLessThan(1e-6);
    expect(Math.abs(mde(0.2, 0.1, 3, 10) - 0.16965651574087373)).toBeLessThan(1e-6);
    expect(Math.abs(mde(0.2, 0.1, 10, 10) - 0.1188696765369537)).toBeLessThan(1e-6);
  });

  it("mde and tasksNeeded are inverses", () => {
    const delta = mde(0.2, 0.1, 3, 42);
    expect(tasksNeeded(0.2, 0.1, 3, delta)).toBeCloseTo(42, 9);
  });

  it("power constant is (z_{α/2}+z_β)² for 80% power at α=.05", () => {
    expect(POWER_CONSTANT).toBe(7.85);
  });

  it("mdeTable enumerates k × n", () => {
    const table = mdeTable({ sigma: 0.2, tau: 0.1, ks: [1, 3, 10], ns: [10, 20] });
    expect(table).toHaveLength(6);
    const row = table.find((r) => r.k === 3 && r.n === 10)!;
    expect(Math.abs(row.mde - 0.16965651574087373)).toBeLessThan(1e-6);
  });
});

describe("noiseFloor — replicates of the SAME artifact", () => {
  const records = [
    rec("cap_00000000000a", 0, 0.5),
    rec("cap_00000000000a", 1, 0.54),
    rec("cap_00000000000a", 2, 0.58),
    rec("cap_00000000000b", 0, 0.7),
    rec("cap_00000000000b", 1, 0.71),
    rec("cap_00000000000b", 2, 0.69),
  ];

  it("per-task σ̂, pooled σ̂, cross-task τ̂ — hand-computed", () => {
    const report = noiseFloor(records);
    expect(report.perTask).toHaveLength(2);
    const [a, b] = report.perTask;
    expect(a!.k).toBe(3);
    expect(a!.sigma).toBeCloseTo(0.03999999999999998, 12);
    expect(b!.sigma).toBeCloseTo(0.010000000000000009, 12);
    expect(report.sigmaHat).toBeCloseTo(0.02915475947422649, 12); // pooled sqrt(Σ(k-1)s²/Σ(k-1))
    expect(report.tauHat).toBeCloseTo(0.11313708498984755, 12); // sd of task means [0.54, 0.70]
  });

  it("rejects mixed artifacts — the noise floor is a property of ONE artifact", () => {
    expect(() => noiseFloor([...records, rec("cap_00000000000c", 0, 0.5, "sha256:" + "f".repeat(64))])).toThrow(
      /artifact/i,
    );
  });

  it("rejects duplicate seeds within a task — memoized re-reads are not replicates", () => {
    expect(() => noiseFloor([rec("cap_00000000000a", 0, 0.5), rec("cap_00000000000a", 0, 0.5)])).toThrow(/seed/i);
  });

  it("requires k ≥ 2 replicates per task", () => {
    expect(() => noiseFloor([rec("cap_00000000000a", 0, 0.5)])).toThrow(/replicate/i);
  });

  it("τ̂ is NaN with a single task — cross-task spread needs ≥ 2 tasks", () => {
    const report = noiseFloor([rec("cap_00000000000a", 0, 0.5), rec("cap_00000000000a", 1, 0.54)]);
    expect(Number.isNaN(report.tauHat)).toBe(true);
    expect(report.sigmaHat).toBeGreaterThan(0);
  });

  it("emits the MDE table for its own measured floor", () => {
    const report = noiseFloor(records, { ks: [1, 3], ns: [10] });
    expect(report.mdeTable).toHaveLength(2);
    const row = report.mdeTable.find((r) => r.k === 3 && r.n === 10)!;
    expect(row.mde).toBeCloseTo(mde(report.sigmaHat, report.tauHat, 3, 10), 12);
  });
});
