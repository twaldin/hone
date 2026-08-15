import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChildRunLaunchReceipt, EvaluationRecord, canonicalJson } from "@hone/schema";
import type {
  BudgetEnvelope,
  CapsuleManifest,
  ChildRunAdmission,
  RecursiveEvaluationPlan,
  MetaCampaignConfigV2 as RecursiveMetaCampaignConfig,
  RunEvent,
  SpawnRunParams,
  SpawnRunResult,
} from "@hone/schema";
import type {
  MetaCandidateGate,
  MetaMeasurement,
  MetaResourceEnvelopeLedger,
  MetaWorkIdentity,
  Sha256Digest,
} from "@hone/meta";
import {
  Broker,
  RecursiveResourceLedger,
  hashChildRunLaunchReceipt,
  type TrustedEvaluationStrategy,
  type TrustedEvaluationStrategyInput,
} from "@hone/broker";
import { RecursiveSearchChildLauncher } from "../src/commands/hone.js";
import type { CliChildSupervisor } from "../src/commands/hone.js";
import { metaWorkKey } from "../src/meta-journal.js";
import type { MetaJournalV1 } from "../src/meta-journal.js";
import type { CampaignPauseAuthority } from "../src/types.js";

const CONFIG_HASH = `sha256:${"c".repeat(64)}` as Sha256Digest;
const SOURCE = `sha256:${"a".repeat(64)}` as Sha256Digest;
const BUNDLE = `sha256:${"b".repeat(64)}` as Sha256Digest;
const FIRST_CAPSULE = "cap_000000000001";
const SECOND_CAPSULE = "cap_000000000002";
const FIRST_CEILING: BudgetEnvelope = {
  maxTokens: 100,
  maxUsd: 2,
  maxWallClockSec: 300,
  maxEvaluatorInvocations: 17,
};
const SECOND_CEILING: BudgetEnvelope = {
  maxTokens: 200,
  maxUsd: 3,
  maxWallClockSec: 400,
  maxEvaluatorInvocations: 17,
};

function plan(): RecursiveEvaluationPlan {
  return {
    allocations: [
      {
        capsuleId: FIRST_CAPSULE,
        allocationOrdinal: 0,
        innerEpisodesMax: 4,
        reservation: FIRST_CEILING,
      },
      {
        capsuleId: SECOND_CAPSULE,
        allocationOrdinal: 1,
        innerEpisodesMax: 3,
        reservation: SECOND_CEILING,
      },
    ],
  };
}

interface Harness {
  strategy: TrustedEvaluationStrategy;
  rows: MetaMeasurement[];
}

function harness(): Harness {
  const campaignDir = mkdtempSync(join(tmpdir(), "hone-recursive-evaluation-"));
  const rows: MetaMeasurement[] = [];
  const journal = {
    queryTrainMeasurements: () => [...rows],
    queryFailureSettlements: () => [],
  } as unknown as MetaJournalV1;
  const gate: MetaCandidateGate = {
    check: async (request) => ({
      ok: true,
      sourceArtifact: request.sourceArtifact,
      bundleDigest: BUNDLE,
      transformationReceiptHash: null,
      feedback: "trusted conformance accepted",
    }),
  };
  const config = {
    counts: { innerEpisodesMax: 4 },
    developmentPanel: {
      members: [
        {
          capsule: { capsuleId: FIRST_CAPSULE },
          calibratedInnerCeiling: FIRST_CEILING,
        },
        {
          capsule: { capsuleId: SECOND_CAPSULE },
          calibratedInnerCeiling: SECOND_CEILING,
        },
      ],
    },
  } as unknown as RecursiveMetaCampaignConfig;
  const launcher = new RecursiveSearchChildLauncher(
    campaignDir,
    campaignDir,
    config,
    CONFIG_HASH,
    journal,
    gate,
    {} as CliChildSupervisor,
    {} as MetaResourceEnvelopeLedger,
    {} as CampaignPauseAuthority,
  );
  return { strategy: launcher.evaluationStrategy(), rows };
}

function request(
  recursivePlan: RecursiveEvaluationPlan,
  spawnRun: TrustedEvaluationStrategyInput["spawnRun"],
): TrustedEvaluationStrategyInput {
  return {
    runId: "run_recursive_outer_smoke",
    capsuleId: "cap_000000000000",
    artifact: { hash: SOURCE },
    assetGroupId: "meta-train",
    seed: 0,
    recursivePlan,
    spawnRun,
  };
}

function identityFor(params: SpawnRunParams): MetaWorkIdentity {
  const schedule = params.child.schedule;
  if (schedule === undefined) throw new Error("test child has no schedule");
  return {
    phase: "search",
    arm: "candidate",
    sourceArtifact: params.child.sourceArtifact.hash as Sha256Digest,
    bundleDigest: params.child.optimizerArtifact.hash as Sha256Digest,
    capsuleId: params.child.capsuleId,
    replicate: 0,
    measurementEpoch: `m2:${createIdentityHash(schedule, params.reservation)}`,
  };
}

