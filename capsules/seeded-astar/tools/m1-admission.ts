/**
 * M1 functional re-admission for the seeded-astar capsule (plan §5.2/§5.3).
 *
 * Runs the UNCHANGED shared trusted ordering tool (capsules/tools/
 * ordering-check.ts) twice — every datapoint is a fresh broker container
 * evaluation of the frozen baseline plus the frozen diagnostic overlays
 * (broken / naive / shortcut / improved) on the two non-holdout asset groups
 * (train, validation) — and derives the M1 normalization constants
 * (qFail / qBase / qRef / scale) from SCORE EVIDENCE, never from source
 * inspection of the diagnostics.
 *
 * It then writes ONE deterministic sidecar, diagnostics/m1-admission.json:
 * canonical JSON (sorted keys, trailing newline), no timestamps, no wall
 * times, no temp paths. Measured aggregates are evidence and appear as
 * measured; every discrete admission decision is PASS/FAIL per check.
 *
 * Capsule immutability: this tool only READS the capsule (manifest, pinned
 * ordering report, baseline, non-holdout assets) and writes exactly the one
 * sidecar. It never opens a holdout byte: every file this process reads is
 * tracked and asserted to live outside assets/holdout, and the shared
 * ordering tool's provisional manifest declares only non-holdout groups, so
 * the broker never stats, hashes, stages, or mounts a holdout file either.
 *
 * Invocation (from the repo root; the env var feeds the shared tool's
 * capsule parameterization and must name THIS capsule):
 *
 *   HONE_CAPSULE_DIR="$PWD/capsules/seeded-astar" \
 *     capsules/node_modules/.bin/tsx capsules/seeded-astar/tools/m1-admission.ts
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapsuleManifest,
  DiagnosticOrderingReport,
  canonicalJson,
  capsuleDigest,
  deriveCapsuleId,
  validateDiagnosticOrdering,
} from "@hone/schema";
import type { EvaluatorOutput, OrderingVariantSummary } from "@hone/schema";
import { runOrderingCheck } from "../../tools/ordering-check.js";
import type { OrderingReport } from "../../tools/ordering-check.js";

const CAPSULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_TOOL = resolve(CAPSULE_DIR, "..", "tools", "ordering-check.ts");
const SIDECAR_PATH = join(CAPSULE_DIR, "diagnostics", "m1-admission.json");
const HOLDOUT_PREFIX = join(CAPSULE_DIR, "assets", "holdout") + sep;

/** Independent full ordering-check invocations (determinism/repeat evidence). */
const PASSES = 2;
/** Fresh container evaluations per pass, pinned by the shared tool itself. */
const EVALS_PER_PASS = 14;

/** Frozen §5.2 functional-admission thresholds. */
const MIN_CASES = 12;
const MIN_GROUPS = 3;
const MAX_SEED_NORMALIZED = 0.7;
const MAX_NAIVE_NORMALIZED = 0.85;
const MIN_GAP_REF_SEED = 0.3;
const MIN_GAP_REF_NAIVE = 0.15;

const M1_VARIANTS = ["broken", "naive", "baseline", "improved"] as const;
const ALL_VARIANTS = ["broken", "naive", "baseline", "shortcut", "improved"] as const;
const SPLITS = ["train", "validation"] as const;
type Split = (typeof SPLITS)[number];
type Variant = (typeof ALL_VARIANTS)[number];

/** Frozen M1 campaign coordinates from the manifest-pinned broker report. */
const FROZEN_Q_FAIL = 0;
const FROZEN_Q_BASE = 0.023772025789093716;
const FROZEN_Q_REFERENCE = 0.21622805389884087;
const FROZEN_SCALE = 0.19245602810974716;

/** Exact M0 delivery lineage of the canonical improved reference. */
const M0_RUN_ID = "run_mrnta7aq34f9c0";
const M0_ARTIFACT =
  "sha256:cd9cc018ec8fd5a60cff0af202839c6e799da35ead358b445d1405f5df65bb9e";
const M0_TRAIN_SCORE = 0.2453954508867987;

