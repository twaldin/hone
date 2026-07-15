import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrokerMethods,
  CapsuleManifest,
  DEFAULT_PROMOTION_RULE,
  DiagnosticOrderingReport,
  EvaluatorOutput,
  PromotionRule,
  RunConfig,
  RunEvent,
  ProxyTraceRecord,
  canonicalJson,
  capsuleDigest,
  deriveCapsuleId,
} from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

describe("canonical json + capsule addressing", () => {
  it("sorts object keys recursively, preserves array order, drops undefined", () => {
    expect(canonicalJson({ b: { d: 2, c: [3, 1] }, a: 0, u: undefined })).toBe(
      '{"a":0,"b":{"c":[3,1],"d":2}}',
    );
  });

  it("deriveCapsuleId is key-order-insensitive and ignores a present id", () => {
    const a = deriveCapsuleId({ x: 1, y: [2, 3], id: "cap_aaaaaaaaaaaa" });
    const b = deriveCapsuleId({ y: [2, 3], x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^cap_[0-9a-f]{12}$/);
  });

  it("capsuleDigest covers the FULL manifest including id", () => {
    const m = CapsuleManifest.parse(load("capsule.seeded-astar.json"));
    const digest = capsuleDigest(m);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(capsuleDigest({ ...m, id: "cap_000000000000" })).not.toBe(digest);
  });
});

describe("contract 1: capsule manifest (v2)", () => {
  it("accepts the seeded-astar fixture and its id derives exactly", () => {
    const m = CapsuleManifest.parse(load("capsule.seeded-astar.json"));
    expect(m.schemaVersion).toBe(2);
    expect(deriveCapsuleId(m)).toBe(m.id);
  });

  it("rejects schemaVersion 1 — v2 is a clean cutover", () => {
    const m = load("capsule.seeded-astar.json");
    m.schemaVersion = 1;
    expect(() => CapsuleManifest.parse(m)).toThrow();
  });

  it("rejects a mutable image tag — only repo@sha256:<64> is admissible", () => {
    const m = load("capsule.seeded-astar.json");
    for (const bad of [
      "hone-task:latest",
      "hone-task",
      "hone-task@sha256:abc",
      "Hone-Task@sha256:" + "a".repeat(64),
      "hone-task@sha512:" + "a".repeat(64),
    ]) {
      m.image = bad;
      expect(() => CapsuleManifest.parse(m), bad).toThrow();
    }
  });

  it("tampering any field breaks the id derivation", () => {
    const m = CapsuleManifest.parse(load("capsule.seeded-astar.json"));
    expect(deriveCapsuleId(m)).toBe(m.id);
    const imageTampered = {
      ...m,
      image: "hone-task@sha256:" + "f".repeat(64),
    };
    expect(deriveCapsuleId(imageTampered)).not.toBe(m.id);
    const reportTampered = {
      ...m,
      diagnosticOrdering: { ...m.diagnosticOrdering, hash: "sha256:" + "e".repeat(64) },
    };
    expect(deriveCapsuleId(reportTampered)).not.toBe(m.id);
  });

  it("requires the diagnostic-ordering reference — evidence is core, not meta", () => {
    const m = load("capsule.seeded-astar.json");
    delete m.diagnosticOrdering;
    expect(() => CapsuleManifest.parse(m)).toThrow();
    m.diagnosticOrdering = { path: "diagnostics/ordering-report.json", hash: "not-a-hash" };
    expect(() => CapsuleManifest.parse(m)).toThrow();
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

describe("diagnostic ordering report", () => {
  it("accepts the persisted-summary fixture", () => {
    const r = DiagnosticOrderingReport.parse(load("ordering-report.json"));
    expect(r.version).toBe(1);
    expect(r.failures).toEqual([]);
    expect(r.stability.aggregates.length).toBeGreaterThanOrEqual(3);
  });

  it("is strict — unknown keys are tampering", () => {
    const r = load("ordering-report.json");
    r.extra = true;
    expect(() => DiagnosticOrderingReport.parse(r)).toThrow();
    const r2 = load("ordering-report.json");
    r2.variants.baseline.note = "sneaky";
    expect(() => DiagnosticOrderingReport.parse(r2)).toThrow();
  });

  it("rejects non-finite aggregates", () => {
    const r = load("ordering-report.json");
    r.variants.broken.combined = Number.POSITIVE_INFINITY;
    expect(() => DiagnosticOrderingReport.parse(r)).toThrow();
  });

  it("requires three or more baseline stability aggregates", () => {
    const r = load("ordering-report.json");
    r.stability.aggregates = [0.5, 0.51];
    expect(() => DiagnosticOrderingReport.parse(r)).toThrow();
  });

  it("rejects a missing variant", () => {
    const r = load("ordering-report.json");
    delete r.variants.shortcut;
    expect(() => DiagnosticOrderingReport.parse(r)).toThrow();
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
    // The fixture pre-registers a non-default promotion rule; it must survive parse verbatim.
    expect(rc.promotion).toEqual({ minDeltaOverSe: 3, minSignConsistency: 0.75, replicates: 5, requireNegativeControls: true });
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
    // Campaign field: required after parse, pre-registered defaults when absent.
    expect(rc.promotion).toEqual(DEFAULT_PROMOTION_RULE);
  });

  it("promotion rule default is not aliased across parses", () => {
    const base = {
      version: 1,
      capsuleId: "cap_000000000000",
      objective: "x",
      budget: { maxTokens: 1, maxUsd: 0, maxWallClockSec: 1, maxEvaluatorInvocations: 1 },
      routing: {},
    };
    const a = RunConfig.parse(base);
    a.promotion.replicates = 99;
    expect(RunConfig.parse(base).promotion.replicates).toBe(DEFAULT_PROMOTION_RULE.replicates);
    expect(DEFAULT_PROMOTION_RULE.replicates).toBe(3);
  });

  it("rejects out-of-range promotion rules — the pre-registered gate cannot be degenerate", () => {
    expect(() => PromotionRule.parse({ minDeltaOverSe: 0, minSignConsistency: 0.8, replicates: 3 })).toThrow();
    expect(() => PromotionRule.parse({ minDeltaOverSe: 2, minSignConsistency: 1.5, replicates: 3 })).toThrow();
    expect(() => PromotionRule.parse({ minDeltaOverSe: 2, minSignConsistency: 0.8, replicates: 0 })).toThrow();
    expect(PromotionRule.parse({ minDeltaOverSe: 2, minSignConsistency: 0.8, replicates: 3 }).requireNegativeControls).toBe(true);
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

  it("probe.completed carries the verdict, both measured aggregates, coordinate, and budget", () => {
    const budget = {
      envelope: { maxTokens: 100, maxUsd: 1, maxWallClockSec: 60, maxEvaluatorInvocations: 10 },
      spent: { tokens: 5, usd: 0.01, wallClockSec: 2.5, evaluatorInvocations: 2 },
    };
    const e = RunEvent.parse({
      runId: "run_1",
      at: new Date().toISOString(),
      type: "probe.completed",
      approved: true,
      baseline: { artifact: { hash: "sha256:" + "a".repeat(64) }, aggregate: 0.5 },
      candidate: {
        artifact: { hash: "sha256:" + "b".repeat(64) },
        aggregate: 0.55,
        delta: 0.05,
      },
      assetGroupId: "validation",
      seed: 7,
      budget,
    });
    expect(e.type).toBe("probe.completed");
  });

  it("probe.completed admits a null candidate but not a missing one", () => {
    const budget = {
      envelope: { maxTokens: 100, maxUsd: 1, maxWallClockSec: 60, maxEvaluatorInvocations: 10 },
      spent: { tokens: 5, usd: 0.01, wallClockSec: 2.5, evaluatorInvocations: 2 },
    };
    const base = {
      runId: "run_1",
      at: new Date().toISOString(),
      type: "probe.completed",
      approved: false,
      baseline: { artifact: { hash: "sha256:" + "a".repeat(64) }, aggregate: 0.5 },
      assetGroupId: "validation",
      seed: 7,
      budget,
    };
    expect(RunEvent.parse({ ...base, candidate: null }).type).toBe("probe.completed");
    expect(() => RunEvent.parse(base)).toThrow();
  });

  it("probe.completed rejects non-finite aggregates", () => {
    const budget = {
      envelope: { maxTokens: 100, maxUsd: 1, maxWallClockSec: 60, maxEvaluatorInvocations: 10 },
      spent: { tokens: 5, usd: 0.01, wallClockSec: 2.5, evaluatorInvocations: 2 },
    };
    expect(() =>
      RunEvent.parse({
        runId: "run_1",
        at: new Date().toISOString(),
        type: "probe.completed",
        approved: false,
        baseline: { artifact: { hash: "sha256:" + "a".repeat(64) }, aggregate: Number.NaN },
        candidate: null,
        assetGroupId: "validation",
        seed: 7,
        budget,
      }),
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
