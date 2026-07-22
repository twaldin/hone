import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  M2_INNER_MODEL_ROUTE,
  M2_OUTER_MODEL_ROUTE,
  M2_PANEL_A_TASK_IDS,
  MetaCampaignConfigV1,
  MetaCampaignConfigV2,
  type BudgetEnvelope,
  type MetaCampaignConfigV1 as MetaCampaignConfig,
  type MetaCampaignConfigV2 as RecursiveConfig,
} from "@hone/schema";
import { describe, expect, it } from "vitest";
import {
  MetaJournalV1,
  metaCampaignConfigHash,
  type MetaResourceUsageV1,
  type MetaSha256DigestV1,
  type MetaSettlementInputV1,
  type MetaWorkIdentityV1,
} from "../src/meta-journal.js";

const fixturePath = fileURLToPath(new URL("../../../schema/fixtures/meta-campaign.m1.json", import.meta.url));

function config(): MetaCampaignConfig {
  return MetaCampaignConfigV1.parse(JSON.parse(readFileSync(fixturePath, "utf8")));
}
function recursiveConfig(): RecursiveConfig {
  const legacy = config();
  const capsule = (index: number) => ({
    ...legacy.train[0]!,
    capsuleId: `cap_${index.toString(16).padStart(12, "0")}`,
    capsuleDigest: digest(`recursive:capsule:${index}`),
    image: `hone-task-${index}@${digest(`recursive:image:${index}`)}`,
    oracleDigest: digest(`recursive:oracle:${index}`),
    scalarizerDigest: digest(`recursive:scalarizer:${index}`),
  });
  const train = Array.from({ length: 8 }, (_, index) => capsule(index + 1));
  const holdout = Array.from({ length: 12 }, (_, index) => capsule(index + 101));
  const child = { ...legacy.budgets.child };
  const multiply = (budget: BudgetEnvelope, factor: number): BudgetEnvelope => ({
    maxTokens: budget.maxTokens * factor,
    maxUsd: budget.maxUsd * factor,
    maxWallClockSec: budget.maxWallClockSec * factor,
    maxEvaluatorInvocations: budget.maxEvaluatorInvocations * factor,
  });
  const calibratedPanelCandidate = multiply(child, 8);
  const optimizer = {
    sourceCommit: "1".repeat(40),
    sourceArtifact: digest("recursive:target-source"),
    bundleDigest: digest("recursive:target-bundle"),
  };
  return MetaCampaignConfigV2.parse({
    ...legacy,
    version: 2,
    seedOptimizer: optimizer,
    controllerOptimizer: optimizer,
    optimizerRuntime: { image: `hone-optimizer@${digest("recursive:optimizer-image")}` },
    generation: {
      stage: "A",
      panel: "A",
      targetGeneration: 0,
      controllerGeneration: 0,
      outerReplicate: 0,
    },
    train,
    holdout,
    routing: {
      outerMutation: M2_OUTER_MODEL_ROUTE,
      innerMutation: M2_INNER_MODEL_ROUTE,
    },
    modelObservation: {
      outerRequestedRoute: M2_OUTER_MODEL_ROUTE,
      innerRequestedRoute: M2_INNER_MODEL_ROUTE,
      identity: "alias-observation",
      recordResponseModel: true,
      recordProviderFingerprint: true,
      driftSentinel: true,
    },
    counts: {
      candidates: 37,
      candidateAttemptsMax: 91,
      innerEpisodesMax: 8,
      searchReplicates: 5,
      confirmationReplicates: 3,
      holdoutReplicates: 3,
      childConcurrency: 2,
    },
    developmentPanel: {
      panel: "A",
      members: train.map((entry, index) => ({
        taskId: M2_PANEL_A_TASK_IDS[index],
        capsule: entry,
        calibratedInnerCeiling: child,
      })),
    },
    recursiveBudgets: {
      search: {
        identity: { envelopeId: digest("recursive:search-envelope"), purpose: "search" },
        calibratedPanelCandidate,
        outerTrajectory: multiply(calibratedPanelCandidate, 12),
      },
      confirmation: {
        identity: { envelopeId: digest("recursive:confirmation-envelope"), purpose: "confirmation" },
        budget: multiply(child, 4 * 8 * 3),
      },
      terminal: {
        identity: { envelopeId: digest("recursive:terminal-envelope"), purpose: "terminal" },
        budget: multiply(child, 3 * 12 * 3),
      },
    },
    allowedClaim: "recursive-transfer-frozen-corpus",
  });
}


