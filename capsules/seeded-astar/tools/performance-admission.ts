#!/usr/bin/env -S node --import tsx
/**
 * Trusted pre-freeze §5.2 performance admission for seeded-astar.
 *
 * Measurement mode launches nine balanced/interleaved fresh Docker containers
 * for the baseline seed, frozen M0 winner, and independent alternate. Check
 * mode is strictly read-only and validates the sealed evidence and its live
 * source/runtime identities.
 *
 *   capsules/node_modules/.bin/tsx capsules/seeded-astar/tools/performance-admission.ts --measure
 *   capsules/node_modules/.bin/tsx capsules/seeded-astar/tools/performance-admission.ts --check
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CapsuleManifest,
  EvaluatorOutput,
  canonicalJson,
  deriveCapsuleId,
  type EvaluatorOutput as EvaluatorOutputValue,
} from "@hone/schema";

const CAPSULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = resolve(CAPSULE_DIR, "..", "..");
const CONFIG_PATH = join(CAPSULE_DIR, "capsule.config.json");
const MANIFEST_PATH = join(CAPSULE_DIR, "manifest.json");
const SIDECAR_REL = "diagnostics/performance-admission.json";
const SIDECAR_PATH = join(CAPSULE_DIR, SIDECAR_REL);
const HARNESS_REL = "tools/performance-admission.ts";
const HARNESS_PATH = join(CAPSULE_DIR, HARNESS_REL);
const BASELINE_DIR = join(CAPSULE_DIR, "baseline");
const SCHEMA = "hone-seeded-astar-performance-admission-v1";
const IMAGE =
  "hone-mutation@sha256:f680ddc7c1d5facfec0cce238784ab459bc4d54221e64a262101f20d575252f7";
const SAMPLE_SEED = 99173;
const SAMPLES_PER_ARTIFACT = 9;
const CPU_QUOTA = 2;
const NANO_CPUS = CPU_QUOTA * 1_000_000_000;
const MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const PIDS_LIMIT = 512;
const PROCESS_TIMEOUT_MS = 300_000;
const M0_RUN_ID = "run_mrnta7aq34f9c0";
const M0_ARTIFACT =
  "sha256:cd9cc018ec8fd5a60cff0af202839c6e799da35ead358b445d1405f5df65bb9e";
const Q_FAIL = 0;
const Q_BASE = 0.023772025789093716;
const Q_REFERENCE = 0.21622805389884087;
const Q_SCALE = 0.19245602810974716;

const ARTIFACT_NAMES = ["baseline", "reference", "alternate"] as const;
type ArtifactName = (typeof ARTIFACT_NAMES)[number];

interface ArtifactSpec {
  sourcePath: string;
  workspacePath: string;
  role: string;
}

const ARTIFACTS: Record<ArtifactName, ArtifactSpec> = {
  baseline: {
    sourcePath: "baseline/astar.py",
    workspacePath: "baseline",
    role: "seed",
  },
  reference: {
    sourcePath: "diagnostics/improved/astar.py",
    workspacePath: "diagnostics/improved",
    role: "frozen-m0-winner-reference",
  },
  alternate: {
    sourcePath: "diagnostics/alternate/astar.py",
    workspacePath: "diagnostics/alternate",
    role: "independent-alternate-diagnostic",
  },
};

/** Three balanced Latin-order blocks, so every artifact occupies every slot three times. */
const INTERLEAVE: readonly ArtifactName[] = [
  "baseline",
  "reference",
  "alternate",
  "reference",
  "alternate",
  "baseline",
  "alternate",
  "baseline",
  "reference",
  "baseline",
  "reference",
  "alternate",
  "reference",
  "alternate",
  "baseline",
  "alternate",
  "baseline",
  "reference",
  "baseline",
  "reference",
  "alternate",
  "reference",
  "alternate",
  "baseline",
  "alternate",
  "baseline",
  "reference",
];

interface SampleEvidence {
  artifact: ArtifactName;
  containerConfigSha256: string;
  containerId: string;
  ordinal: number;
  positionInRound: number;
  responseQualityHash: string;
  round: number;
  runtimeMs: number;
}

interface MeasurementStats {
  madMs: number;
  madOverMedian: number;
  medianMs: number;
  p50Ms: number;
  p95Ms: number;
  responseQualityHash: string;
  samplesMs: number[];
}

