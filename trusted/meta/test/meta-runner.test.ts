import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  EvaluationRecord,
  M2_INNER_MODEL_ROUTE,
  M2_OUTER_MODEL_ROUTE,
  M2_PANEL_A_TASK_IDS,
  MetaCampaignConfigV1,
  MetaCampaignConfigV2,
  canonicalJson,
  type BudgetEnvelope,
  type MetaCampaignConfig,
  type MetaCampaignConfigV1 as LegacyMetaCampaignConfig,
  type MetaCampaignConfigV2 as RecursiveMetaCampaignConfig,
} from "@hone/schema";
import {
  MetaCampaignRunner,
  MetaResourceEnvelopeLedger,
  metaCampaignConfigHash,
  metaEvidenceHash,
  selectDeterministicBest,
  type CandidateGateResult,
  type MetaArtifactIdentity,
  type MetaCandidateGateRequest,
  type MetaChildRunOutcome,
  type MetaChildRunRequest,
  type MetaChildEnvelopeRequest,
  type MetaControlTransformationReceipt,
  type MetaFailureSettlement,
  type MetaEnvelopeAllocationRecord,
  type MetaEnvelopePort,
  type MetaEnvelopeRecordPort,
  type MetaFailureStatus,
  type MetaJournalPort,
  type MetaMeasurement,
  type MetaReservation,
  type MetaResourceUsage,
  type MetaWorkIdentity,
  type Sha256Digest,
} from "../src/index.js";

const tempDirs: string[] = [];
const fixedNow = new Date("2026-07-17T00:00:00.000Z");

