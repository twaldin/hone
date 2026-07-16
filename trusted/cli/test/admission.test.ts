import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, DiagnosticOrderingReport, RunConfig, capsuleDigest } from "@hone/schema";
import { admitCapsule, readCapsuleSnapshot, revalidateForResume, writeCapsuleSnapshot } from "../src/admission.js";
import { computeOptimizerDigest, resolveOptimizerDigest } from "../src/optimizer-digest.js";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import { writeRunConfigFile } from "../src/runs.js";
import {
  CAP_ID,
  FIX_IMAGE,
  FIX_OPTIMIZER_DIGEST,
  ORDERING_REPORT_PATH,
  fakeHash,
  fixtureEvents,
  gitIn,
  initScratchRepo,
  makeCapsule,
  makeIo,
  makeRoot,
  manifestObject,
  manifestRaw,
  orderingReportRaw,
  pkgRoot,
  writeEvents,
} from "./helpers.js";

function sha(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

describe("frozen capsule admission", () => {
  it("admits a drift-free capsule and reproduces the canonical digest", () => {
    const root = makeRoot();
    const dir = makeCapsule(root);
    const admitted = admitCapsule(dir);
    expect(admitted.manifest.id).toBe(CAP_ID);
    expect(admitted.digest).toBe(capsuleDigest(manifestObject()));
    expect(admitted.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(admitted.orderingReport.failures).toEqual([]);
  });

  it("refuses a manifest whose content-addressed id does not recompute", () => {
    const root = makeRoot();
    const dir = makeCapsule(root, { id: "cap_000000000000" });
    expect(() => admitCapsule(dir)).toThrow(/does not recompute/);
  });

  it("refuses a referenced asset with no contentHashes entry (exact key set, missing side)", () => {
    const root = makeRoot();
    const hashes = manifestRaw()["contentHashes"] as Record<string, string>;
    const { "assets/validation/data.txt": _dropped, ...partial } = hashes;
    const dir = makeCapsule(root, { contentHashes: partial });
    expect(() => admitCapsule(dir)).toThrow(/no contentHashes entry/);
  });

  it("refuses an unreferenced contentHashes key (exact key set, extra side)", () => {
    const root = makeRoot();
    const hashes = manifestRaw()["contentHashes"] as Record<string, string>;
    const dir = makeCapsule(root, { contentHashes: { ...hashes, "assets/stray.txt": fakeHash("a") } });
    expect(() => admitCapsule(dir)).toThrow(/must be exact/);
  });

  it("refuses asset drift (bytes differ from the pinned hash)", () => {
    const root = makeRoot();
    const dir = makeCapsule(root);
    writeFileSync(join(dir, "assets", "train", "data.txt"), "tampered\n");
    expect(() => admitCapsule(dir)).toThrow(/asset drift/);
  });

  it("refuses ordering-report drift (bytes differ from the pinned hash)", () => {
    const root = makeRoot();
    const dir = makeCapsule(root);
    writeFileSync(join(dir, ORDERING_REPORT_PATH), "{}");
    expect(() => admitCapsule(dir)).toThrow(/ordering report drift/);
  });

  it("refuses a hash-valid ordering report that does not match the schema", () => {
    const root = makeRoot();
    const broken = `${JSON.stringify({ version: 1 })}\n`;
    const dir = makeCapsule(root, { diagnosticOrdering: { path: ORDERING_REPORT_PATH, hash: sha(broken) } });
    writeFileSync(join(dir, ORDERING_REPORT_PATH), broken);
    expect(() => admitCapsule(dir)).toThrow(/does not match the schema/);
  });

  it("refuses an ordering report that recorded failures", () => {
    const root = makeRoot();
    const failing = { ...orderingReportRaw(), failures: ["broken(0.6) < naive(0.3)"] };
    const body = `${JSON.stringify(failing, null, 2)}\n`;
    const dir = makeCapsule(root, { diagnosticOrdering: { path: ORDERING_REPORT_PATH, hash: sha(body) } });
    writeFileSync(join(dir, ORDERING_REPORT_PATH), body);
    expect(() => admitCapsule(dir)).toThrow(/failure/);
  });

  /**
   * A SEMANTIC forgery: mutate the fixture ordering report, then re-pin the
   * tampered bytes' real hash so the manifest id recomputes and every
   * byte-level check (contentHashes, report hash, id) passes. Only the
   * recomputed semantic invariants can catch it.
   */
  function forgedCapsule(root: string, mutate: (r: DiagnosticOrderingReport) => void): string {
    const report = DiagnosticOrderingReport.parse(orderingReportRaw());
    mutate(report);
    const body = `${JSON.stringify(report, null, 2)}\n`;
    const dir = makeCapsule(root, { diagnosticOrdering: { path: ORDERING_REPORT_PATH, hash: sha(body) } });
    writeFileSync(join(dir, ORDERING_REPORT_PATH), body);
    return dir;
  }

  it("refuses a hash-valid, id-valid report whose combined ordering is forged", () => {
    // broken >= naive: the evaluator no longer discriminates, yet failures:[]
    const dir = forgedCapsule(makeRoot(), (r) => {
      r.variants.broken.combined = r.variants.naive.combined;
    });
    expect(() => admitCapsule(dir)).toThrow(/semantic invariant/);
    expect(() => admitCapsule(dir)).toThrow(/broken/);
  });

  it("refuses a forged shortcut with no train advantage (split check hollowed out)", () => {
    const dir = forgedCapsule(makeRoot(), (r) => {
      r.variants.shortcut.train = r.variants.baseline.train - 0.1;
    });
    expect(() => admitCapsule(dir)).toThrow(/semantic invariant.*shortcut must beat baseline on train/);
  });

  it("refuses a forged shortcut whose cheat transfers to validation", () => {
    const dir = forgedCapsule(makeRoot(), (r) => {
      r.variants.shortcut.validation = r.variants.baseline.validation + 0.1;
    });
    expect(() => admitCapsule(dir)).toThrow(/semantic invariant.*shortcut must NOT beat baseline on validation/);
  });

  it("refuses forged constraint-gate booleans on baseline/improved", () => {
    const dir = forgedCapsule(makeRoot(), (r) => {
      r.variants.improved.validationTestsPass = false;
    });
    expect(() => admitCapsule(dir)).toThrow(/semantic invariant.*improved validationTestsPass/);
  });

  it("refuses a recorded stability spread that does not recompute from the aggregates", () => {
    const dir = forgedCapsule(makeRoot(), (r) => {
      // True spread of [0.5, 0.5, 0.9] is far from the recorded 0.
      r.stability.aggregates = [0.5, 0.5, 0.9];
    });
    expect(() => admitCapsule(dir)).toThrow(/semantic invariant.*does not recompute/);
  });

  it("refuses stability aggregates decoupled from the baseline's own combined score", () => {
    const dir = forgedCapsule(makeRoot(), (r) => {
      r.stability.aggregates = [0.6, 0.6, 0.6]; // self-consistent spread 0, wrong head
    });
    expect(() => admitCapsule(dir)).toThrow(/semantic invariant.*stability\.aggregates\[0\]/);
  });

  it("refuses a self-consistent spread that breaches the band", () => {
    const dir = forgedCapsule(makeRoot(), (r) => {
      const aggs = [0.5, 0.4, 0.6];
      const mean = aggs.reduce((a, b) => a + b, 0) / aggs.length;
      r.stability.aggregates = aggs;
      r.stability.spread = (Math.max(...aggs) - Math.min(...aggs)) / mean; // honest recompute, > band
    });
    expect(() => admitCapsule(dir)).toThrow(/semantic invariant.*strictly under band/);
  });

  it("admits the real seeded-astar ordering report end to end", () => {
    const seededBody = readFileSync(
      join(pkgRoot, "..", "..", "capsules", "seeded-astar", "diagnostics", "ordering-report.json"),
      "utf8",
    );
    const root = makeRoot();
    const dir = makeCapsule(root, { diagnosticOrdering: { path: ORDERING_REPORT_PATH, hash: sha(seededBody) } });
    writeFileSync(join(dir, ORDERING_REPORT_PATH), seededBody);
    const admitted = admitCapsule(dir);
    expect(admitted.orderingReport.failures).toEqual([]);
    expect(admitted.orderingReport.variants.improved.combined).toBeGreaterThan(
      admitted.orderingReport.variants.baseline.combined,
    );
  });

  it("requires a git baseline to be a CLEAN nested worktree at the declared HEAD", () => {
    const root = makeRoot();
    const baseline = join(root, "capsule", "baseline");
    initScratchRepo(baseline);
    const commit = gitIn(baseline, "rev-parse", "HEAD");
    const dir = makeCapsule(root, { baseline: { kind: "git", commit } });
    expect(() => admitCapsule(dir)).not.toThrow();

    // dirty tracked file
    writeFileSync(join(baseline, "hello.txt"), "dirty\n");
    expect(() => admitCapsule(dir)).toThrow(/differs from declared commit/);
    writeFileSync(join(baseline, "hello.txt"), "baseline\n");
    expect(() => admitCapsule(dir)).not.toThrow();

    // untracked file counts as dirty too
    writeFileSync(join(baseline, "stray.txt"), "stray\n");
    expect(() => admitCapsule(dir)).toThrow(/path count|differs from declared commit/);
  });

  it("refuses a baseline HEAD that differs from the declared commit", () => {
    const root = makeRoot();
    const baseline = join(root, "capsule", "baseline");
    initScratchRepo(baseline);
    const dir = makeCapsule(root, { baseline: { kind: "git", commit: "0123456789abcdef0123456789abcdef01234567" } });
    expect(() => admitCapsule(dir)).toThrow(/hardened git .* failed/);
  });
});

describe("run-dir capsule snapshot + resume revalidation", () => {
  it("snapshots round-trip and revalidate against the identical capsule", () => {
    const root = makeRoot();
    const dir = makeCapsule(root);
    const runDir = makeRoot();
    writeCapsuleSnapshot(runDir, manifestObject());
    expect(readCapsuleSnapshot(runDir)).toEqual(manifestObject());
    expect(revalidateForResume(runDir, dir).digest).toBe(capsuleDigest(manifestObject()));
  });

  it("refuses resume when the capsule re-admits at a DIFFERENT digest than the snapshot", () => {
    const root = makeRoot();
    const runDir = makeRoot();
    writeCapsuleSnapshot(runDir, manifestObject());
    // A validly re-scaffolded but different capsule (new objective -> new id/digest).
    const dir = makeCapsule(root, { objective: "A different task entirely." });
    expect(() => revalidateForResume(runDir, dir)).toThrow(/capsule drift since the run started/);
  });

  it("refuses resume when the snapshot is missing (identity cannot be proven)", () => {
    const root = makeRoot();
    const dir = makeCapsule(root);
    expect(() => revalidateForResume(makeRoot(), dir)).toThrow(/cannot prove capsule identity/);
  });

  it("hone run writes the admitted-manifest snapshot into the run dir", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", "stub"], io)).toBe(0);
    const runsDir = join(root, ".hone-runs");
    const snapshot = CapsuleManifest.parse(JSON.parse(readFileSync(join(runsDir, readdirOnly(runsDir), "capsule-manifest.json"), "utf8")));
    expect(snapshot.id).toBe(CAP_ID);
  });

  it("hone run --resume refuses a capsule that drifted since the run started", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const runDir = writeEvents(root, "run_rz", fixtureEvents({ runId: "run_rz", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false }));
    writeCapsuleSnapshot(runDir, manifestObject());
    writeRunConfigFile(runDir, runConfigFixture());
    // drift the capsule AFTER the run started
    writeFileSync(join(root, "capsule", "assets", "train", "data.txt"), "tampered\n");
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub", "--resume"], io)).rejects.toThrow(/asset drift/);
  });

  it("hone run --resume refuses when the optimizer digest no longer matches the sealed one", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const runDir = writeEvents(root, "run_rd", fixtureEvents({ runId: "run_rd", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false }));
    writeCapsuleSnapshot(runDir, manifestObject());
    writeRunConfigFile(runDir, runConfigFixture());
    // An overridden optimizer command with a pinned digest that differs from the sealed one.
    const { io } = makeIo(root, {
      HONE_STUB_EPISODES: "1",
      HONE_OPTIMIZER_CMD: "node",
      HONE_OPTIMIZER_DIGEST: fakeHash("1"),
    });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub", "--resume"], io)).rejects.toThrow(/optimizer drift/);
  });
});

