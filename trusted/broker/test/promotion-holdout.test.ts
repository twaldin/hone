import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapsuleManifest } from "@hone/schema";
import { describe, expect, test } from "vitest";
import {
  assertPromotionHoldoutSplitIdentity,
  buildHoldoutNullControl,
  buildPromotionHoldoutRecord,
  createPromotionHoldoutSplit,
  derivePromotionHoldoutSeed,
  promotionHoldoutSplitSummary,
} from "../src/promotion-holdout.js";
import { Broker } from "../src/broker.js";

const HASH = (digit: string) => `sha256:${digit.repeat(64)}`;
const CAPSULE_DIGEST = HASH("a");
const CAMPAIGN_IDENTITY = HASH("b");
const EXECUTION_IMAGE_OVERRIDE = `hone-holdout-test@sha256:${"2".repeat(64)}`;
const FROZEN_AT = "2026-08-28T00:00:00.000Z";

function units(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index.toString().padStart(2, "0")}`,
    achievableScoreMax: 1,
    contentHash: HASH(((index % 9) + 1).toString()),
    selector: "",
    trainContainerHash: HASH(((index % 9) + 1).toString()),
    holdoutContainerHash: HASH(((index % 9) + 1).toString()),
    trainPath: `assets/train/case-${index}.json`,
    holdoutPath: `assets/holdout/case-${index}.json`,
  }));
}

function deterministicSplit(inputUnits = units(12), holdoutUnits = 2, minimumDetectableEffect = 0.05) {
  return createPromotionHoldoutSplit({
    capsuleId: "cap_0123456789ab",
    capsuleDigest: CAPSULE_DIGEST,
    campaignIdentity: CAMPAIGN_IDENTITY,
    frozenAt: FROZEN_AT,
    trainAssetGroupId: "train",
    holdoutAssetGroupId: "holdout",
    units: inputUnits,
    holdoutUnits,
    noiseClass: "deterministic-zero-noise",
    noiseEnvelope: 0,
    evaluationRepeats: 1,
    minimumDetectableEffect,
  });
}

describe("frozen promotion holdout split", () => {
  test("derives its seed from pre-split identities and is input-order independent", () => {
    const forward = deterministicSplit();
    const reversed = deterministicSplit([...units(12)].reverse());

    expect(reversed).toEqual(forward);
    expect(derivePromotionHoldoutSeed(CAMPAIGN_IDENTITY, CAPSULE_DIGEST)).toMatch(/^sha256:/);
    expect(forward.seedDerivation).toEqual({
      algorithm: "sha256-campaign-capsule-v1",
      domain: "hone-promotion-holdout-seed-v1",
      campaignIdentity: CAMPAIGN_IDENTITY,
    });
    expect(forward.designEligibility).toBe("instrumentation-only");
    expect(() => assertPromotionHoldoutSplitIdentity(forward)).not.toThrow();
  });

  test("rejects assignment or byte tampering under a retained split identity", () => {
    const split = deterministicSplit();
    const tampered = structuredClone(split);
    tampered.holdout.units[0]!.contentHash = HASH("f");
    expect(() => assertPromotionHoldoutSplitIdentity(tampered)).toThrow(/identity|population/);
  });

  test("redacts unit identities and paths from the event summary", () => {
    const summary = promotionHoldoutSplitSummary(deterministicSplit());
    expect(summary).toMatchObject({ holdoutUnits: 2, trainUnits: 10 });
    expect(JSON.stringify(summary)).not.toContain("case-00");
    expect(JSON.stringify(summary)).not.toContain("assets/holdout");
  });
});

describe("promotion holdout assessment", () => {
  test("marks a saturated instrument unmeasurable rather than overfit", () => {
    const split = deterministicSplit(units(25), 20, 0.05);
    const nullControl = buildHoldoutNullControl({
      splitId: split.splitId,
      artifactHash: HASH("1"),
      assetGroupId: "holdout",
      seeds: [0, 1],
      scores: [0.8, 0.8],
      recordedAt: FROZEN_AT,
    });
    const record = buildPromotionHoldoutRecord({
      artifactHash: HASH("2"),
      parentArtifactHash: HASH("1"),
      split,
      gateVersion: "noise-envelope-v2",
      noiseDecision: "promote",
      trainParentScore: 0.3,
      trainChildScore: 0.6,
      holdoutParentScores: [0.8],
      holdoutChildScores: [0.8],
      seeds: [0],
      nullControl,
      recordedAt: FROZEN_AT,
    });

    expect(record.holdout.headroom).toBeCloseTo(0.2);
    expect(record.training.noiseDecision).toBe("promote");
    expect(record.status).toBe("unmeasurable");
    expect(record.claimable).toBe(false);
    expect(record.nullControl).toMatchObject({ estimator: "sample-sd-v1", sampleStandardDeviation: 0 });
  });

  test("can record overfit only when granularity, headroom, and deterministic null support it", () => {
    const split = deterministicSplit(units(25), 20, 0.05);
    const nullControl = buildHoldoutNullControl({
      splitId: split.splitId,
      artifactHash: HASH("1"),
      assetGroupId: "holdout",
      seeds: [0, 1],
      scores: [0.2, 0.2],
      recordedAt: FROZEN_AT,
    });
    const record = buildPromotionHoldoutRecord({
      artifactHash: HASH("2"),
      parentArtifactHash: HASH("1"),
      split,
      gateVersion: "noise-envelope-v2",
      noiseDecision: "promote",
      trainParentScore: 0.3,
      trainChildScore: 0.6,
      holdoutParentScores: [0.2],
      holdoutChildScores: [0.2],
      seeds: [0],
      nullControl,
      recordedAt: FROZEN_AT,
    });
    expect(record.status).toBe("overfit");
    expect(record.claimable).toBe(false);
  });

  test("accepts a different execution image but refuses a different admitted digest", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "hone-audited-holdout-"));
    try {
      const capsuleRoot = join(temporaryRoot, "capsule");
      // Whole-file units: the same bytes back each unit in train/ and holdout/.
      const fileUnits = Array.from({ length: 12 }, (_, index) => {
        const id = `case-${index.toString().padStart(2, "0")}`;
        const bytes = `${JSON.stringify({ id, input: [index, index + 1], expected: 2 * index + 1 })}\n`;
        const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        for (const group of ["train", "holdout"]) {
          mkdirSync(join(capsuleRoot, "assets", group), { recursive: true });
          writeFileSync(join(capsuleRoot, "assets", group, `${id}.json`), bytes);
        }
        return {
          id,
          achievableScoreMax: 1,
          contentHash: hash,
          selector: "",
          trainContainerHash: hash,
          holdoutContainerHash: hash,
          trainPath: `assets/train/${id}.json`,
          holdoutPath: `assets/holdout/${id}.json`,
        };
      });
      const split = deterministicSplit(fileUnits, 2);
      const fixtureManifest = JSON.parse(readFileSync(
        new URL("../../../schema/fixtures/capsule.seeded-astar.json", import.meta.url),
        "utf8",
      ));
      const manifest = CapsuleManifest.parse({
        ...fixtureManifest,
        id: split.capsuleId,
        assetGroups: [
          { id: "train", visibility: "public", paths: ["assets/train"] },
          { id: "holdout", visibility: "holdout", paths: ["assets/holdout"] },
        ],
        contentHashes: Object.fromEntries(fileUnits.flatMap((unit) => [
          [unit.trainPath, unit.trainContainerHash],
          [unit.holdoutPath, unit.holdoutContainerHash],
        ])),
      });
      const runDir = join(temporaryRoot, "run");
      const config = {
        runId: "run_audited_synthetic",
        manifest,
        capsuleRootDir: capsuleRoot,
        baselineArtifactHash: `sha256:${"0".repeat(64)}`,
        admittedCapsuleDigest: CAPSULE_DIGEST,
        optimizerDigest: `sha256:${"1".repeat(64)}`,
        promotionHoldoutSplit: split,
        holdoutLedgerPath: join(runDir, "holdout.ndjson"),
        executionImage: EXECUTION_IMAGE_OVERRIDE,
        runDir,
        casDir: join(temporaryRoot, "cas"),
        onEvent: () => {},
      };
      const broker = new Broker(config);
      await broker.close();
      expect(() => new Broker({
        ...config,
        admittedCapsuleDigest: HASH("f"),
      })).toThrow(/holdout split does not match the frozen capsule identity/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
