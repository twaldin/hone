/** Episode caps admitted by the frozen M2 calibration design. */
export type SaturationCap = 2 | 4 | 8 | 12;
export type SaturationCeiling = 4 | 8 | 12;

export interface ValidSaturationCell {
  capsuleId: string;
  cap: SaturationCap;
  seed: number;
  status: "valid";
  /** Final normalized gain from the independent calibration run. */
  normalizedGain: number;
}

export interface InvalidSaturationCell {
  capsuleId: string;
  cap: SaturationCap;
  seed: number;
  status: "invalid" | "incomplete";
}

export type SaturationCell = ValidSaturationCell | InvalidSaturationCell;

export interface SaturationCeilingOptions {
  /** Explicit uint32 seed for the local deterministic PRNG. Ambient randomness is never consulted. */
  rngSeed: number;
  /** Number of stratified bootstrap resamples. Defaults to 10,000. */
  bootstrapSamples?: number;
}

export type SaturationStatistic = number | "negative-infinity";

export interface SaturationDelta {
  capsuleId: string;
  seed: number;
  lowerCap: SaturationCap;
  upperCap: SaturationCeiling;
  lowerStatus: SaturationCell["status"];
  upperStatus: SaturationCell["status"];
  value: SaturationStatistic;
  source: "observed" | "invalid-deeper" | "invalid-shallower";
}

export interface SaturationComparison {
  lowerCap: SaturationCap;
  upperCap: SaturationCeiling;
  percentile75: SaturationStatistic;
  upperConfidenceBound90: SaturationStatistic;
  qualifies: boolean;
}

export interface SaturationCeilingReport {
  rule: {
    capsuleCount: 4;
    seedsPerCapsule: 5;
    caps: readonly [2, 4, 8, 12];
    adjacentPairs: readonly [readonly [2, 4], readonly [4, 8], readonly [8, 12]];
    marginalPercentile: 0.75;
    confidenceLevel: 0.9;
    practicalGainThreshold: 0.02;
    quantileMethod: "nearest-rank";
    confidenceMethod: "bootstrap-percentile-upper-bound";
    invalidDeeperConvention: "negative-infinity";
    invalidShallowerConvention: "negative-infinity";
  };
  cells: SaturationCell[];
  deltas: SaturationDelta[];
  bootstrap: {
    method: "stratified-seed-resampling-within-capsule";
    rng: "mulberry32-v1";
    rngSeed: number;
    samples: number;
  };
  comparisons: SaturationComparison[];
  selectedCeiling: SaturationCeiling;
  selectionReason: "threshold" | "fallback";
}

export const DEFAULT_SATURATION_BOOTSTRAP_SAMPLES = 10_000;
export const SATURATION_PRACTICAL_GAIN_THRESHOLD = 0.02;

const CAPS = [2, 4, 8, 12] as const;
const PAIRS = [
  [2, 4],
  [4, 8],
  [8, 12],
] as const;
const CAPSULE_COUNT = 4;
const SEEDS_PER_CAPSULE = 5;
const MARGINAL_PERCENTILE = 0.75;
const CONFIDENCE_LEVEL = 0.9;

interface InternalDelta extends SaturationDelta {
  numericValue: number;
}

function isSaturationCap(value: number): value is SaturationCap {
  return value === 2 || value === 4 || value === 8 || value === 12;
}


function compareCell(a: SaturationCell, b: SaturationCell): number {
  const capsuleOrder = a.capsuleId < b.capsuleId ? -1 : a.capsuleId > b.capsuleId ? 1 : 0;
  if (capsuleOrder !== 0) return capsuleOrder;
  if (a.cap !== b.cap) return a.cap - b.cap;
  return a.seed - b.seed;
}


function validateOptions(options: SaturationCeilingOptions): number {
  if (!Number.isInteger(options.rngSeed) || options.rngSeed < 0 || options.rngSeed > 0xffff_ffff) {
    throw new Error(`saturation: rngSeed must be a uint32, got ${options.rngSeed}`);
  }
  const samples = options.bootstrapSamples ?? DEFAULT_SATURATION_BOOTSTRAP_SAMPLES;
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new Error(`saturation: bootstrapSamples must be a positive safe integer, got ${samples}`);
  }
  return samples;
}

