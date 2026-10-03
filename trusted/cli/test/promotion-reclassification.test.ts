import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3 } from "@hone/broker";
import type * as Schema from "@hone/schema";
import {
  CAMPAIGN_12_PROMOTION_CUTOFF,
  deriveCampaign12PromotionReclassification,
} from "../src/promotion-reclassification.js";
import { manifestRaw } from "./helpers.js";

/**
 * The shipped campaign-12 calibration is bound to the admitted digest of the
 * real Floyd capsule, which does not ship with the engine. The synthetic
 * manifest below stands in for it: exactly its digest is reported as the
 * calibrated admitted digest; every other manifest keeps its real digest.
 */
const standIn = vi.hoisted(() => ({ digest: null as string | null, admittedDigest: null as string | null }));

vi.mock("@hone/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof Schema>();
  return {
    ...actual,
    capsuleDigest: (manifest: Schema.CapsuleManifest) => {
      const digest = actual.capsuleDigest(manifest);
      return digest === standIn.digest && standIn.admittedDigest !== null ? standIn.admittedDigest : digest;
    },
  };
});

const FLOYD_ID = "cap_f11c10c3fc15";

function event(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: "run_meta_fixture",
    at: "2026-08-27T23:00:00.000Z",
    ...overrides,
  };
}

describe("campaign-12 promotion reclassification", () => {
  it("is identity-bound, deterministic, confidence-aware, and read-only", async () => {
    const { capsuleDigest, CapsuleManifest } = await vi.importActual<typeof Schema>("@hone/schema");
    const floyd = CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3.find((entry) => entry.capsuleId === FLOYD_ID);
    if (floyd === undefined) throw new Error("missing Floyd calibration fixture");
    const manifest = manifestRaw({ id: FLOYD_ID });
    standIn.digest = capsuleDigest(CapsuleManifest.parse(manifest));
    standIn.admittedDigest = floyd.admittedCapsuleDigest;

    const root = mkdtempSync(join(tmpdir(), "hone-reclassification-"));
    const runDir = join(root, `run_meta_${"a".repeat(64)}`);
    mkdirSync(runDir);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(runDir, "capsule-manifest.json"), manifestBytes);
    const campaignSession = `${JSON.stringify({ version: 1, capsuleImage: floyd.executionImage })}\n`;
    writeFileSync(join(runDir, "campaign-session.v1.json"), campaignSession);
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
      event({ type: "run.started", capsuleId: FLOYD_ID }),
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
    writeFileSync(join(staleRunDir, "campaign-session.v1.json"), campaignSession);
    writeFileSync(
      join(staleRunDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "eval", measurementEpoch: "m2:stale-unmeasured-epoch" })}\n`,
    );
    const staleRunId = "run_meta_stale_identity_fixture";
    const staleEvents = [
      event({ runId: staleRunId, type: "run.started", capsuleId: FLOYD_ID }),
      { ...candidateEval(0), runId: staleRunId },
      event({ runId: staleRunId, type: "gate.paired", episode: 0, parentScore: 1, childScore: 1.05, passed: true }),
      event({ runId: staleRunId, type: "incumbent.new", episode: 0, artifact: { hash: `sha256:${"f".repeat(64)}` } }),
    ];
    writeFileSync(
      join(staleRunDir, "events.ndjson"),
      `${staleEvents.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const staleImageRunDir = join(root, `run_meta_${"9".repeat(64)}`);
    mkdirSync(staleImageRunDir);
    writeFileSync(join(staleImageRunDir, "capsule-manifest.json"), manifestBytes);
    writeFileSync(
      join(staleImageRunDir, "campaign-session.v1.json"),
      `${JSON.stringify({ version: 1, capsuleImage: "changed-execution-image" })}\n`,
    );
    writeFileSync(
      join(staleImageRunDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "eval", measurementEpoch: floyd.measurementEpochs[0] })}\n`,
    );
    const staleImageRunId = "run_meta_stale_execution_image_fixture";
    writeFileSync(
      join(staleImageRunDir, "events.ndjson"),
      `${staleEvents.map((entry) => JSON.stringify({ ...entry, runId: staleImageRunId })).join("\n")}\n`,
    );
    const otherManifestRunDir = join(root, `run_meta_${"8".repeat(64)}`);
    mkdirSync(otherManifestRunDir);
    const otherManifestBytes = `${JSON.stringify(manifestRaw({ id: FLOYD_ID, objective: "A different capsule claiming the Floyd id." }), null, 2)}\n`;
    writeFileSync(join(otherManifestRunDir, "capsule-manifest.json"), otherManifestBytes);
    writeFileSync(join(otherManifestRunDir, "campaign-session.v1.json"), campaignSession);
    writeFileSync(
      join(otherManifestRunDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "eval", measurementEpoch: floyd.measurementEpochs[0] })}\n`,
    );
    const otherManifestRunId = "run_meta_other_manifest_fixture";
    writeFileSync(
      join(otherManifestRunDir, "events.ndjson"),
      `${staleEvents.map((entry) => JSON.stringify({ ...entry, runId: otherManifestRunId })).join("\n")}\n`,
    );

    const first = deriveCampaign12PromotionReclassification(root);
    const second = deriveCampaign12PromotionReclassification(root);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.summary).toEqual({
      totalPromotions: 7,
      survive: 1,
      insideNoiseFloor: 1,
      indeterminate: 5,
    });
    expect(first.promotions.filter((promotion) => promotion.indeterminateKind === "data-availability")).toHaveLength(4);
    expect(first.promotions.filter((promotion) => promotion.indeterminateKind === "confidence")).toHaveLength(1);
    expect(first.promotions.filter((promotion) => promotion.classification === "genuine")).toHaveLength(1);
    for (const runId of [staleRunId, staleImageRunId, otherManifestRunId]) {
      expect(first.promotions.find((promotion) => promotion.runId === runId)?.reasoning)
        .toBe("no full identity-bound campaign-12 calibration for this run");
    }
    expect(readFileSync(eventPath, "utf8")).toBe(source);
    expect(readFileSync(join(runDir, "capsule-manifest.json"))).toEqual(manifestBytes);
  });
});