function digest(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(): LegacyMetaCampaignConfig {
  const file = new URL("../../../schema/fixtures/meta-campaign.m1.json", import.meta.url);
  return MetaCampaignConfigV1.parse(JSON.parse(readFileSync(file, "utf8")));
}

function recursiveFixture(): RecursiveMetaCampaignConfig {
  const legacy = fixture();
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
  const target = {
    sourceCommit: "1".repeat(40),
    sourceArtifact: digest("recursive:target-source"),
    bundleDigest: digest("recursive:target-bundle"),
  };
  return MetaCampaignConfigV2.parse({
    ...legacy,
    version: 2,
    seedOptimizer: target,
    controllerOptimizer: target,
    optimizerRuntime: { image: `hone-optimizer@${digest("recursive:optimizer-image")}` },
    generation: {
      stage: "A",
      panel: "A",
      targetGeneration: 0,
      controllerGeneration: 0,
      outerReplicate: 0,
    },
    calibration: {
      reportDigest: digest("recursive:calibration-report"),
      excludedCapsuleIds: Array.from({ length: 4 }, (_, index) => `cap_${(2001 + index).toString(16).padStart(12, "0")}`),
    },
    corpusCohort: {
      developmentCapsuleIds: [
        ...train.map((entry) => entry.capsuleId),
        ...Array.from({ length: 8 }, (_, index) => `cap_${(2101 + index).toString(16).padStart(12, "0")}`),
      ],
      terminalCapsuleIds: holdout.map((entry) => entry.capsuleId),
      provenanceInputsDigest: digest("recursive:corpus-provenance"),
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
    budgets: {
      ...legacy.budgets,
      // Outer evaluator floor is candidateAttemptsMax + 1 under the V2 schema.
      outer: { ...legacy.budgets.outer, maxEvaluatorInvocations: 92 },
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

class RunnerEnvelopeRecords implements MetaEnvelopeRecordPort {
  readonly rows: MetaEnvelopeAllocationRecord[] = [];

  readAll(): readonly unknown[] {
    return structuredClone(this.rows);
  }

  append(record: MetaEnvelopeAllocationRecord): void {
    this.rows.push(structuredClone(record));
  }
}

function workKey(configHash: Sha256Digest, identity: MetaWorkIdentity): Sha256Digest {
  return digest(canonicalJson({ configHash, ...identity }));
}

class MemoryJournal implements MetaJournalPort {
  readonly configHash: Sha256Digest;
  readonly reservations = new Map<string, MetaReservation>();
  readonly measurements = new Map<string, MetaMeasurement>();
  readonly failures = new Map<string, MetaFailureSettlement>();
  terminal = false;

  constructor(private readonly config: MetaCampaignConfig) {
    this.configHash = metaCampaignConfigHash(config);
  }

  reserveChild(identity: MetaWorkIdentity, envelope?: MetaChildEnvelopeRequest): MetaReservation {
    if (identity.phase === "holdout" && !this.terminal) throw new Error("holdout not latched");
    if (identity.phase !== "holdout" && this.terminal) throw new Error("train work closed");
    const key = workKey(this.configHash, identity);
    const requested = envelope?.reserved ?? this.config.budgets.child;
    const requestedEnvelope = envelope ?? null;
    const existing = this.reservations.get(key);
    if (existing !== undefined) {
      if (
        canonicalJson(existing.reserved) !== canonicalJson(requested) ||
        canonicalJson(existing.envelope) !== canonicalJson(requestedEnvelope)
      ) {
        throw new Error("conflicting reservation slice");
      }
      return structuredClone(existing);
    }
    const reservation: MetaReservation = {
      configHash: this.configHash,
      workKey: key,
      childRunId: `run_meta_${key.slice("sha256:".length)}`,
      identity: structuredClone(identity),
      reserved: { ...requested },
      envelope: structuredClone(requestedEnvelope),
    };
    this.reservations.set(key, reservation);
    return structuredClone(reservation);
  }

  settleChild(
    identity: MetaWorkIdentity,
    input: {
      evidenceHash: string;
      observed: MetaResourceUsage;
      qRaw: number;
      responseModel: string;
      providerFingerprint: string | null;
      modelDriftSentinel: string;
    },
  ): MetaMeasurement {
    const key = workKey(this.configHash, identity);
    if (this.failures.has(key)) throw new Error("conflicting settlement");
    const reservation = this.reservations.get(key);
    if (reservation === undefined) throw new Error("missing reservation");
    const capsule = [...this.config.train, ...this.config.holdout].find((entry) => entry.capsuleId === identity.capsuleId);
    if (capsule === undefined) throw new Error("unknown capsule");
    const measurement: MetaMeasurement = {
      configHash: this.configHash,
      protocolHash: this.config.protocolHash as Sha256Digest,
      analysisConfigHash: this.config.analysisConfigHash as Sha256Digest,
      ...identity,
      capsuleDigest: capsule.capsuleDigest as Sha256Digest,
      requestedModel: this.config.routing.innerMutation,
      responseModel: input.responseModel,
      providerFingerprint: input.providerFingerprint,
      modelDriftSentinel: input.modelDriftSentinel,
      workKey: key,
      childRunId: reservation.childRunId,
      evidenceHash: input.evidenceHash as Sha256Digest,
      reserved: { ...reservation.reserved },
      observed: { ...input.observed },
      qRaw: input.qRaw,
      qBase: capsule.qBase,
      scale: capsule.scale,
      qNormalized: (input.qRaw - capsule.qBase) / capsule.scale,
    };
    const prior = this.measurements.get(key);
    if (prior !== undefined) {
      if (canonicalJson(prior) !== canonicalJson(measurement)) throw new Error("conflicting settlement");
      return structuredClone(prior);
    }
    this.measurements.set(key, measurement);
    return structuredClone(measurement);
  }

  settleChildFailure(
    identity: MetaWorkIdentity,
    input: { evidenceHash: string; observed: MetaResourceUsage; status: MetaFailureStatus },
  ): MetaFailureSettlement {
    const key = workKey(this.configHash, identity);
    if (this.measurements.has(key)) throw new Error("conflicting settlement");
    const reservation = this.reservations.get(key);
    if (reservation === undefined) throw new Error("missing reservation");
    const capsule = [...this.config.train, ...this.config.holdout].find((entry) => entry.capsuleId === identity.capsuleId);
    if (capsule === undefined) throw new Error("unknown capsule");
    const failure: MetaFailureSettlement = {
      configHash: this.configHash,
      protocolHash: this.config.protocolHash as Sha256Digest,
      analysisConfigHash: this.config.analysisConfigHash as Sha256Digest,
      ...identity,
      capsuleDigest: capsule.capsuleDigest as Sha256Digest,
      workKey: key,
      childRunId: reservation.childRunId,
      evidenceHash: input.evidenceHash as Sha256Digest,
      reserved: { ...reservation.reserved },
      observed: { ...input.observed },
      status: input.status,
    };
    const prior = this.failures.get(key);
    if (prior !== undefined) {
      if (canonicalJson(prior) !== canonicalJson(failure)) throw new Error("conflicting settlement");
      return structuredClone(prior);
    }
    this.failures.set(key, failure);
    return structuredClone(failure);
  }

  queryTrainMeasurements(): readonly MetaMeasurement[] {
    return [...this.measurements.values()].filter((row) => row.phase !== "holdout").map((row) => structuredClone(row));
  }

  queryHoldoutMeasurements(): readonly MetaMeasurement[] {
    if (!this.terminal) throw new Error("holdout not latched");
    return [...this.measurements.values()].filter((row) => row.phase === "holdout").map((row) => structuredClone(row));
  }

  queryFailureSettlements(): readonly MetaFailureSettlement[] {
    return [...this.failures.values()].map((row) => structuredClone(row));
  }

  latchTerminalHoldout(): void {
    const settled = new Set([...this.measurements.keys(), ...this.failures.keys()]);
    if ([...this.reservations.keys()].some((key) => !settled.has(key))) throw new Error("open reservation");
    this.terminal = true;
  }
}

function childOutcome(
  request: MetaChildRunRequest,
  normalized: number,
  options: {
    status?: MetaChildRunOutcome["status"];
    valid?: boolean;
    missing?: boolean;
    spend?: MetaResourceUsage;
  } = {},
): MetaChildRunOutcome {
  const q = request.capsule.qBase + normalized * request.capsule.scale;
  const best = digest(`${request.reservation.workKey}:best`);
  const finalEvaluation = options.missing === true
    ? null
    : EvaluationRecord.parse({
        capsuleId: request.capsule.capsuleId,
        artifactHash: best,
        assetGroupId: "train",
        seed: request.identity.replicate,
        output: {
          valid: options.valid ?? true,
          objectives: { q },
          constraints: { required: true },
          perExample: {},
        },
        costUsd: 0,
        durationMs: 1,
        cached: false,
        evaluatedAt: fixedNow.toISOString(),
      });
  return {
    status: options.status ?? "completed",
    childRunId: request.reservation.childRunId,
    measurementEpoch: request.identity.measurementEpoch,
    capsuleId: request.capsule.capsuleId,
    sourceArtifact: request.sourceArtifact,
    bundleDigest: request.bundleDigest,
    runtimeBundleDigest: digest(`${request.bundleDigest}:${request.capsule.image}`),
    baselineArtifactHash: digest(`${request.capsule.capsuleId}:baseline`),
    bestArtifactHash: finalEvaluation === null ? null : best,
    finalEvaluation,
    finalEvaluationHash: finalEvaluation === null ? null : digest(canonicalJson(finalEvaluation)),
    spend: options.spend ?? { tokens: 10, usd: 0.25, wallClockSec: 2, evaluatorInvocations: 3 },
    eventLogHash: digest(`${request.reservation.workKey}:events:${request.attempt}`),
    eventLogCursor: 17 + request.attempt,
    proxyTraceHash: digest(`${request.reservation.workKey}:proxy:${request.attempt}`),
    brokerJournalHash: digest(`${request.reservation.workKey}:broker:${request.attempt}`),
    responseModel: finalEvaluation === null ? null : request.requestedModel,
    providerFingerprint: null,
    modelDriftSentinel: finalEvaluation === null ? null : "stable-test-sentinel",
    feedback: `trusted child ${request.capsule.capsuleId}`,
  };
}

function receipt(kind: "broken" | "degraded", artifactDigest: Sha256Digest): MetaControlTransformationReceipt {
  return {
    version: 1,
    kind,
    transformation: kind === "broken" ? "broken-no-candidate-v1" : "degraded-blind-restart-v1",
    sourceSealHash: digest(`${kind}:source-seal`),
    artifactDigest,
    files: 1,
    transformedFiles: [{
      path: "src/main.ts",
      beforeSha256: digest(`${kind}:before`),
      afterSha256: digest(`${kind}:after`),
      mode: 0o644,
    }],
  };
}

function gateResult(request: MetaCandidateGateRequest, bundleBySource: ReadonlyMap<string, Sha256Digest>): CandidateGateResult {
  const bundleDigest = request.mode === "trusted-control"
    ? request.bundleDigest
    : bundleBySource.get(request.sourceArtifact) ?? digest(`bundle:${request.sourceArtifact}`);
  return {
    ok: true,
    sourceArtifact: request.sourceArtifact,
    bundleDigest,
    transformationReceiptHash: request.mode === "trusted-control"
      ? digest(canonicalJson(request.transformationReceipt))
      : null,
    feedback: "gate passed",
  };
}

function harness(
  runChild: (request: MetaChildRunRequest) => Promise<MetaChildRunOutcome>,
  options: {
    config?: MetaCampaignConfig;
    journal?: MemoryJournal;
    joinPath?: string;
    gate?: (request: MetaCandidateGateRequest) => Promise<CandidateGateResult>;
    bundleBySource?: ReadonlyMap<string, Sha256Digest>;
    envelopeLedger?: MetaEnvelopePort;
  } = {},
): { runner: MetaCampaignRunner; journal: MemoryJournal; joinPath: string } {
  const config = options.config ?? fixture();
  const journal = options.journal ?? new MemoryJournal(config);
  const dir = options.joinPath === undefined ? mkdtempSync(join(tmpdir(), "hone-meta-test-")) : options.joinPath.slice(0, options.joinPath.lastIndexOf("/"));
  if (options.joinPath === undefined) tempDirs.push(dir);
  const joinPath = options.joinPath ?? join(dir, "joins.ndjson");
  const bundleBySource = options.bundleBySource ?? new Map<string, Sha256Digest>();
  return {
    runner: new MetaCampaignRunner({
      config,
      journal,
      joinPath,
      candidateGate: { check: options.gate ?? (async (request) => gateResult(request, bundleBySource)) },
      childSupervisor: { run: runChild },
      ...(options.envelopeLedger === undefined ? {} : { envelopeLedger: options.envelopeLedger }),
      now: () => fixedNow,
      mintMeasurementEpoch: () => "epoch-test",
      childConcurrency: 2,
    }),
    journal,
    joinPath,
  };
}

function searchInput(sourceArtifact = digest("candidate")) {
  return { sourceArtifact, outerCapsuleId: "cap_123456789abc", assetGroupId: "meta-train", seed: 7 };
}

function artifact(source: string, bundle: string): MetaArtifactIdentity {
  return { sourceArtifact: digest(source), bundleDigest: digest(bundle) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("trusted meta runner identity and scoring", () => {
  test("uses distinct source and bundle domains, equal-weight q normalization, and no holdout during search", async () => {
    const config = fixture();
    const gains = new Map(config.train.map((capsule, index) => [capsule.capsuleId, [2, 0, 1, -1, 3][index]!]));
    const calls: MetaChildRunRequest[] = [];
    const sourceArtifact = digest("source-candidate");
    const bundleDigest = digest("resolved-bundle");
    const { runner, journal } = harness(async (request) => {
      calls.push(request);
      return childOutcome(request, gains.get(request.capsule.capsuleId)!);
    }, { bundleBySource: new Map([[sourceArtifact, bundleDigest]]) });
    const record = await runner.evaluateSearchCandidate(searchInput(sourceArtifact));
    expect(record.output.valid).toBe(true);
    expect(record.output.objectives.normalizedGain).toBeCloseTo(1, 12);
    expect(record.artifactHash).toBe(sourceArtifact);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.sourceArtifact === sourceArtifact && call.bundleDigest === bundleDigest)).toBe(true);
    expect([...journal.reservations.values()].every((row) => row.identity.sourceArtifact === sourceArtifact && row.identity.bundleDigest === bundleDigest)).toBe(true);
    expect(calls.map((call) => call.capsule.capsuleId)).toEqual(config.train.map((capsule) => capsule.capsuleId));
    expect(JSON.stringify(record)).not.toContain(config.holdout[0]!.capsuleDigest);
    runner.close();
  });

  test("fails closed when a gate crosses digest domains or marks public work as a trusted control", async () => {
    const sourceArtifact = digest("source");
    for (const gate of [
      async (): Promise<CandidateGateResult> => ({
        ok: true,
        sourceArtifact: digest("wrong-source"),
        bundleDigest: digest("bundle"),
        transformationReceiptHash: null,
        feedback: "wrong source",
      }),
      async (): Promise<CandidateGateResult> => ({
        ok: true,
        sourceArtifact,
        bundleDigest: digest("bundle"),
        transformationReceiptHash: digest("forged-receipt"),
        feedback: "wrong mode",
      }),
    ]) {
      const { runner } = harness(async () => { throw new Error("must not launch"); }, { gate });
      await expect(runner.evaluateSearchCandidate(searchInput(sourceArtifact))).rejects.toThrow(/source artifact|public mutable/);
      runner.close();
    }
  });

  test("deduplicates only the exact source+bundle pair", async () => {
    let calls = 0;
    const sourceArtifact = digest("same-source");
    const bundleDigest = digest("same-bundle");
    const { runner } = harness(async (request) => {
      calls += 1;
      await Promise.resolve();
      return childOutcome(request, 1);
    }, { bundleBySource: new Map([[sourceArtifact, bundleDigest]]) });
    await Promise.all([
      runner.evaluateSearchCandidate(searchInput(sourceArtifact)),
      runner.evaluateSearchCandidate(searchInput(sourceArtifact)),
    ]);
    expect(calls).toBe(5);
    runner.close();
  });
});

describe("recursive M2 search topology", () => {
  test("fails closed before gate or child launch because M2 search uses one-at-a-time spawnRun", async () => {
    const config = recursiveFixture();
    const records = new RunnerEnvelopeRecords();
    const envelopeLedger = new MetaResourceEnvelopeLedger(config.recursiveBudgets, records);
    let gateCalls = 0;
    let childCalls = 0;
    const { runner } = harness(async (request) => {
      childCalls += 1;
      return childOutcome(request, 1);
    }, {
      config,
      envelopeLedger,
      gate: async (request) => {
        gateCalls += 1;
        return gateResult(request, new Map());
      },
    });

    await expect(runner.evaluateSearchCandidate(searchInput(digest("m2-spawn-run-only")))).rejects.toThrow(
      /one child at a time through spawnRun; evaluateSearchCandidate is M1-only/,
    );
    expect(gateCalls).toBe(0);
    expect(childCalls).toBe(0);
    expect(records.rows).toHaveLength(0);
    runner.close();
  });
});

describe("trusted controls and registered pairs", () => {
  test("requires exact registered seed/control source+bundle pairs and exact transformation receipts", async () => {
    const config = fixture();
    const seed: MetaArtifactIdentity = {
      sourceArtifact: config.seedOptimizer.sourceArtifact as Sha256Digest,
      bundleDigest: config.seedOptimizer.bundleDigest as Sha256Digest,
    };
    const winner = artifact("winner-source", "winner-bundle");
    const brokenSource = config.controls.brokenSourceArtifact as Sha256Digest;
    const degradedSource = config.controls.degradedSourceArtifact as Sha256Digest;
    const broken = {
      sourceArtifact: brokenSource,
      bundleDigest: config.controls.brokenBundleDigest as Sha256Digest,
      transformationReceipt: receipt("broken", brokenSource),
    };
    const degraded = {
      sourceArtifact: degradedSource,
      bundleDigest: config.controls.degradedBundleDigest as Sha256Digest,
      transformationReceipt: receipt("degraded", degradedSource),
    };
    const seenModes: string[] = [];
    const bundles = new Map<string, Sha256Digest>([[seed.sourceArtifact, seed.bundleDigest], [winner.sourceArtifact, winner.bundleDigest]]);
    const { runner, joinPath } = harness(async (request) => childOutcome(request, 1), {
      config,
      bundleBySource: bundles,
      gate: async (request) => {
        seenModes.push(request.mode);
        return gateResult(request, bundles);
      },
    });
    await runner.runConfirmation({ seed, winner, brokenControl: broken, degradedControl: degraded });
    expect(seenModes.filter((mode) => mode === "trusted-control")).toHaveLength(2);
    expect(seenModes.filter((mode) => mode === "public-mutable")).toHaveLength(2);
    const admittedControls = readFileSync(joinPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line["t"] === "candidate" && line["transformationReceiptHash"] !== null);
    expect(admittedControls.map((line) => line["transformationReceiptHash"])).toEqual([
      digest(canonicalJson(broken.transformationReceipt)),
      digest(canonicalJson(degraded.transformationReceipt)),
    ]);
    runner.close();

    const mismatched = harness(async (request) => childOutcome(request, 1), { config });
    await expect(mismatched.runner.runConfirmation({
      seed: { ...seed, bundleDigest: digest("seed-in-source-domain") },
      winner,
      brokenControl: broken,
      degradedControl: degraded,
    })).rejects.toThrow(/seed bundle digest/);
    mismatched.runner.close();
  });

  test("rejects a forged control receipt before the public mutable gate can be bypassed", async () => {
    const config = fixture();
    const seed = {
      sourceArtifact: config.seedOptimizer.sourceArtifact as Sha256Digest,
      bundleDigest: config.seedOptimizer.bundleDigest as Sha256Digest,
    };
    const brokenSource = config.controls.brokenSourceArtifact as Sha256Digest;
    const degradedSource = config.controls.degradedSourceArtifact as Sha256Digest;
    const { runner } = harness(async (request) => childOutcome(request, 1), { config });
    await expect(runner.runConfirmation({
      seed,
      winner: artifact("winner", "winner-bundle"),
      brokenControl: {
        sourceArtifact: brokenSource,
        bundleDigest: config.controls.brokenBundleDigest as Sha256Digest,
        transformationReceipt: { ...receipt("broken", brokenSource), artifactDigest: digest("forged-artifact") },
      },
      degradedControl: {
        sourceArtifact: degradedSource,
        bundleDigest: config.controls.degradedBundleDigest as Sha256Digest,
        transformationReceipt: receipt("degraded", degradedSource),
      },
    })).rejects.toThrow(/does not bind/);
    runner.close();
  });
});

describe("failure spend, retry, and terminal latch", () => {
  test("charges every paid candidate failure and emits no score or measurement for invalid work", async () => {
    const failedCapsule = fixture().train[0]!.capsuleId;
    const { runner, journal, joinPath } = harness(async (request) => request.capsule.capsuleId === failedCapsule
      ? childOutcome(request, 0, { status: "candidate_failed", spend: { tokens: 30, usd: 0.75, wallClockSec: 5, evaluatorInvocations: 4 } })
      : childOutcome(request, 1));
    const record = await runner.evaluateSearchCandidate(searchInput(digest("paid-failure")));
    expect(record.output.valid).toBe(false);
    expect(record.output.objectives).toEqual({});
    expect(record.costUsd).toBe(1.75);
    expect(journal.measurements).toHaveLength(4);
    expect(journal.failures).toHaveLength(1);
    expect([...journal.failures.values()][0]?.observed).toEqual({ tokens: 30, usd: 0.75, wallClockSec: 5, evaluatorInvocations: 4 });
    const failureLine = readFileSync(joinPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line["t"] === "failure") as { evidence: Record<string, unknown> };
    expect(failureLine.evidence["eventLogHash"]).toMatch(/^sha256:/);
    expect(failureLine.evidence["proxyTraceHash"]).toMatch(/^sha256:/);
    expect(failureLine.evidence["brokerJournalHash"]).toMatch(/^sha256:/);
    expect(failureLine.evidence["finalEvaluationHash"]).toMatch(/^sha256:/);
    expect(failureLine.evidence["spend"]).toEqual({ tokens: 30, usd: 0.75, wallClockSec: 5, evaluatorInvocations: 4 });
    runner.close();
  });

  test("retries infrastructure once with the same work key/epoch and only the remaining child budget", async () => {
    const firstCapsule = fixture().train[0]!.capsuleId;
    const requests: MetaChildRunRequest[] = [];
    const { runner, journal } = harness(async (request) => {
      requests.push(structuredClone(request));
      if (request.capsule.capsuleId === firstCapsule && request.attempt === 0) {
        return childOutcome(request, 0, { status: "infrastructure_not_run", missing: true, spend: { tokens: 11, usd: 1, wallClockSec: 7, evaluatorInvocations: 2 } });
      }
      if (request.capsule.capsuleId === firstCapsule) {
        return childOutcome(request, 1, { spend: { tokens: 19, usd: 1.5, wallClockSec: 9, evaluatorInvocations: 4 } });
      }
      return childOutcome(request, 1);
    });
    const candidate = digest("retry-candidate");
    expect((await runner.evaluateSearchCandidate(searchInput(candidate))).output.valid).toBe(false);
    expect(() => journal.latchTerminalHoldout()).toThrow(/open reservation/);
    const first = requests.find((request) => request.capsule.capsuleId === firstCapsule)!;
    expect((await runner.evaluateSearchCandidate(searchInput(candidate))).output.valid).toBe(true);
    const retry = requests.find((request) => request.capsule.capsuleId === firstCapsule && request.attempt === 1)!;
    expect(retry.reservation.workKey).toBe(first.reservation.workKey);
    expect(retry.identity.measurementEpoch).toBe(first.identity.measurementEpoch);
    expect(retry.resume).toBe(true);
    expect(retry.remainingBudget).toEqual({
      maxTokens: first.reservation.reserved.maxTokens - 11,
      maxUsd: first.reservation.reserved.maxUsd - 1,
      maxWallClockSec: first.reservation.reserved.maxWallClockSec - 7,
      maxEvaluatorInvocations: first.reservation.reserved.maxEvaluatorInvocations - 2,
    });
    expect(journal.reservations).toHaveLength(5);
    expect(requests).toHaveLength(6);
    runner.close();
  });

  test("resumes a durably prelaunched retry after a crash without minting an attempt or budget", async () => {
    const config = fixture();
    const journal = new MemoryJournal(config);
    const firstCapsule = config.train[0]!.capsuleId;
    const candidate = digest("retry-crash");
    const first = harness(async (request) => request.capsule.capsuleId === firstCapsule
      ? childOutcome(request, 0, { status: "infrastructure_not_run", missing: true, spend: { tokens: 13, usd: 2, wallClockSec: 8, evaluatorInvocations: 3 } })
      : childOutcome(request, 1), { config, journal });
    await first.runner.evaluateSearchCandidate(searchInput(candidate));
    const reservation = [...journal.reservations.values()].find((row) => row.identity.capsuleId === firstCapsule)!;
    first.runner.joins.startRetry(reservation.workKey, {
      maxTokens: reservation.reserved.maxTokens - 13,
      maxUsd: reservation.reserved.maxUsd - 2,
      maxWallClockSec: reservation.reserved.maxWallClockSec - 8,
      maxEvaluatorInvocations: reservation.reserved.maxEvaluatorInvocations - 3,
    });
    first.runner.close();

    const retried: MetaChildRunRequest[] = [];
    const resumed = harness(async (request) => {
      retried.push(structuredClone(request));
      return childOutcome(request, 1, { spend: { tokens: 20, usd: 2.5, wallClockSec: 10, evaluatorInvocations: 4 } });
    }, { config, journal, joinPath: first.joinPath });
    expect((await resumed.runner.evaluateSearchCandidate(searchInput(candidate))).output.valid).toBe(true);
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ attempt: 1, resume: true });
    expect(retried[0]!.reservation.workKey).toBe(reservation.workKey);
    expect(journal.reservations).toHaveLength(5);
    resumed.runner.close();
  });

  test("settles terminal not_run after retry exhaustion, then permits the latch and never retries again", async () => {
    const firstCapsule = fixture().train[0]!.capsuleId;
    let calls = 0;
    const { runner, journal } = harness(async (request) => {
      calls += 1;
      if (request.capsule.capsuleId !== firstCapsule) return childOutcome(request, 1);
      return childOutcome(request, 0, {
        status: "infrastructure_not_run",
        missing: true,
        spend: request.attempt === 0
          ? { tokens: 5, usd: 0.5, wallClockSec: 2, evaluatorInvocations: 1 }
          : { tokens: 9, usd: 0.9, wallClockSec: 4, evaluatorInvocations: 2 },
      });
    });
    const input = searchInput(digest("retry-exhausted"));
    expect((await runner.evaluateSearchCandidate(input)).output.valid).toBe(false);
    expect((await runner.evaluateSearchCandidate(input)).output.valid).toBe(false);
    expect((await runner.evaluateSearchCandidate(input)).output.valid).toBe(false);
    expect(calls).toBe(6);
    expect(journal.failures).toHaveLength(1);
    expect([...journal.failures.values()][0]).toMatchObject({ status: "infrastructure_not_run", observed: { tokens: 9, usd: 0.9 } });
    expect(() => journal.latchTerminalHoldout()).not.toThrow();
    runner.close();
  });

  test("never reruns a durably completed child", async () => {
    let calls = 0;
    const { runner, journal } = harness(async (request) => {
      calls += 1;
      return childOutcome(request, 1);
    });
    const input = searchInput(digest("completed-terminal"));
    expect((await runner.evaluateSearchCandidate(input)).output.valid).toBe(true);
    expect((await runner.evaluateSearchCandidate(input)).output.valid).toBe(true);
    expect(calls).toBe(5);
    expect(journal.measurements).toHaveLength(5);
    runner.close();
  });

  test("budget and candidate failures are terminal on their first outcome", async () => {
    for (const status of ["budget", "candidate_failed"] as const) {
      const firstCapsule = fixture().train[0]!.capsuleId;
      let calls = 0;
      const { runner, journal } = harness(async (request) => {
        calls += 1;
        return request.capsule.capsuleId === firstCapsule
          ? childOutcome(request, 0, { status, missing: true })
          : childOutcome(request, 1);
      });
      const input = searchInput(digest(`terminal-${status}`));
      await runner.evaluateSearchCandidate(input);
      await runner.evaluateSearchCandidate(input);
      expect(calls).toBe(5);
      expect(journal.failures).toHaveLength(1);
      expect(journal.measurements).toHaveLength(4);
      runner.close();
    }
  });
});

describe("durable evidence joins", () => {
  test("joins source, bundle, component hashes, final hash, and spend before settlement", async () => {
    const sourceArtifact = digest("join-source");
    const bundleDigest = digest("join-bundle");
    const { runner, journal, joinPath } = harness(async (request) => childOutcome(request, 1), {
      bundleBySource: new Map([[sourceArtifact, bundleDigest]]),
    });
    await runner.evaluateSearchCandidate(searchInput(sourceArtifact));
    const lines = readFileSync(joinPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const candidate = lines.find((line) => line["t"] === "candidate")!;
    expect(candidate).toMatchObject({ sourceArtifact, bundleDigest });
    const completion = lines.find((line) => line["t"] === "completion") as { evidence: Record<string, unknown>; workKey: string };
    expect(completion.evidence).toMatchObject({ sourceArtifact, bundleDigest, attempt: 0 });
    expect(completion.evidence["runtimeBundleDigest"]).toMatch(/^sha256:/);
    expect(completion.evidence["eventLogHash"]).toMatch(/^sha256:/);
    expect(completion.evidence["proxyTraceHash"]).toMatch(/^sha256:/);
    expect(completion.evidence["brokerJournalHash"]).toMatch(/^sha256:/);
    expect(completion.evidence["finalEvaluationHash"]).toMatch(/^sha256:/);
    expect(completion.evidence["spend"]).toEqual({ tokens: 10, usd: 0.25, wallClockSec: 2, evaluatorInvocations: 3 });
    expect(journal.measurements.get(completion.workKey)?.evidenceHash).toBe(metaEvidenceHash(completion.evidence as never));
    runner.close();
  });

  test("uses deterministic artifact-hash tie breaking", () => {
    const record = (artifactHash: Sha256Digest) => EvaluationRecord.parse({
      capsuleId: "cap_123456789abc",
      artifactHash,
      assetGroupId: "train",
      seed: 0,
      output: { valid: true, objectives: { q: 1 }, constraints: {}, perExample: {} },
      costUsd: 0,
      durationMs: 0,
      cached: false,
      evaluatedAt: fixedNow.toISOString(),
    });
    const low = digest("a");
    const high = digest("b");
    expect(selectDeterministicBest([record(high), record(low)]).artifactHash).toBe([low, high].sort()[0]);
  });
});