function indexCells(
  cells: readonly SaturationCell[],
): Map<string, Map<SaturationCap, Map<number, SaturationCell>>> {
  if (cells.length !== CAPSULE_COUNT * CAPS.length * SEEDS_PER_CAPSULE) {
    throw new Error(`saturation: expected exactly 80 cells, got ${cells.length}`);
  }

  const index = new Map<string, Map<SaturationCap, Map<number, SaturationCell>>>();
  for (const cell of cells) {
    if (typeof cell.capsuleId !== "string" || cell.capsuleId.length === 0) {
      throw new Error("saturation: capsuleId must be a non-empty string");
    }
    if (!isSaturationCap(cell.cap)) throw new Error(`saturation: unsupported cap ${cell.cap}`);
    if (!Number.isSafeInteger(cell.seed)) throw new Error(`saturation: seed must be a safe integer, got ${cell.seed}`);
    if (cell.status === "valid") {
      if (!Number.isFinite(cell.normalizedGain)) {
        throw new Error(
          `saturation: normalized gain must be finite for ${cell.capsuleId}/cap-${cell.cap}/seed-${cell.seed}`,
        );
      }
    } else if (cell.status !== "invalid" && cell.status !== "incomplete") {
      throw new Error(`saturation: unsupported cell status for ${cell.capsuleId}/cap-${cell.cap}/seed-${cell.seed}`);
    }

    let byCap = index.get(cell.capsuleId);
    if (byCap === undefined) {
      byCap = new Map();
      index.set(cell.capsuleId, byCap);
    }
    let bySeed = byCap.get(cell.cap);
    if (bySeed === undefined) {
      bySeed = new Map();
      byCap.set(cell.cap, bySeed);
    }
    if (bySeed.has(cell.seed)) {
      throw new Error(`saturation: duplicate cell for ${cell.capsuleId}/cap-${cell.cap}/seed-${cell.seed}`);
    }
    bySeed.set(cell.seed, cell);
  }

  if (index.size !== CAPSULE_COUNT) {
    throw new Error(`saturation: expected exactly 4 capsules, got ${index.size}`);
  }
  for (const [capsuleId, byCap] of index) {
    const cap2Seeds = byCap.get(2);
    if (cap2Seeds === undefined || cap2Seeds.size !== SEEDS_PER_CAPSULE) {
      throw new Error(`saturation: ${capsuleId}/cap-2 must contain exactly 5 seeds`);
    }
    const matchedSeeds = [...cap2Seeds.keys()].sort((a, b) => a - b);
    for (const cap of CAPS) {
      const capSeeds = byCap.get(cap);
      if (capSeeds === undefined || capSeeds.size !== SEEDS_PER_CAPSULE) {
        throw new Error(`saturation: ${capsuleId}/cap-${cap} must contain exactly 5 seeds`);
      }
      const seeds = [...capSeeds.keys()].sort((a, b) => a - b);
      if (seeds.some((seed, i) => seed !== matchedSeeds[i])) {
        throw new Error(`saturation: ${capsuleId}/cap-${cap} does not use the five matched seeds`);
      }
    }
  }
  return index;
}

function encodeStatistic(value: number): SaturationStatistic {
  if (value === Number.NEGATIVE_INFINITY) return "negative-infinity";
  return Object.is(value, -0) ? 0 : value;
}

/** Empirical nearest-rank quantile. Sorts its scratch array in place to avoid an allocation per bootstrap draw. */
function nearestRank(values: number[], percentile: number): number {
  if (values.length === 0) throw new Error("saturation: cannot take a quantile of an empty sample");
  values.sort((a, b) => a - b);
  const value = values[Math.ceil(percentile * values.length) - 1];
  if (value === undefined) throw new Error("saturation: internal quantile index inconsistency");
  return value;
}

/** Fixed, local uint32 PRNG. Its output is stable and it never reads ambient entropy. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function pairedDelta(
  lower: SaturationCell,
  upper: SaturationCell,
  lowerCap: SaturationCap,
  upperCap: SaturationCeiling,
): InternalDelta {
  let numericValue: number;
  let source: SaturationDelta["source"];

  if (upper.status !== "valid") {
    /*
     * Frozen failure convention: an invalid or incomplete DEEPER cell gets a
     * delta of -Infinity. It is never omitted, imputed from a mutable observed
     * minimum, or converted to zero. -Infinity is the exact most pessimistic
     * value for deepening and therefore can only move the trusted ceiling
     * shallow-ward. Reports encode it losslessly as "negative-infinity" because
     * JSON has no numeric infinity.
     */
    numericValue = Number.NEGATIVE_INFINITY;
    source = "invalid-deeper";
  } else if (lower.status !== "valid") {
    /*
     * The same failed cell was the deeper endpoint of the preceding pair.
     * Reusing it as +Infinity here could reverse its penalty and increase the
     * selected ceiling. Keep the unpaired contrast at -Infinity so a failure
     * can never become evidence for deeper execution through the next pair.
     */
    numericValue = Number.NEGATIVE_INFINITY;
    source = "invalid-shallower";
  } else {
    numericValue = upper.normalizedGain - lower.normalizedGain;
    if (Object.is(numericValue, -0)) numericValue = 0;
    source = "observed";
  }

  return {
    capsuleId: upper.capsuleId,
    seed: upper.seed,
    lowerCap,
    upperCap,
    lowerStatus: lower.status,
    upperStatus: upper.status,
    value: encodeStatistic(numericValue),
    source,
    numericValue,
  };
}