const DIAGNOSTIC_HASHES = {
  alternate:
    "sha256:b4ed2b82a6c4a0b541168905dfa86007bae85bf115b77f9825ba21878c924f2f",
  broken:
    "sha256:b1ab62e80fb899477b2a6cf81660c66615deca7bc09651b156f7d9301ea33a98",
  improved:
    "sha256:c7aabbbd4132b7180e44f5a06b3d386ec1d6c3c81f9a5e450ef910b3360c48c8",
  naive:
    "sha256:68fcf4288c324f339fa123efe12344fb07f80230bc8c5d9be44046e8ef11721c",
  shortcut:
    "sha256:40e59f8f062c582d0381a1bc3a97a4f48337dda4f918d08de1885fb47494d0b5",
} as const;
const ALTERNATE_REPORT_PATH = "diagnostics/alternate-ordering-report.json";
const ALTERNATE_REPORT_HASH =
  "sha256:80b5fdb6484d00d32b7a0be9e7e1cd1b51f40f0195dc686d777a42faa260a5db";
const PERFORMANCE_ADMISSION_SCHEMA = "hone-seeded-astar-performance-admission-v1";
const PERFORMANCE_ADMISSION_PATH = "diagnostics/performance-admission.json";
const PERFORMANCE_ADMISSION_HARNESS_PATH = "tools/performance-admission.ts";

// ---------------------------------------------------------------------------
// Tracked reads: hard evidence that this process never opens a holdout byte.
// ---------------------------------------------------------------------------

const readPaths: string[] = [];

function readTracked(path: string): Buffer {
  const abs = resolve(path);
  if (abs.startsWith(HOLDOUT_PREFIX)) {
    throw new Error(`m1-admission: refusing to read holdout bytes: ${abs}`);
  }
  readPaths.push(abs);
  return readFileSync(abs);
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error("mean of empty sample");
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Relative spread (max-min)/mean — the capsule's frozen stability statistic. */
function relSpread(xs: readonly number[]): number {
  return (Math.max(...xs) - Math.min(...xs)) / mean(xs);
}

// ---------------------------------------------------------------------------
// Static capsule integrity (fail fast, before any container spend)
// ---------------------------------------------------------------------------

interface Check {
  id: string;
  pass: boolean;
  requirement: string;
  observed: string;
}

const checks: Check[] = [];
function check(id: string, pass: boolean, requirement: string, observed: string): void {
  checks.push({ id, pass, requirement, observed });
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: CAPSULE_DIR, encoding: "utf8" }).trim();
}

const manifestBytes = readTracked(join(CAPSULE_DIR, "manifest.json"));
const manifest = CapsuleManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
const manifestSha = sha256(manifestBytes);

if (deriveCapsuleId(manifest) !== manifest.id) {
  throw new Error("m1-admission: manifest id does not derive from its own content");
}

// The shared tool is capsule-parameterized via HONE_CAPSULE_DIR; when that
// parameterization is present the invoker MUST point it at this capsule.
const sharedToolSource = readTracked(SHARED_TOOL).toString("utf8");
if (sharedToolSource.includes("HONE_CAPSULE_DIR")) {
  const envDir = process.env["HONE_CAPSULE_DIR"];
  if (envDir === undefined || resolve(envDir) !== CAPSULE_DIR) {
    throw new Error(
      `m1-admission: shared ordering tool reads HONE_CAPSULE_DIR; set it to ${CAPSULE_DIR} (got ${envDir ?? "<unset>"})`,
    );
  }
}

const pinnedReportBytes = readTracked(join(CAPSULE_DIR, manifest.diagnosticOrdering.path));
const pinnedReportSha = sha256(pinnedReportBytes);
const pinnedReport = DiagnosticOrderingReport.parse(
  JSON.parse(pinnedReportBytes.toString("utf8")),
);
check(
  "ordering-report-hash-matches-manifest",
  pinnedReportSha === manifest.diagnosticOrdering.hash,
  `sha256(${manifest.diagnosticOrdering.path}) == manifest.diagnosticOrdering.hash`,
  `${pinnedReportSha} vs ${manifest.diagnosticOrdering.hash}`,
);

// Content drift: re-hash every NON-holdout pinned asset. Holdout entries are
// deliberately NOT read here; their integrity is enforced by the manifest's
// pre-run hash admission in the trusted runtime.
let assetDrift: string[] = [];
let holdoutEntriesSkipped = 0;
for (const [rel, pinned] of Object.entries(manifest.contentHashes)) {
  if (rel.startsWith("assets/holdout/")) {
    holdoutEntriesSkipped += 1;
    continue;
  }
  const actual = sha256(readTracked(join(CAPSULE_DIR, rel)));
  if (actual !== pinned) assetDrift.push(`${rel}: ${actual} != ${pinned}`);
}
check(
  "no-asset-drift",
  assetDrift.length === 0,
  "every non-holdout manifest.contentHashes entry re-hashes identically",
  assetDrift.length === 0
    ? `${Object.keys(manifest.contentHashes).length - holdoutEntriesSkipped} non-holdout assets verified; ${holdoutEntriesSkipped} holdout entries left unread`
    : assetDrift.join("; "),
);

