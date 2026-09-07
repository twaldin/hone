import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { EpisodeContext } from "../src/episode.js";
import {
  parseMaxEpisodes,
  runEpisodeLoop,
  SANDBOX_WORKER_PATH,
  WORKER_CHUNK_BYTES,
  WORKER_PART_DIR,
} from "../src/loop.js";
import { okStdout, StubBroker, stubHash } from "./stub-broker.js";

/**
 * Smoke-level acceptance for the seed loop: 3 scripted episodes against a
 * stub broker speaking the real wire protocol — one clean improvement, one
 * invalid candidate rescued by the single repair episode, and one ε-restart
 * from the baseline. Every emitted event is schema-validated by the emit
 * callback (the same contract WP4's event log enforces).
 */

const BASELINE = stubHash(9999);

/** Deterministic binary fixture standing in for a sealed worker bundle. */
function fixtureBundle(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function writeWorkerFixture(bytes: Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), "hone-worker-fixture-")), "worker.mjs");
  writeFileSync(path, bytes);
  return path;
}

/** Small shared fixture for tests that only need SOME sealed worker. */
const WORKER_BUNDLE = Buffer.from("// sealed hone worker bundle fixture\n", "utf8");
const WORKER_BUNDLE_PATH = writeWorkerFixture(WORKER_BUNDLE);

function collectEmit(events: RunEvent[]): (event: RunEvent) => RunEvent {
  return (event) => {
    const parsed = RunEvent.parse(event);
    events.push(parsed);
    return parsed;
  };
}

function eventsOf<T extends RunEvent["type"]>(events: RunEvent[], type: T): Extract<RunEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
}