function bootstrapUpperBound(
  strata: readonly (readonly number[])[],
  samples: number,
  random: () => number,
): number {
  const statisticSamples = new Array<number>(samples);
  const draw = new Array<number>(CAPSULE_COUNT * SEEDS_PER_CAPSULE);
  for (let sample = 0; sample < samples; sample += 1) {
    let offset = 0;
    for (const stratum of strata) {
      for (let seed = 0; seed < SEEDS_PER_CAPSULE; seed += 1) {
        const value = stratum[Math.floor(random() * stratum.length)];
        if (value === undefined) throw new Error("saturation: internal bootstrap stratum inconsistency");
        draw[offset] = value;
        offset += 1;
      }
    }
    statisticSamples[sample] = nearestRank(draw, MARGINAL_PERCENTILE);
  }
  return nearestRank(statisticSamples, CONFIDENCE_LEVEL);
}

/**
 * Applies the frozen M2 ceiling rule to exactly 4 capsules × 4 caps × 5
 * matched seeds. The function is pure: it copies/sorts input and uses only the
 * explicitly seeded local PRNG for bootstrap resampling.
 */
export function selectSaturationCeiling(
  cells: readonly SaturationCell[],
  options: SaturationCeilingOptions,
): SaturationCeilingReport {
  const bootstrapSamples = validateOptions(options);
  const index = indexCells(cells);
  const capsuleIds = [...index.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const random = mulberry32(options.rngSeed);
  const internalDeltas: InternalDelta[] = [];
  const comparisons: SaturationComparison[] = [];

  for (const [lowerCap, upperCap] of PAIRS) {
    const strata: number[][] = [];
    for (const capsuleId of capsuleIds) {
      const byCap = index.get(capsuleId);
      const lowerBySeed = byCap?.get(lowerCap);
      const upperBySeed = byCap?.get(upperCap);
      if (lowerBySeed === undefined || upperBySeed === undefined) {
        throw new Error("saturation: internal cap index inconsistency");
      }
      const seeds = [...lowerBySeed.keys()].sort((a, b) => a - b);
      const stratum: number[] = [];
      for (const seed of seeds) {
        const lower = lowerBySeed.get(seed);
        const upper = upperBySeed.get(seed);
        if (lower === undefined || upper === undefined) {
          throw new Error("saturation: internal matched-seed index inconsistency");
        }
        const delta = pairedDelta(lower, upper, lowerCap, upperCap);
        internalDeltas.push(delta);
        stratum.push(delta.numericValue);
      }
      strata.push(stratum);
    }

    const percentile75 = nearestRank(strata.flat(), MARGINAL_PERCENTILE);
    const upperConfidenceBound90 = bootstrapUpperBound(strata, bootstrapSamples, random);
    comparisons.push({
      lowerCap,
      upperCap,
      percentile75: encodeStatistic(percentile75),
      upperConfidenceBound90: encodeStatistic(upperConfidenceBound90),
      qualifies: upperConfidenceBound90 < SATURATION_PRACTICAL_GAIN_THRESHOLD,
    });
  }

  const firstQualified = comparisons.find((comparison) => comparison.qualifies);
  const selectedCeiling = firstQualified?.upperCap ?? 12;
  return {
    rule: {
      capsuleCount: 4,
      seedsPerCapsule: 5,
      caps: CAPS,
      adjacentPairs: PAIRS,
      marginalPercentile: 0.75,
      confidenceLevel: 0.9,
      practicalGainThreshold: 0.02,
      quantileMethod: "nearest-rank",
      confidenceMethod: "bootstrap-percentile-upper-bound",
      invalidDeeperConvention: "negative-infinity",
      invalidShallowerConvention: "negative-infinity",
    },
    cells: cells
      .map<SaturationCell>((cell) =>
        cell.status === "valid"
          ? {
              capsuleId: cell.capsuleId,
              cap: cell.cap,
              seed: cell.seed,
              status: cell.status,
              normalizedGain: cell.normalizedGain,
            }
          : { capsuleId: cell.capsuleId, cap: cell.cap, seed: cell.seed, status: cell.status },
      )
      .sort(compareCell),
    deltas: internalDeltas.map(({ numericValue: _numericValue, ...delta }) => delta),
    bootstrap: {
      method: "stratified-seed-resampling-within-capsule",
      rng: "mulberry32-v1",
      rngSeed: options.rngSeed,
      samples: bootstrapSamples,
    },
    comparisons,
    selectedCeiling,
    selectionReason: firstQualified === undefined ? "fallback" : "threshold",
  };
}

/** Canonical pretty JSON for freezing directly into campaign configuration evidence. */
export function saturationCeilingReportJson(
  cells: readonly SaturationCell[],
  options: SaturationCeilingOptions,
): string {
  return JSON.stringify(selectSaturationCeiling(cells, options), null, 2);
}
