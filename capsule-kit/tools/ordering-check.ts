/**
 * Trusted ordering check for the seeded-astar capsule (build plan WP6).
 *
 * Composes candidate artifacts (baseline tree + diagnostic overlay), runs the
 * capsule evaluator on them directly with python3 (no docker needed for this
 * check) across the train and validation splits, and asserts the diagnostic
 * ordering that proves the evaluator discriminates:
 *
 *   1. broken < naive < baseline < improved   on train+validation aggregate
 *      (aggregate = mean perExample score across both splits)
 *   2. shortcut > baseline on TRAIN, but NOT on validation — the memorizing
 *      cheat inverts across the split boundary, which is the split-integrity
 *      proof
 *   3. stability: 3 evaluations of the baseline stay within a relative spread
 *      band of 0.15 on aggregate ((max-min)/mean). Measured spread over 9
 *      baseline evals on an M3 Max: 0.004-0.009, dominated by wall-clock
 *      noise in the 1/(1+ms) term — the band leaves >15x headroom.
 *   4. sanity: baseline and improved pass the trusted correctness constraint
 *      with quality 1.0
 *
 * Usage: npx tsx capsules/tools/ordering-check.ts [--report [path]]
 *   --report writes the schema-validated compact JSON summary (default path:
 *   capsules/seeded-astar/diagnostics/ordering-report.json) on success.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DIAGNOSTIC_ORDERING_REPORT_VERSION,
  DiagnosticOrderingReport,
  EvaluatorOutput,
  canonicalJson,
} from "@hone/schema";

const CAPSULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "seeded-astar");
const SPLITS = ["train", "validation"] as const;
const DIAGNOSTICS = ["broken", "naive", "shortcut", "improved"] as const;
const STABILITY_RUNS = 3;
const STABILITY_BAND = 0.15;

type Split = (typeof SPLITS)[number];
type Variant = "baseline" | (typeof DIAGNOSTICS)[number];

const SKIP_ENTRIES: Record<string, true> = {
  ".git": true,
  ".gitdir": true,
  __pycache__: true,
  ".pytest_cache": true,
};

/** Baseline tree + (for diagnostics) variant overlay -> temp artifact dir. */
function composeArtifact(variant: Variant): string {
  const artifact = mkdtempSync(join(tmpdir(), `hone-astar-${variant}-`));
  for (const entry of readdirSync(join(CAPSULE_DIR, "baseline"))) {
    if (SKIP_ENTRIES[entry]) continue;
    cpSync(join(CAPSULE_DIR, "baseline", entry), join(artifact, entry), {
      recursive: true,
    });
  }
  if (variant !== "baseline") {
    for (const entry of readdirSync(join(CAPSULE_DIR, "diagnostics", variant))) {
      cpSync(join(CAPSULE_DIR, "diagnostics", variant, entry), join(artifact, entry), {
        recursive: true,
      });
    }
  }
  return artifact;
}

/**
 * Eval entrypoint from capsule.config.json — the pre-manifest source of
 * truth. The ordering report is an INPUT to the manifest (scaffold hashes it
 * into diagnosticOrdering), so this tool cannot depend on manifest.json;
 * scaffold copies the same entrypoint verbatim into the manifest it emits.
 */
const EVAL_ENTRYPOINT: readonly string[] = (() => {
  const raw: unknown = JSON.parse(
    readFileSync(join(CAPSULE_DIR, "capsule.config.json"), "utf8"),
  );
  if (raw === null || typeof raw !== "object" || !("evalEntrypoint" in raw)) {
    throw new Error("capsule.config.json: missing evalEntrypoint");
  }
  const entrypoint = raw.evalEntrypoint;
  if (
    !Array.isArray(entrypoint) ||
    entrypoint.length === 0 ||
    !entrypoint.every((x): x is string => typeof x === "string" && x.length > 0)
  ) {
    throw new Error("capsule.config.json: evalEntrypoint must be a non-empty string array");
  }
  return entrypoint;
})();

