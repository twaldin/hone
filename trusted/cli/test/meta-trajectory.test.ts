import { RunEvent, type BudgetState } from "@hone/schema";
import { describe, expect, it } from "vitest";
import { extractAnytimePoints } from "../src/meta-trajectory.js";

const hash = `sha256:${"a".repeat(64)}`;
const candidate = `sha256:${"b".repeat(64)}`;
const at = "2026-07-15T00:00:00.000Z";
const envelope = { maxTokens: 100, maxUsd: 1, maxWallClockSec: 100, maxEvaluatorInvocations: 10 };

function budget(tokens: number): BudgetState {
  return {
    envelope,
    spent: { tokens, usd: 0, wallClockSec: tokens, evaluatorInvocations: tokens === 0 ? 0 : 1 },
  };
}

describe("meta recursive trajectory extraction", () => {
  it("keeps the first unscoped evaluation as baseline and ignores later promotion probes", () => {
    const events = [
      RunEvent.parse({ runId: "run", at, type: "run.started", capsuleId: "cap", contractHash: hash, optimizerDigest: hash }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(0) }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 0, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: 0.2, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(5) }),
      RunEvent.parse({ runId: "run", at, type: "episode.candidate", episode: 0, candidate: { hash: candidate }, sessionTrace: hash }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", episode: 0, artifact: { hash: candidate }, assetGroupId: "train", seed: 0, aggregate: 0.4, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(15) }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash: candidate }, assetGroupId: "train", seed: 0, aggregate: 0.1, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(20) }),
      RunEvent.parse({ runId: "run", at, type: "run.finished", best: { hash: candidate }, status: "completed" }),
    ];

    expect(extractAnytimePoints(events)).toEqual([
      {
        ordinal: 0,
        eventCursor: 3,
        episode: null,
        candidateArtifact: hash,
        status: "evaluated",
        score: 0.2,
        bestScore: 0.2,
        cached: false,
        spent: { tokens: 5, usd: 0, wallClockSec: 5, evaluatorInvocations: 1 },
      },
      {
        ordinal: 1,
        eventCursor: 6,
        episode: 0,
        candidateArtifact: candidate,
        status: "evaluated",
        score: 0.4,
        bestScore: 0.4,
        cached: false,
        spent: { tokens: 15, usd: 0, wallClockSec: 15, evaluatorInvocations: 1 },
      },
    ]);
  });
});
