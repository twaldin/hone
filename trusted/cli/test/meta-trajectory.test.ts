import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashChildRunLaunchReceipt } from "@hone/broker";
import { campaignImageRepinRecordDigest, metaCampaignConfigHash } from "@hone/meta";
import {
  ChildRunLaunchReceipt,
  MetaCampaignConfigV1,
  M2_PANEL_A_TASK_IDS,
  MetaCampaignConfigV2,
  RunEvent,
  canonicalJson,
  type BudgetState,
  type ChildRunLaunchReceipt as ChildRunLaunchReceiptShape,
  type MetaCampaignConfigV1 as LegacyConfig,
  type MetaCampaignConfigV2 as RecursiveConfig,
} from "@hone/schema";
import { describe, expect, it } from "vitest";
import { appendEvent } from "../src/eventlog.js";
import { MetaJournalV1 } from "../src/meta-journal.js";
import {
  bindRecursiveOuterEvents,
  controllerSpendDelta,
  extractAnytimePoints,
  persistMetaSearchTrajectory,
  type RecursiveCandidateOuterGroup,
  persistTrajectoryWithoutMaskingSearchFailure,
} from "../src/meta-trajectory.js";
import { makeRoot } from "./helpers.js";
import { syntheticFrozenCampaign } from "./support/synthetic-campaign.js";
const hash = `sha256:${"a".repeat(64)}` as RecursiveCandidateOuterGroup["artifact"];
const candidate = `sha256:${"b".repeat(64)}`;
const at = "2026-07-15T00:00:00.000Z";
const envelope = { maxTokens: 100, maxUsd: 1, maxWallClockSec: 100, maxEvaluatorInvocations: 10 };

function budget(tokens: number): BudgetState {
  return {
    envelope,
    spent: { tokens, usd: 0, wallClockSec: tokens, evaluatorInvocations: tokens === 0 ? 0 : 1 },
  };
}

