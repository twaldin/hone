import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
});