describe("runEpisodeLoop", () => {
  it("drives improvement, one-repair, and ε-restart episodes; keeps-if-better; stops on budget", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: {
        1: { score: 0.6 }, // episode 0 candidate
        // 2: episode 1's failed workspace snapshot — must never be evaluated
        3: { a: 0.6, b: 0.7 }, // episode 1 repaired candidate, aggregate = mean = 0.65
        4: { score: 0.55 }, // episode 2 restart candidate: beats baseline, not the incumbent
      },
      execPlan: [
        { exitCode: 0, stdout: okStdout("memoize-neighbors") }, // ep0 mutation
        { exitCode: 1, stderr: "TypeError: boom in astar.js:42" }, // ep1 mutation fails
        { exitCode: 0, stdout: okStdout("fix-boom") }, // ep1 repair
        { exitCode: 0, stdout: okStdout("tune-heap") }, // ep2 mutation (restart)
      ],
      // 6 evaluator invocations = exactly 3 episodes (parent+child each): the loop
      // must observe exhaustion at the top of episode 3 and stop.
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 6 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        seed: 0,
        // ε-draw seam: greedy on episodes 0-1, restart on episode 2.
        rand: (episode) => (episode === 2 ? 0.0 : 0.99),
      });
    } finally {
      await stub.close();
    }

    const c0 = stubHash(1);
    const c1a = stubHash(2);
    const c1b = stubHash(3);
    const c2 = stubHash(4);

    // Parent selection: incumbent-greedy, then the episode-2 restart goes back to baseline.
    const started = eventsOf(events, "episode.started");
    expect(started.map((e) => e.parent.hash)).toEqual([BASELINE, c0, BASELINE]);

    // The failed workspace snapshot seeds the repair sandbox but is never evaluated.
    expect(stub.evaluated).not.toContain(c1a);

    // One invalid episode, rescued by its single repair.
    const invalid = eventsOf(events, "episode.invalid");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ episode: 1, repaired: true });
    expect(invalid[0]?.reason).toContain("exit 1");

    // Paired gate per episode, aggregate = mean of objectives.
    const gates = eventsOf(events, "gate.paired");
    expect(gates.map((e) => [e.episode, e.parentScore, e.childScore, e.passed])).toEqual([
      [0, 0.5, 0.6, true],
      [1, 0.6, expect.closeTo(0.65, 10), true],
      [2, 0.5, 0.55, true],
    ]);

    // Keep-if-better: episode 2 passes its paired gate against the baseline but
    // does NOT displace the stronger incumbent.
    const incumbents = eventsOf(events, "incumbent.new");
    expect(incumbents.map((e) => [e.artifact.hash, e.aggregate, e.episode])).toEqual([
      [c0, 0.6, 0],
      [c1b, expect.closeTo(0.65, 10), 1],
    ]);
    expect(incumbents.map((e) => e.deltaVsBaseline)).toEqual([expect.closeTo(0.1, 10), expect.closeTo(0.15, 10)]);
    expect(stub.reportedIncumbents).toEqual([c0, c1b]);

    // Budget exhaustion ends the run; the best artifact is handed to finish().
    const exhausted = eventsOf(events, "budget.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.dimension).toBe("evaluatorInvocations");
    expect(stub.finished).toEqual([c1b]);

    // Candidate events carry a session trace reference per attempt (3 valid attempts).
    expect(eventsOf(events, "episode.candidate")).toHaveLength(3);

    // Every mutation session execs the SANDBOX-LOCAL sealed worker with a deadline.
    for (const argv of stub.execArgvs) {
      expect(argv.slice(0, 1)).toEqual(["env"]);
      expect(argv[1]).toMatch(/^HONE_DEADLINE_MS=\d+$/);
      expect(argv.slice(2)).toEqual(["bun", SANDBOX_WORKER_PATH]);
    }

    // Every episode file put into a sandbox is a valid EpisodeContext; the repair
    // context carries the failure evidence (stderr tail) into the prompt.
    const contexts = stub.putFiles.map((p) => EpisodeContext.parse(JSON.parse(p.content)));
    expect(stub.putFiles.every((p) => p.path === "/scratch/episode.json")).toBe(true);
    expect(contexts.map((c) => c.mode)).toEqual(["mutation", "mutation", "repair", "mutation"]);
    const repair = contexts[2];
    expect(repair?.userPrompt).toContain("TypeError: boom in astar.js:42");
    expect(repair?.userPrompt).toContain("exit 1");
  });

  it("discards an eval-invalid candidate whose repair also fails, without minting an incumbent", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: {}, // nothing valid is ever produced
      invalidSaveIndices: [1, 2],
      execPlan: [
        { exitCode: 0, stdout: okStdout("bad-idea") }, // candidate evaluates invalid
        { exitCode: 0, stdout: okStdout("bad-repair") }, // repair also evaluates invalid
      ],
      // parent + candidate + repair-candidate = 3 invocations, then exhausted.
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 3 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        rand: () => 0.99,
      });
    } finally {
      await stub.close();
    }

    const invalid = eventsOf(events, "episode.invalid");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ episode: 0, repaired: false });
    expect(invalid[0]?.reason).toContain("invalid");
    expect(eventsOf(events, "gate.paired")).toHaveLength(0);
    expect(eventsOf(events, "incumbent.new")).toHaveLength(0);
    expect(stub.reportedIncumbents).toEqual([]);
    // With no incumbent, finish falls back to the baseline.
    expect(stub.finished).toEqual([BASELINE]);
  });

  it("one-shot mode consumes an eval-invalid candidate without launching a repair", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: {},
      invalidSaveIndices: [1],
      execPlan: [{ exitCode: 0, stdout: okStdout("bad-idea") }],
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 2 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-one-shot-invalid",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        rand: () => 0.99,
        maxEpisodes: 1,
        oneShotCandidate: true,
      });
    } finally {
      await stub.close();
    }

    expect(stub.putFiles).toHaveLength(1);
    expect(stub.evaluated).toEqual([BASELINE, stubHash(1)]);
    expect(eventsOf(events, "episode.invalid")).toEqual([
      expect.objectContaining({ episode: 0, repaired: false, reason: "evaluator rejected the candidate as invalid" }),
    ]);
    expect(eventsOf(events, "incumbent.new")).toHaveLength(0);
    expect(stub.finished).toEqual([BASELINE]);
  });

  it("winds down at the episode boundary when the abort signal fires", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: { 1: { score: 0.6 } },
      execPlan: [{ exitCode: 0, stdout: okStdout("only-episode") }],
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 100 },
    });
    await stub.listen();

    const controller = new AbortController();
    const events: RunEvent[] = [];
    const emit = collectEmit(events);
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: (event) => {
          // Stop after the first full episode has been logged.
          const parsed = emit(event);
          if (event.type === "budget.snapshot") controller.abort();
          return parsed;
        },
        signal: controller.signal,
        rand: () => 0.99,
      });
    } finally {
      await stub.close();
    }

    expect(eventsOf(events, "episode.started")).toHaveLength(1);
    // Aborted runs don't call finish — the supervisor owns shutdown bookkeeping.
    expect(stub.finished).toEqual([]);
  });
});