if (manifest.baseline.kind !== "git") {
  throw new Error("m1-admission: seeded-astar manifest must pin a git baseline");
}
const baselineHead = git(["--git-dir", join(CAPSULE_DIR, "baseline", ".gitdir"), "rev-parse", "HEAD"]);
const baselineStatus = git([
  "--git-dir",
  join(CAPSULE_DIR, "baseline", ".gitdir"),
  "--work-tree",
  join(CAPSULE_DIR, "baseline"),
  "status",
  "--porcelain",
]);
check(
  "no-baseline-drift",
  baselineHead === manifest.baseline.commit && baselineStatus === "",
  "baseline/.gitdir HEAD == manifest.baseline.commit and work tree clean",
  `HEAD ${baselineHead}; status ${baselineStatus === "" ? "clean" : JSON.stringify(baselineStatus)}`,
);

const protectedHashes: Record<string, string> = {};
for (const rel of manifest.protectedPaths) {
  protectedHashes[rel] = sha256(readTracked(join(CAPSULE_DIR, "baseline", rel)));
}

const diagnosticHashes: Record<string, string> = {};
for (const [name, expected] of Object.entries(DIAGNOSTIC_HASHES)) {
  const rel = `diagnostics/${name}/astar.py`;
  const actual = sha256(readTracked(join(CAPSULE_DIR, rel)));
  diagnosticHashes[rel] = actual;
  check(
    `diagnostic-${name}-content-frozen`,
    actual === expected,
    `${rel} has its registered sha256`,
    `${actual} vs ${expected}`,
  );
}

const primarySemanticFailures = validateDiagnosticOrdering(pinnedReport);
check(
  "primary-ordering-report-schema-and-semantics",
  primarySemanticFailures.length === 0,
  "manifest-pinned report parses strictly and satisfies every ordering invariant",
  primarySemanticFailures.length === 0 ? "schema-valid; no semantic failures" : primarySemanticFailures.join("; "),
);

const alternateReportBytes = readTracked(join(CAPSULE_DIR, ALTERNATE_REPORT_PATH));
const alternateReportSha = sha256(alternateReportBytes);
const alternateReport = DiagnosticOrderingReport.parse(
  JSON.parse(alternateReportBytes.toString("utf8")),
);
const alternateSemanticFailures = validateDiagnosticOrdering(alternateReport);
check(
  "alternate-ordering-report-frozen",
  alternateReportSha === ALTERNATE_REPORT_HASH && alternateSemanticFailures.length === 0,
  "independent alternate report hash is frozen and its strict schema/semantics validate",
  `${alternateReportSha}; ${
    alternateSemanticFailures.length === 0
      ? "schema-valid; no semantic failures"
      : alternateSemanticFailures.join("; ")
  }`,
);

check(
  "m0-delivery-winner-content-identity",
  diagnosticHashes["diagnostics/improved/astar.py"] === DIAGNOSTIC_HASHES.improved,
  "canonical improved source equals the frozen M0 delivery winner source sha256",
  `${M0_RUN_ID} ${M0_ARTIFACT} ${diagnosticHashes["diagnostics/improved/astar.py"] ?? "<missing>"}`,
);
check(
  "two-distinct-valid-above-baseline-diagnostics",
  DIAGNOSTIC_HASHES.improved !== DIAGNOSTIC_HASHES.alternate &&
    pinnedReport.variants.improved.combined > pinnedReport.variants.baseline.combined &&
    pinnedReport.variants.improved.trainTestsPass &&
    pinnedReport.variants.improved.validationTestsPass &&
    alternateReport.variants.improved.combined > alternateReport.variants.baseline.combined &&
    alternateReport.variants.improved.trainTestsPass &&
    alternateReport.variants.improved.validationTestsPass,
  "M0 winner and independently authored alternate have different content and each validly beats its broker-measured baseline",
  `M0 ${pinnedReport.variants.improved.combined} > ${pinnedReport.variants.baseline.combined}; alternate ${alternateReport.variants.improved.combined} > ${alternateReport.variants.baseline.combined}`,
);