/**
 * Faithful local reproduction of the broker eval contract: entrypoint runs
 * from the FROZEN baseline (cwd = /trusted/baseline equivalent) while the
 * candidate artifact is only reachable via CAPSULE_WORKSPACE (= /workspace)
 * and fixtures via CAPSULE_ASSETS (= /capsule/assets). Candidate code never
 * shadows the trusted evaluator.
 */
function runEval(artifactDir: string, split: Split): EvaluatorOutput {
  const [command, ...args] = EVAL_ENTRYPOINT;
  if (command === undefined) throw new Error("config evalEntrypoint is empty");
  const stdout = execFileSync(command, args, {
    cwd: join(CAPSULE_DIR, "baseline"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
    env: {
      ...process.env,
      CAPSULE_WORKSPACE: artifactDir,
      CAPSULE_ASSETS: join(CAPSULE_DIR, "assets", split),
    },
  });
  return EvaluatorOutput.parse(JSON.parse(stdout));
}

/** Mean perExample score across one or more evaluator outputs. */
function aggregate(...outputs: EvaluatorOutput[]): number {
  const scores = outputs.flatMap((o) =>
    Object.values(o.perExample).map((e) => e.score),
  );
  if (scores.length === 0) throw new Error("no perExample scores to aggregate");
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

interface VariantResult {
  bySplit: Record<Split, EvaluatorOutput>;
  train: number;
  validation: number;
  combined: number;
}

function evaluateVariant(variant: Variant): VariantResult {
  const artifact = composeArtifact(variant);
  try {
    const bySplit = {
      train: runEval(artifact, "train"),
      validation: runEval(artifact, "validation"),
    };
    return {
      bySplit,
      train: aggregate(bySplit.train),
      validation: aggregate(bySplit.validation),
      combined: aggregate(bySplit.train, bySplit.validation),
    };
  } finally {
    rmSync(artifact, { recursive: true, force: true });
  }
}

export interface OrderingReport {
  results: Record<Variant, VariantResult>;
  stabilityAggregates: number[];
  stabilitySpread: number;
  failures: string[];
}

export function runOrderingCheck(): OrderingReport {
  const failures: string[] = [];
  const check = (label: string, ok: boolean): void => {
    if (!ok) failures.push(label);
  };

  const results = {} as Record<Variant, VariantResult>;
  for (const variant of ["baseline", ...DIAGNOSTICS] as const) {
    results[variant] = evaluateVariant(variant);
  }

  // 1. Discrimination ordering on the combined train+validation aggregate.
  check(
    `broken(${results.broken.combined}) < naive(${results.naive.combined})`,
    results.broken.combined < results.naive.combined,
  );
  check(
    `naive(${results.naive.combined}) < baseline(${results.baseline.combined})`,
    results.naive.combined < results.baseline.combined,
  );
  check(
    `baseline(${results.baseline.combined}) < improved(${results.improved.combined})`,
    results.baseline.combined < results.improved.combined,
  );

  // 2. Split integrity: the train-memorizing cheat inverts across splits.
  check(
    `shortcut beats baseline on train (${results.shortcut.train} > ${results.baseline.train})`,
    results.shortcut.train > results.baseline.train,
  );
  check(
    `shortcut does NOT beat baseline on validation (${results.shortcut.validation} < ${results.baseline.validation})`,
    results.shortcut.validation < results.baseline.validation,
  );

  // 3. Stability: repeated baseline evals within the relative spread band.
  const stabilityAggregates = [results.baseline.combined];
  for (let i = 1; i < STABILITY_RUNS; i += 1) {
    stabilityAggregates.push(evaluateVariant("baseline").combined);
  }
  const mean =
    stabilityAggregates.reduce((a, b) => a + b, 0) / stabilityAggregates.length;
  const stabilitySpread =
    (Math.max(...stabilityAggregates) - Math.min(...stabilityAggregates)) / mean;
  check(
    `baseline stability spread ${stabilitySpread.toFixed(4)} < ${STABILITY_BAND}`,
    stabilitySpread < STABILITY_BAND,
  );

  // 4. Sanity: the correct candidates actually satisfy the constraint gates.
  for (const variant of ["baseline", "improved"] as const) {
    for (const split of SPLITS) {
      const out = results[variant].bySplit[split];
      check(
        `${variant}/${split} tests_pass`,
        out.constraints["tests_pass"] === true,
      );
      check(
        `${variant}/${split} quality == 1`,
        out.diagnostics?.["quality"] === 1.0,
      );
    }
  }

  return { results, stabilityAggregates, stabilitySpread, failures };
}

/**
 * Compact persisted summary of a full ordering check — the shape the capsule
 * manifest pins by hash (`diagnosticOrdering`). Parsed through the shared
 * schema so a malformed summary can never be generated in the first place.
 */
export function summarizeOrderingReport(report: OrderingReport): DiagnosticOrderingReport {
  const variant = (r: VariantResult) => ({
    train: r.train,
    validation: r.validation,
    combined: r.combined,
    trainTestsPass: r.bySplit.train.constraints["tests_pass"] === true,
    validationTestsPass: r.bySplit.validation.constraints["tests_pass"] === true,
  });
  return DiagnosticOrderingReport.parse({
    version: DIAGNOSTIC_ORDERING_REPORT_VERSION,
    variants: {
      baseline: variant(report.results.baseline),
      broken: variant(report.results.broken),
      naive: variant(report.results.naive),
      shortcut: variant(report.results.shortcut),
      improved: variant(report.results.improved),
    },
    stability: {
      aggregates: report.stabilityAggregates,
      spread: report.stabilitySpread,
      band: STABILITY_BAND,
    },
    failures: report.failures,
  });
}

/**
 * Deterministic bytes for the persisted report: the canonical JSON (sorted
 * keys, no whitespace) plus a trailing newline. Serializing the same summary
 * twice is byte-identical, so a scaffold rerun over the persisted file
 * reproduces the same hash and capsule id.
 */
export function serializeOrderingReport(summary: DiagnosticOrderingReport): string {
  return `${canonicalJson(summary)}\n`;
}

function formatReport(report: OrderingReport): string {
  const lines: string[] = [];
  lines.push("variant    train        validation   combined     tests_pass(train/val)");
  for (const [variant, r] of Object.entries(report.results)) {
    lines.push(
      `${variant.padEnd(10)} ${r.train.toExponential(3).padEnd(12)} ` +
        `${r.validation.toExponential(3).padEnd(12)} ` +
        `${r.combined.toExponential(3).padEnd(12)} ` +
        `${String(r.bySplit.train.constraints["tests_pass"])}/${String(
          r.bySplit.validation.constraints["tests_pass"],
        )}`,
    );
  }
  lines.push(
    `stability: aggregates [${report.stabilityAggregates
      .map((a) => a.toExponential(3))
      .join(", ")}], spread ${report.stabilitySpread.toFixed(4)} (band ${STABILITY_BAND})`,
  );
  return lines.join("\n");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf("--report");
  const reportPath =
    flagIndex === -1
      ? undefined
      : (args[flagIndex + 1] ?? join(CAPSULE_DIR, "diagnostics", "ordering-report.json"));

  const report = runOrderingCheck();
  console.log(formatReport(report));
  if (report.failures.length > 0) {
    console.error(`\nORDERING CHECK FAILED:\n- ${report.failures.join("\n- ")}`);
    process.exit(1);
  }
  if (reportPath !== undefined) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, serializeOrderingReport(summarizeOrderingReport(report)));
    console.log(`\nreport -> ${reportPath}`);
  }
  console.log("\nordering check PASSED");
}
