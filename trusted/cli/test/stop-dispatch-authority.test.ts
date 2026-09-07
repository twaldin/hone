import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { stopCommand } from "../src/commands/stop.js";
import {
  at,
  fixtureEvents,
  initScratchRepo,
  makeIo,
  makeRoot,
  readLogLines,
  sealGitBaselineSnapshot,
  tarToCas,
  writeAlignedDispatchJournal,
  writeEvents,
} from "./helpers.js";

/**
 * Proxy dispatch authority gates every stop terminal path (P1): a dead
 * unfinished run may only be finalized — and a finished run only applied —
 * over a dispatch journal whose every intent has a durable, traced terminal
 * record and whose cumulative charge the trusted budget authority covers.
 * fixtureEvents' budget.snapshot records 4200 tokens / $1.25 of proxy spend,
 * so the aligned journal charges exactly that; every bad shape below must
 * refuse WITHOUT appending a terminal, applying anything, or mutating the
 * journal (dead-stop has no live broker — reconciliation is resume's).
 */

const SPENT_TOKENS = 4200;
const SPENT_USD = 1.25;

function intentLine(id: string, ceilTokens = SPENT_TOKENS, ceilUsd = SPENT_USD): string {
  return `${JSON.stringify({
    v: 1,
    kind: "intent",
    id,
    runId: "run_dispatch_auth",
    role: "mutation",
    model: "m",
    requestAt: at(),
    requestSha256: "0".repeat(64),
    promptTokens: Math.max(ceilTokens - 1, 0),
    completionTokens: 1,
    ceilTokens,
    ceilUsd,
  })}\n`;
}

function settleLine(id: string, opts: { tokens?: number; usd?: number; traced?: boolean } = {}): string {
  return `${JSON.stringify({
    v: 1,
    kind: "settle",
    id,
    tokens: opts.tokens ?? SPENT_TOKENS,
    usd: opts.usd ?? SPENT_USD,
    outcome: "usage",
    traced: opts.traced ?? true,
    ...(opts.traced === false ? { traceError: "EIO: simulated trace fsync failure" } : {}),
  })}\n`;
}

function recoveredLine(id: string): string {
  return `${JSON.stringify({ v: 1, kind: "recovered", id, tokens: SPENT_TOKENS, usd: SPENT_USD, at: at() })}\n`;
}

function poisonLine(reason: string): string {
  return `${JSON.stringify({ v: 1, kind: "poison", reason, at: at() })}\n`;
}

function deadRun(root: string, finished = false): { runId: string; runDir: string; journalPath: string } {
  const runId = "run_dispatch_auth";
  const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
  const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
  const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash, bestHash, finished }));
  return { runId, runDir, journalPath: join(runDir, "proxy-dispatch.ndjson") };
}

function events(root: string, runId: string): RunEvent[] {
  return readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
}

interface BadCase {
  name: string;
  journal: string | null;
  message: RegExp;
}

const BAD_CASES: BadCase[] = [
  {
    name: "an UNMATCHED intent (upstream charge unreconciled)",
    journal: intentLine("d1"),
    message: /dispatch intent\(s\) have no settlement.*resume required/,
  },
  {
    name: "a durable POISON fact",
    journal: poisonLine("trace/CAS publication failed for dispatch dX"),
    message: /proxy dispatch authority failed: trace\/CAS publication failed/,
  },
  {
    name: "a CORRUPT terminated line",
    journal: `${intentLine("d1")}${settleLine("d1")}certainly-not-json\n`,
    message: /proxy dispatch authority failed: corrupt dispatch journal line 3/,
  },
  {
    name: "a traced:false settlement (trace obligation unmet forever)",
    journal: `${intentLine("d1")}${settleLine("d1", { traced: false })}`,
    message: /proxy dispatch authority failed: trace\/CAS publication failed for dispatch d1/,
  },
  {
    name: "a RECOVERED fact (crash recovery charged the ceiling; the trace is missing)",
    journal: `${intentLine("d1")}${recoveredLine("d1")}`,
    message: /proxy dispatch authority failed: dispatch d1 was recovered at its ceiling/,
  },
  {
    name: "an UNDERCHARGED broker (journal cumulative charge above trusted spend)",
    journal: `${intentLine("d1", 9000, 9)}${settleLine("d1", { tokens: 9000, usd: 9 })}`,
    message: /broker spend authority is behind the dispatch authority.*resume required/,
  },
  {
    name: "a MISSING journal while the trusted budget authority recorded proxy spend",
    journal: null,
    message: /proxy dispatch journal is missing but the trusted budget authority recorded 4200 tokens/,
  },
];

