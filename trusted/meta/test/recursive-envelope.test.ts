import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  M2DevelopmentPanel,
  M2_PANEL_A_TASK_IDS,
  M2_PANEL_B_TASK_IDS,
  M2RecursiveBudgets,
  MetaSearchTrajectoryV2,
  type BudgetEnvelope,
  type M2PanelTaskId,
  type M2RecursiveBudgets as M2RecursiveBudgetsType,
} from "@hone/schema";
import { describe, expect, test } from "vitest";
import {
  MetaEnvelopeFileRecordPortV1,
  MetaResourceEnvelopeLedger,
  buildMetaCandidateTrajectoryPoints,
  type MetaEnvelopeAllocationRecord,
  type MetaEnvelopeRecordPort,
  type TrustedMetaCandidateEvent,
} from "../src/index.js";

const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` as const;

const unitBudget: BudgetEnvelope = {
  maxTokens: 1,
  maxUsd: 1,
  maxWallClockSec: 1,
  maxEvaluatorInvocations: 1,
};

function budgets(searchDimension = 120): M2RecursiveBudgetsType {
  return M2RecursiveBudgets.parse({
    search: {
      identity: { envelopeId: digest("search-envelope"), purpose: "search" },
      calibratedPanelCandidate: {
        maxTokens: searchDimension / 12,
        maxUsd: searchDimension / 12,
        maxWallClockSec: searchDimension / 12,
        maxEvaluatorInvocations: searchDimension / 12,
      },
      outerTrajectory: {
        maxTokens: searchDimension,
        maxUsd: searchDimension,
        maxWallClockSec: searchDimension,
        maxEvaluatorInvocations: searchDimension,
      },
    },
    confirmation: {
      identity: { envelopeId: digest("confirmation-envelope"), purpose: "confirmation" },
      budget: { maxTokens: 80, maxUsd: 80, maxWallClockSec: 80, maxEvaluatorInvocations: 80 },
    },
    terminal: {
      identity: { envelopeId: digest("terminal-envelope"), purpose: "terminal" },
      budget: { maxTokens: 90, maxUsd: 90, maxWallClockSec: 90, maxEvaluatorInvocations: 90 },
    },
  });
}

class MemoryRecords implements MetaEnvelopeRecordPort {
  readonly rows: MetaEnvelopeAllocationRecord[];

  constructor(initial: readonly MetaEnvelopeAllocationRecord[] = []) {
    this.rows = [...structuredClone(initial)];
  }

  readAll(): readonly unknown[] {
    return structuredClone(this.rows);
  }

  append(record: MetaEnvelopeAllocationRecord): void {
    this.rows.push(structuredClone(record));
  }
}

function reservation(
  reservationId: string,
  reserved: BudgetEnvelope,
  parentReservationId: string | null = null,
) {
  return { reservationId, parentReservationId, reserved };
}

function panel(panelId: "A" | "B") {
  const taskIds = panelId === "A" ? M2_PANEL_A_TASK_IDS : M2_PANEL_B_TASK_IDS;
  return {
    panel: panelId,
    members: taskIds.map((taskId, index) => ({
      taskId: taskId as M2PanelTaskId,
      capsule: {
        capsuleId: `cap_${(index + (panelId === "A" ? 1 : 101)).toString(16).padStart(12, "0")}`,
        capsuleDigest: digest(`${panelId}:capsule:${index}`),
        image: `hone-${panelId.toLowerCase()}-${index}@${digest(`${panelId}:image:${index}`)}`,
        oracleDigest: digest(`${panelId}:oracle:${index}`),
        scalarizerDigest: digest(`${panelId}:scalarizer:${index}`),
        qFail: 0,
        qBase: 0.25,
        qReference: 0.75,
        scale: 0.5,
      },
      calibratedInnerCeiling: { ...unitBudget },
    })),
  };
}

const usage = (value: number) => ({
  tokens: value,
  usd: value,
  wallClockSec: value,
  evaluatorInvocations: value,
});

const reserved = (value: number): BudgetEnvelope => ({
  maxTokens: value,
  maxUsd: value,
  maxWallClockSec: value,
  maxEvaluatorInvocations: value,
});

describe("M2 frozen development panels", () => {
  test("round-trips exact heterogeneous Panel A and Panel B capsule identities", () => {
    for (const panelId of ["A", "B"] as const) {
      const input = panel(panelId);
      const parsed = M2DevelopmentPanel.parse(input);
      expect(parsed).toEqual(input);
      expect(parsed.members.map((member) => member.taskId)).toEqual(
        panelId === "A" ? M2_PANEL_A_TASK_IDS : M2_PANEL_B_TASK_IDS,
      );
      expect(new Set(parsed.members.map((member) => member.capsule.capsuleId)).size).toBe(8);
      expect(new Set(parsed.members.map((member) => member.capsule.capsuleDigest)).size).toBe(8);
      expect(new Set(parsed.members.map((member) => member.capsule.image)).size).toBe(8);
    }
  });

  test("rejects a duplicate capsule identity and a task from the other frozen panel", () => {
    const input = panel("A");
    input.members[1]!.capsule = structuredClone(input.members[0]!.capsule);
    input.members[2]!.taskId = "OWN-T02";
    expect(() => M2DevelopmentPanel.parse(input)).toThrow(/duplicated|not a frozen Panel-A task|missing/);
  });
});

describe("M2 recursive envelope schema", () => {
  test("requires every outer trajectory component to equal twelve calibrated panel candidates", () => {
    for (const dimension of [
      "maxTokens",
      "maxUsd",
      "maxWallClockSec",
      "maxEvaluatorInvocations",
    ] as const) {
      const input = budgets();
      input.search.outerTrajectory[dimension] += 1;
      expect(M2RecursiveBudgets.safeParse(input).success).toBe(false);
    }
  });

  test("requires distinct search, confirmation, and terminal envelope identities", () => {
    const input = budgets();
    input.terminal.identity.envelopeId = input.confirmation.identity.envelopeId;
    expect(() => M2RecursiveBudgets.parse(input)).toThrow(/distinct identities/);
  });
});

describe("trusted componentwise envelope ledger", () => {
  test("fails closed when any one search component exceeds the trajectory envelope", () => {
    for (const dimension of [
      "maxTokens",
      "maxUsd",
      "maxWallClockSec",
      "maxEvaluatorInvocations",
    ] as const) {
      const request = reserved(1);
      request[dimension] = 121;
      const ledger = new MetaResourceEnvelopeLedger(budgets(), new MemoryRecords());
      expect(() => ledger.reserveSearchDescendant(reservation(`too-much-${dimension}`, request))).toThrow(
        new RegExp(dimension),
      );
    }
  });


  test("does not let exhausted search borrow confirmation or terminal resources", () => {
    const ledger = new MetaResourceEnvelopeLedger(budgets(), new MemoryRecords());
    const search = ledger.reserveSearchDescendant(reservation("all-search", reserved(120)));
    const confirmation = ledger.reserveConfirmationDescendant(
      reservation("confirmation-work", reserved(20)),
    );
    const terminal = ledger.reserveTerminalDescendant(reservation("terminal-work", reserved(20)));

    expect(search.envelope.purpose).toBe("search");
    expect(confirmation.envelope.purpose).toBe("confirmation");
    expect(terminal.envelope.purpose).toBe("terminal");
    expect(() => ledger.reserveSearchDescendant(reservation("borrow-attempt", reserved(1)))).toThrow(
      /search envelope maxTokens exceeded/,
    );
  });

  test("returns unused capacity only after durable settlement and replays identities idempotently", () => {
    const records = new MemoryRecords();
    const ledger = new MetaResourceEnvelopeLedger(budgets(), records);
    const request = reservation("candidate-7", reserved(100));
    expect(ledger.reserveSearchDescendant(request).settled).toBe(false);
    expect(ledger.reserveSearchDescendant(request).reservationId).toBe("candidate-7");
    expect(records.rows).toHaveLength(1);
    expect(() => ledger.reserveSearchDescendant(reservation("before-settlement", reserved(21)))).toThrow();
    expect(() => ledger.reserveSearchDescendant(reservation("candidate-7", reserved(99)))).toThrow(
      /conflicting reservation replay/,
    );

    ledger.settleDescendant("candidate-7", usage(50));
    expect(records.rows).toHaveLength(2);
    expect(ledger.reserveSearchDescendant(reservation("after-settlement", reserved(70))).settled).toBe(false);

    const replayed = new MetaResourceEnvelopeLedger(budgets(), new MemoryRecords(records.rows));
    expect(replayed.remainingSearch()).toEqual(reserved(0));
    expect(replayed.reservation("candidate-7")).toMatchObject({ settled: true, observed: usage(50) });
  });

  test("durably replays reservations and settlements from an owner-only record file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hone-envelope-records-"));
    const file = join(dir, "envelopes.ndjson");
    const ledgerId = digest("durable-envelope-ledger");
    try {
      const port = MetaEnvelopeFileRecordPortV1.open(file, ledgerId);
      const ledger = new MetaResourceEnvelopeLedger(budgets(), port);
      ledger.reserveSearchDescendant(reservation("durable-candidate", reserved(100)));
      ledger.settleDescendant("durable-candidate", usage(50));
      port.close();

      const replayPort = MetaEnvelopeFileRecordPortV1.open(file, ledgerId);
      const replayed = new MetaResourceEnvelopeLedger(budgets(), replayPort);
      expect(replayed.remainingSearch()).toEqual(reserved(70));
      expect(replayed.reservation("durable-candidate")).toMatchObject({ settled: true });
      replayPort.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reserves nested slices from ancestors, forbids depth 3, and settles children first", () => {
    const ledger = new MetaResourceEnvelopeLedger(budgets(), new MemoryRecords());
    ledger.reserveSearchDescendant(reservation("depth-1", reserved(100)));
    ledger.reserveSearchDescendant(reservation("depth-2", reserved(60), "depth-1"));
    expect(() => ledger.reserveSearchDescendant(reservation("depth-3", reserved(1), "depth-2"))).toThrow(
      /depth 2/,
    );
    expect(() => ledger.settleDescendant("depth-1", usage(60))).toThrow(/before descendant/);
    ledger.settleDescendant("depth-2", usage(40));
    expect(() => ledger.reserveSearchDescendant(reservation("sibling-too-large", reserved(61), "depth-1"))).toThrow(
      /search envelope maxTokens exceeded/,
    );
    ledger.reserveSearchDescendant(reservation("depth-2-sibling", reserved(60), "depth-1"));
    ledger.settleDescendant("depth-2-sibling", usage(50));
    expect(() => ledger.settleDescendant("depth-1", usage(89))).toThrow(/below settled descendant spend/);
    expect(ledger.settleDescendant("depth-1", usage(90))).toMatchObject({ settled: true });
  });
});

describe("M2 candidate trajectory evidence", () => {
  test("derives panel means, incumbents, and spend from unordered trusted events and authenticated children", () => {
    const developmentPanel = M2DevelopmentPanel.parse(panel("A"));
    const capsuleIds = developmentPanel.members.map((member) => member.capsule.capsuleId);
    const candidate1 = digest("candidate-1");
    const candidate2 = digest("candidate-2");
    const child = (
      candidateOrdinal: 1 | 2,
      capsuleId: string,
      index: number,
      normalizedScore: number,
    ) => ({
      workKey: digest(`work:${candidateOrdinal}:${capsuleId}`),
      childRunId: `child-${candidateOrdinal}-${index}`,
      sourceArtifact: candidateOrdinal === 1 ? candidate1 : candidate2,
      capsuleId,
      replicate: 0,
      measurementEpoch: `epoch-${candidateOrdinal}-${index}`,
      status: "completed" as const,
      qRaw: normalizedScore,
      qBase: 0,
      scale: 1,
      qNormalized: normalizedScore,
      observed: usage(candidateOrdinal),
      evidenceHash: digest(`evidence:${candidateOrdinal}:${capsuleId}`),
      eventLogHash: digest(`events:${candidateOrdinal}:${capsuleId}`),
      points: [],
    });
    const candidate1Children = capsuleIds.map((capsuleId, index) =>
      child(1, capsuleId, index, index + 1));
    const candidate2Children = capsuleIds.map((capsuleId, index) =>
      child(2, capsuleId, index, 0));
    const children = [...candidate2Children, ...candidate1Children];
    const events: TrustedMetaCandidateEvent[] = [
      {
        candidateOrdinal: 2,
        eventCursor: 30,
        candidateArtifact: candidate2,
        childRunIds: candidate2Children.map((row) => row.childRunId),
        controllerSpent: usage(3),
      },
      {
        candidateOrdinal: 0,
        eventCursor: 10,
        candidateArtifact: null,
        childRunIds: [],
        controllerSpent: usage(1),
      },
      {
        candidateOrdinal: 1,
        eventCursor: 20,
        candidateArtifact: candidate1,
        childRunIds: candidate1Children.map((row) => row.childRunId),
        controllerSpent: usage(2),
      },
    ];

    const points = buildMetaCandidateTrajectoryPoints(capsuleIds, events, children, 2);
    expect(points.map((point) => point.candidateOrdinal)).toEqual([0, 1, 2]);
    expect(points.map((point) => point.valid)).toEqual([false, true, true]);
    expect(points.map((point) => point.panelMean)).toEqual([null, 4.5, 0]);
    expect(points.map((point) => point.bestSoFarPanelMean)).toEqual([null, 4.5, 4.5]);
    expect(points.map((point) => point.evaluationSpent)).toEqual([usage(0), usage(8), usage(16)]);
    expect(points.map((point) => point.cumulativeSpent)).toEqual([usage(1), usage(11), usage(30)]);
    expect(points[0]!.perCapsule).toHaveLength(8);

    const trajectory = {
      version: 2,
      configHash: digest("config"),
      outerRunId: "outer-1",
      searchEnvelope: budgets().search.identity,
      panel: developmentPanel,
      controllerBundleDigest: digest("controller"),
      targetSourceArtifact: digest("target-source"),
      targetBundleDigest: digest("target-bundle"),
      createdAt: "2026-07-18T00:00:00.000Z",
      outerEventLogHash: digest("outer-events"),
      points,
      children,
    };
    expect(() => MetaSearchTrajectoryV2.parse(trajectory)).not.toThrow();

    const forgedScore = structuredClone(trajectory);
    forgedScore.points[1]!.perCapsule[0]!.normalizedScore = 999;
    expect(() => MetaSearchTrajectoryV2.parse(forgedScore)).toThrow(/authenticated child aggregation/);
    const forgedSpend = structuredClone(trajectory);
    forgedSpend.points[1]!.evaluationSpent.tokens = 0;
    expect(() => MetaSearchTrajectoryV2.parse(forgedSpend)).toThrow(/authenticated child spend/);
  });

  test("rejects omitted or cursor-reassigned candidate events", () => {
    const developmentPanel = M2DevelopmentPanel.parse(panel("A"));
    const capsuleIds = developmentPanel.members.map((member) => member.capsule.capsuleId);
    const events: TrustedMetaCandidateEvent[] = [
      {
        candidateOrdinal: 1,
        eventCursor: 10,
        candidateArtifact: null,
        childRunIds: [],
        controllerSpent: usage(1),
      },
    ];
    expect(() => buildMetaCandidateTrajectoryPoints(capsuleIds, events, [], 1)).toThrow(
      /incomplete|expected 0/,
    );
  });
});
