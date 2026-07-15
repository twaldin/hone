import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, RunConfig, RunEvent, capsuleDigest } from "@hone/schema";
import type { BudgetState } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { createBackend, deriveProbeReport } from "../src/backends/local.js";
import { appendEvent, readEvents, replayRun } from "../src/eventlog.js";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import type { ProbeReport, RunnerBackendContext } from "../src/types.js";
import {
  CAP_ID,
  FIX_IMAGE,
  at,
  fakeHash,
  fakeOptimizerSpawn,
  gitIn,
  initScratchRepo,
  makeCapsule,
  makeIo,
  makeRoot,
  readLogLines,
  writeEvents,
} from "./helpers.js";

/**
 * VI.4 probe gate: the first optimizer invocation is bounded to one episode,
 * the paired report is derived from BROKER events, probe.completed seals the
 * verdict, decline requests a trusted stop, and an approved probe never
 * re-runs on resume.
 */

const BUDGET: BudgetState = {
  envelope: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
  spent: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
};

function episodeEvents(runId: string, episode: number, parentHash: string, candidateHash: string): RunEvent[] {
  const base = { runId };
  return [
    { ...base, at: at(), type: "episode.started", episode, parent: { hash: parentHash } },
    { ...base, at: at(), type: "episode.candidate", episode, candidate: { hash: candidateHash }, sessionTrace: fakeHash("e") },
    { ...base, at: at(), type: "eval.completed", episode, artifact: { hash: candidateHash }, assetGroupId: "validation", seed: 3, aggregate: 0.62, cached: false },
    { ...base, at: at(), type: "gate.paired", episode, parentScore: 0.5, childScore: 0.62, passed: true },
  ];
}

describe("deriveProbeReport (trusted paired measurement from broker events)", () => {
  it("pairs the newest measured episode: baseline from parent eval or gate, candidate with delta", () => {
    const events = episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c"));
    const report = deriveProbeReport(events, BUDGET);
    expect(report.baseline).toEqual({ artifact: { hash: fakeHash("b") }, aggregate: 0.5 });
    expect(report.candidate).toEqual({ artifact: { hash: fakeHash("c") }, aggregate: 0.62, delta: expect.closeTo(0.12) });
    expect(report.assetGroupId).toBe("validation");
    expect(report.seed).toBe(3);
    expect(report.budget).toEqual(BUDGET);
  });

  it("prefers a direct baseline eval over the gate score", () => {
    const events: RunEvent[] = [
      ...episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")),
      { runId: "run_p", at: at(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("b") }, assetGroupId: "validation", seed: 3, aggregate: 0.48, cached: false },
    ];
    expect(deriveProbeReport(events, BUDGET).baseline.aggregate).toBe(0.48);
  });

  it("reports a null candidate when the probe episode produced none", () => {
    const events: RunEvent[] = [
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      { runId: "run_p", at: at(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("b") }, assetGroupId: "train", seed: 1, aggregate: 0.5, cached: false },
    ];
    const report = deriveProbeReport(events, BUDGET);
    expect(report.candidate).toBeNull();
    expect(report.baseline.aggregate).toBe(0.5);
  });

  it("fails closed when nothing was measured — an incomplete episode is never a probe", () => {
    expect(() => deriveProbeReport([], BUDGET)).toThrow(/no completed evaluation/);
    const unmeasured: RunEvent[] = [
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      { runId: "run_p", at: at(), type: "episode.candidate", episode: 0, candidate: { hash: fakeHash("c") }, sessionTrace: fakeHash("e") },
    ];
    expect(() => deriveProbeReport(unmeasured, BUDGET)).toThrow(/no completed evaluation/);
  });

  it("derives from the NEWEST measured episode (resume probes are not episode-0 bound)", () => {
    const events = [
      ...episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")),
      ...episodeEvents("run_p", 4, fakeHash("c"), fakeHash("d")),
    ];
    const report = deriveProbeReport(events, BUDGET);
    expect(report.baseline.artifact.hash).toBe(fakeHash("c"));
    expect(report.candidate?.artifact.hash).toBe(fakeHash("d"));
  });
});

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

/** An admission-grade capsule the REAL local backend accepts. */
function probeCapsule(root: string): { capsuleDir: string; manifest: CapsuleManifest; digest: string } {
  const baseline = join(root, "capsule", "baseline");
  initScratchRepo(baseline);
  const commit = gitIn(baseline, "rev-parse", "HEAD");
  const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit } });
  const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")));
  return { capsuleDir, manifest, digest: capsuleDigest(manifest) };
}

interface ProbeFlow {
  root: string;
  runDir: string;
  invocationsPath: string;
  probeReports: ProbeReport[];
  stops: number;
  events(): RunEvent[];
  invocations(): { maxEpisodes: string | null; resume: { nextEpisode: number } }[];
}

/**
 * Run the REAL local backend (stubbed docker, unix egress, scripted optimizer
 * that records each invocation's env and exits 0) over a pre-seeded event log.
 */