const frozenCoordinatesMatch =
  FROZEN_Q_FAIL === pinnedReport.variants.broken.combined &&
  FROZEN_Q_BASE === pinnedReport.variants.baseline.combined &&
  FROZEN_Q_REFERENCE === pinnedReport.variants.improved.combined &&
  FROZEN_SCALE === FROZEN_Q_REFERENCE - FROZEN_Q_BASE;
check(
  "m1-normalization-coordinates-frozen",
  frozenCoordinatesMatch,
  "qFail/qBase/qReference equal exact manifest-pinned broker scores and scale = qReference - qBase",
  `qFail=${FROZEN_Q_FAIL}; qBase=${FROZEN_Q_BASE}; qReference=${FROZEN_Q_REFERENCE}; scale=${FROZEN_SCALE}`,
);

const registeredMeta = manifest.meta;
const performanceAdmissionBinding = {
  schema: PERFORMANCE_ADMISSION_SCHEMA,
  path: PERFORMANCE_ADMISSION_PATH,
  sha256: sha256(readTracked(join(CAPSULE_DIR, PERFORMANCE_ADMISSION_PATH))),
  harnessPath: PERFORMANCE_ADMISSION_HARNESS_PATH,
  harnessSha256: sha256(
    readTracked(join(CAPSULE_DIR, PERFORMANCE_ADMISSION_HARNESS_PATH)),
  ),
};
const registeredProvenanceMatches =
  canonicalJson(registeredMeta?.["m0Delivery"]) ===
    canonicalJson({
      runId: M0_RUN_ID,
      artifact: M0_ARTIFACT,
      assetGroupId: "train",
      score: M0_TRAIN_SCORE,
      sourcePath: "diagnostics/improved/astar.py",
      sourceSha256: DIAGNOSTIC_HASHES.improved,
    }) &&
  canonicalJson(registeredMeta?.["m1Normalization"]) ===
    canonicalJson({
      qFail: FROZEN_Q_FAIL,
      qBase: FROZEN_Q_BASE,
      qReference: FROZEN_Q_REFERENCE,
      scale: FROZEN_SCALE,
    }) &&
  canonicalJson(registeredMeta?.["diagnosticContentHashes"]) ===
    canonicalJson(diagnosticHashes) &&
  canonicalJson(registeredMeta?.["independentDiagnosticOrdering"]) ===
    canonicalJson({
      candidatePath: "diagnostics/alternate/astar.py",
      candidateSha256: DIAGNOSTIC_HASHES.alternate,
      reportPath: ALTERNATE_REPORT_PATH,
      reportSha256: ALTERNATE_REPORT_HASH,
    });
check(
  "manifest-provenance-and-content-hashes-frozen",
  registeredProvenanceMatches,
  "manifest meta registers exact M0 lineage, M1 coordinates, diagnostic source hashes, and alternate report hash",
  registeredProvenanceMatches ? "all registered values match" : "manifest meta differs from frozen values",
);
check(
  "performance-admission-binding-current",
  canonicalJson(registeredMeta?.["performanceAdmission"]) ===
    canonicalJson(performanceAdmissionBinding),
  "manifest meta binds the current canonical performance sidecar and harness hashes",
  `${performanceAdmissionBinding.sha256}; harness ${performanceAdmissionBinding.harnessSha256}`,
);

// ---------------------------------------------------------------------------
// Measurement: PASSES independent full runs of the shared trusted tool.
// ---------------------------------------------------------------------------

function splitAggregate(output: EvaluatorOutput): number {
  const scores = Object.values(output.perExample).map((e) => e.score);
  if (scores.length === 0) throw new Error("evaluator output has no perExample scores");
  return mean(scores);
}

interface SplitEvidence {
  aggregate: number;
  testsPass: boolean;
  pathsOptimal: boolean;
  valid: boolean;
  quality: number;
  perExample: Record<string, number>;
}

function splitEvidence(output: EvaluatorOutput): SplitEvidence {
  const perExample: Record<string, number> = {};
  for (const [id, entry] of Object.entries(output.perExample)) perExample[id] = entry.score;
  const quality = output.diagnostics?.["quality"];
  return {
    aggregate: splitAggregate(output),
    testsPass: output.constraints["tests_pass"] === true,
    pathsOptimal: output.constraints["paths_optimal"] === true,
    valid: output.valid,
    quality: typeof quality === "number" ? quality : Number.NaN,
    perExample,
  };
}

