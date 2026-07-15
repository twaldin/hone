import type { EvaluationRecord } from "@hone/schema";
import { sampleStdDev, type PairedStatsOptions } from "./paired.js";

/**
 * Noise floor + MDE (review IV.2 / C2): measure BEFORE optimizing.
 *
 * Model: per-task paired-delta variance = τ² + 2σ²/k, where σ is per-task
 * replicate noise and τ the candidate×task interaction scale. Power identity
 * at 80% power / α=.05 (two-sided): n = 7.85·(τ² + 2σ²/k)/δ².
 *
 * τ̂ here is the pragmatic seed stand-in: sd of per-task mean scores of ONE
 * artifact. True interaction spread needs multiple candidates; this
 * upper-bounds nothing and is published as a floor, not a proof.
 */

/** (z_{α/2} + z_β)² ≈ (1.96 + 0.8416)² for 80% power at two-sided α = .05. */
export const POWER_CONSTANT = 7.85;

/** Minimum detectable effect for n tasks × k replicates/arm: δ = √(C·(τ²+2σ²/k)/n). */
export function mde(sigma: number, tau: number, k: number, n: number): number {
  if (!(sigma >= 0) || !(tau >= 0) || !(k > 0) || !(n > 0)) {
    throw new Error(`mde: invalid inputs (sigma=${sigma}, tau=${tau}, k=${k}, n=${n})`);
  }
  return Math.sqrt((POWER_CONSTANT * (tau * tau + (2 * sigma * sigma) / k)) / n);
}

/** Tasks needed to detect a true effect δ: n = C·(τ²+2σ²/k)/δ² (review IV.2 table). */
export function tasksNeeded(sigma: number, tau: number, k: number, delta: number): number {
  if (!(sigma >= 0) || !(tau >= 0) || !(k > 0) || !(delta > 0)) {
    throw new Error(`tasksNeeded: invalid inputs (sigma=${sigma}, tau=${tau}, k=${k}, delta=${delta})`);
  }
  return (POWER_CONSTANT * (tau * tau + (2 * sigma * sigma) / k)) / (delta * delta);
}

export interface MdeRow {
  k: number;
  n: number;
  mde: number;
}

export function mdeTable(opts: { sigma: number; tau: number; ks: readonly number[]; ns: readonly number[] }): MdeRow[] {
  const rows: MdeRow[] = [];
  for (const k of opts.ks) {
    for (const n of opts.ns) rows.push({ k, n, mde: mde(opts.sigma, opts.tau, k, n) });
  }
  return rows;
}

export interface NoiseFloorOptions extends PairedStatsOptions {
  /** Replicate counts for the published MDE table. */
  ks?: readonly number[];
  /** Task counts for the published MDE table. */
  ns?: readonly number[];
}

export interface NoiseFloorTask {
  capsuleId: string;
  assetGroupId: string;
  /** Replicate count for this task. */
  k: number;
  mean: number;
  /** Per-task replicate σ̂ (sample sd over seeds). */
  sigma: number;
}

export interface NoiseFloorReport {
  artifactHash: string;
  perTask: NoiseFloorTask[];
  /** Pooled σ̂ = √(Σ(kₜ−1)·sₜ² / Σ(kₜ−1)). */
  sigmaHat: number;
  /** Cross-task spread: sample sd of per-task means. NaN with < 2 tasks. */
  tauHat: number;
  /** MDE table at the measured (σ̂, τ̂). */
  mdeTable: MdeRow[];
}

const DEFAULT_KS = [1, 3, 5, 10] as const;
const DEFAULT_NS = [5, 10, 20, 30, 50] as const;

/**
 * Noise floor from k replicate evaluations (distinct seeds) of the SAME
 * artifact per task. Mixed artifacts are rejected: the floor is a property
 * of one artifact's evaluator, not a comparison.
 */
export function noiseFloor(records: readonly EvaluationRecord[], opts: NoiseFloorOptions = {}): NoiseFloorReport {
  if (records.length === 0) throw new Error("noiseFloor: no records");
  const first = records[0];
  if (first === undefined) throw new Error("noiseFloor: no records");
  const artifactHash = first.artifactHash;
  const score =
    opts.score ??
    ((record: EvaluationRecord): number => {
      const values = Object.values(record.output.objectives);
      if (values.length === 0) {
        throw new Error(`noiseFloor: record for ${record.capsuleId}/${record.assetGroupId} has no objectives`);
      }
      return values.reduce((a, b) => a + b, 0) / values.length;
    });

  const byTask = new Map<string, { capsuleId: string; assetGroupId: string; scoresBySeed: Map<number, number> }>();
  for (const record of records) {
    if (record.artifactHash !== artifactHash) {
      throw new Error(
        `noiseFloor: mixed artifacts (${artifactHash} vs ${record.artifactHash}) — replicates must all evaluate ONE artifact`,
      );
    }
    const key = `${record.capsuleId}\u0000${record.assetGroupId}`;
    let task = byTask.get(key);
    if (task === undefined) {
      task = { capsuleId: record.capsuleId, assetGroupId: record.assetGroupId, scoresBySeed: new Map() };
      byTask.set(key, task);
    }
    if (task.scoresBySeed.has(record.seed)) {
      throw new Error(
        `noiseFloor: duplicate seed ${record.seed} for (${record.capsuleId}, ${record.assetGroupId}) — memoized re-reads are not replicates`,
      );
    }
    task.scoresBySeed.set(record.seed, score(record));
  }

  const perTask: NoiseFloorTask[] = [...byTask.values()]
    .sort((a, b) =>
      a.capsuleId === b.capsuleId ? a.assetGroupId.localeCompare(b.assetGroupId) : a.capsuleId.localeCompare(b.capsuleId),
    )
    .map((task) => {
      const scores = [...task.scoresBySeed.entries()].sort(([a], [b]) => a - b).map(([, s]) => s);
      if (scores.length < 2) {
        throw new Error(
          `noiseFloor: (${task.capsuleId}, ${task.assetGroupId}) has ${scores.length} replicate — σ̂ needs k ≥ 2`,
        );
      }
      return {
        capsuleId: task.capsuleId,
        assetGroupId: task.assetGroupId,
        k: scores.length,
        mean: scores.reduce((a, b) => a + b, 0) / scores.length,
        sigma: sampleStdDev(scores),
      };
    });

  let pooledSs = 0;
  let pooledDf = 0;
  for (const task of perTask) {
    pooledSs += (task.k - 1) * task.sigma * task.sigma;
    pooledDf += task.k - 1;
  }
  const sigmaHat = Math.sqrt(pooledSs / pooledDf);
  const tauHat = sampleStdDev(perTask.map((t) => t.mean));

  return {
    artifactHash,
    perTask,
    sigmaHat,
    tauHat,
    mdeTable: Number.isNaN(tauHat)
      ? []
      : mdeTable({ sigma: sigmaHat, tau: tauHat, ks: opts.ks ?? DEFAULT_KS, ns: opts.ns ?? DEFAULT_NS }),
  };
}
