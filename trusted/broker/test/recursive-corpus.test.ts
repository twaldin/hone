import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QueryCorpusParams,
  type BudgetEnvelope,
  type ChildRunAdmission,
  type CapsuleManifest,
  type CorpusPanelEvidence,
  type CorpusPublicDocument,
  type ResourceUsage,
  type RunEvent,
  type SpawnRunParams,
} from "@hone/schema";
import {
  Broker,
  RecursiveResourceLedger,
  hashChildRunLaunchReceipt,
  hashCorpusSnapshot,
  type BrokerConfig,
  type BrokerCorpusConfig,
  type ChildRunLauncher,
} from "../src/index.js";

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpBase = path.join(pkgDir, ".test-tmp", `recursive-${randomBytes(4).toString("hex")}`);
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const IMAGE = `test.invalid/hone@sha256:${"c".repeat(64)}`;
const CONFIG_HASH = `sha256:${"d".repeat(64)}`;
const ADMISSION: ChildRunAdmission = {
  campaignConfigHash: CONFIG_HASH,
  cohort: "panel-a",
  capsuleProvenanceHash: `sha256:${"e".repeat(64)}`,
  sourceProvenanceHash: HASH_A,
  optimizerProvenanceHash: HASH_B,
};
const ADMIT_CHILD = (): ChildRunAdmission => ({ ...ADMISSION });
const CLIENT = { privileged: false } as const;
const ADMIN = { privileged: true } as const;

const LARGE: BudgetEnvelope = {
  maxTokens: 200,
  maxUsd: 200,
  maxWallClockSec: 200,
  maxEvaluatorInvocations: 200,
};

const brokers: Broker[] = [];
const ledgers: RecursiveResourceLedger[] = [];
let capsuleRoot: string;
let sequence = 0;

