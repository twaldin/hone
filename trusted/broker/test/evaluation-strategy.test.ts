import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { EvaluationRecord } from "@hone/schema";
import {
  Broker,
  readBrokerJournalEvaluations,
  type BrokerConfig,
  type TrustedEvaluationStrategyInput,
} from "../src/broker.js";
import { startBroker } from "../src/server.js";
import { TEST_CAPSULE_DIGEST, TEST_IMAGE, TEST_OPTIMIZER_DIGEST, buildTestCapsule } from "./helpers.js";

const BUDGET = { maxTokens: 1_000, maxUsd: 10, maxWallClockSec: 60, maxEvaluatorInvocations: 10 };
const BASELINE = `sha256:${"a".repeat(64)}`;
const AT = "2026-07-17T00:00:00.000Z";

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
    capsuleDigest: TEST_CAPSULE_DIGEST,
    optimizerDigest: TEST_OPTIMIZER_DIGEST,
    holdoutLedgerPath: path.join(runDir, "holdout.ndjson"),
    image: TEST_IMAGE,
    runDir,
    casDir: path.join(root, "cas"),
    onEvent: () => {},
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
    expect(seen).toEqual([{ runId: "run_strategy", capsuleId: config.manifest.id, artifact: { hash: BASELINE }, assetGroupId: "train", seed: 4 }]);
    const evidence = readBrokerJournalEvaluations(config.runDir);
    expect(evidence.records).toEqual([result]);
    expect(evidence.journalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.lineCount).toBeGreaterThan(0);
    await broker.close();
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