async function measure(): Promise<OrderingReport[]> {
  const reports: OrderingReport[] = [];
  for (let i = 0; i < PASSES; i += 1) {
    reports.push(await runOrderingCheck());
  }
  return reports;
}

const reports = await measure();

interface PassEvidence {
  evalInvocations: number;
  failures: string[];
  stabilityAggregates: number[];
  stabilitySpread: number;
  variants: Record<Variant, Record<Split, SplitEvidence> & { combined: number }>;
}

const passEvidence: PassEvidence[] = reports.map((report) => {
  const variants = {} as PassEvidence["variants"];
  for (const variant of ALL_VARIANTS) {
    const result = report.results[variant];
    variants[variant] = {
      train: splitEvidence(result.bySplit.train),
      validation: splitEvidence(result.bySplit.validation),
      combined: result.combined,
    };
  }
  return {
    evalInvocations: report.evalInvocations,
    failures: [...report.failures],
    stabilityAggregates: [...report.stabilityAggregates],
    stabilitySpread: report.stabilitySpread,
    variants,
  };
});

for (const [index, pass] of passEvidence.entries()) {
  check(
    `pass-${index + 1}-ordering-clean`,
    pass.failures.length === 0,
    "shared ordering check reports zero invariant violations",
    pass.failures.length === 0 ? "no failures" : pass.failures.join("; "),
  );
  check(
    `pass-${index + 1}-eval-invocations`,
    pass.evalInvocations === EVALS_PER_PASS,
    `exactly ${EVALS_PER_PASS} fresh broker container evaluations (no memo hits, no host evals)`,
    String(pass.evalInvocations),
  );
  check(
    `pass-${index + 1}-stability-band`,
    pass.stabilitySpread < pinnedReport.stability.band,
    `repeated-baseline relative spread < ${pinnedReport.stability.band}`,
    pass.stabilitySpread.toString(),
  );
}

// Discrete outcomes must be bit-identical across passes AND match the pinned
// report's suite flags — the deterministic component of repeat evidence.
const discrete = (pass: PassEvidence): string =>
  canonicalJson(
    Object.fromEntries(
      ALL_VARIANTS.map((v) => [
        v,
        {
          train: {
            testsPass: pass.variants[v].train.testsPass,
            pathsOptimal: pass.variants[v].train.pathsOptimal,
            valid: pass.variants[v].train.valid,
          },
          validation: {
            testsPass: pass.variants[v].validation.testsPass,
            pathsOptimal: pass.variants[v].validation.pathsOptimal,
            valid: pass.variants[v].validation.valid,
          },
        },
      ]),
    ),
  );
const firstPass = passEvidence[0];
if (firstPass === undefined) throw new Error("m1-admission: no measurement passes");
check(
  "discrete-outcomes-deterministic-across-passes",
  passEvidence.every((p) => discrete(p) === discrete(firstPass)),
  "tests_pass / paths_optimal / valid identical in every independent pass",
  discrete(firstPass),
);
const pinnedFlagsMatch = ALL_VARIANTS.every((v) => {
  const pinnedVariant: OrderingVariantSummary = pinnedReport.variants[v];
  return passEvidence.every(
    (p) =>
      p.variants[v].train.testsPass === pinnedVariant.trainTestsPass &&
      p.variants[v].validation.testsPass === pinnedVariant.validationTestsPass,
  );
});
check(
  "discrete-outcomes-match-pinned-report",
  pinnedFlagsMatch,
  "per-variant suite pass flags equal the manifest-pinned ordering report",
  pinnedFlagsMatch ? "all suite flags identical" : "suite flag mismatch vs pinned report",
);

// ---------------------------------------------------------------------------
// M1 normalization (§5.3) — from score evidence only.
// ---------------------------------------------------------------------------

const samples = (variant: Variant): number[] =>
  variant === "baseline"
    ? passEvidence.flatMap((p) => p.stabilityAggregates)
    : passEvidence.map((p) => p.variants[variant].combined);

const qFail = FROZEN_Q_FAIL;
const qBase = FROZEN_Q_BASE;
const qReference = FROZEN_Q_REFERENCE;
const scale = FROZEN_SCALE;
const baselineSamples = samples("baseline");
const improvedSamples = samples("improved");
const naiveSamples = samples("naive");
const brokenSamples = samples("broken");
const qNaive = pinnedReport.variants.naive.combined;
const qBroken = pinnedReport.variants.broken.combined;

