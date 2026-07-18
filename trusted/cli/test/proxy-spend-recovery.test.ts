import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, RunConfig, capsuleDigest } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { freezeCapsuleAssets } from "../src/admission.js";
import { createBackend } from "../src/backends/local.js";
import { appendEvent, readEvents, replayRun } from "../src/eventlog.js";
import type { RunnerBackendContext } from "../src/types.js";
import { at, fakeHash, gitIn, initScratchRepo, makeCapsule, makeRoot, scriptedCreateHelper } from "./helpers.js";

/**
 * Proxy dispatch-journal recovery vs broker startup ordering (P1): the
 * proxy's recovery starts AT CONSTRUCTION and delivers recovered ceiling
 * charges before the broker exists; worse, a recovered fact made durable by
 * a prior attempt is NEVER re-delivered through recordSpend. The backend
 * therefore queues pre-broker spend callbacks and, after startBroker +
 * `dispatchRecovery()`, reconciles the journal's CUMULATIVE charge level as
 * an absolute lower bound into the broker (charging only positive deficits),
 * snapshots the budget durably, and only then opens the direct sink. These
 * are resume schedules over a real proxy + real broker with scripted docker.
 */

const RUN_ID = "run_spendrec";
const CEIL_TOKENS = 7770;
const CEIL_USD = 0.5;

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

function intentLine(id: string): string {
  return `${JSON.stringify({
    v: 1,
    kind: "intent",
    id,
    runId: RUN_ID,
    role: "mutation",
    model: "m",
    requestAt: at(),
    requestSha256: "a".repeat(64),
    promptTokens: 100,
    completionTokens: 7670,
    ceilTokens: CEIL_TOKENS,
    ceilUsd: CEIL_USD,
  })}\n`;
}

function recoveredLine(id: string): string {
  return `${JSON.stringify({ v: 1, kind: "recovered", id, tokens: CEIL_TOKENS, usd: CEIL_USD, at: at() })}\n`;
}

function makeCtx(root: string, run: RunCommand, barriers: { cleanup: (p: Promise<void>) => void }): RunnerBackendContext {
  const runDir = join(root, ".hone-runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(root, ".hone-cas"), { recursive: true });
  const baseline = join(root, "capsule", "baseline");
  initScratchRepo(baseline);
  const commit = gitIn(baseline, "rev-parse", "HEAD");
  const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit } });
  const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")));
  if (!existsSync(join(runDir, "capsule-assets"))) freezeCapsuleAssets(runDir, capsuleDir, manifest);
  appendEvent(runDir, { runId: RUN_ID, at: at(), type: "run.started", capsuleId: manifest.id, contractHash: fakeHash("c"), optimizerDigest: fakeHash("0") });
  const abort = new AbortController();
  abort.abort(new Error("stop requested")); // setup-only: the reconcile must land BEFORE the abort short-circuit
  return {
    runId: RUN_ID,
    root,
    runDir,
    casDir: join(root, ".hone-cas"),
    capsuleDir,
    manifest,
    config: RunConfig.parse({
      version: 1,
      capsuleId: manifest.id,
      objective: manifest.objective,
      budget: manifest.budget,
      routing: { mutation: { model: "m" } },
      headless: true,
    }),
    env: { PATH: process.env["PATH"] ?? "", HONE_EGRESS: "network" },
    capsuleDigest: capsuleDigest(manifest),
    optimizerDigest: fakeHash("0"),
    replayed: replayRun(runDir),
    signal: abort.signal,
    emit: (event) => appendEvent(runDir, event),
    registerChild: () => () => {},
    probeGate: () => Promise.resolve(true),
    requestStop: () => {},
    registerAuthorityBarrier: (b) => {
      void b.catch(() => {});
    },
    registerCleanupBarrier: (b) => {
      barriers.cleanup(b);
      void b.catch(() => {});
    },
  };
}

function scriptedDocker(runDir: string): RunCommand {
  return (argv) => {
    if (argv[1] === "info") return Promise.resolve(res({ stdout: Buffer.from("ENGINE-TEST\n") }));
    if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
    if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("cid\n") }));
    const outArg = argv.find((a) => typeof a === "string" && a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
    if (argv[1] === "exec" && outArg !== undefined) {
      mkdirSync(join(runDir, "scratch-snapshot"), { recursive: true });
      writeFileSync(join(runDir, "scratch-snapshot", outArg.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length)), "");
    }
    return Promise.resolve(res());
  };
}

function lastBudgetSnapshot(runDir: string): { tokens: number; usd: number } | null {
  const events = readEvents(runDir);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.type === "budget.snapshot") {
      return { tokens: event.budget.spent.tokens, usd: event.budget.spent.usd };
    }
  }
  return null;
}

