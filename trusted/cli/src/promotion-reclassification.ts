import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAMPAIGN_12_CALIBRATED_AT,
  CAMPAIGN_12_CALIBRATION_EVIDENCE_VERSION,
  CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3,
  campaign12PromotionNoiseCalibration,
} from "@hone/broker";
import { CapsuleManifest, capsuleDigest, type PromotionNoiseCalibration } from "@hone/schema";

export const CAMPAIGN_12_RECLASSIFICATION_VERSION =
  "campaign-12-promotion-reclassification-v3" as const;
export const CAMPAIGN_12_PROMOTION_CUTOFF = "2026-08-28T00:05:41.275Z" as const;

interface LegacyEvent {
  runId?: string;
  at?: string;
  type?: string;
  capsuleId?: string;
  episode?: number;
  parentScore?: number;
  childScore?: number;
  passed?: boolean;
  artifact?: { hash?: string };
  assetGroupId?: string;
}

interface BrokerEvalLine {
  t?: string;
  measurementEpoch?: string;
}

interface CampaignSession {
  capsuleImage?: string;
  executionImage?: string;
}

export type PromotionReclassification = "genuine" | "noise-attributable" | "indeterminate";
export type IndeterminateKind = "confidence" | "data-availability";

export interface ReclassifiedPromotion {
  runId: string;
  at: string;
  capsuleId: string;
  admittedCapsuleDigest: string;
  executionImage: string;
  measurementEpoch: string;
  assetGroupId: string | null;
  episode: number;
  artifactHash: string;
  parentScore: number | null;
  childScore: number | null;
  observedDelta: number | null;
  noiseFloor: number | null;
  noiseEnvelope: number | null;
  classification: PromotionReclassification;
  indeterminateKind: IndeterminateKind | null;
  survives: boolean;
  reasoning: string;
  sensitivityThresholds: {
    maxSpan: number;
    p99: number;
    threeSd: number;
    p95: number;
    twoSd: number;
    shipped4_5Sd: number;
  } | null;
}

interface Counts {
  totalPromotions: number;
  survive: number;
  insideNoiseFloor: number;
  indeterminate: number;
}