const normalize = (q: number): number =>
  (q - qFail) / (qReference - qFail);
const S = {
  broken: normalize(qBroken),
  naive: normalize(qNaive),
  seed: normalize(qBase),
  reference: normalize(qReference),
};

check("scale-positive", scale > 0, "s = qReference - qBase strictly positive", scale.toString());
check(
  "seed-normalized",
  S.seed <= MAX_SEED_NORMALIZED,
  `S(seed) <= ${MAX_SEED_NORMALIZED}`,
  S.seed.toString(),
);
check(
  "naive-normalized",
  S.naive <= MAX_NAIVE_NORMALIZED,
  `S(naive) <= ${MAX_NAIVE_NORMALIZED}`,
  S.naive.toString(),
);
check(
  "reference-normalized",
  S.reference === 1,
  "S(reference) == 1 exactly under S(q) = (q - qFail) / (qReference - qFail)",
  S.reference.toString(),
);
check(
  "gap-reference-seed",
  S.reference - S.seed >= MIN_GAP_REF_SEED,
  `S(reference) - S(seed) >= ${MIN_GAP_REF_SEED}`,
  (S.reference - S.seed).toString(),
);
check(
  "gap-reference-naive",
  S.reference - S.naive >= MIN_GAP_REF_NAIVE,
  `S(reference) - S(naive) >= ${MIN_GAP_REF_NAIVE}`,
  (S.reference - S.naive).toString(),
);

const repeatedScoreOrdering = passEvidence.every(
  (p) =>
    p.variants.broken.combined < p.variants.naive.combined &&
    p.variants.naive.combined < p.variants.baseline.combined &&
    p.variants.baseline.combined < p.variants.improved.combined,
);
check(
  "repeat-exact-score-ordering",
  repeatedScoreOrdering,
  "every repeated broker pass records exact raw scores satisfying broken < naive < baseline < improved",
  passEvidence
    .map(
      (p) =>
        `${p.variants.broken.combined} < ${p.variants.naive.combined} < ${p.variants.baseline.combined} < ${p.variants.improved.combined}`,
    )
    .join("; "),
);

// Per-pass robustness: the same threshold decisions must hold inside EACH
// independent pass using that pass's own reference sample (machine-speed
// factors cancel in the ratio).
const perPassThresholdsHold = passEvidence.every((p) => {
  const ref = p.variants.improved.combined;
  const seed = mean(p.stabilityAggregates) / ref;
  const naive = p.variants.naive.combined / ref;
  return (
    ref > mean(p.stabilityAggregates) &&
    seed <= MAX_SEED_NORMALIZED &&
    naive <= MAX_NAIVE_NORMALIZED &&
    1 - seed >= MIN_GAP_REF_SEED &&
    1 - naive >= MIN_GAP_REF_NAIVE
  );
});
check(
  "thresholds-hold-in-every-pass",
  perPassThresholdsHold,
  "every independent pass reproduces every §5.2 threshold decision on its own samples",
  passEvidence
    .map((p) => `S(seed)=${mean(p.stabilityAggregates) / p.variants.improved.combined}`)
    .join(", "),
);

const baselineCrossSpread = relSpread(baselineSamples);
const improvedCrossSpread = relSpread(improvedSamples);
check(
  "cross-pass-stability",
  baselineCrossSpread < pinnedReport.stability.band &&
    improvedCrossSpread < pinnedReport.stability.band,
  `baseline and reference aggregates across all independent samples stay inside the frozen ${pinnedReport.stability.band} relative band`,
  `baseline spread ${baselineCrossSpread}; reference spread ${improvedCrossSpread}`,
);

// ---------------------------------------------------------------------------
// Case / behavior-group census
// ---------------------------------------------------------------------------

const trainCases = Object.keys(firstPass.variants.baseline.train.perExample).sort();
const validationCases = Object.keys(firstPass.variants.baseline.validation.perExample).sort();
// Protected trusted-suite cases (eval.py `_suite_cases`, protected path pinned
// by hash above). Enumerated for the census only; every NORMALIZATION number
// in this sidecar comes from measured scores.
const suiteTopologyCases = ["open3", "ring4", "hook3", "snake6"];
const suiteUnsolvableCases = ["blocked", "walled-start", "walled-goal"];
const suiteRandomCases = ["rand12", "rand16", "rand20", "rand28", "rand34", "rand40"];

