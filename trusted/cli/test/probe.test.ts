import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CapsuleManifest, EvaluationRecord, PROMOTION_GATE_VERSION, RunConfig, RunEvent, capsuleDigest } from "@hone/schema";
import type { BudgetState, NoiseCalibrationRunConfig } from "@hone/schema";
import { readBrokerJournalEvaluations, type BrokerConfig, type CmdResult, type RunCommand } from "@hone/broker";
import type * as BrokerModule from "@hone/broker";
import { freezeCapsuleAssets } from "../src/admission.js";
import { createBackend, deriveProbeReport } from "../src/backends/local.js";
import { MUTATION_WORKER_PREFLIGHT_FILE } from "../src/backends/optimizer-container.js";
import { appendEvent, readEvents, replayRun } from "../src/eventlog.js";
import { sealedRunAuthority } from "../src/search.js";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import type { ProbeReport, RunnerBackendContext } from "../src/types.js";
import {
  CAP_ID,
  scriptedCreateHelper,
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

// Pass-through spy on the trusted broker constructor: the exact config the
// local backend hands startBroker is the authority under test.
const captured = vi.hoisted(() => ({ brokerConfigs: [] as BrokerConfig[] }));
vi.mock("@hone/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof BrokerModule>();
  return {
    ...actual,
    startBroker: (config: BrokerConfig, options: Parameters<typeof actual.startBroker>[1]) => {
      captured.brokerConfigs.push(config);
      return actual.startBroker(config, options);
    },
  };
});

/**
 * VI.4 probe gate under the M0 one-shot invariant: the run buys AT MOST one
 * candidate-producing optimizer episode, and the probe candidate IS the run
 * candidate. The paired report is derived from BROKER events, probe.completed
 * seals the verdict, decline requests a trusted stop, and approval proceeds
 * straight to finalization — it never launches a second (full) optimizer
 * invocation, and an approved probe never re-runs the gate on resume.
 */

const BUDGET: BudgetState = {
  envelope: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
  spent: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
};

