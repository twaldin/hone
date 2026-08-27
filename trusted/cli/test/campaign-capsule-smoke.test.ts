import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MetaCampaignConfigV2 } from "@hone/schema";
import type { MetaCampaignConfigV2 as RecursiveMetaCampaignConfig } from "@hone/schema";
import {
  assertPanelCapsuleSmokeEligibility,
  assertRequiredPanelCapsuleSmoke,
  type CapsuleSmokeRow,
} from "../src/campaign-capsule-smoke.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const preservedPath = resolve(repoRoot, "data/m2-refreeze-final/campaign-frozen.json");
const HASH = `sha256:${"a".repeat(64)}`;

function requiredConfig(): RecursiveMetaCampaignConfig {
  const preserved = JSON.parse(readFileSync(preservedPath, "utf8"));
  return MetaCampaignConfigV2.parse({
    ...preserved,
    preIgnitionGates: {
      panelCapsuleSmoke: {
        version: 1,
        required: true,
      },
    },
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

describe("campaign panel capsule smoke eligibility", () => {
  it("requires one valid conformance/evaluator settlement for every frozen panel capsule", () => {
    const config = requiredConfig();
    const rows = passingRows(config);
    expect(assertPanelCapsuleSmokeEligibility(
      config,
      rows,
      { modelCalls: 0, providerCalls: 0 },
    )).toEqual({ normalizedGain: (rows.length - 1) / 2 });

    expect(() => assertPanelCapsuleSmokeEligibility(
      config,
      rows.slice(0, -1),
      { modelCalls: 0, providerCalls: 0 },
    )).toThrow(/settled 5\/6 capsules/);

    const invalid = structuredClone(rows) as unknown as Array<Record<string, unknown>>;
    const evaluation = invalid[2]?.["evaluation"] as Record<string, unknown>;
    evaluation["valid"] = false;
    expect(() => assertPanelCapsuleSmokeEligibility(
      config,
      invalid as unknown as CapsuleSmokeRow[],
      { modelCalls: 0, providerCalls: 0 },
    )).toThrow();

    const unguarded = structuredClone(rows) as unknown as Array<Record<string, unknown>>;
    const conformance = unguarded[2]?.["conformance"] as Record<string, unknown>;
    conformance["protectedPathControl"] = "ACCEPTED";
    expect(() => assertPanelCapsuleSmokeEligibility(
      config,
      unguarded as unknown as CapsuleSmokeRow[],
      { modelCalls: 0, providerCalls: 0 },
    )).toThrow();
  });

  it("refuses eligibility after any model or provider dispatch", () => {
    const config = requiredConfig();
    const rows = passingRows(config);
    expect(() => assertPanelCapsuleSmokeEligibility(
      config,
      rows,
      { modelCalls: 1, providerCalls: 0 },
    )).toThrow(/observed dispatch/);
    expect(() => assertPanelCapsuleSmokeEligibility(
      config,
      rows,
      { modelCalls: 0, providerCalls: 1 },
    )).toThrow(/observed dispatch/);
  });

  it("fails closed when a required ignition guard is absent", () => {
    expect(() => assertRequiredPanelCapsuleSmoke(
      "/tmp/hone-panel-smoke-missing",
      requiredConfig(),
    )).toThrow(/receipt .* is missing or invalid/);
  });
});