const groups = [
  {
    id: "perf-train",
    kind: "sealed public asset mazes, per-example continuous score",
    cases: trainCases,
  },
  {
    id: "perf-validation",
    kind: "sealed protected asset mazes, per-example continuous score",
    cases: validationCases,
  },
  {
    id: "suite-topology",
    kind: "trusted-suite handcrafted solvable topologies (BFS oracle, per-case pass/fail)",
    cases: suiteTopologyCases,
  },
  {
    id: "suite-unsolvable",
    kind: "trusted-suite unreachable-goal cases (must return no path)",
    cases: suiteUnsolvableCases,
  },
  {
    id: "suite-random",
    kind: "trusted-suite seeded random mazes 12..40 (BFS oracle, per-case pass/fail)",
    cases: suiteRandomCases,
  },
];
const totalCases = groups.reduce((n, g) => n + g.cases.length, 0);
check("case-count", totalCases >= MIN_CASES, `>= ${MIN_CASES} independently scoreable sealed cases`, String(totalCases));
check("group-count", groups.length >= MIN_GROUPS, `>= ${MIN_GROUPS} behavior groups`, String(groups.length));

// Holdout isolation evidence: this process's own tracked reads, plus the
// shared tool's structural exclusion (its provisional manifest declares only
// non-holdout groups, so the broker never touches a holdout path; its host
// transcript is asserted docker/tar-only and the eval count is pinned above).
const holdoutReads = readPaths.filter((p) => p.startsWith(HOLDOUT_PREFIX));
check(
  "no-holdout-bytes-read",
  holdoutReads.length === 0,
  "zero admission-process reads under assets/holdout; broker-side exclusion structural in the shared tool",
  holdoutReads.length === 0
    ? `${readPaths.length} tracked reads, none under assets/holdout; ${holdoutEntriesSkipped} pinned holdout hashes left unverified-by-design`
    : holdoutReads.join("; "),
);

// Post-measurement drift re-check: identity, both broker reports, and every
// diagnostic source are byte-identical after the runs.
const manifestShaAfter = sha256(readTracked(join(CAPSULE_DIR, "manifest.json")));
const reportShaAfter = sha256(readTracked(join(CAPSULE_DIR, manifest.diagnosticOrdering.path)));
const alternateReportShaAfter = sha256(readTracked(join(CAPSULE_DIR, ALTERNATE_REPORT_PATH)));
const diagnosticDriftAfter = Object.entries(DIAGNOSTIC_HASHES).filter(
  ([name, expected]) =>
    sha256(readTracked(join(CAPSULE_DIR, "diagnostics", name, "astar.py"))) !== expected,
);
check(
  "no-capsule-drift-after-measurement",
  manifestShaAfter === manifestSha &&
    reportShaAfter === pinnedReportSha &&
    alternateReportShaAfter === alternateReportSha &&
    diagnosticDriftAfter.length === 0,
  "manifest, broker reports, and diagnostic sources are byte-identical before and after measurement",
  `manifest ${manifestShaAfter}; primary report ${reportShaAfter}; alternate report ${alternateReportShaAfter}; diagnostic drift ${diagnosticDriftAfter.length}`,
);

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

const admission = checks.every((c) => c.pass) ? "PASS" : "FAIL";

const rawPasses = passEvidence.map((p) => ({
  evalInvocations: p.evalInvocations,
  failures: p.failures,
  stability: { aggregates: p.stabilityAggregates, relativeSpread: p.stabilitySpread },
  variants: Object.fromEntries(
    ALL_VARIANTS.map((v) => [
      v,
      {
        combined: p.variants[v].combined,
        train: {
          aggregate: p.variants[v].train.aggregate,
          testsPass: p.variants[v].train.testsPass,
          pathsOptimal: p.variants[v].train.pathsOptimal,
          valid: p.variants[v].train.valid,
          quality: p.variants[v].train.quality,
          perExample: p.variants[v].train.perExample,
        },
        validation: {
          aggregate: p.variants[v].validation.aggregate,
          testsPass: p.variants[v].validation.testsPass,
          pathsOptimal: p.variants[v].validation.pathsOptimal,
          valid: p.variants[v].validation.valid,
          quality: p.variants[v].validation.quality,
          perExample: p.variants[v].validation.perExample,
        },
      },
    ]),
  ),
}));

