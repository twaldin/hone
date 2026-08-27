import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ChildRunLaunchReceipt,
  MetaSearchTrajectoryV1,
  MetaSearchTrajectoryV2,
  canonicalJson,
  type AnytimeSearchPointV1,
  type MetaCampaignConfig,
  type MetaChildTrajectoryV1,
  type MetaOuterTrajectoryPointV1,
  type RunEvent,
} from "@hone/schema";
import {
  buildMetaCandidateTrajectoryPoints,
  type MetaFailureSettlement,
  type MetaMeasurement,
  type MetaResourceUsage,
  type Sha256Digest,
  type TrustedMetaCandidateEvent,
} from "@hone/meta";
import type { MetaJournalV1 } from "./meta-journal.js";
import { EVENTS_FILE, readEvents, replayRun, writeFileDurable } from "./eventlog.js";
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

export function trajectoryCampaignJournals(
  config: Pick<MetaCampaignConfig, "sourceMigrationJournal" | "imageRepinJournal">,
): {
  sourceMigrationJournal?: MetaCampaignConfig["sourceMigrationJournal"];
  imageRepinJournal?: MetaCampaignConfig["imageRepinJournal"];
} {
  return {
    ...(config.sourceMigrationJournal === undefined
      ? {}
      : { sourceMigrationJournal: config.sourceMigrationJournal }),
    ...(config.imageRepinJournal === undefined
      ? {}
      : { imageRepinJournal: config.imageRepinJournal }),
  };
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

export function controllerSpendDelta(
  current: MetaResourceUsage,
  prior: MetaResourceUsage,
  candidateOrdinal: number,
): MetaResourceUsage {
  const delta: MetaResourceUsage = {
    tokens: current.tokens - prior.tokens,
    usd: current.usd - prior.usd,
    wallClockSec: current.wallClockSec - prior.wallClockSec,
    evaluatorInvocations: current.evaluatorInvocations - prior.evaluatorInvocations,
  };
  if (Object.values(delta).some((value) => value < 0)) {
    throw new Error(`candidate ordinal ${candidateOrdinal} regresses trusted controller spend`);
  }
  return delta;
}
export interface FailedSearchTrajectoryPersistence {
  readonly exitCode: number;
  readonly persistenceError: string | null;
}

/**
 * A partial trajectory is useful failure evidence, but it is secondary to the
 * optimizer/Broker failure that stopped the run. Never let evidence
 * materialization replace that primary replay signal on the CLI boundary.
 */
export function persistTrajectoryWithoutMaskingSearchFailure(
  exitCode: number,
  persist: () => void,
): FailedSearchTrajectoryPersistence {
  if (!Number.isInteger(exitCode) || exitCode === 0) {
    throw new Error(`failed search persistence requires a nonzero integer exit code, got ${exitCode}`);
  }
  try {
    persist();
    return { exitCode, persistenceError: null };
  } catch (error) {
    return {
      exitCode,
      persistenceError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function extractAnytimePoints(events: readonly RunEvent[]): AnytimeSearchPointV1[] {
  const points: MutablePoint[] = [];
  const byEpisode = new Map<number, MutablePoint>();
  const pending = new Set<MutablePoint>();
  const trustedEvaluationPoints = new Set<MutablePoint>();
  let baseline: MutablePoint | null = null;
  let lastSpent: MetaResourceUsage = { ...ZERO_USAGE };
  let activeEpisode: number | null = null;

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
  const candidatePoint = (
    episode: number,
    cursor: number,
    artifact: Sha256Digest,
  ): MutablePoint => {
    const current = episodePoint(episode, cursor);
    // Candidate bytes and their immutable lineage episode are not an attempt
    // identity. A failed panel can be retried byte-for-byte without another
    // episode.candidate event; each trusted evaluation occurrence must
    // therefore advance to its own point after the prior point settles.
    if (
      current.candidateArtifact === null
      || (
        current.candidateArtifact === artifact
        && !trustedEvaluationPoints.has(current)
      )
    ) {
      return current;
    }
    const point: MutablePoint = {
      ordinal: points.length,
      eventCursor: cursor,
      episode,
      candidateArtifact: artifact,
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
      activeEpisode = event.episode;
      continue;
    }
    if (event.type === "episode.completed") {
      if (activeEpisode === event.episode) activeEpisode = null;
      continue;
    }
    if (event.type === "episode.candidate") {
      const artifact = event.candidate.hash as Sha256Digest;
      const point = candidatePoint(event.episode, cursor, artifact);
      point.eventCursor = cursor;
      point.candidateArtifact = artifact;
      // Trusted strategy evaluations are intentionally emitted without an
      // episode field. `episode.candidate` is the durable episode binding and
      // occurs before the following budget snapshot, so charge that snapshot
      // to this point. Without this, a refused/null panel kept the stale
      // episode-start spend and made a later valid monotonicity guard report a
      // false controller-spend regression.
      pending.add(point);
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
        if (baseline === null) {
          baseline = {
            ordinal: 0,
            eventCursor: cursor,
            episode: null,
            candidateArtifact: event.artifact.hash as Sha256Digest,
            status: event.aggregate === null ? "invalid" : "evaluated",
            score: event.aggregate,
            bestScore: null,
            cached: event.cached,
            spent: { ...lastSpent },
          };
          points.unshift(baseline);
          for (const [ordinal, current] of points.entries()) current.ordinal = ordinal;
          point = baseline;
        } else {
          // A retried seed panel is a distinct admission even though its
          // source artifact is unchanged. Keep it separate from the episode's
          // later saved candidate so the two candidate ordinals cannot
          // overwrite one another. Other unscoped records are comparator
          // probes and do not mint trajectory candidates.
          if (activeEpisode === null) continue;
          const artifact = event.artifact.hash as Sha256Digest;
          const hasEligiblePoint = points.some(
            (candidatePoint) =>
              candidatePoint.candidateArtifact === artifact
              && candidatePoint.status === "evaluated",
          );
          if (
            hasEligiblePoint
            || baseline.candidateArtifact !== artifact
            || baseline.status !== "invalid"
          ) {
            continue;
          }
          point = {
            ordinal: points.length,
            eventCursor: cursor,
            episode: activeEpisode,
            candidateArtifact: artifact,
            status: event.aggregate === null ? "invalid" : "evaluated",
            score: event.aggregate,
            bestScore: null,
            cached: event.cached,
            spent: { ...lastSpent },
          };
          points.push(point);
        }
      } else {
        const artifact = event.artifact.hash as Sha256Digest;
        point = candidatePoint(event.episode, cursor, artifact);
        point.candidateArtifact = artifact;
      }
      point.eventCursor = cursor;
      point.status = event.aggregate === null ? "invalid" : "evaluated";
      point.score = event.aggregate;
      point.cached = event.cached;
      trustedEvaluationPoints.add(point);
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

  const ordered = baseline === null
    ? [...points].sort((left, right) => left.eventCursor - right.eventCursor)
    : [
        baseline,
        ...points
          .filter((point) => point !== baseline)
          .sort((left, right) => left.eventCursor - right.eventCursor),
      ];
  let best: number | null = null;
  return ordered.map((point, ordinal) => {
    if (point.status === "evaluated" && point.score !== null) best = best === null ? point.score : Math.max(best, point.score);
    return {
      ...point,
      ordinal,
      bestScore: best,
    };
  });
}

export interface RecursiveCandidateOuterGroup {
  artifact: Sha256Digest;
  childRunIds: string[];
}

/** Bind every durable candidate admission, including retried null panels, to trusted outer events in order. */
export function bindRecursiveOuterEvents(
  grouped: ReadonlyMap<number, RecursiveCandidateOuterGroup>,
  outerEvents: readonly RunEvent[],
): TrustedMetaCandidateEvent[] {
  if (grouped.size === 0) throw new Error("recursive trajectory has no durable spawnRun candidate admissions");
  const terminalCandidateOrdinal = Math.max(...grouped.keys());
  const outerPoints = extractAnytimePoints(outerEvents);
  const events: TrustedMetaCandidateEvent[] = [];
  let priorCursor = -1;
  let priorControllerSpent: MetaResourceUsage = { ...ZERO_USAGE };
  for (let candidateOrdinal = 0; candidateOrdinal <= terminalCandidateOrdinal; candidateOrdinal += 1) {
    const group = grouped.get(candidateOrdinal);
    if (group === undefined) {
      throw new Error(`recursive trajectory is missing candidate ordinal ${candidateOrdinal}`);
    }
    const outerPoint = outerPoints.find(
      (point) => point.eventCursor > priorCursor && point.candidateArtifact === group.artifact,
    );
    if (outerPoint === undefined) {
      throw new Error(`candidate ordinal ${candidateOrdinal} has no matching trusted outer event`);
    }
    const controllerSpent = controllerSpendDelta(
      outerPoint.spent,
      priorControllerSpent,
      candidateOrdinal,
    );
    priorCursor = outerPoint.eventCursor;
    priorControllerSpent = { ...outerPoint.spent };
    events.push({
      candidateOrdinal,
      eventCursor: outerPoint.eventCursor,
      candidateArtifact: group.artifact,
      childRunIds: [...group.childRunIds].sort(),
      controllerSpent,
    });
  }
  return events;
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
function persistRecursiveTrajectory(
  opts: PersistMetaSearchTrajectoryOptions,
  controllerBundleDigest: Sha256Digest,
  outerEventBytes: Buffer,
  outerEvents: ReturnType<typeof readEvents>,
  children: readonly MetaChildTrajectoryV1[],
): string {
  if (opts.config.version !== 2) throw new Error("recursive trajectory requires a V2 config");
  const grouped = new Map<number, { artifact: Sha256Digest; childRunIds: string[] }>();
  for (const entry of readdirSync(opts.campaignDir)) {
    if (!entry.startsWith("child-launch-") || !entry.endsWith(".json")) continue;
    const receipt = ChildRunLaunchReceipt.parse(JSON.parse(readFileSync(join(opts.campaignDir, entry), "utf8")));
    const schedule = receipt.child.schedule;
    if (schedule === undefined || receipt.child.purpose !== "capsule") continue;
    const sourceArtifact = receipt.child.sourceArtifact.hash as Sha256Digest;
    const current = grouped.get(schedule.candidateOrdinal);
    if (current !== undefined && current.artifact !== sourceArtifact) {
      throw new Error(`candidate ordinal ${schedule.candidateOrdinal} maps to multiple source artifacts`);
    }
    const group = current ?? { artifact: sourceArtifact, childRunIds: [] };
    if (group.childRunIds.includes(receipt.child.runId)) {
      throw new Error(`candidate ordinal ${schedule.candidateOrdinal} duplicates child ${receipt.child.runId}`);
    }
    group.childRunIds.push(receipt.child.runId);
    grouped.set(schedule.candidateOrdinal, group);
  }
  const events = bindRecursiveOuterEvents(grouped, outerEvents);
  const terminalCandidateOrdinal = Math.max(...grouped.keys());
  const points = buildMetaCandidateTrajectoryPoints(
    opts.config.developmentPanel.members.map((member) => member.capsule.capsuleId),
    events,
    children,
    terminalCandidateOrdinal,
  );
  const lastEvent = outerEvents[outerEvents.length - 1];
  if (lastEvent === undefined) throw new Error("outer event log is empty");
  const trajectory = MetaSearchTrajectoryV2.parse({
    version: 2,
    configHash: opts.configHash,
    ...trajectoryCampaignJournals(opts.config),
    outerRunId: opts.outerRunId,
    searchEnvelope: opts.config.recursiveBudgets.search.identity,
    panel: opts.config.developmentPanel,
    controllerBundleDigest,
    targetSourceArtifact: opts.config.seedOptimizer.sourceArtifact,
    targetBundleDigest: opts.config.seedOptimizer.bundleDigest,
    createdAt: lastEvent.at,
    outerEventLogHash: sha256(outerEventBytes),
    points,
    children,
  });
  const outputPath = join(opts.campaignDir, "search-trajectory.v2.json");
  writeFileDurable(outputPath, `${canonicalJson(trajectory)}\n`);
  chmodSync(outputPath, 0o600);
  return outputPath;
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
  const effectiveControllerDigest = replayRun(outerRunDir).optimizerDigest;
  if (
    effectiveControllerDigest === null
    || !/^sha256:[0-9a-f]{64}$/.test(effectiveControllerDigest)
  ) {
    throw new Error("outer trajectory has no effective sealed controller optimizer digest");
  }
  if (
    opts.config.version === 2
    && opts.config.sourceMigrationJournal?.migrations.some(
      (migration) => migration.optimizerRefreeze !== undefined,
    ) === true
    && effectiveControllerDigest !== opts.config.controllerOptimizer.bundleDigest
  ) {
    throw new Error("outer trajectory controller optimizer does not match the journaled campaign head");
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
  if (opts.config.version === 2) {
    return persistRecursiveTrajectory(
      opts,
      effectiveControllerDigest as Sha256Digest,
      outerEventBytes,
      outerEvents,
      children,
    );
  }
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
    ...trajectoryCampaignJournals(opts.config),
    outerRunId: opts.outerRunId,
    controllerBundleDigest: effectiveControllerDigest,
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
