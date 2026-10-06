import { readFileSync } from "node:fs";
import { bindPromotionNoiseCalibrations } from "@hone/broker";
import {
  NoiseCalibrationRunConfig,
  SearchRunConfig,
  type BudgetEnvelope,
  type BudgetState,
  type CapsuleManifest,
  type PromotionGateDecision,
  type PromotionNoiseCalibration,
  type RunConfig,
  type RunEvent,
} from "@hone/schema";
import { UsageError } from "./args.js";

/**
 * Sealed single-capsule search for `hone run` (`search` in the run config).
 *
 * The seed loop's multi-episode search already runs for M1 children. A plain
 * run reaches it by sealing three things at creation, all bound by the
 * contract hash and reused verbatim on resume: the episode count, a trusted
 * measurement epoch, and the promotion-noise calibrations measured in that
 * epoch. The supervisor maps them onto the same trusted context the M1
 * campaign fills (optimizerEpisodesMax, maxPublicCandidateEvaluations,
 * measurementEpoch), never from optimizer-authored input.
 */

/** Parent + candidate: the evaluator invocations an episode needs before any comparison exists. */
export const MIN_EVALUATOR_INVOCATIONS_PER_EPISODE = 2;

/** Candidate plus one repair per episode, each a distinct public evaluation and a saved artifact. */
export const PUBLIC_CANDIDATES_PER_EPISODE = 2;

/**
 * The asset group the seed loop measures and gates on: `train` when it is
 * visible, otherwise the first non-holdout group in manifest order (the order
 * getTask reports). Matches the loop's policy and the M1 final coordinate.
 */
export function searchAssetGroupId(manifest: CapsuleManifest): string {
  const group =
    manifest.assetGroups.find((candidate) => candidate.visibility !== "holdout" && candidate.id === "train")
    ?? manifest.assetGroups.find((candidate) => candidate.visibility !== "holdout");
  if (group === undefined) throw new UsageError(`capsule ${manifest.id} has no non-holdout asset group to measure`);
  return group.id;
}

/** A calibration file holds one PromotionNoiseCalibration object or an array of them. */
export function readCalibrationFile(path: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`--calibration ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

export interface SearchSealInputs {
  runId: string;
  manifest: CapsuleManifest;
  admittedCapsuleDigest: string;
  executionImage: string;
  /** The run's effective (possibly tightened) budget envelope. */
  budget: BudgetEnvelope;
  episodes: number;
  measurementEpoch: string | undefined;
  /** Raw calibration file entries, or null when no --calibration was given. */
  calibrations: readonly unknown[] | null;
}

/**
 * Validate and seal a search at creation. Refuses an episode count the
 * admitted envelope obviously cannot serve, and any calibration the broker
 * would refuse at startup (same identity binding) or that does not cover the
 * asset group the search gates on.
 */
export function sealSearchConfig(inputs: SearchSealInputs): SearchRunConfig {
  const floor = MIN_EVALUATOR_INVOCATIONS_PER_EPISODE * inputs.episodes;
  if (floor > inputs.budget.maxEvaluatorInvocations) {
    throw new UsageError(
      `search.episodes ${inputs.episodes} needs at least ${floor} evaluator invocations (parent + candidate per episode), `
        + `but the run budget allows ${inputs.budget.maxEvaluatorInvocations}`,
    );
  }
  // Minted when the operator names none: unique to the run, so no calibration can match it.
  const measurementEpoch = inputs.measurementEpoch ?? `search:${inputs.runId}`;
  let calibrations: PromotionNoiseCalibration[] = [];
  if (inputs.calibrations !== null) {
    if (inputs.measurementEpoch === undefined) {
      throw new UsageError("--calibration requires search.measurementEpoch: a calibration only binds to the epoch it was measured in");
    }
    try {
      calibrations = [...bindPromotionNoiseCalibrations(inputs.calibrations, {
        capsuleId: inputs.manifest.id,
        admittedCapsuleDigest: inputs.admittedCapsuleDigest,
        executionImage: inputs.executionImage,
        assetGroupIds: inputs.manifest.assetGroups.map((group) => group.id),
        measurementEpoch,
      }).values()];
    } catch (error) {
      throw new UsageError(`--calibration refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    const searchGroup = searchAssetGroupId(inputs.manifest);
    if (!calibrations.some((calibration) => calibration.assetGroupId === searchGroup)) {
      throw new UsageError(
        `--calibration covers ${calibrations.map((calibration) => calibration.assetGroupId).join(", ") || "no asset group"}, `
          + `but the search gates on ${searchGroup}`,
      );
    }
  }
  return SearchRunConfig.parse({ episodes: inputs.episodes, measurementEpoch, calibrations });
}

/** Validate a baseline-only noise run against the admitted capsule and budget. */
export function sealNoiseCalibrationConfig(
  noise: NoiseCalibrationRunConfig,
  manifest: CapsuleManifest,
  budget: BudgetEnvelope,
): NoiseCalibrationRunConfig {
  const group = manifest.assetGroups.find((candidate) => candidate.id === noise.assetGroupId);
  if (group === undefined || group.visibility === "holdout") {
    throw new UsageError(`noiseCalibration.assetGroupId ${noise.assetGroupId} is not a registered non-holdout asset group`);
  }
  // The broker ends a run as `budget` once spent reaches the envelope, so a
  // noise run must finish strictly below it to complete.
  if (noise.seeds.length >= budget.maxEvaluatorInvocations) {
    throw new UsageError(
      `noiseCalibration measures ${noise.seeds.length} seeds, so it needs more than ${noise.seeds.length} evaluator invocations to complete under its budget, but the run budget allows ${budget.maxEvaluatorInvocations}`,
    );
  }
  return NoiseCalibrationRunConfig.parse(noise);
}

