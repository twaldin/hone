import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QueryCorpusParams,
  type BudgetEnvelope,
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
const CLIENT = { privileged: false } as const;

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

async function writeTerminal(runId: string, name: string): Promise<string> {
  const dir = path.join(tmpBase, "children", name);
  await mkdir(dir, { recursive: true });
  const eventPath = path.join(dir, "events.ndjson");
  const terminal: RunEvent = {
    runId,
    at: "1970-01-01T00:00:00.000Z",
    type: "run.finished",
    status: "completed",
  };
  await writeFile(eventPath, `${JSON.stringify(terminal)}\n`);
  return eventPath;
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
    ledger.reserveChild(childRequest("depth-one", 1, depthOneBudget, "capsule"), ["root"]);
    const depthTwoBudget: BudgetEnvelope = {
      maxTokens: 40,
      maxUsd: 40,
      maxWallClockSec: 40,
      maxEvaluatorInvocations: 40,
    };
    ledger.reserveChild(childRequest("depth-two", 2, depthTwoBudget, "delegated"), ["root", "depth-one"]);
    const launcher = vi.fn<ChildRunLauncher>();
    const broker = makeBroker({
      runId: "depth-two",
      budget: depthTwoBudget,
      recursive: { depth: 2, ancestors: ["root", "depth-one"], ledger, launchChildRun: launcher },
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
    ledger.reserveChild(childRequest("parent", 1, parentBudget, "capsule"), ["root"]);
    const launcher = vi.fn<ChildRunLauncher>();
    const broker = makeBroker({
      runId: "parent",
      budget: parentBudget,
      recursive: { depth: 1, ancestors: ["root"], ledger, launchChildRun: launcher },
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
    const request = childRequest("durable-child", 1, reservation, "capsule");
    const firstLedger = RecursiveResourceLedger.open(ledgerPath);
    ledgers.push(firstLedger);
    const firstLauncher: ChildRunLauncher = async () => {
      throw new Error("simulated launcher crash after durable reservation");
    };
    const first = makeBroker({
      runId: "root",
      runDir,
      budget: LARGE,
      recursive: { depth: 0, ancestors: [], ledger: firstLedger, launchChildRun: firstLauncher },
    });

    await expect(first.spawnRun(request, CLIENT)).rejects.toThrow(/simulated launcher crash/);
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
    const secondLauncher: ChildRunLauncher = async ({ replay }) => {
      replayFlags.push(replay);
      return { terminalEventPath: await writeTerminal("durable-child", "durable-child"), usage };
    };
    const second = makeBroker({
      runId: "root",
      runDir,
      budget: LARGE,
      recursive: { depth: 0, ancestors: [], ledger: replayedLedger, launchChildRun: secondLauncher },
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
    const launcher: ChildRunLauncher = async () => {
      announceStarted?.();
      await gate;
      return { terminalEventPath: await writeTerminal("settling-child", "settling-child"), usage };
    };
    const broker = makeBroker({
      runId: "root",
      budget: LARGE,
      recursive: { depth: 0, ancestors: [], ledger, launchChildRun: launcher },
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
  it("returns byte-identical pages for the same cursor, logs both sides, and has no terminal representation", () => {
    const publicDocuments: CorpusPublicDocument[] = [
      { source: "public-snapshot", id: "public-b", content: "beta history", contentHash: contentHash("beta history") },
      { source: "public-snapshot", id: "public-a", content: "alpha history", contentHash: contentHash("alpha history") },
    ];
    const panelEvidence: CorpusPanelEvidence[] = [
      {
        source: "panel-evidence",
        id: "panel-a",
        content: "metered panel evidence",
        contentHash: contentHash("metered panel evidence"),
        usage: { tokens: 11, usd: 1, wallClockSec: 2, evaluatorInvocations: 1 },
      },
    ];
    const events: RunEvent[] = [];
    const broker = makeBroker({
      runId: "corpus-root",
      budget: LARGE,
      events,
      corpus: {
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
  });
});
