import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaCampaignConfigHash } from "@hone/meta";
import { canonicalJson, MetaCampaignConfigV2 } from "@hone/schema";
import { recursiveCommand } from "../src/commands/hone.js";
import { assembleG1Record, writeG1Record } from "../src/gate-records.js";
import { collectOptimizerSnapshot } from "../src/optimizer-digest.js";
import { resolveCandidateOptimizer } from "../src/optimizer-artifact.js";
import { runCommand } from "../src/supervisor.js";
import type { CmdIo } from "../src/io.js";
import type * as OptimizerDigestModule from "../src/optimizer-digest.js";
import { buildConfig, buildMeasurements, digest, passingG1Specs, receiptFor, G1_THRESHOLDS, ID } from "./helpers/gate-fixtures.js";

// Keep command parsing, approval persistence, schemas, identity guards and dispatch
// real. Replace only installed-artifact/admission and execution boundaries; no
// Docker, provider, campaign measurement or terminal input is used by this suite.
vi.mock("../src/supervisor.js", () => ({ runCommand: vi.fn(async () => 1) }));
vi.mock("../src/runtime-digest.js", () => ({ verifiedBootRuntimeDigest: () => `sha256:${"1".repeat(64)}` }));
vi.mock("../src/optimizer-digest.js", async (original) => ({
  ...await original<typeof OptimizerDigestModule>(),
  collectOptimizerSnapshot: vi.fn(),
}));
vi.mock("../src/optimizer-artifact.js", () => ({ resolveCandidateOptimizer: vi.fn() }));
vi.mock("../src/artifact.js", () => ({ extractWorkspaceArtifact: (_cas: string, _hash: string, dir: string) => mkdirSync(dir, { recursive: true }) }));
vi.mock("../src/meta-controls.js", () => ({
  captureMetaControlSourceSeal: async () => ({ version: 1, files: [] }),
  buildBrokenMetaControl: async () => control("broken"),
  buildDegradedMetaControl: async () => control("degraded"),
}));
vi.mock("../src/admission.js", () => ({
  admitCapsule: (dir: string) => {
    const entry = entries.find((candidate) => candidate.capsuleId === basename(dir));
    if (!entry) return {}; // The synthetic capsule has its own real schema check.
    return {
      provisional: false,
      digest: entry.capsuleDigest,
      manifest: {
        id: entry.capsuleId, image: entry.image,
        assetGroups: [{ id: "isolated-test-holdout", visibility: "holdout" }],
        budget: { maxEvaluatorInvocations: 10000 },
      },
      oracleDigest: entry.oracleDigest,
      scalarizerDigest: entry.scalarizerDigest,
    };
  },
  capsuleOracleDigest: (entry: { oracleDigest: string }) => entry.oracleDigest,
  capsuleScalarizerDigest: (entry: { scalarizerDigest: string }) => entry.scalarizerDigest,
}));

function control(kind: "broken" | "degraded") {
  return { bytes: Buffer.from(kind), digest: digest(kind), receipt: { artifactDigest: digest(kind) } };
}
let entries: MetaCampaignConfigV2["train"] = [];
let root: string;
let config: MetaCampaignConfigV2;
let recordDir: string;
let campaignDir: string;
let io: CmdIo;
const dispatchReached = new Error("isolated offline dispatch reached");

