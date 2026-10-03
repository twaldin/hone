import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, MetaCampaignConfigV2 } from "@hone/schema";
import type { MetaCampaignConfigV2 as RecursiveMetaCampaignConfig } from "@hone/schema";
import { metaCampaignConfigHash } from "@hone/meta";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPanelCapsuleSmokeEligibility,
  assertRequiredPanelCapsuleSmoke,
  panelCapsuleSmokeReceiptDigest,
  panelCapsuleSmokeReceiptPath,
  type CapsuleSmokeRow,
  type PanelCapsuleSmokeReceipt,
} from "../src/campaign-capsule-smoke.js";
import { recursiveCommand } from "../src/commands/hone.js";
import type { CmdIo } from "../src/io.js";
import { sealBootRuntimeDigest } from "../src/runtime-digest.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const preservedPath = resolve(repoRoot, "data/m2-refreeze-final/campaign-frozen.json");
const HASH = `sha256:${"a".repeat(64)}`;
const ZERO_DISPATCH = {
  modelCalls: 0,
  providerCalls: 0,
  mutationUsageRecords: 0,
  proxyTraceRecords: 0,
  tokens: 0,
  usd: 0,
} as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function requiredConfig(): RecursiveMetaCampaignConfig {
  const preserved = JSON.parse(readFileSync(preservedPath, "utf8"));
  return MetaCampaignConfigV2.parse({
    ...preserved,
    preIgnitionGates: { panelCapsuleSmoke: { version: 1, required: true } },
  });
}

function passingRows(config: RecursiveMetaCampaignConfig): CapsuleSmokeRow[] {
  return config.developmentPanel.members.map((member, ordinal) => ({
    taskId: member.taskId,
    capsuleId: member.capsule.capsuleId,
    capsuleDigest: member.capsule.capsuleDigest,
    image: member.capsule.image,
    candidateArtifact: HASH,
    conformance: {
      passed: true,
      archiveBytes: 1024 + ordinal,
      protectedPathControl: "PROTECTED_PATH_VIOLATION",
    },
    isolation: {
      mode: "reserved-uid",
      allocationId: `allocation-${ordinal}`,
      workerUid: 20_000 + ordinal,
      waitMs: 0,
    },
    evaluation: {
      valid: true,
      constraintsPassed: true,
      score: member.capsule.qBase,
      costUsd: 0,
      durationMs: 1,
      recordHash: HASH,
    },
    settlement: {
      kind: "measurement",
      workKey: HASH,
      childRunId: `run_meta_${"b".repeat(64)}`,
      qNormalized: ordinal,
    },
  }));
}

