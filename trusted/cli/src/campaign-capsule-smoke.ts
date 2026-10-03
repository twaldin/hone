import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Broker, BrokerError, CasStore, packDirAsArtifact, unpackArtifact } from "@hone/broker";
import {
  CapsuleManifest,
  EvaluationRecord,
  MetaCampaignConfigV2,
  canonicalJson,
  capsuleDigest,
  type MetaCampaignConfigV2 as RecursiveMetaCampaignConfig,
  type RunEvent,
} from "@hone/schema";
import { metaCampaignConfigHash, type Sha256Digest } from "@hone/meta";
import { z } from "zod";
import { UsageError } from "./args.js";
import { writeFileDurable } from "./eventlog.js";
import { measureBaseline } from "./backends/local.js";
import { MetaJournalV1 } from "./meta-journal.js";
import { runsRoot } from "./runs.js";

const HASH = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IMAGE = z.string().regex(/@sha256:[0-9a-f]{64}$/);

const CapsuleSmokeRow = z.object({
  taskId: z.string().min(1),
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  capsuleDigest: HASH,
  image: IMAGE,
  candidateArtifact: HASH,
  conformance: z.object({
    passed: z.literal(true),
    archiveBytes: z.number().int().positive(),
    protectedPathControl: z.literal("PROTECTED_PATH_VIOLATION"),
  }).strict(),
  isolation: z.object({
    mode: z.enum(["reserved-uid", "shared-uid-lease"]),
    allocationId: z.string().min(1),
    workerUid: z.number().int().positive(),
    waitMs: z.number().int().nonnegative(),
  }).strict(),
  evaluation: z.object({
    valid: z.literal(true),
    constraintsPassed: z.literal(true),
    score: z.number().finite(),
    costUsd: z.literal(0),
    durationMs: z.number().finite().nonnegative(),
    recordHash: HASH,
  }).strict(),
  settlement: z.object({
    kind: z.literal("measurement"),
    workKey: HASH,
    childRunId: z.string().regex(/^run_meta_[0-9a-f]{64}$/),
    qNormalized: z.number().finite(),
  }).strict(),
}).strict();
export type CapsuleSmokeRow = z.infer<typeof CapsuleSmokeRow>;

const PanelCapsuleSmokeReceiptBody = z.object({
  version: z.literal(1),
  type: z.literal("campaign-panel-capsule-smoke.v1"),
  campaignConfigHash: HASH,
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  runtimeDigest: HASH,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  evaluationOrder: z.literal("sequential-quiet-host"),
  settlementJournal: z.string().min(1),
  settlementJournalHash: HASH,
  capsules: z.array(CapsuleSmokeRow).min(1),
  aggregate: z.object({
    expectedCapsules: z.number().int().positive(),
    passedCapsules: z.number().int().positive(),
    allChildrenValid: z.literal(true),
    fullPanel: z.literal(true),
    normalizedGain: z.number().finite(),
  }).strict(),
  dispatch: z.object({
    modelCalls: z.literal(0),
    providerCalls: z.literal(0),
    mutationUsageRecords: z.literal(0),
    proxyTraceRecords: z.literal(0),
    tokens: z.literal(0),
    usd: z.literal(0),
  }).strict(),
  ignitionEligible: z.literal(true),
}).strict();

const PanelCapsuleSmokeReceipt = PanelCapsuleSmokeReceiptBody.extend({
  receiptDigest: HASH,
}).strict();
export type PanelCapsuleSmokeReceipt = z.infer<typeof PanelCapsuleSmokeReceipt>;

export interface CapsuleSmokeLocation {
  readonly dir: string;
  readonly digest: string;
  readonly executionImage: string;
}

export interface RunPanelCapsuleSmokeRequest {
  readonly root: string;
  readonly config: RecursiveMetaCampaignConfig;
  readonly sourceCommit: string;
  readonly runtimeDigest: Sha256Digest;
  readonly evidencePath: string;
  readonly capsules: ReadonlyMap<string, CapsuleSmokeLocation>;
}

