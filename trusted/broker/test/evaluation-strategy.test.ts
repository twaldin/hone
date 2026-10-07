import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  assessPromotion,
  deterministicBaselineScoreHash,
  EvaluationRecord,
  GetTaskResult,
  PROMOTION_GATE_VERSION,
  PromotionNoiseCalibration,
  runScopedEvaluationCacheNamespace,
  type RecursiveEvaluationPlan,
  type RecursiveTask,
} from "@hone/schema";
import { CasStore } from "../src/cas.js";
import { packDirAsArtifact } from "../src/artifact.js";
import {
  Broker,
  readBrokerJournalEvaluations,
  type BrokerConfig,
  type TrustedEvaluationStrategyInput,
} from "../src/broker.js";
import { RecursiveResourceLedger } from "../src/recursive.js";
import { startBroker } from "../src/server.js";
import { TEST_CAPSULE_DIGEST, TEST_IMAGE, TEST_OPTIMIZER_DIGEST, buildTestCapsule } from "./helpers.js";

const BUDGET = { maxTokens: 1_000, maxUsd: 10, maxWallClockSec: 60, maxEvaluatorInvocations: 10 };
const BASELINE = `sha256:${"a".repeat(64)}`;
const AT = "2026-07-17T00:00:00.000Z";
const RECURSIVE_TASK: RecursiveTask = {
  depth: 0,
  innerEpisodesMax: 4,
  members: [{ capsuleId: "cap_000000000001", calibratedInnerCeiling: BUDGET }],
};
const RECURSIVE_PLAN: RecursiveEvaluationPlan = {
  allocations: [{
    capsuleId: "cap_000000000001",
    allocationOrdinal: 0,
    innerEpisodesMax: 4,
    reservation: BUDGET,
  }],
};

async function configFor(
  name: string,
  strategy: (input: TrustedEvaluationStrategyInput) => Promise<EvaluationRecord>,
): Promise<BrokerConfig> {
  const root = await mkdtemp(path.join(os.tmpdir(), `hone-strategy-${name}-`));
  const capsule = await buildTestCapsule(root, BUDGET);
  const runDir = path.join(root, "run");
  return {
    runId: `run_${name}`,
    manifest: capsule.manifest,
    capsuleRootDir: capsule.capsuleRootDir,
    baselineArtifactHash: BASELINE,
    admittedCapsuleDigest: TEST_CAPSULE_DIGEST,
    optimizerDigest: TEST_OPTIMIZER_DIGEST,
    holdoutLedgerPath: path.join(runDir, "holdout.ndjson"),
    executionImage: TEST_IMAGE,
    runDir,
    casDir: path.join(root, "cas"),
    onEvent: () => {},
    runCommand: async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      truncated: false,
    }),
    evaluationStrategy: strategy,
  };
}

function recordFor(input: TrustedEvaluationStrategyInput): EvaluationRecord {
  return EvaluationRecord.parse({
    capsuleId: input.capsuleId,
    artifactHash: input.artifact.hash,
    assetGroupId: input.assetGroupId,
    seed: input.seed,
    output: {
      valid: true,
      objectives: { normalizedGain: 1.25 },
      constraints: { complete: true },
      perExample: { one: { score: 1.25, feedback: "bounded" } },
    },
    costUsd: 2,
    durationMs: 3,
    cached: false,
    evaluatedAt: AT,
  });
}

