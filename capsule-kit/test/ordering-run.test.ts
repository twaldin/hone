/**
 * The ordering check end to end through the REAL broker, with the docker CLI
 * replaced at the single host-command seam by a scripted two-phase evaluator.
 * Pins the container-count contract (logical evaluations vs physical
 * containers, early invalid encodes) and that evidence survives late failures.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type RunCommand } from "@hone/broker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as HostEvaluatorGate from "../../trusted/broker/src/host-evaluator-gate.js";
import type * as OrderingCheck from "../tools/ordering-check.js";

// The host evaluator gate is Linux-only kernel machinery (abstract sockets,
// real uids) with its own tests; this suite is about the ordering tool's
// accounting, so the gate is a no-op lease and the suite runs anywhere.
vi.mock("../../trusted/broker/src/host-evaluator-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HostEvaluatorGate>()),
  acquireHostEvaluatorGate: async () => ({ allocationId: "a".repeat(32), waitMs: 0, release: async () => {} }),
}));

const VARIANT_ORDER = ["baseline", "broken", "naive", "shortcut", "improved", "baseline", "baseline"] as const;
// [train, validation] mean scores per variant.
const SCORES: Record<string, [number, number]> = {
  baseline: [0.5, 0.5],
  broken: [0.1, 0.1],
  naive: [0.3, 0.3],
  shortcut: [0.8, 0.2],
  improved: [1, 1],
};
const result = (variant: string, split: number) => ({
  valid: true,
  objectives: { score: SCORES[variant]![split]! },
  constraints: { tests_pass: true },
  perExample: { only: { score: SCORES[variant]![split]! } },
  diagnostics: { quality: variant === "improved" ? 1 : 0.5 },
});
const invalidEncode = {
  valid: false,
  objectives: {},
  perExample: { only: { score: 0 } },
  diagnostics: { summary: "candidate failed to build" },
};

interface Script {
  /** Variants whose evaluations stop at an invalid encode result (one container). */
  earlyInvalid?: readonly string[];
  /** The post-run `docker ps` leak check reports a container after every measurement finished. */
  leakedContainer?: boolean;
}

let root: string;
// The tool resolves HONE_CAPSULE_DIR once at module load, so it is imported
// after the fixture capsule exists; a static import cannot work.
let tool: typeof OrderingCheck;

function makeCapsule(): string {
  const dir = join(root, "capsule");
  mkdirSync(join(dir, "baseline"), { recursive: true });
  writeFileSync(join(dir, "baseline", "eval.py"), "# frozen evaluator\n");
  for (const name of ["broken", "naive", "shortcut", "improved"]) {
    mkdirSync(join(dir, "diagnostics", name), { recursive: true });
    writeFileSync(join(dir, "diagnostics", name, "candidate.txt"), `${name}\n`);
  }
  for (const [split, file] of [["train", "a.json"], ["validation", "b.json"]] as const) {
    mkdirSync(join(dir, "assets", split), { recursive: true });
    writeFileSync(join(dir, "assets", split, file), "{}\n");
  }
  writeFileSync(
    join(dir, "capsule.config.json"),
    JSON.stringify({
      objective: "two-phase ordering fixture",
      image: `hone-fixture@sha256:${"b".repeat(64)}`,
      evalEntrypoint: ["python3", "-I", "-B", "eval.py"],
      evalPhases: ["encode", "decode"],
      protectedPaths: ["eval.py"],
      assetGroups: [
        { id: "train", visibility: "public", paths: ["assets/train"] },
        { id: "validation", visibility: "protected", paths: ["assets/validation"] },
      ],
      budget: { maxTokens: 1000, maxUsd: 1, maxWallClockSec: 7200, maxEvaluatorInvocations: 40 },
      diagnosticOrdering: { path: "diagnostics/ordering-report.json" },
    }),
  );
  return dir;
}

