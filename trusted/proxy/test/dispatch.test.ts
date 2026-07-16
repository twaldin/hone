import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProxy,
  DEFAULT_DURABLE_IO,
  DISPATCH_JOURNAL_FILE,
  DISPATCH_JOURNAL_VERSION,
  parseDispatchRecord,
  readDispatchJournalState,
  type DispatchIntentRecord,
  type DispatchRecord,
  type DispatchSettleRecord,
  type DurableIo,
  type ProxyConfig,
  type ProxyHandle,
  type SpendRecord,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// The crash matrix these tests inject (SIGKILL = a byte-exact snapshot of the
// journal at the boundary, restarted in a fresh proxy):
//   - after durable intent / before fetch      → ceiling charged once + poison
//   - after upstream accepted / before settle  → ceiling charged once + poison
//   - CAS body publication failure             → traced:false survives restart
//   - trace append failure                     → traced:false survives restart
//   - torn journal tail                        → dropped; settled history stays healthy
//   - torn tail hiding a settle                → unmatched intent still fails closed
//   - recovery replayed twice                  → no second charge, still poisoned
//   - concurrent requests                      → serialized, 1:1 matched, exact totals
// ---------------------------------------------------------------------------

const MOCK_USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const GENEROUS_REMAINING = { tokens: 1_000_000_000, usd: 1_000_000 };
const PRICING = { "routed-model": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } };

interface UpstreamCall {
  body: string;
  /** Byte-exact dispatch-journal content at the instant the upstream saw the request. */
  journalAtDispatch: string;
}

interface MockUpstream {
  port: number;
  calls: UpstreamCall[];
  /** "slow"-mode completions held open; invoke an entry to release its response. */
  slow: Array<() => void>;
  close(): Promise<void>;
}

/**
 * Minimal completions upstream. On every request it synchronously snapshots
 * the dispatch journal — the recorded bytes are exactly what a SIGKILL at
 * "upstream accepted" would leave behind, and simultaneously the witness for
 * the intent-before-fetch proof.
 */
async function startUpstream(journalPathRef: { path: string }): Promise<MockUpstream> {
  const calls: UpstreamCall[] = [];
  const slow: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let journalAtDispatch = "";
      try {
        journalAtDispatch = readFileSync(journalPathRef.path, "utf8");
      } catch {
        journalAtDispatch = "";
      }
      calls.push({ body, journalAtDispatch });
      const parsed = JSON.parse(body) as { model?: string; messages?: Array<{ content?: unknown }> };
      const first = parsed.messages?.[0]?.content;
      const mode = typeof first === "string" ? first : "";
      const jsonCompletion = (usage: unknown): string =>
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          model: parsed.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          ...(usage === undefined ? {} : { usage }),
        });
      if (mode === "slow") {
        slow.push(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jsonCompletion(MOCK_USAGE));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonCompletion(mode === "no-usage" ? undefined : MOCK_USAGE));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    calls,
    slow,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Boot {
  proxy: ProxyHandle;
  port: number;
  runDir: string;
  casDir: string;
  spends: SpendRecord[];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function freshDirs(): Promise<{ runDir: string; casDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "hone-dispatch-"));
  return { runDir: join(base, "run"), casDir: join(base, "cas") };
}

/**
 * Boot a proxy over (possibly pre-existing) run/cas dirs — a "restart" is a
 * second boot over the same runDir. Poison tests assert close() rejection
 * in-test; cleanup only guarantees teardown.
 */
async function boot(
  dirs: { runDir: string; casDir: string },
  upstreamPort: number,
  overrides: Partial<ProxyConfig> = {},
): Promise<Boot> {
  const spends: SpendRecord[] = [];
  const proxy = createProxy({
    runId: "run_dispatch",
    routing: { mutation: { model: "routed-model" } },
    runDir: dirs.runDir,
    casDir: dirs.casDir,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    pricing: PRICING,
    checkBudget: () => ({ allowed: true, remaining: GENEROUS_REMAINING }),
    recordSpend: (s) => {
      spends.push(s);
    },
    ...overrides,
  });
  const port = await proxy.listenTcp(0);
  cleanups.push(async () => {
    await proxy.close().catch(() => undefined);
  });
  return { proxy, port, runDir: dirs.runDir, casDir: dirs.casDir, spends };
}

