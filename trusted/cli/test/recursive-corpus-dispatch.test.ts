import type * as RuntimeDigestModule from "../src/runtime-digest.js";
import type * as OptimizerDigestModule from "../src/optimizer-digest.js";
import type * as AdmissionModule from "../src/admission.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker, CasStore, packDirAsArtifact } from "@hone/broker";
import { metaCampaignConfigHash, type MetaWorkIdentity } from "@hone/meta";
import {
  CapsuleManifest, M2_INNER_MODEL_ROUTE, M2_OUTER_MODEL_ROUTE,
  M2_PANEL_A_TASK_IDS, M2_PANEL_B_TASK_IDS, MetaCampaignConfigV1, MetaCampaignConfigV2,
  QueryCorpusParams, SpawnRunParams, canonicalJson, capsuleDigest,
  type BudgetEnvelope, type MetaCampaignConfigV1 as LegacyConfig,
  type MetaCampaignConfigV2 as RecursiveConfig,
} from "@hone/schema";
import { recursiveCommand } from "../src/commands/hone.js";
import { assembleCorpusProvenance, corpusProvenanceInputsDigest, corpusCohortFenceError, type BuildBrokerCorpusConfigInputs, type AdmittedCorpusCapsule } from "../src/corpus-provenance.js";
import { collectOptimizerSnapshot, snapshotDigest, type OptimizerSnapshot } from "../src/optimizer-digest.js";
import { buildBrokenMetaControl, buildDegradedMetaControl, captureMetaControlSourceSeal, type MetaControlArtifact } from "../src/meta-controls.js";
import { runCommand, type TrustedRunOptions } from "../src/supervisor.js";
import { admitCapsule, type AdmittedCapsule } from "../src/admission.js";
import { gitIn, initScratchRepo, makeCapsule, makeIo, makeRoot, manifestRaw } from "./helpers.js";
import { metaWorkKey } from "../src/meta-journal.js";
import type { CmdIo } from "../src/io.js";

// Only external launch/admission/optimizer preparation are intercepted. Dispatch,
// artifact verification, cohort fencing, durable campaign state and broker queries run for real.
vi.mock("../src/supervisor.js", () => ({ runCommand: vi.fn() }));
vi.mock("../src/runtime-digest.js", async (original) => ({
  ...await original<typeof RuntimeDigestModule>(),
  verifiedBootRuntimeDigest: () => `sha256:${"a".repeat(64)}`,
}));
vi.mock("../src/optimizer-digest.js", async (original) => ({
  ...await original<typeof OptimizerDigestModule>(),
  collectOptimizerSnapshot: vi.fn(),
}));
vi.mock("../src/optimizer-artifact.js", () => ({
  resolveCandidateOptimizer: vi.fn(async ({ artifactHash, baseSnapshot, image }) => ({
    sourceArtifact: artifactHash, mergedDigest: artifactHash, snapshot: baseSnapshot,
    baseDigest: snapshotDigest(image, baseSnapshot), mutablePaths: {},
  })),
}));
vi.mock("../src/optimizer-conformance.js", () => ({
  conformCandidateOptimizer: vi.fn(async (candidate, image) => {
    const body = {
      version: 1, sourceArtifact: candidate.sourceArtifact,
      baseDigest: candidate.baseDigest, mutablePaths: candidate.mutablePaths,
      runtime: {
        version: 1, image, optimizerDigest: candidate.mergedDigest,
        buildContractDigest: digest("build"), bundleDigest: digest("bundle"),
        bundleFiles: {}, runtimeArgv: [], runtimeDigest: digest("runtime"),
      },
      protocol: { version: "jsonrpc-2.0", methods: ["getTask", "getBudget", "finish"], modelEgress: false, childReservations: 0 },
    };
    return { ...body, receiptDigest: digest(canonicalJson(body)) };
  }),
}));
vi.mock("../src/admission.js", async (original) => ({
  ...await original<typeof AdmissionModule>(),
  admitCapsule: vi.fn(),
  capsuleOracleDigest: () => digest("oracle"),
  capsuleScalarizerDigest: () => digest("scalarizer"),
}));