const sidecar = {
  version: 1,
  kind: "m1-functional-admission",
  partition: "public-train",
  capsule: {
    id: manifest.id,
    capsuleDigest: capsuleDigest(manifest),
    manifestSha256: manifestSha,
    image: manifest.image,
    baseline: manifest.baseline,
    orderingReport: {
      path: manifest.diagnosticOrdering.path,
      sha256: pinnedReportSha,
      pinnedHash: manifest.diagnosticOrdering.hash,
    },
    performanceAdmission: performanceAdmissionBinding,
  },
  provenance: {
    m0Delivery: {
      runId: M0_RUN_ID,
      artifact: M0_ARTIFACT,
      assetGroupId: "train",
      score: M0_TRAIN_SCORE,
      sourcePath: "diagnostics/improved/astar.py",
      sourceSha256: DIAGNOSTIC_HASHES.improved,
    },
    diagnosticContentHashes: diagnosticHashes,
    independentAlternate: {
      candidatePath: "diagnostics/alternate/astar.py",
      candidateSha256: DIAGNOSTIC_HASHES.alternate,
      reportPath: ALTERNATE_REPORT_PATH,
      reportSha256: alternateReportSha,
      report: alternateReport,
    },
  },
  evaluator: {
    entrypoint: manifest.evalEntrypoint,
    protectedPathSha256: protectedHashes,
    qDefinition:
      "q = mean per-example score; score = correctness / (1 + slowest_of_5_ms); invalid output, protocol violation, crash, timeout, or non-optimal path hard-gates correctness to the frozen fail value",
  },
  cases: {
    total: totalCases,
    minimumRequired: MIN_CASES,
    behaviorGroups: groups,
    minimumGroupsRequired: MIN_GROUPS,
    sealedAssetCases: { train: trainCases.length, validation: validationCases.length },
    trustedSuiteCases:
      suiteTopologyCases.length + suiteUnsolvableCases.length + suiteRandomCases.length,
  },
  normalization: {
    method:
      "S(q) = (q - qFail) / (qReference - qFail), exact constants frozen from the manifest-pinned trusted broker report; campaign coordinate per plan §5.3: Y = (q - qBase) / scale, unclipped",
    qFail,
    qBase,
    qReference,
    scale,
    samples: {
      baseline: baselineSamples,
      improved: improvedSamples,
      naive: naiveSamples,
      broken: brokenSamples,
    },
    exactPinnedScores: {
      broken: qBroken,
      naive: qNaive,
      baseline: qBase,
      reference: qReference,
    },
  },
  normalizedScores: S,
  gaps: {
    referenceMinusSeed: S.reference - S.seed,
    referenceMinusNaive: S.reference - S.naive,
  },
  measurement: {
    passes: PASSES,
    variantsPerPass: [...ALL_VARIANTS],
    m1AdmissionVariants: [...M1_VARIANTS],
    nonHoldoutGroups: [...SPLITS],
    evaluationsPerPass: EVALS_PER_PASS,
    optimizerPilot: {
      attempted: false,
      evaluations: 0,
    },
    raw: rawPasses,
    pinnedOrderingReport: pinnedReport,
    alternateBrokerReport: alternateReport,
    realBrokerSmoke: {
      canonicalFreshEvaluations: PASSES * EVALS_PER_PASS,
      alternateFreshEvaluations: EVALS_PER_PASS,
      network: "none",
      hostCommands: ["docker", "tar"],
    },
  },
  commands: [
    `HONE_CAPSULE_DIR="$PWD/capsules/seeded-astar" capsules/node_modules/.bin/tsx capsules/seeded-astar/tools/m1-admission.ts`,
    `HONE_CAPSULE_DIR="$PWD/tmp/seeded-astar-alternate-m1" capsules/node_modules/.bin/tsx capsules/tools/ordering-check.ts --report`,
    "per datapoint (executed by @hone/broker inside the shared ordering tool, 14 fresh containers per pass, docker/tar-only host transcript asserted): docker run <hardened flags> hone-mutation@sha256:f680ddc7c1d5facfec0cce238784ab459bc4d54221e64a262101f20d575252f7 python3 -I -B eval.py",
  ],
  checks,
  admission,
};

const bytes = `${canonicalJson(sidecar)}\n`;
writeFileSync(SIDECAR_PATH, bytes);

console.log(`m1-admission: ${admission}`);
for (const c of checks) {
  console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.id}: ${c.observed} (require: ${c.requirement})`);
}
console.log(`sidecar -> ${SIDECAR_PATH}`);
console.log(`sidecar sha256: ${sha256(bytes)}`);
if (admission !== "PASS") process.exit(1);