describe("runEpisodeLoop paired comparator evidence", () => {
  it("grandchild episode asks the broker for the baseline on the candidate's exact coordinate before reporting", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: {
        1: { score: 0.6 }, // episode 0 candidate → incumbent
        2: { score: 0.7 }, // episode 1 grandchild, mutated from the incumbent
      },
      execPlan: [
        { exitCode: 0, stdout: okStdout("first-improvement") },
        { exitCode: 0, stdout: okStdout("grandchild-improvement") },
      ],
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 100 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        rand: () => 0.99, // always greedy
        maxEpisodes: 2,
      });
    } finally {
      await stub.close();
    }

    const c0 = stubHash(1);
    const c1 = stubHash(2);
    // Episode 0: baseline parent doubles as the baseline pair — no extra ask.
    // Episode 1: incumbent parent + grandchild, then the paired baseline ask
    // completes the evidence set on (assetGroup, seed=1) BEFORE reportIncumbent.
    expect(stub.evaluateAsks).toEqual([
      `${BASELINE}@0`,
      `${c0}@0`,
      `${c0}@1`,
      `${c1}@1`,
      `${BASELINE}@1`,
    ]);
    expect(stub.reportedIncumbents).toEqual([c0, c1]);
    const incumbents = eventsOf(events, "incumbent.new");
    expect(incumbents.map((e) => [e.artifact.hash, e.episode])).toEqual([
      [c0, 0],
      [c1, 1],
    ]);
    // deltaVsBaseline is computed from the same-coordinate baseline measurement.
    expect(incumbents[1]?.deltaVsBaseline).toBeCloseTo(0.2, 10);
    expect(stub.finished).toEqual([c1]);
  });

  it("ε-restart challenger is paired against the current incumbent on its own seed; a worse challenger is never reported", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: {
        1: { score: 0.6 }, // episode 0 candidate → incumbent (measured 0.6 at seed 0)
        2: { score: 0.65 }, // episode 1 restart challenger at seed 1
      },
      // On the challenger's coordinate the incumbent scores 0.7: the challenger
      // beats the incumbent's stale seed-0 mean (0.6) but loses the paired
      // comparison — cumulative unpaired means must never decide.
      objectivesBySaveIndexAndSeed: { "1:1": { score: 0.7 } },
      execPlan: [
        { exitCode: 0, stdout: okStdout("first-improvement") },
        { exitCode: 0, stdout: okStdout("restart-challenger") },
      ],
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 100 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        rand: (episode) => (episode === 1 ? 0.0 : 0.99), // restart on episode 1
        maxEpisodes: 2,
      });
    } finally {
      await stub.close();
    }

    const c0 = stubHash(1);
    const c1 = stubHash(2);
    // Episode 1 restarts from the baseline (parent doubles as baseline pair);
    // after the challenger beats its parent, the loop asks the broker for the
    // CURRENT incumbent on the challenger's exact coordinate.
    expect(stub.evaluateAsks).toEqual([
      `${BASELINE}@0`,
      `${c0}@0`,
      `${BASELINE}@1`,
      `${c1}@1`,
      `${c0}@1`,
    ]);
    // gate.paired passes vs the baseline parent...
    const gates = eventsOf(events, "gate.paired");
    expect(gates.map((e) => [e.episode, e.passed])).toEqual([
      [0, true],
      [1, true],
    ]);
    // ...but the paired incumbent comparison rejects the challenger: never
    // reported, never selected.
    expect(eventsOf(events, "incumbent.new").map((e) => e.artifact.hash)).toEqual([c0]);
    expect(stub.reportedIncumbents).toEqual([c0]);
    expect(stub.finished).toEqual([c0]);
  });
});

