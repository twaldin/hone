import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrokerMethods,
  CapsuleManifest,
  EvaluatorOutput,
  RunConfig,
  RunEvent,
  ProxyTraceRecord,
} from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

describe("contract 1: capsule manifest", () => {
  it("accepts the seeded-astar fixture", () => {
    expect(() => CapsuleManifest.parse(load("capsule.seeded-astar.json"))).not.toThrow();
  });

  it("meta block is droppable without breaking replay (minimality rule)", () => {
    const m = load("capsule.seeded-astar.json");
    delete m.meta;
    expect(() => CapsuleManifest.parse(m)).not.toThrow();
  });

  it("rejects a capsule with no asset groups", () => {
    const m = load("capsule.seeded-astar.json");
    m.assetGroups = [];
    expect(() => CapsuleManifest.parse(m)).toThrow();
  });

  it("rejects a partial budget envelope — unmetered dimensions are the free variable", () => {
    const m = load("capsule.seeded-astar.json");
    delete m.budget.maxWallClockSec;
    expect(() => CapsuleManifest.parse(m)).toThrow();
  });
});

describe("contract: evaluator output", () => {
  it("accepts §7.3 output with unbounded per-example feedback blobs", () => {
    const out = EvaluatorOutput.parse(load("evaluator.output.json"));
    expect(out.perExample["maze_sparse_02"]?.feedback).toEqual({
      note: "suboptimal path length 122 vs 117",
      timeMs: 9.8,
    });
  });

  it("feedback is optional — plain scores remain valid", () => {
    const out = EvaluatorOutput.parse({ valid: true, objectives: { q: 1 }, perExample: { a: { score: 0.5 } } });
    expect(out.perExample["a"]?.score).toBe(0.5);
  });
});

describe("contract 2: broker protocol", () => {
  it("exposes the reserved future-proofing methods (spawnRun, queryCorpus)", () => {
    expect(Object.keys(BrokerMethods)).toEqual(
      expect.arrayContaining(["getTask", "createSandbox", "exec", "saveArtifact", "evaluate", "reportIncumbent", "getBudget", "finish", "spawnRun", "queryCorpus"]),
    );
  });

  it("createSandbox only admits mutation-role sandboxes — eval sandboxes are trusted-side only", () => {
    expect(() =>
      BrokerMethods.createSandbox.params.parse({ artifact: { hash: "sha256:" + "a".repeat(64) }, role: "evaluation" }),
    ).toThrow();
  });

  it("spawnRun depth is capped", () => {
    expect(() =>
      BrokerMethods.spawnRun.params.parse({
        subCapsuleId: "cap_000000000000",
        budgetSlice: { maxTokens: 1, maxUsd: 1, maxWallClockSec: 1, maxEvaluatorInvocations: 1 },
        maxDepth: 3,
      }),
    ).toThrow();
  });
});

describe("contract 5: run config", () => {
  it("accepts the meta campaign fixture", () => {
    const rc = RunConfig.parse(load("runconfig.meta.json"));
    expect(rc.improverSeat).toBe(true);
    expect(rc.apply).toBe("none");
    expect(rc.routing["mutation"]?.model).toBe("gpt-5.6-terra");
  });

  it("defaults: apply=none, headless=false — safe by default", () => {
    const rc = RunConfig.parse({
      version: 1,
      capsuleId: "cap_000000000000",
      objective: "x",
      budget: { maxTokens: 1, maxUsd: 0, maxWallClockSec: 1, maxEvaluatorInvocations: 1 },
      routing: {},
    });
    expect(rc.apply).toBe("none");
    expect(rc.headless).toBe(false);
    expect(rc.improverSeat).toBe(false);
  });
});

describe("contract 4: event log", () => {
  it("round-trips an incumbent event", () => {
    const e = RunEvent.parse({
      runId: "run_1",
      at: new Date().toISOString(),
      type: "incumbent.new",
      artifact: { hash: "sha256:" + "b".repeat(64) },
      aggregate: 0.517,
      deltaVsBaseline: 0.035,
      episode: 4,
    });
    expect(e.type).toBe("incumbent.new");
  });

  it("holdout access events carry the ledger count — no unlogged holdout reads", () => {
    expect(() =>
      RunEvent.parse({ runId: "r", at: new Date().toISOString(), type: "holdout.accessed", capsuleId: "c" }),
    ).toThrow();
  });
});

describe("contract 3: proxy trace", () => {
  it("requires usage accounting and CAS body refs on every record", () => {
    const rec = ProxyTraceRecord.parse({
      version: 1,
      runId: "run_1",
      role: "mutation",
      model: "gpt-5.6-terra",
      requestAt: new Date().toISOString(),
      durationMs: 1200,
      status: 200,
      usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
      estimatedUsd: 0,
      requestBody: "sha256:" + "c".repeat(64),
      responseBody: "sha256:" + "d".repeat(64),
    });
    expect(rec.usage.totalTokens).toBe(1200);
  });
});
