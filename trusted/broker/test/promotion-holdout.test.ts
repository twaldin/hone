import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleManifest, PromotionHoldoutRecord, PromotionHoldoutSplit } from "@hone/schema";
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
import { admitCapsule } from "../../cli/src/admission.js";

const HASH = (digit: string) => `sha256:${digit.repeat(64)}`;
const CAPSULE_DIGEST = HASH("a");
const CAMPAIGN_IDENTITY = HASH("b");
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

  test("parses the corrected real-data record and resolves every receipt citation", () => {
    const results = JSON.parse(readFileSync(
      new URL("../../../data/hone-m2-holdout/corrected-pilot-results.v2.json", import.meta.url),
      "utf8",
    ));
    const record = PromotionHoldoutRecord.parse(results.promotionRecord);
    const receipts = readFileSync(
      new URL("../../../data/hone-m2-holdout/corrected-pilot-evaluations.v2.ndjson", import.meta.url),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const cited = new Set(results.receiptDigests);

    expect(record).toMatchObject({
      status: "unmeasurable",
      claimable: false,
      holdout: { assetGroupId: "promotion-holdout", holdoutUnits: 20 },
    });
    expect(receipts).toHaveLength(3);
    expect(receipts.every((row) => cited.has(row.recordDigest))).toBe(true);
    expect(receipts.every((row) => row.record.assetGroupId === record.holdout.assetGroupId)).toBe(true);
  });

  test("parses the corrected tradeup record and resolves every receipt citation", () => {
    const results = JSON.parse(readFileSync(
      new URL("../../../data/hone-m2-holdout/corrected-tradeup-results.v2.json", import.meta.url),
      "utf8",
    ));
    const record = PromotionHoldoutRecord.parse(results.promotionRecord);
    const receipts = readFileSync(
      new URL("../../../data/hone-m2-holdout/corrected-tradeup-evaluations.v2.ndjson", import.meta.url),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const cited = new Set(results.receiptDigests);

    expect(record).toMatchObject({
      status: "supported",
      claimable: true,
      holdout: { assetGroupId: "promotion-holdout", holdoutUnits: 20 },
    });
    expect(receipts).toHaveLength(3);
    expect(receipts.every((row) => cited.has(row.recordDigest))).toBe(true);
    expect(receipts.every((row) => row.record.assetGroupId === record.holdout.assetGroupId)).toBe(true);
  });

  test("boots the trusted broker from both audited real-data split ledgers", async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const temporaryRoot = mkdtempSync(join(tmpdir(), "hone-audited-holdout-"));
    try {
      for (const spec of [
        {
          label: "flt-text-input",
          ledger: "audited-flt-split.v2.json",
          materialize: (root: string) => {
            mkdirSync(join(root, "train"), { recursive: true });
            mkdirSync(join(root, "promotion-holdout"), { recursive: true });
            copyFileSync(join(repositoryRoot, "capsules/flt-text-input/assets/train/cases.json"), join(root, "train/cases.json"));
            copyFileSync(join(repositoryRoot, "capsules/flt-text-input/assets/validation/cases.json"), join(root, "promotion-holdout/cases.json"));
          },
        },
        {
          label: "tradeup-profit",
          ledger: "audited-tradeup-split.v2.json",
          materialize: (root: string) => {
            mkdirSync(join(root, "train"), { recursive: true });
            mkdirSync(join(root, "promotion-holdout"), { recursive: true });
            copyFileSync(join(repositoryRoot, "capsules/tradeup-profit/assets/train/cases.json"), join(root, "train/cases.json"));
            const validation = JSON.parse(readFileSync(join(repositoryRoot, "capsules/tradeup-profit/assets/validation/cases.json"), "utf8"));
            const holdout = JSON.parse(readFileSync(join(repositoryRoot, "capsules/tradeup-profit/assets/holdout/cases.json"), "utf8"));
            writeFileSync(
              join(root, "promotion-holdout/cases.json"),
              JSON.stringify({ ...validation, cases: [...validation.cases, ...holdout.cases], split: "promotion-holdout" }) + "\n",
            );
          },
        },
      ]) {
        const admitted = admitCapsule(join(repositoryRoot, "capsules", spec.label));
        const ledger = JSON.parse(readFileSync(join(repositoryRoot, "data/hone-m2-holdout", spec.ledger), "utf8"));
        const split = PromotionHoldoutSplit.parse(ledger.split);
        assertPromotionHoldoutSplitIdentity(split);
        const capsuleRoot = join(temporaryRoot, spec.label, "capsule");
        spec.materialize(capsuleRoot);
        const manifest = CapsuleManifest.parse({
          ...admitted.manifest,
          assetGroups: [
            { id: "train", visibility: "public", paths: ["train"] },
            { id: "promotion-holdout", visibility: "holdout", paths: ["promotion-holdout"] },
          ],
          contentHashes: {
            "train/cases.json": split.train.units[0]!.containerHash,
            "promotion-holdout/cases.json": split.holdout.units[0]!.containerHash,
          },
        });
        const runDir = join(temporaryRoot, spec.label, "run");
        const broker = new Broker({
          runId: `run_audited_${spec.label}`,
          manifest,
          capsuleRootDir: capsuleRoot,
          baselineArtifactHash: `sha256:${"0".repeat(64)}`,
          capsuleDigest: admitted.digest,
          optimizerDigest: `sha256:${"1".repeat(64)}`,
          promotionHoldoutSplit: split,
          holdoutLedgerPath: join(runDir, "holdout.ndjson"),
          image: admitted.manifest.image,
          runDir,
          casDir: join(temporaryRoot, spec.label, "cas"),
          onEvent: () => {},
        });
        await broker.close();
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