function sha256(bytes: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writeReceipt(
  root: string,
  config: RecursiveMetaCampaignConfig,
  mutate?: (receipt: PanelCapsuleSmokeReceipt) => void,
  reseal = false,
): PanelCapsuleSmokeReceipt {
  const configHash = metaCampaignConfigHash(config) as `sha256:${string}`;
  const journal = join(root, ".hone-runs", `panel-test-settlements-${process.pid}.ndjson`);
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(journal, "settled\n");
  const rows = passingRows(config);
  const normalizedGain = rows.reduce((sum, row) => sum + row.settlement.qNormalized, 0) / rows.length;
  const body = {
    version: 1 as const,
    type: "campaign-panel-capsule-smoke.v1" as const,
    campaignConfigHash: configHash,
    sourceCommit: config.trustedRuntime.sourceCommit,
    runtimeDigest: config.trustedRuntime.digest,
    startedAt: "2026-08-27T00:00:00.000Z",
    completedAt: "2026-08-27T00:01:00.000Z",
    evaluationOrder: "sequential-quiet-host" as const,
    settlementJournal: journal,
    settlementJournalHash: sha256(readFileSync(journal)),
    capsules: rows,
    aggregate: {
      expectedCapsules: rows.length,
      passedCapsules: rows.length,
      allChildrenValid: true as const,
      fullPanel: true as const,
      normalizedGain,
    },
    dispatch: ZERO_DISPATCH,
    ignitionEligible: true as const,
  };
  const receipt = {
    ...body,
    receiptDigest: panelCapsuleSmokeReceiptDigest(body),
  } as PanelCapsuleSmokeReceipt;
  mutate?.(receipt);
  if (reseal) {
    const { receiptDigest: _old, ...mutatedBody } = receipt;
    receipt.receiptDigest = panelCapsuleSmokeReceiptDigest(mutatedBody);
  }
  const path = panelCapsuleSmokeReceiptPath(root, configHash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${canonicalJson(receipt)}\n`);
  return receipt;
}

describe("campaign panel capsule smoke eligibility", () => {
  it("requires every panel settlement, protected-path refusal, and observed zero dispatch", () => {
    const config = requiredConfig();
    const rows = passingRows(config);
    expect(assertPanelCapsuleSmokeEligibility(config, rows, ZERO_DISPATCH))
      .toEqual({ normalizedGain: (rows.length - 1) / 2 });
    expect(() => assertPanelCapsuleSmokeEligibility(config, rows.slice(0, -1), ZERO_DISPATCH))
      .toThrow(/settled 5\/6 capsules/);

    const invalid = structuredClone(rows) as unknown as Array<Record<string, unknown>>;
    (invalid[2]?.["evaluation"] as Record<string, unknown>)["valid"] = false;
    expect(() => assertPanelCapsuleSmokeEligibility(
      config,
      invalid as unknown as CapsuleSmokeRow[],
      ZERO_DISPATCH,
    )).toThrow();

    const unguarded = structuredClone(rows) as unknown as Array<Record<string, unknown>>;
    (unguarded[2]?.["conformance"] as Record<string, unknown>)["protectedPathControl"] = "ACCEPTED";
    expect(() => assertPanelCapsuleSmokeEligibility(
      config,
      unguarded as unknown as CapsuleSmokeRow[],
      ZERO_DISPATCH,
    )).toThrow();

    for (const field of ["modelCalls", "providerCalls", "tokens", "usd"] as const) {
      expect(() => assertPanelCapsuleSmokeEligibility(
        config,
        rows,
        { ...ZERO_DISPATCH, [field]: 1 },
      )).toThrow(/observed dispatch or spend/);
    }
  });

  it("kills receipt digest, identity, runtime, journal, and aggregate tampering", () => {
    const config = requiredConfig();
    const cases: Array<[(receipt: PanelCapsuleSmokeReceipt) => void, boolean, RegExp]> = [
      [(receipt) => { receipt.aggregate.normalizedGain += 1; }, false, /receipt digest/],
      [(receipt) => { receipt.capsules[0]!.image = `foreign@sha256:${"c".repeat(64)}`; }, true, /identity drift/],
      [(receipt) => { receipt.runtimeDigest = `sha256:${"d".repeat(64)}`; }, true, /different frozen runtime/],
      [(receipt) => { receipt.settlementJournalHash = `sha256:${"e".repeat(64)}`; }, true, /journal digest/],
      [(receipt) => { receipt.aggregate.normalizedGain += 1; }, true, /aggregate does not match/],
    ];
    for (const [mutate, reseal, expected] of cases) {
      const root = mkdtempSync(join(tmpdir(), "hone-panel-receipt-"));
      roots.push(root);
      writeReceipt(root, config, mutate, reseal);
      expect(() => assertRequiredPanelCapsuleSmoke(root, config)).toThrow(expected);
    }
  });

  it("wires required receipt refusal and acceptance through recursive SEARCH", async () => {
    const runtimeDigest = sealBootRuntimeDigest();
    const commit = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const base = requiredConfig();
    const config = MetaCampaignConfigV2.parse({
      ...base,
      trustedRuntime: { sourceCommit: commit, digest: runtimeDigest },
      seedOptimizer: { ...base.seedOptimizer, sourceCommit: commit },
      controllerOptimizer: { ...base.controllerOptimizer, sourceCommit: commit },
    });
    mkdirSync(join(repoRoot, ".hone-runs"), { recursive: true });
    const campaign = join(repoRoot, ".hone-runs", `panel-wiring-${process.pid}.json`);
    writeFileSync(campaign, `${canonicalJson(config)}\n`);
    roots.push(campaign);
    const io: CmdIo = {
      root: repoRoot,
      env: { ...process.env },
      out: () => {},
      err: () => {},
      isTTY: false,
    };
    const args = ["--campaign", campaign, "--phase", "search", "--headless"];
    await expect(recursiveCommand(args, io, { stopAfterPreIgnitionGate: true }))
      .rejects.toThrow(/panel capsule smoke receipt .* missing or invalid/);
    writeReceipt(repoRoot, config);
    roots.push(dirname(panelCapsuleSmokeReceiptPath(
      repoRoot,
      metaCampaignConfigHash(config) as `sha256:${string}`,
    )));
    await expect(recursiveCommand(args, io, { stopAfterPreIgnitionGate: true })).resolves.toBe(0);
  });
});
