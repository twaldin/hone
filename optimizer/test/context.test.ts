import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BudgetState, EvaluationRecord } from "@hone/schema";
import {
  buildEpisodeContext,
  EVALUATOR_RECORD_PATH,
  MAX_INLINE_PER_EXAMPLE_RESULTS,
} from "../assets/context.js";
import { maxFeedbackChars } from "../assets/policy.js";
import { MUTATION_SYSTEM_PROMPT, REPAIR_SYSTEM_PROMPT } from "../assets/prompts.js";
import { EpisodeContext } from "../src/episode.js";

/** Golden-ish contract: the reflective loop EATS feedback blobs — they must reach the prompt. */

const budget: BudgetState = {
  envelope: { maxTokens: 1_000_000, maxUsd: 50, maxWallClockSec: 7200, maxEvaluatorInvocations: 10 },
  spent: { tokens: 250_000, usd: 12.5, wallClockSec: 1800, evaluatorInvocations: 3 },
};

const sessionNoYieldMaxTokens = 1_500_000;

function record(perExample: EvaluationRecord["output"]["perExample"]): EvaluationRecord {
  return {
    capsuleId: "cap_000000000000",
    artifactHash: "sha256:".padEnd(71, "0"),
    assetGroupId: "train",
    seed: 4,
    output: {
      valid: true,
      objectives: { runtime: 0.42, correctness: 1 },
      constraints: { compiles: true },
      perExample,
      diagnostics: { summary: "2/3 mazes within budget" },
    },
    costUsd: 0.01,
    durationMs: 900,
    cached: false,
    evaluatedAt: "2026-07-14T00:00:00.000Z",
  };
}