interface PerformanceBinding {
  harnessPath: string;
  harnessSha256: string;
  path: string;
  schema: string;
  sha256: string;
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function runText(command: string, args: readonly string[], timeoutMs = 30_000): string {
  return execFileSync(command, [...args], {
    cwd: REPO_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  }).trim();
}

/** R-7 linear quantile, recorded verbatim in the sidecar protocol. */
function quantile(samples: readonly number[], probability: number): number {
  if (samples.length === 0) throw new Error("quantile requires samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) throw new Error("quantile index outside samples");
  return low + (high - low) * (index - lower);
}

function summarize(samples: readonly number[], responseQualityHash: string): MeasurementStats {
  if (samples.length !== SAMPLES_PER_ARTIFACT) {
    throw new Error(`expected ${SAMPLES_PER_ARTIFACT} samples, received ${samples.length}`);
  }
  const medianMs = quantile(samples, 0.5);
  const madMs = quantile(
    samples.map((sample) => Math.abs(sample - medianMs)),
    0.5,
  );
  return {
    madMs,
    madOverMedian: madMs / medianMs,
    medianMs,
    p50Ms: medianMs,
    p95Ms: quantile(samples, 0.95),
    responseQualityHash,
    samplesMs: [...samples],
  };
}

function canonicalResponse(output: EvaluatorOutputValue): Record<string, unknown> {
  const cases: Record<string, string> = {};
  for (const [caseId, entry] of Object.entries(output.perExample).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof entry.feedback !== "string") {
      throw new Error(`${caseId}: trusted feedback must be a string`);
    }
    const timingFree = entry.feedback.replace(/ in slowest [0-9]+(?:\.[0-9]+)? ms$/, "");
    if (!/^all 5 reps returned optimal len [1-9][0-9]*$/.test(timingFree)) {
      throw new Error(`${caseId}: not every timed path was trusted-valid and optimal: ${entry.feedback}`);
    }
    cases[caseId] = timingFree;
  }
  const diagnostics = expectRecord(output.diagnostics, "evaluator diagnostics");
  const summary = expectString(diagnostics["summary"], "evaluator diagnostics.summary");
  const trustedSuite = summary.split("trusted suite: ")[1];
  if (trustedSuite !== "all checks passed") {
    throw new Error(`trusted fixed correctness suite failed: ${summary}`);
  }
  const quality = expectNumber(diagnostics["quality"], "evaluator diagnostics.quality");
  return {
    cases,
    constraints: output.constraints,
    quality,
    trustedSuite,
    valid: output.valid,
  };
}

function verifyOutput(output: EvaluatorOutputValue, expectedCaseIds: readonly string[]): string {
  const observedIds = Object.keys(output.perExample).sort();
  if (canonicalJson(observedIds) !== canonicalJson([...expectedCaseIds].sort())) {
    throw new Error(`fixed case mismatch: ${canonicalJson(observedIds)} vs ${canonicalJson(expectedCaseIds)}`);
  }
  if (
    output.valid !== true ||
    output.constraints["tests_pass"] !== true ||
    output.constraints["paths_optimal"] !== true
  ) {
    throw new Error(`trusted correctness constraints failed: ${canonicalJson(output)}`);
  }
  const response = canonicalResponse(output);
  if (response["quality"] !== 1) throw new Error("trusted quality must equal 1 exactly");
  return sha256(canonicalJson(response));
}

function inspectMeasurementContainer(containerId: string): { configSha256: string; raw: Record<string, unknown> } {
  const rows = expectArray(readJsonFromText(runText("docker", ["inspect", containerId])), "docker inspect");
  const row = expectRecord(rows[0], "docker inspect[0]");
  const hostConfig = expectRecord(row["HostConfig"], "docker inspect HostConfig");
  const config = expectRecord(row["Config"], "docker inspect Config");
  if (hostConfig["NetworkMode"] !== "none") throw new Error("measurement container network is not none");
  if (hostConfig["ReadonlyRootfs"] !== true) throw new Error("measurement container rootfs is not read-only");
  if (hostConfig["NanoCpus"] !== NANO_CPUS) {
    throw new Error(`measurement container NanoCpus ${String(hostConfig["NanoCpus"])} != ${NANO_CPUS}`);
  }
  if (hostConfig["Memory"] !== MEMORY_BYTES || hostConfig["MemorySwap"] !== MEMORY_BYTES) {
    throw new Error("measurement container memory quota differs from the frozen protocol");
  }
  if (hostConfig["PidsLimit"] !== PIDS_LIMIT) {
    throw new Error(`measurement container pids limit differs: ${String(hostConfig["PidsLimit"])}`);
  }
  if (config["Image"] !== IMAGE) throw new Error(`measurement image differs: ${String(config["Image"])}`);
  const projection = {
    capAdd: hostConfig["CapAdd"],
    capDrop: hostConfig["CapDrop"],
    image: config["Image"],
    memory: hostConfig["Memory"],
    memorySwap: hostConfig["MemorySwap"],
    mounts: hostConfig["Binds"],
    nanoCpus: hostConfig["NanoCpus"],
    networkMode: hostConfig["NetworkMode"],
    pidsLimit: hostConfig["PidsLimit"],
    readonlyRootfs: hostConfig["ReadonlyRootfs"],
    securityOpt: hostConfig["SecurityOpt"],
    shmSize: hostConfig["ShmSize"],
    tmpfs: hostConfig["Tmpfs"],
    user: config["User"],
    workingDir: config["WorkingDir"],
  };
  return { configSha256: sha256(canonicalJson(projection)), raw: row };
}

function readJsonFromText(text: string): unknown {
  return JSON.parse(text);
}

function runSample(
  artifact: ArtifactName,
  ordinal: number,
  expectedCaseIds: readonly string[],
): SampleEvidence {
  const spec = ARTIFACTS[artifact];
  const name = `hone-seeded-perf-${process.pid}-${ordinal}-${randomBytes(4).toString("hex")}`;
  const createArgs = [
    "create",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--log-driver",
    "none",
    "--pids-limit",
    String(PIDS_LIMIT),
    "--memory",
    String(MEMORY_BYTES),
    "--memory-swap",
    String(MEMORY_BYTES),
    "--cpus",
    String(CPU_QUOTA),
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "KILL",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "IPC_OWNER",
    "--cap-add",
    "SYS_ADMIN",
    "--pull",
    "never",
    "--tmpfs",
    "/tmp:size=16m,nosuid,nodev,noexec",
    "--shm-size",
    "16m",
    "--user",
    "0:0",
    "-w",
    "/trusted/baseline",
    "-e",
    `HONE_SEED=${SAMPLE_SEED}`,
    "-v",
    `${join(CAPSULE_DIR, spec.workspacePath)}:/workspace:ro`,
    "-v",
    `${BASELINE_DIR}:/trusted/baseline:ro`,
    "--tmpfs",
    "/capsule:mode=0700,size=1m",
    "-v",
    `${join(CAPSULE_DIR, "assets", "train")}:/capsule/assets/train:ro`,
    "-v",
    `${join(CAPSULE_DIR, "assets", "validation")}:/capsule/assets/validation:ro`,
    IMAGE,
    "python3",
    "-I",
    "-B",
    "eval.py",
  ];
  const containerId = runText("docker", createArgs);
  let outputText = "";
  let configSha256 = "";
  try {
    const inspected = inspectMeasurementContainer(containerId);
    configSha256 = inspected.configSha256;
    outputText = runText("docker", ["start", "-a", containerId], PROCESS_TIMEOUT_MS);
  } finally {
    runText("docker", ["rm", "-f", containerId]);
  }
  const output = EvaluatorOutput.parse(readJsonFromText(outputText));
  const diagnostics = expectRecord(output.diagnostics, "evaluator diagnostics");
  const runtimeMs = expectNumber(diagnostics["runtime_ms"], "evaluator diagnostics.runtime_ms");
  if (!(runtimeMs > 0)) throw new Error(`runtime must be positive, received ${runtimeMs}`);
  return {
    artifact,
    containerConfigSha256: configSha256,
    containerId,
    ordinal,
    positionInRound: (ordinal - 1) % ARTIFACT_NAMES.length,
    responseQualityHash: verifyOutput(output, expectedCaseIds),
    round: Math.floor((ordinal - 1) / ARTIFACT_NAMES.length),
    runtimeMs,
  };
}

function currentDockerIdentity(): Record<string, unknown> {
  const version = expectRecord(
    readJsonFromText(runText("docker", ["version", "--format", "{{json .}}"])),
    "docker version",
  );
  const info = expectRecord(
    readJsonFromText(runText("docker", ["info", "--format", "{{json .}}"])),
    "docker info",
  );
  const imageRows = expectArray(readJsonFromText(runText("docker", ["image", "inspect", IMAGE])), "image inspect");
  const image = expectRecord(imageRows[0], "image inspect[0]");
  const server = expectRecord(version["Server"], "docker version Server");
  const components = expectArray(server["Components"], "docker version Server.Components");
  const componentIdentity = components.map((entry, index) => {
    const component = expectRecord(entry, `docker component ${index}`);
    return {
      details: component["Details"],
      name: component["Name"],
      version: component["Version"],
    };
  });
  const descriptor = expectRecord(image["Descriptor"], "image Descriptor");
  const rootFs = expectRecord(image["RootFS"], "image RootFS");
  const imageId = expectString(image["Id"], "image Id");
  if (imageId !== IMAGE.slice("hone-mutation@".length)) {
    throw new Error(`pinned image ID mismatch: ${imageId} vs ${IMAGE}`);
  }
  return {
    client: version["Client"],
    engine: {
      architecture: info["Architecture"],
      cgroupDriver: info["CgroupDriver"],
      cgroupVersion: info["CgroupVersion"],
      components: componentIdentity,
      cpus: info["NCPU"],
      driver: info["Driver"],
      id: info["ID"],
      kernelVersion: info["KernelVersion"],
      memoryBytes: info["MemTotal"],
      operatingSystem: info["OperatingSystem"],
      osType: info["OSType"],
      serverVersion: info["ServerVersion"],
    },
    image: {
      architecture: image["Architecture"],
      created: image["Created"],
      descriptorDigest: descriptor["digest"],
      descriptorMediaType: descriptor["mediaType"],
      descriptorSize: descriptor["size"],
      id: imageId,
      os: image["Os"],
      repoDigests: image["RepoDigests"],
      rootFsLayers: rootFs["Layers"],
      sizeBytes: image["Size"],
    },
  };
}

function gitBaselineIdentity(): Record<string, unknown> {
  const gitDir = join(BASELINE_DIR, ".gitdir");
  const common = ["--git-dir", gitDir, "--work-tree", BASELINE_DIR];
  const head = runText("git", [...common, "rev-parse", "HEAD"]);
  const tree = runText("git", [...common, "rev-parse", "HEAD^{tree}"]);
  const status = runText("git", [
    ...common,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":!.gitdir",
  ]);
  if (status !== "") throw new Error(`baseline work tree drift: ${status}`);
  return { commit: head, status: "clean", tree: `git-sha1:${tree}` };
}

function fixedInputs(manifest: CapsuleManifest): {
  assetHashes: Record<string, string>;
  caseIds: string[];
  contentHashSetSha256: string;
} {
  const measuredGroups = manifest.assetGroups.filter((group) => group.id === "train" || group.id === "validation");
  if (measuredGroups.length !== 2) throw new Error("manifest must contain exact train and validation measurement groups");
  const paths = measuredGroups.flatMap((group) => group.paths).sort();
  const assetHashes: Record<string, string> = {};
  const caseIds: string[] = [];
  for (const rel of paths) {
    const expected = manifest.contentHashes[rel];
    if (expected === undefined) throw new Error(`manifest content hash missing for ${rel}`);
    const bytes = readFileSync(join(CAPSULE_DIR, rel));
    const observed = sha256(bytes);
    if (observed !== expected) throw new Error(`${rel}: ${observed} != manifest ${expected}`);
    assetHashes[rel] = observed;
    const fixture = expectRecord(JSON.parse(bytes.toString("utf8")), rel);
    caseIds.push(expectString(fixture["id"], `${rel}.id`));
  }
  if (new Set(caseIds).size !== caseIds.length) throw new Error("fixed asset case IDs are not unique");
  return {
    assetHashes,
    caseIds: caseIds.sort(),
    contentHashSetSha256: sha256(canonicalJson(assetHashes)),
  };
}

function sourceIdentities(manifest: CapsuleManifest): Record<string, unknown> {
  const hashes: Record<ArtifactName, string> = {
    alternate: sha256(readFileSync(join(CAPSULE_DIR, ARTIFACTS.alternate.sourcePath))),
    baseline: sha256(readFileSync(join(CAPSULE_DIR, ARTIFACTS.baseline.sourcePath))),
    reference: sha256(readFileSync(join(CAPSULE_DIR, ARTIFACTS.reference.sourcePath))),
  };
  if (new Set(Object.values(hashes)).size !== ARTIFACT_NAMES.length) {
    throw new Error("baseline, M0 reference, and alternate source identities must be distinct");
  }
  const meta = expectRecord(manifest.meta, "manifest meta");
  const m0 = expectRecord(meta["m0Delivery"], "manifest meta.m0Delivery");
  const alternate = expectRecord(
    meta["independentDiagnosticOrdering"],
    "manifest meta.independentDiagnosticOrdering",
  );
  if (
    m0["runId"] !== M0_RUN_ID ||
    m0["artifact"] !== M0_ARTIFACT ||
    m0["sourceSha256"] !== hashes.reference
  ) {
    throw new Error("frozen M0 delivery semantics or source identity changed");
  }
  if (alternate["candidateSha256"] !== hashes.alternate) {
    throw new Error("independent alternate source identity changed");
  }
  if (manifest.image !== IMAGE) throw new Error(`manifest image changed: ${manifest.image}`);
  if (manifest.baseline.kind !== "git") throw new Error("seeded baseline must remain git-pinned");
  const baselineGit = gitBaselineIdentity();
  if (baselineGit["commit"] !== manifest.baseline.commit) {
    throw new Error("baseline git HEAD differs from manifest");
  }
  return {
    artifacts: {
      alternate: {
        compositionIdentity: sha256(
          canonicalJson({ baselineCommit: manifest.baseline.commit, overlay: hashes.alternate }),
        ),
        independentReport: alternate["reportSha256"],
        role: ARTIFACTS.alternate.role,
        sourcePath: ARTIFACTS.alternate.sourcePath,
        sourceSha256: hashes.alternate,
      },
      baseline: {
        artifactIdentity: `git:${manifest.baseline.commit}`,
        role: ARTIFACTS.baseline.role,
        sourcePath: ARTIFACTS.baseline.sourcePath,
        sourceSha256: hashes.baseline,
      },
      reference: {
        artifactIdentity: M0_ARTIFACT,
        compositionIdentity: sha256(
          canonicalJson({ baselineCommit: manifest.baseline.commit, overlay: hashes.reference }),
        ),
        role: ARTIFACTS.reference.role,
        runId: M0_RUN_ID,
        sourcePath: ARTIFACTS.reference.sourcePath,
        sourceSha256: hashes.reference,
      },
    },
    baselineGit,
  };
}

function toolIdentities(): Record<string, unknown> {
  const toolPaths = [
    HARNESS_REL,
    "baseline/eval.py",
    "baseline/worker.py",
    "baseline/test_astar.py",
  ];
  const capsuleHashes: Record<string, string> = {};
  for (const rel of toolPaths) capsuleHashes[rel] = sha256(readFileSync(join(CAPSULE_DIR, rel)));
  const repoTools = [
    "capsules/tools/scaffold.ts",
    "schema/src/canonical.ts",
    "schema/src/evaluator.ts",
    "pnpm-lock.yaml",
  ];
  const repoHashes: Record<string, string> = {};
  for (const rel of repoTools) repoHashes[rel] = sha256(readFileSync(join(REPO_DIR, rel)));
  const tsxPackagePath = join(REPO_DIR, "capsules", "node_modules", "tsx", "package.json");
  const tsxPackage = expectRecord(readJson(tsxPackagePath), "tsx package");
  return {
    capsuleFiles: capsuleHashes,
    node: { arch: process.arch, platform: process.platform, version: process.version },
    repositoryFiles: repoHashes,
    tsx: {
      packageJsonSha256: sha256(readFileSync(tsxPackagePath)),
      version: tsxPackage["version"],
    },
  };
}

function frozenSemantics(manifest: CapsuleManifest): Record<string, unknown> {
  const meta = expectRecord(manifest.meta, "manifest meta");
  const normalization = expectRecord(meta["m1Normalization"], "manifest meta.m1Normalization");
  const observed = {
    qBase: normalization["qBase"],
    qFail: normalization["qFail"],
    qReference: normalization["qReference"],
    scale: normalization["scale"],
  };
  const expected = { qBase: Q_BASE, qFail: Q_FAIL, qReference: Q_REFERENCE, scale: Q_SCALE };
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error(`qFail/qBase/qReference/scale changed: ${canonicalJson(observed)}`);
  }
  const orderingBytes = readFileSync(join(CAPSULE_DIR, manifest.diagnosticOrdering.path));
  const orderingSha256 = sha256(orderingBytes);
  if (orderingSha256 !== manifest.diagnosticOrdering.hash) {
    throw new Error("manifest-pinned diagnostic ordering report drifted");
  }
  const ordering = expectRecord(JSON.parse(orderingBytes.toString("utf8")), "ordering report");
  const variants = expectRecord(ordering["variants"], "ordering report variants");
  const order = ["broken", "naive", "baseline", "improved"].map((name) => {
    const variant = expectRecord(variants[name], `ordering report ${name}`);
    return { combined: expectNumber(variant["combined"], `${name}.combined`), name };
  });
  if (!(order[0]!.combined < order[1]!.combined && order[1]!.combined < order[2]!.combined && order[2]!.combined < order[3]!.combined)) {
    throw new Error(`frozen diagnostic order changed: ${canonicalJson(order)}`);
  }
  return {
    m0: { artifact: M0_ARTIFACT, runId: M0_RUN_ID },
    normalization: expected,
    ordering: {
      relation: "broken < naive < baseline < improved",
      reportPath: manifest.diagnosticOrdering.path,
      reportSha256: orderingSha256,
      values: order,
    },
  };
}

