import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrokerJournalEvaluationFact } from "@hone/broker";
import {
  DETERMINISTIC_ZERO_NOISE_ESTIMATOR,
  POOLED_SCORE_SD_ESTIMATOR,
  PROMOTION_GATE_VERSION,
  PromotionNoiseCalibration,
  canonicalJson,
  capsuleDigest,
  deterministicBaselineScoreHash,
} from "@hone/schema";
import type { CapsuleManifest, DeterministicBaselineRun, DeterministicBaselineScore } from "@hone/schema";

export const PROMOTION_NOISE_OBSERVATIONS_VERSION =
  "campaign-12-promotion-noise-observations-v2" as const;
export const PROMOTION_NOISE_ESTIMATOR = "pooled-within-coordinate-sd-v1" as const;
export const ESTIMATOR_MIN_REPEATS_PER_COORDINATE = 3 as const;

interface EventRecord {
  runId?: string;
  at?: string;
  type?: string;
  capsuleId?: string;
  artifact?: { hash?: string };
  assetGroupId?: string;
  seed?: number;
  aggregate?: number | null;
  cached?: boolean;
}

interface BrokerEvalLine {
  t?: string;
  measurementEpoch?: string;
}

interface CampaignSession {
  capsuleImage?: string;
  executionImage?: string;
}

export interface RepeatedScoreObservation {
  runId: string;
  at: string;
  score: number;
}

export interface RepeatedScoreGroup {
  artifactHash: string;
  assetGroupId: "train";
  seed: number;
  observations: RepeatedScoreObservation[];
}

export interface CapsuleNoiseObservations {
  identity: {
    capsuleId: string;
    admittedCapsuleDigest: string;
    admittedManifestImage: string;
    executionImage: string;
    assetGroupId: "train";
    measurementEpochs: string[];
  };
  sourceFiles: Array<{
    runId: string;
    eventsPath: string;
    eventsSha256: string;
    manifestPath: string;
    manifestSha256: string;
    campaignSessionPath: string;
    campaignSessionSha256: string;
    brokerStatePath: string;
    brokerStateSha256: string;
    measurementEpoch: string;
  }>;
  groups: RepeatedScoreGroup[];
}

export interface PromotionNoiseObservationsArtifact {
  version: typeof PROMOTION_NOISE_OBSERVATIONS_VERSION;
  derivedAtCampaignTerminal: "2026-08-28T03:32:53.235Z";
  sourceRoot: string;
  capsules: CapsuleNoiseObservations[];
}

