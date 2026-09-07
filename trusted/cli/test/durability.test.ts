import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, eventsPath, readEvents, syncDir, writeAllSync, writeFileDurable } from "../src/eventlog.js";
import { CAP_ID, FIX_OPTIMIZER_DIGEST, at, fakeHash, makeRoot } from "./helpers.js";

/**
 * Durable publication primitives: short writes must never let a truncated
 * seal reach fsync+rename, and the event log's FIRST acknowledged append
 * must create the file (its dirent fsync is on that code path).
 */

describe("writeAllSync (injected short writes)", () => {
  it("writes the whole buffer through a short-writing fd", () => {
    const root = makeRoot();
    const path = join(root, "out.bin");
    const fd = openSync(path, "w");
    const calls: number[] = [];
    try {
      writeAllSync(fd, Buffer.from("hello durable world", "utf8"), (f, buffer, offset, length) => {
        const n = Math.min(3, length);
        calls.push(n);
        return writeSync(f, buffer, offset, n);
      });
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path, "utf8")).toBe("hello durable world");
    expect(calls.length).toBeGreaterThan(1); // the loop actually resumed short writes
  });

  it("a zero-progress write fails instead of spinning or acknowledging a truncation", () => {
    const root = makeRoot();
    const fd = openSync(join(root, "stall.bin"), "w");
    try {
      expect(() => writeAllSync(fd, Buffer.from("x"), () => 0)).toThrow(/short write stalled/);
    } finally {
      closeSync(fd);
    }
  });
});

describe("writeFileDurable (whole-or-absent publication)", () => {
  it("publishes the full content through injected short writes and leaves no tmp behind", () => {
    const root = makeRoot();
    const path = join(root, "seal.json");
    writeFileDurable(path, "0123456789", (f, buffer, offset, length) => writeSync(f, buffer, offset, Math.min(2, length)));
    expect(readFileSync(path, "utf8")).toBe("0123456789");
    expect(readdirSync(root).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("a stalled write never publishes a truncated seal (rename is never reached)", () => {
    const root = makeRoot();
    const path = join(root, "seal.json");
    let budget = 4;
    expect(() =>
      writeFileDurable(path, "0123456789", (f, buffer, offset, length) => (budget-- > 0 ? writeSync(f, buffer, offset, Math.min(1, length)) : 0)),
    ).toThrow(/short write stalled/);
    expect(existsSync(path)).toBe(false); // fail closed: no torn seal at the published path
  });

  it("overwrites atomically: the published path always parses as one of the two whole contents", () => {
    const root = makeRoot();
    const path = join(root, "seal.json");
    writeFileDurable(path, `${JSON.stringify({ v: 1 })}\n`);
    writeFileDurable(path, `${JSON.stringify({ v: 2 })}\n`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ v: 2 });
  });
});

describe("event-log dirent durability (EVERY append pins the run dir)", () => {
  it("the first append creates the log, fsyncs the run dir, and is replayable", () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_dur1");
    mkdirSync(runDir, { recursive: true });
    expect(existsSync(eventsPath(runDir))).toBe(false);
    const synced: string[] = [];
    appendEvent(
      runDir,
      {
        runId: "run_dur1",
        at: at(),
        type: "run.started",
        capsuleId: CAP_ID,
        contractHash: fakeHash("c"),
        optimizerDigest: FIX_OPTIMIZER_DIGEST,
      },
      (dir) => {
        synced.push(dir);
        syncDir(dir);
      },
    );
    expect(synced).toEqual([runDir]);
    const events = readEvents(runDir);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("run.started");
  });

  it("RECOVERY append: a log file created by a killed process (dirent possibly never durable) is re-pinned on the next append", () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_dur2");
    mkdirSync(runDir, { recursive: true });
    // Simulate a killed creator: the file EXISTS (page cache) with one
    // acknowledged line, but this process never observed creating it.
    writeFileSync(
      eventsPath(runDir),
      `${JSON.stringify({ runId: "run_dur2", at: at(), type: "run.started", capsuleId: CAP_ID, contractHash: fakeHash("c"), optimizerDigest: FIX_OPTIMIZER_DIGEST })}\n`,
    );
    const synced: string[] = [];
    appendEvent(runDir, { runId: "run_dur2", at: at(), type: "run.resumed", fromCursor: 1 }, (dir) => {
      synced.push(dir);
      syncDir(dir);
    });
    // The simplest safe policy: the run dir is fsynced on EVERY append —
    // never only behind a created-by-me observation.
    expect(synced).toEqual([runDir]);
    expect(readEvents(runDir).length).toBe(2);
  });

  it("a concurrent-creator interleaving still pins the dirent for BOTH acknowledgers", () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_dur3");
    mkdirSync(runDir, { recursive: true });
    const synced: string[] = [];
    const seam = (dir: string): void => {
      synced.push(dir);
      syncDir(dir);
    };
    // Two appenders race file creation (O_APPEND keeps lines whole); each
    // acknowledgment must independently carry a run-dir fsync.
    appendEvent(runDir, { runId: "run_dur3", at: at(), type: "run.started", capsuleId: CAP_ID, contractHash: fakeHash("c"), optimizerDigest: FIX_OPTIMIZER_DIGEST }, seam);
    appendEvent(runDir, { runId: "run_dur3", at: at(), type: "run.resumed", fromCursor: 1 }, seam);
    expect(synced).toEqual([runDir, runDir]);
    expect(readEvents(runDir).length).toBe(2);
  });

  it("syncDir pins an existing directory and refuses a missing one", () => {
    const root = makeRoot();
    expect(() => syncDir(root)).not.toThrow();
    expect(() => syncDir(join(root, "absent"))).toThrow();
  });
});
