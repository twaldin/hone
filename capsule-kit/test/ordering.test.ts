import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadCapsuleConfig,
  orderingBrokerResources,
  provisionalManifest,
  resolveStabilityRuns,
} from "../tools/ordering-check.js";

describe("ordering stability evidence options", () => {
  it("uses three passes by default and accepts an explicit larger sample", () => {
    expect(resolveStabilityRuns([])).toBe(3);
    expect(resolveStabilityRuns(["--stability-runs", "5"])).toBe(5);
  });

  it("rejects missing, repeated, fractional, and undersized samples", () => {
    expect(() => resolveStabilityRuns(["--stability-runs"])).toThrow(
      "--stability-runs requires a value",
    );
    expect(() =>
      resolveStabilityRuns(["--stability-runs", "5", "--stability-runs", "6"]),
    ).toThrow("--stability-runs may be specified only once");
    expect(() => resolveStabilityRuns(["--stability-runs", "3.5"])).toThrow(
      "safe integer >= 3",
    );
    expect(() => resolveStabilityRuns(["--stability-runs", "2"])).toThrow(
      "safe integer >= 3",
    );
  });
});

describe("ordering measurement evaluator timeout", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const BASELINE_HASH = `sha256:${"a".repeat(64)}`;
  const GROUPS = [
    { id: "train", visibility: "public", paths: ["assets/train/a.json"] },
    { id: "validation", visibility: "protected", paths: ["assets/validation/b.json"] },
  ];

  function capsule(extra: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "ordering-timeout-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets", "train"), { recursive: true });
    mkdirSync(join(dir, "assets", "validation"), { recursive: true });
    writeFileSync(join(dir, "assets", "train", "a.json"), "{}\n");
    writeFileSync(join(dir, "assets", "validation", "b.json"), "[]\n");
    writeFileSync(join(dir, "capsule.config.json"), JSON.stringify({
      objective: "fixture",
      image: `hone-fixture@sha256:${"b".repeat(64)}`,
      evalEntrypoint: ["python3", "eval.py"],
      protectedPaths: ["eval.py"],
      assetGroups: [
        { id: "train", visibility: "public", paths: ["assets/train"] },
        { id: "validation", visibility: "protected", paths: ["assets/validation"] },
      ],
      budget: { maxTokens: 1000, maxUsd: 1, maxWallClockSec: 7200, maxEvaluatorInvocations: 10 },
      diagnosticOrdering: { path: "diagnostics/ordering-report.json" },
      ...extra,
    }));
    return dir;
  }

  it("measures with the capsule's declared evaluator timeout", () => {
    const dir = capsule({ evaluatorTimeoutSec: 3600, sandbox: { memoryBytes: 1 << 30, cpus: 4 } });
    const manifest = provisionalManifest(loadCapsuleConfig(dir), BASELINE_HASH, GROUPS, dir);
    expect(manifest.evaluatorTimeoutSec).toBe(3600);
    expect(orderingBrokerResources(manifest)).toEqual({
      sandboxMemoryBytes: 1 << 30,
      sandboxCpus: 4,
      evalTimeoutSec: 3600,
    });
  });

  it("leaves the broker default in place when the capsule declares none", () => {
    const dir = capsule({});
    const manifest = provisionalManifest(loadCapsuleConfig(dir), BASELINE_HASH, GROUPS, dir);
    expect(manifest.evaluatorTimeoutSec).toBeUndefined();
    expect(orderingBrokerResources(manifest)).toEqual({});
  });

  it("refuses a malformed or out-of-range timeout before any measurement", () => {
    expect(() => loadCapsuleConfig(capsule({ evaluatorTimeoutSec: "3600" }))).toThrow(
      'invalid or missing "evaluatorTimeoutSec"',
    );
    const dir = capsule({ evaluatorTimeoutSec: 30 });
    expect(() => provisionalManifest(loadCapsuleConfig(dir), BASELINE_HASH, GROUPS, dir)).toThrow();
  });

  it("measures a two-phase capsule through the same phase protocol and refuses any other", () => {
    const dir = capsule({ evalPhases: ["encode", "decode"] });
    expect(provisionalManifest(loadCapsuleConfig(dir), BASELINE_HASH, GROUPS, dir).evalPhases).toEqual(["encode", "decode"]);
    const plain = capsule({});
    expect(provisionalManifest(loadCapsuleConfig(plain), BASELINE_HASH, GROUPS, plain).evalPhases).toBeUndefined();
    expect(() => loadCapsuleConfig(capsule({ evalPhases: "encode" }))).toThrow('invalid or missing "evalPhases"');
    const reversed = capsule({ evalPhases: ["decode", "encode"] });
    expect(() => provisionalManifest(loadCapsuleConfig(reversed), BASELINE_HASH, GROUPS, reversed)).toThrow();
  });
});