export interface DerivedNoiseCalibration {
  capsuleId: string;
  admittedCapsuleDigest: string;
  executionImage: string;
  assetGroupId: "train";
  measurementEpochs: string[];
  estimator: typeof PROMOTION_NOISE_ESTIMATOR;
  estimatorMinRepeatsPerCoordinate: typeof ESTIMATOR_MIN_REPEATS_PER_COORDINATE;
  sampleDepths: number[];
  informationFreeMeasurements: number;
  coordinateGroups: number;
  pooledDegreesOfFreedom: number;
  pooledWithinCoordinateSd: number;
  noiseFloor: number;
  noiseEnvelope: number;
  informationFreePairs: number;
  informationFreePositive: number;
  observedInformationFreeMeasurements: number;
  observedCoordinateGroups: number;
  deltaDistribution: { min: number; p05: number; median: number; p95: number; max: number };
  sensitivityThresholds: { maxSpan: number; p99: number; threeSd: number; p95: number; twoSd: number };
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function lines(bytes: Buffer): unknown[] {
  return bytes.toString("utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error("quantile requires observations");
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) throw new Error("quantile index escaped observations");
  return low + (high - low) * (position - lower);
}

/** Journal -> immutable raw observation artifact, including measured identities and file hashes. */
export function derivePromotionNoiseObservations(runsRootInput: string): PromotionNoiseObservationsArtifact {
  const runsRoot = resolve(runsRootInput);
  if (!existsSync(runsRoot)) throw new Error(`campaign evidence root does not exist: ${runsRoot}`);
  const runDirs = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_meta_"))
    .map((entry) => join(runsRoot, entry.name))
    .sort();
  const byCapsule = new Map<string, CapsuleNoiseObservations>();

  for (const runDir of runDirs) {
    const eventsPath = join(runDir, "events.ndjson");
    const manifestPath = join(runDir, "capsule-manifest.json");
    const campaignSessionPath = join(runDir, "campaign-session.v1.json");
    const brokerStatePath = join(runDir, "broker-state.ndjson");
    if (
      !existsSync(eventsPath)
      || !existsSync(manifestPath)
      || !existsSync(campaignSessionPath)
      || !existsSync(brokerStatePath)
    ) continue;
    const eventsBytes = readFileSync(eventsPath);
    const manifestBytes = readFileSync(manifestPath);
    const campaignSessionBytes = readFileSync(campaignSessionPath);
    const brokerBytes = readFileSync(brokerStatePath);
    const manifest = CapsuleManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
    const session = JSON.parse(campaignSessionBytes.toString("utf8")) as CampaignSession;
    const executionImage = session.executionImage ?? session.capsuleImage;
    if (executionImage === undefined) throw new Error(`${runDir} has no executed capsule image receipt`);
    const digest = capsuleDigest(manifest);
    const epochs = new Set(
      (lines(brokerBytes) as BrokerEvalLine[])
        .filter((line) => line.t === "eval" && line.measurementEpoch !== undefined)
        .map((line) => line.measurementEpoch!),
    );
    if (epochs.size !== 1) throw new Error(`${runDir} has ${epochs.size} trusted measurement epochs`);
    const measurementEpoch = [...epochs][0]!;
    const events = lines(eventsBytes) as EventRecord[];
    const started = events.find((event) => event.type === "run.started");
    const runId = started?.runId;
    if (runId === undefined || started?.capsuleId !== manifest.id) {
      throw new Error(`${runDir} run.started does not match measured manifest`);
    }
    let capsule = byCapsule.get(manifest.id);
    if (capsule === undefined) {
      capsule = {
        identity: {
          capsuleId: manifest.id,
          admittedCapsuleDigest: digest,
          admittedManifestImage: manifest.image,
          executionImage,
          assetGroupId: "train",
          measurementEpochs: [],
        },
        sourceFiles: [],
        groups: [],
      };
      byCapsule.set(manifest.id, capsule);
    } else if (
      capsule.identity.admittedCapsuleDigest !== digest
      || capsule.identity.admittedManifestImage !== manifest.image
      || capsule.identity.executionImage !== executionImage
    ) {
      throw new Error(`${manifest.id} measured runs disagree on admitted or executed evaluator identity`);
    }
    capsule.identity.measurementEpochs.push(measurementEpoch);
    capsule.sourceFiles.push({
      runId,
      eventsPath: relative(runsRoot, eventsPath),
      eventsSha256: sha256(eventsBytes),
      manifestPath: relative(runsRoot, manifestPath),
      manifestSha256: sha256(manifestBytes),
      campaignSessionPath: relative(runsRoot, campaignSessionPath),
      campaignSessionSha256: sha256(campaignSessionBytes),
      brokerStatePath: relative(runsRoot, brokerStatePath),
      brokerStateSha256: sha256(brokerBytes),
      measurementEpoch,
    });
    for (const event of events) {
      if (
        event.type !== "eval.completed"
        || event.assetGroupId !== "train"
        || event.cached !== false
        || typeof event.aggregate !== "number"
        || event.artifact?.hash === undefined
        || event.seed === undefined
        || event.at === undefined
      ) continue;
      const existing = capsule.groups.find((group) =>
        group.artifactHash === event.artifact!.hash && group.seed === event.seed
      );
      const observation = { runId, at: event.at, score: event.aggregate };
      if (existing === undefined) {
        capsule.groups.push({
          artifactHash: event.artifact.hash,
          assetGroupId: "train",
          seed: event.seed,
          observations: [observation],
        });
      } else {
        existing.observations.push(observation);
      }
    }
  }

  const capsules = [...byCapsule.values()].sort((left, right) =>
    left.identity.capsuleId.localeCompare(right.identity.capsuleId)
  );
  for (const capsule of capsules) {
    capsule.identity.measurementEpochs.sort();
    capsule.sourceFiles.sort((left, right) => left.runId.localeCompare(right.runId));
    capsule.groups = capsule.groups
      .filter((group) => group.observations.length >= 2)
      .sort((left, right) =>
        left.artifactHash.localeCompare(right.artifactHash) || left.seed - right.seed
      );
    for (const group of capsule.groups) {
      group.observations.sort((left, right) => left.at.localeCompare(right.at) || left.runId.localeCompare(right.runId));
    }
  }
  if (capsules.length !== 6) throw new Error(`expected six campaign-12 capsules, got ${capsules.length}`);
  return {
    version: PROMOTION_NOISE_OBSERVATIONS_VERSION,
    derivedAtCampaignTerminal: "2026-08-28T03:32:53.235Z",
    sourceRoot: runsRoot,
    capsules,
  };
}

/** Repeated scores of one measurement coordinate; only cross-run pairs are information-free nulls. */
export interface ScoreCoordinate {
  observations: readonly { runId: string; score: number }[];
}

export interface PooledNoiseEstimate {
  /** Coordinates with at least ESTIMATOR_MIN_REPEATS_PER_COORDINATE repeats. */
  sampleDepths: number[];
  pooledDegreesOfFreedom: number;
  pooledWithinCoordinateSd: number;
  /** Every cross-run (later − earlier) pair delta within a coordinate. */
  deltas: number[];
  /** Largest within-coordinate score span (max observed pair delta). */
  maxSpan: number;
  observedInformationFreeMeasurements: number;
  observedCoordinateGroups: number;
}

/** Pooled within-coordinate SD over repeated scores (the pooled-score estimator's arithmetic). */
export function pooledNoiseEstimate(coordinates: readonly ScoreCoordinate[]): PooledNoiseEstimate {
  const groups = coordinates.filter((group) => group.observations.length >= 2);
  const estimatorGroups = groups.filter(
    (group) => group.observations.length >= ESTIMATOR_MIN_REPEATS_PER_COORDINATE,
  );
  const deltas: number[] = [];
  for (const group of groups) {
    for (let parent = 0; parent < group.observations.length; parent++) {
      for (let child = parent + 1; child < group.observations.length; child++) {
        const parentObservation = group.observations[parent]!;
        const childObservation = group.observations[child]!;
        if (parentObservation.runId === childObservation.runId) continue;
        deltas.push(childObservation.score - parentObservation.score);
      }
    }
  }
  let squaredError = 0;
  let pooledDegreesOfFreedom = 0;
  for (const group of estimatorGroups) {
    const scores = group.observations.map((observation) => observation.score);
    if (!scores.every((score) => score === scores[0])) {
      const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      squaredError += scores.reduce((sum, score) => sum + (score - mean) ** 2, 0);
    }
    pooledDegreesOfFreedom += scores.length - 1;
  }
  return {
    sampleDepths: estimatorGroups.map((group) => group.observations.length),
    pooledDegreesOfFreedom,
    pooledWithinCoordinateSd: Math.sqrt(squaredError / pooledDegreesOfFreedom),
    deltas,
    maxSpan: Math.max(...groups.map((group) => {
      const scores = group.observations.map((observation) => observation.score);
      return Math.max(...scores) - Math.min(...scores);
    })),
    observedInformationFreeMeasurements: groups.reduce((sum, group) => sum + group.observations.length, 0),
    observedCoordinateGroups: groups.length,
  };
}

/** Pure raw-observations -> convergent, minimum-powered calibration derivation. */
export function deriveNoiseCalibrations(
  artifact: PromotionNoiseObservationsArtifact,
): DerivedNoiseCalibration[] {
  if (artifact.version !== PROMOTION_NOISE_OBSERVATIONS_VERSION) {
    throw new Error(`unsupported observation artifact ${String(artifact.version)}`);
  }
  return artifact.capsules.map((capsule) => {
    const { sampleDepths, pooledDegreesOfFreedom, pooledWithinCoordinateSd, deltas, maxSpan, observedInformationFreeMeasurements, observedCoordinateGroups } =
      pooledNoiseEstimate(capsule.groups);
    return {
      capsuleId: capsule.identity.capsuleId,
      admittedCapsuleDigest: capsule.identity.admittedCapsuleDigest,
      executionImage: capsule.identity.executionImage,
      assetGroupId: capsule.identity.assetGroupId,
      measurementEpochs: capsule.identity.measurementEpochs,
      estimator: PROMOTION_NOISE_ESTIMATOR,
      estimatorMinRepeatsPerCoordinate: ESTIMATOR_MIN_REPEATS_PER_COORDINATE,
      sampleDepths,
      informationFreeMeasurements: sampleDepths.reduce((sum, depth) => sum + depth, 0),
      coordinateGroups: sampleDepths.length,
      pooledDegreesOfFreedom,
      pooledWithinCoordinateSd,
      noiseFloor: 3 * pooledWithinCoordinateSd,
      noiseEnvelope: 4.5 * pooledWithinCoordinateSd,
      informationFreePairs: deltas.length,
      informationFreePositive: deltas.filter((delta) => delta > 0).length,
      observedInformationFreeMeasurements,
      observedCoordinateGroups,
      deltaDistribution: {
        min: Math.min(...deltas),
        p05: quantile(deltas, 0.05),
        median: quantile(deltas, 0.5),
        p95: quantile(deltas, 0.95),
        max: Math.max(...deltas),
      },
      sensitivityThresholds: {
        maxSpan,
        p99: quantile(deltas, 0.99),
        threeSd: 3 * pooledWithinCoordinateSd,
        p95: quantile(deltas, 0.95),
        twoSd: 2 * pooledWithinCoordinateSd,
      },
    };
  });
}

export const BASELINE_NOISE_EVIDENCE_VERSION = "hone-baseline-noise-v1" as const;
export const BASELINE_NOISE_OBSERVATIONS_VERSION = "hone-baseline-noise-observations-v1" as const;

/** The identity a baseline-only noise cohort is measured under; the calibration binds every field. */
export interface BaselineNoiseIdentity {
  capsuleId: string;
  admittedCapsuleDigest: string;
  executionImage: string;
  assetGroupId: string;
  measurementEpoch: string;
  seeds: readonly number[];
  baselineArtifactHash?: string;
}

/** One completed noise run: its id and its journaled trusted evaluation facts. */
export interface BaselineNoiseRun {
  runId: string;
  facts: readonly BrokerJournalEvaluationFact[];
}

export interface BaselineNoiseObservations {
  version: typeof BASELINE_NOISE_OBSERVATIONS_VERSION;
  identity: BaselineNoiseIdentity & { baselineArtifactHash: string };
  runIds: string[];
  coordinates: Array<{ seed: number; observations: Array<{ runId: string; score: number }> }>;
}

/**
 * Baseline-only noise runs -> pooled-score promotion calibration. Each run
 * contributes exactly one fresh trusted measurement of the frozen baseline per
 * seed, so a seed is one coordinate and its repeats come from distinct runs
 * (broker boots). Every pair is information-free: both arms are the same
 * artifact. The cross-boot spread is at least the within-episode spread the
 * search gate faces, so the envelope is conservative. Schema minimums apply
 * unchanged: a cohort below them refuses.
 */
export function deriveBaselineNoiseCalibration(
  runs: readonly BaselineNoiseRun[],
  identity: BaselineNoiseIdentity,
  calibratedAt: string,
): { calibration: PromotionNoiseCalibration; observations: BaselineNoiseObservations } {
  let baselineArtifactHash: string | undefined;
  const coordinates = identity.seeds.map((seed) => ({ seed, observations: [] as Array<{ runId: string; score: number }> }));
  for (const run of runs) {
    const facts = run.facts.filter((fact) =>
      fact.measurementEpoch === identity.measurementEpoch && fact.record.assetGroupId === identity.assetGroupId);
    for (const coordinate of coordinates) {
      const measured = facts.filter((fact) => fact.record.seed === coordinate.seed);
      if (measured.length !== 1) {
        throw new Error(`noise run ${run.runId} holds ${measured.length} measurements of seed ${coordinate.seed}, expected exactly 1`);
      }
      const fact = measured[0]!;
      if (fact.record.cached) throw new Error(`noise run ${run.runId} seed ${coordinate.seed} is a memo hit, not a fresh measurement`);
      if (fact.record.capsuleId !== identity.capsuleId) {
        throw new Error(`noise run ${run.runId} measured capsule ${fact.record.capsuleId}, expected ${identity.capsuleId}`);
      }
      baselineArtifactHash ??= fact.record.artifactHash;
      if (fact.record.artifactHash !== baselineArtifactHash) {
        throw new Error(`noise run ${run.runId} measured ${fact.record.artifactHash}, not the cohort baseline ${baselineArtifactHash}`);
      }
      if (fact.aggregate === null) {
        throw new Error(`noise run ${run.runId} seed ${coordinate.seed}: the baseline measurement is not eligible (invalid output or failed constraint)`);
      }
      coordinate.observations.push({ runId: run.runId, score: fact.aggregate });
    }
  }
  if (baselineArtifactHash === undefined) throw new Error("noise cohort holds no baseline measurement");
  const observations: BaselineNoiseObservations = {
    version: BASELINE_NOISE_OBSERVATIONS_VERSION,
    identity: { ...identity, seeds: [...identity.seeds], baselineArtifactHash },
    runIds: runs.map((run) => run.runId),
    coordinates,
  };
  const estimate = pooledNoiseEstimate(coordinates);
  const maxObservedPairDelta = estimate.maxSpan;
  const calibration = PromotionNoiseCalibration.parse({
    gateVersion: PROMOTION_GATE_VERSION,
    evidenceVersion: BASELINE_NOISE_EVIDENCE_VERSION,
    calibratedAt,
    capsuleId: identity.capsuleId,
    admittedCapsuleDigest: identity.admittedCapsuleDigest,
    executionImage: identity.executionImage,
    assetGroupId: identity.assetGroupId,
    measurementEpoch: identity.measurementEpoch,
    sourceCohortSha256: [sha256(Buffer.from(canonicalJson(observations), "utf8"))],
    maxObservedPairDelta,
    noiseFloor: 3 * estimate.pooledWithinCoordinateSd,
    noiseEnvelope: Math.max(4.5 * estimate.pooledWithinCoordinateSd, maxObservedPairDelta),
    informationFreePairs: estimate.deltas.length,
    informationFreePositive: estimate.deltas.filter((delta) => delta > 0).length,
    estimator: POOLED_SCORE_SD_ESTIMATOR,
    estimatorMinRepeatsPerCoordinate: ESTIMATOR_MIN_REPEATS_PER_COORDINATE,
    sampleDepths: estimate.sampleDepths,
    informationFreeMeasurements: estimate.sampleDepths.reduce((sum, depth) => sum + depth, 0),
    coordinateGroups: estimate.sampleDepths.length,
    pooledDegreesOfFreedom: estimate.pooledDegreesOfFreedom,
    pooledWithinCoordinateSd: estimate.pooledWithinCoordinateSd,
  });
  return { calibration, observations };
}

export interface DeterministicBaselineNoiseObservations extends BaselineNoiseObservations {
  baselineRuns: DeterministicBaselineRun[];
  scoreHash: string;
}

/** Fresh baseline-only repeats -> zero-noise evidence, never a pooled fallback. */
export function deriveDeterministicBaselineNoiseCalibration(
  runs: readonly BaselineNoiseRun[],
  identity: BaselineNoiseIdentity,
  calibratedAt: string,
): { calibration: PromotionNoiseCalibration; observations: DeterministicBaselineNoiseObservations } {
  const baselineArtifactHash = identity.baselineArtifactHash;
  if (baselineArtifactHash === undefined) throw new Error("deterministic noise calibration requires the admitted baseline artifact hash");
  const baselineRuns: DeterministicBaselineRun[] = runs.map((run) => {
    let evaluationCacheNamespace: string | undefined;
    for (const fact of run.facts) {
      if (fact.measurementEpoch !== identity.measurementEpoch
        || fact.record.assetGroupId !== identity.assetGroupId
        || fact.record.capsuleId !== identity.capsuleId) {
        throw new Error(`noise run ${run.runId} contains a measurement outside the admitted capsule, group or epoch`);
      }
      if (fact.record.artifactHash !== baselineArtifactHash) {
        throw new Error(`noise run ${run.runId} measured ${fact.record.artifactHash}, not the admitted baseline ${baselineArtifactHash}`);
      }
      if (!identity.seeds.includes(fact.record.seed)) {
        throw new Error(`noise run ${run.runId} contains an unplanned seed ${fact.record.seed}`);
      }
      if (fact.record.cached !== false) throw new Error(`noise run ${run.runId} seed ${fact.record.seed} is a memo hit, not a fresh measurement`);
      if (fact.aggregate === null || !Number.isFinite(fact.aggregate)) {
        throw new Error(`noise run ${run.runId} seed ${fact.record.seed}: the baseline measurement is not eligible`);
      }
      if (fact.evaluationCacheNamespace === undefined) {
        throw new Error(`noise run ${run.runId} is missing its trusted run-scoped evaluation cache namespace`);
      }
      evaluationCacheNamespace ??= fact.evaluationCacheNamespace;
      if (fact.evaluationCacheNamespace !== evaluationCacheNamespace) {
        throw new Error(`noise run ${run.runId} contains inconsistent evaluation cache namespaces`);
      }
    }
    const scores: DeterministicBaselineScore[] = identity.seeds.map((seed) => {
      const measured = run.facts.filter((fact) => fact.record.seed === seed);
      if (measured.length !== 1) {
        throw new Error(`noise run ${run.runId} holds ${measured.length} measurements of seed ${seed}, expected exactly 1`);
      }
      const fact = measured[0]!;
      return {
        seed,
        aggregate: fact.aggregate!,
        perExample: Object.fromEntries(Object.entries(fact.record.output.perExample).map(([id, result]) => [id, result.score])),
      };
    });
    if (evaluationCacheNamespace === undefined) throw new Error(`noise run ${run.runId} holds no fresh baseline measurement`);
    return { runId: run.runId, evaluationCacheNamespace, scores };
  });
  const scoreHash = deterministicBaselineScoreHash(baselineRuns[0]?.scores ?? []);
  const observations: DeterministicBaselineNoiseObservations = {
    version: BASELINE_NOISE_OBSERVATIONS_VERSION,
    identity: { ...identity, seeds: [...identity.seeds], baselineArtifactHash },
    runIds: runs.map((run) => run.runId),
    coordinates: identity.seeds.map((seed, index) => ({
      seed,
      observations: baselineRuns.map((run) => ({ runId: run.runId, score: run.scores[index]!.aggregate })),
    })),
    baselineRuns,
    scoreHash,
  };
  const calibration = PromotionNoiseCalibration.parse({
    gateVersion: PROMOTION_GATE_VERSION,
    evidenceVersion: BASELINE_NOISE_EVIDENCE_VERSION,
    calibratedAt,
    capsuleId: identity.capsuleId,
    admittedCapsuleDigest: identity.admittedCapsuleDigest,
    executionImage: identity.executionImage,
    assetGroupId: identity.assetGroupId,
    measurementEpoch: identity.measurementEpoch,
    sourceCohortSha256: [sha256(Buffer.from(canonicalJson(observations), "utf8"))],
    estimator: DETERMINISTIC_ZERO_NOISE_ESTIMATOR,
    baselineArtifactHash,
    baselineRuns,
    scoreHash,
    informationFreeMeasurements: runs.length * identity.seeds.length,
    informationFreePairs: identity.seeds.length * runs.length * (runs.length - 1) / 2,
    informationFreePositive: 0,
    maxObservedPairDelta: 0,
    noiseFloor: 0,
    noiseEnvelope: 0,
  });
  return { calibration, observations };
}

export interface DirectPairedDeltaScale {
  capsuleId: string;
  admittedCapsuleDigest: string;
  executionImage: string;
  assetGroupId: "train";
  baselineArtifactHash: string;
  pairedDeltaTrials: number;
  pairedDeltaDegreesOfFreedom: number;
  pairedDeltaSd: number;
  informationFreePositive: number;
  maxObservedLocalPairDelta: number;
  sourceCohortSha256: string;
}

interface LocalNullTrial {
  capsuleId?: string;
  capsuleDigest?: string;
  image?: string;
  baselineArtifact?: string;
  parentScore?: number;
  childScore?: number;
  gateEvents?: number;
  evalAssetGroupIds?: string[];
  evalSeeds?: number[];
}

/** Purpose-built schedule-faithful null trials -> direct paired-delta SD. */
export function deriveDirectPairedDeltaScales(bytes: Buffer): DirectPairedDeltaScale[] {
  const trials = lines(bytes) as LocalNullTrial[];
  const byCapsule = new Map<string, LocalNullTrial[]>();
  for (const trial of trials) {
    if (
      trial.capsuleId === undefined
      || trial.capsuleDigest === undefined
      || trial.image === undefined
      || trial.baselineArtifact === undefined
      || trial.parentScore === undefined
      || trial.childScore === undefined
      || trial.gateEvents !== 1
      || JSON.stringify(trial.evalAssetGroupIds) !== JSON.stringify(["train", "train"])
      || trial.evalSeeds?.length !== 2
      || trial.evalSeeds[0] !== trial.evalSeeds[1]
    ) {
      throw new Error("local null trial is missing schedule-faithful paired evidence");
    }
    const group = byCapsule.get(trial.capsuleId) ?? [];
    group.push(trial);
    byCapsule.set(trial.capsuleId, group);
  }
  const sourceCohortSha256 = sha256(bytes);
  const result: DirectPairedDeltaScale[] = [];
  for (const [capsuleId, group] of byCapsule) {
    if (group.length !== 16) throw new Error(`${capsuleId} has ${group.length} local null trials, expected 16`);
    const first = group[0]!;
    if (!group.every((trial) =>
      trial.capsuleDigest === first.capsuleDigest
      && trial.image === first.image
      && trial.baselineArtifact === first.baselineArtifact
    )) {
      throw new Error(`${capsuleId} local null trials disagree on evaluator identity`);
    }
    const deltas = group.map((trial) => trial.childScore! - trial.parentScore!);
    const mean = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
    const squaredError = deltas.every((delta) => delta === deltas[0])
      ? 0
      : deltas.reduce((sum, delta) => sum + (delta - mean) ** 2, 0);
    result.push({
      capsuleId,
      admittedCapsuleDigest: first.capsuleDigest!,
      executionImage: first.image!,
      assetGroupId: "train",
      baselineArtifactHash: first.baselineArtifact!,
      pairedDeltaTrials: deltas.length,
      pairedDeltaDegreesOfFreedom: deltas.length - 1,
      pairedDeltaSd: Math.sqrt(squaredError / (deltas.length - 1)),
      informationFreePositive: deltas.filter((delta) => delta > 0).length,
      maxObservedLocalPairDelta: Math.max(...deltas.map(Math.abs)),
      sourceCohortSha256,
    });
  }
  return result.sort((left, right) => left.capsuleId.localeCompare(right.capsuleId));
}

export function writePromotionNoiseObservations(runsRoot: string, outputPath: string): void {
  const artifact = derivePromotionNoiseObservations(runsRoot);
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const runsRoot = process.argv[2];
  const outputPath = process.argv[3];
  if (runsRoot === undefined || outputPath === undefined) {
    throw new Error("usage: promotion-noise-derivation.ts <campaign .hone-runs> <new observations.json>");
  }
  writePromotionNoiseObservations(runsRoot, outputPath);
}
