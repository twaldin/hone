import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MetaSearchTrajectoryV1,
  canonicalJson,
  type AnytimeSearchPointV1,
  type MetaCampaignConfig,
  type MetaChildTrajectoryV1,
  type MetaOuterTrajectoryPointV1,
} from "@hone/schema";
import {
  type MetaFailureSettlement,
  type MetaMeasurement,
  type MetaResourceUsage,
  type Sha256Digest,
} from "@hone/meta";
import type { MetaJournalV1 } from "./meta-journal.js";
import { EVENTS_FILE, readEvents, writeFileDurable } from "./eventlog.js";
import { runsRoot } from "./runs.js";

const ZERO_USAGE: Readonly<MetaResourceUsage> = {
  tokens: 0,
  usd: 0,
  wallClockSec: 0,
  evaluatorInvocations: 0,
};

interface PersistMetaSearchTrajectoryOptions {
  root: string;
  campaignDir: string;
  outerRunId: string;
  configHash: Sha256Digest;
  config: MetaCampaignConfig;
  journal: MetaJournalV1;
}

type SearchSettlement = MetaMeasurement | MetaFailureSettlement;

type MutablePoint = {
  ordinal: number;
  eventCursor: number;
  episode: number | null;
  candidateArtifact: Sha256Digest | null;
  status: "evaluated" | "invalid";
  score: number | null;
  bestScore: number | null;
  cached: boolean | null;
  spent: MetaResourceUsage;
};