describe("optimizer digest resolution", () => {
  it("computes a deterministic digest that binds the image", () => {
    const a = computeOptimizerDigest(FIX_IMAGE);
    expect(a).toBe(FIX_OPTIMIZER_DIGEST);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeOptimizerDigest(`other@sha256:${"b".repeat(64)}`)).not.toBe(a);
  });

  it("an overridden in-container command REQUIRES a valid explicit digest; ENTRY is refused outright", () => {
    expect(() => resolveOptimizerDigest({ HONE_OPTIMIZER_CMD: "node" }, FIX_IMAGE)).toThrow(/explicit HONE_OPTIMIZER_DIGEST/);
    expect(() => resolveOptimizerDigest({ HONE_OPTIMIZER_ENTRY: "/tmp/x.mjs" }, FIX_IMAGE)).toThrow(/no longer supported/);
    expect(() => resolveOptimizerDigest({ HONE_OPTIMIZER_CMD: "node", HONE_OPTIMIZER_DIGEST: "not-a-digest" }, FIX_IMAGE)).toThrow(
      /explicit HONE_OPTIMIZER_DIGEST/,
    );
    const pinned = fakeHash("2");
    expect(resolveOptimizerDigest({ HONE_OPTIMIZER_CMD: "node", HONE_OPTIMIZER_DIGEST: pinned }, FIX_IMAGE)).toBe(pinned);
  });

  it("a stale explicit pin on the DEFAULT optimizer fails closed", () => {
    expect(() => resolveOptimizerDigest({ HONE_OPTIMIZER_DIGEST: fakeHash("3") }, FIX_IMAGE)).toThrow(/misleading pin/);
    expect(resolveOptimizerDigest({ HONE_OPTIMIZER_DIGEST: FIX_OPTIMIZER_DIGEST }, FIX_IMAGE)).toBe(FIX_OPTIMIZER_DIGEST);
    expect(resolveOptimizerDigest({}, FIX_IMAGE)).toBe(FIX_OPTIMIZER_DIGEST);
  });

  it("hone run seals the computed digest into run.started", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io, out } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", "stub"], io)).toBe(0);
    const started = out.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e["type"] === "run.started");
    expect(started?.["optimizerDigest"]).toBe(FIX_OPTIMIZER_DIGEST);
  });
});

function readdirOnly(dir: string): string {
  const entries = readdirSync(dir);
  expect(entries.length).toBe(1);
  return entries[0] ?? "";
}

function runConfigFixture(): RunConfig {
  return RunConfig.parse({
    version: 1,
    capsuleId: CAP_ID,
    objective: "fixture objective",
    budget: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
    routing: { mutation: { model: "test-model" } },
    headless: true,
  });
}
