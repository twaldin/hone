import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MetaCampaignConfigV2,
  canonicalJson,
  RunEvent,
  type BudgetEnvelope,
  type CapsuleManifest,
  type EvaluationRecord,
  type SpawnRunParams,
} from "@hone/schema";
import {
  MetaEnvelopeFileRecordPortV1,
  MetaResourceEnvelopeLedger,
  type MetaChildRunOutcome,
  type MetaChildRunRequest,
  type Sha256Digest,
} from "@hone/meta";
import { Broker, RecursiveResourceLedger } from "@hone/broker";
import {
  RecursiveSearchChildLauncher,
  type CliChildSupervisor,
} from "../src/commands/hone.js";
import {
  MetaJournalV1,
  metaCampaignConfigHash,
  metaWorkKey,
  type MetaWorkIdentityV1,
} from "../src/meta-journal.js";
import type { CampaignPauseAuthority } from "../src/types.js";

/*
 * Preserved launch evidence, m2-exec-runtime-2, config bd7654d7…:
 * outer events cursors 0 run.started, 2 episode.started, 5 run.resumed;
 * child cursors 6 run.paused(provider-transport), 8 run.resumed;
 * meta-journal seq 1 reservation, seq 2 erroneous infrastructure_not_run
 * failure settlement. Replaying the child then raised exactly
 * `conflicting duplicate settlement for sha256:de507175…`.
 */
const frozenConfigPath = fileURLToPath(new URL(
  "../../../data/m2-refreeze-final/campaign-frozen-recursive-capacity.json",
  import.meta.url,
));
const pendingJournalFixturePath = fileURLToPath(new URL("./fixtures/pending-journal-process.ts", import.meta.url));
const cliPackageDir = fileURLToPath(new URL("../", import.meta.url));
const config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(frozenConfigPath, "utf8")));
const configHash = metaCampaignConfigHash(config) as Sha256Digest;
const member = config.developmentPanel.members[0]!;
const sourceArtifact = config.seedOptimizer.sourceArtifact as Sha256Digest;
const bundleDigest = config.seedOptimizer.bundleDigest as Sha256Digest;
const reservation: BudgetEnvelope = {
  maxTokens: 12_000_000,
  maxUsd: 25,
  maxWallClockSec: 10_800,
  maxEvaluatorInvocations: 200,
};
const schedule = { candidateOrdinal: 0, allocationOrdinal: 0, innerEpisodesMax: 4 } as const;
const identity: MetaWorkIdentityV1 = {
  phase: "search",
  arm: "candidate",
  sourceArtifact,
  bundleDigest,
  capsuleId: member.capsule.capsuleId,
  replicate: 0,
  measurementEpoch: `m2:${digest(canonicalJson({
    candidateOrdinal: schedule.candidateOrdinal,
    allocationOrdinal: schedule.allocationOrdinal,
    innerEpisodesMax: schedule.innerEpisodesMax,
    reserved: reservation,
  })).slice("sha256:".length)}`,
};
const workKey = metaWorkKey(configHash, identity);
const childRunId = `run_meta_${workKey.slice("sha256:".length)}`;
const request: SpawnRunParams = {
  child: {
    runId: childRunId,
    capsuleId: member.capsule.capsuleId,
    sourceArtifact: { hash: sourceArtifact },
    optimizerArtifact: { hash: bundleDigest },
    purpose: "capsule",
    schedule,
  },
  depth: 1,
  reservation,
};
const CLIENT = { privileged: false } as const;
const FIRST_SPEND = { tokens: 0, usd: 0, wallClockSec: 57.484, evaluatorInvocations: 1 };
const FULL_SPEND = { tokens: 23, usd: 0.5, wallClockSec: 83.75, evaluatorInvocations: 2 };
const OUTER_RUN_ID = "run_recursive_outer_settlement_replay";
const OUTER_CAPSULE_ID = "cap_8045fe577441";
const IMAGE = `hone-test@sha256:${"9".repeat(64)}`;
const CONTRACT = digest("settlement-replay-contract");
const INITIAL_EVENTS: RunEvent[] = [
  {
    runId: childRunId,
    at: "2026-08-23T15:00:54.059Z",
    type: "run.started",
    capsuleId: member.capsule.capsuleId,
    contractHash: CONTRACT,
    optimizerDigest: bundleDigest,
    checkpointVersion: 1,
    campaignConfigHash: configHash,
  },
  {
    runId: childRunId,
    at: "2026-08-23T15:00:56.033Z",
    type: "budget.snapshot",
    budget: { envelope: reservation, spent: { ...FIRST_SPEND, wallClockSec: 1.974 }, lifetimeSec: 1.974 },
  },
  {
    runId: childRunId,
    at: "2026-08-23T15:01:05.869Z",
    type: "episode.started",
    episode: 0,
    parent: { hash: sourceArtifact },
  },
  {
    runId: childRunId,
    at: "2026-08-23T15:01:06.154Z",
    type: "budget.snapshot",
    budget: { envelope: reservation, spent: { ...FIRST_SPEND, wallClockSec: 12.095 }, lifetimeSec: 12.095 },
  },
  {
    runId: childRunId,
    at: "2026-08-23T15:01:08.246Z",
    type: "eval.completed",
    artifact: { hash: sourceArtifact },
    assetGroupId: "train",
    seed: 0,
    aggregate: member.capsule.qBase,
    cached: false,
  },
];
const PAUSE_EVENTS: RunEvent[] = [
  {
    runId: childRunId,
    at: "2026-08-23T15:01:51.538Z",
    type: "run.paused",
    reason: "provider-transport",
    pauseId: "pause_settlement_replay",
    providerStatus: null,
  },
  {
    runId: childRunId,
    at: "2026-08-23T15:01:51.547Z",
    type: "budget.snapshot",
    budget: { envelope: reservation, spent: FIRST_SPEND, lifetimeSec: 57.488 },
  },
];
const RESUME_EVENTS: RunEvent[] = [
  {
    runId: childRunId,
    at: "2026-08-23T15:25:37.361Z",
    type: "run.resumed",
    fromCursor: INITIAL_EVENTS.length + PAUSE_EVENTS.length,
  },
  {
    runId: childRunId,
    at: "2026-08-23T15:25:39.947Z",
    type: "budget.snapshot",
    budget: { envelope: reservation, spent: FULL_SPEND, lifetimeSec: 1485.888 },
  },
  {
    runId: childRunId,
    at: "2026-08-23T15:25:41.000Z",
    type: "run.finished",
    status: "completed",
  },
];