function computeGates(
  stats: Record<ArtifactName, MeasurementStats>,
  hashes: Record<ArtifactName, string>,
): Record<string, unknown> {
  const maxMadOverMedian = Math.max(...ARTIFACT_NAMES.map((name) => stats[name].madOverMedian));
  const referenceMedianFractionFaster =
    (stats.baseline.medianMs - stats.reference.medianMs) / stats.baseline.medianMs;
  const referenceP95OverBaselineP95 = stats.reference.p95Ms / stats.baseline.p95Ms;
  const measuredNoise = maxMadOverMedian;
  const effectOverMeasuredNoise =
    measuredNoise === 0 ? null : referenceMedianFractionFaster / measuredNoise;
  const stabilityAtMostFivePercent = maxMadOverMedian <= 0.05;
  const effectAtLeastThreeTimesNoise =
    measuredNoise === 0 || referenceMedianFractionFaster >= 3 * measuredNoise;
  const identicalResponseQualityHash = new Set(Object.values(hashes)).size === 1;
  const diagnosticSourceHashesDistinct =
    sha256(readFileSync(join(CAPSULE_DIR, ARTIFACTS.reference.sourcePath))) !==
    sha256(readFileSync(join(CAPSULE_DIR, ARTIFACTS.alternate.sourcePath)));
  const referenceMedianAtLeastFifteenPercentFaster = referenceMedianFractionFaster >= 0.15;
  const referenceP95AtMostFivePercentWorse = referenceP95OverBaselineP95 <= 1.05;
  const twoDistinctDiagnosticsAboveBaseline =
    diagnosticSourceHashesDistinct &&
    stats.reference.medianMs < stats.baseline.medianMs &&
    stats.alternate.medianMs < stats.baseline.medianMs;
  const noiseGate = stabilityAtMostFivePercent || effectAtLeastThreeTimesNoise;
  const planGate =
    noiseGate &&
    referenceMedianAtLeastFifteenPercentFaster &&
    referenceP95AtMostFivePercentWorse &&
    identicalResponseQualityHash &&
    twoDistinctDiagnosticsAboveBaseline;
  return {
    diagnosticSourceHashesDistinct,
    effectAtLeastThreeTimesNoise,
    effectOverMeasuredNoise,
    identicalResponseQualityHash,
    maxMadOverMedian,
    measuredNoiseDefinition: "max artifact MAD/median across baseline, reference, alternate",
    noiseGate,
    planGate,
    referenceMedianAtLeastFifteenPercentFaster,
    referenceMedianFractionFaster,
    referenceP95AtMostFivePercentWorse,
    referenceP95OverBaselineP95,
    stabilityAtMostFivePercent,
    twoDistinctDiagnosticsAboveBaseline,
  };
}