const fixturePath = fileURLToPath(new URL("../../../schema/fixtures/meta-campaign.m1.json", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function legacyConfig(): LegacyConfig {
  return MetaCampaignConfigV1.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
}

function multiply(budget: BudgetEnvelope, factor: number): BudgetEnvelope {
  return {
    maxTokens: budget.maxTokens * factor,
    maxUsd: budget.maxUsd * factor,
    maxWallClockSec: budget.maxWallClockSec * factor,
    maxEvaluatorInvocations: budget.maxEvaluatorInvocations * factor,
  };
}

/** A valid V2 campaign config for the requested stage; capsuleIds are cap_000000000001..08. */
function buildConfig(stage: "A" | "B"): RecursiveConfig {
  const legacy = legacyConfig();
  const capsule = (index: number) => ({
    ...legacy.train[0]!,
    capsuleId: `cap_${index.toString(16).padStart(12, "0")}`,
    capsuleDigest: digest(`recursive:capsule:${index}`),
    image: `hone-task-${index}@${digest(`recursive:image:${index}`)}`,
    oracleDigest: digest(`recursive:oracle:${index}`),
    scalarizerDigest: digest(`recursive:scalarizer:${index}`),
  });
  const train = Array.from({ length: 8 }, (_, index) => capsule(index + 1));
  const holdout = Array.from({ length: 11 }, (_, index) => capsule(index + 101));
  const child = { ...legacy.budgets.child };
  const calibratedPanelCandidate = multiply(child, 8);
  const target = {
    sourceCommit: "1".repeat(40),
    sourceArtifact: digest("recursive:target-source"),
    bundleDigest: digest("recursive:target-bundle"),
  };
  const controller = stage === "A"
    ? target
    : { sourceCommit: "1".repeat(40), sourceArtifact: digest("recursive:controller-source"), bundleDigest: digest("recursive:controller-bundle") };
  const panelTasks = stage === "A" ? M2_PANEL_A_TASK_IDS : M2_PANEL_B_TASK_IDS;
  const confirmationRuns = (stage === "A" ? 4 : 5) * 8 * 3;
  return MetaCampaignConfigV2.parse({
    ...legacy,
    version: 2,
    seedOptimizer: target,
    controllerOptimizer: controller,
    optimizerRuntime: { image: `hone-optimizer@${digest("recursive:optimizer-image")}` },
    generation: stage === "A"
      ? { stage: "A", panel: "A", targetGeneration: 0, controllerGeneration: 0, outerReplicate: 0 }
      : { stage: "B", panel: "B", targetGeneration: 1, controllerGeneration: 0, outerReplicate: 0 },
    calibration: {
      reportDigest: digest("recursive:calibration-report"),
      excludedCapsuleIds: Array.from({ length: 4 }, (_, index) => `cap_${(2001 + index).toString(16).padStart(12, "0")}`),
    },
    corpusCohort: {
      developmentCapsuleIds: [
        ...train.map((entry) => entry.capsuleId),
        ...Array.from({ length: 8 }, (_, index) => `cap_${(2101 + index).toString(16).padStart(12, "0")}`),
      ],
      terminalCapsuleIds: holdout.map((entry) => entry.capsuleId),
      provenanceInputsDigest: digest("recursive:corpus-provenance"),
    },
    train,
    holdout,
    routing: { outerMutation: M2_OUTER_MODEL_ROUTE, innerMutation: M2_INNER_MODEL_ROUTE },
    modelObservation: {
      outerRequestedRoute: M2_OUTER_MODEL_ROUTE,
      innerRequestedRoute: M2_INNER_MODEL_ROUTE,
      identity: "alias-observation",
      recordResponseModel: true,
      recordProviderFingerprint: true,
      driftSentinel: true,
    },
    counts: {
      candidates: 37,
      candidateAttemptsMax: 91,
      innerEpisodesMax: 8,
      searchReplicates: 5,
      confirmationReplicates: 3,
      holdoutReplicates: 3,
      childConcurrency: 2,
    },
    budgets: { ...legacy.budgets, outer: { ...legacy.budgets.outer, maxEvaluatorInvocations: 92 } },
    developmentPanel: {
      panel: stage,
      members: train.map((entry, index) => ({
        taskId: panelTasks[index],
        capsule: entry,
        calibratedInnerCeiling: child,
      })),
    },
    recursiveBudgets: {
      search: {
        identity: { envelopeId: digest("recursive:search-envelope"), purpose: "search" },
        calibratedPanelCandidate,
        outerTrajectory: multiply(calibratedPanelCandidate, 12),
      },
      confirmation: {
        identity: { envelopeId: digest("recursive:confirmation-envelope"), purpose: "confirmation" },
        budget: multiply(child, confirmationRuns),
      },
      terminal: {
        identity: { envelopeId: digest("recursive:terminal-envelope"), purpose: "terminal" },
        budget: multiply(child, 3 * 11 * 3),
      },
    },
    allowedClaim: "recursive-transfer-frozen-corpus",
  });
}

type CorpusInputs = Omit<BuildBrokerCorpusConfigInputs, "campaignConfigHash">;
const roots: string[] = [];
let snapshot: OptimizerSnapshot;
let broken: MetaControlArtifact;
let degraded: MetaControlArtifact;

beforeAll(async () => {
  // Dispatch does not need the installed dependency closure. Keep only a small
  // source fixture plus the three files the real control transforms consume.
  const sources: Record<string, string> = {
    "package.json": "{}\n",
    "tsconfig.json": "{}\n",
    "src/main.ts": "export {};\n",
    "worker/mutate.ts": "export {};\n",
  };
  for (const path of ["src/loop.ts", "assets/context.ts", "assets/policy.ts"]) {
    sources[path] = readFileSync(join(repoRoot, "optimizer", path), "utf8");
  }
  snapshot = { files: new Map(Object.entries(sources).map(([path, content]) => [
    `optimizer/${path}`, { bytes: Buffer.from(content), mode: 0o644 },
  ])) };
  const optimizerDir = makeRoot();
  try {
    for (const [path, content] of Object.entries(sources)) {
      mkdirSync(dirname(join(optimizerDir, path)), { recursive: true });
      writeFileSync(join(optimizerDir, path), content);
    }
    const seal = await captureMetaControlSourceSeal(optimizerDir);
    broken = await buildBrokenMetaControl(optimizerDir, seal);
    degraded = await buildDegradedMetaControl(optimizerDir, seal);
  } finally {
    rmSync(optimizerDir, { recursive: true, force: true });
  }
});
beforeEach(() => {
  vi.mocked(collectOptimizerSnapshot).mockReturnValue(snapshot);
  vi.mocked(runCommand).mockReset();
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface Fixture {
  root: string;
  config: RecursiveConfig;
  corpus: CorpusInputs;
  io: CmdIo;
  save: () => void;
}

async function fixture(): Promise<Fixture> {
  const root = makeRoot();
  roots.push(root);
  initScratchRepo(root);
  writeFileSync(join(root, ".gitignore"), ".hone-*\ncapsules/\ncapsule/\ncampaign.json\n");
  gitIn(root, "add", ".gitignore");
  gitIn(root, "commit", "-m", "ignore synthetic campaign state");
  const config = buildConfig("A");
  config.mutablePaths = ["optimizer/assets"];
  config.protectedPaths = ["trusted", "schema", "optimizer/src", "optimizer/worker"];
  const capsules: Record<string, AdmittedCorpusCapsule> = {};
  const development = Array.from({ length: 16 }, (_, i) => `dev-${i}`);
  const terminal = Array.from({ length: 11 }, (_, i) => `terminal-${i}`);
  for (const label of [...development, ...terminal]) {
    const manifest = CapsuleManifest.parse(manifestRaw({
      objective: `Improve synthetic ${label} while preserving exact output.`,
      assetGroups: [{ id: "data", visibility: terminal.includes(label) ? "holdout" : "public", paths: ["data.txt"] }],
      contentHashes: { "data.txt": digest(`synthetic data for ${label}`) },
      budget: { ...config.budgets.child, maxEvaluatorInvocations: 1000 },
    }));
    capsules[label] = { manifest, digest: capsuleDigest(manifest), provisional: false };
    mkdirSync(join(root, "capsules", label), { recursive: true });
  }
  vi.mocked(admitCapsule).mockImplementation((dir) => {
    const label = dir.slice(dir.lastIndexOf("/") + 1);
    const admitted = capsules[label];
    if (admitted !== undefined) return { ...admitted, orderingReport: {} } as AdmittedCapsule;
    if (label === "outer-capsule") return { manifest: CapsuleManifest.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))) } as AdmittedCapsule;
    throw new Error(`unexpected fixture admission ${dir}`);
  });
  const entry = (label: string) => ({
    ...config.train[0]!, capsuleId: capsules[label]!.manifest.id,
    capsuleDigest: capsules[label]!.digest, image: capsules[label]!.manifest.image,
    oracleDigest: digest("oracle"), scalarizerDigest: digest("scalarizer"),
  });
  config.train = development.slice(0, 8).map(entry);
  config.holdout = terminal.map(entry);
  config.developmentPanel.members.forEach((member, i) => { member.capsule = config.train[i]!; });
  const publicSnapshot = [{ id: "public-history", content: "verified public history" }];
  const panelEvidence = [{ id: "panel-result", content: "verified panel result", cohort: "panel-a" as const, capsuleLabel: development[0]!, usage: { tokens: 12, usd: 0.5, wallClockSec: 3, evaluatorInvocations: 1 } }];
  const provenance = assembleCorpusProvenance({ capsules, mapping: { development, terminal }, publicSnapshot, panelEvidence, generatedAt: "2026-07-22T00:00:00.000Z" });
  config.corpusCohort = {
    developmentCapsuleIds: [...provenance.developmentCapsuleIds],
    terminalCapsuleIds: [...provenance.terminalCapsuleIds],
    provenanceInputsDigest: provenance.inputsDigest,
  };
  const seedDir = join(root, ".hone-seed");
  mkdirSync(seedDir);
  writeFileSync(join(seedDir, "package.json"), "{}\n");
  const sourceArtifact = await packDirAsArtifact(seedDir, new CasStore(join(root, ".hone-cas")));
  const commit = gitIn(root, "rev-parse", "HEAD");
  config.seedOptimizer = { sourceCommit: commit, sourceArtifact, bundleDigest: sourceArtifact };
  config.controllerOptimizer = { ...config.seedOptimizer };
  config.trustedRuntime = { sourceCommit: commit, digest: `sha256:${"a".repeat(64)}` };
  config.controls = {
    brokenSourceArtifact: broken.digest, brokenBundleDigest: broken.digest,
    degradedSourceArtifact: degraded.digest, degradedBundleDigest: degraded.digest,
  };
  MetaCampaignConfigV2.parse(config);
  const corpus: CorpusInputs = { provenance, publicSnapshot, panelEvidence };
  const save = () => writeFileSync(join(root, "campaign.json"), JSON.stringify(config));
  save();
  const { io } = makeIo(root);
  delete io.env["HONE_OPTIMIZER_CMD"];
  return { root, config, corpus, io, save };
}

function queryAtLaunch(root: string, options: TrustedRunOptions) {
  const capsuleRootDir = makeCapsule(root);
  const manifest = CapsuleManifest.parse(manifestRaw());
  const broker = new Broker({
    runId: "run_corpus_probe", manifest, capsuleRootDir,
    baselineArtifactHash: manifest.baseline.kind === "cas" ? manifest.baseline.hash : digest("baseline"),
    capsuleDigest: capsuleDigest(manifest), optimizerDigest: digest("optimizer"),
    holdoutLedgerPath: join(root, ".hone-probe", "holdout.ndjson"),
    image: manifest.image, runDir: join(root, ".hone-probe"), casDir: join(root, ".hone-cas"),
    corpus: options.corpus,
    onEvent: () => {},
  });
  try {
    return broker.queryCorpus(QueryCorpusParams.parse({ query: { text: "verified", sources: ["public-snapshot", "panel-evidence"] }, cursor: null, pageSize: 10 }), { privileged: false });
  } finally { broker.close(); }
}

const searchArgs = ["--campaign", "campaign.json", "--headless", "--phase", "search"];
describe("recursive corpus dispatch", () => {
  it("serves verified documents through the actual outer dispatch handoff", async () => {
    const f = await fixture();
    vi.mocked(runCommand).mockImplementation(async (_args, _io, options = {}) => {
      expect(options.corpusCohort).toBeDefined();
      expect(corpusCohortFenceError(options.corpus!, options.corpusCohort!)).toBeNull();
      const response = queryAtLaunch(f.root, options);
      expect(response.documents.map((doc) => doc.content)).toEqual(["verified panel result", "verified public history"]);
      expect(response.documents.find((doc) => doc.source === "panel-evidence")).toMatchObject({ usage: f.corpus.provenance.panelDocs[0]!.usage, provenance: { campaignConfigHash: metaCampaignConfigHash(f.config), capsuleId: f.config.train[0]!.capsuleId, cohort: "panel-a" } });
      return 17; // Stop before optimizer/provider execution or measurement collection.
    });
    expect(await recursiveCommand(searchArgs, f.io, { corpus: f.corpus })).toBe(17);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it.each(["search", "confirmation", "terminal"])("refuses missing provenance before %s can prepare or launch work", async (phase) => {
    const f = await fixture();
    await expect(recursiveCommand(["--campaign", "campaign.json", "--headless", "--phase", phase], f.io))
      .rejects.toThrow(/requires verified corpus provenance/);
    expect(runCommand).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, ".hone-runs"))).toBe(false);
  });

  it.each([
    ["tampered artifact", (f: Fixture) => { f.corpus.provenance.terminalContentHashes.push(digest("drift")); }, /inputsDigest mismatch/],
    ["tampered document", (f: Fixture) => { f.corpus.publicSnapshot = [{ id: "public-history", content: "changed" }]; }, /bound hash/],
    ["missing document", (f: Fixture) => { f.corpus.panelEvidence = []; }, /were not supplied/],
    ["foreign artifact", (f: Fixture) => { f.config.corpusCohort.provenanceInputsDigest = digest("foreign"); }, /different provenance artifacts/],
    ["foreign cohort", (f: Fixture) => {
      f.config.corpusCohort.developmentCapsuleIds[15] = "cap_ffffffffffff";
    }, /development capsule ids differ/],
    ["capsule digest drift", (f: Fixture) => {
      f.corpus.provenance.capsules.find((record) => record.id === f.config.train[0]!.capsuleId)!.digest = digest("foreign capsule");
      f.corpus.provenance.inputsDigest = corpusProvenanceInputsDigest(f.corpus.provenance);
      f.config.corpusCohort.provenanceInputsDigest = f.corpus.provenance.inputsDigest;
    }, /frozen development identity/],
    ["panel reassignment", (f: Fixture) => {
      f.corpus.provenance.panelDocs[0]!.cohort = "panel-b";
      f.corpus.provenance.inputsDigest = corpusProvenanceInputsDigest(f.corpus.provenance);
      f.config.corpusCohort.provenanceInputsDigest = f.corpus.provenance.inputsDigest;
    }, /frozen panel assignment/],
  ] as const)("refuses %s before any launch", async (_name, mutate, refusal) => {
    const f = await fixture();
    mutate(f);
    f.save();
    await expect(recursiveCommand(searchArgs, f.io, { corpus: f.corpus })).rejects.toThrow(refusal);
    expect(runCommand).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, ".hone-runs"))).toBe(false);
  });

  it("rebinds the same corpus on outer resume and rejects changed bytes before touching retained state", async () => {
    const f = await fixture();
    const outerDir = join(f.root, ".hone-runs", `run_recursive_outer_${metaCampaignConfigHash(f.config).slice(7)}`);
    mkdirSync(outerDir, { recursive: true });
    const eventsPath = join(outerDir, "events.ndjson");
    writeFileSync(eventsPath, "");
    vi.mocked(runCommand).mockImplementation(async (args, _io, options = {}) => {
      expect(args).toContain("--resume");
      expect(queryAtLaunch(f.root, options).documents.map((doc) => doc.content))
        .toEqual(["verified panel result", "verified public history"]);
      expect(corpusCohortFenceError(options.corpus!, options.corpusCohort!)).toBeNull();
      return 17;
    });
    expect(await recursiveCommand(searchArgs, f.io, { corpus: f.corpus })).toBe(17);
    f.corpus.publicSnapshot = [{ id: "public-history", content: "changed after interruption" }];
    await expect(recursiveCommand(searchArgs, f.io, { corpus: f.corpus })).rejects.toThrow(/bound hash/);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(readFileSync(eventsPath, "utf8")).toBe("");
  });

  it.each([false, true])("serves verified corpus to a scheduled child (resume=%s)", async (resume) => {
    const f = await fixture();
    const configHash = metaCampaignConfigHash(f.config);
    const schedule = { candidateOrdinal: 0, allocationOrdinal: 0, innerEpisodesMax: 4 };
    const reservation = f.config.budgets.child;
    const identity: MetaWorkIdentity = {
      phase: "search", arm: "candidate", sourceArtifact: f.config.seedOptimizer.sourceArtifact as `sha256:${string}`,
      bundleDigest: f.config.seedOptimizer.bundleDigest as `sha256:${string}`,
      capsuleId: f.config.train[0]!.capsuleId, replicate: 0,
      measurementEpoch: `m2:${digest(canonicalJson({ ...schedule, reserved: reservation })).slice(7)}`,
    };
    const childRunId = `run_meta_${metaWorkKey(configHash, identity).slice(7)}`;
    const request = SpawnRunParams.parse({
      child: { runId: childRunId, capsuleId: identity.capsuleId, sourceArtifact: { hash: identity.sourceArtifact }, optimizerArtifact: { hash: identity.bundleDigest }, purpose: "capsule", schedule },
      depth: 1, reservation,
    });
    if (resume) {
      const childDir = join(f.root, ".hone-runs", childRunId);
      mkdirSync(childDir, { recursive: true });
      writeFileSync(join(childDir, "events.ndjson"), "");
    }
    const stopped = new Error("offline child launch intercepted");
    vi.mocked(runCommand).mockImplementation(async (args, _io, options = {}) => {
      if (options.proxyRole === "outer-optimizer") {
        const recursive = options.recursiveBroker!;
        const admission = recursive.admitChildRun!({ parentRunId: options.runId!, parentDepth: 0, request });
        expect(admission).toBeDefined();
        await recursive.launchChildRun!({ admission: admission!, request, replay: resume });
        throw new Error("child interception did not stop dispatch");
      }
      expect(options.runId).toBe(childRunId);
      expect(options.measurementEpoch).toBe(identity.measurementEpoch);
      expect(args.includes("--resume")).toBe(resume);
      expect(corpusCohortFenceError(options.corpus!, options.corpusCohort!)).toBeNull();
      expect(queryAtLaunch(f.root, options).documents.map((doc) => doc.content))
        .toEqual(["verified panel result", "verified public history"]);
      throw stopped;
    });
    await expect(recursiveCommand(searchArgs, f.io, { corpus: f.corpus })).rejects.toBe(stopped);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
