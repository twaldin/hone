import type { EvaluationRecord } from "@hone/schema";
import { pairedStats, type EvaluationPair } from "./paired.js";
import { PromotionGate, type PromotionDecision, type PromotionRuleInput } from "./promotion.js";

/**
 * A-A null harness (review IV.2 / C2): replicate evaluations of ONE artifact
 * are split into two pseudo-arms and pushed through the real pairedStats →
 * promotion pipeline N times. Any sane rule must false-promote at ≈ α or
 * below; a rule that promotes its own noise is rejected before it ever sees
 * a real challenger.
 *
 * The negative-control gate is satisfied synthetically (a control pinned
 * below the champion): A-A exercises the STATISTICAL criteria; control
 * discrimination is validated separately with real broken candidates.
 */

export interface AaSampleContext {
  trial: number;
  task: number;
  /** Pseudo-arm: 0 = "champion", 1 = "challenger". SAME artifact, same distribution. */
  arm: 0 | 1;
  replicate: number;
}

export interface AaOptions {
  rule: PromotionRuleInput;
  /** Number of independent A-A trials. */
  trials: number;
  /** Tasks per trial. */
  tasks: number;
  /** Score generator — MUST be arm-invariant in distribution (that is what makes it A-A). */
  sample: (ctx: AaSampleContext) => number;
}

export interface AaReport {
  trials: number;
  promotions: number;
  /** False-promotion rate: promotions / trials. */
  rate: number;
  ruleHash: string;
  /** Per-trial decisions, for audit. */
  decisions: PromotionDecision[];
}

const AA_ARTIFACT = `sha256:${"a".repeat(64)}`;

function syntheticRecord(task: number, seed: number, aggregate: number): EvaluationRecord {
  return {
    capsuleId: `aa-task-${task}`,
    artifactHash: AA_ARTIFACT,
    assetGroupId: "aa",
    seed,
    output: { valid: true, objectives: { aggregate }, constraints: {}, perExample: {} },
    costUsd: 0,
    durationMs: 0,
    cached: false,
    evaluatedAt: "1970-01-01T00:00:00.000Z",
  };
}

export function aaFalsePromotionRate(opts: AaOptions): AaReport {
  if (!Number.isInteger(opts.trials) || opts.trials < 1) throw new Error(`aa: trials must be ≥ 1, got ${opts.trials}`);
  if (!Number.isInteger(opts.tasks) || opts.tasks < 1) throw new Error(`aa: tasks must be ≥ 1, got ${opts.tasks}`);

  const gate = new PromotionGate(opts.rule);
  const replicates = gate.rule.replicates;
  const syntheticControl = { id: "aa-synthetic-negative-control", meanDelta: -1 };

  const decisions: PromotionDecision[] = [];
  let promotions = 0;
  for (let trial = 0; trial < opts.trials; trial += 1) {
    const pairs: EvaluationPair[] = [];
    for (let task = 0; task < opts.tasks; task += 1) {
      for (let replicate = 0; replicate < replicates; replicate += 1) {
        pairs.push({
          champion: syntheticRecord(task, replicate, opts.sample({ trial, task, arm: 0, replicate })),
          challenger: syntheticRecord(task, replicate, opts.sample({ trial, task, arm: 1, replicate })),
        });
      }
    }
    const decision = gate.evaluate(pairedStats(pairs), [syntheticControl]);
    decisions.push(decision);
    if (decision.promote) promotions += 1;
  }

  return { trials: opts.trials, promotions, rate: promotions / opts.trials, ruleHash: gate.ruleHash, decisions };
}
