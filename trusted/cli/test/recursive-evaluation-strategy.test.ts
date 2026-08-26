import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  ChildRunLaunchReceipt as ChildRunLaunchReceiptShape,
  SpawnRunResult,
} from "@hone/schema";
import type {
  MetaCandidateGate,
  MetaFailureSettlement,
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
import {
  RecursiveSearchChildLauncher,
  imageBoundCandidateBundleDigest,
  type CliChildSupervisor,
} from "../src/commands/hone.js";
import { snapshotDigest, type OptimizerSnapshot } from "../src/optimizer-digest.js";
import { metaWorkKey } from "../src/meta-journal.js";
import type { MetaJournalV1 } from "../src/meta-journal.js";
import type { CampaignPauseAuthority } from "../src/types.js";

const CONFIG_HASH = `sha256:${"c".repeat(64)}` as Sha256Digest;
const SOURCE = `sha256:${"a".repeat(64)}` as Sha256Digest;
const BUNDLE = `sha256:${"b".repeat(64)}` as Sha256Digest;
const FIRST_IMAGE = `hone-test@sha256:${"1".repeat(64)}`;
const SECOND_IMAGE = `hone-test@sha256:${"2".repeat(64)}`;
const THIRD_IMAGE = `hone-test@sha256:${"3".repeat(64)}`;
const IMAGE_BOUND_BUNDLE = `sha256:${"d".repeat(64)}` as Sha256Digest;
const FIRST_CAPSULE = "cap_000000000001";
const SECOND_CAPSULE = "cap_000000000002";
const THIRD_CAPSULE = "cap_000000000003";
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
const OUTER_BUDGET: BudgetEnvelope = {
  maxTokens: 1_000,
  maxUsd: 10,
  maxWallClockSec: 1_000,
  maxEvaluatorInvocations: 100,
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

function threeChildPlan(): RecursiveEvaluationPlan {
  return {
    allocations: [
      ...plan().allocations,
      {
        capsuleId: THIRD_CAPSULE,
        allocationOrdinal: 2,
        innerEpisodesMax: 4,
        reservation: FIRST_CEILING,
      },
    ],
  };
}

interface Harness {
  strategy: TrustedEvaluationStrategy;
  rows: MetaMeasurement[];
  failures: MetaFailureSettlement[];
  campaignDir: string;
}

interface HarnessOptions {
  campaignDir?: string;
  rows?: MetaMeasurement[];
  failures?: MetaFailureSettlement[];
}

function harness(options: HarnessOptions = {}): Harness {
  const campaignDir = options.campaignDir ?? mkdtempSync(join(tmpdir(), "hone-recursive-evaluation-"));
  const rows = options.rows ?? [];
  const failures = options.failures ?? [];
  const journal = {
    queryTrainMeasurements: () => [...rows],
    queryFailureSettlements: () => [...failures],
  } as unknown as MetaJournalV1;
  const gate = {
    check: async (request: Parameters<MetaCandidateGate["check"]>[0]) => ({
      ok: true as const,
      sourceArtifact: request.sourceArtifact,
      bundleDigest: BUNDLE,
      transformationReceiptHash: null,
      feedback: "trusted conformance accepted",
    }),
    bundleDigestForImage: () => BUNDLE,
  };
  const config = {
    counts: { innerEpisodesMax: 4, searchChildConcurrency: 3 },
    developmentPanel: {
      members: [
        {
          capsule: { capsuleId: FIRST_CAPSULE, image: FIRST_IMAGE },
          calibratedInnerCeiling: FIRST_CEILING,
        },
        {
          capsule: { capsuleId: SECOND_CAPSULE, image: SECOND_IMAGE },
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
  return { strategy: launcher.evaluationStrategy(), rows, failures, campaignDir };
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

function writeDurableLaunchReceipt(campaignDir: string, params: SpawnRunParams): void {
  const receiptBody: Omit<ChildRunLaunchReceiptShape, "receiptDigest"> = {
    child: params.child,
    depth: params.depth,
    admission: {
      campaignConfigHash: CONFIG_HASH,
      cohort: "panel-a",
      capsuleProvenanceHash: CONFIG_HASH,
      sourceProvenanceHash: params.child.sourceArtifact.hash,
      optimizerProvenanceHash: params.child.optimizerArtifact.hash,
    },
    launchedAt: "2026-08-26T00:00:00.000Z",
  };
  const receipt = ChildRunLaunchReceipt.parse({
    ...receiptBody,
    receiptDigest: hashChildRunLaunchReceipt(receiptBody),
  });
  writeFileSync(
    join(campaignDir, `child-launch-${params.child.runId}.json`),
    `${canonicalJson(receipt)}\n`,
  );
}

describe("recursive search trusted evaluation adapter", () => {
  it("derives an accepted candidate bundle digest for the target image", () => {
    const snapshot: OptimizerSnapshot = { files: new Map() };
    const comparisonDigest = snapshotDigest(FIRST_IMAGE, snapshot);
    const targetDigest = snapshotDigest(THIRD_IMAGE, snapshot);

    expect(imageBoundCandidateBundleDigest(snapshot, THIRD_IMAGE)).toBe(targetDigest);
    expect(targetDigest).not.toBe(comparisonDigest);
  });

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

  it("returns a null aggregate after one child settles candidate_failed", async () => {
    const { strategy, rows, failures } = harness();
    const spawnRun = vi.fn(async (params: SpawnRunParams): Promise<SpawnRunResult> => {
      const identity = identityFor(params);
      const workKey = metaWorkKey(CONFIG_HASH, identity);
      const observed = { tokens: 10, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 };
      if (params.child.capsuleId === SECOND_CAPSULE) {
        failures.push({
          ...identity,
          workKey,
          observed,
          status: "candidate_failed",
        } as unknown as MetaFailureSettlement);
      } else {
        rows.push({
          ...identity,
          workKey,
          qNormalized: 0.25,
          observed,
        } as unknown as MetaMeasurement);
      }
      return {} as SpawnRunResult;
    });

    const record = await strategy(request(plan(), spawnRun));

    expect(record.output).toMatchObject({
      valid: false,
      objectives: {},
      constraints: { allChildrenValid: false },
      diagnostics: { summary: expect.stringContaining(`${SECOND_CAPSULE}=candidate_failed`) },
    });
    expect(record.costUsd).toBeCloseTo(0.2, 10);
    expect(spawnRun).toHaveBeenCalledTimes(2);
  });

  it("mints a fresh child-work identity after a null panel instead of replaying its failed settlement", async () => {
    const { strategy, rows, failures } = harness();
    const spawned: SpawnRunParams[] = [];
    const spawnRun = vi.fn(async (params: SpawnRunParams): Promise<SpawnRunResult> => {
      spawned.push(params);
      const identity = identityFor(params);
      const workKey = metaWorkKey(CONFIG_HASH, identity);
      const observed = { tokens: 10, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 };
      if (params.child.schedule?.candidateOrdinal === 0 && params.child.capsuleId === SECOND_CAPSULE) {
        if (!failures.some((failure) => failure.workKey === workKey)) {
          failures.push({
            ...identity,
            workKey,
            observed,
            status: "candidate_failed",
          } as unknown as MetaFailureSettlement);
        }
      } else if (!rows.some((row) => row.workKey === workKey)) {
        rows.push({
          ...identity,
          workKey,
          qNormalized: params.child.capsuleId === FIRST_CAPSULE ? 0.25 : 0.75,
          observed,
        } as unknown as MetaMeasurement);
      }
      return {} as SpawnRunResult;
    });

    const first = await strategy(request(plan(), spawnRun));
    const second = await strategy({ ...request(plan(), spawnRun), seed: 1 });

    expect(first.output).toMatchObject({ valid: false, objectives: {} });
    expect(second.output).toMatchObject({
      valid: true,
      objectives: { normalizedGain: 0.5 },
      constraints: { allChildrenValid: true, fullPanel: true },
    });
    expect(spawned.map((params) => params.child.schedule?.candidateOrdinal)).toEqual([0, 0, 1, 1]);
    const firstRunIds = spawned.slice(0, 2).map((params) => params.child.runId);
    const retryRunIds = spawned.slice(2).map((params) => params.child.runId);
    expect(new Set(retryRunIds).size).toBe(2);
    expect(retryRunIds.every((runId) => !firstRunIds.includes(runId))).toBe(true);
  });

  it("rehydrates a settled failed panel as retryable rather than memoizing it after restart", async () => {
    const first = harness();
    const firstRunIds: string[] = [];
    const failedSpawn = vi.fn(async (params: SpawnRunParams): Promise<SpawnRunResult> => {
      firstRunIds.push(params.child.runId);
      writeDurableLaunchReceipt(first.campaignDir, params);
      const identity = identityFor(params);
      const workKey = metaWorkKey(CONFIG_HASH, identity);
      const observed = { tokens: 10, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 };
      if (params.child.capsuleId === SECOND_CAPSULE) {
        first.failures.push({
          ...identity,
          workKey,
          childRunId: params.child.runId,
          observed,
          status: "candidate_failed",
        } as unknown as MetaFailureSettlement);
      } else {
        first.rows.push({
          ...identity,
          workKey,
          childRunId: params.child.runId,
          qNormalized: 0.25,
          observed,
        } as unknown as MetaMeasurement);
      }
      return {} as SpawnRunResult;
    });
    await expect(first.strategy(request(plan(), failedSpawn))).resolves.toMatchObject({
      output: { valid: false, objectives: {} },
    });

    const resumed = harness({
      campaignDir: first.campaignDir,
      rows: first.rows,
      failures: first.failures,
    });
    const retrySpawns: SpawnRunParams[] = [];
    const successfulSpawn = vi.fn(async (params: SpawnRunParams): Promise<SpawnRunResult> => {
      retrySpawns.push(params);
      const identity = identityFor(params);
      const workKey = metaWorkKey(CONFIG_HASH, identity);
      resumed.rows.push({
        ...identity,
        workKey,
        childRunId: params.child.runId,
        qNormalized: params.child.capsuleId === FIRST_CAPSULE ? 0.25 : 0.75,
        observed: { tokens: 10, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 },
      } as unknown as MetaMeasurement);
      return {} as SpawnRunResult;
    });
    await expect(
      resumed.strategy({ ...request(plan(), successfulSpawn), seed: 1 }),
    ).resolves.toMatchObject({
      output: {
        valid: true,
        objectives: { normalizedGain: 0.5 },
        constraints: { allChildrenValid: true, fullPanel: true },
      },
    });
    expect(retrySpawns.map((params) => params.child.schedule?.candidateOrdinal)).toEqual([1, 1]);
    expect(retrySpawns.every((params) => !firstRunIds.includes(params.child.runId))).toBe(true);
  });

  it("keeps a settled successful panel memoized across restart", async () => {
    const first = harness();
    const firstRunIds: string[] = [];
    const settle = vi.fn(async (params: SpawnRunParams): Promise<SpawnRunResult> => {
      firstRunIds.push(params.child.runId);
      writeDurableLaunchReceipt(first.campaignDir, params);
      const identity = identityFor(params);
      first.rows.push({
        ...identity,
        workKey: metaWorkKey(CONFIG_HASH, identity),
        childRunId: params.child.runId,
        qNormalized: params.child.capsuleId === FIRST_CAPSULE ? 0.25 : 0.75,
        observed: { tokens: 10, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 },
      } as unknown as MetaMeasurement);
      return {} as SpawnRunResult;
    });
    await expect(first.strategy(request(plan(), settle))).resolves.toMatchObject({
      output: { valid: true, objectives: { normalizedGain: 0.5 } },
    });

    const resumed = harness({
      campaignDir: first.campaignDir,
      rows: first.rows,
      failures: first.failures,
    });
    const replayed: SpawnRunParams[] = [];
    await expect(resumed.strategy({
      ...request(plan(), async (params): Promise<SpawnRunResult> => {
        replayed.push(params);
        return {} as SpawnRunResult;
      }),
      seed: 1,
    })).resolves.toMatchObject({
      output: { valid: true, objectives: { normalizedGain: 0.5 } },
    });
    expect(replayed.map((params) => params.child.schedule?.candidateOrdinal)).toEqual([0, 0]);
    expect(replayed.map((params) => params.child.runId)).toEqual(firstRunIds);
  });

  it("resumes an ordinal that has both a failed settlement and an open child before allowing a fresh retry", async () => {
    const campaignDir = mkdtempSync(join(tmpdir(), "hone-recursive-open-attempt-"));
    const params = plan().allocations.map((allocation): SpawnRunParams => {
      const schedule = {
        candidateOrdinal: 0,
        allocationOrdinal: allocation.allocationOrdinal,
        innerEpisodesMax: allocation.innerEpisodesMax,
      };
      const draft: SpawnRunParams = {
        child: {
          runId: `run_meta_${"0".repeat(64)}`,
          capsuleId: allocation.capsuleId,
          sourceArtifact: { hash: SOURCE },
          optimizerArtifact: { hash: BUNDLE },
          purpose: "capsule" as const,
          schedule,
        },
        depth: 1,
        reservation: allocation.reservation,
      };
      const identity = identityFor(draft);
      return {
        ...draft,
        child: {
          ...draft.child,
          runId: `run_meta_${metaWorkKey(CONFIG_HASH, identity).slice("sha256:".length)}`,
        },
      };
    });
    for (const child of params) writeDurableLaunchReceipt(campaignDir, child);
    const failedChild = params[1];
    if (failedChild === undefined) throw new Error("open-attempt fixture lost its failed child");
    const failedIdentity = identityFor(failedChild);
    const failures = [{
      ...failedIdentity,
      workKey: metaWorkKey(CONFIG_HASH, failedIdentity),
      childRunId: failedChild.child.runId,
      observed: { tokens: 10, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 },
      status: "candidate_failed",
    } as unknown as MetaFailureSettlement];
    const resumed = harness({ campaignDir, failures });
    const retrySpawns: SpawnRunParams[] = [];
    const spawnRun = vi.fn(async (child: SpawnRunParams): Promise<SpawnRunResult> => {
      retrySpawns.push(child);
      if (child.child.capsuleId === FIRST_CAPSULE) {
        const identity = identityFor(child);
        resumed.rows.push({
          ...identity,
          workKey: metaWorkKey(CONFIG_HASH, identity),
          childRunId: child.child.runId,
          qNormalized: 0.25,
          observed: { tokens: 10, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 },
        } as unknown as MetaMeasurement);
      }
      return {} as SpawnRunResult;
    });

    await expect(resumed.strategy(request(plan(), spawnRun))).resolves.toMatchObject({
      output: { valid: false, objectives: {} },
    });
    expect(retrySpawns.map((child) => child.child.schedule?.candidateOrdinal)).toEqual([0, 0]);
    expect(retrySpawns.map((child) => child.child.runId)).toEqual(params.map((child) => child.child.runId));
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

  it("settles three image-bound children through the broker with each runtime digest sealed at launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "hone-recursive-image-binding-"));
    const campaignDir = join(root, "campaign");
    const runDir = join(root, "outer-run");
    const capsuleRoot = join(root, "outer-capsule");
    mkdirSync(campaignDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    mkdirSync(capsuleRoot, { recursive: true });
    mkdirSync(join(root, "cas"), { recursive: true });
    const metaTask = "trusted recursive image binding\n";
    writeFileSync(join(capsuleRoot, "meta-task.txt"), metaTask);
    const metaTaskHash = `sha256:${createHash("sha256").update(metaTask).digest("hex")}`;

    // M2 ignition 4's first two allocations used the comparison image; the
    // third was the first different capsule image and therefore the first
    // legitimate runtime digest that differed from the conformance digest.
    const runtimeBundleByImage: Record<string, Sha256Digest> = {
      [FIRST_IMAGE]: BUNDLE,
      [SECOND_IMAGE]: BUNDLE,
      [THIRD_IMAGE]: IMAGE_BOUND_BUNDLE,
    };
    const runtimeBundleByCapsule: Record<string, Sha256Digest> = {
      [FIRST_CAPSULE]: BUNDLE,
      [SECOND_CAPSULE]: BUNDLE,
      [THIRD_CAPSULE]: IMAGE_BOUND_BUNDLE,
    };
    const rows: MetaMeasurement[] = [];
    const finalized: string[] = [];
    const journal = {
      queryTrainMeasurements: () => [...rows],
      queryFailureSettlements: () => [],
    } as unknown as MetaJournalV1;
    const gate = {
      check: async (gateRequest: Parameters<MetaCandidateGate["check"]>[0]) => ({
        ok: true as const,
        sourceArtifact: gateRequest.sourceArtifact,
        bundleDigest: BUNDLE,
        transformationReceiptHash: null,
        feedback: "comparison-image conformance accepted",
      }),
      bundleDigestForImage: (_sourceArtifact: Sha256Digest, image: string): Sha256Digest => {
        const digest = runtimeBundleByImage[image];
        if (digest === undefined) throw new Error(`test has no runtime bundle for ${image}`);
        return digest;
      },
    };
    const config = {
      counts: { innerEpisodesMax: 4, searchChildConcurrency: 3 },
      developmentPanel: {
        members: [
          {
            capsule: { capsuleId: FIRST_CAPSULE, image: FIRST_IMAGE },
            calibratedInnerCeiling: FIRST_CEILING,
          },
          {
            capsule: { capsuleId: SECOND_CAPSULE, image: SECOND_IMAGE },
            calibratedInnerCeiling: SECOND_CEILING,
          },
          {
            capsule: { capsuleId: THIRD_CAPSULE, image: THIRD_IMAGE },
            calibratedInnerCeiling: FIRST_CEILING,
          },
        ],
      },
    } as unknown as RecursiveMetaCampaignConfig;
    const adapter = new RecursiveSearchChildLauncher(
      root,
      campaignDir,
      config,
      CONFIG_HASH,
      journal,
      gate,
      {} as CliChildSupervisor,
      {} as MetaResourceEnvelopeLedger,
      {} as CampaignPauseAuthority,
    );
    const ledger = RecursiveResourceLedger.open(join(campaignDir, "recursive-resource.ndjson"));
    const enteredChildren: string[] = [];
    const openReservationCounts: number[] = [];
    let releaseChildren!: () => void;
    const allChildrenEntered = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });
    const broker = new Broker({
      runId: "run_recursive_outer_image_binding",
      manifest: {
        schemaVersion: 2,
        id: "cap_000000000000",
        objective: "exercise trusted recursive child image binding",
        baseline: { kind: "cas", hash: SOURCE },
        image: FIRST_IMAGE,
        evalEntrypoint: ["true"],
        protectedPaths: [],
        diagnosticOrdering: { path: "ordering.json", hash: CONFIG_HASH },
        assetGroups: [{ id: "meta-train", visibility: "public", paths: ["meta-task.txt"] }],
        budget: OUTER_BUDGET,
        contentHashes: { "meta-task.txt": metaTaskHash },
      } satisfies CapsuleManifest,
      capsuleRootDir: capsuleRoot,
      baselineArtifactHash: SOURCE,
      capsuleDigest: CONFIG_HASH,
      optimizerDigest: BUNDLE,
      holdoutLedgerPath: join(runDir, "holdout-ledger.ndjson"),
      image: FIRST_IMAGE,
      runDir,
      casDir: join(root, "cas"),
      onEvent: () => {},
      now: () => 0,
      recursive: {
        depth: 0,
        ancestors: [],
        ledger,
        resourceEnvelope: OUTER_BUDGET,
        admitChildRun: ({ request: childRequest }) => ({
          campaignConfigHash: CONFIG_HASH,
          cohort: "panel-a",
          capsuleProvenanceHash: CONFIG_HASH,
          sourceProvenanceHash: childRequest.child.sourceArtifact.hash,
          optimizerProvenanceHash: childRequest.child.optimizerArtifact.hash,
        }),
        launchChildRun: async ({ request: childRequest, admission }) => {
          enteredChildren.push(childRequest.child.runId);
          openReservationCounts.push(
            ledger.budgetState("run_recursive_outer_image_binding").openReservations,
          );
          if (enteredChildren.length === 3) releaseChildren();
          await allChildrenEntered;
          const actualBundle = runtimeBundleByCapsule[childRequest.child.capsuleId];
          if (actualBundle === undefined) throw new Error("test launched a capsule outside its runtime map");
          const childDir = join(root, childRequest.child.runId);
          mkdirSync(childDir, { recursive: true });
          const receiptPath = join(childDir, "launch-receipt.ndjson");
          const receiptBody = {
            child: childRequest.child,
            depth: childRequest.depth,
            admission,
            launchedAt: "2026-08-23T21:22:13.455Z",
          };
          const receipt = ChildRunLaunchReceipt.parse({
            ...receiptBody,
            receiptDigest: hashChildRunLaunchReceipt(receiptBody),
          });
          writeFileSync(receiptPath, `${canonicalJson(receipt)}\n`);
          const terminalEventPath = join(childDir, "events.ndjson");
          const events: RunEvent[] = [
            {
              runId: childRequest.child.runId,
              at: "2026-08-23T21:22:14.730Z",
              type: "run.started",
              capsuleId: childRequest.child.capsuleId,
              contractHash: CONFIG_HASH,
              optimizerDigest: actualBundle,
              checkpointVersion: 1,
              campaignConfigHash: admission.campaignConfigHash,
            },
            {
              runId: childRequest.child.runId,
              at: "2026-08-23T21:33:49.000Z",
              type: "run.finished",
              status: "completed",
            },
          ];
          writeFileSync(terminalEventPath, `${events.map((event) => canonicalJson(event)).join("\n")}\n`);
          const identity = identityFor(childRequest);
          return {
            launchReceiptPath: receiptPath,
            terminalEventPath,
            usage: { tokens: 1, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 },
            finalizeSettlement: () => {
              finalized.push(childRequest.child.runId);
              rows.push({
                ...identity,
                workKey: metaWorkKey(CONFIG_HASH, identity),
                qNormalized: childRequest.child.capsuleId === FIRST_CAPSULE
                  ? 0.25
                  : childRequest.child.capsuleId === SECOND_CAPSULE
                    ? 0.5
                    : 0.75,
                observed: { tokens: 1, usd: 0.1, wallClockSec: 1, evaluatorInvocations: 1 },
              } as unknown as MetaMeasurement);
            },
          };
        },
      },
    });

    try {
      const launched: SpawnRunParams[] = [];
      const record = await adapter.evaluationStrategy()(request(
        threeChildPlan(),
        async (childRequest) => {
          launched.push(childRequest);
          return await broker.spawnRun(childRequest, { privileged: false });
        },
      ));

      expect(launched.map((childRequest) => childRequest.child.optimizerArtifact.hash)).toEqual([
        BUNDLE,
        BUNDLE,
        IMAGE_BOUND_BUNDLE,
      ]);
      expect(finalized.sort()).toEqual(launched.map((childRequest) => childRequest.child.runId).sort());
      expect(new Set(finalized)).toHaveLength(3);
      expect(openReservationCounts).toContain(3);
      const durableShape = readFileSync(ledger.filePath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line).t);
      expect(durableShape.slice(0, 4)).toEqual(["account", "reservation", "reservation", "reservation"]);
      expect(durableShape.filter((type) => type === "settlement")).toHaveLength(3);
      expect(record.output.objectives).toEqual({ normalizedGain: 0.5 });
      expect(record.output.constraints).toEqual({ allChildrenValid: true, fullPanel: true });
      expect(ledger.budgetState("run_recursive_outer_image_binding")).toMatchObject({
        reservations: 3,
        openReservations: 0,
      });
    } finally {
      await broker.close();
      ledger.close();
    }
  });
});