function postCompletions(b: Boot, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${b.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${b.proxy.tokenFor("mutation")}`,
    },
    body: JSON.stringify(body),
  });
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}

/** Parse every terminated line of the journal; throws on any malformed record. */
async function readJournal(runDir: string): Promise<DispatchRecord[]> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, DISPATCH_JOURNAL_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n");
  lines.pop();
  return lines.filter((l) => l !== "").map((l) => parseDispatchRecord(l));
}

function onlyIntent(records: DispatchRecord[]): DispatchIntentRecord {
  const intents = records.filter((r): r is DispatchIntentRecord => r.kind === "intent");
  expect(intents).toHaveLength(1);
  return intents[0]!;
}

/**
 * Produce a crash-consistent "after upstream accepted / before settle"
 * journal image with REAL proxy-written bytes: run a request against a held
 * upstream, snapshot the journal the upstream witnessed, then let the run
 * finish cleanly. Returns the snapshot and its (only) intent.
 */
async function captureIntentOnlyJournal(): Promise<{
  snapshot: string;
  intent: DispatchIntentRecord;
}> {
  const dirs = await freshDirs();
  const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
  const upstream = await startUpstream(pathRef);
  cleanups.push(() => upstream.close());
  const a = await boot(dirs, upstream.port);
  const pending = postCompletions(a, { messages: [{ role: "user", content: "slow" }], max_tokens: 7 });
  await until(() => upstream.slow.length === 1);
  const snapshot = upstream.calls[0]!.journalAtDispatch;
  // Release and finish cleanly: proxy A itself stays healthy and settled.
  upstream.slow[0]!();
  await (await pending).text();
  await a.proxy.close();
  expect((await readDispatchJournalState(pathRef.path)).unmatched).toHaveLength(0);
  const records = snapshot
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => parseDispatchRecord(l));
  return { snapshot, intent: onlyIntent(records) };
}

/** A fresh runDir seeded with exact journal bytes — the restart-after-SIGKILL image. */
async function seedRunDir(journalContent: string): Promise<{ runDir: string; casDir: string }> {
  const dirs = await freshDirs();
  await mkdir(dirs.runDir, { recursive: true });
  await writeFile(join(dirs.runDir, DISPATCH_JOURNAL_FILE), journalContent, "utf8");
  return dirs;
}

// ---------------------------------------------------------------------------
// intent barrier
// ---------------------------------------------------------------------------

describe("dispatch journal — intent barrier", () => {
  it("the intent is written and fsynced BEFORE any upstream dispatch, and carries the admitted ceiling", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    const events: string[] = [];
    const journalIo: Partial<DurableIo> = {
      async syncFile(handle) {
        await DEFAULT_DURABLE_IO.syncFile(handle);
        events.push("journal-fsync");
      },
    };
    const b = await boot(dirs, upstream.port, { journalIo });

    const res = await postCompletions(b, { messages: [{ role: "user", content: "hi" }], max_tokens: 7 });
    expect(res.status).toBe(200);
    await res.text();

    // Ordering proof: the journal fsync resolved strictly before the
    // upstream ever saw the request.
    expect(events[0]).toBe("journal-fsync");
    expect(upstream.calls).toHaveLength(1);

    // The bytes the upstream witnessed already contained the COMPLETE intent
    // for exactly this request: identity (sha256 of the forwarded body) plus
    // the admitted worst-case ceiling.
    const seen = upstream.calls[0]!;
    const intentAtDispatch = onlyIntent(
      seen.journalAtDispatch
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => parseDispatchRecord(l)),
    );
    expect(intentAtDispatch.v).toBe(DISPATCH_JOURNAL_VERSION);
    expect(intentAtDispatch.runId).toBe("run_dispatch");
    expect(intentAtDispatch.role).toBe("mutation");
    expect(intentAtDispatch.model).toBe("routed-model");
    expect(intentAtDispatch.requestSha256).toBe(createHash("sha256").update(seen.body).digest("hex"));
    expect(intentAtDispatch.completionTokens).toBe(7);
    expect(intentAtDispatch.ceilTokens).toBe(intentAtDispatch.promptTokens + 7);
    expect(intentAtDispatch.ceilUsd).toBeCloseTo(
      (intentAtDispatch.promptTokens / 1e6) * 3 + (7 / 1e6) * 15,
      12,
    );

    // Settlement matched the intent with the ACTUAL charge and a met trace
    // obligation; journal totals equal broker totals exactly.
    const records = await readJournal(b.runDir);
    expect(records.map((r) => r.kind)).toEqual(["intent", "settle"]);
    const settle = records[1] as DispatchSettleRecord;
    expect(settle.id).toBe(intentAtDispatch.id);
    expect(settle.outcome).toBe("usage");
    expect(settle.traced).toBe(true);
    expect(settle.tokens).toBe(120);
    expect(b.spends).toEqual([{ tokens: settle.tokens, usd: settle.usd }]);
    const state = await readDispatchJournalState(pathRef.path);
    expect(state.poisoned).toBeUndefined();
    expect(state.unmatched).toHaveLength(0);
    expect(state.chargedTotals.tokens).toBe(120);
  });

  it("fail-closed ceiling settlements (missing usage) journal the full reserved ceiling", async () => {
    const dirs = await freshDirs();
    const upstream = await startUpstream({ path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) });
    cleanups.push(() => upstream.close());
    const b = await boot(dirs, upstream.port);
    const res = await postCompletions(b, { messages: [{ role: "user", content: "no-usage" }], max_tokens: 9 });
    expect(res.status).toBe(200);
    await res.text();
    const records = await readJournal(b.runDir);
    const intent = onlyIntent(records);
    const settle = records.find((r): r is DispatchSettleRecord => r.kind === "settle")!;
    expect(settle.outcome).toBe("ceiling");
    expect(settle.traced).toBe(true);
    expect(settle.tokens).toBe(intent.ceilTokens);
    expect(settle.usd).toBeCloseTo(intent.ceilUsd, 12);
    expect(b.spends).toEqual([{ tokens: settle.tokens, usd: settle.usd }]);
  });

  it("a proven never-accepted transport failure settles the intent at zero and the journal restarts healthy", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const dead = await startUpstream(pathRef);
    await dead.close(); // refuse all connections from now on
    const a = await boot(dirs, dead.port);
    const res = await postCompletions(a, { messages: [], max_tokens: 5 });
    expect(res.status).toBe(502);
    expect(a.spends).toHaveLength(0);
    const records = await readJournal(a.runDir);
    expect(records.map((r) => r.kind)).toEqual(["intent", "settle"]);
    const settle = records[1] as DispatchSettleRecord;
    expect(settle).toMatchObject({ tokens: 0, usd: 0, outcome: "no-upstream", traced: true });
    await a.proxy.close(); // zero-settled is a CLEAN shutdown

    // Restart over the settled journal: healthy — no poison, no charge.
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    const b = await boot(dirs, upstream.port);
    expect((await b.proxy.dispatchRecovery()).poisoned).toBeUndefined();
    expect(b.spends).toHaveLength(0);
    const ok = await postCompletions(b, { messages: [], max_tokens: 5 });
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it("an intent that cannot become durable refuses the request pre-fetch, poisons the live proxy, and owes nothing on restart", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    const a = await boot(dirs, upstream.port, {
      journalIo: {
        async write() {
          throw new Error("EIO: simulated journal write failure");
        },
      },
    });

    // No intent → no fetch → nothing owed. The request fails closed with the
    // dispatch-authority error and the reservation is released without charge.
    const first = await postCompletions(a, { messages: [], max_tokens: 5 });
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      error: { type: "hone_dispatch_authority_failed" },
    });
    expect(upstream.calls).toHaveLength(0);
    expect(a.spends).toHaveLength(0);

    // The live journal is poisoned: the NEXT request is refused at the gate.
    const second = await postCompletions(a, { messages: [], max_tokens: 5 });
    expect(second.status).toBe(503);
    expect(upstream.calls).toHaveLength(0);
    await expect(a.proxy.close()).rejects.toThrow(/poisoned/);

    // Nothing durable ever described a dispatch, so a restart is healthy.
    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.poisoned).toBeUndefined();
    expect(report.chargedTotals).toEqual({ tokens: 0, usd: 0 });
    expect(b.spends).toHaveLength(0);
    const ok = await postCompletions(b, { messages: [], max_tokens: 5 });
    expect(ok.status).toBe(200);
    await ok.text();
    await b.proxy.close();
  });

  it("concurrent requests journal serialized, 1:1-matched intent/settle pairs with exact totals", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    const b = await boot(dirs, upstream.port, {
      // 1-byte writes make any missing serialization interleave the lines.
      journalIo: {
        async write(handle, buf, offset, length) {
          return DEFAULT_DURABLE_IO.write(handle, buf, offset, Math.min(1, length));
        },
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        postCompletions(b, { messages: [{ role: "user", content: `req-${i}` }], max_tokens: 5 }),
      ),
    );
    await Promise.all(responses.map((r) => r.text()));

    const records = await readJournal(b.runDir); // parseDispatchRecord throws on any torn/interleaved line
    const intentIndex = new Map<string, number>();
    const settleIndex = new Map<string, number>();
    for (const [i, r] of records.entries()) {
      if (r.kind === "intent") intentIndex.set(r.id, i);
      if (r.kind === "settle") settleIndex.set(r.id, i);
    }
    expect(intentIndex.size).toBe(6);
    expect(settleIndex.size).toBe(6);
    for (const [id, si] of settleIndex) {
      const ii = intentIndex.get(id);
      expect(ii).toBeDefined();
      expect(ii!).toBeLessThan(si); // every settle follows ITS intent
    }
    const state = await readDispatchJournalState(pathRef.path);
    expect(state.poisoned).toBeUndefined();
    expect(state.unmatched).toHaveLength(0);
    // Exact totals: journal charges == broker charges == 6 actual usages.
    expect(state.chargedTotals.tokens).toBe(6 * 120);
    expect(b.spends.reduce((t, s) => t + s.tokens, 0)).toBe(6 * 120);
    expect(b.spends.reduce((t, s) => t + s.usd, 0)).toBeCloseTo(state.chargedTotals.usd, 12);
  });
});

// ---------------------------------------------------------------------------
// crash recovery
// ---------------------------------------------------------------------------

describe("dispatch journal — crash recovery", () => {
  it("an unmatched intent (crash between intent fsync and settlement) is charged at its full ceiling exactly once and durably poisons the run", async () => {
    const { snapshot, intent } = await captureIntentOnlyJournal();
    const dirs = await seedRunDir(snapshot);
    const upstream = await startUpstream({ path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) });
    cleanups.push(() => upstream.close());

    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();

    // The full reserved ceiling was recovered and DELIVERED before any
    // admission could run — admission headroom includes the recovered charge.
    expect(report.poisoned).toMatch(/no settlement/);
    expect(report.recovered).toEqual([
      expect.objectContaining({ id: intent.id, tokens: intent.ceilTokens, usd: intent.ceilUsd }),
    ]);
    expect(report.chargedTotals).toEqual({ tokens: intent.ceilTokens, usd: intent.ceilUsd });
    expect(b.spends).toEqual([{ tokens: intent.ceilTokens, usd: intent.ceilUsd }]);

    // The missing-trace fact is durable: poison + recovered records on disk.
    const records = await readJournal(b.runDir);
    expect(records.map((r) => r.kind)).toEqual(["intent", "poison", "recovered"]);

    // Fail closed: no request is ever forwarded over the poisoned ledger.
    const refused = await postCompletions(b, { messages: [], max_tokens: 5 });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: { type: "hone_dispatch_authority_failed" },
    });
    expect(upstream.calls).toHaveLength(0);
    expect(b.spends).toHaveLength(1); // the refusal charged nothing further

    // ...and the run can never report a clean shutdown.
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/); // idempotent
  });

  it("replaying recovery (a second restart) never charges again and stays poisoned", async () => {
    const { snapshot, intent } = await captureIntentOnlyJournal();
    const dirs = await seedRunDir(snapshot);
    const upstream = await startUpstream({ path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) });
    cleanups.push(() => upstream.close());

    // First restart: recovers + charges the ceiling once.
    const b = await boot(dirs, upstream.port);
    await b.proxy.dispatchRecovery();
    expect(b.spends).toEqual([{ tokens: intent.ceilTokens, usd: intent.ceilUsd }]);
    await b.proxy.close().catch(() => undefined);
    const bytesAfterFirst = await readFile(join(dirs.runDir, DISPATCH_JOURNAL_FILE), "utf8");

    // Second restart (replay): matched by the recovered record — NO new
    // charge, no new journal writes, still terminally poisoned.
    const c = await boot(dirs, upstream.port);
    const replay = await c.proxy.dispatchRecovery();
    expect(replay.recovered).toHaveLength(0);
    expect(replay.poisoned).toMatch(/recovered at its ceiling|no settlement/);
    expect(replay.chargedTotals).toEqual({ tokens: intent.ceilTokens, usd: intent.ceilUsd });
    expect(c.spends).toHaveLength(0);
    expect(await readFile(join(dirs.runDir, DISPATCH_JOURNAL_FILE), "utf8")).toBe(bytesAfterFirst);

    const refused = await postCompletions(c, { messages: [], max_tokens: 5 });
    expect(refused.status).toBe(503);
    await expect(c.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
  });

  it("a crash captured strictly BEFORE fetch (at the intent fsync) recovers identically", async () => {
    // Snapshot taken inside the journal fsync hook: at that instant the
    // intent is durable and the fetch has NOT started — the exact
    // "after durable intent / before fetch" boundary.
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    let atIntentFsync: string | undefined;
    const a = await boot(dirs, upstream.port, {
      journalIo: {
        async syncFile(handle) {
          await DEFAULT_DURABLE_IO.syncFile(handle);
          atIntentFsync ??= readFileSync(pathRef.path, "utf8");
        },
      },
    });
    await (await postCompletions(a, { messages: [{ role: "user", content: "hi" }], max_tokens: 3 })).text();
    await a.proxy.close();
    const intent = onlyIntent(
      atIntentFsync!
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => parseDispatchRecord(l)),
    );

    const crashDirs = await seedRunDir(atIntentFsync!);
    const upstream2 = await startUpstream({ path: join(crashDirs.runDir, DISPATCH_JOURNAL_FILE) });
    cleanups.push(() => upstream2.close());
    const b = await boot(crashDirs, upstream2.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.recovered).toEqual([
      expect.objectContaining({ id: intent.id, tokens: intent.ceilTokens, usd: intent.ceilUsd }),
    ]);
    expect(b.spends).toEqual([{ tokens: intent.ceilTokens, usd: intent.ceilUsd }]);
    expect((await postCompletions(b, { messages: [], max_tokens: 3 })).status).toBe(503);
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
  });

  it("a fully settled journal restarts healthy — clean shutdown never poisons", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    const a = await boot(dirs, upstream.port);
    await (await postCompletions(a, { messages: [], max_tokens: 5 })).text();
    await a.proxy.close();

    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.poisoned).toBeUndefined();
    expect(report.recovered).toHaveLength(0);
    expect(report.chargedTotals.tokens).toBe(120); // prior settled charge, never re-delivered
    expect(b.spends).toHaveLength(0);
    const ok = await postCompletions(b, { messages: [], max_tokens: 5 });
    expect(ok.status).toBe(200);
    await ok.text();
    expect(b.spends).toHaveLength(1);
    await b.proxy.close(); // healthy history: clean shutdown
  });
});

// ---------------------------------------------------------------------------
// durable poison persistence (CAS / trace failures)
// ---------------------------------------------------------------------------

describe("dispatch journal — durable trace/CAS poison", () => {
  async function assertPoisonSurvivesRestart(
    faultIo: "casIo" | "traceIo",
    message: string,
  ): Promise<void> {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    const io: Partial<DurableIo> = {
      async syncFile() {
        throw new Error(message);
      },
    };
    const a = await boot(dirs, upstream.port, { [faultIo]: io });

    // The request fails closed; the charge is recorded; the settlement
    // durably records the UNMET trace obligation.
    const first = await postCompletions(a, { messages: [], max_tokens: 5 });
    await expect(first.text()).rejects.toThrow();
    expect(a.spends).toHaveLength(1);
    const records = await readJournal(a.runDir);
    expect(records.map((r) => r.kind)).toEqual(["intent", "settle"]);
    const settle = records[1] as DispatchSettleRecord;
    expect(settle.traced).toBe(false);
    expect(settle.traceError).toContain(message);
    await expect(a.proxy.close()).rejects.toThrow(/poisoned/);

    // Restart with HEALTHY IO: the durable traced:false fact still poisons —
    // no forwarding, no re-charge (the settlement matched its intent).
    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.poisoned).toMatch(/trace\/CAS publication failed/);
    expect(report.recovered).toHaveLength(0);
    expect(b.spends).toHaveLength(0);
    const callsBefore = upstream.calls.length;
    const refused = await postCompletions(b, { messages: [], max_tokens: 5 });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: { type: "hone_dispatch_authority_failed" },
    });
    expect(upstream.calls).toHaveLength(callsBefore);
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
  }

  it("a CAS body publication failure survives restart and blocks forwarding", async () => {
    await assertPoisonSurvivesRestart("casIo", "EIO: simulated cas fsync failure");
  });

  it("a trace append failure survives restart and blocks forwarding", async () => {
    await assertPoisonSurvivesRestart("traceIo", "EIO: simulated trace fsync failure");
  });

  it("a live settle-append WRITE failure poisons immediately and the restart recovers the intent at its ceiling", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    // The intent (first append) lands durably; the settle write never puts a
    // single byte on disk — the on-disk image is EXACTLY "crashed before
    // settle" even though the process stays alive.
    let appends = 0;
    const a = await boot(dirs, upstream.port, {
      journalIo: {
        async write(handle, buf, offset, length) {
          if (offset === 0) appends += 1;
          if (appends > 1) throw new Error("EIO: simulated journal write failure");
          return DEFAULT_DURABLE_IO.write(handle, buf, offset, length);
        },
      },
    });

    // The settle append fails AFTER recordSpend: the actual charge stands,
    // the reservation is retained, the client fails closed, and the journal
    // is live-poisoned so the next request is refused pre-upstream.
    const first = await postCompletions(a, { messages: [], max_tokens: 5 });
    await expect(first.text()).rejects.toThrow();
    expect(a.spends).toHaveLength(1);
    expect(a.spends[0]!.tokens).toBe(120);
    const refused = await postCompletions(a, { messages: [], max_tokens: 5 });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: { type: "hone_dispatch_authority_failed" },
    });
    expect(upstream.calls).toHaveLength(1);
    await expect(a.proxy.close()).rejects.toThrow(/poisoned/);

    // Restart: the intent is unmatched on disk (the settle never became
    // durable) → the FULL reserved ceiling is charged (the worst-case bound
    // for any upstream honoring the admitted max_tokens), and the run stays
    // poisoned.
    const intent = onlyIntent(await readJournal(dirs.runDir));
    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.recovered).toEqual([
      expect.objectContaining({ id: intent.id, tokens: intent.ceilTokens, usd: intent.ceilUsd }),
    ]);
    expect(b.spends).toEqual([{ tokens: intent.ceilTokens, usd: intent.ceilUsd }]);
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
  });
});

// ---------------------------------------------------------------------------
// torn tails and corruption
// ---------------------------------------------------------------------------

describe("dispatch journal — torn tails and corruption", () => {
  it("a torn tail behind settled history is dropped and truncated; the journal restarts healthy", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    const a = await boot(dirs, upstream.port);
    await (await postCompletions(a, { messages: [], max_tokens: 5 })).text();
    await a.proxy.close();
    // Crash mid-append: an unterminated fragment. Its append never resolved,
    // so no dispatch ever proceeded on its authority.
    await appendFile(pathRef.path, '{"v":1,"kind":"intent","id":"torn', "utf8");

    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.poisoned).toBeUndefined();
    expect(report.recovered).toHaveLength(0);
    expect(b.spends).toHaveLength(0);
    const ok = await postCompletions(b, { messages: [], max_tokens: 5 });
    expect(ok.status).toBe(200);
    await ok.text();
    // The fragment was truncated before the new appends: every line parses.
    const records = await readJournal(b.runDir);
    expect(records.map((r) => r.kind)).toEqual(["intent", "settle", "intent", "settle"]);
    await b.proxy.close();
  });

  it("a torn SETTLE fragment does not resurrect its dispatch: the intent is still recovered at the ceiling", async () => {
    const { snapshot, intent } = await captureIntentOnlyJournal();
    // The settle was mid-write when the process died: torn, never durable.
    const dirs = await seedRunDir(
      `${snapshot}{"v":1,"kind":"settle","id":"${intent.id}","tokens":120,"usd":0.0006,"outcome":"usage","traced":true`,
    );
    const upstream = await startUpstream({ path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) });
    cleanups.push(() => upstream.close());
    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.recovered).toEqual([
      expect.objectContaining({ id: intent.id, tokens: intent.ceilTokens, usd: intent.ceilUsd }),
    ]);
    expect(report.poisoned).toMatch(/no settlement/);
    expect(b.spends).toEqual([{ tokens: intent.ceilTokens, usd: intent.ceilUsd }]);
    expect((await postCompletions(b, { messages: [], max_tokens: 5 })).status).toBe(503);
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
  });

  it("a corrupt TERMINATED line poisons the journal without charging anything", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    const a = await boot(dirs, upstream.port);
    await (await postCompletions(a, { messages: [], max_tokens: 5 })).text();
    await a.proxy.close();
    await appendFile(pathRef.path, "certainly-not-json\n", "utf8");

    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.poisoned).toMatch(/corrupt dispatch journal line 3/);
    expect(report.recovered).toHaveLength(0); // history matched; nothing to charge
    expect(b.spends).toHaveLength(0);
    expect((await postCompletions(b, { messages: [], max_tokens: 5 })).status).toBe(503);
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
  });

  it("an unsupported journal version fails closed", async () => {
    const dirs = await seedRunDir(
      `${JSON.stringify({ v: 2, kind: "intent", id: "future" })}\n`,
    );
    const upstream = await startUpstream({ path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) });
    cleanups.push(() => upstream.close());
    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.poisoned).toMatch(/unsupported dispatch journal version 2/);
    expect(b.spends).toHaveLength(0);
    expect((await postCompletions(b, { messages: [], max_tokens: 5 })).status).toBe(503);
    expect(upstream.calls).toHaveLength(0);
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
  });
});

// ---------------------------------------------------------------------------
// settlement state machine — broker charge failures
// ---------------------------------------------------------------------------

describe("settlement state machine — broker charge failures", () => {
  it("recordSpend throwing BEFORE the broker durably records: no clean response, one charge attempt, intent unmatched, poisoned close", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    let attempts = 0;
    const a = await boot(dirs, upstream.port, {
      recordSpend: () => {
        attempts += 1;
        throw new Error("EPIPE: simulated broker admin socket failure");
      },
    });

    // The client never observes a clean response over an unsettled charge.
    const first = await postCompletions(a, { messages: [], max_tokens: 5 });
    await expect(first.text()).rejects.toThrow();

    // The handler's finally RESUMED the settlement plan but never re-ran the
    // failed spend phase: exactly one charge attempt, never a deliberate
    // second delivery of the same charge.
    expect(attempts).toBe(1);

    // No settle record exists — the durable intent stays unmatched, and no
    // silent reservation refund produced a phantom journal settlement.
    const records = await readJournal(a.runDir);
    expect(records.map((r) => r.kind)).toEqual(["intent"]);
    const state = await readDispatchJournalState(pathRef.path);
    expect(state.unmatched).toHaveLength(1);

    // Dispatch authority is poisoned in-memory: the next request is refused
    // BEFORE the upstream, and close() can never report a clean shutdown.
    const refused = await postCompletions(a, { messages: [], max_tokens: 5 });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: { type: "hone_dispatch_authority_failed" },
    });
    expect(upstream.calls).toHaveLength(1);
    expect(attempts).toBe(1);
    await expect(a.proxy.close()).rejects.toThrow(/broker charge for dispatch .* did not settle/);
  });

  it("recordSpend throwing AFTER the broker durably recorded (lost ack): restart re-charges the ceiling — over-count, never under-count", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    // The broker DID record the charge; only the acknowledgement was lost.
    const durableCharges: SpendRecord[] = [];
    const a = await boot(dirs, upstream.port, {
      recordSpend: (s) => {
        durableCharges.push(s);
        throw new Error("ECONNRESET: simulated ack loss after durable charge");
      },
    });

    const first = await postCompletions(a, { messages: [], max_tokens: 5 });
    await expect(first.text()).rejects.toThrow();
    expect(durableCharges).toEqual([{ tokens: 120, usd: expect.any(Number) }]);
    // The proxy cannot distinguish this from the never-recorded case: the
    // intent stays unmatched and the shutdown is never clean.
    expect((await readDispatchJournalState(pathRef.path)).unmatched).toHaveLength(1);
    await expect(a.proxy.close()).rejects.toThrow(/broker charge for dispatch .* did not settle/);

    // Restart: recovery charges the FULL reserved ceiling exactly once. With
    // the first charge durable broker-side, the cumulative total is actual +
    // ceiling — the irreducible over-count window — never an under-count,
    // and the run stays terminally poisoned.
    const intent = onlyIntent(await readJournal(dirs.runDir));
    const b = await boot(dirs, upstream.port);
    const report = await b.proxy.dispatchRecovery();
    expect(report.recovered).toEqual([
      expect.objectContaining({ id: intent.id, tokens: intent.ceilTokens, usd: intent.ceilUsd }),
    ]);
    expect(b.spends).toEqual([{ tokens: intent.ceilTokens, usd: intent.ceilUsd }]);
    expect((await postCompletions(b, { messages: [], max_tokens: 5 })).status).toBe(503);
    await expect(b.proxy.close()).rejects.toThrow(/dispatch authority poisoned/);
  });

  it("a transport-ambiguous ceiling settlement whose recordSpend throws also fails closed: no 502 body completes cleanly", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    // An upstream that accepts the TCP connection then destroys it mid-
    // request: NOT provably unaccepted, so the ceiling settlement runs.
    const abortive = http.createServer((req) => req.destroy());
    await new Promise<void>((resolve) => abortive.listen(0, "127.0.0.1", resolve));
    const addr = abortive.address();
    const abortivePort = typeof addr === "object" && addr !== null ? addr.port : 0;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          abortive.close(() => resolve());
          abortive.closeAllConnections();
        }),
    );
    let attempts = 0;
    const a = await boot(dirs, abortivePort, {
      recordSpend: () => {
        attempts += 1;
        throw new Error("EPIPE: simulated broker admin socket failure");
      },
    });

    const res = await postCompletions(a, { messages: [], max_tokens: 5 }).then(
      (r) => r.text().then(() => "clean" as const, () => "destroyed" as const),
      () => "destroyed" as const,
    );
    expect(res).toBe("destroyed");
    expect(attempts).toBe(1);
    expect((await readDispatchJournalState(pathRef.path)).unmatched).toHaveLength(1);
    await expect(a.proxy.close()).rejects.toThrow(/broker charge for dispatch .* did not settle/);
  });
});

// ---------------------------------------------------------------------------
// poison latch race (post-intent pre-fetch fence)
// ---------------------------------------------------------------------------

describe("dispatch journal — poison latch race", () => {
  it("a request that passed the gates BEFORE a concurrent poison never dispatches: intent settled zero/no-upstream, journal complete", async () => {
    const dirs = await freshDirs();
    const pathRef = { path: join(dirs.runDir, DISPATCH_JOURNAL_FILE) };
    const upstream = await startUpstream(pathRef);
    cleanups.push(() => upstream.close());
    // CAS publication fails for every trace: request A's settlement poisons
    // the trace log and latches the dispatch poison.
    const b = await boot(dirs, upstream.port, {
      casIo: {
        async syncFile() {
          throw new Error("EIO: simulated cas fsync failure");
        },
      },
    });

    // Request B: headers + HALF the body, held open. Its handler enters now,
    // passes the top-of-handler poison gates (nothing is poisoned yet), and
    // stalls inside body buffering.
    const bodyB = JSON.stringify({ messages: [{ role: "user", content: "held" }], max_tokens: 5 });
    const half = Math.floor(bodyB.length / 2);
    const reqB = http.request({
      host: "127.0.0.1",
      port: b.port,
      method: "POST",
      path: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(bodyB),
        authorization: `Bearer ${b.proxy.tokenFor("mutation")}`,
      },
    });
    const responseB = new Promise<{ status: number; body: string }>((resolve, reject) => {
      reqB.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      reqB.on("error", reject);
    });
    reqB.write(bodyB.slice(0, half));
    await sleep(150); // B is past the gates and awaiting its remaining body bytes

    // Request A runs to completion: its CAS publication fails, the trace log
    // poisons, and its settle lands traced:false — dispatch poison latched.
    const resA = await postCompletions(b, { messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
    await expect(resA.text()).rejects.toThrow();
    expect(b.spends).toHaveLength(1);
    expect(upstream.calls).toHaveLength(1);

    // Release B: it admits and appends its durable intent — the post-intent
    // fence must observe the latched poison BEFORE any fetch.
    reqB.write(bodyB.slice(half));
    reqB.end();
    const got = await responseB;
    expect(got.status).toBe(503);
    expect(JSON.parse(got.body)).toMatchObject({ error: { type: "hone_trace_authority_failed" } });

    // The upstream NEVER saw B and no second charge was recorded.
    expect(upstream.calls).toHaveLength(1);
    expect(b.spends).toHaveLength(1);

    // B's durable intent is matched by a zero/no-upstream settlement: the
    // journal is COMPLETE — nothing unmatched for restart recovery to
    // ceiling-charge — even though the run is terminally poisoned by A.
    const records = await readJournal(b.runDir);
    expect(records.map((r) => r.kind)).toEqual(["intent", "settle", "intent", "settle"]);
    const intentB = records[2] as DispatchIntentRecord;
    const settleB = records[3] as DispatchSettleRecord;
    expect(settleB.id).toBe(intentB.id);
    expect(settleB).toMatchObject({ tokens: 0, usd: 0, outcome: "no-upstream", traced: true });
    const state = await readDispatchJournalState(pathRef.path);
    expect(state.unmatched).toHaveLength(0);
    expect(state.poisoned).toMatch(/trace\/CAS publication failed/);

    // Terminal view: close() still rejects — the poison is A's, not an
    // accounting hole left by B.
    await expect(b.proxy.close()).rejects.toThrow(/poisoned/);
  });
});
