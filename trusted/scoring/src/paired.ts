import type { EvaluationRecord } from "@hone/schema";

/**
 * Paired statistics (review IV.2 / C3): champion vs challenger evaluated on
 * IDENTICAL (capsule, assetGroup, seed) coordinates. Per-task deltas feed an
 * aggregate paired mean + SE; per-example vectors are preserved as evidence
 * for the reflective loop but are NEVER consumed by selection (greedy seed).
 */

export interface EvaluationPair {
  champion: EvaluationRecord;
  challenger: EvaluationRecord;
}

export interface PairedStatsOptions {
  /** Scalar score for a record. Default: mean of `output.objectives` values. */
  score?: (record: EvaluationRecord) => number;
}

export interface PairedTaskStats {
  capsuleId: string;
  assetGroupId: string;
  /** Replicate seeds, ascending. */
  seeds: number[];
  /** challenger − champion, one per seed, in `seeds` order. */
  seedDeltas: number[];
  /** Mean of `seedDeltas` — the task's paired delta. */
  delta: number;
  /** Example key → per-seed deltas for keys present in BOTH arms. Logged, not selected on. */
  perExampleDeltas: Record<string, number[]>;
}

export interface PairedStatsResult {
  nTasks: number;
  /** Per-task paired deltas, tasks in (capsuleId, assetGroupId) order. */
  deltas: number[];
  meanDelta: number;
  /** Paired standard error: sd(deltas)/√nTasks. NaN when nTasks < 2 — no interval. */
  se: number;
  /** Fraction of tasks with delta > 0; ties count against (conservative). */
  signConsistency: number;
  /** Minimum replicates (seed pairs) across tasks. */
  minReplicates: number;
  perTask: PairedTaskStats[];
}

/** Sample standard deviation (n−1 denominator). NaN for n < 2. */
export function sampleStdDev(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const ss = values.reduce((a, v) => a + (v - mean) * (v - mean), 0);
  return Math.sqrt(ss / (values.length - 1));
}

export function pairedStats(pairs: readonly EvaluationPair[], opts: PairedStatsOptions = {}): PairedStatsResult {
  if (pairs.length === 0) throw new Error("pairedStats: empty pair set");
  const score =
    opts.score ??
    ((record: EvaluationRecord): number => {
      const values = Object.values(record.output.objectives);
      if (values.length === 0) {
        throw new Error(`pairedStats: record for ${record.capsuleId}/${record.assetGroupId} has no objectives`);
      }
      return values.reduce((a, b) => a + b, 0) / values.length;
    });

  // Group by task, enforcing pairing integrity.
  const byTask = new Map<string, { capsuleId: string; assetGroupId: string; bySeed: Map<number, EvaluationPair> }>();
  pairs.forEach((pair, i) => {
    const { champion, challenger } = pair;
    if (
      champion.capsuleId !== challenger.capsuleId ||
      champion.assetGroupId !== challenger.assetGroupId ||
      champion.seed !== challenger.seed
    ) {
      throw new Error(
        `pairedStats: pair ${i} is not paired — champion (${champion.capsuleId}, ${champion.assetGroupId}, seed ${champion.seed}) ` +
          `vs challenger (${challenger.capsuleId}, ${challenger.assetGroupId}, seed ${challenger.seed})`,
      );
    }
    const key = `${champion.capsuleId}\u0000${champion.assetGroupId}`;
    let task = byTask.get(key);
    if (task === undefined) {
      task = { capsuleId: champion.capsuleId, assetGroupId: champion.assetGroupId, bySeed: new Map() };
      byTask.set(key, task);
    }
    if (task.bySeed.has(champion.seed)) {
      throw new Error(
        `pairedStats: duplicate pair for (${champion.capsuleId}, ${champion.assetGroupId}, seed ${champion.seed}) — a replicate must be a distinct seed`,
      );
    }
    task.bySeed.set(champion.seed, pair);
  });

  const perTask: PairedTaskStats[] = [...byTask.values()]
    .sort((a, b) =>
      a.capsuleId === b.capsuleId ? a.assetGroupId.localeCompare(b.assetGroupId) : a.capsuleId.localeCompare(b.capsuleId),
    )
    .map((task) => {
      const seeds = [...task.bySeed.keys()].sort((a, b) => a - b);
      const seedDeltas: number[] = [];
      const perExampleDeltas: Record<string, number[]> = {};
      for (const seed of seeds) {
        const pair = task.bySeed.get(seed);
        if (pair === undefined) throw new Error("pairedStats: internal seed index inconsistency");
        seedDeltas.push(score(pair.challenger) - score(pair.champion));
        for (const [example, challengerResult] of Object.entries(pair.challenger.output.perExample)) {
          const championResult = pair.champion.output.perExample[example];
          if (championResult === undefined) continue; // unmatched example keys carry no paired signal
          (perExampleDeltas[example] ??= []).push(challengerResult.score - championResult.score);
        }
      }
      return {
        capsuleId: task.capsuleId,
        assetGroupId: task.assetGroupId,
        seeds,
        seedDeltas,
        delta: seedDeltas.reduce((a, b) => a + b, 0) / seedDeltas.length,
        perExampleDeltas,
      };
    });

  const deltas = perTask.map((t) => t.delta);
  const nTasks = deltas.length;
  return {
    nTasks,
    deltas,
    meanDelta: deltas.reduce((a, b) => a + b, 0) / nTasks,
    se: sampleStdDev(deltas) / Math.sqrt(nTasks),
    signConsistency: deltas.filter((d) => d > 0).length / nTasks,
    minReplicates: Math.min(...perTask.map((t) => t.seeds.length)),
    perTask,
  };
}
