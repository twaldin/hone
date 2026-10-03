import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunEvent, type BudgetState } from "@hone/schema";
import { describe, expect, it, vi } from "vitest";
import { completeSearchCommandRun } from "../src/commands/hone.js";
import { readEvents } from "../src/eventlog.js";
import { controllerSpendDelta, extractAnytimePoints } from "../src/meta-trajectory.js";

const at = "2026-08-24T20:53:08.432Z";
const hash = `sha256:${"a".repeat(64)}`;
const candidate0 = `sha256:${"6".repeat(64)}`;
const candidate1 = `sha256:${"2".repeat(64)}`;
const envelope = {
  maxTokens: 5_000_000,
  maxUsd: 25,
  maxWallClockSec: 200_000,
  maxEvaluatorInvocations: 30,
};

function snapshot(tokens: number, wallClockSec: number, evaluatorInvocations: number): BudgetState {
  return {
    envelope,
    spent: { tokens, usd: 0, wallClockSec, evaluatorInvocations },
  };
}

function campaign8OuterRun(): string {
  const root = mkdtempSync(join(tmpdir(), "hone-campaign8-boundary-"));
  const runDir = join(root, "outer");
  mkdirSync(runDir);
  const events = [
    RunEvent.parse({ runId: "run", at, type: "run.started", capsuleId: "cap", contractHash: hash, optimizerDigest: hash }),
    RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: snapshot(0, 0, 0) }),
    RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 0, parent: { hash } }),
    RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: 0.2, cached: false }),
    RunEvent.parse({ runId: "run", at, type: "episode.candidate", episode: 0, candidate: { hash: candidate0 }, sessionTrace: hash }),
    RunEvent.parse({ runId: "run", at, type: "episode.invalid", episode: 0, repaired: false, reason: "trusted recursive panel returned a null aggregate" }),
    RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: snapshot(183_548, 16_227.713, 2) }),
    RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 0 }),
    RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 1, parent: { hash: candidate0 } }),
    RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash: candidate0 }, assetGroupId: "train", seed: 0, aggregate: null, cached: false }),
    RunEvent.parse({ runId: "run", at, type: "episode.candidate", episode: 1, candidate: { hash: candidate1 }, sessionTrace: hash }),
    RunEvent.parse({ runId: "run", at, type: "episode.invalid", episode: 1, repaired: false, reason: "trusted candidate refused" }),
    RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: snapshot(240_000, 22_082.402, 5) }),
    RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 1 }),
    RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 2, parent: { hash: candidate0 } }),
  ];
  writeFileSync(join(runDir, "events.ndjson"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return runDir;
}

describe("search command failure boundary", () => {
  it("replays Campaign-8's refused episode and preserves the primary resume exit without masking", () => {
    const outerRunDir = campaign8OuterRun();
    const reports: string[] = [];
    const persistTrajectory = vi.fn(() => {
      const points = extractAnytimePoints(readEvents(outerRunDir));
      expect(points.map((point) => [point.episode, point.status])).toEqual([
        [null, "evaluated"],
        [0, "invalid"],
        [1, "invalid"],
        [2, "invalid"],
      ]);
      const delta = controllerSpendDelta(points[2]!.spent, points[1]!.spent, 1);
      expect(delta).toMatchObject({
        tokens: 56_452,
        usd: 0,
        evaluatorInvocations: 3,
      });
      expect(delta.wallClockSec).toBeCloseTo(5_854.689, 6);
      return "/trajectory.json";
    });

    expect(completeSearchCommandRun({
      exitCode: 1,
      outerRunDir,
      persistTrajectory,
      reportSecondaryFailure: (message) => reports.push(message),
    })).toBe(1);
    expect(persistTrajectory).toHaveBeenCalledOnce();
    expect(reports).toEqual([]);
  });

  it("reports a secondary production guard error without replacing the primary exit", () => {
    const reports: string[] = [];
    expect(completeSearchCommandRun({
      exitCode: 1,
      outerRunDir: campaign8OuterRun(),
      persistTrajectory: () => {
        controllerSpendDelta(snapshot(0, 0, 0).spent, snapshot(183_548, 16_227.713, 2).spent, 1);
        return "/unreachable";
      },
      reportSecondaryFailure: (message) => reports.push(message),
    })).toBe(1);
    expect(reports).toEqual([
      "search optimizer exited 1; partial trajectory persistence also failed without replacing the primary failure: candidate ordinal 1 regresses trusted controller spend",
    ]);
  });

  it("does not suppress trajectory failures after a successful optimizer exit", () => {
    expect(() => completeSearchCommandRun({
      exitCode: 0,
      outerRunDir: campaign8OuterRun(),
      persistTrajectory: () => {
        throw new Error("trajectory corrupt");
      },
      reportSecondaryFailure: () => {},
    })).toThrow("trajectory corrupt");
  });
});