function writeConfig() {
  writeFileSync(join(root, "campaign.json"), JSON.stringify(config));
  campaignDir = join(root, ".hone-runs", `recursive-cell-${metaCampaignConfigHash(config).slice(7)}`);
}
function search(phase: string[] = ["--phase", "search"]) {
  return recursiveCommand(["--campaign", "campaign.json", "--headless", ...phase], io);
}
function approve(extra: string[] = []) {
  return search(["--phase", "approve-search", "--record-dir", recordDir,
    "--approver", "synthetic-test-owner", "--reason", "isolated test approval, not campaign authority",
    "--attest-diff-confined", "--attest-mechanism-plausible", ...extra]);
}
function expectNoWork() {
  expect(runCommand).not.toHaveBeenCalled();
  expect(resolveCandidateOptimizer).not.toHaveBeenCalled();
  expect(collectOptimizerSnapshot).not.toHaveBeenCalled();
  expect(existsSync(join(campaignDir, "meta-journal.ndjson"))).toBe(false);
  expect(existsSync(join(campaignDir, "outer-config.json"))).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "hone-search-approval-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), "*\n");
  execFileSync("git", ["-C", root, "add", "-f", ".gitignore"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "isolated fixture"]);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const base = buildConfig("B");
  config = MetaCampaignConfigV2.parse({
    ...base,
    trustedRuntime: { sourceCommit: commit, digest: `sha256:${"1".repeat(64)}` },
    seedOptimizer: { sourceCommit: commit, ...ID.winner },
    controllerOptimizer: { sourceCommit: commit, ...ID.seed },
    controls: {
      brokenSourceArtifact: digest("broken"), brokenBundleDigest: digest("broken-bundle"),
      degradedSourceArtifact: digest("degraded"), degradedBundleDigest: digest("degraded-bundle"),
    },
  });
  const snapshot = { files: new Map([...config.mutablePaths, ...config.protectedPaths]
    .filter((path) => path.startsWith("optimizer/"))
    .map((path) => [path, { bytes: Buffer.from("fixture"), mode: 0o644 as const }])) };
  vi.mocked(collectOptimizerSnapshot).mockReturnValue(snapshot);
  vi.mocked(resolveCandidateOptimizer).mockImplementation(async ({ artifactHash }) => {
    const identity = [config.seedOptimizer, config.controllerOptimizer].find((candidate) => candidate.sourceArtifact === artifactHash);
    return {
      sourceArtifact: artifactHash, baseDigest: digest("base"),
      mergedDigest: identity?.bundleDigest ?? (artifactHash === digest("broken") ? digest("broken-bundle") : digest("degraded-bundle")),
      mutablePaths: {}, snapshot,
    };
  });
  vi.mocked(runCommand).mockRejectedValue(dispatchReached);
  entries = [...config.train, ...config.holdout];
  for (const entry of entries) mkdirSync(join(root, "capsules", entry.capsuleId), { recursive: true });
  recordDir = join(root, "stage-a");
  mkdirSync(recordDir);
  const stageA = buildConfig("A");
  const measurements = buildMeasurements(stageA, passingG1Specs());
  writeG1Record(recordDir, assembleG1Record({ config: stageA, measurements, receipt: receiptFor(measurements),
    thresholds: G1_THRESHOLDS, seed: ID.seed, winner: ID.winner }));
  io = { root, env: {}, isTTY: false, out: () => {}, err: () => {} };
  writeConfig();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("recursive Stage-B search owner handoff", () => {
  it.each([{ phase: [] }, { phase: ["--phase", "search"] }])("unapproved search launches nothing ($phase)", async ({ phase }) => {
    await expect(search(phase)).rejects.toThrow(/G1.*search.*approval.*absent/i);
    expectNoWork();
  });

  it.each([0, 1] as const)("approved controller generation %i reaches offline dispatch without later artifacts", async (generation) => {
    if (generation === 1) {
      config = MetaCampaignConfigV2.parse({ ...config, generation: { ...config.generation, controllerGeneration: 1 }, controllerOptimizer: config.seedOptimizer });
      writeConfig();
    }
    expect(await approve()).toBe(0);
    expectNoWork();
    expect(existsSync(join(campaignDir, "g1-authorization.v1.json"))).toBe(false);
    expect(existsSync(join(campaignDir, "g2-authorization.v1.json"))).toBe(false);
    await expect(search()).rejects.toBe(dispatchReached);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("refreshes approval after asynchronous preparation and before launching work", async () => {
    await approve();
    const resolveArtifact = vi.mocked(resolveCandidateOptimizer).getMockImplementation()!;
    vi.mocked(resolveCandidateOptimizer).mockImplementationOnce(async (input) => {
      const resolved = await resolveArtifact(input);
      rmSync(join(campaignDir, "g1-search-approval.v1.json"));
      return resolved;
    });
    await expect(search()).rejects.toThrow(/G1.*search.*approval.*absent/i);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses a symlinked source directory when recording approval", async () => {
    const alias = join(root, "stage-a-alias");
    symlinkSync(recordDir, alias, "dir");
    recordDir = alias;
    await expect(approve()).rejects.toThrow(/source G1 record directory.*symlink/i);
    expectNoWork();
  });

  it("launches nothing when the approved source directory is replaced by a symlink", async () => {
    await approve();
    const moved = join(root, "relocated-stage-a");
    renameSync(recordDir, moved);
    symlinkSync(moved, recordDir, "dir");
    await expect(search()).rejects.toThrow(/source G1 record directory.*symlink/i);
    expectNoWork();
  });

  it("requires both explicit owner attestations before recording approval", async () => {
    await expect(search(["--phase", "approve-search", "--record-dir", recordDir, "--approver", "synthetic-test-owner", "--reason", "test"]))
      .rejects.toThrow(/attest/);
    expectNoWork();
  });
  it("keeps Stage-A search outside the G1 approval boundary", async () => {
    const stageA = buildConfig("A");
    config = MetaCampaignConfigV2.parse({
      ...config, generation: stageA.generation, developmentPanel: stageA.developmentPanel,
      controllerOptimizer: config.seedOptimizer, recursiveBudgets: stageA.recursiveBudgets,
    });
    writeConfig();
    await expect(search()).rejects.toBe(dispatchReached);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "tampered"])("refuses %s approval before preparing work", async (failure) => {
    await approve();
    const path = join(campaignDir, "g1-search-approval.v1.json");
    const approval = JSON.parse(readFileSync(path, "utf8"));
    if (failure === "rejected") approval.humanDecision.decision = "rejected";
    else approval.humanDecision.reason = "changed since approval";
    writeFileSync(path, JSON.stringify(approval));
    vi.clearAllMocks();
    await expect(search()).rejects.toThrow();
    expectNoWork();
  });

  it("does not reuse approval for a different frozen cell", async () => {
    await approve();
    const approval = readFileSync(join(campaignDir, "g1-search-approval.v1.json"));
    config = MetaCampaignConfigV2.parse({ ...config, generation: { ...config.generation, outerReplicate: 1 } });
    writeConfig();
    mkdirSync(campaignDir, { recursive: true });
    writeFileSync(join(campaignDir, "g1-search-approval.v1.json"), approval);
    vi.clearAllMocks();
    await expect(search()).rejects.toThrow(/not the dispatched campaign/);
    expectNoWork();
  });


  it("rejects a changed Stage-A record before resumed search can dispatch", async () => {
    await approve();
    const path = join(recordDir, "g1-statistical-record.v1.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.generatedAt = "2026-09-07T00:00:00.000Z";
    const { inputsDigest: _old, ...body } = record;
    record.inputsDigest = digest(canonicalJson(body));
    writeG1Record(recordDir, record);
    mkdirSync(join(root, ".hone-runs", `run_recursive_outer_${metaCampaignConfigHash(config).slice(7)}`));
    vi.clearAllMocks();
    await expect(search()).rejects.toThrow(/stale approval/);
    expectNoWork();
  });
});