function sha256(bytes: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function panelCapsuleSmokeReceiptDigest(
  body: z.infer<typeof PanelCapsuleSmokeReceiptBody>,
): Sha256Digest {
  return sha256(canonicalJson(body));
}

export function panelCapsuleSmokeReceiptPath(root: string, configHash: Sha256Digest): string {
  return join(
    runsRoot(root),
    `pre-ignition-${configHash.slice("sha256:".length)}`,
    "panel-capsule-smoke.v1.json",
  );
}

export function assertPanelCapsuleSmokeEligibility(
  configInput: RecursiveMetaCampaignConfig,
  rowsInput: readonly CapsuleSmokeRow[],
  dispatch: {
    readonly modelCalls: number;
    readonly providerCalls: number;
    readonly mutationUsageRecords: number;
    readonly proxyTraceRecords: number;
    readonly tokens: number;
    readonly usd: number;
  },
): { normalizedGain: number } {
  const config = MetaCampaignConfigV2.parse(configInput);
  if (
    dispatch.modelCalls !== 0
    || dispatch.providerCalls !== 0
    || dispatch.mutationUsageRecords !== 0
    || dispatch.proxyTraceRecords !== 0
    || dispatch.tokens !== 0
    || dispatch.usd !== 0
  ) {
    throw new UsageError(`panel capsule smoke observed dispatch or spend: ${canonicalJson(dispatch)}`);
  }
  const rows = rowsInput.map((row) => CapsuleSmokeRow.parse(row));
  const expected = new Map(
    config.developmentPanel.members.map((member) => [member.capsule.capsuleId, member] as const),
  );
  if (rows.length !== expected.size) {
    throw new UsageError(`panel capsule smoke settled ${rows.length}/${expected.size} capsules`);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const member = expected.get(row.capsuleId);
    if (member === undefined) throw new UsageError(`panel capsule smoke returned non-panel capsule ${row.capsuleId}`);
    if (seen.has(row.capsuleId)) throw new UsageError(`panel capsule smoke duplicated capsule ${row.capsuleId}`);
    seen.add(row.capsuleId);
    if (
      row.taskId !== member.taskId
      || row.capsuleDigest !== member.capsule.capsuleDigest
      || row.image !== member.capsule.image
    ) {
      throw new UsageError(`panel capsule smoke identity drift for ${row.capsuleId}`);
    }
  }
  const normalizedGain = rows.reduce((sum, row) => sum + row.settlement.qNormalized, 0) / rows.length;
  if (!Number.isFinite(normalizedGain)) throw new UsageError("panel capsule smoke aggregate is not finite");
  return { normalizedGain };
}

export function readPanelCapsuleSmokeReceipt(path: string): PanelCapsuleSmokeReceipt {
  let parsed: PanelCapsuleSmokeReceipt;
  try {
    parsed = PanelCapsuleSmokeReceipt.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new UsageError(
      `panel capsule smoke receipt ${path} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { receiptDigest: recorded, ...body } = parsed;
  const expected = panelCapsuleSmokeReceiptDigest(PanelCapsuleSmokeReceiptBody.parse(body));
  if (recorded !== expected) {
    throw new UsageError(`panel capsule smoke receipt digest ${recorded} does not match ${expected}`);
  }
  return parsed;
}

export function assertRequiredPanelCapsuleSmoke(
  root: string,
  configInput: RecursiveMetaCampaignConfig,
): PanelCapsuleSmokeReceipt | undefined {
  const config = MetaCampaignConfigV2.parse(configInput);
  if (config.preIgnitionGates?.panelCapsuleSmoke.required !== true) return undefined;
  const configHash = metaCampaignConfigHash(config) as Sha256Digest;
  const path = panelCapsuleSmokeReceiptPath(root, configHash);
  const receipt = readPanelCapsuleSmokeReceipt(path);
  if (
    receipt.campaignConfigHash !== configHash
    || receipt.sourceCommit !== config.trustedRuntime.sourceCommit
    || receipt.runtimeDigest !== config.trustedRuntime.digest
  ) {
    throw new UsageError("panel capsule smoke receipt belongs to a different frozen runtime");
  }
  if (sha256(readFileSync(receipt.settlementJournal)) !== receipt.settlementJournalHash) {
    throw new UsageError("panel capsule smoke settlement journal digest does not match");
  }
  const eligibility = assertPanelCapsuleSmokeEligibility(config, receipt.capsules, receipt.dispatch);
  if (eligibility.normalizedGain !== receipt.aggregate.normalizedGain) {
    throw new UsageError("panel capsule smoke aggregate does not match its durable settlements");
  }
  return receipt;
}

export async function runPanelCapsuleSmoke(
  request: RunPanelCapsuleSmokeRequest,
): Promise<{ receipt: PanelCapsuleSmokeReceipt; guardPath: string }> {
  const config = MetaCampaignConfigV2.parse(request.config);
  const configHash = metaCampaignConfigHash(config) as Sha256Digest;
  if (config.preIgnitionGates?.panelCapsuleSmoke.required !== true) {
    throw new UsageError("frozen campaign does not require the panel capsule smoke gate");
  }
  if (
    request.sourceCommit !== config.trustedRuntime.sourceCommit
    || request.runtimeDigest !== config.trustedRuntime.digest
  ) {
    throw new UsageError("panel capsule smoke must execute from the exact frozen runtime");
  }

  const guardPath = panelCapsuleSmokeReceiptPath(request.root, configHash);
  mkdirSync(dirname(guardPath), { recursive: true, mode: 0o700 });
  rmSync(guardPath, { force: true });
  for (const entry of readdirSync(dirname(guardPath), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("attempt-")) {
      rmSync(join(dirname(guardPath), entry.name), { recursive: true, force: true });
    }
  }
  const attemptId = randomUUID().replaceAll("-", "");
  const attemptRoot = join(dirname(guardPath), `attempt-${attemptId}`);
  mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
  chmodSync(attemptRoot, 0o700);
  const journalPath = join(attemptRoot, "settlements.ndjson");
  const journal = MetaJournalV1.open(journalPath, config);
  const startedAt = new Date().toISOString();
  let observedTokens = 0;
  let observedUsd = 0;
  let observedMutationUsageRecords = 0;
  let observedModelCalls = 0;
  let observedProviderCalls = 0;
  let observedProxyTraceRecords = 0;
  const rows: CapsuleSmokeRow[] = [];

  try {
    // Sequential execution is deliberate. Unknown/historical evaluators may
    // retain the shared uid-2000 FIFO, and simultaneous real evaluators make a
    // noisy host a conformance variable rather than a measured input.
    for (const [ordinal, member] of config.developmentPanel.members.entries()) {
      const location = request.capsules.get(member.capsule.capsuleDigest);
      if (location === undefined) {
        throw new UsageError(`panel capsule ${member.capsule.capsuleId} is not installed`);
      }
      if (
        location.digest !== member.capsule.capsuleDigest
        || location.executionImage !== member.capsule.image
      ) {
        throw new UsageError(`panel capsule ${member.capsule.capsuleId} resolved to a foreign identity`);
      }
      const manifest = CapsuleManifest.parse(
        JSON.parse(readFileSync(join(location.dir, "manifest.json"), "utf8")),
      );
      if (manifest.id !== member.capsule.capsuleId || capsuleDigest(manifest) !== location.digest) {
        throw new UsageError(`panel capsule ${member.capsule.capsuleId} manifest identity drift`);
      }
      const train = manifest.assetGroups.find((group) => group.id === "train");
      if (train === undefined || train.visibility === "holdout") {
        throw new UsageError(`panel capsule ${member.capsule.capsuleId} has no public train asset group`);
      }

      const capsuleRoot = join(attemptRoot, `${String(ordinal).padStart(2, "0")}-${manifest.id}`);
      const casDir = join(capsuleRoot, "cas");
      mkdirSync(capsuleRoot, { recursive: true, mode: 0o700 });
      const cas = new CasStore(casDir);
      const candidateArtifact = await measureBaseline(location.dir, manifest, cas) as Sha256Digest;
      const archiveBytes = (await cas.readBuffer(candidateArtifact)).length;
      const negativeWorkspace = await unpackArtifact(
        cas,
        candidateArtifact,
        join(capsuleRoot, "negative-unpacked"),
      );
      appendFileSync(join(negativeWorkspace, "eval.py"), "\n# panel smoke protected-path control\n");
      const protectedPathArtifact = await packDirAsArtifact(negativeWorkspace, cas) as Sha256Digest;
      const optimizerDigest = sha256(`campaign-panel-capsule-smoke:${configHash}:${manifest.id}`);
      const events: RunEvent[] = [];
      const broker = new Broker({
        runId: `run_panel_smoke_${manifest.id.slice("cap_".length)}_${attemptId.slice(0, 12)}`,
        manifest,
        capsuleRootDir: location.dir,
        baselineArtifactHash: candidateArtifact,
        admittedCapsuleDigest: location.digest,
        optimizerDigest,
        measurementEpoch: `panel-smoke:${configHash}:${manifest.id}`,
        holdoutLedgerPath: join(capsuleRoot, "holdout.ndjson"),
        executionImage: location.executionImage,
        runDir: join(capsuleRoot, "run"),
        casDir,
        evalTimeoutSec: config.evaluatorTimeoutSec,
        onEvent: (event) => events.push(event),
      });
      let budgetSpent: { tokens: number; usd: number };
      let evaluation: z.infer<typeof EvaluationRecord>;
      try {
        await broker.init();
        evaluation = await broker.evaluate(
          { artifact: { hash: candidateArtifact }, assetGroupId: train.id, seed: 0 },
          { privileged: true },
        );
        let protectedPathRejected = false;
        try {
          await broker.evaluate(
            { artifact: { hash: protectedPathArtifact }, assetGroupId: train.id, seed: 0 },
            { privileged: true },
          );
        } catch (error) {
          protectedPathRejected = error instanceof BrokerError && error.code === "PROTECTED_PATH_VIOLATION";
        }
        if (!protectedPathRejected) {
          throw new UsageError(`panel capsule ${manifest.id} accepted the protected-path control`);
        }
        const budget = broker.getBudget({ privileged: true });
        budgetSpent = { tokens: budget.spent.tokens, usd: budget.spent.usd ?? 0 };
        observedTokens += budgetSpent.tokens;
        observedUsd += budgetSpent.usd;
      } finally {
        await broker.close();
      }
      const isolations = events.filter((event) => event.type === "evaluator.isolation");
      const isolation = isolations[0];
      if (isolation === undefined || isolations.length !== 1) {
        throw new UsageError(`panel capsule ${manifest.id} did not traverse exactly one evaluator isolation`);
      }
      const objectives = Object.values(evaluation.output.objectives);
      const score = objectives[0];
      if (
        evaluation.cached
        || !evaluation.output.valid
        || !Object.values(evaluation.output.constraints).every(Boolean)
        || objectives.length !== 1
        || score === undefined
        || !Number.isFinite(score)
        || evaluation.costUsd !== 0
      ) {
        throw new UsageError(`panel capsule ${manifest.id} did not produce one fresh valid finite zero-cost score`);
      }

      const identity = {
        phase: "search" as const,
        arm: "candidate" as const,
        sourceArtifact: candidateArtifact,
        bundleDigest: optimizerDigest,
        capsuleId: manifest.id,
        replicate: 0,
        measurementEpoch: `panel-smoke-${ordinal}`,
      };
      journal.reserveChild(identity, {
        purpose: "search",
        envelope: config.recursiveBudgets.search.identity,
        reservationId: `panel-smoke-${attemptId}-${ordinal}`,
        parentReservationId: null,
        reserved: member.calibratedInnerCeiling,
      });
      const recordHash = sha256(canonicalJson(EvaluationRecord.parse(evaluation)));
      const measurement = journal.settleChild(identity, {
        evidenceHash: recordHash,
        observed: {
          tokens: budgetSpent.tokens,
          usd: budgetSpent.usd,
          wallClockSec: evaluation.durationMs / 1000,
          evaluatorInvocations: 1,
        },
        qRaw: score,
        responseModel: "synthetic-zero-dispatch",
        providerFingerprint: null,
        modelDriftSentinel: "synthetic-zero-dispatch",
      });
      rows.push(CapsuleSmokeRow.parse({
        taskId: member.taskId,
        capsuleId: manifest.id,
        capsuleDigest: location.digest,
        image: location.executionImage,
        candidateArtifact,
        conformance: {
          passed: true,
          archiveBytes,
          protectedPathControl: "PROTECTED_PATH_VIOLATION",
        },
        isolation: isolation.isolation,
        evaluation: {
          valid: true,
          constraintsPassed: true,
          score,
          costUsd: 0,
          durationMs: evaluation.durationMs,
          recordHash,
        },
        settlement: {
          kind: "measurement",
          workKey: measurement.workKey,
          childRunId: measurement.childRunId,
          qNormalized: measurement.qNormalized,
        },
      }));
    }
  } finally {
    journal.close();
  }

  const inspectDispatchRecords = (root: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        inspectDispatchRecords(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ndjson")) continue;
      const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
      if (entry.name.includes("proxy-dispatch") || entry.name.includes("proxy-trace")) {
        observedProxyTraceRecords += lines.length;
        observedProviderCalls += lines.length;
      }
      for (const line of lines) {
        try {
          const record: unknown = JSON.parse(line);
          if (record === null || typeof record !== "object" || !("modelCalls" in record)) continue;
          const usage = record as { modelCalls?: unknown; providerCalls?: unknown };
          if (typeof usage.modelCalls !== "number" || typeof usage.providerCalls !== "number") continue;
          observedMutationUsageRecords += 1;
          observedModelCalls += usage.modelCalls;
          observedProviderCalls += usage.providerCalls;
        } catch {
          // Non-JSON diagnostics carry no dispatch authority.
        }
      }
    }
  };
  inspectDispatchRecords(attemptRoot);
  const dispatch = {
    modelCalls: observedModelCalls,
    providerCalls: observedProviderCalls,
    mutationUsageRecords: observedMutationUsageRecords,
    proxyTraceRecords: observedProxyTraceRecords,
    tokens: observedTokens,
    usd: observedUsd,
  };
  const { normalizedGain } = assertPanelCapsuleSmokeEligibility(config, rows, dispatch);
  const completedAt = new Date().toISOString();
  const body = PanelCapsuleSmokeReceiptBody.parse({
    version: 1,
    type: "campaign-panel-capsule-smoke.v1",
    campaignConfigHash: configHash,
    sourceCommit: request.sourceCommit,
    runtimeDigest: request.runtimeDigest,
    startedAt,
    completedAt,
    evaluationOrder: "sequential-quiet-host",
    settlementJournal: journalPath,
    settlementJournalHash: sha256(readFileSync(journalPath)),
    capsules: rows,
    aggregate: {
      expectedCapsules: config.developmentPanel.members.length,
      passedCapsules: rows.length,
      allChildrenValid: true,
      fullPanel: true,
      normalizedGain,
    },
    dispatch,
    ignitionEligible: true,
  });
  const receipt = PanelCapsuleSmokeReceipt.parse({
    ...body,
    receiptDigest: panelCapsuleSmokeReceiptDigest(body),
  });
  const bytes = `${canonicalJson(receipt)}\n`;
  const evidencePath = resolve(request.evidencePath);
  mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 });
  writeFileDurable(evidencePath, bytes);
  chmodSync(evidencePath, 0o600);
  if (evidencePath !== resolve(guardPath)) {
    writeFileDurable(guardPath, bytes);
    chmodSync(guardPath, 0o600);
  }
  if (!existsSync(guardPath)) {
    throw new UsageError(`panel capsule smoke failed to publish ignition guard ${basename(guardPath)}`);
  }
  assertRequiredPanelCapsuleSmoke(request.root, config);
  return { receipt, guardPath };
}