function createIdentityHash(
  schedule: NonNullable<SpawnRunParams["child"]["schedule"]>,
  reservation: BudgetEnvelope,
): string {
  return createHash("sha256").update(canonicalJson({
    candidateOrdinal: schedule.candidateOrdinal,
    allocationOrdinal: schedule.allocationOrdinal,
    innerEpisodesMax: schedule.innerEpisodesMax,
    reserved: reservation,
  })).digest("hex");
}

describe("recursive search trusted evaluation adapter", () => {
  it("derives child identities and returns only the mean of trusted normalized settlements", async () => {
    const { strategy, rows } = harness();
    const spawned: SpawnRunParams[] = [];
    const normalized = new Map([
      [FIRST_CAPSULE, 0.25],
      [SECOND_CAPSULE, 0.75],
    ]);
    const spawnRun = vi.fn(async (params: SpawnRunParams): Promise<SpawnRunResult> => {
      spawned.push(params);
      const identity = identityFor(params);
      rows.push({
        ...identity,
        workKey: metaWorkKey(CONFIG_HASH, identity),
        capsuleId: params.child.capsuleId,
        qNormalized: normalized.get(params.child.capsuleId),
        observed: { tokens: 10, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 },
      } as unknown as MetaMeasurement);
      return {} as SpawnRunResult;
    });

    const record = await strategy(request(plan(), spawnRun));

    expect(record.output.objectives).toEqual({ normalizedGain: 0.5 });
    expect(record.output.constraints).toEqual({ allChildrenValid: true, fullPanel: true });
    expect(record.costUsd).toBeCloseTo(0.2, 10);
    expect(spawned).toHaveLength(2);
    expect(spawned.map((params) => params.child.optimizerArtifact.hash)).toEqual([BUNDLE, BUNDLE]);
    expect(spawned.map((params) => params.child.schedule?.candidateOrdinal)).toEqual([0, 0]);
    expect(spawned.map((params) => params.child.runId)).toEqual(
      spawned.map((params) => `run_meta_${metaWorkKey(CONFIG_HASH, identityFor(params)).slice("sha256:".length)}`),
    );
  });

  it("fails every trusted allocation guard before dispatch instead of clamping mutable input", async () => {
    const { strategy } = harness();
    const spawnRun = vi.fn(async (): Promise<SpawnRunResult> => ({} as SpawnRunResult));
    const base = plan();
    await expect(strategy({
      runId: "run_recursive_outer_smoke",
      capsuleId: "cap_000000000000",
      artifact: { hash: SOURCE },
      assetGroupId: "meta-train",
      seed: 0,
      spawnRun,
    })).rejects.toThrow(/requires an optimizer-authored allocation plan/);

    const cases: Array<[RecursiveEvaluationPlan, RegExp]> = [
      [{ allocations: [...base.allocations, { ...base.allocations[0]!, allocationOrdinal: 2 }] }, /exceeds the frozen development panel/],
      [{ allocations: [{ ...base.allocations[0]!, capsuleId: "cap_000000000099" }] }, /non-panel capsule/],
      [{ allocations: [base.allocations[0]!, { ...base.allocations[0]!, allocationOrdinal: 1 }] }, /double-counts capsule/],
      [{ allocations: [base.allocations[0]!, { ...base.allocations[1]!, allocationOrdinal: 0 }] }, /allocation ordinal 0 is duplicated/],
      [{ allocations: [{ ...base.allocations[0]!, innerEpisodesMax: 5 }] }, /inner episode ceiling/],
      [{ allocations: [{ ...base.allocations[0]!, reservation: { ...FIRST_CEILING, maxTokens: 101 } }] }, /maxTokens ceiling/],
      [{ allocations: [{ ...base.allocations[0]!, reservation: { ...FIRST_CEILING, maxUsd: 3 } }] }, /maxUsd ceiling/],
      [{ allocations: [{ ...base.allocations[0]!, reservation: { ...FIRST_CEILING, maxWallClockSec: 301 } }] }, /maxWallClockSec ceiling/],
      [{
        allocations: [{
          ...base.allocations[0]!,
          reservation: { ...FIRST_CEILING, maxEvaluatorInvocations: 18 },
        }],
      }, /maxEvaluatorInvocations ceiling/],
    ];
    for (const [candidate, refusal] of cases) {
      await expect(strategy(request(candidate, spawnRun))).rejects.toThrow(refusal);
    }
    expect(spawnRun).not.toHaveBeenCalled();
  });
});