async function journalPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), `hone-meta-${name}-`)), "private", "meta-journal.v1.ndjson");
}

function digest(value: string): MetaSha256DigestV1 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function identity(
  value: string,
  overrides: Partial<MetaWorkIdentityV1> = {},
): MetaWorkIdentityV1 {
  return {
    phase: "search",
    arm: "candidate",
    sourceArtifact: digest(`source-${value}`),
    bundleDigest: digest(`bundle-${value}`),
    capsuleId: "cap_aaaaaaaaaaaa",
    replicate: 0,
    measurementEpoch: `m1-official-2026-07:${value}`,
    ...overrides,
  };
}

const ZERO_USAGE: MetaResourceUsageV1 = {
  tokens: 0,
  usd: 0,
  wallClockSec: 0,
  evaluatorInvocations: 0,
};

function settlement(qRaw: number, overrides: Partial<MetaSettlementInputV1> = {}): MetaSettlementInputV1 {
  return {
    evidenceHash: digest(`evidence-${qRaw}`),
    observed: ZERO_USAGE,
    qRaw,
    responseModel: "gpt-5.6-sol",
    providerFingerprint: null,
    modelDriftSentinel: "start=gpt-5.6-sol;end=gpt-5.6-sol",
    ...overrides,
  };
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").trimEnd().split("\n");
}

