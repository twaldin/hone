import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "@hone/schema";
import { EventLog, replay } from "../src/index.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "run.events.ndjson");

const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hone-eventlog-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = "2026-07-14T12:00:00.000Z";
const hash = (c: string) => `sha256:${c.repeat(64)}`;
const started: RunEvent = {
  runId: "r1",
  at,
  type: "run.started",
  capsuleId: "cap_0123456789ab",
  contractHash: hash("a"),
  optimizerDigest: hash("b"),
};

describe("event log: append", () => {
  it("appends one NDJSON line per event and returns the 0-based cursor", async () => {
    const log = new EventLog(join(tmp(), "events.ndjson"));
    expect(await log.append(started)).toBe(0);
    expect(await log.append({ runId: "r1", at, type: "budget.exhausted", dimension: "usd" })).toBe(1);
    await log.close();
    const lines = readFileSync(log.path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).type).toBe("run.started");
  });

  it("zod-rejects garbage before anything hits disk", async () => {
    const log = new EventLog(join(tmp(), "events.ndjson"));
    // biome-ignore format: intentionally malformed
    await expect(log.append({ runId: "r1", at, type: "nonsense" } as unknown as RunEvent)).rejects.toThrow();
    expect(await log.read()).toHaveLength(0);
    await log.close();
  });
});

describe("event log: read", () => {
  it("reads from a cursor, returning events with their cursors", async () => {
    const log = new EventLog(join(tmp(), "events.ndjson"));
    await log.append(started);
    await log.append({ runId: "r1", at, type: "budget.exhausted", dimension: "usd" });
    const all = await log.read();
    expect(all.map((e) => e.cursor)).toEqual([0, 1]);
    const fromOne = await log.read(1);
    expect(fromOne).toHaveLength(1);
    expect(fromOne[0]!.event.type).toBe("budget.exhausted");
    await log.close();
  });

  it("tolerates a torn trailing line (crash mid-write) but rejects torn interior lines", async () => {
    const dir = tmp();
    const p = join(dir, "events.ndjson");
    const log = new EventLog(p);
    await log.append(started);
    await log.close();
    appendFileSync(p, '{"runId":"r1","at":"2026-'); // torn write, no newline
    const events = await new EventLog(p).read();
    expect(events).toHaveLength(1);

    const bad = join(dir, "bad.ndjson");
    writeFileSync(bad, '{"broken\n' + JSON.stringify(started) + "\n");
    await expect(new EventLog(bad).read()).rejects.toThrow(/line 0/);
  });

  it("read on a nonexistent file is an empty log, not an error", async () => {
    expect(await new EventLog(join(tmp(), "never-written.ndjson")).read()).toEqual([]);
  });
});

describe("event log: tail", () => {
  it("yields existing events, then events appended while tailing, and ends at run.finished", async () => {
    const log = new EventLog(join(tmp(), "events.ndjson"));
    await log.append(started);
    const seen: string[] = [];
    const iter = log.tail(0, { pollMs: 5 });
    seen.push((await iter.next()).value!.event.type);
    // Appended AFTER the tail consumed everything present — must still arrive.
    await log.append({ runId: "r1", at, type: "run.finished", status: "stopped" });
    seen.push((await iter.next()).value!.event.type);
    expect((await iter.next()).done).toBe(true); // run.finished terminates the stream
    expect(seen).toEqual(["run.started", "run.finished"]);
    await log.close();
  });

  it("stops when aborted", async () => {
    const log = new EventLog(join(tmp(), "events.ndjson"));
    await log.append(started);
    const ac = new AbortController();
    const iter = log.tail(0, { pollMs: 5, signal: ac.signal });
    expect((await iter.next()).value!.event.type).toBe("run.started");
    ac.abort();
    expect((await iter.next()).done).toBe(true);
    await log.close();
  });
});

describe("event log: replay — the resumability contract", () => {
  it("reconstructs incumbent, episodes, budget, status, holdout ledger from the fixture log", async () => {
    const events = (await new EventLog(fixture).read()).map((e) => e.event);
    const state = replay(events);
    expect(state.incumbent).toEqual({ hash: hash("2") });
    expect(state.episodesDone).toBe(2); // ep0 gate.paired, ep1 invalid unrepaired
    expect(state.status).toBe("completed");
    expect(state.budgetLast?.spent.evaluatorInvocations).toBe(3);
    expect(state.holdoutLedger).toEqual({ count: 1, budget: 5 });
  });

  it("second replay is byte-identical to the first", async () => {
    const events = (await new EventLog(fixture).read()).map((e) => e.event);
    const a = Buffer.from(JSON.stringify(replay(events)), "utf8");
    const b = Buffer.from(JSON.stringify(replay(events)), "utf8");
    expect(a.equals(b)).toBe(true);
  });

  it("an episode.invalid with repaired=true does NOT finish the episode", () => {
    const state = replay([
      started,
      { runId: "r1", at, type: "episode.started", episode: 0, parent: { hash: hash("1") } },
      { runId: "r1", at, type: "episode.invalid", episode: 0, reason: "syntax", repaired: true },
    ]);
    expect(state.episodesDone).toBe(0);
    expect(state.status).toBe("running");
  });

  it("empty log replays to a pending run", () => {
    const state = replay([]);
    expect(state).toEqual({
      incumbent: null,
      episodesDone: 0,
      budgetLast: null,
      status: "pending",
      holdoutLedger: null,
    });
  });
});