async function runProbeFlow(opts: { seed: RunEvent[]; verdict: boolean; abortOnGate?: boolean }): Promise<ProbeFlow> {
  const root = makeRoot();
  const runId = "run_probe";
  const runDir = writeEvents(root, runId, opts.seed);
  mkdirSync(join(root, ".hone-cas"), { recursive: true });
  const { capsuleDir, manifest, digest } = probeCapsule(root);

  const invocationsPath = join(root, "invocations.ndjson");
  const optimizerEntry = join(root, "opt.mjs");
  writeFileSync(
    optimizerEntry,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(invocationsPath)}, JSON.stringify({`,
      '  maxEpisodes: process.env.HONE_MAX_EPISODES ?? null,',
      '  resume: JSON.parse(process.env.HONE_RESUME),',
      '}) + "\\n");',
    ].join("\n"),
  );

  const flow: ProbeFlow = {
    root,
    runDir,
    invocationsPath,
    probeReports: [],
    stops: 0,
    events: () => readEvents(runDir),
    invocations: () =>
      existsSync(invocationsPath)
        ? readFileSync(invocationsPath, "utf8")
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l))
        : [],
  };

  const run: RunCommand = () => Promise.resolve(res());
  // In-container argv override + fake docker spawn: the backend believes it
  // launched the sealed container; lifecycle (env wiring, exit codes) is real.
  const backend = createBackend({ run, spawnOptimizer: fakeOptimizerSpawn(FIX_IMAGE) });
  const abort = new AbortController();
  const ctx: RunnerBackendContext = {
    runId,
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
    env: {
      PATH: process.env["PATH"] ?? "",
      HONE_EGRESS: "socket",
      HONE_OPTIMIZER_CMD: `${process.execPath} ${optimizerEntry}`,
    },
    capsuleDigest: digest,
    optimizerDigest: fakeHash("0"),
    replayed: replayRun(runDir),
    signal: abort.signal,
    emit: (event) => appendEvent(runDir, event),
    registerChild: () => () => {},
    probeGate: (report) => {
      flow.probeReports.push(report);
      // A stop landing WHILE the owner is being asked: the gate resolves
      // (promptProbe returns false on abort) but the backend must seal NO
      // durable verdict.
      if (opts.abortOnGate === true) abort.abort(new Error("stop requested"));
      return Promise.resolve(opts.verdict);
    },
    requestStop: () => {
      flow.stops++;
    },
    registerAuthorityBarrier: () => {},
    registerCleanupBarrier: () => {},
  };

  await backend.start(ctx);
  return flow;
}

function seededLog(runId: string): RunEvent[] {
  return [
    { runId, at: at(), type: "run.started", capsuleId: CAP_ID, contractHash: fakeHash("c"), optimizerDigest: fakeHash("0") },
    ...episodeEvents(runId, 0, fakeHash("b"), fakeHash("c")),
  ];
}

describe("probe gate flow (real local backend, scripted optimizer)", () => {
  it("resume with an unsealed completed pair re-gates it without buying another probe episode", { timeout: 30_000 }, async () => {
    const flow = await runProbeFlow({ seed: seededLog("run_probe"), verdict: true });

    // The completed broker-authored pair is sufficient evidence: only the
    // post-approval full invocation launches, from the existing cursor.
    const invocations = flow.invocations();
    expect(invocations.length).toBe(1);
    expect(invocations[0]?.maxEpisodes).toBeNull();
    expect(invocations[0]?.resume.nextEpisode).toBe(1);

    // The gate saw the TRUSTED paired measurement from the broker events.
    expect(flow.probeReports.length).toBe(1);
    expect(flow.probeReports[0]?.baseline.aggregate).toBe(0.5);
    expect(flow.probeReports[0]?.candidate?.aggregate).toBe(0.62);
    expect(flow.probeReports[0]?.budget.envelope.maxUsd).toBe(25);

    // Exactly one schema-valid probe.completed sealed the verdict.
    const probes = flow.events().flatMap((e) => (e.type === "probe.completed" ? [e] : []));
    expect(probes.length).toBe(1);
    expect(probes[0]?.approved).toBe(true);
    expect(probes[0]?.baseline.aggregate).toBe(0.5);
    expect(probes[0]?.candidate?.delta).toBeCloseTo(0.12);
    expect(flow.stops).toBe(0);
  });

  it("decline: probe.completed approved=false is sealed, a trusted stop is requested, no full launch", { timeout: 30_000 }, async () => {
    const flow = await runProbeFlow({ seed: seededLog("run_probe"), verdict: false });
    expect(flow.invocations().length).toBe(0); // recovered evidence is gated before any launch
    const probes = flow.events().flatMap((e) => (e.type === "probe.completed" ? [e] : []));
    expect(probes.length).toBe(1);
    expect(probes[0]?.approved).toBe(false);
    expect(flow.stops).toBe(1);
  });

  it("resume with an approved probe never re-runs the gate or duplicates probe.completed", { timeout: 30_000 }, async () => {
    const approved: RunEvent = {
      runId: "run_probe",
      at: at(),
      type: "probe.completed",
      approved: true,
      baseline: { artifact: { hash: fakeHash("b") }, aggregate: 0.5 },
      candidate: { artifact: { hash: fakeHash("c") }, aggregate: 0.62, delta: 0.12 },
      assetGroupId: "validation",
      seed: 3,
      budget: BUDGET,
    };
    const flow = await runProbeFlow({ seed: [...seededLog("run_probe"), approved], verdict: false });
    // One UNBOUNDED invocation straight to the full run; the gate never ran.
    const invocations = flow.invocations();
    expect(invocations.length).toBe(1);
    expect(invocations[0]?.maxEpisodes).toBeNull();
    expect(flow.probeReports.length).toBe(0);
    expect(flow.events().filter((e) => e.type === "probe.completed").length).toBe(1);
    expect(flow.stops).toBe(0);
  });

  it("resume onto a durable decline honors it: trusted stop, optimizer never launches", { timeout: 30_000 }, async () => {
    const declined: RunEvent = {
      runId: "run_probe",
      at: at(),
      type: "probe.completed",
      approved: false,
      baseline: { artifact: { hash: fakeHash("b") }, aggregate: 0.5 },
      candidate: null,
      assetGroupId: "validation",
      seed: 3,
      budget: BUDGET,
    };
    const flow = await runProbeFlow({ seed: [...seededLog("run_probe"), declined], verdict: true });
    expect(flow.invocations().length).toBe(0);
    expect(flow.probeReports.length).toBe(0);
    expect(flow.stops).toBe(1);
  });

  it("an abort DURING the gate seals no durable verdict — the run stays resumable and re-gates", { timeout: 30_000 }, async () => {
    const flow = await runProbeFlow({ seed: seededLog("run_probe"), verdict: false, abortOnGate: true });
    // The recovered pair was gated without another optimizer invocation.
    expect(flow.invocations().length).toBe(0);
    expect(flow.probeReports.length).toBe(1);
    // …but the abort raced the answer: NO probe.completed was appended (a
    // durable false would wrongly stop every future resume), no stop was
    // requested by the gate path, and no full launch happened.
    expect(flow.events().filter((e) => e.type === "probe.completed").length).toBe(0);
    expect(flow.stops).toBe(0);
  });
});

describe("probe decline terminalizes stopped (supervisor requestStop wiring)", () => {
  it("a backend requesting a trusted stop yields run.finished status=stopped", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "declining-backend.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            // Mirrors the probe-decline path: request a trusted stop, then wind down.
            ctx.requestStop();
            if (!ctx.signal.aborted) {
              await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }));
            }
          },
        };
      }
      `,
    );
    const { io } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "50" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./declining-backend.mjs"], io);
    expect(code).toBe(0); // stopped is not a failure
    const runId = soleRun(root);
    const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("stopped");
  });
});

