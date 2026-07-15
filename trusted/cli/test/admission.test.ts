import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, RunConfig, capsuleDigest } from "@hone/schema";
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

  it("requires a git baseline to be a CLEAN nested worktree at the declared HEAD", () => {
    const root = makeRoot();
    const baseline = join(root, "capsule", "baseline");
    initScratchRepo(baseline);
    const commit = gitIn(baseline, "rev-parse", "HEAD");
    const dir = makeCapsule(root, { baseline: { kind: "git", commit } });
    expect(() => admitCapsule(dir)).not.toThrow();

    // dirty tracked file
    writeFileSync(join(baseline, "hello.txt"), "dirty\n");
    expect(() => admitCapsule(dir)).toThrow(/not clean/);
    writeFileSync(join(baseline, "hello.txt"), "baseline\n");
    expect(() => admitCapsule(dir)).not.toThrow();

    // untracked file counts as dirty too
    writeFileSync(join(baseline, "stray.txt"), "stray\n");
    expect(() => admitCapsule(dir)).toThrow(/not clean/);
  });

  it("refuses a baseline HEAD that differs from the declared commit", () => {
    const root = makeRoot();
    const baseline = join(root, "capsule", "baseline");
    initScratchRepo(baseline);
    const dir = makeCapsule(root, { baseline: { kind: "git", commit: "0123456789abcdef0123456789abcdef01234567" } });
    expect(() => admitCapsule(dir)).toThrow(/baseline HEAD/);
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

  it("an overridden optimizer (CMD or ENTRY) REQUIRES a valid explicit digest", () => {
    expect(() => resolveOptimizerDigest({ HONE_OPTIMIZER_CMD: "node" }, FIX_IMAGE)).toThrow(/explicit HONE_OPTIMIZER_DIGEST/);
    expect(() => resolveOptimizerDigest({ HONE_OPTIMIZER_ENTRY: "/tmp/x.mjs" }, FIX_IMAGE)).toThrow(/explicit HONE_OPTIMIZER_DIGEST/);
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
