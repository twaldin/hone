import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  it("is byte-input deterministic and does not rewrite historical events", () => {
    const root = mkdtempSync(join(tmpdir(), "hone-reclassification-"));
    const runDir = join(root, `run_meta_${"a".repeat(64)}`);
    mkdirSync(runDir);
    const events = [
      event({ type: "run.started", capsuleId: "cap_f11c10c3fc15" }),
      event({ type: "gate.paired", episode: 0, parentScore: 1, childScore: 1.01, passed: true }),
      event({ type: "incumbent.new", episode: 0, artifact: { hash: `sha256:${"b".repeat(64)}` } }),
      event({ at: CAMPAIGN_12_PROMOTION_CUTOFF, type: "gate.paired", episode: 1, parentScore: 1, childScore: 1.05, passed: true }),
      event({ at: CAMPAIGN_12_PROMOTION_CUTOFF, type: "incumbent.new", episode: 1, artifact: { hash: `sha256:${"c".repeat(64)}` } }),
    ];
    const source = `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const eventPath = join(runDir, "events.ndjson");
    writeFileSync(eventPath, source);

    const first = deriveCampaign12PromotionReclassification(root);
    const second = deriveCampaign12PromotionReclassification(root);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.summary).toEqual({
      totalPromotions: 2,
      survive: 1,
      insideNoiseEnvelope: 1,
      indeterminate: 0,
    });
    expect(first.promotions.map((promotion) => promotion.classification)).toEqual([
      "noise-attributable",
      "genuine",
    ]);
    expect(readFileSync(eventPath, "utf8")).toBe(source);
  });
});

const RECORDED_CAMPAIGN_12_RUNS =
  "/home/tim/omp-firstmate/worktrees/m2-exec-runtime-12/.hone-runs";

describe.runIf(existsSync(RECORDED_CAMPAIGN_12_RUNS))("recorded campaign-12 journal", () => {
  it("reclassifies the fixed 74-promotion cohort deterministically", () => {
    const first = deriveCampaign12PromotionReclassification(RECORDED_CAMPAIGN_12_RUNS);
    const second = deriveCampaign12PromotionReclassification(RECORDED_CAMPAIGN_12_RUNS);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.input.observedLegacyGates).toBe(149);
    expect(first.summary).toEqual({
      totalPromotions: 74,
      survive: 48,
      insideNoiseEnvelope: 26,
      indeterminate: 0,
    });
  });
});
