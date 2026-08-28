import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAMPAIGN_12_CALIBRATED_AT,
  CAMPAIGN_12_CALIBRATION_EVIDENCE_VERSION,
  CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V1,
} from "@hone/broker";

export const CAMPAIGN_12_RECLASSIFICATION_VERSION =
  "campaign-12-promotion-reclassification-v1" as const;
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
}

export type PromotionReclassification = "genuine" | "noise-attributable" | "indeterminate";

export interface ReclassifiedPromotion {
  runId: string;
  at: string;
  capsuleId: string;
  episode: number;
  artifactHash: string;
  parentScore: number | null;
  childScore: number | null;
  observedDelta: number | null;
  noiseEnvelope: number | null;
  classification: PromotionReclassification;
  survives: boolean;
  reasoning: string;
}

export interface PromotionReclassificationArtifact {
  version: typeof CAMPAIGN_12_RECLASSIFICATION_VERSION;
  createdFromImmutableEventsAtOrBefore: typeof CAMPAIGN_12_PROMOTION_CUTOFF;
  selectionProtocol: "run_meta events through fixed 149-gate observation cutoff";
  calibration: {
    evidenceVersion: typeof CAMPAIGN_12_CALIBRATION_EVIDENCE_VERSION;
    calibratedAt: typeof CAMPAIGN_12_CALIBRATED_AT;
  };
  input: {
    runsRoot: string;
    eventFiles: Array<{ path: string; sha256: string }>;
    observedLegacyGates: number;
  };
  summary: {
    totalPromotions: number;
    survive: number;
    insideNoiseEnvelope: number;
    indeterminate: number;
  };
  byCapsule: Record<string, {
    totalPromotions: number;
    survive: number;
    insideNoiseEnvelope: number;
    indeterminate: number;
  }>;
  promotions: ReclassifiedPromotion[];
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function classify(
  runId: string,
  capsuleId: string,
  incumbent: LegacyEvent,
  gate: LegacyEvent | undefined,
): ReclassifiedPromotion {
  const calibration = CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V1.find(
    (entry) => entry.capsuleId === capsuleId,
  );
  const parentScore = gate?.parentScore;
  const childScore = gate?.childScore;
  const delta = parentScore === undefined || childScore === undefined
    ? null
    : childScore - parentScore;
  const common = {
    runId,
    at: incumbent.at ?? "",
    capsuleId,
    episode: incumbent.episode ?? -1,
    artifactHash: incumbent.artifact?.hash ?? "",
    parentScore: parentScore ?? null,
    childScore: childScore ?? null,
    observedDelta: delta,
    noiseEnvelope: calibration?.noiseEnvelope ?? null,
  };
  if (gate === undefined || delta === null || calibration === undefined || !(delta > 0)) {
    return {
      ...common,
      classification: "indeterminate",
      survives: false,
      reasoning: gate === undefined
        ? "no preceding gate.paired event for this run and episode"
        : calibration === undefined
          ? "no identity-bound campaign-12 calibration for this capsule"
          : "legacy promotion does not carry a positive reconstructable paired delta",
    };
  }
  if (delta <= calibration.noiseEnvelope) {
    return {
      ...common,
      classification: "noise-attributable",
      survives: false,
      reasoning: `positive delta ${delta} is within the measured identical-artifact envelope ${calibration.noiseEnvelope}`,
    };
  }
  return {
    ...common,
    classification: "genuine",
    survives: true,
    reasoning: `positive delta ${delta} exceeds the measured identical-artifact envelope ${calibration.noiseEnvelope}`,
  };
}

/** Read-only derivation: this function never opens a campaign file for writing. */
export function deriveCampaign12PromotionReclassification(
  runsRootInput: string,
): PromotionReclassificationArtifact {
  const runsRoot = resolve(runsRootInput);
  const eventPaths = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_meta_"))
    .map((entry) => join(runsRoot, entry.name, "events.ndjson"))
    .filter((path) => existsSync(path))
    .sort();
  const eventFiles: Array<{ path: string; sha256: string }> = [];
  const promotions: ReclassifiedPromotion[] = [];
  let observedLegacyGates = 0;

  for (const eventPath of eventPaths) {
    const bytes = readFileSync(eventPath);
    eventFiles.push({ path: relative(runsRoot, eventPath), sha256: sha256(bytes) });
    const events = bytes.toString("utf8").split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LegacyEvent);
    const started = events.find((event) => event.type === "run.started");
    const capsuleId = started?.capsuleId;
    const runId = started?.runId ?? basename(eventPath);
    if (capsuleId === undefined) continue;
    const gateByEpisode = new Map<number, LegacyEvent>();
    for (const event of events) {
      if ((event.at ?? "") > CAMPAIGN_12_PROMOTION_CUTOFF) continue;
      if (event.type === "gate.paired" && event.episode !== undefined) {
        observedLegacyGates++;
        gateByEpisode.set(event.episode, event);
      } else if (event.type === "incumbent.new" && event.episode !== undefined) {
        promotions.push(classify(runId, capsuleId, event, gateByEpisode.get(event.episode)));
      }
    }
  }

  promotions.sort((left, right) =>
    left.at.localeCompare(right.at)
    || left.runId.localeCompare(right.runId)
    || left.episode - right.episode,
  );
  const byCapsule: PromotionReclassificationArtifact["byCapsule"] = {};
  for (const promotion of promotions) {
    const counts = byCapsule[promotion.capsuleId] ?? {
      totalPromotions: 0,
      survive: 0,
      insideNoiseEnvelope: 0,
      indeterminate: 0,
    };
    counts.totalPromotions++;
    if (promotion.classification === "genuine") counts.survive++;
    else if (promotion.classification === "noise-attributable") counts.insideNoiseEnvelope++;
    else counts.indeterminate++;
    byCapsule[promotion.capsuleId] = counts;
  }
  return {
    version: CAMPAIGN_12_RECLASSIFICATION_VERSION,
    createdFromImmutableEventsAtOrBefore: CAMPAIGN_12_PROMOTION_CUTOFF,
    selectionProtocol: "run_meta events through fixed 149-gate observation cutoff",
    calibration: {
      evidenceVersion: CAMPAIGN_12_CALIBRATION_EVIDENCE_VERSION,
      calibratedAt: CAMPAIGN_12_CALIBRATED_AT,
    },
    input: { runsRoot, eventFiles, observedLegacyGates },
    summary: {
      totalPromotions: promotions.length,
      survive: promotions.filter((promotion) => promotion.classification === "genuine").length,
      insideNoiseEnvelope: promotions.filter((promotion) => promotion.classification === "noise-attributable").length,
      indeterminate: promotions.filter((promotion) => promotion.classification === "indeterminate").length,
    },
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