describe("runEpisodeLoop maxEpisodes cap", () => {
  it("runs exactly one episode on the successful path when maxEpisodes=1", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: { 1: { score: 0.6 } },
      execPlan: [{ exitCode: 0, stdout: okStdout("probe-improvement") }],
      // Budget could fund many more episodes — only the cap may stop the loop.
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 100 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        rand: () => 0.99,
        maxEpisodes: 1,
      });
    } finally {
      await stub.close();
    }

    expect(eventsOf(events, "episode.started")).toHaveLength(1);
    expect(eventsOf(events, "budget.exhausted")).toHaveLength(0);
    expect(eventsOf(events, "incumbent.new")).toHaveLength(1);
    // The capped run still hands its best artifact to finish().
    expect(stub.finished).toEqual([stubHash(1)]);
  });

  it("counts a repaired episode as one episode against the cap", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      // save 1 = failed workspace snapshot (never evaluated), save 2 = repaired candidate.
      objectivesBySaveIndex: { 2: { score: 0.7 } },
      execPlan: [
        { exitCode: 1, stderr: "TypeError: boom" }, // ep0 mutation fails
        { exitCode: 0, stdout: okStdout("fix-boom") }, // ep0 repair succeeds
      ],
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 100 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        rand: () => 0.99,
        maxEpisodes: 1,
      });
    } finally {
      await stub.close();
    }

    expect(eventsOf(events, "episode.started")).toHaveLength(1);
    expect(eventsOf(events, "episode.invalid")).toEqual([expect.objectContaining({ episode: 0, repaired: true })]);
    expect(eventsOf(events, "budget.exhausted")).toHaveLength(0);
    expect(stub.finished).toEqual([stubHash(2)]);
  });

  it("holds the cap across an invalid episode's discard continue", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: {}, // nothing valid is ever produced
      invalidSaveIndices: [1, 2],
      execPlan: [
        { exitCode: 0, stdout: okStdout("bad-idea") }, // candidate evaluates invalid
        { exitCode: 0, stdout: okStdout("bad-repair") }, // repair also evaluates invalid
      ],
      // Ample budget: without the cap the loop would demand a third exec and
      // the stub would fail the test with an unscripted-exec error.
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 100 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        rand: () => 0.99,
        maxEpisodes: 1,
      });
    } finally {
      await stub.close();
    }

    expect(eventsOf(events, "episode.started")).toHaveLength(1);
    expect(eventsOf(events, "episode.invalid")).toEqual([expect.objectContaining({ episode: 0, repaired: false })]);
    expect(eventsOf(events, "budget.exhausted")).toHaveLength(0);
    expect(eventsOf(events, "incumbent.new")).toHaveLength(0);
    expect(stub.finished).toEqual([BASELINE]);
  });

  it("grants the full allowance from the resume ordinal: nextEpisode=1 + cap=1 runs exactly episode 1", async () => {
    const stub = new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: { 1: { score: 0.6 } },
      // Exactly one episode's mutation is scripted; a second would be an
      // unscripted-call test failure.
      execPlan: [{ exitCode: 0, stdout: okStdout("resumed-probe") }],
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 100 },
    });
    await stub.listen();

    const events: RunEvent[] = [];
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: WORKER_BUNDLE_PATH,
        emit: collectEmit(events),
        rand: () => 0.99,
        // Crash-after-start replay: the probe episode was journaled as started
        // but never completed — the relaunch MUST still attempt one episode.
        resume: { nextEpisode: 1, incumbent: null },
        maxEpisodes: 1,
      });
    } finally {
      await stub.close();
    }

    const started = eventsOf(events, "episode.started");
    expect(started.map((e) => e.episode)).toEqual([1]);
    expect(eventsOf(events, "budget.exhausted")).toHaveLength(0);
    expect(stub.finished).toEqual([stubHash(1)]);
  });

  it("fails closed on a non-positive or non-integer maxEpisodes before touching the broker", async () => {
    const base = {
      brokerSocket: "/nonexistent/broker.sock",
      runId: "run-test",
      emit: collectEmit([]),
    };
    await expect(runEpisodeLoop({ ...base, maxEpisodes: 0 })).rejects.toThrow(/maxEpisodes/);
    await expect(runEpisodeLoop({ ...base, maxEpisodes: -1 })).rejects.toThrow(/maxEpisodes/);
    await expect(runEpisodeLoop({ ...base, maxEpisodes: 1.5 })).rejects.toThrow(/maxEpisodes/);
    await expect(runEpisodeLoop({ ...base, maxEpisodes: Number.NaN })).rejects.toThrow(/maxEpisodes/);
  });
});