describe("proxy dispatch recovery reconciles into the broker before terminal/admission", () => {
  it("(a) an UNMATCHED intent at startup: the recovered ceiling charge lands in the broker and a durable budget snapshot proves it before any terminal", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", RUN_ID);
    mkdirSync(runDir, { recursive: true });
    // Crashed attempt: intent fsynced, upstream possibly contacted, no settle.
    writeFileSync(join(runDir, "proxy-dispatch.ndjson"), intentLine("d1"));

    let cleanupBarrier: Promise<void> | null = null;
    const run = scriptedDocker(runDir);
    const ctx = makeCtx(root, run, { cleanup: (p) => (cleanupBarrier = p) });
    await createBackend({ run, createHelper: scriptedCreateHelper(run) }).start(ctx);

    // Recovery charged the FULL reserved ceiling exactly once, the pre-broker
    // queue was drained, and the reconciled floor was journaled durably.
    const snapshot = lastBudgetSnapshot(runDir);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.tokens).toBeGreaterThanOrEqual(CEIL_TOKENS);
    expect(snapshot?.usd).toBeGreaterThanOrEqual(CEIL_USD);
    // The journal now carries the durable recovered fact (replay-safe).
    expect(readFileSync(join(runDir, "proxy-dispatch.ndjson"), "utf8")).toContain('"kind":"recovered"');
    // A recovered dispatch is a durable poison fact (its trace is missing):
    // the proxy refuses a clean shutdown, so the run stays NON-TERMINAL.
    expect(cleanupBarrier).not.toBeNull();
    await expect(cleanupBarrier).rejects.toThrow(/proxy:/);
    // The rejected barrier is the supervisor's terminal gate (it returns 1
    // and appends nothing when cleanup is incomplete — cleanup-order.test.ts
    // proves that end-to-end): the backend itself must never have emitted a
    // terminal event either.
    expect(readEvents(runDir).some((e) => e.type === "run.finished")).toBe(false);
  });

  it("(b) a recovered fact durable but the charge LOST (crash before the callback): the cumulative journal level is re-charged as an absolute lower bound — never re-delivered, never dropped", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", RUN_ID);
    mkdirSync(runDir, { recursive: true });
    // Prior attempt recovered d1 durably (recovered record) but died BEFORE
    // the recordSpend callback reached any broker journal: replay will treat
    // d1 as matched forever, so ONLY the cumulative-level reconcile can
    // restore the charge.
    writeFileSync(join(runDir, "proxy-dispatch.ndjson"), intentLine("d1") + recoveredLine("d1"));

    let cleanupBarrier: Promise<void> | null = null;
    const run = scriptedDocker(runDir);
    const ctx = makeCtx(root, run, { cleanup: (p) => (cleanupBarrier = p) });
    await createBackend({ run, createHelper: scriptedCreateHelper(run) }).start(ctx);

    const snapshot = lastBudgetSnapshot(runDir);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.tokens).toBeGreaterThanOrEqual(CEIL_TOKENS);
    expect(snapshot?.usd).toBeGreaterThanOrEqual(CEIL_USD);
    // Idempotence of the LEVEL reconcile: the charge appears once, not twice.
    expect(snapshot?.tokens).toBeLessThan(2 * CEIL_TOKENS);
    expect(cleanupBarrier).not.toBeNull();
    await expect(cleanupBarrier).rejects.toThrow(/proxy:/);
    expect(readEvents(runDir).some((e) => e.type === "run.finished")).toBe(false);
  });

  it("a POISONED dispatch journal keeps the run non-terminal (proxy.close rejects the cleanup barrier) while the budget floor still reconciles", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", RUN_ID);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "proxy-dispatch.ndjson"),
      `${JSON.stringify({ v: 1, kind: "poison", reason: "trace/CAS publication failed for dispatch dX", at: at() })}\n`,
    );

    let cleanupBarrier: Promise<void> | null = null;
    const run = scriptedDocker(runDir);
    const ctx = makeCtx(root, run, { cleanup: (p) => (cleanupBarrier = p) });
    await createBackend({ run, createHelper: scriptedCreateHelper(run) }).start(ctx);
    expect(cleanupBarrier).not.toBeNull();
    await expect(cleanupBarrier).rejects.toThrow(/proxy:/);
    expect(readEvents(runDir).some((e) => e.type === "run.finished")).toBe(false);
    // The run emitted a reconciled budget snapshot regardless — terminal
    // refusal comes from the poison, not from a missing budget authority.
    expect(lastBudgetSnapshot(runDir)).not.toBeNull();
  });

  it("a CLEAN journal reconciles a zero floor and the run tears down terminal-clean", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", RUN_ID);
    mkdirSync(runDir, { recursive: true });
    let cleanupBarrier: Promise<void> | null = null;
    const run = scriptedDocker(runDir);
    const ctx = makeCtx(root, run, { cleanup: (p) => (cleanupBarrier = p) });
    await createBackend({ run, createHelper: scriptedCreateHelper(run) }).start(ctx);
    expect(cleanupBarrier).not.toBeNull();
    await expect(cleanupBarrier).resolves.toBeUndefined();
    const snapshot = lastBudgetSnapshot(runDir);
    expect(snapshot).toEqual({ tokens: 0, usd: 0 });
  });
});