function contentHash(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function manifest(budget: BudgetEnvelope): CapsuleManifest {
  return {
    schemaVersion: 2,
    id: "cap_0123456789ab",
    objective: "recursive security fixture",
    baseline: { kind: "cas", hash: HASH_A },
    image: IMAGE,
    evalEntrypoint: ["true"],
    protectedPaths: [],
    diagnosticOrdering: { path: "diagnostics/ordering.json", hash: HASH_B },
    assetGroups: [{ id: "train", visibility: "public", paths: ["train"] }],
    budget,
    contentHashes: { "train/data.txt": contentHash("train") },
  };
}

function childRequest(
  runId: string,
  depth: 1 | 2,
  reservation: BudgetEnvelope,
  purpose: "capsule" | "delegated" | "self-ab",
): SpawnRunParams {
  return {
    child: {
      runId,
      capsuleId: "cap_0123456789ab",
      sourceArtifact: { hash: HASH_A },
      optimizerArtifact: { hash: HASH_B },
      purpose,
    },
    depth,
    reservation,
  };
}

function makeBroker(options: {
  runId: string;
  budget: BudgetEnvelope;
  runDir?: string;
  recursive?: BrokerConfig["recursive"];
  corpus?: BrokerCorpusConfig;
  events?: RunEvent[];
}): Broker {
  const runDir = options.runDir ?? path.join(tmpBase, `run-${sequence++}`);
  const events = options.events ?? [];
  const broker = new Broker({
    runId: options.runId,
    manifest: manifest(options.budget),
    capsuleRootDir: capsuleRoot,
    baselineArtifactHash: HASH_A,
    capsuleDigest: HASH_A,
    optimizerDigest: HASH_B,
    holdoutLedgerPath: path.join(runDir, "holdout-ledger.ndjson"),
    image: IMAGE,
    runDir,
    casDir: path.join(tmpBase, "cas"),
    onEvent: (event) => events.push(event),
    now: () => 0,
    ...(options.recursive === undefined ? {} : { recursive: options.recursive }),
    ...(options.corpus === undefined ? {} : { corpus: options.corpus }),
  });
  brokers.push(broker);
  return broker;
}

interface ChildEvidence {
  launchReceiptPath: string;
  terminalEventPath: string;
}

async function writeChildEvidence(
  request: SpawnRunParams,
  admission: ChildRunAdmission,
  name: string,
): Promise<ChildEvidence> {
  const dir = path.join(tmpBase, "children", name);
  await mkdir(dir, { recursive: true });
  const launchReceiptPath = path.join(dir, "launch-receipt.ndjson");
  const receiptBody = {
    child: request.child,
    depth: request.depth,
    admission,
    launchedAt: "1970-01-01T00:00:00.000Z",
  };
  await writeFile(
    launchReceiptPath,
    `${JSON.stringify({ ...receiptBody, receiptDigest: hashChildRunLaunchReceipt(receiptBody) })}\n`,
  );
  const terminalEventPath = path.join(dir, "events.ndjson");
  const events: RunEvent[] = [
    {
      runId: request.child.runId,
      at: "1970-01-01T00:00:00.000Z",
      type: "run.started",
      capsuleId: request.child.capsuleId,
      contractHash: contentHash("child-run-contract"),
      optimizerDigest: request.child.optimizerArtifact.hash,
      campaignConfigHash: admission.campaignConfigHash,
    },
    {
      runId: request.child.runId,
      at: "1970-01-01T00:00:01.000Z",
      type: "run.finished",
      status: "completed",
    },
  ];
  await writeFile(terminalEventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { launchReceiptPath, terminalEventPath };
}

beforeEach(async () => {
  capsuleRoot = path.join(tmpBase, "capsule");
  await mkdir(path.join(capsuleRoot, "train"), { recursive: true });
  await writeFile(path.join(capsuleRoot, "train", "data.txt"), "train");
});

afterEach(async () => {
  for (const broker of brokers.splice(0).reverse()) {
    await broker.close().catch(() => undefined);
  }
  for (const ledger of ledgers.splice(0).reverse()) ledger.close();
  await rm(tmpBase, { recursive: true, force: true });
});

describe("recursive spawnRun authority", () => {
  it("runs frozen child membership and artifact-provenance admission before reserving", async () => {
    const ledger = RecursiveResourceLedger.open(path.join(tmpBase, "admission-ledger.ndjson"));
    ledgers.push(ledger);
    const allowed = childRequest("allowed-child", 1, { ...LARGE, maxTokens: 20 }, "capsule");
    const launcher = vi.fn<ChildRunLauncher>();
    const broker = makeBroker({
      runId: "root",
      budget: LARGE,
      recursive: {
        depth: 0,
        ancestors: [],
        ledger,
        admitChildRun: ({ request }) =>
          request.child.capsuleId === allowed.child.capsuleId &&
          request.child.sourceArtifact.hash === allowed.child.sourceArtifact.hash &&
          request.child.optimizerArtifact.hash === allowed.child.optimizerArtifact.hash
            ? ADMISSION
            : undefined,
        launchChildRun: launcher,
      },
    });
    const forged: SpawnRunParams[] = [
      { ...allowed, child: { ...allowed.child, runId: "foreign-capsule", capsuleId: "cap_terminal_unopened" } },
      { ...allowed, child: { ...allowed.child, runId: "foreign-source", sourceArtifact: { hash: CONFIG_HASH } } },
      { ...allowed, child: { ...allowed.child, runId: "foreign-optimizer", optimizerArtifact: { hash: CONFIG_HASH } } },
    ];

    for (const request of forged) {
      await expect(broker.spawnRun(request, CLIENT)).rejects.toMatchObject({ code: "CHILD_ADMISSION_DENIED" });
      expect(ledger.hasChild(request.child.runId)).toBe(false);
    }
    expect(ledger.budgetState("root")).toMatchObject({ reservations: 0, openReservations: 0, remaining: LARGE });
    expect(launcher).not.toHaveBeenCalled();
  });

  it("does not settle or return capacity for a terminal-only stream without launch-bound events", async () => {
    const ledger = RecursiveResourceLedger.open(path.join(tmpBase, "launch-receipt-ledger.ndjson"));
    ledgers.push(ledger);
    const reservation = { ...LARGE, maxTokens: 40, maxUsd: 40, maxWallClockSec: 40, maxEvaluatorInvocations: 40 };
    const request = childRequest("unlaunched-child", 1, reservation, "capsule");
    const usage: ResourceUsage = { tokens: 1, usd: 1, wallClockSec: 1, evaluatorInvocations: 1 };
    const launcher: ChildRunLauncher = async ({ request: launchedRequest, admission }) => {
      const evidence = await writeChildEvidence(launchedRequest, admission, "terminal-only");
      const terminalOnly: RunEvent = {
        runId: launchedRequest.child.runId,
        at: "1970-01-01T00:00:01.000Z",
        type: "run.finished",
        status: "completed",
      };
      await writeFile(evidence.terminalEventPath, `${JSON.stringify(terminalOnly)}\n`);
      return { ...evidence, usage };
    };
    const broker = makeBroker({
      runId: "root",
      budget: LARGE,
      recursive: {
        depth: 0,
        ancestors: [],
        ledger,
        admitChildRun: ADMIT_CHILD,
        launchChildRun: launcher,
      },
    });

    await expect(broker.spawnRun(request, CLIENT)).rejects.toThrow(/not bound to its launch receipt/);
    expect(ledger.budgetState("root")).toMatchObject({
      reservations: 1,
      openReservations: 1,
      remaining: { maxTokens: 160, maxUsd: 160, maxWallClockSec: 160, maxEvaluatorInvocations: 160 },
    });
  });

  it("requires sealed campaignConfigHash instead of treating the per-run contractHash as campaign identity", async () => {
    const ledger = RecursiveResourceLedger.open(path.join(tmpBase, "campaign-identity-ledger.ndjson"));
    ledgers.push(ledger);
    const reservation = { ...LARGE, maxTokens: 30, maxUsd: 30, maxWallClockSec: 30, maxEvaluatorInvocations: 30 };
    const request = childRequest("campaign-unbound-child", 1, reservation, "capsule");
    const launcher: ChildRunLauncher = async ({ request: launchedRequest, admission }) => {
      const evidence = await writeChildEvidence(launchedRequest, admission, "campaign-unbound");
      const eventsWithoutCampaign: RunEvent[] = [
        {
          runId: launchedRequest.child.runId,
          at: "1970-01-01T00:00:00.000Z",
          type: "run.started",
          capsuleId: launchedRequest.child.capsuleId,
          contractHash: admission.campaignConfigHash,
          optimizerDigest: launchedRequest.child.optimizerArtifact.hash,
        },
        {
          runId: launchedRequest.child.runId,
          at: "1970-01-01T00:00:01.000Z",
          type: "run.finished",
          status: "completed",
        },
      ];
      await writeFile(
        evidence.terminalEventPath,
        `${eventsWithoutCampaign.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      return {
        ...evidence,
        usage: { tokens: 1, usd: 1, wallClockSec: 1, evaluatorInvocations: 1 },
      };
    };
    const broker = makeBroker({
      runId: "root",
      budget: LARGE,
      recursive: {
        depth: 0,
        ancestors: [],
        ledger,
        admitChildRun: ADMIT_CHILD,
        launchChildRun: launcher,
      },
    });

    await expect(broker.spawnRun(request, CLIENT)).rejects.toThrow(/not bound to its launch receipt/);
    expect(ledger.budgetState("root")).toMatchObject({
      openReservations: 1,
      remaining: { maxTokens: 170, maxUsd: 170, maxWallClockSec: 170, maxEvaluatorInvocations: 170 },
    });
  });
  it("refuses spawnRun at depth 2 before invoking the trusted launcher", async () => {
    const ledger = RecursiveResourceLedger.open(path.join(tmpBase, "depth-ledger.ndjson"));
    ledgers.push(ledger);
    ledger.registerRun("root", 0, [], LARGE);
    const depthOneBudget: BudgetEnvelope = {
      maxTokens: 120,
      maxUsd: 120,
      maxWallClockSec: 120,
      maxEvaluatorInvocations: 120,
    };
    ledger.reserveChild(childRequest("depth-one", 1, depthOneBudget, "capsule"), ["root"], ADMISSION);
    const depthTwoBudget: BudgetEnvelope = {
      maxTokens: 40,
      maxUsd: 40,
      maxWallClockSec: 40,
      maxEvaluatorInvocations: 40,
    };
    ledger.reserveChild(
      childRequest("depth-two", 2, depthTwoBudget, "delegated"),
      ["root", "depth-one"],
      ADMISSION,
    );
    const launcher = vi.fn<ChildRunLauncher>();
    const broker = makeBroker({
      runId: "depth-two",
      budget: depthTwoBudget,
      recursive: {
        depth: 2,
        ancestors: ["root", "depth-one"],
        ledger,
        admitChildRun: ADMIT_CHILD,
        launchChildRun: launcher,
      },
    });

    await expect(broker.spawnRun(childRequest("forbidden", 2, depthTwoBudget, "delegated"), CLIENT)).rejects.toMatchObject({
      code: "DEPTH_EXCEEDED",
    });
    expect(launcher).not.toHaveBeenCalled();
    expect(ledger.hasChild("forbidden")).toBe(false);
  });

  it("fails a componentwise ancestor shortfall without partially reserving any ancestor", async () => {
    const ledger = RecursiveResourceLedger.open(path.join(tmpBase, "shortfall-ledger.ndjson"));
    ledgers.push(ledger);
    ledger.registerRun("root", 0, [], LARGE);
    const parentBudget: BudgetEnvelope = {
      maxTokens: 100,
      maxUsd: 10,
      maxWallClockSec: 100,
      maxEvaluatorInvocations: 100,
    };
    ledger.reserveChild(childRequest("parent", 1, parentBudget, "capsule"), ["root"], ADMISSION);
    const launcher = vi.fn<ChildRunLauncher>();
    const broker = makeBroker({
      runId: "parent",
      budget: parentBudget,
      recursive: { depth: 1, ancestors: ["root"], ledger, admitChildRun: ADMIT_CHILD, launchChildRun: launcher },
    });
    const rootBefore = ledger.budgetState("root");
    const parentBefore = ledger.budgetState("parent");
    const tooLarge = { ...parentBudget, maxTokens: 50, maxUsd: 11 };

    await expect(broker.spawnRun(childRequest("short-child", 2, tooLarge, "delegated"), CLIENT)).rejects.toMatchObject({
      code: "RESERVATION_EXCEEDED",
    });
    expect(ledger.budgetState("root")).toEqual(rootBefore);
    expect(ledger.budgetState("parent")).toEqual(parentBefore);
    expect(ledger.hasChild("short-child")).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
  });

  it("replays an incomplete crash reservation without double-reserving or minting another child identity", async () => {
    const ledgerPath = path.join(tmpBase, "crash-ledger.ndjson");
    const runDir = path.join(tmpBase, "root-run");
    const reservation = { ...LARGE, maxTokens: 50, maxUsd: 50, maxWallClockSec: 50, maxEvaluatorInvocations: 50 };
    const baseRequest = childRequest("durable-child", 1, reservation, "capsule");
    const request: SpawnRunParams = {
      ...baseRequest,
      child: {
        ...baseRequest.child,
        schedule: { candidateOrdinal: 2, allocationOrdinal: 7, innerEpisodesMax: 4 },
      },
    };
    const firstLedger = RecursiveResourceLedger.open(ledgerPath);
    ledgers.push(firstLedger);
    const firstLauncher = vi.fn<ChildRunLauncher>(async () => {
      throw new Error("simulated launcher crash after durable reservation");
    });
    const first = makeBroker({
      runId: "root",
      runDir,
      budget: LARGE,
      recursive: {
        depth: 0,
        ancestors: [],
        ledger: firstLedger,
        admitChildRun: ADMIT_CHILD,
        launchChildRun: firstLauncher,
      },
    });

    await expect(first.spawnRun(request, CLIENT)).rejects.toThrow(/simulated launcher crash/);
    const mutatedSchedule: SpawnRunParams = {
      ...request,
      child: {
        ...request.child,
        schedule: { candidateOrdinal: 2, allocationOrdinal: 8, innerEpisodesMax: 4 },
      },
    };
    await expect(first.spawnRun(mutatedSchedule, CLIENT)).rejects.toMatchObject({ code: "INTERNAL" });
    expect(firstLauncher).toHaveBeenCalledTimes(1);
    expect(firstLedger.budgetState("root")).toMatchObject({
      reservations: 1,
      openReservations: 1,
      remaining: { maxTokens: 150 },
    });
    await first.close();
    brokers.splice(brokers.indexOf(first), 1);
    firstLedger.close();
    ledgers.splice(ledgers.indexOf(firstLedger), 1);

    const replayedLedger = RecursiveResourceLedger.open(ledgerPath);
    ledgers.push(replayedLedger);
    const usage: ResourceUsage = { tokens: 10, usd: 2, wallClockSec: 3, evaluatorInvocations: 4 };
    const replayFlags: boolean[] = [];
    const secondLauncher: ChildRunLauncher = async ({ replay, request: launchedRequest, admission }) => {
      replayFlags.push(replay);
      return { ...(await writeChildEvidence(launchedRequest, admission, "durable-child")), usage };
    };
    const second = makeBroker({
      runId: "root",
      runDir,
      budget: LARGE,
      recursive: {
        depth: 0,
        ancestors: [],
        ledger: replayedLedger,
        admitChildRun: ADMIT_CHILD,
        launchChildRun: secondLauncher,
      },
    });
    const result = await second.spawnRun(request, CLIENT);

    expect(replayFlags).toEqual([true]);
    expect(result.child.runId).toBe("durable-child");
    expect(replayedLedger.budgetState("root")).toMatchObject({
      reservations: 1,
      openReservations: 0,
      remaining: {
        maxTokens: 190,
        maxUsd: 198,
        maxWallClockSec: 197,
        maxEvaluatorInvocations: 196,
      },
    });
  });

  it("holds the full reservation until the child terminal event is durable, then returns only unused resources", async () => {
    const ledger = RecursiveResourceLedger.open(path.join(tmpBase, "settlement-ledger.ndjson"));
    ledgers.push(ledger);
    let release: (() => void) | undefined;
    let announceStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const usage: ResourceUsage = { tokens: 7, usd: 3, wallClockSec: 5, evaluatorInvocations: 2 };
    const launcher: ChildRunLauncher = async ({ request: launchedRequest, admission }) => {
      announceStarted?.();
      await gate;
      return { ...(await writeChildEvidence(launchedRequest, admission, "settling-child")), usage };
    };
    const broker = makeBroker({
      runId: "root",
      budget: LARGE,
      recursive: { depth: 0, ancestors: [], ledger, admitChildRun: ADMIT_CHILD, launchChildRun: launcher },
    });
    const reservation = { ...LARGE, maxTokens: 60, maxUsd: 60, maxWallClockSec: 60, maxEvaluatorInvocations: 60 };
    const pending = broker.spawnRun(childRequest("settling-child", 1, reservation, "capsule"), CLIENT);
    await started;

    expect(ledger.budgetState("root")).toMatchObject({
      openReservations: 1,
      remaining: { maxTokens: 140, maxUsd: 140, maxWallClockSec: 140, maxEvaluatorInvocations: 140 },
    });
    release?.();
    await pending;
    expect(ledger.budgetState("root")).toMatchObject({
      openReservations: 0,
      remaining: {
        maxTokens: 193,
        maxUsd: 197,
        maxWallClockSec: 195,
        maxEvaluatorInvocations: 198,
      },
    });
  });
});

describe("deterministic filtered corpus", () => {
  it("returns byte-identical pages for pinned cursors as evidence grows and across replay", async () => {
    const publicDocuments: CorpusPublicDocument[] = [
      {
        source: "public-snapshot",
        provenance: { campaignConfigHash: CONFIG_HASH, cohort: "public-history" },
        id: "public-b",
        content: "beta history",
        contentHash: contentHash("beta history"),
      },
      {
        source: "public-snapshot",
        provenance: { campaignConfigHash: CONFIG_HASH, cohort: "public-history" },
        id: "public-a",
        content: "alpha history",
        contentHash: contentHash("alpha history"),
      },
    ];
    const panelEvidence: CorpusPanelEvidence[] = [
      {
        source: "panel-evidence",
        provenance: {
          campaignConfigHash: CONFIG_HASH,
          cohort: "panel-a",
          capsuleId: "cap_0123456789ab",
        },
        id: "panel-a",
        content: "metered panel evidence",
        contentHash: contentHash("metered panel evidence"),
        usage: { tokens: 11, usd: 1, wallClockSec: 2, evaluatorInvocations: 1 },
      },
    ];
    const events: RunEvent[] = [];
    const runDir = path.join(tmpBase, "versioned-corpus-run");
    const broker = makeBroker({
      runId: "corpus-root",
      runDir,
      budget: LARGE,
      events,
      corpus: {
        provenance: {
          campaignConfigHash: CONFIG_HASH,
          developmentCapsuleIds: ["cap_0123456789ab"],
          terminalCapsuleIds: ["cap_terminal_unopened"],
          terminalContentHashes: [contentHash("sealed terminal evidence")],
        },
        publicSnapshot: { hash: hashCorpusSnapshot(publicDocuments), documents: publicDocuments },
        panelEvidence,
      },
    });
    const baseQuery = QueryCorpusParams.parse({
      query: { text: "", sources: ["panel-evidence", "public-snapshot"] },
      cursor: null,
      pageSize: 1,
    });
    const first = broker.queryCorpus(baseQuery, CLIENT);
    const replayed = broker.queryCorpus({ ...baseQuery, cursor: first.cursor }, CLIENT);

    expect(Buffer.from(JSON.stringify(replayed))).toEqual(Buffer.from(JSON.stringify(first)));
    expect(events.map((event) => event.type)).toEqual([
      "corpus.query",
      "corpus.response",
      "corpus.query",
      "corpus.response",
    ]);
    expect(events[1]).toMatchObject({ type: "corpus.response", response: { cursor: first.cursor } });
    expect(events[3]).toEqual(events[1]);

    const addedEvidence: CorpusPanelEvidence = {
      source: "panel-evidence",
      provenance: {
        campaignConfigHash: CONFIG_HASH,
        cohort: "panel-a",
        capsuleId: "cap_0123456789ab",
      },
      id: "panel-0",
      content: "newly metered panel evidence",
      contentHash: contentHash("newly metered panel evidence"),
      usage: { tokens: 5, usd: 0.5, wallClockSec: 1, evaluatorInvocations: 1 },
    };
    const appended = broker.appendCorpusPanelEvidence([addedEvidence], ADMIN);
    const latest = broker.queryCorpus(baseQuery, CLIENT);
    const pinnedOldPage = broker.queryCorpus({ ...baseQuery, cursor: first.cursor }, CLIENT);
    expect(appended.corpusVersionHash).not.toBe(first.corpusVersionHash);
    expect(latest.corpusVersionHash).toBe(appended.corpusVersionHash);
    expect(latest.documents[0]?.id).toBe("panel-0");
    expect(Buffer.from(JSON.stringify(pinnedOldPage))).toEqual(Buffer.from(JSON.stringify(first)));

    const terminalProbe = broker.queryCorpus(
      { query: { text: "sealed-terminal-identity", sources: ["public-snapshot", "panel-evidence"] }, cursor: null, pageSize: 100 },
      CLIENT,
    );
    expect(terminalProbe.documents).toEqual([]);
    expect(QueryCorpusParams.safeParse({
      query: { text: "", sources: ["terminal"] },
      cursor: null,
      pageSize: 10,
    }).success).toBe(false);
    expect(JSON.stringify(terminalProbe)).not.toContain("terminalIdentity");
    await broker.close();
    brokers.splice(brokers.indexOf(broker), 1);
    const resumed = makeBroker({
      runId: "corpus-root",
      runDir,
      budget: LARGE,
      corpus: {
        provenance: {
          campaignConfigHash: CONFIG_HASH,
          developmentCapsuleIds: ["cap_0123456789ab"],
          terminalCapsuleIds: ["cap_terminal_unopened"],
          terminalContentHashes: [contentHash("sealed terminal evidence")],
        },
        publicSnapshot: { hash: hashCorpusSnapshot(publicDocuments), documents: publicDocuments },
        panelEvidence,
      },
    });
    const replayedOldPage = resumed.queryCorpus({ ...baseQuery, cursor: first.cursor }, CLIENT);
    const replayedLatest = resumed.queryCorpus(baseQuery, CLIENT);
    expect(Buffer.from(JSON.stringify(replayedOldPage))).toEqual(Buffer.from(JSON.stringify(first)));
    expect(replayedLatest.corpusVersionHash).toBe(appended.corpusVersionHash);
    expect(replayedLatest.documents[0]?.id).toBe("panel-0");
  });

  it("rejects terminal provenance and terminal content independently of caller-supplied source labels", () => {
    const publicDocument: CorpusPublicDocument = {
      source: "public-snapshot",
      provenance: { campaignConfigHash: CONFIG_HASH, cohort: "public-history" },
      id: "public-safe",
      content: "safe public history",
      contentHash: contentHash("safe public history"),
    };
    const terminalPanel: CorpusPanelEvidence = {
      source: "panel-evidence",
      provenance: {
        campaignConfigHash: CONFIG_HASH,
        cohort: "panel-a",
        capsuleId: "cap_terminal_unopened",
      },
      id: "mislabeled-panel",
      content: "ordinary-looking evidence",
      contentHash: contentHash("ordinary-looking evidence"),
      usage: { tokens: 1, usd: 0, wallClockSec: 1, evaluatorInvocations: 1 },
    };
    const provenance = {
      campaignConfigHash: CONFIG_HASH,
      developmentCapsuleIds: ["cap_0123456789ab"],
      terminalCapsuleIds: ["cap_terminal_unopened"],
      terminalContentHashes: [contentHash("sealed terminal evidence")],
    };

    expect(() =>
      makeBroker({
        runId: "terminal-panel",
        budget: LARGE,
        corpus: {
          provenance,
          publicSnapshot: { hash: hashCorpusSnapshot([publicDocument]), documents: [publicDocument] },
          panelEvidence: [terminalPanel],
        },
      }),
    ).toThrow(/violates frozen development provenance/);

    const mislabeledPublic: CorpusPublicDocument = {
      source: "public-snapshot",
      provenance: { campaignConfigHash: CONFIG_HASH, cohort: "public-history" },
      id: "public-looking",
      content: "sealed terminal evidence",
      contentHash: contentHash("sealed terminal evidence"),
    };
    expect(() =>
      makeBroker({
        runId: "terminal-content",
        budget: LARGE,
        corpus: {
          provenance,
          publicSnapshot: { hash: hashCorpusSnapshot([mislabeledPublic]), documents: [mislabeledPublic] },
          panelEvidence: [],
        },
      }),
    ).toThrow(/violates frozen development provenance/);
  });

  it("enforces the page cap before journaling and charges repeated response payloads to a durable byte budget", () => {
    const oversizedContent = "x".repeat(2_000);
    const oversizedDocument: CorpusPublicDocument = {
      source: "public-snapshot",
      provenance: { campaignConfigHash: CONFIG_HASH, cohort: "public-history" },
      id: "oversized",
      content: oversizedContent,
      contentHash: contentHash(oversizedContent),
    };
    const provenance = {
      campaignConfigHash: CONFIG_HASH,
      developmentCapsuleIds: ["cap_0123456789ab"],
      terminalCapsuleIds: ["cap_terminal_unopened"],
      terminalContentHashes: [contentHash("sealed terminal evidence")],
    };
    const oversizedEvents: RunEvent[] = [];
    const oversized = makeBroker({
      runId: "oversized-corpus",
      budget: LARGE,
      events: oversizedEvents,
      corpus: {
        provenance,
        publicSnapshot: { hash: hashCorpusSnapshot([oversizedDocument]), documents: [oversizedDocument] },
        panelEvidence: [],
        maxPageBytes: 256,
        maxJournalBytes: 100_000,
      },
    });
    const query = QueryCorpusParams.parse({
      query: { text: "", sources: ["public-snapshot"] },
      cursor: null,
      pageSize: 1,
    });
    expect(() => oversized.queryCorpus(query, CLIENT)).toThrow(/page byte cap/);
    expect(oversizedEvents).toEqual([]);

    const smallDocument: CorpusPublicDocument = {
      source: "public-snapshot",
      provenance: { campaignConfigHash: CONFIG_HASH, cohort: "public-history" },
      id: "small",
      content: "bounded",
      contentHash: contentHash("bounded"),
    };
    const meteredEvents: RunEvent[] = [];
    const metered = makeBroker({
      runId: "metered-corpus",
      budget: LARGE,
      events: meteredEvents,
      corpus: {
        provenance,
        publicSnapshot: { hash: hashCorpusSnapshot([smallDocument]), documents: [smallDocument] },
        panelEvidence: [],
        maxPageBytes: 10_000,
        maxJournalBytes: 10_000,
      },
    });
    let successful = 0;
    while (successful < 100) {
      try {
        metered.queryCorpus(query, CLIENT);
        successful += 1;
      } catch (error) {
        expect(error).toMatchObject({ code: "QUOTA_EXCEEDED" });
        break;
      }
    }
    expect(successful).toBeGreaterThan(0);
    expect(successful).toBeLessThan(100);
    expect(meteredEvents).toHaveLength(successful * 2);
    const loggedBeforeRetry = meteredEvents.length;
    expect(() => metered.queryCorpus(query, CLIENT)).toThrow(/journal byte budget/);
    expect(meteredEvents).toHaveLength(loggedBeforeRetry);
  });
});