const fixtureChildSource = String.raw`
const fs = require("node:fs");
const [eventPath, gatewayUrl, mode, initial64, paused64, resumed64] = process.argv.slice(1);
const initial = JSON.parse(Buffer.from(initial64, "base64").toString("utf8"));
const paused = JSON.parse(Buffer.from(paused64, "base64").toString("utf8"));
const resumed = JSON.parse(Buffer.from(resumed64, "base64").toString("utf8"));
function append(event) {
  const fd = fs.openSync(eventPath, "a", 0o600);
  try {
    fs.writeSync(fd, Buffer.from(JSON.stringify(event) + "\n"), null);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
async function main() {
  if (mode !== "resume") for (const event of initial) append(event);
  try {
    const response = await fetch(gatewayUrl);
    if (!response.ok) throw new Error("gateway returned " + response.status);
    for (const event of resumed) append(event);
  } catch {
    for (const event of paused) append(event);
    fs.writeSync(1, "PAUSED\n");
    if (mode === "pause-hold") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    process.exitCode = 23;
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
`;

function digest(value: string | Buffer): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function eventFacts(path: string): RunEvent[] {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => RunEvent.parse(JSON.parse(line)));
}

function journalFacts(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function reserveGatewayPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("gateway did not bind a TCP port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function startGateway(port: number): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}\n");
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function stopGateway(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

async function runFixtureChild(
  eventPath: string,
  gatewayUrl: string,
  mode: "pause" | "pause-hold" | "resume" | "complete",
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = spawn(process.execPath, [
    "-e",
    fixtureChildSource,
    eventPath,
    gatewayUrl,
    mode,
    encoded(INITIAL_EVENTS),
    encoded(PAUSE_EVENTS),
    encoded(RESUME_EVENTS),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  if (mode === "pause-hold") {
    await waitForChildOutput(child, "PAUSED\n");
    child.kill("SIGKILL");
  }
  const [code, signal] = await closed;
  if ((mode === "resume" || mode === "complete") && code !== 0) {
    throw new Error(`fixture child resume failed ${code}/${signal}: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  if (mode === "pause" && code !== 23) {
    throw new Error(`fixture child pause failed ${code}/${signal}: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  if (mode === "pause-hold" && signal !== "SIGKILL") {
    throw new Error(`fixture child was not killed: ${code}/${signal}`);
  }
  return { code, signal };
}

async function waitForChildOutput(child: ChildProcess, marker: string): Promise<void> {
  const stdout = child.stdout;
  if (stdout === null) throw new Error("fixture child has no stdout");
  const { promise, resolve, reject } = Promise.withResolvers!<void>();
  let text = "";
  const onData = (chunk: Buffer): void => {
    text += chunk.toString("utf8");
    if (text.includes(marker)) {
      stdout.off("data", onData);
      resolve();
    }
  };
  stdout.on("data", onData);
  child.once("error", reject);
  child.once("close", (code, signal) => reject(new Error(`fixture child exited before ${marker.trim()} ${code}/${signal}`)));
  await promise;
}

async function killPendingJournalProcess(root: string): Promise<NodeJS.Signals | null> {
  const journalPath = join(root, "campaign", "meta-journal.ndjson");
  const facts = journalFacts(journalPath);
  const reservationFact = facts.find((fact) => fact["t"] === "reservation") as {
    reservation?: { identity?: unknown; envelope?: unknown };
  } | undefined;
  const pendingFact = facts.find((fact) => fact["t"] === "pending") as {
    pending?: { evidenceHash?: unknown; observed?: unknown };
  } | undefined;
  if (
    reservationFact?.reservation?.identity === undefined
    || reservationFact.reservation.envelope === undefined
    || pendingFact?.pending?.evidenceHash === undefined
    || pendingFact.pending.observed === undefined
  ) {
    throw new Error("pending replay fixture could not recover the durable reservation");
  }
  const payload = {
    configPath: frozenConfigPath,
    journalPath,
    identity: reservationFact.reservation.identity,
    envelope: reservationFact.reservation.envelope,
    pending: {
      evidenceHash: pendingFact.pending.evidenceHash,
      observed: pendingFact.pending.observed,
    },
  };
  const child = spawn(process.execPath, ["--import", "tsx", pendingJournalFixturePath], {
    cwd: cliPackageDir,
    env: {
      ...process.env,
      HONE_PENDING_REPLAY_FIXTURE: Buffer.from(JSON.stringify(payload)).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  await waitForChildOutput(child, "PENDING-REPLAYED\n");
  child.kill("SIGKILL");
  const [code, signal] = await closed;
  if (signal !== "SIGKILL") {
    throw new Error(`journal fixture was not killed ${code}/${signal}: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  return signal;
}

function finalEvaluation(qRaw: number): EvaluationRecord {
  return {
    capsuleId: member.capsule.capsuleId,
    artifactHash: sourceArtifact,
    assetGroupId: "train",
    seed: 0,
    output: {
      valid: true,
      objectives: { score: qRaw },
      constraints: { tests_pass: true },
      perExample: {},
      diagnostics: { summary: "fixture child completed after provider recovery" },
    },
    costUsd: FULL_SPEND.usd,
    durationMs: FULL_SPEND.wallClockSec * 1000,
    cached: false,
    evaluatedAt: "2026-08-23T15:25:40.000Z",
  };
}

class GatewayChildSupervisor {
  readonly kills: Array<NodeJS.Signals | null> = [];

  constructor(
    private readonly root: string,
    private readonly gatewayUrl: string,
    private readonly phase: "pause" | "pause-hold" | "resume" | "complete" | "unknown",
    private readonly qRaw = member.capsule.qBase + member.capsule.scale * 0.25,
  ) {}

  async runLaunched(childRequest: MetaChildRunRequest): Promise<MetaChildRunOutcome> {
    const runDir = join(this.root, ".hone-runs", childRequest.reservation.childRunId);
    mkdirSync(runDir, { recursive: true });
    const eventPath = join(runDir, "events.ndjson");
    const exited = this.phase === "unknown"
      ? { signal: null }
      : await runFixtureChild(eventPath, this.gatewayUrl, this.phase);
    this.kills.push(exited.signal);
    if (this.phase === "unknown") writeFileSync(eventPath, "{\"runId\":\n", { mode: 0o600 });
    const bytes = readFileSync(eventPath);
    const events = this.phase === "unknown" ? [] : eventFacts(eventPath);
    const completed = events.at(-1)?.type === "run.finished";
    const evaluation = completed ? finalEvaluation(this.qRaw) : null;
    return {
      status: completed ? "completed" : "infrastructure_not_run",
      childRunId: childRequest.reservation.childRunId,
      measurementEpoch: childRequest.identity.measurementEpoch,
      capsuleId: childRequest.identity.capsuleId,
      sourceArtifact: childRequest.sourceArtifact,
      bundleDigest: childRequest.bundleDigest,
      runtimeBundleDigest: bundleDigest,
      baselineArtifactHash: sourceArtifact,
      bestArtifactHash: completed ? sourceArtifact : null,
      finalEvaluation: evaluation,
      finalEvaluationHash: evaluation === null ? null : digest(canonicalJson(evaluation)),
      spend: completed ? FULL_SPEND : FIRST_SPEND,
      eventLogHash: digest(bytes),
      eventLogCursor: events.length,
      proxyTraceHash: null,
      brokerJournalHash: completed ? digest("completed-broker-journal") : digest("paused-broker-journal"),
      responseModel: completed ? config.routing.innerMutation : null,
      providerFingerprint: completed ? "fixture-provider" : null,
      modelDriftSentinel: completed ? `start=${config.routing.innerMutation};end=${config.routing.innerMutation}` : null,
      feedback: completed ? "child completed after provider recovery" : "child has no durable terminal event",
    };
  }
}

interface OpenRuntime {
  broker: Broker;
  journal: MetaJournalV1;
  envelopePort: MetaEnvelopeFileRecordPortV1;
  recursiveLedger: RecursiveResourceLedger;
  launcher: RecursiveSearchChildLauncher;
  close(): Promise<void>;
}

function outerManifest(root: string): CapsuleManifest {
  const content = "recursive settlement replay\n";
  const trainDir = join(root, "outer-capsule", "train");
  mkdirSync(trainDir, { recursive: true });
  writeFileSync(join(trainDir, "data.txt"), content);
  return {
    schemaVersion: 2,
    id: OUTER_CAPSULE_ID,
    objective: "recursive settlement replay fixture",
    baseline: { kind: "cas", hash: sourceArtifact },
    image: IMAGE,
    evalEntrypoint: ["true"],
    protectedPaths: [],
    diagnosticOrdering: { path: "diagnostics/ordering.json", hash: digest("ordering") },
    assetGroups: [{ id: "train", visibility: "public", paths: ["train"] }],
    budget: config.budgets.outer,
    contentHashes: { "train/data.txt": digest(content) },
  };
}

function openRuntime(root: string, supervisor: GatewayChildSupervisor): OpenRuntime {
  const campaignDir = join(root, "campaign");
  mkdirSync(campaignDir, { recursive: true });
  const journal = MetaJournalV1.open(join(campaignDir, "meta-journal.ndjson"), config);
  const envelopePort = MetaEnvelopeFileRecordPortV1.open(
    join(campaignDir, "resource-envelope.v1.ndjson"),
    configHash,
  );
  const envelopeLedger = new MetaResourceEnvelopeLedger(config.recursiveBudgets, envelopePort);
  const authority: CampaignPauseAuthority = {
    isCampaignPaused: () => false,
    captureCampaignDispatchFence: () => ({ epoch: "running", paused: false }),
    validateCampaignDispatchFence: () => true,
    recordCampaignPause: () => {},
    recordCampaignResume: () => {},
  };
  const launcher = new RecursiveSearchChildLauncher(
    root,
    campaignDir,
    config,
    configHash,
    journal,
    { check: async () => ({ ok: true, sourceArtifact, bundleDigest, transformationReceiptHash: null, feedback: "accepted" }) },
    supervisor as unknown as CliChildSupervisor,
    envelopeLedger,
    authority,
  );
  const recursiveLedger = RecursiveResourceLedger.open(join(campaignDir, "recursive-resource.v1.ndjson"));
  const manifest = outerManifest(root);
  const runDir = join(root, ".hone-runs", OUTER_RUN_ID);
  mkdirSync(runDir, { recursive: true });
  const broker = new Broker({
    runId: OUTER_RUN_ID,
    manifest,
    capsuleRootDir: join(root, "outer-capsule"),
    baselineArtifactHash: sourceArtifact,
    capsuleDigest: digest("outer-capsule"),
    optimizerDigest: bundleDigest,
    evaluationStrategy: launcher.evaluationStrategy(),
    holdoutLedgerPath: join(runDir, "holdout-ledger.ndjson"),
    image: IMAGE,
    runDir,
    casDir: join(root, ".hone-cas"),
    onEvent: () => {},
    now: () => 0,
    recursive: launcher.brokerConfig(recursiveLedger),
  });
  return {
    broker,
    journal,
    envelopePort,
    recursiveLedger,
    launcher,
    async close(): Promise<void> {
      await broker.close();
      journal.close();
      envelopePort.close();
      recursiveLedger.close();
    },
  };
}

async function exercisePauseResume(killDuringPause: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hone-settlement-replay-"));
  const port = await reserveGatewayPort();
  const gatewayUrl = `http://127.0.0.1:${port}/v1/responses`;
  const pausedSupervisor = new GatewayChildSupervisor(root, gatewayUrl, killDuringPause ? "pause-hold" : "pause");
  let initial = openRuntime(root, pausedSupervisor);
  await expect(initial.broker.spawnRun(request, CLIENT)).rejects.toThrow(
    `child ${childRunId} has no durable terminal event`,
  );
  expect(initial.recursiveLedger.budgetState(OUTER_RUN_ID)).toMatchObject({
    reservations: 1,
    openReservations: 1,
  });
  const pausedMetaFacts = journalFacts(join(root, "campaign", "meta-journal.ndjson"));
  expect(pausedMetaFacts.map((fact) => fact["t"])).toEqual(["header", "reservation", "pending"]);
  const pausedEnvelopeFacts = journalFacts(join(root, "campaign", "resource-envelope.v1.ndjson"));
  expect(pausedEnvelopeFacts.filter((fact) => fact["type"] === "reservation")).toHaveLength(1);
  expect(pausedEnvelopeFacts.filter((fact) => fact["type"] === "settlement")).toHaveLength(0);
  await initial.close();
  if (killDuringPause) {
    expect(pausedSupervisor.kills).toEqual(["SIGKILL"]);
    expect(await killPendingJournalProcess(root)).toBe("SIGKILL");
  }

  const gateway = await startGateway(port);
  try {
    const resumedSupervisor = new GatewayChildSupervisor(root, gatewayUrl, "resume");
    const resumed = openRuntime(root, resumedSupervisor);
    initial = resumed;
    try {
      const result = await resumed.broker.spawnRun(request, CLIENT);
      expect(result.usage).toEqual(FULL_SPEND);
      expect(result.terminal.status).toBe("completed");
      expect(resumed.recursiveLedger.budgetState(OUTER_RUN_ID)).toMatchObject({
        reservations: 1,
        openReservations: 0,
      });
    } finally {
      await resumed.close();
    }
  } finally {
    await stopGateway(gateway);
  }

  const metaFacts = journalFacts(join(root, "campaign", "meta-journal.ndjson"));
  expect(metaFacts.map((fact) => fact["t"])).toEqual([
    "header",
    "reservation",
    "pending",
    "settlement",
    "measurement",
  ]);
  expect(metaFacts.filter((fact) => fact["t"] === "failure-settlement")).toHaveLength(0);
  const pending = metaFacts.find((fact) => fact["t"] === "pending") as { pending?: { observed?: unknown } } | undefined;
  expect(pending?.pending?.observed).toEqual(FIRST_SPEND);
  const terminal = metaFacts.find((fact) => fact["t"] === "settlement") as { measurement?: { observed?: unknown } } | undefined;
  expect(terminal?.measurement?.observed).toEqual(FULL_SPEND);

  const envelopeFacts = journalFacts(join(root, "campaign", "resource-envelope.v1.ndjson"));
  expect(envelopeFacts.filter((fact) => fact["type"] === "reservation")).toHaveLength(1);
  const envelopeSettlement = envelopeFacts.filter((fact) => fact["type"] === "settlement");
  expect(envelopeSettlement).toHaveLength(1);
  expect(envelopeSettlement[0]?.["observed"]).toEqual(FULL_SPEND);

  const childEvents = eventFacts(join(root, ".hone-runs", childRunId, "events.ndjson"));
  expect(childEvents.filter((event) => event.type === "episode.started")).toHaveLength(1);
  expect(childEvents.filter((event) => event.type === "run.paused")).toHaveLength(1);
  expect(childEvents.filter((event) => event.type === "run.resumed")).toHaveLength(1);
  expect(childEvents.filter((event) => event.type === "run.finished")).toHaveLength(1);
  expect(childEvents.at(-1)).toMatchObject({ type: "run.finished", status: "completed" });

  const recursiveFacts = journalFacts(join(root, "campaign", "recursive-resource.v1.ndjson"));
  expect(recursiveFacts.filter((fact) => fact["t"] === "reservation")).toHaveLength(1);
  expect(recursiveFacts.filter((fact) => fact["t"] === "settlement")).toHaveLength(1);
  expect(recursiveFacts.filter((fact) => fact["t"] === "usage" && fact["runId"] === childRunId)).toHaveLength(1);
}

describe("recursive child nonterminal settlement replay", () => {
  it("replays provider gateway absence into one full terminal settlement after recovery", { timeout: 30_000 }, async () => {
    expect(configHash).toBe("sha256:bd7654d7c2967fdcb01131cf29507e0286762d3c2e452185f1840c1aa102d300");
    expect(workKey).toBe("sha256:de50717555fa81039f155e7a9df2efcbde237def09a84c3c258e620747963973");
    await exercisePauseResume(false);
  });

  it("replays the nonterminal journal after SIGKILL between pause and resume", { timeout: 30_000 }, async () => {
    await exercisePauseResume(true);
  });

  it("records an unreplayable child as pending without minting a terminal settlement", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "hone-unknown-child-"));
    const supervisor = new GatewayChildSupervisor(root, "http://127.0.0.1:1/v1/responses", "unknown");
    const runtime = openRuntime(root, supervisor);
    try {
      await expect(runtime.broker.spawnRun(request, CLIENT)).rejects.toThrow(/child .* event stream is corrupt at cursor 0/);
      expect(runtime.journal.queryPendingChildren()).toHaveLength(1);
      expect(runtime.journal.queryFailureSettlements()).toEqual([]);
      expect(runtime.journal.queryTrainMeasurements()).toEqual([]);
      const envelopeFacts = journalFacts(join(root, "campaign", "resource-envelope.v1.ndjson"));
      expect(envelopeFacts.filter((fact) => fact["type"] === "reservation")).toHaveLength(1);
      expect(envelopeFacts.filter((fact) => fact["type"] === "settlement")).toHaveLength(0);
      const recursiveFacts = journalFacts(join(root, "campaign", "recursive-resource.v1.ndjson"));
      expect(recursiveFacts.filter((fact) => fact["t"] === "reservation")).toHaveLength(1);
      expect(recursiveFacts.filter((fact) => fact["t"] === "settlement")).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  // This pins child settlement only. Without a campaign pause authority, the top-level
  // supervisor still terminalizes the outer run after an unreplayable child event stream.
  it("keeps the genuine-terminal duplicate settlement refusal immutable", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "hone-terminal-settlement-"));
    const port = await reserveGatewayPort();
    const gateway = await startGateway(port);
    const gatewayUrl = `http://127.0.0.1:${port}/v1/responses`;
    const supervisor = new GatewayChildSupervisor(root, gatewayUrl, "complete");
    const runtime = openRuntime(root, supervisor);
    try {
      await runtime.broker.spawnRun(request, CLIENT);
      const admission = runtime.launcher.admitChildRun({ parentRunId: OUTER_RUN_ID, parentDepth: 0, request });
      if (admission === undefined) throw new Error("fixture child was not admitted");
      const conflicting = new GatewayChildSupervisor(root, gatewayUrl, "resume", member.capsule.qBase + member.capsule.scale * 0.75);
      const replayedLauncher = new RecursiveSearchChildLauncher(
        root,
        join(root, "campaign"),
        config,
        configHash,
        runtime.journal,
        { check: async () => ({ ok: true, sourceArtifact, bundleDigest, transformationReceiptHash: null, feedback: "accepted" }) },
        conflicting as unknown as CliChildSupervisor,
        new MetaResourceEnvelopeLedger(config.recursiveBudgets, runtime.envelopePort),
        {
          isCampaignPaused: () => false,
          captureCampaignDispatchFence: () => ({ epoch: "running", paused: false }),
          validateCampaignDispatchFence: () => true,
          recordCampaignPause: () => {},
          recordCampaignResume: () => {},
        },
      );
      await expect(replayedLauncher.launchChildRun({ request, admission, replay: true })).rejects.toThrow(
        `conflicting duplicate settlement for ${workKey}`,
      );
    } finally {
      await runtime.close();
      await stopGateway(gateway);
    }
  });
});