describe("stop refuses to finalize a dead UNFINISHED run over failed dispatch authority", () => {
  for (const bad of BAD_CASES) {
    it(`${bad.name}: nonzero exit, no terminal event, journal untouched`, async () => {
      const root = makeRoot();
      const { runId, journalPath } = deadRun(root);
      if (bad.journal !== null) writeFileSync(journalPath, bad.journal);
      const before = bad.journal !== null ? readFileSync(journalPath, "utf8") : null;

      const { io, err } = makeIo(root);
      expect(await stopCommand([], io)).toBe(1);
      expect(err.join("\n")).toMatch(bad.message);
      // No terminal was appended — the run stays resumable.
      expect(events(root, runId).some((e) => e.type === "run.finished")).toBe(false);
      // Dead-stop NEVER mutates or recovers the journal (no live broker):
      // byte-identical before and after, and no journal is ever created.
      if (before !== null) expect(readFileSync(journalPath, "utf8")).toBe(before);
      else expect(existsSync(journalPath)).toBe(false);
    });
  }

  it("a MISSING journal with a proxy-trace log present refuses even at zero recorded spend", async () => {
    const root = makeRoot();
    const runId = "run_trace_only";
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    // Zero-spend snapshot: only the trace file betrays that a dispatch happened.
    const fixture = fixtureEvents({ runId, baselineHash, bestHash: baselineHash, finished: false }).map((e) =>
      e.type === "budget.snapshot"
        ? { ...e, budget: { ...e.budget, spent: { ...e.budget.spent, tokens: 0, usd: 0 } } }
        : e,
    );
    const runDir = writeEvents(root, runId, fixture);
    writeFileSync(join(runDir, "proxy-trace.ndjson"), '{"v":1}\n');

    const { io, err } = makeIo(root);
    expect(await stopCommand([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/journal is missing but proxy-trace\.ndjson exists/);
    expect(events(root, runId).some((e) => e.type === "run.finished")).toBe(false);
  });

  it("a CLEAN aligned journal still finalizes the dead run as stopped", async () => {
    const root = makeRoot();
    const { runId } = deadRun(root);
    writeAlignedDispatchJournal(root, runId);
    const { io } = makeIo(root);
    expect(await stopCommand([], io)).toBe(0);
    const all = events(root, runId);
    const last = all[all.length - 1];
    expect(last?.type).toBe("run.finished");
    if (last?.type === "run.finished") expect(last.status).toBe("stopped");
  });

  it("a MISSING journal with zero recorded spend and no trace log proves no dispatch — finalizes", async () => {
    const root = makeRoot();
    const runId = "run_no_dispatch";
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const fixture = fixtureEvents({ runId, baselineHash, bestHash: baselineHash, finished: false }).map((e) =>
      e.type === "budget.snapshot"
        ? { ...e, budget: { ...e.budget, spent: { ...e.budget.spent, tokens: 0, usd: 0 } } }
        : e,
    );
    writeEvents(root, runId, fixture);
    const { io } = makeIo(root);
    expect(await stopCommand([], io)).toBe(0);
    expect(events(root, runId).at(-1)?.type).toBe("run.finished");
  });
});

describe("an already-FINISHED historical terminal cannot bypass the dispatch authority gate", () => {
  it("refuses idempotent-finish AND --take-best delivery over an unmatched intent; nothing applied, nothing appended", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const { runId, journalPath } = deadRun(root, true);
    sealGitBaselineSnapshot(root, runId, repo);
    const journalBytes = intentLine("d1");
    writeFileSync(journalPath, journalBytes);
    const linesBefore = readLogLines(root, runId).length;

    const { io, err } = makeIo(root);
    expect(await stopCommand(["--take-best", "--repo", "repo"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/dispatch intent\(s\) have no settlement.*resume required/);
    // The finished event already existed — but nothing NEW was appended and
    // nothing was delivered over the failed dispatch ledger.
    expect(readLogLines(root, runId).length).toBe(linesBefore);
    const refs = spawnSync("git", ["-C", repo, "for-each-ref", "refs/heads/hone/"], { encoding: "utf8" });
    expect(refs.stdout.trim()).toBe("");
    // The journal itself was never mutated or "repaired".
    expect(readFileSync(journalPath, "utf8")).toBe(journalBytes);
  });

  it("refuses over a durable poison even without --take-best", async () => {
    const root = makeRoot();
    const { runId, journalPath } = deadRun(root, true);
    writeFileSync(journalPath, poisonLine("dispatch d9 settled without a trace record"));
    const linesBefore = readLogLines(root, runId).length;
    const { io, err } = makeIo(root);
    expect(await stopCommand([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/proxy dispatch authority failed/);
    expect(readLogLines(root, runId).length).toBe(linesBefore);
  });

  it("passes idempotently over a clean aligned journal", async () => {
    const root = makeRoot();
    const { runId } = deadRun(root, true);
    writeAlignedDispatchJournal(root, runId);
    const { io } = makeIo(root);
    expect(await stopCommand([], io)).toBe(0);
    expect(events(root, runId).filter((e) => e.type === "run.finished").length).toBe(1);
  });
});
