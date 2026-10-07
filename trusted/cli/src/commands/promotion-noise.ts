import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CasStore, readBrokerJournalEvaluations } from "@hone/broker";
import { DETERMINISTIC_ZERO_NOISE_ESTIMATOR, MeasurementEpoch, canonicalJson, capsuleDigest } from "@hone/schema";
import { admitCapsule, readCapsuleSnapshot } from "../admission.js";
import { UsageError, boolFlag, parseFlags, strFlag } from "../args.js";
import { measureBaseline } from "../backends/local.js";
import { replayRun, writeFileDurable } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { deriveBaselineNoiseCalibration, deriveDeterministicBaselineNoiseCalibration } from "../promotion-noise-derivation.js";
import type { BaselineNoiseIdentity } from "../promotion-noise-derivation.js";
import { casRoot, loadRunConfigFile, runsRoot } from "../runs.js";
import { searchAssetGroupId } from "../search.js";
import { runCommand } from "../supervisor.js";

const USAGE =
  "usage: hone promotion-noise <capsule-dir> --epoch <name> --out <calibration.json> --headless [--deterministic] [--seeds K] [--repeats R] [--backend local|stub]";

/** Schema minimums for the pooled-score estimator; never lowered here. */
const MIN_SEEDS = 3;
const MIN_REPEATS = 3;
const MIN_MEASUREMENTS = 21;
const MIN_DEGREES_OF_FREEDOM = 18;