function makeSidecar(): Record<string, unknown> {
  const manifest = CapsuleManifest.parse(readJson(MANIFEST_PATH));
  if (deriveCapsuleId(manifest) !== manifest.id) throw new Error("manifest ID does not derive before measurement");
  const inputs = fixedInputs(manifest);
  const sources = sourceIdentities(manifest);
  const docker = currentDockerIdentity();
  const tools = toolIdentities();
  const semantics = frozenSemantics(manifest);
  const samples: SampleEvidence[] = [];
  const sampleValues: Record<ArtifactName, number[]> = {
    alternate: [],
    baseline: [],
    reference: [],
  };
  const responseHashes: Record<ArtifactName, string[]> = {
    alternate: [],
    baseline: [],
    reference: [],
  };
  for (const [index, artifact] of INTERLEAVE.entries()) {
    const sample = runSample(artifact, index + 1, inputs.caseIds);
    samples.push(sample);
    sampleValues[artifact].push(sample.runtimeMs);
    responseHashes[artifact].push(sample.responseQualityHash);
    console.log(
      `performance-admission: ${index + 1}/${INTERLEAVE.length} ${artifact} ${sample.runtimeMs.toFixed(6)} ms ${sample.responseQualityHash}`,
    );
  }
  const artifactHashes: Record<ArtifactName, string> = {
    alternate: responseHashes.alternate[0] ?? "",
    baseline: responseHashes.baseline[0] ?? "",
    reference: responseHashes.reference[0] ?? "",
  };
  for (const name of ARTIFACT_NAMES) {
    if (responseHashes[name].length !== SAMPLES_PER_ARTIFACT) {
      throw new Error(`${name}: wrong sample count`);
    }
    if (!responseHashes[name].every((hash) => hash === artifactHashes[name])) {
      throw new Error(`${name}: response/quality hash changed between samples`);
    }
  }
  const measurements: Record<ArtifactName, MeasurementStats> = {
    alternate: summarize(sampleValues.alternate, artifactHashes.alternate),
    baseline: summarize(sampleValues.baseline, artifactHashes.baseline),
    reference: summarize(sampleValues.reference, artifactHashes.reference),
  };
  const gates = computeGates(measurements, artifactHashes);
  const planGate = expectBoolean(gates["planGate"], "computed plan gate");
  return {
    admission: planGate ? "PASS" : "FAIL",
    commands: [
      "capsules/node_modules/.bin/tsx capsules/seeded-astar/tools/performance-admission.ts --measure",
      "capsules/node_modules/.bin/tsx capsules/tools/scaffold.ts capsules/seeded-astar (twice; byte-identical manifest)",
      "capsules/node_modules/.bin/tsx capsules/seeded-astar/tools/performance-admission.ts --check (twice; non-mutating)",
    ],
    fixedInputs: {
      assetGroups: ["train", "validation"],
      assetHashes: inputs.assetHashes,
      caseIds: inputs.caseIds,
      contentHashSetSha256: inputs.contentHashSetSha256,
      holdoutPolicy: "not mounted or read; performance admission preserves existing non-holdout M0/M1 measurement semantics",
      trustedSuite: "13 deterministic cases sealed by baseline/eval.py hash and executed in every sample",
    },
    gates,
    identities: {
      docker,
      sources,
      tools,
    },
    measurements,
    protocol: {
      cpuQuota: {
        dockerFlag: `--cpus=${CPU_QUOTA}`,
        nanoCpus: NANO_CPUS,
        source: "Docker cgroup CPU quota",
      },
      evaluatorEntrypoint: ["python3", "-I", "-B", "eval.py"],
      freshContainerPerSample: true,
      image: IMAGE,
      interleave: INTERLEAVE,
      memoryBytes: MEMORY_BYTES,
      network: "none",
      pidsLimit: PIDS_LIMIT,
      percentile: "R-7 linear interpolation at p=0.50 and p=0.95 over nine container samples",
      readOnlyRootfs: true,
      responseQualityHash:
        "sha256(canonical JSON of valid, constraints, quality, timing-stripped per-case trusted outcomes, and trusted-suite outcome)",
      sampleMetric: "trusted evaluator diagnostics.runtime_ms (median asset slowest-of-five request latency)",
      sampleSeed: SAMPLE_SEED,
      samplesPerArtifact: SAMPLES_PER_ARTIFACT,
      totalFreshContainers: INTERLEAVE.length,
    },
    samples,
    schema: SCHEMA,
    semantics,
    sealing: {
      design:
        "This sidecar records the harness hash but deliberately excludes manifest/config bytes and capsule ID. Manifest/config metadata seal sidecar+harness hashes one-way, avoiding a sidecar<->manifest hash cycle.",
      harnessPath: HARNESS_REL,
      harnessSha256: sha256(readFileSync(HARNESS_PATH)),
      metadataPath: "meta.performanceAdmission",
      sidecarPath: SIDECAR_REL,
    },
  };
}