describe("parseMaxEpisodes", () => {
  it("treats unset as unbounded", () => {
    expect(parseMaxEpisodes(undefined)).toBeUndefined();
  });

  it("parses a positive integer", () => {
    expect(parseMaxEpisodes("1")).toBe(1);
    expect(parseMaxEpisodes("25")).toBe(25);
  });

  it("fails closed on zero, negatives, fractions, garbage, and empty strings", () => {
    for (const raw of ["0", "-3", "1.5", "abc", "", "  ", "Infinity", "1e999"]) {
      expect(() => parseMaxEpisodes(raw)).toThrow(/HONE_MAX_EPISODES/);
    }
  });
});

describe("runEpisodeLoop sealed worker transfer", () => {
  /** Two full chunks + a binary tail: exercises chunking, ordering, and byte exactness. */
  const BIG_BUNDLE = fixtureBundle(WORKER_CHUNK_BYTES * 2 + 1234);

  function transferScript(): StubBroker {
    return new StubBroker({
      baselineHash: BASELINE,
      baselineObjectives: { score: 0.5 },
      objectivesBySaveIndex: { 1: { score: 0.6 }, 2: { score: 0.7 } },
      execPlan: [
        { exitCode: 0, stdout: okStdout("first") },
        { exitCode: 0, stdout: okStdout("second") },
      ],
      envelope: { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 100_000, maxEvaluatorInvocations: 100 },
    });
  }

  async function runEpisodes(stub: StubBroker, maxEpisodes: number): Promise<void> {
    try {
      await runEpisodeLoop({
        brokerSocket: stub.socketPath,
        runId: "run-test",
        workerBundlePath: writeWorkerFixture(BIG_BUNDLE),
        emit: (event) => RunEvent.parse(event),
        rand: () => 0.99,
        maxEpisodes,
      });
    } finally {
      await stub.close();
    }
  }

  it("putFiles the exact sealed bytes in frame-sized chunks, assembles, and execs the sandbox-local file", async () => {
    const stub = transferScript();
    await stub.listen();
    await runEpisodes(stub, 1);

    // Chunking: every part under the frame-safe cap, in order, and the
    // concatenation is byte-identical to the sealed bundle.
    expect(stub.workerParts.length).toBe(3);
    expect(stub.workerParts.every((p) => p.bytes.length <= WORKER_CHUNK_BYTES)).toBe(true);
    expect(stub.workerParts.map((p) => p.path)).toEqual([...stub.workerParts.map((p) => p.path)].sort());
    expect(Buffer.concat(stub.workerParts.map((p) => p.bytes)).equals(BIG_BUNDLE)).toBe(true);

    // One assembly, exact bytes, before the episode context and the session exec.
    expect(stub.workerTransfers.length).toBe(1);
    expect(stub.workerTransfers[0]?.bytes.equals(BIG_BUNDLE)).toBe(true);
    expect(stub.scratch.get(SANDBOX_WORKER_PATH)?.equals(BIG_BUNDLE)).toBe(true);

    const sb = stub.workerTransfers[0]?.sandboxId ?? "";
    const assembleAt = stub.ops.findIndex((op) => op.startsWith(`exec:${sb}:sh -c cat ${WORKER_PART_DIR}/`));
    const lastPartAt = stub.ops.lastIndexOf(`putFile:${sb}:${stub.workerParts[2]?.path ?? ""}`);
    const episodeJsonAt = stub.ops.indexOf(`putFile:${sb}:/scratch/episode.json`);
    const sessionAt = stub.ops.findIndex((op) => op.startsWith(`exec:${sb}:env HONE_DEADLINE_MS=`));
    expect(lastPartAt).toBeGreaterThan(-1);
    expect(assembleAt).toBeGreaterThan(lastPartAt);
    expect(episodeJsonAt).toBeGreaterThan(assembleAt);
    expect(sessionAt).toBeGreaterThan(episodeJsonAt);
    // The session runs the sandbox-local sealed file — no image-baked path.
    expect(stub.execArgvs).toEqual([["env", expect.stringMatching(/^HONE_DEADLINE_MS=\d+$/), "bun", SANDBOX_WORKER_PATH]]);
    expect(stub.ops.join("\n")).not.toContain("/opt/hone-worker");
  });

  it("skips re-transfer for a later sandbox only after the shared /scratch copy hash-verifies", async () => {
    const stub = transferScript();
    await stub.listen();
    await runEpisodes(stub, 2);

    // Two sandboxes, one transfer: the second probe verified the shared copy.
    expect(stub.workerTransfers.length).toBe(1);
    const probes = stub.ops.filter((op) => op.endsWith(`:sha256sum ${SANDBOX_WORKER_PATH}`));
    expect(probes.length).toBe(2);
    expect(stub.scratch.get(SANDBOX_WORKER_PATH)?.equals(BIG_BUNDLE)).toBe(true);
  });

  it("re-ships the sealed bytes when the sandbox-local copy does not match the sealed hash", async () => {
    const stub = transferScript();
    // A previous session (or a hostile mutation) left different bytes behind.
    stub.scratch.set(SANDBOX_WORKER_PATH, Buffer.from("tampered worker", "utf8"));
    await stub.listen();
    await runEpisodes(stub, 1);

    expect(stub.workerTransfers.length).toBe(1);
    expect(stub.workerTransfers[0]?.bytes.equals(BIG_BUNDLE)).toBe(true);
    expect(stub.scratch.get(SANDBOX_WORKER_PATH)?.equals(BIG_BUNDLE)).toBe(true);
  });

  it("fails the episode loop closed when the sealed worker bundle is unreadable", async () => {
    await expect(
      runEpisodeLoop({
        brokerSocket: "/nonexistent/broker.sock",
        runId: "run-test",
        workerBundlePath: "/nonexistent/worker.mjs",
        emit: (event) => RunEvent.parse(event),
      }),
    ).rejects.toThrow(/worker\.mjs/);
  });

  it("creates the episode sandbox BEFORE the parent evaluation so both evals share the pairing epoch", async () => {
    const stub = transferScript();
    await stub.listen();
    await runEpisodes(stub, 2);

    for (const episode of [0, 1]) {
      const sandboxId = `sb_${String(episode + 1).padStart(12, "0")}`;
      const createAt = stub.ops.indexOf(`createSandbox:${sandboxId}`);
      const parentEvalAt = stub.ops.findIndex((op) => op.startsWith("evaluate:") && op.endsWith(`@${episode}`));
      expect(createAt).toBeGreaterThan(-1);
      expect(parentEvalAt).toBeGreaterThan(createAt);
      // ...and the episode's session exec follows the parent evaluation in the same epoch.
      const sessionAt = stub.ops.findIndex((op) => op.startsWith(`exec:${sandboxId}:env HONE_DEADLINE_MS=`));
      expect(sessionAt).toBeGreaterThan(parentEvalAt);
    }
  });

  it("never places worker bytes under /workspace — the saved candidate artifact cannot contain the bundle", async () => {
    const stub = transferScript();
    await stub.listen();
    await runEpisodes(stub, 2);

    // saveArtifact archives /workspace ONLY; every loop-written path (worker
    // chunks, assembled bundle, episode context) lives under /scratch.
    expect(SANDBOX_WORKER_PATH.startsWith("/scratch/")).toBe(true);
    expect(WORKER_PART_DIR.startsWith("/scratch/")).toBe(true);
    const written = [...stub.workerParts.map((p) => p.path), ...stub.putFiles.map((p) => p.path)];
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((p) => p.startsWith("/scratch/"))).toBe(true);
    expect(written.some((p) => p.startsWith("/workspace"))).toBe(false);
    // No exec touches a /workspace-resident worker either — only the /scratch path.
    for (const op of stub.ops.filter((o) => o.includes("hone-worker"))) {
      expect(op).not.toContain("/workspace");
    }
    // No stage residue: assembly atomically installed the bundle and removed
    // the chunk dir, so shared /scratch holds ONLY the installed worker (plus
    // the episode context) — nothing for later snapshots to drag along.
    const residue = [...stub.scratch.keys()].filter((p) => p.startsWith(`${WORKER_PART_DIR}/`));
    expect(residue).toEqual([]);
    expect([...stub.scratch.keys()].sort()).toEqual(["/scratch/episode.json", SANDBOX_WORKER_PATH]);
  });
});