function positiveInt(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const raw = strFlag(flags, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new UsageError(`--${name} must be a positive integer`);
  return value;
}

/**
 * `hone promotion-noise`: produce a promotion-noise calibration for one
 * capsule in an operator-chosen measurement epoch.
 *
 * It runs R sealed baseline-only noise runs (`noiseCalibration` run config),
 * one after another. Each is an ordinary trusted `hone run` under the same
 * epoch, capsule digest and evaluator image as the later search: it measures
 * the frozen baseline once per seed and calls no model. Run ids derive from
 * the frozen plan, so re-running the command resumes or reuses every repeat
 * instead of paying for it again. By default the pooled-score estimator uses
 * K seeds × R repeats. Opt-in --deterministic requires identical fresh score
 * vectors and emits zero-noise evidence, or refuses without falling back.
 * The result is written to --out, ready for `hone run … --calibration`.
 */
export async function promotionNoiseCommand(args: string[], io: CmdIo): Promise<number> {
  const { positionals, flags } = parseFlags(args, {
    booleans: ["headless", "deterministic"],
    strings: ["epoch", "out", "seeds", "repeats", "backend"],
  });
  const capsuleArg = positionals[0];
  const epochFlag = strFlag(flags, "epoch");
  const outFlag = strFlag(flags, "out");
  if (capsuleArg === undefined || positionals.length !== 1 || epochFlag === undefined || outFlag === undefined || !boolFlag(flags, "headless")) {
    throw new UsageError(USAGE);
  }
  const epoch = MeasurementEpoch.safeParse(epochFlag);
  if (!epoch.success) throw new UsageError(`--epoch: ${epoch.error.issues.map((issue) => issue.message).join("; ")}`);
  const deterministic = boolFlag(flags, "deterministic");
  const seedCount = positiveInt(flags, "seeds", deterministic ? 1 : MIN_SEEDS);
  const repeats = positiveInt(flags, "repeats", deterministic ? MIN_REPEATS : 7);
  if (deterministic && repeats < MIN_REPEATS) {
    throw new UsageError("--deterministic requires at least 3 fresh baseline repeats; otherwise run the full default 3 × 7 calibration without --deterministic");
  }
  if (!deterministic && (
    seedCount < MIN_SEEDS
    || repeats < MIN_REPEATS
    || seedCount * repeats < MIN_MEASUREMENTS
    || seedCount * (repeats - 1) < MIN_DEGREES_OF_FREEDOM
  )) {
    throw new UsageError(
      `--seeds ${seedCount} --repeats ${repeats} is below the calibration minimums: at least ${MIN_SEEDS} seeds, `
        + `${MIN_REPEATS} repeats, ${MIN_MEASUREMENTS} measurements and seeds × (repeats − 1) ≥ ${MIN_DEGREES_OF_FREEDOM} (default 3 × 7)`,
    );
  }
  const backendFlag = strFlag(flags, "backend");
  const capsuleDir = resolve(io.root, capsuleArg);
  const outPath = resolve(io.root, outFlag);

  const admitted = admitCapsule(capsuleDir, { review: "required", casDir: casRoot(io.root) });
  if (admitted.provisional) throw new UsageError("provisional capsule quarantine admits only the M0 probe — calibrate an approved capsule");
  const identity: BaselineNoiseIdentity = {
    capsuleId: admitted.manifest.id,
    admittedCapsuleDigest: admitted.digest,
    executionImage: admitted.manifest.image,
    assetGroupId: searchAssetGroupId(admitted.manifest),
    measurementEpoch: epoch.data,
    seeds: Array.from({ length: seedCount }, (_, seed) => seed),
  };
  if (deterministic) {
    identity.baselineArtifactHash = admitted.manifest.baseline.kind === "cas"
      ? admitted.manifest.baseline.hash
      : await measureBaseline(capsuleDir, admitted.manifest, new CasStore(casRoot(io.root)));
  }
  // Keep the default plan's canonical bytes unchanged; the opt-in estimator
  // gets separate persisted plans, run ids and therefore cache namespaces.
  const plan = deterministic
    ? { version: 1, ...identity, repeats, estimator: DETERMINISTIC_ZERO_NOISE_ESTIMATOR }
    : { version: 1, ...identity, repeats };
  const planHash = createHash("sha256").update(canonicalJson(plan)).digest("hex");
  const stateDir = join(runsRoot(io.root), `promotion-noise-${planHash.slice(0, 16)}`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const planPath = join(stateDir, "plan.json");
  if (!existsSync(planPath)) writeFileDurable(planPath, `${canonicalJson(plan)}\n`);
  const noiseCalibration = { measurementEpoch: identity.measurementEpoch, assetGroupId: identity.assetGroupId, seeds: identity.seeds };
  const configPath = join(stateDir, "noise-run-config.json");
  if (!existsSync(configPath)) {
    writeFileDurable(configPath, `${JSON.stringify({ headless: true, apply: "none", noiseCalibration }, null, 2)}\n`);
  }
  const backendArgs = backendFlag === undefined ? [] : ["--backend", backendFlag];

  const runDirs: Array<{ runId: string; runDir: string }> = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const runId = `run_noise_${planHash.slice(0, 12)}_r${repeat}`;
    const runDir = join(runsRoot(io.root), runId);
    let code = 0;
    if (!existsSync(runDir)) {
      code = await runCommand([capsuleDir, "--headless", "--config", configPath, ...backendArgs], io, { runId });
    } else {
      const state = replayRun(runDir);
      if (state.runId === null) {
        throw new UsageError(`noise run ${runId} was minted but never started; remove ${runDir} and re-run to measure it`);
      }
      if (state.finished === null) {
        code = await runCommand([capsuleDir, "--headless", "--resume", ...backendArgs], io, { runId });
      }
    }
    const state = replayRun(runDir);
    if (state.finished === null) {
      io.err(`noise run ${runId} (repeat ${repeat + 1}/${repeats}) is not finished; re-run this command to resume it`);
      return code === 0 ? 1 : code;
    }
    if (state.finished.status !== "completed") {
      throw new UsageError(
        `noise run ${runId} (repeat ${repeat + 1}/${repeats}) finished ${state.finished.status}; a cohort needs every repeat completed — `
          + "fix the cause and measure a fresh cohort under a new --epoch",
      );
    }
    runDirs.push({ runId, runDir });
  }

  // Every repeat must have measured exactly this plan, in this epoch, for this
  // admitted capsule; the derivation re-checks each journaled fact.
  const runs = runDirs.map(({ runId, runDir }) => {
    const sealed = loadRunConfigFile(runDir).noiseCalibration;
    if (sealed === undefined || canonicalJson(sealed) !== canonicalJson(noiseCalibration)) {
      throw new UsageError(`noise run ${runId} did not seal this plan's noise calibration`);
    }
    if (capsuleDigest(readCapsuleSnapshot(runDir)) !== identity.admittedCapsuleDigest) {
      throw new UsageError(`noise run ${runId} measured a different admitted capsule digest`);
    }
    return { runId, facts: readBrokerJournalEvaluations(runDir).facts };
  });
  const calibratedAt = runDirs
    .map(({ runDir }) => replayRun(runDir).finished?.at ?? "")
    .reduce((latest, at) => (at > latest ? at : latest), "");
  let derived;
  try {
    derived = deterministic
      ? deriveDeterministicBaselineNoiseCalibration(runs, identity, calibratedAt)
      : deriveBaselineNoiseCalibration(runs, identity, calibratedAt);
  } catch (error) {
    const required = deterministic ? "; run the full default 3 × 7 calibration without --deterministic" : "";
    throw new UsageError(`promotion-noise derivation refused: ${error instanceof Error ? error.message : String(error)}${required}`);
  }
  writeFileDurable(join(stateDir, "observations.json"), `${canonicalJson(derived.observations)}\n`);
  const body = `${JSON.stringify(derived.calibration, null, 2)}\n`;
  if (existsSync(outPath) && readFileSync(outPath, "utf8") !== body) {
    throw new UsageError(`--out ${outPath} already exists with different content; choose a new path`);
  }
  writeFileDurable(outPath, body);
  io.out(JSON.stringify({
    type: "promotion-noise.calibrated",
    out: outPath,
    capsuleId: identity.capsuleId,
    measurementEpoch: identity.measurementEpoch,
    assetGroupId: identity.assetGroupId,
    runs: runDirs.map(({ runId }) => runId),
    pooledWithinCoordinateSd: derived.calibration.estimator === "pooled-within-coordinate-sd-v1"
      ? derived.calibration.pooledWithinCoordinateSd
      : null,
    noiseEnvelope: derived.calibration.noiseEnvelope,
  }));
  return 0;
}