function bindingFrom(value: unknown, label: string): PerformanceBinding {
  const record = expectRecord(value, label);
  return {
    harnessPath: expectString(record["harnessPath"], `${label}.harnessPath`),
    harnessSha256: expectString(record["harnessSha256"], `${label}.harnessSha256`),
    path: expectString(record["path"], `${label}.path`),
    schema: expectString(record["schema"], `${label}.schema`),
    sha256: expectString(record["sha256"], `${label}.sha256`),
  };
}

function checkStoredMeasurements(sidecar: Record<string, unknown>): void {
  if (sidecar["schema"] !== SCHEMA || sidecar["admission"] !== "PASS") {
    throw new Error("stored performance admission is not a PASS under the frozen schema");
  }
  const rawMeasurements = expectRecord(sidecar["measurements"], "sidecar measurements");
  const stats = {} as Record<ArtifactName, MeasurementStats>;
  const hashes = {} as Record<ArtifactName, string>;
  for (const name of ARTIFACT_NAMES) {
    const raw = expectRecord(rawMeasurements[name], `sidecar measurements.${name}`);
    const samples = expectArray(raw["samplesMs"], `${name}.samplesMs`).map((value, index) =>
      expectNumber(value, `${name}.samplesMs[${index}]`),
    );
    const responseQualityHash = expectString(raw["responseQualityHash"], `${name}.responseQualityHash`);
    const recomputed = summarize(samples, responseQualityHash);
    for (const field of ["madMs", "madOverMedian", "medianMs", "p50Ms", "p95Ms"] as const) {
      if (raw[field] !== recomputed[field]) {
        throw new Error(`${name}.${field} is not reproducible from stored samples`);
      }
    }
    stats[name] = recomputed;
    hashes[name] = responseQualityHash;
  }
  const recomputedGates = computeGates(stats, hashes);
  if (canonicalJson(recomputedGates) !== canonicalJson(sidecar["gates"])) {
    throw new Error("stored gates are not reproducible from stored measurements");
  }
  if (recomputedGates["planGate"] !== true) throw new Error("recomputed §5.2 plan gate failed");
  const rawSamples = expectArray(sidecar["samples"], "sidecar samples");
  if (rawSamples.length !== INTERLEAVE.length) throw new Error("stored raw sample count changed");
  for (const [index, raw] of rawSamples.entries()) {
    const sample = expectRecord(raw, `sidecar samples[${index}]`);
    if (sample["artifact"] !== INTERLEAVE[index] || sample["ordinal"] !== index + 1) {
      throw new Error(`stored sample ${index} violates the frozen interleave`);
    }
    const artifact = INTERLEAVE[index];
    if (artifact === undefined || sample["responseQualityHash"] !== hashes[artifact]) {
      throw new Error(`stored sample ${index} response hash differs from artifact hash`);
    }
  }
}