export interface PromotionReclassificationArtifact {
  version: typeof CAMPAIGN_12_RECLASSIFICATION_VERSION;
  createdFromImmutableEventsAtOrBefore: typeof CAMPAIGN_12_PROMOTION_CUTOFF;
  selectionProtocol: "run_meta events through fixed 149-gate observation cutoff";
  calibration: {
    evidenceVersion: typeof CAMPAIGN_12_CALIBRATION_EVIDENCE_VERSION;
    calibratedAt: typeof CAMPAIGN_12_CALIBRATED_AT;
    estimator: "identity-matched direct paired-delta SD; pooled score-SD fallback";
    noiseAtOrBelow: "2.121 paired-delta SD (or 3 pooled score SD)";
    confidenceIndeterminateThrough: "3.182 paired-delta SD (or 4.5 pooled score SD), tail-guarded by max observed delta";
  };
  input: {
    runsRoot: string;
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
    }>;
    observedLegacyGates: number;
  };
  summary: Counts;
  sensitivity: Record<"shipped4_5Sd" | "maxSpan" | "p99" | "threeSd" | "p95" | "twoSd", { survive: number; rejected: number }>;
  byCapsule: Record<string, Counts>;
  promotions: ReclassifiedPromotion[];
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseLines<T>(bytes: Buffer): T[] {
  return bytes.toString("utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}

function classify(
  runId: string,
  identity: {
    capsuleId: string;
    admittedCapsuleDigest: string;
    executionImage: string;
    measurementEpoch: string;
  },
  assetGroupId: string | undefined,
  incumbent: LegacyEvent,
  gate: LegacyEvent | undefined,
  calibration: PromotionNoiseCalibration | null,
): ReclassifiedPromotion {
  const evidence = CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3.find((entry) =>
    entry.capsuleId === identity.capsuleId
    && entry.admittedCapsuleDigest === identity.admittedCapsuleDigest
    && entry.executionImage === identity.executionImage
    && assetGroupId === entry.assetGroupId
    && entry.measurementEpochs.includes(identity.measurementEpoch)
  );
  const parentScore = gate?.parentScore;
  const childScore = gate?.childScore;
  const delta = parentScore === undefined || childScore === undefined
    ? null
    : childScore - parentScore;
  const common = {
    runId,
    at: incumbent.at ?? "",
    ...identity,
    assetGroupId: assetGroupId ?? null,
    episode: incumbent.episode ?? -1,
    artifactHash: incumbent.artifact?.hash ?? "",
    parentScore: parentScore ?? null,
    childScore: childScore ?? null,
    observedDelta: delta,
    noiseFloor: calibration?.noiseFloor ?? null,
    noiseEnvelope: calibration?.noiseEnvelope ?? null,
    sensitivityThresholds: evidence === undefined
      ? null
      : { ...evidence.sensitivityThresholds, shipped4_5Sd: evidence.noiseEnvelope },
  };
  if (gate === undefined || delta === null || calibration === null || evidence === undefined || !(delta > 0)) {
    return {
      ...common,
      classification: "indeterminate",
      indeterminateKind: "data-availability",
      survives: false,
      reasoning: gate === undefined
        ? "no preceding gate.paired event for this run and episode"
        : calibration === null || evidence === undefined
          ? "no full identity-bound campaign-12 calibration for this run"
          : "legacy promotion does not carry a positive reconstructable paired delta",
    };
  }
  if (delta <= calibration.noiseFloor) {
    return {
      ...common,
      classification: "noise-attributable",
      indeterminateKind: null,
      survives: false,
      reasoning: `positive delta ${delta} is at or below the 3-SD noise floor ${calibration.noiseFloor}`,
    };
  }
  if (delta <= calibration.noiseEnvelope) {
    return {
      ...common,
      classification: "indeterminate",
      indeterminateKind: "confidence",
      survives: false,
      reasoning: `positive delta ${delta} exceeds the 3-SD noise floor ${calibration.noiseFloor} but not the 4.5-SD confidence boundary ${calibration.noiseEnvelope}`,
    };
  }
  return {
    ...common,
    classification: "genuine",
    indeterminateKind: null,
    survives: true,
    reasoning: `positive delta ${delta} exceeds the 4.5-SD confidence boundary ${calibration.noiseEnvelope}`,
  };
}

function emptyCounts(): Counts {
  return { totalPromotions: 0, survive: 0, insideNoiseFloor: 0, indeterminate: 0 };
}

function addCount(counts: Counts, promotion: ReclassifiedPromotion): void {
  counts.totalPromotions++;
  if (promotion.classification === "genuine") counts.survive++;
  else if (promotion.classification === "noise-attributable") counts.insideNoiseFloor++;
  else counts.indeterminate++;
}

/** Read-only derivation: this function never opens a campaign file for writing. */
export function deriveCampaign12PromotionReclassification(
  runsRootInput: string,
): PromotionReclassificationArtifact {
  const runsRoot = resolve(runsRootInput);
  if (!existsSync(runsRoot)) throw new Error(`campaign evidence root does not exist: ${runsRoot}`);
  const runDirs = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_meta_"))
    .map((entry) => join(runsRoot, entry.name))
    .sort();
  const sourceFiles: PromotionReclassificationArtifact["input"]["sourceFiles"] = [];
  const promotions: ReclassifiedPromotion[] = [];
  let observedLegacyGates = 0;

  for (const runDir of runDirs) {
    const eventPath = join(runDir, "events.ndjson");
    const manifestPath = join(runDir, "capsule-manifest.json");
    const campaignSessionPath = join(runDir, "campaign-session.v1.json");
    const brokerStatePath = join(runDir, "broker-state.ndjson");
    if (
      !existsSync(eventPath)
      || !existsSync(manifestPath)
      || !existsSync(campaignSessionPath)
      || !existsSync(brokerStatePath)
    ) continue;
    const eventBytes = readFileSync(eventPath);
    const manifestBytes = readFileSync(manifestPath);
    const campaignSessionBytes = readFileSync(campaignSessionPath);
    const brokerBytes = readFileSync(brokerStatePath);
    const events = parseLines<LegacyEvent>(eventBytes);
    const manifest = CapsuleManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
    const session = JSON.parse(campaignSessionBytes.toString("utf8")) as CampaignSession;
    const executionImage = session.executionImage ?? session.capsuleImage;
    if (executionImage === undefined) throw new Error(`${runDir} has no executed capsule image receipt`);
    const epochs = new Set(
      parseLines<BrokerEvalLine>(brokerBytes)
        .filter((line) => line.t === "eval" && line.measurementEpoch !== undefined)
        .map((line) => line.measurementEpoch!),
    );
    if (epochs.size !== 1) throw new Error(`${runDir} has ${epochs.size} measurement epochs`);
    const measurementEpoch = [...epochs][0]!;
    const started = events.find((event) => event.type === "run.started");
    const capsuleId = started?.capsuleId;
    const runId = started?.runId ?? basename(runDir);
    if (capsuleId === undefined || capsuleId !== manifest.id) {
      throw new Error(`${runDir} run.started does not match its measured manifest`);
    }
    const identity = {
      capsuleId,
      admittedCapsuleDigest: capsuleDigest(manifest),
      executionImage,
      measurementEpoch,
    };
    sourceFiles.push({
      runId,
      eventsPath: relative(runsRoot, eventPath),
      eventsSha256: sha256(eventBytes),
      manifestPath: relative(runsRoot, manifestPath),
      manifestSha256: sha256(manifestBytes),
      campaignSessionPath: relative(runsRoot, campaignSessionPath),
      campaignSessionSha256: sha256(campaignSessionBytes),
      brokerStatePath: relative(runsRoot, brokerStatePath),
      brokerStateSha256: sha256(brokerBytes),
    });
    const gateByEpisode = new Map<number, LegacyEvent>();
    const assetGroupByEpisode = new Map<number, string>();
    for (const event of events) {
      if ((event.at ?? "") > CAMPAIGN_12_PROMOTION_CUTOFF) continue;
      if (event.type === "eval.completed" && event.episode !== undefined && event.assetGroupId !== undefined) {
        assetGroupByEpisode.set(event.episode, event.assetGroupId);
      } else if (event.type === "gate.paired" && event.episode !== undefined) {
        observedLegacyGates++;
        gateByEpisode.set(event.episode, event);
      } else if (event.type === "incumbent.new" && event.episode !== undefined) {
        const assetGroupId = assetGroupByEpisode.get(event.episode);
        const calibration = assetGroupId === undefined
          ? null
          : campaign12PromotionNoiseCalibration({ ...identity, assetGroupId });
        promotions.push(classify(
          runId,
          identity,
          assetGroupId,
          event,
          gateByEpisode.get(event.episode),
          calibration,
        ));
      }
    }
  }

  promotions.sort((left, right) =>
    left.at.localeCompare(right.at)
    || left.runId.localeCompare(right.runId)
    || left.episode - right.episode,
  );
  sourceFiles.sort((left, right) => left.runId.localeCompare(right.runId));
  const summary = emptyCounts();
  const byCapsule: PromotionReclassificationArtifact["byCapsule"] = {};
  for (const promotion of promotions) {
    addCount(summary, promotion);
    const counts = byCapsule[promotion.capsuleId] ?? emptyCounts();
    addCount(counts, promotion);
    byCapsule[promotion.capsuleId] = counts;
  }
  const sensitivity = {
    shipped4_5Sd: { survive: 0, rejected: 0 },
    maxSpan: { survive: 0, rejected: 0 },
    p99: { survive: 0, rejected: 0 },
    threeSd: { survive: 0, rejected: 0 },
    p95: { survive: 0, rejected: 0 },
    twoSd: { survive: 0, rejected: 0 },
  };
  for (const promotion of promotions) {
    for (const estimator of Object.keys(sensitivity) as Array<keyof typeof sensitivity>) {
      const threshold = promotion.sensitivityThresholds?.[estimator];
      if (promotion.observedDelta !== null && threshold !== undefined && promotion.observedDelta > threshold) {
        sensitivity[estimator].survive++;
      } else {
        sensitivity[estimator].rejected++;
      }
    }
  }
  return {
    version: CAMPAIGN_12_RECLASSIFICATION_VERSION,
    createdFromImmutableEventsAtOrBefore: CAMPAIGN_12_PROMOTION_CUTOFF,
    selectionProtocol: "run_meta events through fixed 149-gate observation cutoff",
    calibration: {
      evidenceVersion: CAMPAIGN_12_CALIBRATION_EVIDENCE_VERSION,
      calibratedAt: CAMPAIGN_12_CALIBRATED_AT,
      estimator: "identity-matched direct paired-delta SD; pooled score-SD fallback",
      noiseAtOrBelow: "2.121 paired-delta SD (or 3 pooled score SD)",
      confidenceIndeterminateThrough: "3.182 paired-delta SD (or 4.5 pooled score SD), tail-guarded by max observed delta",
    },
    input: { runsRoot, sourceFiles, observedLegacyGates },
    summary,
    sensitivity,
    byCapsule,
    promotions,
  };
}

export function writeCampaign12PromotionReclassification(runsRoot: string, outputPath: string): void {
  const artifact = deriveCampaign12PromotionReclassification(runsRoot);
  if (artifact.input.observedLegacyGates !== 149 || artifact.summary.totalPromotions !== 74) {
    throw new Error(
      `campaign-12 observation cohort mismatch: expected 149 gates/74 promotions, got ` +
        `${artifact.input.observedLegacyGates}/${artifact.summary.totalPromotions}`,
    );
  }
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const runsRoot = process.argv[2];
  const outputPath = process.argv[3];
  if (runsRoot === undefined || outputPath === undefined) {
    throw new Error("usage: promotion-reclassification.ts <campaign .hone-runs> <new output.json>");
  }
  writeCampaign12PromotionReclassification(runsRoot, outputPath);
}