/** Trusted backend authority derived from the sealed config; empty for M0 and campaign runs. */
export interface SealedRunAuthority {
  measurementEpoch?: string;
  optimizerEpisodesMax?: number;
  maxPublicCandidateEvaluations?: number;
  maxCandidateArtifacts?: number;
  promotionNoiseCalibrations?: readonly PromotionNoiseCalibration[];
}

export function sealedRunAuthority(config: RunConfig): SealedRunAuthority {
  if (config.search !== undefined) {
    const { episodes, measurementEpoch, calibrations } = config.search;
    return {
      measurementEpoch,
      optimizerEpisodesMax: episodes,
      maxPublicCandidateEvaluations: PUBLIC_CANDIDATES_PER_EPISODE * episodes,
      maxCandidateArtifacts: PUBLIC_CANDIDATES_PER_EPISODE * episodes,
      // Explicit, possibly empty: the sealed list is the run's only calibration authority.
      promotionNoiseCalibrations: calibrations,
    };
  }
  if (config.noiseCalibration !== undefined) {
    return { measurementEpoch: config.noiseCalibration.measurementEpoch, promotionNoiseCalibrations: [] };
  }
  return {};
}

/** Plain-language notice when the sealed search cannot promote anything; null when it can. */
export function searchCalibrationNotice(search: SearchRunConfig, manifest: CapsuleManifest): string | null {
  const group = searchAssetGroupId(manifest);
  if (search.calibrations.some((calibration) => calibration.assetGroupId === group)) return null;
  return `search run has no promotion calibration for asset group ${group} in epoch ${JSON.stringify(search.measurementEpoch)}: `
    + "every candidate gate refuses as uncalibrated, so the run searches but no child can become incumbent. "
    + "Produce one with `hone promotion-noise` and seal it with --calibration.";
}

export interface SearchLineageStep {
  episode: number;
  parent: string;
  artifact: string;
  parentScore: number | null;
  childScore: number;
  delta: number | null;
  noiseEnvelope: number | null;
  decision: PromotionGateDecision | null;
  deltaVsBaseline: number;
}

export interface SearchReport {
  measurementEpoch: string;
  assetGroupId: string;
  calibrated: boolean;
  episodes: { planned: number; completed: number };
  /** Broker-authored gate.paired decisions by outcome. */
  gates: Partial<Record<PromotionGateDecision, number>>;
  /** Baseline → best incumbent, one step per promotion, each with its paired delta. */
  lineage: SearchLineageStep[];
  budget: BudgetState | null;
  note: string | null;
}

/**
 * End-of-run search report from the durable, broker-authored events: the best
 * incumbent's chain of promotions back to the baseline, each step's paired
 * parent/child delta and noise envelope, the gate outcomes, and budget used.
 */
export function searchReport(events: readonly RunEvent[], search: SearchRunConfig, manifest: CapsuleManifest): SearchReport {
  const parents = new Map<number, string>();
  // Broker-authored gate per candidate: each candidate is gated once, on its first trusted measurement.
  const gatesByCandidate = new Map<string, Extract<RunEvent, { type: "gate.paired" }>>();
  const incumbents = new Map<string, Extract<RunEvent, { type: "incumbent.new" }>>();
  const gates: Partial<Record<PromotionGateDecision, number>> = {};
  let completed = 0;
  let budget: BudgetState | null = null;
  let best: string | null = null;
  for (const event of events) {
    switch (event.type) {
      case "episode.started":
        parents.set(event.episode, event.parent.hash);
        break;
      case "episode.completed":
        completed += 1;
        break;
      case "gate.paired": {
        if (event.candidate !== undefined) gatesByCandidate.set(event.candidate.hash, event);
        const decision = event.decision ?? (event.passed ? "promote" : null);
        if (decision !== null) gates[decision] = (gates[decision] ?? 0) + 1;
        break;
      }
      case "incumbent.new":
        incumbents.set(event.artifact.hash, event);
        best = event.artifact.hash;
        break;
      case "budget.snapshot":
        budget = event.budget;
        break;
      default:
        break;
    }
  }
  const lineage: SearchLineageStep[] = [];
  const visited = new Set<string>();
  for (let hash = best; hash !== null && !visited.has(hash);) {
    visited.add(hash);
    const incumbent = incumbents.get(hash);
    if (incumbent === undefined) break;
    const parent = parents.get(incumbent.episode) ?? null;
    const gate = gatesByCandidate.get(hash);
    lineage.unshift({
      episode: incumbent.episode,
      parent: parent ?? "unknown",
      artifact: hash,
      parentScore: gate?.parentScore ?? null,
      childScore: incumbent.aggregate,
      delta: gate?.delta ?? (gate === undefined ? null : gate.childScore - gate.parentScore),
      noiseEnvelope: gate?.noiseEnvelope ?? null,
      decision: gate?.decision ?? null,
      deltaVsBaseline: incumbent.deltaVsBaseline,
    });
    hash = parent;
  }
  const note = searchCalibrationNotice(search, manifest);
  return {
    measurementEpoch: search.measurementEpoch,
    assetGroupId: searchAssetGroupId(manifest),
    calibrated: note === null,
    episodes: { planned: search.episodes, completed },
    gates,
    lineage,
    budget,
    note,
  };
}