function focusedCheck(): void {
  const sidecarBytes = readFileSync(SIDECAR_PATH);
  const sidecar = expectRecord(JSON.parse(sidecarBytes.toString("utf8")), "performance sidecar");
  if (`${canonicalJson(sidecar)}\n` !== sidecarBytes.toString("utf8")) {
    throw new Error("performance sidecar bytes are not canonical JSON plus one newline");
  }
  const config = expectRecord(readJson(CONFIG_PATH), "capsule config");
  const configMeta = expectRecord(config["meta"], "capsule config meta");
  const configBinding = bindingFrom(configMeta["performanceAdmission"], "config performanceAdmission");
  const manifest = CapsuleManifest.parse(readJson(MANIFEST_PATH));
  if (deriveCapsuleId(manifest) !== manifest.id) throw new Error("manifest ID no longer derives");
  const manifestMeta = expectRecord(manifest.meta, "manifest meta");
  const manifestBinding = bindingFrom(
    manifestMeta["performanceAdmission"],
    "manifest performanceAdmission",
  );
  if (canonicalJson(configBinding) !== canonicalJson(manifestBinding)) {
    throw new Error("config and manifest performance-admission bindings differ");
  }
  const expectedBinding: PerformanceBinding = {
    harnessPath: HARNESS_REL,
    harnessSha256: sha256(readFileSync(HARNESS_PATH)),
    path: SIDECAR_REL,
    schema: SCHEMA,
    sha256: sha256(sidecarBytes),
  };
  if (canonicalJson(configBinding) !== canonicalJson(expectedBinding)) {
    throw new Error(
      `sealed performance-admission binding drifted: ${canonicalJson(configBinding)} vs ${canonicalJson(expectedBinding)}`,
    );
  }
  checkStoredMeasurements(sidecar);
  const recordedIdentities = expectRecord(sidecar["identities"], "sidecar identities");
  const recordedDocker = recordedIdentities["docker"];
  if (canonicalJson(currentDockerIdentity()) !== canonicalJson(recordedDocker)) {
    throw new Error("current Docker/platform/image identity differs from measured identity");
  }
  const inputs = fixedInputs(manifest);
  const recordedInputs = expectRecord(sidecar["fixedInputs"], "sidecar fixedInputs");
  if (
    canonicalJson(inputs.assetHashes) !== canonicalJson(recordedInputs["assetHashes"]) ||
    canonicalJson(inputs.caseIds) !== canonicalJson(recordedInputs["caseIds"]) ||
    inputs.contentHashSetSha256 !== recordedInputs["contentHashSetSha256"]
  ) {
    throw new Error("fixed manifest assets differ from performance evidence");
  }
  const recordedSources = recordedIdentities["sources"];
  if (canonicalJson(sourceIdentities(manifest)) !== canonicalJson(recordedSources)) {
    throw new Error("current source/artifact identities differ from performance evidence");
  }
  const recordedTools = recordedIdentities["tools"];
  if (canonicalJson(toolIdentities()) !== canonicalJson(recordedTools)) {
    throw new Error("current tool identities differ from performance evidence");
  }
  if (canonicalJson(frozenSemantics(manifest)) !== canonicalJson(sidecar["semantics"])) {
    throw new Error("q/order/M0 semantics differ from performance evidence");
  }
  console.log(`performance-admission check: PASS`);
  console.log(`sidecar sha256: ${expectedBinding.sha256}`);
  console.log(`harness sha256: ${expectedBinding.harnessSha256}`);
  console.log(`manifest id: ${manifest.id}`);
}

const mode = process.argv[2];
if (mode === "--measure") {
  const sidecar = makeSidecar();
  const bytes = `${canonicalJson(sidecar)}\n`;
  writeFileSync(SIDECAR_PATH, bytes, { mode: 0o644 });
  console.log(`performance-admission: ${sidecar["admission"]}`);
  console.log(`sidecar -> ${SIDECAR_PATH}`);
  console.log(`sidecar sha256: ${sha256(bytes)}`);
  console.log(`harness sha256: ${sha256(readFileSync(HARNESS_PATH))}`);
  if (sidecar["admission"] !== "PASS") process.exitCode = 1;
} else if (mode === "--check") {
  focusedCheck();
} else {
  console.error("usage: performance-admission.ts --measure | --check");
  process.exitCode = 2;
}
