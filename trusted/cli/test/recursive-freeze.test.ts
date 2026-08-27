import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  campaignRuntimeClosureRecordDigest,
  metaCampaignConfigHash,
} from "@hone/meta";
import type { Sha256Digest } from "@hone/meta";
import { MetaCampaignConfigV2 } from "@hone/schema";
import { describe, expect, it, vi } from "vitest";
import {
  freezeRecursiveCampaignConfig,
  recursiveCommand,
} from "../src/commands/hone.js";
import type { CmdIo } from "../src/io.js";
import { assertM2OuterDirectEnvelope } from "../src/launch-draft.js";
import { verifiedBootRuntimeDigest } from "../src/runtime-digest.js";

const preservedPath = fileURLToPath(new URL(
  "../../../data/m2-refreeze-final/campaign-frozen.json",
  import.meta.url,
));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function preservedConfig(): MetaCampaignConfigV2 {
  return MetaCampaignConfigV2.parse(JSON.parse(readFileSync(preservedPath, "utf8")));
}

function freezeInputs(config: MetaCampaignConfigV2) {
  const target = {
    sourceArtifact: config.seedOptimizer.sourceArtifact,
    baseDigest: config.seedOptimizer.bundleDigest,
    mergedDigest: config.seedOptimizer.bundleDigest,
    mutablePaths: {},
    snapshot: { files: new Map() },
  };
  return {
    corpus: { train: config.train, holdout: config.holdout },
    identities: {
      sourceCommit: config.trustedRuntime.sourceCommit,
      runtimeDigest: config.trustedRuntime.digest,
      target,
      controller: {
        ...target,
        sourceArtifact: config.controllerOptimizer.sourceArtifact,
        mergedDigest: config.controllerOptimizer.bundleDigest,
      },
      brokenControl: {
        sourceArtifact: config.controls.brokenSourceArtifact,
        bundleDigest: config.controls.brokenBundleDigest,
        transformationReceipt: {},
      },
      degradedControl: {
        sourceArtifact: config.controls.degradedSourceArtifact,
        bundleDigest: config.controls.degradedBundleDigest,
        transformationReceipt: {},
      },
    },
  };
}

describe("recursive freeze envelope enforcement", () => {
  it("executes the freeze-time envelope gate before emitting a frozen config", () => {
    const config = preservedConfig();
    const { corpus, identities } = freezeInputs(config);
    const enforced = vi.fn((_candidate: Parameters<typeof assertM2OuterDirectEnvelope>[0]) => {
      throw new Error("freeze-envelope-gate-reached");
    });
    expect(() => freezeRecursiveCampaignConfig(
      config,
      corpus,
      identities as never,
      enforced,
    )).toThrow("freeze-envelope-gate-reached");
    expect(enforced).toHaveBeenCalledOnce();
  });

  it("derives the preserved draft into an exact sufficient outer envelope", () => {
    const config = preservedConfig();
    const { corpus, identities } = freezeInputs(config);
    const frozen = freezeRecursiveCampaignConfig(config, corpus, identities as never);
    expect(frozen.budgets.outer).toEqual({
      maxTokens: 22_500_000,
      maxUsd: 113,
      maxWallClockSec: 137_343,
      maxEvaluatorInvocations: 27,
    });
    expect(frozen.counts).toMatchObject({ searchChildConcurrency: 3, childConcurrency: 4 });
    expect(assertM2OuterDirectEnvelope(frozen)).toEqual(frozen.outerBudgetDerivation);
  });

  it("schema-refuses an outer budget that differs from its recorded derivation", () => {
    const config = preservedConfig();
    const { corpus, identities } = freezeInputs(config);
    const frozen = freezeRecursiveCampaignConfig(config, corpus, identities as never);
    const mismatched = structuredClone(frozen);
    mismatched.budgets.outer.maxTokens += 1;
    expect(() => MetaCampaignConfigV2.parse(mismatched)).toThrow(
      /outer direct budget must equal its freeze derivation/,
    );
  });

  it("schema-refuses search concurrency above judging even without derivation evidence", () => {
    const config = preservedConfig();
    const overcommitted = structuredClone(config);
    overcommitted.counts.searchChildConcurrency = 3;
    overcommitted.counts.childConcurrency = 2;
    delete overcommitted.outerBudgetDerivation;
    expect(() => MetaCampaignConfigV2.parse(overcommitted)).toThrow(
      /search child concurrency cannot exceed the confirmation\/terminal child concurrency/,
    );
  });

  it("publishes the runtime closure journal through the real recursive freeze command", async () => {
    const outputFlag = `.hone-runs/recursive-freeze-publication-${process.pid}.json`;
    const outputPath = resolve(repoRoot, outputFlag);
    rmSync(outputPath, { force: true });
    const lines = { out: [] as string[], err: [] as string[] };
    const io: CmdIo = {
      root: repoRoot,
      env: { ...process.env },
      isTTY: false,
      out: (line) => lines.out.push(line),
      err: (line) => lines.err.push(line),
    };
    const draft = preservedConfig();
    const prepared = freezeInputs(draft);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const bootDigest = verifiedBootRuntimeDigest() as Sha256Digest;
    prepared.identities.sourceCommit = commit;
    prepared.identities.runtimeDigest = bootDigest;
    const frozenConfig = freezeRecursiveCampaignConfig(
      draft,
      prepared.corpus,
      prepared.identities as never,
    );
    const body = {
      version: 1,
      at: "2026-08-27T00:00:00.000Z",
      sourceCommit: commit,
      bootDigest,
      campaignBootDigest: bootDigest,
      optimizerImage: frozenConfig.optimizerRuntime.image,
      optimizerBaseDigest: frozenConfig.seedOptimizer.bundleDigest,
      closureDigest: `sha256:${"a".repeat(64)}` as Sha256Digest,
      manifestArtifact: `sha256:${"b".repeat(64)}` as Sha256Digest,
      fileCount: 0,
      totalBytes: 0,
      previousRecordDigest: null,
    } as const;
    const closureCapture = {
      record: {
        ...body,
        recordDigest: campaignRuntimeClosureRecordDigest(body),
      },
      marginalBytes: 0,
      reusedBytes: 0,
    };
    try {
      const code = await recursiveCommand([
        "--campaign",
        "data/m2-refreeze-final/campaign-frozen.json",
        "--phase",
        "freeze",
        "--out",
        outputFlag,
        "--headless",
      ], io, {
        preparedFreezePublication: { frozenConfig, closureCapture },
      });
      expect(lines.err, lines.err.join("\n")).toEqual([]);
      expect(code).toBe(0);
      const published = MetaCampaignConfigV2.parse(
        JSON.parse(readFileSync(outputPath, "utf8")),
      );
      expect(published.runtimeClosureJournal?.captures).toHaveLength(1);
      expect(published.runtimeClosureJournal?.campaignConfigHash).toBe(
        metaCampaignConfigHash(published),
      );
    } finally {
      rmSync(outputPath, { force: true });
    }
  });
});