function soleRun(root: string): string {
  const dirs = readdirSync(join(root, ".hone-runs"));
  expect(dirs.length).toBe(1);
  return dirs[0] ?? "";
}

describe("sequential optimizer children (probe adds a second child)", () => {
  it("a clean-exit child is unregistered and its residual group killed; a later stop never signals it", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const killsPath = join(root, "kills.ndjson");
    writeFileSync(
      join(root, "two-children-backend.mjs"),
      `import { appendFileSync } from "node:fs";
      export function createBackend() {
        return {
          async start(ctx) {
            const record = (line) => appendFileSync(${JSON.stringify(killsPath)}, line + "\\n");
            // First child: positively reaped (probe invocation finished code 0).
            const first = { pid: undefined, kill: (sig) => { record("first:" + (sig ?? "SIGTERM")); return true; } };
            const unregister = ctx.registerChild(first);
            // Backend-side positive reap: residual group kill, then unregister.
            first.kill("SIGKILL");
            unregister();
            record("reaped");
            // Second child: still live when the stop lands.
            const second = { pid: undefined, kill: (sig) => { record("second:" + (sig ?? "SIGTERM")); return true; } };
            ctx.registerChild(second);
            ctx.requestStop();
            if (!ctx.signal.aborted) {
              await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }));
            }
          },
        };
      }
      `,
    );
    const { io } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "50" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./two-children-backend.mjs"], io);
    expect(code).toBe(0);

    const lines = readFileSync(killsPath, "utf8").split("\n").filter((l) => l !== "");
    const reapedAt = lines.indexOf("reaped");
    expect(reapedAt).toBeGreaterThanOrEqual(1);
    // The supervisor's stop barrier signalled ONLY the still-registered child:
    // after "reaped", no signal ever reaches the first (recycled) handle again.
    const afterReap = lines.slice(reapedAt + 1);
    expect(afterReap.some((l) => l.startsWith("second:SIGTERM"))).toBe(true);
    expect(afterReap.some((l) => l.startsWith("first:"))).toBe(false);
  });
});