describe("buildEpisodeContext", () => {
  it("renders objective, per-example scores, feedback blobs, lineage, and remaining budget", () => {
    const ctx = buildEpisodeContext({
      episode: 4,
      objective: "make the pathfinder fast, keep correctness",
      parentEvaluation: record({
        maze_04: { score: 0.2, feedback: "TimeoutError: search exceeded 5s on maze_04 (expanded 9M nodes)" },
        maze_07: { score: 1, feedback: { runtimeMs: 12, note: "already optimal" } },
      }),
      lineage: [
        { episode: 0, approach: "memoize-neighbors", delta: 0.02 },
        { episode: 2, approach: "binary-heap-frontier", delta: -0.01 },
      ],
      budget,
      sessionNoYieldMaxTokens,
    });

    expect(EpisodeContext.parse(ctx)).toEqual(ctx);
    expect(ctx.mode).toBe("mutation");
    expect(ctx.episode).toBe(4);
    expect(ctx.systemPrompt).toBe(MUTATION_SYSTEM_PROMPT);
    expect(ctx.systemPrompt).toContain("The FIRST successful yield terminates this episode and is the goal");
    expect(ctx.systemPrompt).toContain("Protected assets are unavailable");
    // Version-2 coding-session request: the inner improvement role, its safe
    // tool subset, and the yield schema all ride in the request itself — the
    // worker enforces exactly these, so the builder must emit them.
    expect(ctx.role).toBe("inner-improver");
    expect(ctx.tools).toEqual(["read", "bash", "write", "edit"]);
    expect(ctx.outputSchema.additionalProperties).toBe(false);
    expect(ctx.outputSchema.required).toEqual(["summary", "approach", "filesChanged"]);

    expect(ctx.userPrompt).toContain("make the pathfinder fast, keep correctness");
    // Behavioral invariants, not rendering format (context.ts is a mutable
    // asset in M1): example ids, scores, and untouched feedback blobs (string
    // and structured) must all reach the prompt.
    expect(ctx.userPrompt).toContain("maze_04");
    expect(ctx.userPrompt).toContain("0.2");
    expect(ctx.userPrompt).toContain("TimeoutError: search exceeded 5s on maze_04 (expanded 9M nodes)");
    expect(ctx.userPrompt).toContain('{"runtimeMs":12,"note":"already optimal"}');
    // Objective values and the evaluator's diagnostic summary reach the prompt.
    expect(ctx.userPrompt).toContain("runtime");
    expect(ctx.userPrompt).toContain("0.42");
    expect(ctx.userPrompt).toContain("2/3 mazes within budget");
    // Lineage approach labels reach the prompt.
    expect(ctx.userPrompt).toContain("memoize-neighbors");
    expect(ctx.userPrompt).toContain("binary-heap-frontier");
    // Remaining budget (envelope minus spend) reaches the prompt, not raw spend.
    expect(ctx.userPrompt).toContain("750000");
    expect(ctx.userPrompt).not.toContain("250000");
    expect(ctx.userPrompt).toContain("session no-yield token bound: 1500000");
    expect(ctx.userPrompt).toContain("session no-yield tokens remaining: 1500000 (at session start)");
  });

  it("renders a raised session no-yield ceiling as the enforced bound and remainder", () => {
    const ctx = buildEpisodeContext({
      episode: 0,
      objective: "obj",
      parentEvaluation: record({}),
      lineage: [],
      budget,
      sessionNoYieldMaxTokens: 1_700_000,
    });

    expect(ctx.userPrompt).toContain("session no-yield token bound: 1700000");
    expect(ctx.userPrompt).toContain("session no-yield tokens remaining: 1700000 (at session start)");
    expect(ctx.userPrompt).not.toContain("session no-yield token bound: 1500000");
  });

  it("truncates oversized feedback blobs at the policy bound", () => {
    const huge = "x".repeat(maxFeedbackChars + 500);
    const ctx = buildEpisodeContext({
      episode: 0,
      objective: "obj",
      parentEvaluation: record({ big: { score: 0, feedback: huge } }),
      lineage: [],
      budget,
      sessionNoYieldMaxTokens,
    });
    // Invariant: the oversized blob never reaches the prompt in full, but a
    // usable prefix does. The truncation marker text itself is mutable.
    expect(ctx.userPrompt).not.toContain(huge);
    expect(ctx.userPrompt).toContain("x".repeat(100));
  });

  it("keeps a real small-example M2 evaluation section byte-identical to the legacy rendering", () => {
    const output = JSON.parse(readFileSync(
      new URL("../../capsules/biome-parser-formatter/diagnostics/baseline-train.json", import.meta.url),
      "utf8",
    )) as EvaluationRecord["output"];
    const ctx = buildEpisodeContext({
      episode: 0,
      objective: "Improve Biome parser and formatter throughput without changing output.",
      parentEvaluation: { ...record({}), output },
      lineage: [],
      budget,
      sessionNoYieldMaxTokens,
    });
    const start = ctx.userPrompt.indexOf("# Current evaluation of this artifact");
    const end = ctx.userPrompt.indexOf("\n\n# Remaining budget", start);

    expect(ctx.userPrompt.slice(start, end)).toBe(`# Current evaluation of this artifact

valid: true
objective score: 0.07176521795164478
constraints: byte_exact=true, diagnostic_hashes=true, idempotent=true, rss_within_limit=true, tests_pass=true

Per-example results:
- aggregate: score=0.07176521795164478
  feedback: 4 frozen files; reciprocal geometric mean milliseconds

Evaluator summary: upstream-derived JS/TS/CSS parser and formatter regression suite passed`);
  });

  it("keeps exactly the inline cap in the legacy shape and aggregates only above it", () => {
    const perExample = Object.fromEntries(
      Array.from({ length: MAX_INLINE_PER_EXAMPLE_RESULTS + 1 }, (_, index) => [
        `case-${String(index).padStart(2, "0")}`,
        { score: index, feedback: `feedback-${index}` },
      ]),
    );
    const contextInput = {
      episode: 0,
      objective: "obj",
      lineage: [],
      budget,
      sessionNoYieldMaxTokens,
    };
    const atCap = buildEpisodeContext({
      ...contextInput,
      parentEvaluation: record(Object.fromEntries(
        Object.entries(perExample).slice(0, MAX_INLINE_PER_EXAMPLE_RESULTS),
      )),
    }).userPrompt;
    expect(atCap).toContain("Per-example results:");
    expect(atCap).not.toContain("Lowest-score examples:");
    expect(atCap.match(/^- case-/gm)).toHaveLength(MAX_INLINE_PER_EXAMPLE_RESULTS);
    expect(atCap).not.toContain(EVALUATOR_RECORD_PATH);

    const overCap = buildEpisodeContext({
      ...contextInput,
      parentEvaluation: record(perExample),
    }).userPrompt;
    expect(overCap).toContain("Lowest-score examples:");
    expect(overCap).toContain("Omitted 1 middle-score examples:");
    expect(overCap).toContain(`Full evaluator record (all ${MAX_INLINE_PER_EXAMPLE_RESULTS + 1} per-example results): ${EVALUATOR_RECORD_PATH}`);
    expect(overCap).not.toMatch(/NaN|undefined/);
  });

  it("bounds a 2,000-entry evaluator prompt", () => {
    const perExample = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [
        `train-${String(index).padStart(4, "0")}`,
        {
          score: index / 2_000,
          feedback: "anonymous ranking-calibration contribution",
        },
      ]),
    );
    const ctx = buildEpisodeContext({
      episode: 0,
      objective: "rank launches",
      parentEvaluation: record(perExample),
      lineage: [],
      budget,
      sessionNoYieldMaxTokens,
    });

    expect(ctx.userPrompt.length).toBeLessThan(20_000);
    expect(ctx.userPrompt.match(/^- train-/gm)).toHaveLength(MAX_INLINE_PER_EXAMPLE_RESULTS);
    expect(ctx.userPrompt).toContain("train-0000");
    expect(ctx.userPrompt).toContain("train-1999");
    expect(ctx.userPrompt).not.toContain("train-1000");
    expect(ctx.userPrompt).toContain("Omitted 1984 middle-score examples:");
    expect(ctx.userPrompt).toContain(
      `Full evaluator record (all 2000 per-example results): ${EVALUATOR_RECORD_PATH}`,
    );
  });

  it("switches to the repair frame and carries the failure evidence", () => {
    const ctx = buildEpisodeContext({
      episode: 2,
      objective: "obj",
      parentEvaluation: record({}),
      lineage: [],
      budget,
      sessionNoYieldMaxTokens,
      failure: {
        reason: "mutation session failed (exit 1, episode 2)",
        exitCode: 1,
        stdoutTail: "installing deps…",
        stderrTail: "TypeError: boom in astar.js:42",
        evaluatorSummary: "harness crashed before scoring",
      },
    });
    expect(ctx.mode).toBe("repair");
    expect(ctx.systemPrompt).toBe(REPAIR_SYSTEM_PROMPT);
    expect(ctx.systemPrompt).toContain("The FIRST successful yield terminates this episode and is the goal");
    expect(ctx.systemPrompt).toContain("Protected assets are unavailable");
    expect(ctx.role).toBe("repair");
    expect(EpisodeContext.parse(ctx)).toEqual(ctx);
    expect(ctx.userPrompt).toContain("mutation session failed (exit 1, episode 2)");
    expect(ctx.userPrompt).toContain("TypeError: boom in astar.js:42");
    expect(ctx.userPrompt).toContain("harness crashed before scoring");
  });
});