/** Scripted docker CLI: encode/decode containers per the two-phase protocol, everything else succeeds quietly. */
function fakeDocker(script: Script, launches: string[][]): RunCommand {
  const ok = (stdout = "") => ({
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    truncated: false,
    timedOut: false,
  });
  let encodes = 0;
  return async (argv, opts) => {
    if (argv[0] !== "docker") return runCommand(argv, opts);
    // Only the tool's own leak check uses `-aq`; the broker's quiescence scan uses `-q`.
    if (argv[1] === "ps") return ok(script.leakedContainer === true && argv.includes("-aq") ? "deadbeef0001\n" : "");
    if (argv[1] !== "run") return ok();
    launches.push([...argv]);
    const phase = argv.find((a) => a.startsWith("HONE_EVAL_PHASE="))?.slice("HONE_EVAL_PHASE=".length);
    if (phase !== "decode") encodes += 1;
    const index = encodes - 1;
    const variant = VARIANT_ORDER[Math.floor(index / 2)]!;
    if (phase === "encode") {
      if (script.earlyInvalid?.includes(variant) === true) return ok(JSON.stringify(invalidEncode));
      const handoff = argv.find((a) => a.includes(":/capsule/handoff:"))!.split(":")[0]!;
      writeFileSync(join(handoff, "archive.bin"), "compressed");
      return ok(JSON.stringify({ honeEvalContinue: "decode" }));
    }
    return ok(JSON.stringify(result(variant, index % 2)));
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hone-ordering-run-"));
  vi.stubEnv("HONE_CAPSULE_DIR", makeCapsule());
  tool = await import("../tools/ordering-check.js");
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("ordering check on a two-phase capsule", () => {
  it("counts 14 logical evaluations in 28 physical containers (decode launches are not evaluations)", async () => {
    const launches: string[][] = [];
    const unverified: OrderingCheck.OrderingReport[] = [];
    const report = await tool.runOrderingCheck({
      runCommand: fakeDocker({}, launches),
      onUnverifiedReport: (r) => unverified.push(r),
    });
    expect(report).toMatchObject({
      logicalEvaluations: 14,
      evalInvocations: 28,
      decodeLaunches: 14,
      earlyInvalidEncodes: 0,
      failures: [],
    });
    expect(launches).toHaveLength(28);
    expect(unverified).toEqual([report]);
  });

  it("pins every native baseline and diagnostic phase through the ordering entry point", async () => {
    const previous = process.env["HONE_SANDBOX_CPUSET"];
    vi.stubEnv("HONE_SANDBOX_CPUSET", "1-4");
    const launches: string[][] = [];
    try {
      await tool.runOrderingCheck({ runCommand: fakeDocker({}, launches) });
      for (const argv of launches) {
        expect(argv.filter(arg => arg === "--cpuset-cpus")).toEqual(["--cpuset-cpus"]);
        expect(argv[argv.indexOf("--cpuset-cpus") + 1]).toBe("1-4");
      }
      expect(launches.filter(argv => argv.includes("HONE_EVAL_PHASE=encode"))).toHaveLength(14);
      expect(launches.filter(argv => argv.includes("HONE_EVAL_PHASE=decode"))).toHaveLength(14);
    } finally {
      vi.stubEnv("HONE_SANDBOX_CPUSET", previous);
    }
  });

  it("counts an evaluation that ends at an invalid encode as one container", async () => {
    const report = await tool.runOrderingCheck({
      runCommand: fakeDocker({ earlyInvalid: ["broken"] }, []),
    });
    // broken x (train, validation) never decodes: 14 evaluations, 12 decodes.
    expect(report).toMatchObject({
      logicalEvaluations: 14,
      evalInvocations: 26,
      decodeLaunches: 12,
      earlyInvalidEncodes: 2,
      failures: [],
    });
    expect(report.results.broken.combined).toBe(0);
  });

  it("persists raw measurements and the aggregate report, then marks them complete", async () => {
    const out = join(root, "ok");
    const paths = { rawPath: join(out, "raw.json"), partialPath: join(out, "partial.json"), reportPath: join(out, "report.json") };
    const report = await tool.runOrderingWithEvidence({
      stabilityRuns: 3,
      paths,
      runCommand: fakeDocker({ earlyInvalid: ["broken"] }, []),
    });
    expect(report.failures).toEqual([]);
    const raw = JSON.parse(readFileSync(paths.rawPath, "utf8"));
    expect(raw).toMatchObject({ schemaVersion: 1, stabilityRuns: 3, status: "complete" });
    expect(raw.measurements).toHaveLength(14);
    const partial = JSON.parse(readFileSync(paths.partialPath, "utf8"));
    expect(partial).toMatchObject({
      status: "complete",
      completedMeasurements: 14,
      counts: { logicalEvaluations: 14, physicalContainers: 26, decodeLaunches: 12, earlyInvalidEncodes: 2 },
    });
    expect(partial.summary.variants.baseline.combined).toBe(0.5);
    expect(JSON.parse(readFileSync(paths.reportPath, "utf8")).variants.improved.combined).toBe(1);
  });

  it("keeps every measurement, the aggregate report and the explanation when a late integrity check fails", async () => {
    const out = join(root, "late");
    const paths = { rawPath: join(out, "raw.json"), partialPath: join(out, "partial.json"), reportPath: join(out, "report.json") };
    await expect(
      tool.runOrderingWithEvidence({
        stabilityRuns: 3,
        paths,
        runCommand: fakeDocker({ leakedContainer: true }, []),
      }),
    ).rejects.toThrow(/resource leaks detected/);
    const raw = JSON.parse(readFileSync(paths.rawPath, "utf8"));
    expect(raw.status).toBe("failed");
    expect(raw.failure).toMatch(/containers leaked/);
    expect(raw.measurements).toHaveLength(14);
    const partial = JSON.parse(readFileSync(paths.partialPath, "utf8"));
    expect(partial).toMatchObject({
      status: "failed",
      completedMeasurements: 14,
      counts: { logicalEvaluations: 14, physicalContainers: 28 },
    });
    expect(partial.failure).toMatch(/containers leaked/);
    expect(partial.summary.variants.shortcut.train).toBe(0.8);
    // A run that failed integrity never leaves an admitted-looking report behind.
    expect(existsSync(paths.reportPath)).toBe(false);
  });

  it("records failing ordering checks with the aggregate report, without writing the compact report", async () => {
    const out = join(root, "ordering-fail");
    const paths = { rawPath: join(out, "raw.json"), partialPath: join(out, "partial.json"), reportPath: join(out, "report.json") };
    // The improved control stops at an invalid encode: it can no longer beat baseline.
    const report = await tool.runOrderingWithEvidence({
      stabilityRuns: 3,
      paths,
      runCommand: fakeDocker({ earlyInvalid: ["improved"] }, []),
    });
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report).toMatchObject({ logicalEvaluations: 14, evalInvocations: 26, earlyInvalidEncodes: 2 });
    const partial = JSON.parse(readFileSync(paths.partialPath, "utf8"));
    expect(partial.status).toBe("failed");
    expect(partial.failure).toMatch(/ORDERING CHECK FAILED/);
    expect(partial.summary.variants.improved.combined).toBe(0);
    expect(JSON.parse(readFileSync(paths.rawPath, "utf8")).measurements).toHaveLength(14);
    expect(existsSync(paths.reportPath)).toBe(false);
  });

  it("an unbuildable aggregate summary never aborts the run before the count gate", async () => {
    const out = join(root, "degenerate");
    const paths = { rawPath: join(out, "raw.json"), partialPath: join(out, "partial.json") };
    // Every evaluation stops at an invalid encode: all aggregates are 0, so the
    // stability spread is NaN and no schema-valid summary exists.
    const report = await tool.runOrderingWithEvidence({
      stabilityRuns: 3,
      paths,
      runCommand: fakeDocker({ earlyInvalid: ["baseline", "broken", "naive", "shortcut", "improved"] }, []),
    });
    expect(report).toMatchObject({ logicalEvaluations: 14, evalInvocations: 14, decodeLaunches: 0, earlyInvalidEncodes: 14 });
    expect(report.failures.length).toBeGreaterThan(0);
    const partial = JSON.parse(readFileSync(paths.partialPath, "utf8"));
    expect(partial).toMatchObject({ status: "failed", summary: null, counts: { logicalEvaluations: 14, physicalContainers: 14 } });
    expect(partial.summaryError).toMatch(/spread/);
    expect(JSON.parse(readFileSync(paths.rawPath, "utf8")).measurements).toHaveLength(14);
  });

  it("records the failure even when the compact report cannot be written or cleaned up", async () => {
    const out = join(root, "finalize");
    const reportPath = join(out, "report-is-a-directory");
    mkdirSync(reportPath, { recursive: true });
    const paths = { rawPath: join(out, "raw.json"), partialPath: join(out, "partial.json"), reportPath };
    await expect(
      tool.runOrderingWithEvidence({ stabilityRuns: 3, paths, runCommand: fakeDocker({}, []) }),
    ).rejects.toThrow();
    const raw = JSON.parse(readFileSync(paths.rawPath, "utf8"));
    expect(raw.status).toBe("failed");
    expect(raw.failure).not.toBe("");
    expect(raw.measurements).toHaveLength(14);
  });
});
