import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapsuleManifest,
  DiagnosticOrderingReport,
  canonicalJson,
  deriveCapsuleId,
} from "@hone/schema";

const CAPSULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(CAPSULE_DIR, "diagnostics", "ordering-report.json");
const SIDECAR_PATH = join(CAPSULE_DIR, "diagnostics", "m1-admission.json");
const GROUPS = ["focused-effort", "broader-state", "conversation-tail", "oversized-noise"];

interface Check {
  readonly id: string;
  readonly pass: boolean;
  readonly requirement: string;
  readonly observed: string;
}

interface BankSummary {
  readonly split: string;
  readonly caseCount: number;
  readonly groupCounts: Readonly<Record<string, number>>;
  readonly sealValid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bankSummary(split: "train" | "validation"): BankSummary {
  const path = join(CAPSULE_DIR, "assets", split, "bank.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.split !== split || !Array.isArray(parsed.cases) || typeof parsed.seal !== "string") {
    throw new Error(`m1-admission: malformed ${split} bank`);
  }
  const groupCounts: Record<string, number> = {};
  for (const value of parsed.cases) {
    if (!isRecord(value) || typeof value.group !== "string") {
      throw new Error(`m1-admission: malformed ${split} case`);
    }
    groupCounts[value.group] = (groupCounts[value.group] ?? 0) + 1;
  }
  const sealed = canonicalJson({
    schemaVersion: parsed.schemaVersion,
    split: parsed.split,
    weightVersion: parsed.weightVersion,
    cases: parsed.cases,
  });
  return {
    split,
    caseCount: parsed.cases.length,
    groupCounts,
    sealValid: parsed.seal === sha256(sealed),
  };
}

const checks: Check[] = [];
function check(id: string, pass: boolean, requirement: string, observed: string): void {
  checks.push({ id, pass, requirement, observed });
}

const manifestBytes = readFileSync(join(CAPSULE_DIR, "manifest.json"));
const manifest = CapsuleManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
const reportBytes = readFileSync(REPORT_PATH);
const report = DiagnosticOrderingReport.parse(JSON.parse(reportBytes.toString("utf8")));
const train = bankSummary("train");
const validation = bankSummary("validation");
const baseline = report.variants.baseline;
const broken = report.variants.broken;
const naive = report.variants.naive;
const shortcut = report.variants.shortcut;
const improved = report.variants.improved;
const qFail = 0;
const qBase = baseline.combined;
const qRef = improved.combined;
const scale = qRef - qBase;

check("manifest-id", deriveCapsuleId(manifest) === manifest.id,
  "manifest id derives canonically", manifest.id);
check("ordering-report-hash", sha256(reportBytes) === manifest.diagnosticOrdering.hash,
  "ordering report bytes match manifest hash", `${sha256(reportBytes)} vs ${manifest.diagnosticOrdering.hash}`);
check("immutable-image",
  manifest.image === "hone-mutation@sha256:f680ddc7c1d5facfec0cce238784ab459bc4d54221e64a262101f20d575252f7",
  "manifest uses the owner-approved immutable mutation/evaluation image",
  manifest.image);
check("owner-snapshot",
  manifest.meta?.["sourceCommit"] === "03b459450875fd44d054f5af4acb594427497683" &&
    manifest.meta?.["sourceTree"] === "e02affd1f852f395079ff5ad76b2a0bc8f1d9460",
  "manifest pins the approved owner commit and tree",
  `${String(manifest.meta?.["sourceCommit"])} / ${String(manifest.meta?.["sourceTree"])}`);
const lockMeta = manifest.meta?.["capsuleLock"];
const lockPath = isRecord(lockMeta) && typeof lockMeta.path === "string" ? lockMeta.path : undefined;
const lockHash = isRecord(lockMeta) && typeof lockMeta.hash === "string" ? lockMeta.hash : undefined;
const actualLockHash = lockPath === undefined ? undefined : sha256(readFileSync(join(CAPSULE_DIR, lockPath)));
check("capsule-lock",
  lockHash !== undefined && actualLockHash === lockHash,
  "capsule lock bytes match the hash sealed into manifest metadata",
  `${String(actualLockHash)} vs ${String(lockHash)}`);
const provenanceMeta = manifest.meta?.["provenanceRecord"];
const provenancePath = isRecord(provenanceMeta) && typeof provenanceMeta.path === "string"
  ? provenanceMeta.path
  : undefined;
const provenanceHash = isRecord(provenanceMeta) && typeof provenanceMeta.hash === "string"
  ? provenanceMeta.hash
  : undefined;
const actualProvenanceHash = provenancePath === undefined
  ? undefined
  : sha256(readFileSync(join(CAPSULE_DIR, provenancePath)));
check("internal-use-provenance",
  provenanceHash !== undefined && actualProvenanceHash === provenanceHash &&
    manifest.meta?.["usage"] === "internal-use-only",
  "internal-use provenance bytes and policy are manifest-sealed",
  `${String(actualProvenanceHash)} vs ${String(provenanceHash)}; usage ${String(manifest.meta?.["usage"])}`);
const diagnosticMeta = manifest.meta?.["diagnosticArtifacts"];
for (const variant of ["broken", "naive", "shortcut", "improved"]) {
  const artifact = isRecord(diagnosticMeta) ? diagnosticMeta[variant] : undefined;
  const path = isRecord(artifact) && typeof artifact.path === "string" ? artifact.path : undefined;
  const expected = isRecord(artifact) && typeof artifact.hash === "string" ? artifact.hash : undefined;
  const actual = path === undefined ? undefined : sha256(readFileSync(join(CAPSULE_DIR, path)));
  check(`diagnostic-${variant}-frozen`,
    expected !== undefined && actual === expected,
    `${variant} diagnostic bytes match manifest-sealed metadata`,
    `${String(actual)} vs ${String(expected)}`);
}
for (const split of [train, validation]) {
  const counts = GROUPS.map((group) => split.groupCounts[group] ?? 0);
  check(`${split.split}-bank-sealed`, split.sealValid,
    `${split.split} fixture bank self-seal verifies`, String(split.sealValid));
  check(`${split.split}-group-balanced`, counts.every((count) => count === counts[0] && count > 0),
    `${split.split} has equal positive counts across four registered groups`, canonicalJson(split.groupCounts));
}
const nonHoldoutAssetDrift: string[] = [];
for (const [path, expected] of Object.entries(manifest.contentHashes)) {
  if (path.startsWith("assets/holdout/")) continue;
  const actual = sha256(readFileSync(join(CAPSULE_DIR, path)));
  if (actual !== expected) nonHoldoutAssetDrift.push(`${path}:${actual}`);
}
check("non-holdout-assets", nonHoldoutAssetDrift.length === 0,
  "all train/validation content hashes match manifest", nonHoldoutAssetDrift.length === 0 ? "match" : nonHoldoutAssetDrift.join(";"));
check("case-count", train.caseCount + validation.caseCount >= 24,
  "at least 24 train+validation cases", String(train.caseCount + validation.caseCount));
check("strict-ordering", broken.combined < naive.combined && naive.combined < baseline.combined && baseline.combined < improved.combined,
  "broken < naive < baseline < improved", `${broken.combined} < ${naive.combined} < ${baseline.combined} < ${improved.combined}`);
check("second-above-baseline-diagnostic", baseline.combined < shortcut.combined && shortcut.combined < improved.combined,
  "baseline < independently constructed shortcut < improved on combined score", `${baseline.combined} < ${shortcut.combined} < ${improved.combined}`);
check("split-integrity", shortcut.train > baseline.train && shortcut.validation < baseline.validation,
  "shortcut beats train baseline and loses to validation baseline", `train ${shortcut.train} > ${baseline.train}; validation ${shortcut.validation} < ${baseline.validation}`);
check("baseline-ceiling", baseline.combined <= 0.70,
  "q(base) <= 0.70", String(baseline.combined));
check("naive-ceiling", naive.combined <= 0.85,
  "q(naive) <= 0.85", String(naive.combined));
check("reference-quality", improved.combined >= 0.90,
  "q(ref) >= 0.90 of sealed feasible optimum", String(improved.combined));
check("reference-seed-gap", improved.combined - baseline.combined >= 0.20,
  "q(ref)-q(base) >= 0.20", String(improved.combined - baseline.combined));
check("reference-naive-gap", improved.combined - naive.combined >= 0.15,
  "q(ref)-q(naive) >= 0.15", String(improved.combined - naive.combined));
check("search-headroom", improved.combined < 1,
  "improved remains below the registered feasible optimum", String(improved.combined));
check("repeat-stability", report.stability.spread < report.stability.band && report.stability.aggregates.length === 3,
  "three fresh baseline repeats have relative spread below band", `${canonicalJson(report.stability.aggregates)} spread ${report.stability.spread} < ${report.stability.band}`);
check("ordering-clean", report.failures.length === 0,
  "shared real-broker ordering report has no failures", canonicalJson(report.failures));

if (manifest.baseline.kind !== "git") throw new Error("m1-admission: baseline must be git-pinned");
const gitDir = join(CAPSULE_DIR, "baseline", ".gitdir");
const workTree = join(CAPSULE_DIR, "baseline");
const baselineHead = execFileSync("git", ["--git-dir", gitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const baselineStatus = execFileSync("git", ["--git-dir", gitDir, "--work-tree", workTree, "status", "--porcelain"], { encoding: "utf8" }).trim();
check("baseline-frozen-clean", baselineHead === manifest.baseline.commit && baselineStatus.length === 0,
  "baseline HEAD matches manifest and work tree is clean", `HEAD ${baselineHead}; status ${baselineStatus.length === 0 ? "clean" : baselineStatus}`);

const sidecar = {
  version: 1,
  capsuleId: manifest.id,
  manifestHash: sha256(manifestBytes),
  orderingReportHash: sha256(reportBytes),
  q: { qFail, qBase, qRef, scale },
  cases: { train, validation, totalNonHoldout: train.caseCount + validation.caseCount },
  measurement: {
    brokerPath: "shared capsules/tools/ordering-check.ts",
    evaluations: 14,
    baselineRepeats: report.stability.aggregates.length,
    network: "none",
    serviceDependency: false,
    holdoutBytesRead: 0,
  },
  checks,
  pass: checks.every((item) => item.pass),
};
writeFileSync(SIDECAR_PATH, `${canonicalJson(sidecar)}\n`);
if (!sidecar.pass) {
  const failures = checks.filter((item) => !item.pass).map((item) => `${item.id}: ${item.observed}`);
  throw new Error(`M1 admission failed: ${failures.join("; ")}`);
}
process.stdout.write(`${canonicalJson({ pass: true, q: sidecar.q, checks: checks.length, sidecar: SIDECAR_PATH })}\n`);
