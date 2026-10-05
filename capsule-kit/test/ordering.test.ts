import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertEvaluatorLaunches,
  countEvaluatorLaunches,
  loadCapsuleConfig,
  orderingBrokerResources,
  provisionalManifest,
  resolveStabilityRuns,
  verifyOrderingMeasurements,
  type OrderingMeasurement,
  type OrderingReport,
} from "../tools/ordering-check.js";
import { OrderingEvidenceWriter } from "../tools/ordering-evidence.js";

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

describe("ordering evaluator container accounting", () => {
  const launch = (name: string, phase?: "encode" | "decode"): string[] => [
    "docker", "run", "--rm", "--name", name, "--network", "none",
    ...(phase === undefined ? [] : ["-e", `HONE_EVAL_PHASE=${phase}`]),
    "image",
  ];
  /** `decoded` evaluations run encode+decode; `early` stop at an invalid encode. */
  function transcript(decoded: number, early: number): string[][] {
    const commands: string[][] = [["tar", "-x"]];
    for (let i = 0; i < decoded + early; i += 1) {
      commands.push(launch(`eval-${i}`, "encode"));
      if (i < decoded) commands.push(launch(`eval-${i}-decode`, "decode"));
    }
    return commands;
  }
  const measurement = (valid: boolean): OrderingMeasurement => ({
    variant: "baseline",
    split: "train",
    seed: 0,
    output: { valid, objectives: {}, constraints: {}, perExample: {}, diagnostics: {} },
  });
  const measurements = (valid: number, invalid: number): OrderingMeasurement[] => [
    ...Array.from({ length: valid }, () => measurement(true)),
    ...Array.from({ length: invalid }, () => measurement(false)),
  ];

  it("counts decode launches as physical containers, not evaluations", () => {
    expect(countEvaluatorLaunches(transcript(14, 0))).toEqual({ logical: 14, decode: 14, physical: 28, pairingErrors: [] });
    // An evaluation ended by an invalid encode is exactly one container.
    expect(countEvaluatorLaunches(transcript(12, 2))).toEqual({ logical: 14, decode: 12, physical: 26, pairingErrors: [] });
    expect(countEvaluatorLaunches([launch("a"), launch("b")])).toMatchObject({ logical: 2, decode: 0, physical: 2 });
  });

  it("accepts the 14-evaluation / 28-container two-phase transcript the legacy gate rejected", () => {
    const counts = countEvaluatorLaunches(transcript(14, 0));
    expect(() =>
      assertEvaluatorLaunches(counts, { logicalEvaluations: 14, phased: true, measurements: measurements(14, 0) }),
    ).not.toThrow();
    expect(() =>
      assertEvaluatorLaunches(countEvaluatorLaunches(transcript(12, 2)), {
        logicalEvaluations: 14,
        phased: true,
        measurements: measurements(12, 2),
      }),
    ).not.toThrow();
  });

  it("still rejects a wrong logical count, whatever the physical count", () => {
    const expected = { phased: true, measurements: measurements(13, 0) };
    expect(() =>
      assertEvaluatorLaunches(countEvaluatorLaunches(transcript(13, 0)), { ...expected, logicalEvaluations: 14 }),
    ).toThrow("expected exactly 14 logical evaluations, observed 13 logical evaluations in 26 containers (13 decode)");
    // 15 evaluations with 28 physical containers also fails: physical == 2 x expected is not enough.
    expect(() =>
      assertEvaluatorLaunches(countEvaluatorLaunches(transcript(13, 2)), { ...expected, logicalEvaluations: 14 }),
    ).toThrow("observed 15 logical evaluations in 28 containers");
  });

  it("rejects decode launches that do not pair with exactly one encode launch", () => {
    const orphan = [launch("eval-0", "encode"), launch("other-decode", "decode")];
    expect(() =>
      assertEvaluatorLaunches(countEvaluatorLaunches(orphan), { logicalEvaluations: 1, phased: true, measurements: [] }),
    ).toThrow("decode launch other-decode has no earlier encode launch");
    const early = [launch("eval-0-decode", "decode"), launch("eval-0", "encode")];
    expect(countEvaluatorLaunches(early).pairingErrors).toHaveLength(1);
    const twice = [launch("eval-0", "encode"), launch("eval-0-decode", "decode"), launch("eval-0-decode", "decode")];
    expect(countEvaluatorLaunches(twice).pairingErrors).toEqual(["encode launch eval-0 was decoded more than once"]);
  });

  it("rejects decode containers on a single-phase capsule", () => {
    expect(() =>
      assertEvaluatorLaunches(countEvaluatorLaunches(transcript(1, 0)), {
        logicalEvaluations: 1,
        phased: false,
        measurements: measurements(1, 0),
      }),
    ).toThrow("single-phase capsule launched decode containers");
  });

  it("rejects a valid result that never reached a decode container", () => {
    expect(() =>
      assertEvaluatorLaunches(countEvaluatorLaunches(transcript(13, 1)), {
        logicalEvaluations: 14,
        phased: true,
        measurements: measurements(14, 0),
      }),
    ).toThrow("14 valid measurements but only 13 decode containers");
  });

  it("hands out the report before a failing count check throws, and before a transcript check", () => {
    const seen: string[] = [];
    const report = { marker: true } as unknown as OrderingReport;
    const run = (commands: string[][]) =>
      verifyOrderingMeasurements({
        commands,
        measurements: measurements(13, 0),
        expectedLogicalEvaluations: 14,
        phased: true,
        buildReport: (launches) => {
          seen.push(`built:${launches.logical}/${launches.physical}`);
          return report;
        },
        onUnverifiedReport: (r) => seen.push(r === report ? "persisted" : "wrong report"),
      });
    expect(() => run(transcript(13, 0))).toThrow("expected exactly 14 logical evaluations");
    expect(seen).toEqual(["built:13/26", "persisted"]);
    seen.length = 0;
    // Count passes; a later transcript violation still comes after persistence.
    const noNetwork = transcript(14, 0);
    noNetwork[1] = noNetwork[1]!.filter((a) => a !== "--network" && a !== "none");
    expect(() => run(noNetwork)).toThrow("eval container without --network none");
    expect(seen).toEqual(["built:14/28", "persisted"]);
  });
});

describe("ordering evidence writer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ordering-evidence-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const measurement = (seed: number): OrderingMeasurement => ({
    variant: "baseline",
    split: "train",
    seed,
    output: { valid: true, objectives: { score: seed }, constraints: {}, perExample: {}, diagnostics: {} },
  });

  it("rewrites the raw file after every measurement and keeps them all when the run fails", () => {
    const rawPath = join(dir, "nested", "raw.json");
    const writer = new OrderingEvidenceWriter({ stabilityRuns: 3, rawPath });
    writer.measurement(measurement(0));
    writer.measurement(measurement(1));
    let raw = JSON.parse(readFileSync(rawPath, "utf8"));
    expect(raw).toMatchObject({ schemaVersion: 1, stabilityRuns: 3, status: "in-progress" });
    expect(raw.measurements.map((m: OrderingMeasurement) => m.seed)).toEqual([0, 1]);
    writer.fail(new Error("evaluator exploded"));
    raw = JSON.parse(readFileSync(rawPath, "utf8"));
    expect(raw).toMatchObject({ status: "failed", failure: "evaluator exploded" });
    expect(raw.measurements).toHaveLength(2);
    expect(readdirSync(join(dir, "nested"))).toEqual(["raw.json"]);
  });
});