describe("meta recursive trajectory extraction", () => {

const legacyFixturePath = fileURLToPath(new URL(
  "../../../schema/fixtures/meta-campaign.m1.json",
  import.meta.url,
));

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function repinLegacy(config: LegacyConfig): LegacyConfig {
  const capsule = config.train[0]!;
  const toImage = `hone-repinned@${digest("trajectory:v1:image")}`;
  const body = {
    version: 1,
    at: "2026-08-27T02:40:00.000Z",
    capsuleId: capsule.capsuleId,
    fromImage: capsule.image,
    toImage,
    evidencePath: "trajectory-equivalence.v1.json",
    evidenceSha256: digest("trajectory:v1:evidence"),
    reason: "trajectory V1 provenance",
    previousRecordDigest: null,
  } as const;
  return MetaCampaignConfigV1.parse({
    ...config,
    train: config.train.map((entry) => (
      entry.capsuleId === capsule.capsuleId ? { ...entry, image: toImage } : entry
    )),
    imageRepinJournal: {
      version: 1,
      campaignConfigHash: metaCampaignConfigHash(config),
      repins: [{ ...body, recordDigest: campaignImageRepinRecordDigest(body) }],
    },
  });
}

function repinRecursive(config: RecursiveConfig): RecursiveConfig {
  const capsule = config.train[0]!;
  const toImage = `hone-repinned@${digest("trajectory:v2:image")}`;
  const body = {
    version: 1,
    at: "2026-08-27T02:41:00.000Z",
    capsuleId: capsule.capsuleId,
    fromImage: capsule.image,
    toImage,
    evidencePath: "trajectory-equivalence.v2.json",
    evidenceSha256: digest("trajectory:v2:evidence"),
    reason: "trajectory V2 provenance",
    previousRecordDigest: null,
  } as const;
  return MetaCampaignConfigV2.parse({
    ...config,
    train: config.train.map((entry) => (
      entry.capsuleId === capsule.capsuleId ? { ...entry, image: toImage } : entry
    )),
    developmentPanel: {
      ...config.developmentPanel,
      members: config.developmentPanel.members.map((member) => ({
        ...member,
        capsule: member.capsule.capsuleId === capsule.capsuleId
          ? { ...member.capsule, image: toImage }
          : member.capsule,
      })),
    },
    imageRepinJournal: {
      version: 1,
      campaignConfigHash: metaCampaignConfigHash(config),
      repins: [{ ...body, recordDigest: campaignImageRepinRecordDigest(body) }],
    },
  });
}

function writeOuterEvents(
  root: string,
  runId: string,
  envelope: BudgetState["envelope"],
  candidateArtifact?: `sha256:${string}`,
): void {
  const runDir = join(root, ".hone-runs", runId);
  mkdirSync(runDir, { recursive: true });
  appendEvent(runDir, {
    runId,
    at,
    type: "run.started",
    capsuleId: "cap_trajectory0000",
    contractHash: digest("trajectory:contract"),
    optimizerDigest: digest("trajectory:optimizer"),
  });
  appendEvent(runDir, { runId, at, type: "budget.snapshot", budget: { envelope, spent: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 } } });
  appendEvent(runDir, { runId, at, type: "episode.started", episode: 0, parent: { hash } });
  appendEvent(runDir, { runId, at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: 0.2, cached: false });
  appendEvent(runDir, { runId, at, type: "budget.snapshot", budget: { envelope, spent: { tokens: 1, usd: 0, wallClockSec: 1, evaluatorInvocations: 1 } } });
  if (candidateArtifact !== undefined) {
    appendEvent(runDir, { runId, at, type: "episode.candidate", episode: 0, candidate: { hash: candidateArtifact }, sessionTrace: digest("trajectory:trace") });
    appendEvent(runDir, { runId, at, type: "eval.completed", episode: 0, artifact: { hash: candidateArtifact }, assetGroupId: "train", seed: 0, aggregate: null, cached: false });
    appendEvent(runDir, { runId, at, type: "budget.snapshot", budget: { envelope, spent: { tokens: 2, usd: 0, wallClockSec: 2, evaluatorInvocations: 2 } } });
  }
}
  it("keeps the first unscoped evaluation as baseline and ignores later promotion probes", () => {
    const events = [
      RunEvent.parse({ runId: "run", at, type: "run.started", capsuleId: "cap", contractHash: hash, optimizerDigest: hash }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(0) }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 0, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: 0.2, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(5) }),
      RunEvent.parse({ runId: "run", at, type: "episode.candidate", episode: 0, candidate: { hash: candidate }, sessionTrace: hash }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", episode: 0, artifact: { hash: candidate }, assetGroupId: "train", seed: 0, aggregate: 0.4, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(15) }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash: candidate }, assetGroupId: "train", seed: 0, aggregate: 0.1, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(20) }),
      RunEvent.parse({ runId: "run", at, type: "run.finished", best: { hash: candidate }, status: "completed" }),
    ];

    expect(extractAnytimePoints(events)).toEqual([
      {
        ordinal: 0,
        eventCursor: 3,
        episode: null,
        candidateArtifact: hash,
        status: "evaluated",
        score: 0.2,
        bestScore: 0.2,
        cached: false,
        spent: { tokens: 5, usd: 0, wallClockSec: 5, evaluatorInvocations: 1 },
      },
      {
        ordinal: 1,
        eventCursor: 6,
        episode: 0,
        candidateArtifact: candidate,
        status: "evaluated",
        score: 0.4,
        bestScore: 0.4,
        cached: false,
        spent: { tokens: 15, usd: 0, wallClockSec: 15, evaluatorInvocations: 1 },
      },
    ]);
  });

  it("attributes Campaign-8's unscoped refused panel spend before continuing to the next episode", () => {
    const candidate0 = `sha256:${"6".repeat(64)}`;
    const candidate1 = `sha256:${"2".repeat(64)}`;
    const incidentEnvelope = {
      maxTokens: 5_000_000,
      maxUsd: 25,
      maxWallClockSec: 200_000,
      maxEvaluatorInvocations: 30,
    };
    const snapshot = (
      tokens: number,
      wallClockSec: number,
      evaluatorInvocations: number,
    ): BudgetState => ({
      envelope: incidentEnvelope,
      spent: { tokens, usd: 0, wallClockSec, evaluatorInvocations },
    });
    const events = [
      RunEvent.parse({ runId: "run", at, type: "run.started", capsuleId: "cap", contractHash: hash, optimizerDigest: hash }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: snapshot(0, 0, 0) }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 0, parent: { hash } }),
      // Production trusted-strategy evaluations are unscoped. The schema
      // therefore exposes this first one as the special baseline point.
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: 0.2, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "episode.candidate", episode: 0, candidate: { hash: candidate0 }, sessionTrace: hash }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: snapshot(183_548, 8_303.412, 2) }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 0 }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 1, parent: { hash: candidate0 } }),
      // Campaign-8 emitted the next unscoped comparison before binding its
      // failed candidate. It is not a second baseline and must not steal the
      // candidate's following snapshot.
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash: candidate0 }, assetGroupId: "train", seed: 0, aggregate: null, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "episode.candidate", episode: 1, candidate: { hash: candidate1 }, sessionTrace: hash }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: snapshot(240_000, 16_414.125, 4) }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 1 }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 2, parent: { hash: candidate0 } }),
    ];

    const points = extractAnytimePoints(events);
    expect(points.map((point) => [point.episode, point.candidateArtifact, point.spent])).toEqual([
      [null, hash, snapshot(183_548, 8_303.412, 2).spent],
      [0, candidate0, snapshot(183_548, 8_303.412, 2).spent],
      [1, candidate1, snapshot(240_000, 16_414.125, 4).spent],
      [2, null, snapshot(240_000, 16_414.125, 4).spent],
    ]);
    expect(points.map((point) => point.status)).toEqual([
      "evaluated",
      "invalid",
      "invalid",
      "invalid",
    ]);
    expect(points[2]).toMatchObject({
      episode: 1,
      candidateArtifact: candidate1,
      status: "invalid",
      score: null,
    });
    expect(controllerSpendDelta(points[1]!.spent, points[0]!.spent, 1)).toEqual({
      tokens: 0,
      usd: 0,
      wallClockSec: 0,
      evaluatorInvocations: 0,
    });
    expect(events.some((event) => event.type === "episode.completed" && event.episode === 0)).toBe(true);
    expect(events.some((event) => event.type === "episode.started" && event.episode === 1)).toBe(true);
    expect(events.some((event) => event.type === "episode.completed" && event.episode === 1)).toBe(true);
    expect(events.some((event) => event.type === "episode.started" && event.episode === 2)).toBe(true);
    const historicallyMaskedPrimary = persistTrajectoryWithoutMaskingSearchFailure(1, () => {
      controllerSpendDelta(
        snapshot(0, 0, 0).spent,
        snapshot(183_548, 16_227.713, 2).spent,
        1,
      );
    });
    expect(historicallyMaskedPrimary).toEqual({
      exitCode: 1,
      persistenceError: "candidate ordinal 1 regresses trusted controller spend",
    });

    const correctedReentry = persistTrajectoryWithoutMaskingSearchFailure(1, () => {
      controllerSpendDelta(points[2]!.spent, points[1]!.spent, 1);
    });
    expect(correctedReentry).toEqual({ exitCode: 1, persistenceError: null });
    expect(() => persistTrajectoryWithoutMaskingSearchFailure(0, () => {})).toThrow(
      /requires a nonzero integer exit code/,
    );
  });

  it("orders a successful seed retry before the new candidate saved later in the same episode", () => {
    const events = [
      RunEvent.parse({ runId: "run", at, type: "run.started", capsuleId: "cap", contractHash: hash, optimizerDigest: hash }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(0) }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 0, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: null, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(10) }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 0 }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 1, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 1, aggregate: 0.5, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(20) }),
      RunEvent.parse({ runId: "run", at, type: "episode.candidate", episode: 1, candidate: { hash: candidate }, sessionTrace: hash }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", episode: 1, artifact: { hash: candidate }, assetGroupId: "train", seed: 1, aggregate: 0.8, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(30) }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 1 }),
    ];

    const candidates = extractAnytimePoints(events).filter((point) => point.candidateArtifact !== null);

    expect(candidates.map((point) => point.candidateArtifact)).toEqual([hash, hash, candidate]);
    expect(candidates.map((point) => point.eventCursor)).toEqual([3, 7, 10]);
    expect(candidates.map((point) => point.bestScore)).toEqual([null, 0.5, 0.8]);
  });

  it("binds repeated null panels to distinct trusted ordinals instead of crashing at ordinal zero", () => {
    const events = [
      RunEvent.parse({ runId: "run", at, type: "run.started", capsuleId: "cap", contractHash: hash, optimizerDigest: hash }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(0) }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 0, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: null, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(10) }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 0 }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 1, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 1, aggregate: null, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(20) }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 1 }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 2, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 2, aggregate: null, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(30) }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 2 }),
      RunEvent.parse({ runId: "run", at, type: "run.finished", best: { hash }, status: "completed" }),
    ];
    const grouped = new Map<number, RecursiveCandidateOuterGroup>([
      [0, { artifact: hash, childRunIds: ["child-0"] }],
      [1, { artifact: hash, childRunIds: ["child-1"] }],
      [2, { artifact: hash, childRunIds: ["child-2"] }],
    ]);

    const bound = bindRecursiveOuterEvents(grouped, events);

    expect(bound.map((event) => event.candidateOrdinal)).toEqual([0, 1, 2]);
    expect(bound.map((event) => event.eventCursor)).toEqual([3, 7, 11]);
    expect(bound.map((event) => event.candidateArtifact)).toEqual([hash, hash, hash]);
    expect(bound.map((event) => event.childRunIds)).toEqual([["child-0"], ["child-1"], ["child-2"]]);
    expect(extractAnytimePoints(events).filter((point) => point.candidateArtifact === hash))
      .toHaveLength(3);
  });

  it("binds a byte-identical failed-panel retry by trusted event occurrence rather than immutable lineage", () => {
    const repeated = `sha256:${"c".repeat(64)}` as RecursiveCandidateOuterGroup["artifact"];
    const events = [
      RunEvent.parse({ runId: "run", at, type: "run.started", capsuleId: "cap", contractHash: hash, optimizerDigest: hash }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 0, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: 0.5, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "episode.candidate", episode: 0, candidate: { hash: repeated }, sessionTrace: hash }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", episode: 0, artifact: { hash: repeated }, assetGroupId: "train", seed: 0, aggregate: null, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 0 }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 1, parent: { hash } }),
      // A no-change repair has no new episode.candidate event and retains the
      // original lineage tag, but the launcher assigned it a fresh ordinal.
      RunEvent.parse({ runId: "run", at, type: "eval.completed", episode: 0, artifact: { hash: repeated }, assetGroupId: "train", seed: 1, aggregate: 0.7, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 1 }),
    ];
    const grouped = new Map<number, RecursiveCandidateOuterGroup>([
      [0, { artifact: hash, childRunIds: ["c-base"] }],
      [1, { artifact: repeated, childRunIds: ["c-first"] }],
      [2, { artifact: repeated, childRunIds: ["c-retry"] }],
    ]);

    const bound = bindRecursiveOuterEvents(grouped, events);

    expect(bound.map((event) => [
      event.candidateOrdinal,
      event.eventCursor,
      event.candidateArtifact,
      event.childRunIds,
    ])).toEqual([
      [0, 2, hash, ["c-base"]],
      [1, 4, repeated, ["c-first"]],
      [2, 7, repeated, ["c-retry"]],
    ]);
  });

  it("does not admit a later unscoped comparator after an eligible seed retry", () => {
    const events = [
      RunEvent.parse({ runId: "run", at, type: "run.started", capsuleId: "cap", contractHash: hash, optimizerDigest: hash }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 0, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 0, aggregate: null, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(10) }),
      RunEvent.parse({ runId: "run", at, type: "episode.completed", episode: 0 }),
      RunEvent.parse({ runId: "run", at, type: "episode.started", episode: 1, parent: { hash } }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 1, aggregate: 0.5, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(20) }),
      RunEvent.parse({ runId: "run", at, type: "eval.completed", artifact: { hash }, assetGroupId: "train", seed: 2, aggregate: 0.6, cached: false }),
      RunEvent.parse({ runId: "run", at, type: "budget.snapshot", budget: budget(30) }),
    ];

    const sourcePoints = extractAnytimePoints(events).filter(
      (point) => point.candidateArtifact === hash,
    );

    expect(sourcePoints.map((point) => [point.eventCursor, point.status, point.score])).toEqual([
      [2, "invalid", null],
      [6, "evaluated", 0.5],
    ]);
  });

  it("still refuses a genuine controller-spend regression", () => {
    expect(() => controllerSpendDelta(
      { tokens: 9, usd: 1, wallClockSec: 2, evaluatorInvocations: 1 },
      { tokens: 10, usd: 1, wallClockSec: 2, evaluatorInvocations: 1 },
      1,
    )).toThrow("candidate ordinal 1 regresses trusted controller spend");
  });

  it("persists the image re-pin journal in V1 trajectory evidence", () => {
    const root = makeRoot();
    const campaignDir = join(root, "campaign");
    mkdirSync(campaignDir, { recursive: true });
    const config = repinLegacy(MetaCampaignConfigV1.parse(JSON.parse(
      readFileSync(legacyFixturePath, "utf8"),
    )));
    const configHash = metaCampaignConfigHash(config);
    const outerRunId = "run_trajectory_v1";
    writeOuterEvents(root, outerRunId, config.budgets.outer);
    const journal = MetaJournalV1.open(join(campaignDir, "meta-journal.ndjson"), config);
    try {
      const output = persistMetaSearchTrajectory({
        root,
        campaignDir,
        outerRunId,
        configHash,
        config,
        journal,
      });
      const trajectory = JSON.parse(readFileSync(output, "utf8"));
      expect(trajectory.imageRepinJournal).toEqual(config.imageRepinJournal);
    } finally {
      journal.close();
    }
  });

  it("persists the image re-pin journal in recursive V2 trajectory evidence", () => {
    const root = makeRoot();
    const campaignDir = join(root, "campaign");
    mkdirSync(campaignDir, { recursive: true });
    const config = repinRecursive(syntheticFrozenCampaign());
    const trajectoryConfig = structuredClone(config);
    const usedTaskIds = new Set(
      trajectoryConfig.developmentPanel.members.map((member) => member.taskId),
    );
    for (let index = 6; index < 8; index += 1) {
      const capsule = config.holdout[index - 6]!;
      const taskId = M2_PANEL_A_TASK_IDS.find((candidate) => !usedTaskIds.has(candidate))!;
      usedTaskIds.add(taskId);
      trajectoryConfig.train.push(capsule);
      trajectoryConfig.developmentPanel.members.push({
        taskId,
        capsule,
        calibratedInnerCeiling: config.budgets.child,
      });
    }
    const configHash = metaCampaignConfigHash(config);
    const outerRunId = "run_trajectory_v2";
    const candidateArtifact = digest("trajectory:v2:candidate");
    writeOuterEvents(root, outerRunId, config.budgets.outer, candidateArtifact);

    const bundleDigest = digest("trajectory:v2:bundle");
    const identity = {
      phase: "search" as const,
      arm: "candidate" as const,
      sourceArtifact: candidateArtifact,
      bundleDigest,
      capsuleId: config.train[0]!.capsuleId,
      replicate: 0,
      measurementEpoch: "trajectory:v2:epoch",
    };
    const journal = MetaJournalV1.open(join(campaignDir, "meta-journal.ndjson"), config);
    const reservation = journal.reserveChild(identity, {
      purpose: "search",
      envelope: config.recursiveBudgets.search.identity,
      reservationId: "trajectory-v2-reservation",
      parentReservationId: null,
      reserved: config.budgets.child,
    });
    journal.settleChildFailure(identity, {
      evidenceHash: digest("trajectory:v2:failure"),
      observed: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
      status: "candidate_failed",
    });
    const childRunId = reservation.childRunId;
    const receiptBody: Omit<ChildRunLaunchReceiptShape, "receiptDigest"> = {
      child: {
        runId: childRunId,
        capsuleId: config.train[0]!.capsuleId,
        sourceArtifact: { hash: candidateArtifact },
        optimizerArtifact: { hash: bundleDigest },
        purpose: "capsule",
        schedule: {
          candidateOrdinal: 0,
          allocationOrdinal: 0,
          innerEpisodesMax: config.counts.innerEpisodesMax,
        },
      },
      depth: 1,
      admission: {
        campaignConfigHash: configHash,
        cohort: "panel-a",
        capsuleProvenanceHash: config.train[0]!.capsuleDigest,
        sourceProvenanceHash: candidateArtifact,
        optimizerProvenanceHash: bundleDigest,
      },
      launchedAt: "2026-08-27T02:42:00.000Z",
    };
    const receipt = ChildRunLaunchReceipt.parse({
      ...receiptBody,
      receiptDigest: hashChildRunLaunchReceipt(receiptBody),
    });
    writeFileSync(
      join(campaignDir, `child-launch-${childRunId}.json`),
      `${canonicalJson(receipt)}\n`,
    );

    try {
      const output = persistMetaSearchTrajectory({
        root,
        campaignDir,
        outerRunId,
        configHash,
        config: trajectoryConfig,
        journal,
      });
      const trajectory = JSON.parse(readFileSync(output, "utf8"));
      expect(trajectory.imageRepinJournal).toEqual(config.imageRepinJournal);
    } finally {
      journal.close();
    }
  });
});