function sha256(bytes: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function addUsage(left: MetaResourceUsage, right: MetaResourceUsage): MetaResourceUsage {
  return {
    tokens: left.tokens + right.tokens,
    usd: left.usd + right.usd,
    wallClockSec: left.wallClockSec + right.wallClockSec,
    evaluatorInvocations: left.evaluatorInvocations + right.evaluatorInvocations,
  };
}

function sumUsage(rows: readonly SearchSettlement[]): MetaResourceUsage {
  return rows.reduce<MetaResourceUsage>((sum, row) => addUsage(sum, row.observed), { ...ZERO_USAGE });
}

export function extractAnytimePoints(events: ReturnType<typeof readEvents>): AnytimeSearchPointV1[] {
  const points: MutablePoint[] = [];
  const byEpisode = new Map<number, MutablePoint>();
  const pending = new Set<MutablePoint>();
  let baseline: MutablePoint | null = null;
  let lastSpent: MetaResourceUsage = { ...ZERO_USAGE };

  const episodePoint = (episode: number, cursor: number): MutablePoint => {
    const existing = byEpisode.get(episode);
    if (existing !== undefined) return existing;
    const point: MutablePoint = {
      ordinal: points.length,
      eventCursor: cursor,
      episode,
      candidateArtifact: null,
      status: "invalid",
      score: null,
      bestScore: null,
      cached: null,
      spent: { ...lastSpent },
    };
    byEpisode.set(episode, point);
    points.push(point);
    return point;
  };

  for (const [cursor, event] of events.entries()) {
    if (event.type === "episode.started") {
      episodePoint(event.episode, cursor);
      continue;
    }
    if (event.type === "episode.candidate") {
      const point = episodePoint(event.episode, cursor);
      point.eventCursor = cursor;
      point.candidateArtifact = event.candidate.hash as Sha256Digest;
      continue;
    }
    if (event.type === "episode.invalid") {
      const point = episodePoint(event.episode, cursor);
      point.eventCursor = cursor;
      point.status = "invalid";
      point.score = null;
      point.cached = null;
      pending.add(point);
      continue;
    }
    if (event.type === "eval.completed") {
      let point: MutablePoint;
      if (event.episode === undefined) {
        if (baseline !== null) continue;
        baseline = {
          ordinal: 0,
          eventCursor: cursor,
          episode: null,
          candidateArtifact: event.artifact.hash as Sha256Digest,
          status: "evaluated",
          score: event.aggregate,
          bestScore: null,
          cached: event.cached,
          spent: { ...lastSpent },
        };
        points.unshift(baseline);
        for (const [ordinal, current] of points.entries()) current.ordinal = ordinal;
        point = baseline;
      } else {
        point = episodePoint(event.episode, cursor);
        point.candidateArtifact = event.artifact.hash as Sha256Digest;
      }
      point.eventCursor = cursor;
      point.status = "evaluated";
      point.score = event.aggregate;
      point.cached = event.cached;
      pending.add(point);
      continue;
    }
    if (event.type === "budget.snapshot") {
      lastSpent = { ...event.budget.spent };
      for (const point of pending) point.spent = { ...lastSpent };
      pending.clear();
    }
  }
  for (const point of pending) point.spent = { ...lastSpent };

  let best: number | null = null;
  return points.map((point, ordinal) => {
    if (point.status === "evaluated" && point.score !== null) best = best === null ? point.score : Math.max(best, point.score);
    return {
      ...point,
      ordinal,
      bestScore: best,
    };
  });
}

function childExecutionDir(root: string, childRunId: string): string | null {
  const base = join(runsRoot(root), childRunId);
  const retry = join(runsRoot(root), `${childRunId}.retry1`);
  if (existsSync(join(retry, EVENTS_FILE))) return retry;
  if (existsSync(join(base, EVENTS_FILE))) return base;
  return null;
}

function childTrajectory(root: string, settlement: SearchSettlement): MetaChildTrajectoryV1 {
  const runDir = childExecutionDir(root, settlement.childRunId);
  const eventPath = runDir === null ? null : join(runDir, EVENTS_FILE);
  const eventBytes = eventPath !== null && existsSync(eventPath) ? readFileSync(eventPath) : null;
  const events = runDir === null ? [] : readEvents(runDir);
  const completed = "qNormalized" in settlement;
  return {
    workKey: settlement.workKey,
    childRunId: settlement.childRunId,
    sourceArtifact: settlement.sourceArtifact,
    capsuleId: settlement.capsuleId,
    replicate: settlement.replicate,
    measurementEpoch: settlement.measurementEpoch,
    status: completed ? "completed" : settlement.status,
    qRaw: completed ? settlement.qRaw : null,
    qBase: completed ? settlement.qBase : null,
    scale: completed ? settlement.scale : null,
    qNormalized: completed ? settlement.qNormalized : null,
    observed: { ...settlement.observed },
    evidenceHash: settlement.evidenceHash,
    eventLogHash: eventBytes === null ? null : sha256(eventBytes),
    points: extractAnytimePoints(events),
  };
}

/** Materialize one deterministic, replay-derived outer+inner trajectory evidence file. */
export function persistMetaSearchTrajectory(opts: PersistMetaSearchTrajectoryOptions): string {
  const outerRunDir = join(runsRoot(opts.root), opts.outerRunId);
  const outerEventPath = join(outerRunDir, EVENTS_FILE);
  if (!existsSync(outerEventPath)) throw new Error(`outer event log is missing for ${opts.outerRunId}`);
  const outerEventBytes = readFileSync(outerEventPath);
  const outerEvents = readEvents(outerRunDir);
  const started = outerEvents.find((event) => event.type === "run.started");
  if (started === undefined || !/^sha256:[0-9a-f]{64}$/.test(started.optimizerDigest)) {
    throw new Error("outer trajectory has no sealed controller optimizer digest");
  }

  const settlements: SearchSettlement[] = [
    ...opts.journal.queryTrainMeasurements().filter((row) => row.phase === "search"),
    ...opts.journal.queryFailureSettlements().filter((row) => row.phase === "search"),
  ];
  settlements.sort((left, right) =>
    left.sourceArtifact.localeCompare(right.sourceArtifact)
    || left.capsuleId.localeCompare(right.capsuleId)
    || left.replicate - right.replicate,
  );
  const children = settlements.map((settlement) => childTrajectory(opts.root, settlement));
  const childrenByArtifact = new Map<string, MetaChildTrajectoryV1[]>();
  for (const child of children) {
    const rows = childrenByArtifact.get(child.sourceArtifact) ?? [];
    rows.push(child);
    childrenByArtifact.set(child.sourceArtifact, rows);
  }

  let cumulativeEvaluationSpent: MetaResourceUsage = { ...ZERO_USAGE };
  const chargedArtifacts = new Set<string>();
  const outerPoints: MetaOuterTrajectoryPointV1[] = extractAnytimePoints(outerEvents).map((point) => {
    const artifact = point.candidateArtifact;
    const childRows = artifact === null ? [] : childrenByArtifact.get(artifact) ?? [];
    const firstCharge = artifact !== null && !chargedArtifacts.has(artifact);
    if (artifact !== null) chargedArtifacts.add(artifact);
    const evaluationSpent = firstCharge
      ? sumUsage(settlements.filter((row) => row.sourceArtifact === artifact))
      : { ...ZERO_USAGE };
    cumulativeEvaluationSpent = addUsage(cumulativeEvaluationSpent, evaluationSpent);
    const perCapsule = Object.fromEntries(opts.config.train.map((capsule) => {
      const rows = childRows.filter((row) => row.capsuleId === capsule.capsuleId && row.qNormalized !== null);
      const value = rows.length === 0 ? null : rows.reduce((sum, row) => sum + (row.qNormalized ?? 0), 0) / rows.length;
      return [capsule.capsuleId, value];
    }));
    return {
      ...point,
      perCapsule,
      childRunIds: childRows.map((row) => row.childRunId).sort(),
      evaluationSpent,
      cumulativeEvaluationSpent: { ...cumulativeEvaluationSpent },
    };
  });
  if (outerPoints.length === 0) throw new Error("outer trajectory contains no baseline or candidate observation");

  const lastEvent = outerEvents[outerEvents.length - 1];
  if (lastEvent === undefined) throw new Error("outer event log is empty");
  const trajectory = MetaSearchTrajectoryV1.parse({
    version: 1,
    configHash: opts.configHash,
    outerRunId: opts.outerRunId,
    controllerBundleDigest: started.optimizerDigest,
    targetSourceArtifact: opts.config.seedOptimizer.sourceArtifact,
    targetBundleDigest: opts.config.seedOptimizer.bundleDigest,
    createdAt: lastEvent.at,
    outerEventLogHash: sha256(outerEventBytes),
    points: outerPoints,
    children,
  });
  const outputPath = join(opts.campaignDir, "search-trajectory.v1.json");
  writeFileDurable(outputPath, `${canonicalJson(trajectory)}\n`);
  chmodSync(outputPath, 0o600);
  return outputPath;
}
