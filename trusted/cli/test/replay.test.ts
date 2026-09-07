import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvents, replay, replayRun, bestArtifact } from "../src/eventlog.js";
import { fakeHash, fixtureEvents, makeRoot, writeEvents } from "./helpers.js";

describe("event log replay", () => {
  it("reconstructs cursor, incumbent, budget, and status from the stream alone", () => {
    const events = fixtureEvents({ runId: "run_r1", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false });
    const st = replay(events);
    expect(st.runId).toBe("run_r1");
    expect(st.cursor).toBe(events.length);
    expect(st.status).toBe("running");
    expect(st.nextEpisode).toBe(1);
    expect(st.baselineArtifact?.hash).toBe(fakeHash("b"));
    expect(st.incumbent?.artifact.hash).toBe(fakeHash("d"));
    expect(st.incumbent?.aggregate).toBeCloseTo(0.62);
    expect(st.incumbent?.deltaVsBaseline).toBeCloseTo(0.12);
    expect(st.lastBudget?.spent.usd).toBeCloseTo(1.25);
    expect(bestArtifact(st)?.hash).toBe(fakeHash("d"));
  });

  it("replays a durable pre-terminal budget exhaustion latch", () => {
    const events = fixtureEvents({ runId: "run_budget_replay", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false });
    events.push({
      runId: "run_budget_replay",
      at: new Date().toISOString(),
      type: "budget.exhausted",
      dimension: "tokens",
    });
    const st = replay(events);
    expect(st.budgetExhaustedDimension).toBe("tokens");
    expect(st.finished).toBeNull();
  });

  it("replays the one durable delivery outcome before terminalization", () => {
    const events = fixtureEvents({ runId: "run_delivery_replay", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false });
    events.push({
      runId: "run_delivery_replay",
      at: new Date().toISOString(),
      type: "delivery.applied",
      mode: "auto",
      ref: "hone/run_delivery_replay",
    });
    expect(replay(events).delivery).toEqual({
      mode: "auto",
      ref: "hone/run_delivery_replay",
    });
  });

  it("run.finished settles status and best", () => {
    const events = fixtureEvents({ runId: "run_r2", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: true });
    const st = replay(events);
    expect(st.status).toBe("completed");
    expect(st.finished?.best?.hash).toBe(fakeHash("d"));
  });

  it("tolerates a torn trailing line (crash mid-append)", () => {
    const root = makeRoot();
    const runDir = writeEvents(root, "run_torn", fixtureEvents({ runId: "run_torn", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false }));
    appendFileSync(join(runDir, "events.ndjson"), '{"runId":"run_torn","at":"2026-');
    const events = readEvents(runDir);
    expect(events.length).toBe(7);
    const st = replayRun(runDir);
    expect(st.cursor).toBe(7);
    expect(st.status).toBe("running");
  });

  it("ignores a complete JSON event without its acknowledging newline", () => {
    const root = makeRoot();
    const all = fixtureEvents({ runId: "run_valid_tail", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: true });
    const runDir = writeEvents(root, "run_valid_tail", all.slice(0, -1));
    appendFileSync(join(runDir, "events.ndjson"), JSON.stringify(all[all.length - 1]));
    const events = readEvents(runDir);
    expect(events).toHaveLength(all.length - 1);
    expect(replay(events).finished).toBeNull();
  });

  it("rejects interior corruption — the log is trusted state", () => {
    const root = makeRoot();
    const good = fixtureEvents({ runId: "run_bad", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false });
    const runDir = writeEvents(root, "run_bad", good.slice(0, 3));
    appendFileSync(join(runDir, "events.ndjson"), "not json at all\n");
    appendFileSync(join(runDir, "events.ndjson"), `${JSON.stringify(good[3])}\n`);
    expect(() => readEvents(runDir)).toThrow(/corrupt/i);
  });

  it("rejects schema-invalid interior events", () => {
    const root = makeRoot();
    const runDir = writeEvents(root, "run_inv", [
      { runId: "run_inv", at: new Date().toISOString(), type: "holdout.accessed", capsuleId: "c" },
      ...fixtureEvents({ runId: "run_inv", baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false }),
    ]);
    expect(() => readEvents(runDir)).toThrow();
  });
});
