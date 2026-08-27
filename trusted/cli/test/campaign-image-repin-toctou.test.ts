import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MetaCampaignConfigV2 } from "@hone/schema";
import { describe, expect, test, vi } from "vitest";
import { repinCampaignImage } from "../src/commands/hone.js";
import { makeRoot } from "./helpers.js";

const forgeState = vi.hoisted(() => ({
  evidencePath: null as string | null,
  readCount: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && forgeState.evidencePath !== null && path === forgeState.evidencePath) {
        forgeState.readCount += 1;
        if (forgeState.readCount >= 2) {
          return Buffer.from("{\"forged\":\"swapped-after-validation\"}\n");
        }
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof NodeFs.readFileSync,
  };
});

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const preservedPath = join(repoRoot, "data/m2-refreeze-final/campaign-frozen.json");
const TO_IMAGE = `hone-equivalent@sha256:${"a".repeat(64)}`;

function sha256(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function distribution(artifact: string, historicalScore: number, rawScores: number[]) {
  const min = Math.min(...rawScores);
  const max = Math.max(...rawScores);
  const mean = rawScores.reduce((sum, score) => sum + score, 0) / rawScores.length;
  return {
    artifact,
    historicalScore,
    rawScores,
    min,
    max,
    mean,
    selfSpread: (max - min) / Math.abs(mean),
    relativeMeanOffset: Math.abs(historicalScore - mean) / Math.abs(mean),
  };
}

describe("campaign repin-image evidence commit", () => {
  test("refuses evidence bytes swapped after validation and leaves the campaign untouched", () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    const before = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(preservedPath, "utf8")));
    const capsule = before.train[0]!;
    const originalBytes = `${JSON.stringify(before, null, 2)}\n`;
    writeFileSync(campaignPath, originalBytes);
    const evidencePath = join(root, "evidence", "toctou.json");
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify({
      version: 1,
      generatedAt: "2026-08-27T01:00:00.000Z",
      capsuleId: capsule.capsuleId,
      fromImage: capsule.image,
      toImage: TO_IMAGE,
      baseline: {
        artifact: `sha256:${"1".repeat(64)}`,
        recordedScore: 0.25,
        reproducedScores: [0.25, 0.25, 0.25],
      },
      settledCandidate: {
        artifact: `sha256:${"2".repeat(64)}`,
        recordedScore: 0.5,
        reproducedScores: [0.5, 0.5, 0.5],
      },
      tripwires: [{ name: "capsule determinism and shortcut tripwires", passed: true }],
      modelCalls: 0,
      result: "passed",
    }, null, 2)}\n`);

    forgeState.evidencePath = evidencePath;
    forgeState.readCount = 0;
    try {
      expect(() => repinCampaignImage({
        root,
        campaignPath,
        capsuleId: capsule.capsuleId,
        fromImage: capsule.image,
        toImage: TO_IMAGE,
        evidencePath,
        reason: "TOCTOU regression",
        at: "2026-08-27T02:20:00.000Z",
      })).toThrow("evidence changed during re-pin");
    } finally {
      forgeState.evidencePath = null;
    }
    expect(readFileSync(campaignPath, "utf8")).toBe(originalBytes);
  });

  test("refuses a pre-registration swapped after validation and leaves the campaign untouched", () => {
    const scratch = makeRoot();
    const campaignPath = join(scratch, "campaign-frozen.json");
    const before = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(preservedPath, "utf8")));
    const capsule = before.train.find((entry) => entry.capsuleId === "cap_93f9f6942024")!;
    chmodSync(join(repoRoot, ".hone-cas", "admission-receipts"), 0o700);
    chmodSync(
      join(repoRoot, ".hone-cas", "admission-receipts", `${capsule.capsuleDigest.slice("sha256:".length)}.ndjson`),
      0o600,
    );
    const originalBytes = `${JSON.stringify(before, null, 2)}\n`;
    writeFileSync(campaignPath, originalBytes);
    const evidenceDir = join(scratch, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const preRegistrationPath = join(evidenceDir, "distribution-preregistration.v1.json");
    const evidencePath = join(evidenceDir, "distribution-equivalence.v1.json");
    const sourcePath = join(repoRoot, "capsules/biome-parser-formatter/baseline/eval.py");
    const sourceBytes = readFileSync(sourcePath);
    const proof = {
      evaluatorSourcePath: "capsules/biome-parser-formatter/baseline/eval.py",
      evaluatorSourceSha256: sha256(sourceBytes),
      seedEnvironmentVariable: "HONE_SEED",
      entropySources: [
        { line: 815, exactSourceLine: "            measured_nonce = secrets.randbits(63)" },
      ],
      timingSources: [
        { line: 431, exactSourceLine: "        started = time.perf_counter_ns()" },
      ],
    };
    const baseline = { artifact: `sha256:${"1".repeat(64)}`, historicalScore: 10 };
    const settledCandidate = { artifact: `sha256:${"2".repeat(64)}`, historicalScore: 20 };
    const preRegistrationBytes = `${JSON.stringify({
      version: 1,
      evidenceMode: "distribution-preregistration",
      registeredAt: "2026-08-27T04:00:00.000Z",
      capsuleId: capsule.capsuleId,
      fromImage: capsule.image,
      toImage: TO_IMAGE,
      structuralNondeterminism: proof,
      measurementPlan: { replicatesPerArtifact: 12, k: 0.5 },
      baseline,
      settledCandidate,
    }, null, 2)}\n`;
    writeFileSync(preRegistrationPath, preRegistrationBytes);
    writeFileSync(evidencePath, `${JSON.stringify({
      version: 1,
      evidenceMode: "distribution",
      generatedAt: "2026-08-27T04:30:00.000Z",
      measurementStartedAt: "2026-08-27T04:01:00.000Z",
      measurementCompletedAt: "2026-08-27T04:29:00.000Z",
      capsuleId: capsule.capsuleId,
      fromImage: capsule.image,
      toImage: TO_IMAGE,
      preRegistrationPath: "distribution-preregistration.v1.json",
      preRegistrationSha256: sha256(preRegistrationBytes),
      structuralNondeterminism: proof,
      k: 0.5,
      exploratoryMeasurements: {
        excluded: true,
        statement: "Pre-registration measurements were exploratory and are excluded; only post-pre-registration measurements are confirmatory.",
      },
      baseline: distribution(baseline.artifact, baseline.historicalScore, [9, 11, 9, 11, 9, 11, 9, 11, 9, 11, 9, 11]),
      settledCandidate: distribution(
        settledCandidate.artifact,
        settledCandidate.historicalScore,
        [18, 22, 18, 22, 18, 22, 18, 22, 18, 22, 18, 22],
      ),
      tripwires: [{ name: "ordering", passed: true }],
      modelCalls: 0,
      result: "passed",
    }, null, 2)}\n`);

    forgeState.evidencePath = preRegistrationPath;
    forgeState.readCount = 0;
    try {
      expect(() => repinCampaignImage({
        root: repoRoot,
        campaignPath,
        capsuleId: capsule.capsuleId,
        fromImage: capsule.image,
        toImage: TO_IMAGE,
        evidencePath,
        reason: "distribution TOCTOU regression",
        at: "2026-08-27T04:31:00.000Z",
      })).toThrow("distribution evidence input changed during re-pin");
    } finally {
      forgeState.evidencePath = null;
    }
    expect(readFileSync(campaignPath, "utf8")).toBe(originalBytes);
  });
});