describe("MetaJournalV1 durable identity and idempotency", () => {
  it("publishes an owner-only config-bound header and returns one deterministic reservation for duplicate work", async () => {
    const path = await journalPath("header");
    const cfg = config();
    const journal = MetaJournalV1.open(path, cfg);
    const first = journal.reserveChild(identity("candidate-1"));
    const duplicate = journal.reserveChild(identity("candidate-1"));

    expect(duplicate).toEqual(first);
    expect(first.configHash).toBe(metaCampaignConfigHash(cfg));
    expect(first.childRunId).toBe(`run_meta_${first.workKey.slice(7)}`);
    expect(first.reserved).toEqual(cfg.budgets.child);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(lines(path).map((line) => JSON.parse(line).t)).toEqual(["header", "reservation"]);
    expect(journal.budgetState()).toMatchObject({ reservations: 1, openReservations: 1 });
    journal.close();
  });

  it("settles and measures exactly once, rejects a conflicting duplicate, and releases unused capacity", async () => {
    const path = await journalPath("settle");
    const cfg = config();
    const journal = MetaJournalV1.open(path, cfg);
    const work = identity("candidate-2");
    journal.reserveChild(work);
    const input = settlement(0.91, {
      observed: { tokens: 7, usd: 0.25, wallClockSec: 3.5, evaluatorInvocations: 2 },
      providerFingerprint: "provider-build-17",
    });
    const first = journal.settleChild(work, input);
    const duplicate = journal.settleChild(work, input);

    expect(duplicate).toEqual(first);
    expect(first.qNormalized).toBe((first.qRaw - first.qBase) / first.scale);
    expect(first.qNormalized).toBe(1);
    expect(first.requestedModel).toBe(cfg.modelObservation.requestedRoute);
    expect(() => journal.settleChild(work, settlement(0.8))).toThrow(/conflicting duplicate settlement/);
    expect(lines(path).map((line) => JSON.parse(line).t)).toEqual([
      "header",
      "reservation",
      "settlement",
      "measurement",
    ]);
    expect(journal.budgetState()).toMatchObject({
      settlements: 1,
      measurements: 1,
      openReservations: 0,
      committed: {
        maxTokens: cfg.budgets.outer.maxTokens + 7,
        maxUsd: cfg.budgets.outer.maxUsd + 0.25,
        maxWallClockSec: cfg.budgets.outer.maxWallClockSec + 3.5,
        maxEvaluatorInvocations: cfg.budgets.outer.maxEvaluatorInvocations + 2,
      },
    });
    journal.close();
  });

  it("keeps source-artifact and bundle-digest domains distinct in work identity", async () => {
    const path = await journalPath("digest-domains");
    const journal = MetaJournalV1.open(path, config());
    const base = identity("domain");
    const changedSource = { ...base, sourceArtifact: digest("different-source") };
    const changedBundle = { ...base, bundleDigest: digest("different-bundle") };
    const reservations = [base, changedSource, changedBundle].map((work) => journal.reserveChild(work));
    expect(new Set(reservations.map((reservation) => reservation.workKey))).toHaveLength(3);
    journal.close();
  });

  it("compares registered seed and control source+bundle pairs in their own digest domains", async () => {
    const cfg = config();
    const path = await journalPath("registered-pairs");
    const journal = MetaJournalV1.open(path, cfg);
    const seed = identity("seed", {
      phase: "confirmation",
      arm: "seed",
      sourceArtifact: cfg.seedOptimizer.sourceArtifact as MetaSha256DigestV1,
      bundleDigest: cfg.seedOptimizer.bundleDigest as MetaSha256DigestV1,
    });
    expect(() => journal.reserveChild({ ...seed, sourceArtifact: seed.bundleDigest })).toThrow(/source domain/);
    expect(() => journal.reserveChild({ ...seed, bundleDigest: seed.sourceArtifact })).toThrow(/bundle domain/);
    expect(() => journal.reserveChild(seed)).not.toThrow();
    journal.close();
  });

  it("durably settles paid invalid work without publishing a score or losing componentwise spend", async () => {
    const path = await journalPath("failure-settlement");
    const cfg = config();
    const journal = MetaJournalV1.open(path, cfg);
    const work = identity("paid-failure");
    journal.reserveChild(work);
    const observed = { tokens: 17, usd: 1.25, wallClockSec: 4.5, evaluatorInvocations: 3 };
    const failure = journal.settleChildFailure(work, {
      evidenceHash: digest("paid-failure-evidence"),
      observed,
      status: "candidate_failed",
    });
    expect(journal.settleChildFailure(work, {
      evidenceHash: digest("paid-failure-evidence"),
      observed,
      status: "candidate_failed",
    })).toEqual(failure);
    expect(journal.queryTrainMeasurements()).toEqual([]);
    expect(journal.queryFailureSettlements()).toEqual([failure]);
    expect(journal.budgetState()).toMatchObject({
      settlements: 1,
      measurements: 0,
      failureSettlements: 1,
      openReservations: 0,
      committed: {
        maxTokens: cfg.budgets.outer.maxTokens + observed.tokens,
        maxUsd: cfg.budgets.outer.maxUsd + observed.usd,
        maxWallClockSec: cfg.budgets.outer.maxWallClockSec + observed.wallClockSec,
        maxEvaluatorInvocations: cfg.budgets.outer.maxEvaluatorInvocations + observed.evaluatorInvocations,
      },
    });
    expect(() => journal.settleChild(work, settlement(0.8, { observed }))).toThrow(/conflicting duplicate settlement/);
    journal.close();

    const replayed = MetaJournalV1.open(path, cfg);
    expect(replayed.queryFailureSettlements()).toEqual([failure]);
    expect(replayed.queryTrainMeasurements()).toEqual([]);
    replayed.close();
  });

  it("rejects every observed resource dimension above its full reservation", async () => {
    const cases: Array<[keyof MetaResourceUsageV1, number, RegExp]> = [
      ["tokens", config().budgets.child.maxTokens + 1, /maxTokens/],
      ["usd", config().budgets.child.maxUsd + 0.01, /maxUsd/],
      ["wallClockSec", config().budgets.child.maxWallClockSec + 0.01, /maxWallClockSec/],
      ["evaluatorInvocations", config().budgets.child.maxEvaluatorInvocations + 1, /maxEvaluatorInvocations/],
    ];
    for (const [dimension, value, message] of cases) {
      const path = await journalPath(`observed-${dimension}`);
      const journal = MetaJournalV1.open(path, config());
      const work = identity(`observed-${dimension}`);
      journal.reserveChild(work);
      expect(() => journal.settleChild(work, settlement(0.5, { observed: { ...ZERO_USAGE, [dimension]: value } }))).toThrow(message);
      journal.close();
    }
  });
  it("persists and replays the exact recursive envelope slice and binding", async () => {
    const path = await journalPath("recursive-envelope");
    const cfg = recursiveConfig();
    const work = identity("recursive-allocation", {
      capsuleId: cfg.developmentPanel.members[0]!.capsule.capsuleId,
      measurementEpoch: "m2:allocation-bound",
    });
    const envelope = {
      purpose: "search" as const,
      envelope: cfg.recursiveBudgets.search.identity,
      reservationId: "candidate-0-allocation-0",
      parentReservationId: null,
      reserved: { ...cfg.budgets.child },
    };
    const journal = MetaJournalV1.open(path, cfg);
    expect(() => journal.reserveChild(work)).toThrow(/requires a durable resource-envelope binding/);
    const reservation = journal.reserveChild(work, envelope);
    expect(reservation.reserved).toEqual(envelope.reserved);
    expect(reservation.envelope).toEqual(envelope);
    expect(JSON.parse(lines(path)[1] ?? "{}")).toMatchObject({
      v: 2,
      t: "reservation",
      reservation: { envelope },
    });
    expect(() => journal.reserveChild(work, {
      ...envelope,
      reservationId: "candidate-0-allocation-conflict",
    })).toThrow(/different envelope binding/);
    journal.close();

    const replayed = MetaJournalV1.open(path, cfg);
    expect(replayed.reserveChild(work, envelope)).toEqual(reservation);
    replayed.close();

    const legacyPath = await journalPath("recursive-legacy-reservation");
    const legacyJournal = MetaJournalV1.open(legacyPath, cfg);
    legacyJournal.reserveChild(work, envelope);
    legacyJournal.close();
    const legacyLines = lines(legacyPath).map((line) => JSON.parse(line));
    legacyLines[1].v = 1;
    delete legacyLines[1].reservation.envelope;
    writeFileSync(legacyPath, `${legacyLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    expect(() => MetaJournalV1.open(legacyPath, cfg)).toThrow(
      /recursive meta journals require every reservation to carry its durable envelope binding/,
    );
  });
});

describe("MetaJournalV1 componentwise campaign admission", () => {
  const dimensions = ["maxTokens", "maxUsd", "maxWallClockSec", "maxEvaluatorInvocations"] as const;

  for (const exhaustedDimension of dimensions) {
    it(`accepts the exact ${exhaustedDimension} boundary and refuses the next full envelope`, async () => {
      const cfg = config();
      for (const dimension of dimensions) {
        if (dimension !== exhaustedDimension) cfg.budgets.campaign[dimension] += cfg.budgets.child[dimension];
      }
      const path = await journalPath(`budget-${exhaustedDimension}`);
      const journal = MetaJournalV1.open(path, cfg);
      const childRuns =
        cfg.counts.candidates * cfg.train.length * cfg.counts.searchReplicates +
        4 * cfg.train.length * cfg.counts.confirmationReplicates +
        2 * cfg.holdout.length * cfg.counts.holdoutReplicates;
      for (let index = 0; index < childRuns; index += 1) {
        journal.reserveChild(identity(`${exhaustedDimension}-${index}`));
      }
      expect(journal.budgetState().remaining[exhaustedDimension]).toBe(0);
      expect(() => journal.reserveChild(identity(`${exhaustedDimension}-overflow`))).toThrow(
        new RegExp(`campaign budget exhausted: ${exhaustedDimension}`),
      );
      expect(journal.budgetState()).toMatchObject({
        reservations: childRuns,
        openReservations: childRuns,
      });
      journal.close();
    });
  }
});

describe("MetaJournalV1 replay and terminal holdout authority", () => {
  it("charges an open crash reservation conservatively across replay", async () => {
    const path = await journalPath("crash-open");
    const cfg = config();
    const first = MetaJournalV1.open(path, cfg);
    const reservation = first.reserveChild(identity("crashed-child"));
    const before = first.budgetState().committed;
    first.close();

    const replayed = MetaJournalV1.open(path, cfg);
    expect(replayed.budgetState()).toMatchObject({ committed: before, reservations: 1, settlements: 0, openReservations: 1 });
    expect(replayed.reserveChild(identity("crashed-child"))).toEqual(reservation);
    replayed.close();
  });

  it("idempotently republishes a measurement when a crash left only its durable settlement", async () => {
    const path = await journalPath("recover-measurement");
    const cfg = config();
    const first = MetaJournalV1.open(path, cfg);
    const work = identity("settled-before-crash");
    first.reserveChild(work);
    const measured = first.settleChild(work, settlement(0.7));
    first.close();
    const durable = lines(path);
    expect(JSON.parse(durable.at(-1) ?? "{}").t).toBe("measurement");
    writeFileSync(path, `${durable.slice(0, -1).join("\n")}\n`, { mode: 0o600 });

    const replayed = MetaJournalV1.open(path, cfg);
    expect(replayed.queryTrainMeasurements()).toEqual([measured]);
    expect(lines(path).map((line) => JSON.parse(line).t)).toEqual([
      "header",
      "reservation",
      "settlement",
      "measurement",
    ]);
    expect(replayed.settleChild(work, settlement(0.7))).toEqual(measured);
    replayed.close();
  });

  it("refuses torn tails, terminated corruption, exact-normalization forgery, and a foreign config", async () => {
    const cfg = config();

    const tornPath = await journalPath("torn");
    MetaJournalV1.open(tornPath, cfg).close();
    appendFileSync(tornPath, '{"v":1,"t":"reservation"');
    expect(() => MetaJournalV1.open(tornPath, cfg)).toThrow(/torn unterminated tail/);

    const corruptPath = await journalPath("corrupt");
    MetaJournalV1.open(corruptPath, cfg).close();
    appendFileSync(corruptPath, "not-json\n");
    expect(() => MetaJournalV1.open(corruptPath, cfg)).toThrow(/corrupt at line 2/);

    const normalizedPath = await journalPath("normalization-forgery");
    const normalized = MetaJournalV1.open(normalizedPath, cfg);
    const work = identity("normalization-forgery");
    normalized.reserveChild(work);
    normalized.settleChild(work, settlement(0.7));
    normalized.close();
    const forged = readFileSync(normalizedPath, "utf8").replace(/"qNormalized":[^,}]+/g, '"qNormalized":0.5');
    expect(forged).not.toBe(readFileSync(normalizedPath, "utf8"));
    writeFileSync(normalizedPath, forged, { mode: 0o600 });
    expect(() => MetaJournalV1.open(normalizedPath, cfg)).toThrow(/exact normalization is corrupt/);

    const foreignPath = await journalPath("foreign");
    MetaJournalV1.open(foreignPath, cfg).close();
    const foreign = config();
    foreign.objective = "a different valid frozen objective";
    expect(() => MetaJournalV1.open(foreignPath, foreign)).toThrow(/foreign campaign config/);
  });

  it("latches holdout exactly at terminal phase and never exposes holdout through the train query", async () => {
    const path = await journalPath("holdout");
    const journal = MetaJournalV1.open(path, config());
    const holdout = identity("winner-holdout", {
      phase: "holdout",
      arm: "winner",
      capsuleId: "cap_111111111111",
    });
    expect(() => journal.reserveChild(holdout)).toThrow(/terminal holdout latch/);

    const train = identity("winner-train", { phase: "confirmation", arm: "winner" });
    journal.reserveChild(train);
    const trainMeasurement = journal.settleChild(train, settlement(0.8));
    journal.latchTerminalHoldout();
    journal.latchTerminalHoldout();
    expect(() => journal.reserveChild(identity("late-search"))).toThrow(/train\/search work is closed/);
    journal.reserveChild(holdout);
    const holdoutMeasurement = journal.settleChild(holdout, settlement(0.9));

    expect(journal.queryTrainMeasurements()).toEqual([trainMeasurement]);
    expect(journal.queryTrainMeasurements()).not.toContainEqual(holdoutMeasurement);
    expect(journal.queryHoldoutMeasurements()).toEqual([holdoutMeasurement]);
    expect(journal.budgetState()).toMatchObject({ terminalHoldoutLatched: true, measurements: 2 });
    journal.close();

    const replayed = MetaJournalV1.open(path, config());
    expect(replayed.queryTrainMeasurements()).toEqual([trainMeasurement]);
    expect(replayed.queryHoldoutMeasurements()).toEqual([holdoutMeasurement]);
    replayed.close();
  });
});