describe("trusted broker evaluation strategy", () => {
  test("returns and journals the trusted strategy record without spawning an evaluator", async () => {
    const seen: TrustedEvaluationStrategyInput[] = [];
    const config = await configFor("strategy", async (input) => {
      seen.push(input);
      return recordFor(input);
    });
    const broker = new Broker(config);
    const result = await broker.evaluate({ artifact: { hash: BASELINE }, assetGroupId: "train", seed: 4 }, { privileged: false });
    expect(result.output.objectives.normalizedGain).toBe(1.25);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      runId: "run_strategy",
      capsuleId: config.manifest.id,
      artifact: { hash: BASELINE },
      assetGroupId: "train",
      seed: 4,
    });
    expect(seen[0]?.spawnRun).toBeTypeOf("function");
    const evidence = readBrokerJournalEvaluations(config.runDir);
    expect(evidence.records).toEqual([result]);
    expect(evidence.journalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.lineCount).toBeGreaterThan(0);
    await broker.close();
  });

  test("preserves original negative-zero example bits after journal numbers lose their sign", async () => {
    const config = await configFor("score_bits_zero", async (input) => {
      const record = recordFor(input);
      record.output.perExample.one!.score = -0;
      return record;
    });
    const broker = new Broker(config);
    try {
      const result = await broker.evaluate({ artifact: { hash: BASELINE }, assetGroupId: "train", seed: 0 }, { privileged: false });
      expect(Object.is(result.output.perExample.one!.score, -0)).toBe(true);
      const fact = readBrokerJournalEvaluations(config.runDir).facts[0]!;
      expect(Object.is(fact.record.output.perExample.one!.score, 0)).toBe(true);
      expect(fact.scoreBits).toEqual({
        aggregateBits: "3ff4000000000000",
        perExampleBits: { one: "8000000000000000" },
      });
    } finally {
      await broker.close();
      await rm(path.dirname(config.runDir), { recursive: true, force: true });
    }
  });

  test("keeps empty example IDs eligible and preserves their original score bits", async () => {
    const config = await configFor("score_bits_empty_id", async (input) => {
      const record = recordFor(input);
      record.output.perExample = { "": { score: -0 } };
      return record;
    });
    const broker = new Broker(config);
    try {
      const result = await broker.evaluate({ artifact: { hash: BASELINE }, assetGroupId: "train", seed: 0 }, { privileged: false });
      expect(Object.is(result.output.perExample[""]!.score, -0)).toBe(true);
      const fact = readBrokerJournalEvaluations(config.runDir).facts[0]!;
      expect(fact.aggregate).toBe(1.25);
      expect(fact.scoreBits?.perExampleBits?.[""]).toBe("8000000000000000");
    } finally {
      await broker.close();
      await rm(path.dirname(config.runDir), { recursive: true, force: true });
    }
  });

  test("keeps protected baseline example evidence out of the optimizer task without losing the gate", async () => {
    const config = await configFor("private_zero_noise", async (input) => recordFor(input));
    const epoch = "private-zero-noise";
    const scores = [{
      seed: 0,
      aggregateBits: "3ff4000000000000",
      perExampleBits: { "protected-example": "3fd0000000000000" },
    }];
    config.measurementEpoch = epoch;
    config.promotionNoiseCalibrations = [PromotionNoiseCalibration.parse({
      gateVersion: PROMOTION_GATE_VERSION,
      evidenceVersion: "hone-baseline-noise-v1",
      calibratedAt: AT,
      capsuleId: config.manifest.id,
      admittedCapsuleDigest: TEST_CAPSULE_DIGEST,
      executionImage: TEST_IMAGE,
      assetGroupId: "secret",
      measurementEpoch: epoch,
      sourceCohortSha256: [`sha256:${"e".repeat(64)}`],
      maxObservedPairDelta: 0,
      noiseFloor: 0,
      noiseEnvelope: 0,
      informationFreePairs: 3,
      informationFreePositive: 0,
      estimator: "deterministic-zero-noise-v1",
      baselineArtifactHash: BASELINE,
      baselineRuns: [0, 1, 2].map((repeat) => {
        const runId = `private_baseline_${repeat}`;
        return { runId, evaluationCacheNamespace: runScopedEvaluationCacheNamespace(epoch, runId), scores };
      }),
      scoreHash: deterministicBaselineScoreHash(scores),
      informationFreeMeasurements: 3,
    })];
    const broker = new Broker(config);
    try {
      const task = broker.getTask({ privileged: false });
      const calibration = task.promotionGateCalibrations.find((entry) => entry.assetGroupId === "secret")!;
      const optimizerPayload = JSON.stringify(task);
      for (const privateField of ["perExampleBits", "baselineRuns", "scoreHash"]) {
        expect(optimizerPayload).not.toContain(`${JSON.stringify(privateField)}:`);
      }
      expect(PromotionNoiseCalibration.safeParse(calibration).success).toBe(false);
      const visible = GetTaskResult.parse(JSON.parse(optimizerPayload));
      expect(assessPromotion(1.25, 1.375, visible.promotionGateCalibrations[0]!).decision).toBe("promote");
    } finally {
      await broker.close();
      await rm(path.dirname(config.runDir), { recursive: true, force: true });
    }
  });

  test("memoizes a repeated request while the broker owns the cached bit", async () => {
    let calls = 0;
    const config = await configFor("memo", async (input) => {
      calls += 1;
      return EvaluationRecord.parse({ ...recordFor(input), cached: true });
    });
    const broker = new Broker(config);
    const first = await broker.evaluate({ artifact: { hash: BASELINE }, assetGroupId: "train", seed: 0 }, { privileged: false });
    const second = await broker.evaluate({ artifact: { hash: BASELINE }, assetGroupId: "train", seed: 0 }, { privileged: false });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
    await broker.close();
  });

  test("replays a journaled evaluator result inside an incomplete episode without charging again", async () => {
    let strategyCalls = 0;
    const config = await configFor("resume-evaluator", async (input) => {
      strategyCalls += 1;
      return recordFor(input);
    });
    const cas = new CasStore(config.casDir);
    const workspace = path.join(path.dirname(config.runDir), "workspace");
    await mkdir(workspace);
    const parent = { hash: await packDirAsArtifact(workspace, cas) };
    config.baselineArtifactHash = parent.hash;
    config.runCommand = async (argv) => ({
      exitCode: argv[1] === "run" ? 0 : 0,
      stdout: Buffer.from(argv[1] === "run" ? "container-resume\n" : ""),
      stderr: Buffer.alloc(0),
      timedOut: false,
      truncated: false,
    });

    const firstBroker = new Broker(config);
    await firstBroker.init();
    await firstBroker.createSandbox(
      { artifact: parent, role: "mutation" },
      { privileged: false },
    );
    const first = await firstBroker.evaluate(
      { artifact: parent, assetGroupId: "train", seed: 4 },
      { privileged: false },
    );
    expect(strategyCalls).toBe(1);
    expect(first.cached).toBe(false);
    await firstBroker.close();

    const resumedBroker = new Broker({
      ...config,
      evaluationStrategy: async () => {
        throw new Error("journaled evaluator work was re-spent");
      },
    });
    await resumedBroker.init();
    await resumedBroker.createSandbox(
      { artifact: parent, role: "mutation", continueEpisode: 0 },
      { privileged: false },
    );
    const replayed = await resumedBroker.evaluate(
      { artifact: parent, assetGroupId: "train", seed: 4, resume: true },
      { privileged: false },
    );
    expect(replayed).toEqual({ ...first, cached: true });
    expect(resumedBroker.getBudget({ privileged: false }).spent.evaluatorInvocations).toBe(1);
    expect(readBrokerJournalEvaluations(config.runDir).records).toEqual([first]);
    await resumedBroker.close();
  });

  test("does not replay an incomplete episode under a different recursive plan", async () => {
    let strategyCalls = 0;
    const config = await configFor("resume-recursive-plan", async (input) => {
      strategyCalls += 1;
      return recordFor(input);
    });
    const cas = new CasStore(config.casDir);
    const workspace = path.join(path.dirname(config.runDir), "workspace-recursive");
    await mkdir(workspace);
    const parent = { hash: await packDirAsArtifact(workspace, cas) };
    config.baselineArtifactHash = parent.hash;
    config.runCommand = async (argv) => ({
      exitCode: 0,
      stdout: Buffer.from(argv[1] === "run" ? "container-resume\n" : ""),
      stderr: Buffer.alloc(0),
      timedOut: false,
      truncated: false,
    });
    const changedPlan: RecursiveEvaluationPlan = {
      allocations: [{ ...RECURSIVE_PLAN.allocations[0]!, innerEpisodesMax: 3 }],
    };

    const firstBroker = new Broker(config);
    await firstBroker.init();
    await firstBroker.createSandbox({ artifact: parent, role: "mutation" }, { privileged: false });
    await firstBroker.evaluate(
      { artifact: parent, assetGroupId: "train", seed: 4, recursivePlan: RECURSIVE_PLAN },
      { privileged: false },
    );
    await firstBroker.close();

    const resumedBroker = new Broker(config);
    await resumedBroker.init();
    await resumedBroker.createSandbox(
      { artifact: parent, role: "mutation", continueEpisode: 0 },
      { privileged: false },
    );
    const fresh = await resumedBroker.evaluate(
      { artifact: parent, assetGroupId: "train", seed: 4, recursivePlan: changedPlan, resume: true },
      { privileged: false },
    );
    expect(fresh.cached).toBe(false);
    expect(strategyCalls).toBe(2);
    expect(resumedBroker.getBudget({ privileged: false }).spent.evaluatorInvocations).toBe(2);
    await resumedBroker.close();
  });

  test("keys strategy memoization by the optimizer-authored recursive plan", async () => {
    let calls = 0;
    const config = await configFor("recursive-memo", async (input) => {
      calls += 1;
      return recordFor(input);
    });
    const broker = new Broker(config);
    const first = RECURSIVE_PLAN;
    const second: RecursiveEvaluationPlan = {
      allocations: [{ ...first.allocations[0]!, innerEpisodesMax: 3 }],
    };
    await broker.evaluate(
      { artifact: { hash: BASELINE }, assetGroupId: "train", seed: 0, recursivePlan: first },
      { privileged: false },
    );
    await broker.evaluate(
      { artifact: { hash: BASELINE }, assetGroupId: "train", seed: 0, recursivePlan: second },
      { privileged: false },
    );
    expect(calls).toBe(2);
    await broker.close();
  });

  test("exposes the development task and refuses recursive search without its trusted strategy", async () => {
    const configured = await configFor("recursive-task", async (input) => recordFor(input));
    const ledger = RecursiveResourceLedger.open(path.join(configured.runDir, "recursive.ndjson"));
    configured.recursive = {
      depth: 0,
      ancestors: [],
      ledger,
      evaluationTask: RECURSIVE_TASK,
      admitChildRun: () => undefined,
      launchChildRun: async () => {
        throw new Error("not reached");
      },
    };
    const broker = new Broker(configured);
    expect(broker.getTask({ privileged: false }).recursiveTask).toEqual(RECURSIVE_TASK);
    await broker.close();
    ledger.close();

    const unwired = await configFor("recursive-tripwire", async (input) => recordFor(input));
    const unwiredLedger = RecursiveResourceLedger.open(path.join(unwired.runDir, "recursive.ndjson"));
    unwired.evaluationStrategy = undefined;
    unwired.recursive = {
      depth: 0,
      ancestors: [],
      ledger: unwiredLedger,
      evaluationTask: RECURSIVE_TASK,
      admitChildRun: () => undefined,
      launchChildRun: async () => {
        throw new Error("not reached");
      },
    };
    expect(() => new Broker(unwired)).toThrow(
      /recursive search requires a trusted evaluation strategy; refusing the synthetic capsule evaluator/,
    );
    unwiredLedger.close();
  });

  test("rejects a strategy record joined to a different request identity", async () => {
    const config = await configFor("identity", async (input) => EvaluationRecord.parse({ ...recordFor(input), seed: input.seed + 1 }));
    const broker = new Broker(config);
    await expect(broker.evaluate({ artifact: { hash: BASELINE }, assetGroupId: "train", seed: 0 }, { privileged: false })).rejects.toThrow(
      /different request identity/,
    );
    expect(broker.getBudget({ privileged: true }).spent.evaluatorInvocations).toBe(1);
    await broker.close();
  });

  test("terminal holdout release is an explicit narrow public capability", async () => {
    const config = await configFor("terminal-holdout", async (input) => recordFor(input));
    config.terminalHoldoutAssetGroupIds = ["holdout"];
    const broker = new Broker(config);
    expect(broker.getTask({ privileged: false }).visibleAssetGroups).toEqual(["train", "secret", "holdout"]);
    await expect(broker.evaluate(
      { artifact: { hash: BASELINE }, assetGroupId: "holdout", seed: 2 },
      { privileged: false },
    )).rejects.toThrow(/holdout ledger not open/);
    await broker.close();
  });

  test("terminal holdout release refuses non-holdout groups", async () => {
    const config = await configFor("invalid-terminal-holdout", async (input) => recordFor(input));
    config.terminalHoldoutAssetGroupIds = ["train"];
    expect(() => new Broker(config)).toThrow(/terminal holdout asset group train is not visibility=holdout/);
  });

  test("places the public Unix listener at an explicit short path without opening TCP", async () => {
    const config = await configFor("short-public-socket", async (input) => recordFor(input));
    const socketPath = path.join(path.dirname(config.runDir), "broker.sock");
    const running = await startBroker(config, { socketPath });
    expect(running.socketPath).toBe(socketPath);
    expect(running.publicTcpAddress).toBeUndefined();
    expect(running.adminSocketPath).toBeUndefined();
    expect(existsSync(socketPath)).toBe(true);
    await running.close();
    expect(existsSync(socketPath)).toBe(false);
  });
});
