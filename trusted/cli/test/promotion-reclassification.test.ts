import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2 } from "@hone/broker";
import {
  CAMPAIGN_12_PROMOTION_CUTOFF,
  deriveCampaign12PromotionReclassification,
} from "../src/promotion-reclassification.js";

function event(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: "run_meta_fixture",
    at: "2026-08-27T23:00:00.000Z",
    ...overrides,
  };
}

describe("campaign-12 promotion reclassification", () => {
  it("is identity-bound, deterministic, confidence-aware, and read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "hone-reclassification-"));
    const runDir = join(root, `run_meta_${"a".repeat(64)}`);
    mkdirSync(runDir);
    const manifestSource = fileURLToPath(new URL(
      "../../../capsules/floyd-block-search-render/manifest.json",
      import.meta.url,
    ));
    const manifestBytes = readFileSync(manifestSource);
    writeFileSync(join(runDir, "capsule-manifest.json"), manifestBytes);
    const floyd = CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V2.find(
      (entry) => entry.capsuleId === "cap_f11c10c3fc15",
    );
    if (floyd === undefined) throw new Error("missing Floyd calibration fixture");
    writeFileSync(
      join(runDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "eval", measurementEpoch: floyd.measurementEpochs[0] })}\n`,
    );
    const candidateEval = (episode: number) => event({
      type: "eval.completed",
      episode,
      assetGroupId: "train",
      artifact: { hash: `sha256:${String(episode).repeat(64)}` },
      seed: episode,
      aggregate: 1,
      cached: false,
    });
    const events = [
      event({ type: "run.started", capsuleId: "cap_f11c10c3fc15" }),
      candidateEval(0),
      event({ type: "gate.paired", episode: 0, parentScore: 1, childScore: 1.01, passed: true }),
      event({ type: "incumbent.new", episode: 0, artifact: { hash: `sha256:${"b".repeat(64)}` } }),
      candidateEval(1),
      event({ at: CAMPAIGN_12_PROMOTION_CUTOFF, type: "gate.paired", episode: 1, parentScore: 1, childScore: 1.05, passed: true }),
      event({ at: CAMPAIGN_12_PROMOTION_CUTOFF, type: "incumbent.new", episode: 1, artifact: { hash: `sha256:${"c".repeat(64)}` } }),
      event({ type: "incumbent.new", episode: 2, artifact: { hash: `sha256:${"d".repeat(64)}` } }),
      candidateEval(3),
      event({ type: "gate.paired", episode: 3, parentScore: 1, childScore: 1.025, passed: true }),
      event({ type: "incumbent.new", episode: 3, artifact: { hash: `sha256:${"e".repeat(64)}` } }),
    ];
    const source = `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const eventPath = join(runDir, "events.ndjson");
    writeFileSync(eventPath, source);
    const staleRunDir = join(root, `run_meta_${"f".repeat(64)}`);
    mkdirSync(staleRunDir);
    writeFileSync(join(staleRunDir, "capsule-manifest.json"), manifestBytes);
    writeFileSync(
      join(staleRunDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "eval", measurementEpoch: "m2:stale-unmeasured-epoch" })}\n`,
    );
    const staleRunId = "run_meta_stale_identity_fixture";
    const staleEvents = [
      event({ runId: staleRunId, type: "run.started", capsuleId: "cap_f11c10c3fc15" }),
      { ...candidateEval(0), runId: staleRunId },
      event({ runId: staleRunId, type: "gate.paired", episode: 0, parentScore: 1, childScore: 1.05, passed: true }),
      event({ runId: staleRunId, type: "incumbent.new", episode: 0, artifact: { hash: `sha256:${"f".repeat(64)}` } }),
    ];
    writeFileSync(
      join(staleRunDir, "events.ndjson"),
      `${staleEvents.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const first = deriveCampaign12PromotionReclassification(root);
    const second = deriveCampaign12PromotionReclassification(root);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.summary).toEqual({
      totalPromotions: 5,
      survive: 1,
      insideNoiseFloor: 1,
      indeterminate: 3,
    });
    expect(first.promotions.filter((promotion) => promotion.indeterminateKind === "data-availability")).toHaveLength(2);
    expect(first.promotions.filter((promotion) => promotion.indeterminateKind === "confidence")).toHaveLength(1);
    expect(first.promotions.filter((promotion) => promotion.classification === "genuine")).toHaveLength(1);
    expect(first.promotions.some((promotion) =>
      promotion.reasoning === "no full identity-bound campaign-12 calibration for this run"
    )).toBe(true);
    expect(readFileSync(eventPath, "utf8")).toBe(source);
    expect(readFileSync(join(runDir, "capsule-manifest.json"))).toEqual(manifestBytes);
  });
});

const RECORDED_CAMPAIGN_12_RUNS =
  "/home/tim/omp-firstmate/worktrees/m2-exec-runtime-12/.hone-runs";

describe("recorded campaign-12 journal", () => {
  it("reclassifies the fixed identity-bound 74-promotion cohort deterministically", () => {
    expect(existsSync(RECORDED_CAMPAIGN_12_RUNS)).toBe(true);
    const first = deriveCampaign12PromotionReclassification(RECORDED_CAMPAIGN_12_RUNS);
    const second = deriveCampaign12PromotionReclassification(RECORDED_CAMPAIGN_12_RUNS);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.input.observedLegacyGates).toBe(149);
    expect(first.summary).toEqual({
      totalPromotions: 74,
      survive: 48,
      insideNoiseFloor: 21,
      indeterminate: 5,
    });
    expect(first.sensitivity).toEqual({
      maxSpan: { survive: 48, rejected: 26 },
      p99: { survive: 53, rejected: 21 },
      threeSd: { survive: 53, rejected: 21 },
      p95: { survive: 55, rejected: 19 },
      twoSd: { survive: 56, rejected: 18 },
    });
  });
});
