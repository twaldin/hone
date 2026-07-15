import { describe, expect, it } from "vitest";
import type { BudgetState, EvaluationRecord } from "@hone/schema";
import { buildEpisodeContext } from "../assets/context.js";
import { maxFeedbackChars } from "../assets/policy.js";
import { MUTATION_SYSTEM_PROMPT, REPAIR_SYSTEM_PROMPT } from "../assets/prompts.js";
import { EpisodeContext } from "../src/episode.js";

/** Golden-ish contract: the reflective loop EATS feedback blobs — they must reach the prompt. */

const budget: BudgetState = {
  envelope: { maxTokens: 1_000_000, maxUsd: 50, maxWallClockSec: 7200, maxEvaluatorInvocations: 10 },
  spent: { tokens: 250_000, usd: 12.5, wallClockSec: 1800, evaluatorInvocations: 3 },
};

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
    });

    expect(EpisodeContext.parse(ctx)).toEqual(ctx);
    expect(ctx.mode).toBe("mutation");
    expect(ctx.episode).toBe(4);
    expect(ctx.systemPrompt).toBe(MUTATION_SYSTEM_PROMPT);

    expect(ctx.userPrompt).toContain("make the pathfinder fast, keep correctness");
    // Per-example scores AND untouched feedback blobs (string and structured).
    expect(ctx.userPrompt).toContain("maze_04: score=0.2");
    expect(ctx.userPrompt).toContain("TimeoutError: search exceeded 5s on maze_04 (expanded 9M nodes)");
    expect(ctx.userPrompt).toContain('{"runtimeMs":12,"note":"already optimal"}');
    expect(ctx.userPrompt).toContain("objective runtime: 0.42");
    expect(ctx.userPrompt).toContain("2/3 mazes within budget");
    // Lineage with signed deltas.
    expect(ctx.userPrompt).toContain("episode 0: memoize-neighbors (delta +0.0200)");
    expect(ctx.userPrompt).toContain("episode 2: binary-heap-frontier (delta -0.0100)");
    // Remaining budget, not raw spend.
    expect(ctx.userPrompt).toContain("tokens: 750000 of 1000000 left");
    expect(ctx.userPrompt).toContain("evaluations: 7 of 10 left");
  });

  it("truncates oversized feedback blobs at the policy bound", () => {
    const huge = "x".repeat(maxFeedbackChars + 500);
    const ctx = buildEpisodeContext({
      episode: 0,
      objective: "obj",
      parentEvaluation: record({ big: { score: 0, feedback: huge } }),
      lineage: [],
      budget,
    });
    expect(ctx.userPrompt).toContain("… [truncated]");
    expect(ctx.userPrompt).not.toContain(huge);
  });

  it("switches to the repair frame and carries the failure evidence", () => {
    const ctx = buildEpisodeContext({
      episode: 2,
      objective: "obj",
      parentEvaluation: record({}),
      lineage: [],
      budget,
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
    expect(ctx.userPrompt).toContain("mutation session failed (exit 1, episode 2)");
    expect(ctx.userPrompt).toContain("TypeError: boom in astar.js:42");
    expect(ctx.userPrompt).toContain("harness crashed before scoring");
  });
});