/** A complete promoted probe episode: save, tagged eval, passed gate, and the matching incumbent.new the broker publishes on reportIncumbent. */
function episodeEvents(runId: string, episode: number, parentHash: string, candidateHash: string): RunEvent[] {
  const base = { runId };
  return [
    { ...base, at: at(), type: "episode.started", episode, parent: { hash: parentHash } },
    { ...base, at: at(), type: "episode.candidate", episode, candidate: { hash: candidateHash }, sessionTrace: fakeHash("e") },
    { ...base, at: at(), type: "eval.completed", episode, artifact: { hash: candidateHash }, assetGroupId: "validation", seed: 3, aggregate: 0.62, cached: false },
    { ...base, at: at(), type: "gate.paired", episode, parentScore: 0.5, childScore: 0.62, passed: true },
    { ...base, at: at(), type: "incumbent.new", artifact: { hash: candidateHash }, aggregate: 0.62, deltaVsBaseline: 0.12, episode },
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

  it("refuses to turn a null aggregate into probe authority", () => {
    const events: RunEvent[] = [
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      { runId: "run_p", at: at(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("b") }, assetGroupId: "train", seed: 1, aggregate: null, cached: false },
    ];

    expect(() => deriveProbeReport(events, BUDGET)).toThrow(/null aggregate/);
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

  it("derives an unchanged-workspace probe from the untagged memo-hit parent eval: candidate:null, not failure", () => {
    const parent = fakeHash("b");
    const events: RunEvent[] = [
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: parent } },
      // Memo-hit trusted measurement: NO episode tag on eval.completed.
      { runId: "run_p", at: at(), type: "eval.completed", artifact: { hash: parent }, assetGroupId: "validation", seed: 7, aggregate: 0.5, cached: true },
    ];
    const report = deriveProbeReport(events, BUDGET);
    expect(report.baseline).toEqual({ artifact: { hash: parent }, aggregate: 0.5 });
    expect(report.candidate).toBeNull();
    expect(report.assetGroupId).toBe("validation");
    expect(report.seed).toBe(7);
  });

  it("memo-hit fallback trusts ONLY the parent's untagged eval inside the newest episode window", () => {
    const parent = fakeHash("b");
    // Untagged eval BEFORE the window (startup state, not this episode's measurement):
    const beforeWindow: RunEvent[] = [
      { runId: "run_p", at: at(), type: "eval.completed", artifact: { hash: parent }, assetGroupId: "validation", seed: 7, aggregate: 0.5, cached: true },
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: parent } },
    ];
    expect(() => deriveProbeReport(beforeWindow, BUDGET)).toThrow(/no completed evaluation/);
    // Untagged eval for a DIFFERENT artifact is never a baseline:
    const wrongArtifact: RunEvent[] = [
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: parent } },
      { runId: "run_p", at: at(), type: "eval.completed", artifact: { hash: fakeHash("c") }, assetGroupId: "validation", seed: 7, aggregate: 0.9, cached: true },
    ];
    expect(() => deriveProbeReport(wrongArtifact, BUDGET)).toThrow(/no completed evaluation/);
  });

  it("a NEWER started episode with only a memo-hit eval wins over an older tagged pair (resume window)", () => {
    const events: RunEvent[] = [
      ...episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")),
      { runId: "run_p", at: at(), type: "episode.started", episode: 1, parent: { hash: fakeHash("c") } },
      { runId: "run_p", at: at(), type: "eval.completed", artifact: { hash: fakeHash("c") }, assetGroupId: "validation", seed: 9, aggregate: 0.62, cached: true },
    ];
    const report = deriveProbeReport(events, BUDGET);
    expect(report.baseline.artifact.hash).toBe(fakeHash("c"));
    expect(report.baseline.aggregate).toBe(0.62);
    expect(report.candidate).toBeNull();
    expect(report.seed).toBe(9);
  });
  // Reviewer exploit (cap-respecting, maxCandidateArtifacts=2): a failed-exec
  // repair R is saved unevaluated; a distinct C is saved, trusted-evaluated,
  // gated, and promoted; then R is reopened, a byte-identical no-op leaves
  // bytes == R, and the re-save makes R the LAST episode.candidate without a
  // new artifact reservation. The candidate must be the eval/gate-bound C —
  // never the last save R with C's gate childScore transferred onto it.
  function exploitEvents(runId: string, R: string, C: string): RunEvent[] {
    const base = { runId };
    return [
      { ...base, at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      { ...base, at: at(), type: "episode.candidate", episode: 0, candidate: { hash: R }, sessionTrace: fakeHash("1") },
      { ...base, at: at(), type: "episode.candidate", episode: 0, candidate: { hash: C }, sessionTrace: fakeHash("2") },
      { ...base, at: at(), type: "eval.completed", episode: 0, artifact: { hash: C }, assetGroupId: "validation", seed: 3, aggregate: 0.62, cached: false },
      { ...base, at: at(), type: "gate.paired", episode: 0, parentScore: 0.5, childScore: 0.62, passed: true },
      { ...base, at: at(), type: "incumbent.new", artifact: { hash: C }, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 },
      // Reopened R, byte-identical no-op save: R becomes the LAST save.
      { ...base, at: at(), type: "episode.candidate", episode: 0, candidate: { hash: R }, sessionTrace: fakeHash("3") },
    ];
  }

  it("EXPLOIT: a re-saved unevaluated repair after the gated pair never becomes the candidate — the eval/gate-bound artifact does", () => {
    const R = fakeHash("a");
    const C = fakeHash("c");
    const report = deriveProbeReport(exploitEvents("run_p", R, C), BUDGET);
    // The prompt candidate IS the promoted incumbent the one-shot run will
    // finalize: exact hash, exact aggregate, delta vs the reported baseline.
    expect(report.candidate).toEqual({ artifact: { hash: C }, aggregate: 0.62, delta: expect.closeTo(0.12) });
    expect(report.candidate?.artifact.hash).not.toBe(R);
    expect(report.baseline).toEqual({ artifact: { hash: fakeHash("b") }, aggregate: 0.5 });
  });

  it("never transfers a gate score to another hash: a childScore matching no evaluated saved candidate fails closed", () => {
    const events: RunEvent[] = [
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      { runId: "run_p", at: at(), type: "episode.candidate", episode: 0, candidate: { hash: fakeHash("c") }, sessionTrace: fakeHash("e") },
      { runId: "run_p", at: at(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("c") }, assetGroupId: "validation", seed: 3, aggregate: 0.62, cached: false },
      { runId: "run_p", at: at(), type: "gate.paired", episode: 0, parentScore: 0.5, childScore: 0.7, passed: true },
    ];
    expect(() => deriveProbeReport(events, BUDGET)).toThrow(/binds 0 evaluated saved candidates/);
  });

  it("fails closed when the gate childScore binds MORE than one evaluated saved candidate (ambiguous)", () => {
    const shared = (hash: string): RunEvent[] => [
      { runId: "run_p", at: at(), type: "episode.candidate", episode: 0, candidate: { hash }, sessionTrace: `${fakeHash("e")}:${hash}` },
      { runId: "run_p", at: at(), type: "eval.completed", episode: 0, artifact: { hash }, assetGroupId: "validation", seed: 3, aggregate: 0.62, cached: false },
    ];
    const events: RunEvent[] = [
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      ...shared(fakeHash("c")),
      ...shared(fakeHash("d")),
      { runId: "run_p", at: at(), type: "gate.paired", episode: 0, parentScore: 0.5, childScore: 0.62, passed: true },
    ];
    expect(() => deriveProbeReport(events, BUDGET)).toThrow(/binds 2 evaluated saved candidates/);
  });

  it("fails closed when the episode's promoted incumbent is not the gate-bound candidate", () => {
    const unpromoted = episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")).filter((e) => e.type !== "incumbent.new");
    const wrongHash: RunEvent[] = [
      ...unpromoted,
      { runId: "run_p", at: at(), type: "incumbent.new", artifact: { hash: fakeHash("f") }, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 },
    ];
    expect(() => deriveProbeReport(wrongHash, BUDGET)).toThrow(/not the gate-bound candidate/);
    const wrongScore: RunEvent[] = [
      ...unpromoted,
      { runId: "run_p", at: at(), type: "incumbent.new", artifact: { hash: fakeHash("c") }, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 0 },
    ];
    expect(() => deriveProbeReport(wrongScore, BUDGET)).toThrow(/not the gate-bound candidate/);
  });

  it("EXPLOIT: a passed gate whose optimizer withheld reportIncumbent fails closed — zero incumbents is never approvable", () => {
    const withheld = episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")).filter((e) => e.type !== "incumbent.new");
    expect(() => deriveProbeReport(withheld, BUDGET)).toThrow(/recorded 0 promoted incumbents/);
  });

  it("fails closed on MORE than one promoted incumbent for a passed gate", () => {
    const doubled: RunEvent[] = [
      ...episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")),
      { runId: "run_p", at: at(), type: "incumbent.new", artifact: { hash: fakeHash("c") }, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 },
    ];
    expect(() => deriveProbeReport(doubled, BUDGET)).toThrow(/recorded 2 promoted incumbents/);
  });

  it("honest losing probe: a FAILED gate keeps the bound candidate visible with its negative delta and requires zero incumbents", () => {
    const base = { runId: "run_p" };
    const losing: RunEvent[] = [
      { ...base, at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      { ...base, at: at(), type: "episode.candidate", episode: 0, candidate: { hash: fakeHash("c") }, sessionTrace: fakeHash("e") },
      { ...base, at: at(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("c") }, assetGroupId: "validation", seed: 3, aggregate: 0.45, cached: false },
      { ...base, at: at(), type: "gate.paired", episode: 0, parentScore: 0.5, childScore: 0.45, passed: false },
    ];
    const report = deriveProbeReport(losing, BUDGET);
    expect(report.candidate).toEqual({ artifact: { hash: fakeHash("c") }, aggregate: 0.45, delta: expect.closeTo(-0.05) });
    expect(report.baseline.aggregate).toBe(0.5);
    // …and a promotion under a failed gate is a contradiction: fail closed.
    const contradiction: RunEvent[] = [
      ...losing,
      { runId: "run_p", at: at(), type: "incumbent.new", artifact: { hash: fakeHash("c") }, aggregate: 0.45, deltaVsBaseline: -0.05, episode: 0 },
    ];
    expect(() => deriveProbeReport(contradiction, BUDGET)).toThrow(/without a gate-passing bound candidate/);
  });

  it("fails closed on an evaluated saved candidate with NO paired gate (unbindable score)", () => {
    const events: RunEvent[] = [
      { runId: "run_p", at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      { runId: "run_p", at: at(), type: "episode.candidate", episode: 0, candidate: { hash: fakeHash("c") }, sessionTrace: fakeHash("e") },
      { runId: "run_p", at: at(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("c") }, assetGroupId: "validation", seed: 3, aggregate: 0.62, cached: false },
    ];
    expect(() => deriveProbeReport(events, BUDGET)).toThrow(/without a paired gate measurement/);
  });

  it("fails closed on multiple paired gates, conflicting evaluations of one hash, or a stray tagged eval", () => {
    const dupGate: RunEvent[] = [
      ...episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")),
      { runId: "run_p", at: at(), type: "gate.paired", episode: 0, parentScore: 0.5, childScore: 0.6, passed: true },
    ];
    expect(() => deriveProbeReport(dupGate, BUDGET)).toThrow(/2 paired gate measurements/);
    const conflictingEval: RunEvent[] = [
      ...episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")),
      { runId: "run_p", at: at(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("c") }, assetGroupId: "validation", seed: 3, aggregate: 0.6, cached: false },
    ];
    expect(() => deriveProbeReport(conflictingEval, BUDGET)).toThrow(/conflicting trusted evaluations/);
    const strayEval: RunEvent[] = [
      ...episodeEvents("run_p", 0, fakeHash("b"), fakeHash("c")),
      { runId: "run_p", at: at(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("f") }, assetGroupId: "validation", seed: 3, aggregate: 0.9, cached: false },
    ];
    expect(() => deriveProbeReport(strayEval, BUDGET)).toThrow(/neither the parent nor a saved candidate/);
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
  capsule: { capsuleDir: string; manifest: CapsuleManifest; digest: string };
  probeReports: ProbeReport[];
  stops: number;
  toolbeltPreflights: Array<{ image: string; optimizerStarted: boolean }>;
  /** The operator cpuset the prepared optimizer runtime carried into each toolbelt preflight. */
  toolbeltCpusets: Array<string | undefined>;
  startError: Error | null;
  /** Exact trusted configs this flow handed to startBroker. */
  brokerConfigs: BrokerConfig[];
  /** Evaluator container executions (`docker start -a` of an eval container). */
  evaluatorRuns: number;
  events(): RunEvent[];
  invocations(): {
    maxEpisodes: string | null;
    oneShot: string | null;
    resume: { nextEpisode: number; incumbent: { artifact: { hash: string } } | null };
  }[];
}

/**
 * Run the REAL local backend (stubbed docker, unix egress, scripted optimizer
 * that records each invocation's env and exits 0) over a pre-seeded event log.
 * `reuse` re-enters an earlier flow's run dir, as a resume after process death.
 */
async function runProbeFlow(opts: {
  seed: RunEvent[];
  verdict: boolean;
  abortOnGate?: boolean;
  m1?: { episodes: number; strategy: NonNullable<RunnerBackendContext["evaluationStrategy"]> };
  search?: { episodes: number; measurementEpoch: string; calibrated: boolean };
  noise?: NoiseCalibrationRunConfig;
  reuse?: ProbeFlow;
  abortAfterEvaluatorRuns?: number;
  toolbeltFailure?: Error;
  toolbeltResult?: unknown;
  mutationWorkerPreflightContract?: RunnerBackendContext["mutationWorkerPreflightContract"];
  captureStartError?: boolean;
  /** Extra operator env for the backend context (e.g. HONE_SANDBOX_CPUSET). */
  env?: Record<string, string>;
}): Promise<ProbeFlow> {
  const root = opts.reuse?.root ?? makeRoot();
  const runId = "run_probe";
  let runDir: string;
  let capsule: ProbeFlow["capsule"];
  if (opts.reuse !== undefined) {
    runDir = opts.reuse.runDir;
    capsule = opts.reuse.capsule;
  } else {
    runDir = writeEvents(root, runId, opts.seed);
    // A crashed run's broker journal holds the durable incumbent fact BEFORE
    // the public event exists (journalFact ordering) — seed it alongside, or
    // the resumed broker correctly refuses a public promotion it never made.
    const incumbentFacts = opts.seed.flatMap((e) =>
      e.type === "incumbent.new"
        ? [{ t: "incumbent", hash: e.artifact.hash, aggregate: e.aggregate, deltaVsBaseline: e.deltaVsBaseline, episode: e.episode }]
        : [],
    );
    if (incumbentFacts.length > 0) {
      writeFileSync(join(runDir, "broker-state.ndjson"), `${incumbentFacts.map((f) => JSON.stringify(f)).join("\n")}\n`);
    }
    mkdirSync(join(root, ".hone-cas"), { recursive: true });
    capsule = probeCapsule(root);
    freezeCapsuleAssets(runDir, capsule.capsuleDir, capsule.manifest);
  }
  const { capsuleDir, manifest, digest } = capsule;

  const invocationsPath = join(root, "invocations.ndjson");
  const optimizerEntry = join(root, "opt.mjs");
  writeFileSync(
    optimizerEntry,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(invocationsPath)}, JSON.stringify({`,
      '  maxEpisodes: process.env.HONE_MAX_EPISODES ?? null,',
      '  oneShot: process.env.HONE_ONE_SHOT_CANDIDATE ?? null,',
      '  resume: JSON.parse(process.env.HONE_RESUME),',
      '}) + "\\n");',
    ].join("\n"),
  );

  const configsBefore = captured.brokerConfigs.length;
  const flow: ProbeFlow = {
    root,
    runDir,
    invocationsPath,
    capsule,
    probeReports: [],
    stops: 0,
    startError: null,
    toolbeltPreflights: [],
    toolbeltCpusets: [],
    get brokerConfigs() {
      return captured.brokerConfigs.slice(configsBefore);
    },
    evaluatorRuns: 0,
    events: () => readEvents(runDir),
    invocations: () =>
      existsSync(invocationsPath)
        ? readFileSync(invocationsPath, "utf8")
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l))
        : [],
  };

  const abort = new AbortController();
  const run: RunCommand = (argv) => {
    if (argv[0] === "docker" && argv[1] === "info") {
      return Promise.resolve(res({ stdout: Buffer.from("ENGINE-TEST\n") }));
    }
    if (argv[0] === "docker" && argv[1] === "create") {
      // Evaluator containers get an addressable id so their attached start
      // can answer with a trusted EvaluatorOutput.
      const name = argv[argv.indexOf("--name") + 1] ?? "";
      return Promise.resolve(res({ stdout: Buffer.from(name.includes("-eval-") ? `eval-${name}\n` : "lease-id\n") }));
    }
    if (argv[0] === "docker" && argv[1] === "start" && argv[2] === "-a" && (argv[3] ?? "").startsWith("eval-")) {
      flow.evaluatorRuns += 1;
      if (opts.abortAfterEvaluatorRuns !== undefined && flow.evaluatorRuns >= opts.abortAfterEvaluatorRuns) {
        abort.abort(new Error("host died"));
      }
      return Promise.resolve(res({ stdout: Buffer.from(JSON.stringify({ valid: true, objectives: { score: 0.5 } })) }));
    }
    if (argv[0] === "docker" && argv[1] === "exec" && argv.some((arg) => arg.includes("hone-scratch-keeper-"))) {
      const out = argv.find((a) => typeof a === "string" && a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
      const snapshotDir = join(runDir, "scratch-snapshot");
      mkdirSync(snapshotDir, { recursive: true });
      // Publish exactly the minted per-attempt basename (docker semantics): a
      // valid empty tar, so a resumed broker can restore it.
      writeFileSync(join(snapshotDir, out === undefined ? "scratch.tar.tmp" : out.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length)), Buffer.alloc(10240));
    }
    return Promise.resolve(res());
  };
  // In-container argv override + fake docker spawn: the backend believes it
  // launched the sealed container; lifecycle (env wiring, exit codes) is real.
  const backend = createBackend({
    run,
    spawnOptimizer: fakeOptimizerSpawn(FIX_IMAGE),
    createHelper: scriptedCreateHelper(run),
    mutationToolbeltSmoke: async (runtime) => {
      flow.toolbeltCpusets.push(runtime.cpuset);
      flow.toolbeltPreflights.push({
        image: runtime.image,
        optimizerStarted: existsSync(invocationsPath),
      });
      if (opts.toolbeltFailure !== undefined) throw opts.toolbeltFailure;
      return opts.toolbeltResult;
    },
  });
  const config = RunConfig.parse({
    version: 1,
    capsuleId: manifest.id,
    objective: manifest.objective,
    budget: manifest.budget,
    routing: { mutation: { model: "m" } },
    headless: true,
    ...(opts.search === undefined
      ? {}
      : {
          search: {
            episodes: opts.search.episodes,
            measurementEpoch: opts.search.measurementEpoch,
            calibrations: opts.search.calibrated
              ? [{
                  gateVersion: PROMOTION_GATE_VERSION,
                  evidenceVersion: "hone-baseline-noise-v1",
                  calibratedAt: "2026-10-05T00:00:00.000Z",
                  capsuleId: manifest.id,
                  admittedCapsuleDigest: digest,
                  executionImage: manifest.image,
                  assetGroupId: "train",
                  measurementEpoch: opts.search.measurementEpoch,
                  sourceCohortSha256: [fakeHash("3")],
                  maxObservedPairDelta: 0,
                  noiseFloor: 0,
                  noiseEnvelope: 0,
                  informationFreePairs: 63,
                  informationFreePositive: 0,
                  estimator: "pooled-within-coordinate-sd-v1",
                  estimatorMinRepeatsPerCoordinate: 3,
                  sampleDepths: [7, 7, 7],
                  informationFreeMeasurements: 21,
                  coordinateGroups: 3,
                  pooledDegreesOfFreedom: 18,
                  pooledWithinCoordinateSd: 0,
                }]
              : [],
          },
        }),
    ...(opts.noise === undefined ? {} : { noiseCalibration: opts.noise }),
  });
  const ctx: RunnerBackendContext = {
    runId,
    root,
    runDir,
    casDir: join(root, ".hone-cas"),
    capsuleDir,
    admittedManifest: manifest,
    runtimeIdentity: { admittedCapsuleDigest: digest, executionImage: manifest.image },
    config,
    env: {
      PATH: process.env["PATH"] ?? "",
      HONE_EGRESS: "socket",
      // The upstream is required (no default); the scripted optimizer never dials it.
      HONE_UPSTREAM_BASE_URL: "http://127.0.0.1:9",
      HONE_OPTIMIZER_CMD: `${process.execPath} ${optimizerEntry}`,
      ...opts.env,
    },
    // Direct backend fixture: frozen assets/run.started already exist; this is the post-seal byte recheck.
    admissionReview: "off",
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
    ...(opts.m1 === undefined
      ? {}
      : {
          measurementEpoch: "m1:test-epoch",
          evaluationStrategy: opts.m1.strategy,
          optimizerEpisodesMax: opts.m1.episodes,
          maxPublicCandidateEvaluations: Math.max(1, opts.m1.episodes),
        }),
    // Exactly what the supervisor derives from a sealed run config.
    ...sealedRunAuthority(config),
    ...(opts.mutationWorkerPreflightContract === undefined
      ? {}
      : { mutationWorkerPreflightContract: opts.mutationWorkerPreflightContract }),
    requestStop: () => {
      flow.stops++;
    },
    requestPause: () => {},
    registerAuthorityBarrier: () => {},
    registerCleanupBarrier: () => {},
  };

  try {
    await backend.start(ctx);
  } catch (error) {
    if (opts.captureStartError !== true) throw error;
    flow.startError = error instanceof Error ? error : new Error(String(error));
  }
  return flow;
}

describe("trusted M1 fixed-work local branch", () => {
  it("skips the M0 probe, honors the episode cap, and records a terminal trusted evaluation", { timeout: 30_000 }, async () => {
    let calls = 0;
    let seenEpoch: string | undefined;
    const strategy: NonNullable<RunnerBackendContext["evaluationStrategy"]> = async (input) => {
      calls++;
      seenEpoch = input.measurementEpoch;
      return EvaluationRecord.parse({
        runId: input.runId,
        capsuleId: input.capsuleId,
        artifactHash: input.artifact.hash,
        assetGroupId: input.assetGroupId,
        seed: input.seed,
        output: {
          valid: true,
          aggregate: 0.5,
          objectives: { meta: 0.5 },
          constraints: {},
          perExample: {},
          diagnostics: { summary: "trusted M1 terminal measurement" },
        },
        costUsd: 0,
        durationMs: 1,
        cached: false,
        evaluatedAt: new Date().toISOString(),
      });
    };
    const flow = await runProbeFlow({
      seed: [{
        runId: "run_probe",
        at: at(),
        type: "run.started",
        capsuleId: CAP_ID,
        contractHash: fakeHash("c"),
        optimizerDigest: fakeHash("0"),
      }],
      verdict: false,
      m1: { episodes: 3, strategy },
    });

    // M1 children stay in one-shot-candidate mode.
    expect(flow.invocations()).toEqual([{ maxEpisodes: "3", oneShot: "1", resume: expect.objectContaining({ nextEpisode: 0 }) }]);
    const [brokerConfig] = flow.brokerConfigs;
    expect(brokerConfig).toMatchObject({
      measurementEpoch: "m1:test-epoch",
      maxMutationEpisodes: 3,
      maxCandidateArtifacts: 4,
      maxPublicCandidateEvaluations: 3,
    });
    expect(brokerConfig).not.toHaveProperty("runScopedEvaluationCache");
    expect(brokerConfig).not.toHaveProperty("promotionNoiseCalibrations");
    expect(flow.toolbeltPreflights).toEqual([{ image: FIX_IMAGE, optimizerStarted: false }]);
    expect(flow.probeReports).toHaveLength(0);
    expect(flow.events().some((event) => event.type === "probe.completed")).toBe(false);
    expect(calls).toBe(1);
    expect(seenEpoch).toBe("m1:test-epoch");
    expect(readBrokerJournalEvaluations(flow.runDir).records).toHaveLength(1);
  });

  it("durably records both full-toolbelt and legacy-selftest preflight contracts", { timeout: 30_000 }, async () => {
    const strategy: NonNullable<RunnerBackendContext["evaluationStrategy"]> = async (input) =>
      EvaluationRecord.parse({
        runId: input.runId,
        capsuleId: input.capsuleId,
        artifactHash: input.artifact.hash,
        assetGroupId: input.assetGroupId,
        seed: input.seed,
        output: {
          valid: true,
          aggregate: 0.5,
          objectives: { meta: 0.5 },
          constraints: {},
          perExample: {},
          diagnostics: { summary: "preflight record fixture" },
        },
        costUsd: 0,
        durationMs: 1,
        cached: false,
        evaluatedAt: new Date().toISOString(),
      });
    const cases = [
      {
        contract: undefined,
        result: {
          type: "hone-mutation-toolbelt-selftest.v1",
          home: "/home/hone",
          modelCalls: 0,
          tools: ["bash", "write", "edit"],
          outputs: { bash: "bash-ok\n", write: "write-ok\n", edit: "edit-ok\n" },
        },
        expected: "full-toolbelt",
      },
      {
        contract: "legacy-selftest" as const,
        result: {
          type: "hone-mutation-legacy-selftest.v1",
          contract: "legacy-selftest",
          modelCalls: 0,
          output: "hone-mutation selftest ok",
        },
        expected: "legacy-selftest",
      },
    ];
    for (const fixture of cases) {
      const flow = await runProbeFlow({
        seed: [{
          runId: "run_probe",
          at: at(),
          type: "run.started",
          capsuleId: CAP_ID,
          contractHash: fakeHash("c"),
          optimizerDigest: fakeHash("0"),
        }],
        verdict: false,
        m1: { episodes: 1, strategy },
        toolbeltResult: fixture.result,
        ...(fixture.contract === undefined
          ? {}
          : { mutationWorkerPreflightContract: fixture.contract }),
      });
      const record = JSON.parse(readFileSync(
        join(flow.runDir, MUTATION_WORKER_PREFLIGHT_FILE),
        "utf8",
      ));
      expect(record).toEqual({
        version: 1,
        runId: "run_probe",
        optimizerDigest: fakeHash("0"),
        contract: fixture.expected,
        result: fixture.result,
      });
    }
  });

  it("refuses at zero spend when the mutation toolbelt smoke rejects", { timeout: 30_000 }, async () => {
    const toolbeltFailure = new Error("mutation toolbelt unavailable");
    const strategy: NonNullable<RunnerBackendContext["evaluationStrategy"]> = async () => {
      throw new Error("evaluation must not start after a toolbelt refusal");
    };
    const flow = await runProbeFlow({
      seed: [{
        runId: "run_probe",
        at: at(),
        type: "run.started",
        capsuleId: CAP_ID,
        contractHash: fakeHash("c"),
        optimizerDigest: fakeHash("0"),
      }],
      verdict: false,
      m1: { episodes: 3, strategy },
      toolbeltFailure,
      captureStartError: true,
    });

    expect(flow.startError).toBe(toolbeltFailure);
    expect(flow.toolbeltPreflights).toEqual([{ image: FIX_IMAGE, optimizerStarted: false }]);
    expect(flow.invocations()).toEqual([]);
    expect(flow.events().some((event) => event.type === "episode.started")).toBe(false);
  });

  it("reads HONE_SANDBOX_CPUSET once at backend start and hands it to the prepared optimizer runtime the preflight uses", { timeout: 30_000 }, async () => {
    const seed: RunEvent[] = [{
      runId: "run_probe",
      at: at(),
      type: "run.started",
      capsuleId: CAP_ID,
      contractHash: fakeHash("c"),
      optimizerDigest: fakeHash("0"),
    }];
    const strategy: NonNullable<RunnerBackendContext["evaluationStrategy"]> = async () => {
      throw new Error("evaluation must not start after a toolbelt refusal");
    };
    const preflightCpusets = async (env: Record<string, string>): Promise<Array<string | undefined>> => {
      const flow = await runProbeFlow({
        seed,
        verdict: false,
        m1: { episodes: 3, strategy },
        toolbeltFailure: new Error("stop at the preflight"),
        captureStartError: true,
        env,
      });
      expect(flow.startError?.message).toBe("stop at the preflight");
      return flow.toolbeltCpusets;
    };

    expect(await preflightCpusets({ HONE_SANDBOX_CPUSET: "1-4" })).toEqual(["1-4"]);
    expect(await preflightCpusets({})).toEqual([undefined]);
    expect(await preflightCpusets({ HONE_SANDBOX_CPUSET: "" })).toEqual([undefined]); // empty == unset
  });
});

describe("sealed hone run search (real local backend)", () => {
  const EPOCH = "compress-2026-10";
  const started = (runId: string): RunEvent => ({
    runId, at: at(), type: "run.started", capsuleId: CAP_ID, contractHash: fakeHash("c"), optimizerDigest: fakeHash("0"), checkpointVersion: 1,
  });

  it("hands the broker the sealed episode caps, epoch, run-scoped cache and calibration, and runs the loop without the probe", { timeout: 30_000 }, async () => {
    const flow = await runProbeFlow({ seed: [started("run_probe")], verdict: false, search: { episodes: 5, measurementEpoch: EPOCH, calibrated: true } });

    // Full multi-episode loop: no HONE_ONE_SHOT_CANDIDATE, no probe gate.
    expect(flow.invocations()).toEqual([{ maxEpisodes: "5", oneShot: null, resume: expect.objectContaining({ nextEpisode: 0, incumbent: null }) }]);
    expect(flow.probeReports).toHaveLength(0);
    expect(flow.stops).toBe(0);
    expect(flow.events().some((event) => event.type === "probe.completed")).toBe(false);
    expect(flow.brokerConfigs).toHaveLength(1);
    const [brokerConfig] = flow.brokerConfigs;
    expect(brokerConfig).toMatchObject({
      measurementEpoch: EPOCH,
      runScopedEvaluationCache: true,
      maxMutationEpisodes: 5,
      maxPublicCandidateEvaluations: 10,
      maxCandidateArtifacts: 10,
      promotionNoiseCalibrations: [expect.objectContaining({ measurementEpoch: EPOCH, assetGroupId: "train", capsuleId: flow.capsule.manifest.id })],
    });
    // The admitted envelope stays the broker-enforced budget.
    expect(brokerConfig?.manifest.budget).toEqual(flow.capsule.manifest.budget);
    // Unlike an M1 child, a search buys no extra terminal evaluation.
    expect(flow.evaluatorRuns).toBe(0);
  });

  it("an uncalibrated search hands the broker an explicit empty calibration list, never the built-in fallback", { timeout: 30_000 }, async () => {
    const flow = await runProbeFlow({ seed: [started("run_probe")], verdict: false, search: { episodes: 2, measurementEpoch: EPOCH, calibrated: false } });
    expect(flow.brokerConfigs[0]?.promotionNoiseCalibrations).toEqual([]);
    expect(flow.invocations()).toEqual([expect.objectContaining({ maxEpisodes: "2", oneShot: null })]);
  });

  it("resumes from the durable episode cursor and incumbent without re-buying completed episodes", { timeout: 30_000 }, async () => {
    const runId = "run_probe";
    const [b, c, d] = [fakeHash("b"), fakeHash("c"), fakeHash("d")];
    const flow = await runProbeFlow({
      seed: [
        started(runId),
        ...episodeEvents(runId, 0, b, c),
        { runId, at: at(), type: "episode.completed", episode: 0 },
        { runId, at: at(), type: "episode.started", episode: 1, parent: { hash: c } },
        { runId, at: at(), type: "episode.candidate", episode: 1, candidate: { hash: d }, sessionTrace: fakeHash("e") },
        { runId, at: at(), type: "episode.invalid", episode: 1, reason: "evaluator rejected the candidate as invalid", repaired: false },
        { runId, at: at(), type: "episode.completed", episode: 1 },
      ],
      verdict: false,
      search: { episodes: 4, measurementEpoch: EPOCH, calibrated: true },
    });
    expect(flow.invocations()).toEqual([{
      maxEpisodes: "2",
      oneShot: null,
      resume: expect.objectContaining({ nextEpisode: 2, incumbent: expect.objectContaining({ artifact: { hash: c } }) }),
    }]);
    expect(flow.brokerConfigs[0]).toMatchObject({ episodeOrigin: 2, maxMutationEpisodes: 4, measurementEpoch: EPOCH });
    expect(flow.probeReports).toHaveLength(0);
  });

  it("a finished episode budget launches no optimizer on resume", { timeout: 30_000 }, async () => {
    const runId = "run_probe";
    const flow = await runProbeFlow({
      seed: [
        started(runId),
        { runId, at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
        { runId, at: at(), type: "episode.completed", episode: 0 },
      ],
      verdict: false,
      search: { episodes: 1, measurementEpoch: EPOCH, calibrated: false },
    });
    expect(flow.invocations()).toEqual([]);
    expect(flow.evaluatorRuns).toBe(0);
  });

  it("M0 without search keeps the one-shot probe under the M0 broker caps", { timeout: 30_000 }, async () => {
    const flow = await runProbeFlow({ seed: [started("run_probe")], verdict: false, captureStartError: true });
    // The scripted optimizer produces no pair, so the probe report refuses — the invocation shape is what matters.
    expect(flow.startError?.message).toMatch(/no completed evaluation/);
    expect(flow.invocations()).toEqual([expect.objectContaining({ maxEpisodes: "1", oneShot: "1" })]);
    const [brokerConfig] = flow.brokerConfigs;
    expect(brokerConfig).toMatchObject({ maxMutationEpisodes: 1, maxCandidateArtifacts: 2 });
    for (const key of ["measurementEpoch", "runScopedEvaluationCache", "promotionNoiseCalibrations", "maxPublicCandidateEvaluations"]) {
      expect(brokerConfig, key).not.toHaveProperty(key);
    }
  });

  it.runIf(process.platform === "linux")(
    "a noise run measures only the frozen baseline per sealed seed, calls no optimizer, and a resume after host death never re-pays a measured seed",
    { timeout: 60_000 },
    async () => {
      const noise = { measurementEpoch: EPOCH, assetGroupId: "train", seeds: [0, 1, 2] };
      const first = await runProbeFlow({ seed: [started("run_probe")], verdict: false, noise, abortAfterEvaluatorRuns: 1 });
      expect(first.evaluatorRuns).toBe(1);
      expect(readBrokerJournalEvaluations(first.runDir).facts.map((fact) => fact.record.seed)).toEqual([0]);
      expect(first.brokerConfigs[0]).toMatchObject({ measurementEpoch: EPOCH, runScopedEvaluationCache: true, promotionNoiseCalibrations: [] });

      const resumed = await runProbeFlow({ seed: [], verdict: false, noise, reuse: first });
      expect(resumed.evaluatorRuns).toBe(2);
      const facts = readBrokerJournalEvaluations(resumed.runDir).facts;
      expect(facts.map((fact) => fact.record.seed)).toEqual([0, 1, 2]);
      for (const fact of facts) {
        expect(fact).toMatchObject({ measurementEpoch: EPOCH, aggregate: 0.5, record: { cached: false, assetGroupId: "train" } });
      }
      expect(new Set(facts.map((fact) => fact.record.artifactHash)).size).toBe(1);
      expect(resumed.invocations()).toEqual([]);
      expect(resumed.toolbeltPreflights).toEqual([]);
    },
  );
});

function seededLog(runId: string): RunEvent[] {
  return [
    { runId, at: at(), type: "run.started", capsuleId: CAP_ID, contractHash: fakeHash("c"), optimizerDigest: fakeHash("0") },
    ...episodeEvents(runId, 0, fakeHash("b"), fakeHash("c")),
  ];
}

describe("probe gate flow (real local backend, scripted optimizer)", () => {
  it("resume with an unsealed completed pair re-gates it without buying another probe episode", { timeout: 30_000 }, async () => {
    const flow = await runProbeFlow({ seed: seededLog("run_probe"), verdict: true });

    // The completed broker-authored pair is sufficient evidence: it re-gates
    // WITHOUT buying another probe episode, and — M0 one-shot — the approved
    // probe candidate IS the run candidate, so approval finalizes without any
    // optimizer invocation at all.
    expect(flow.invocations().length).toBe(0);

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
  it("EXPLOIT flow: the owner is prompted for the gate-bound artifact, never a later re-saved unevaluated repair", { timeout: 30_000 }, async () => {
    const runId = "run_probe";
    const R = fakeHash("a");
    const C = fakeHash("c");
    const seed: RunEvent[] = [
      { runId, at: at(), type: "run.started", capsuleId: CAP_ID, contractHash: fakeHash("c"), optimizerDigest: fakeHash("0") },
      { runId, at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      // Failed-exec repair R (artifact 1 of 2): saved, never evaluated.
      { runId, at: at(), type: "episode.candidate", episode: 0, candidate: { hash: R }, sessionTrace: fakeHash("1") },
      // Distinct C (artifact 2 of 2): saved, trusted-evaluated, gated.
      { runId, at: at(), type: "episode.candidate", episode: 0, candidate: { hash: C }, sessionTrace: fakeHash("2") },
      { runId, at: at(), type: "eval.completed", episode: 0, artifact: { hash: C }, assetGroupId: "validation", seed: 3, aggregate: 0.62, cached: false },
      { runId, at: at(), type: "gate.paired", episode: 0, parentScore: 0.5, childScore: 0.62, passed: true },
      { runId, at: at(), type: "incumbent.new", artifact: { hash: C }, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 },
      // Reopened R, byte-identical no-op save: R is the LAST episode.candidate.
      { runId, at: at(), type: "episode.candidate", episode: 0, candidate: { hash: R }, sessionTrace: fakeHash("3") },
    ];
    const flow = await runProbeFlow({ seed, verdict: true });
    expect(flow.invocations().length).toBe(0);
    // The prompt candidate is the eval/gate-bound C — the incumbent the
    // one-shot run finalizes — at C's own trusted score. Never R.
    expect(flow.probeReports.length).toBe(1);
    expect(flow.probeReports[0]?.candidate?.artifact.hash).toBe(C);
    expect(flow.probeReports[0]?.candidate?.aggregate).toBe(0.62);
    // The sealed durable approval names the same artifact.
    const probes = flow.events().flatMap((e) => (e.type === "probe.completed" ? [e] : []));
    expect(probes.length).toBe(1);
    expect(probes[0]?.approved).toBe(true);
    expect(probes[0]?.candidate?.artifact.hash).toBe(C);
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
    // M0 one-shot: the durable approval resumes straight to finalization —
    // the gate never re-runs and NO optimizer invocation is bought (the
    // approved probe candidate already is the run candidate).
    expect(flow.invocations().length).toBe(0);
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
