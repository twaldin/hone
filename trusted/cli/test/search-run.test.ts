import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMOTION_GATE_VERSION, RunConfig, RunEvent, capsuleDigest } from "@hone/schema";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import { searchReport } from "../src/search.js";
import { CAP_ID, FIX_IMAGE, at, fakeHash, makeCapsule, makeIo, makeRoot, manifestObject } from "./helpers.js";

/**
 * `hone run` search: the sealed run config is the run's only search
 * authority. A recording backend (the dev-only module seam) captures the
 * trusted context the supervisor hands the backend, so these cases prove the
 * sealing, the plumbing, resume reuse, and the M0 default without Docker.
 */

const EPOCH = "compress-2026-10";

function recordingBackend(root: string): string {
  const path = join(root, "recording-backend.mjs");
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs";
    export function createBackend() {
      return {
        async start(ctx) {
          appendFileSync(${JSON.stringify(join(root, "contexts.ndjson"))}, JSON.stringify({
            runId: ctx.runId,
            resumeCount: ctx.replayed.resumeCount,
            measurementEpoch: ctx.measurementEpoch ?? null,
            optimizerEpisodesMax: ctx.optimizerEpisodesMax ?? null,
            maxPublicCandidateEvaluations: ctx.maxPublicCandidateEvaluations ?? null,
            maxCandidateArtifacts: ctx.maxCandidateArtifacts ?? null,
            promotionNoiseCalibrations: ctx.promotionNoiseCalibrations ?? null,
          }) + "\\n");
          // First start leaves a durable pause so the run stays resumable.
          if (ctx.env.RECORDING_PAUSE_FIRST === "1" && ctx.replayed.resumeCount === 0) {
            ctx.requestPause({ reason: "operator" });
          }
        },
      };
    }
    `,
  );
  return "./recording-backend.mjs";
}

function contexts(root: string): Array<Record<string, unknown>> {
  const path = join(root, "contexts.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runIds(root: string): string[] {
  const dir = join(root, ".hone-runs");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("run_")) : [];
}

function sealedConfig(root: string, runId: string): RunConfig {
  return RunConfig.parse(JSON.parse(readFileSync(join(root, ".hone-runs", runId, "runconfig.json"), "utf8")));
}

function writeJson(root: string, name: string, value: unknown): string {
  writeFileSync(join(root, name), JSON.stringify(value));
  return name;
}

function calibration(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gateVersion: PROMOTION_GATE_VERSION,
    evidenceVersion: "hone-baseline-noise-v1",
    calibratedAt: "2026-10-05T00:00:00.000Z",
    capsuleId: CAP_ID,
    admittedCapsuleDigest: capsuleDigest(manifestObject()),
    executionImage: FIX_IMAGE,
    assetGroupId: "train",
    measurementEpoch: EPOCH,
    sourceCohortSha256: [fakeHash("3")],
    maxObservedPairDelta: 0.02,
    noiseFloor: 0.03,
    noiseEnvelope: 0.045,
    informationFreePairs: 63,
    informationFreePositive: 30,
    estimator: "pooled-within-coordinate-sd-v1",
    estimatorMinRepeatsPerCoordinate: 3,
    sampleDepths: [7, 7, 7],
    informationFreeMeasurements: 21,
    coordinateGroups: 3,
    pooledDegreesOfFreedom: 18,
    pooledWithinCoordinateSd: 0.01,
    ...over,
  };
}

function setup(env: Record<string, string> = {}) {
  const root = makeRoot();
  makeCapsule(root);
  const backend = recordingBackend(root);
  const captured = makeIo(root, {
    HONE_UNSAFE_BACKEND: "1",
    HONE_KILL_GRACE_MS: "50",
    HONE_OPTIMIZER_CMD: "true",
    HONE_OPTIMIZER_DIGEST: fakeHash("0"),
    ...env,
  });
  return { root, backend, ...captured };
}

describe("hone run search: creation seals episodes, epoch and calibration", () => {
  it("seals a minted run-scoped epoch and an empty calibration, plumbs trusted caps, and says plainly nothing can promote", { timeout: 60_000 }, async () => {
    const { root, backend, io, out, err } = setup();
    const config = writeJson(root, "search.json", { search: { episodes: 3 } });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", config], io)).toBe(0);

    const [runId] = runIds(root);
    if (runId === undefined) throw new Error("no run minted");
    const sealed = sealedConfig(root, runId);
    expect(sealed.search).toEqual({ episodes: 3, measurementEpoch: `search:${runId}`, calibrations: [] });
    const contract = readFileSync(join(root, ".hone-runs", runId, "contract.md"), "utf8");
    expect(contract).toContain("## Search (sealed)");
    expect(contract).toContain("no child can become incumbent");
    expect(contract).not.toContain("M0 is one cache-safe candidate");
    expect(err.join("\n")).toMatch(/no promotion calibration for asset group train .* no child can become incumbent/);

    expect(contexts(root)).toEqual([{
      runId,
      resumeCount: 0,
      measurementEpoch: `search:${runId}`,
      optimizerEpisodesMax: 3,
      maxPublicCandidateEvaluations: 6,
      maxCandidateArtifacts: 6,
      promotionNoiseCalibrations: [],
    }]);
    const report = JSON.parse(out[out.length - 1] ?? "{}") as { search?: { calibrated: boolean; episodes: unknown; lineage: unknown[] } };
    expect(report.search?.calibrated).toBe(false);
    expect(report.search?.episodes).toEqual({ planned: 3, completed: 0 });
    expect(report.search?.lineage).toEqual([]);
  });

  it("accepts an identity-matched calibration sealed in the operator-chosen epoch and hands it to the backend", { timeout: 60_000 }, async () => {
    const { root, backend, io, err } = setup();
    const config = writeJson(root, "search.json", { search: { episodes: 2, measurementEpoch: EPOCH } });
    const file = writeJson(root, "calibration.json", calibration());
    expect(await cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", config, "--calibration", file], io)).toBe(0);
    const [runId] = runIds(root);
    if (runId === undefined) throw new Error("no run minted");
    const parsed = sealedConfig(root, runId).search;
    expect(parsed?.measurementEpoch).toBe(EPOCH);
    expect(parsed?.calibrations).toEqual([calibration()]);
    expect(contexts(root)[0]?.["promotionNoiseCalibrations"]).toEqual([calibration()]);
    expect(err.join("\n")).not.toMatch(/no promotion calibration/);
    expect(readFileSync(join(root, ".hone-runs", runId, "contract.md"), "utf8")).toContain("noise envelope 0.045");
  });

  it("refuses, before minting a run, any calibration the broker would refuse or that misses the search group", { timeout: 60_000 }, async () => {
    const cases: Array<{ name: string; file: unknown; epoch?: string | null; pattern: RegExp }> = [
      { name: "epoch", file: calibration({ measurementEpoch: "other-epoch" }), pattern: /measurement epoch "other-epoch" != "compress-2026-10"/ },
      { name: "image", file: calibration({ executionImage: `hone-task@sha256:${"9".repeat(64)}` }), pattern: /evaluator image/ },
      { name: "digest", file: calibration({ admittedCapsuleDigest: fakeHash("8") }), pattern: /admitted digest/ },
      { name: "capsule", file: calibration({ capsuleId: "cap_000000000000" }), pattern: /capsule cap_000000000000/ },
      { name: "group", file: calibration({ assetGroupId: "nope" }), pattern: /unregistered asset group nope/ },
      { name: "coverage", file: calibration({ assetGroupId: "validation" }), pattern: /covers validation, but the search gates on train/ },
      { name: "duplicate", file: [calibration(), calibration()], pattern: /duplicate promotion noise calibration for train/ },
      { name: "minimums", file: calibration({ sampleDepths: [7, 7, 6], informationFreeMeasurements: 20, pooledDegreesOfFreedom: 17 }), pattern: /--calibration refused/ },
      { name: "no epoch", file: calibration(), epoch: null, pattern: /--calibration requires search.measurementEpoch/ },
    ];
    for (const fixture of cases) {
      const { root, backend, io } = setup();
      const search = fixture.epoch === null ? { episodes: 2 } : { episodes: 2, measurementEpoch: EPOCH };
      const config = writeJson(root, "search.json", { search });
      const file = writeJson(root, "calibration.json", fixture.file);
      await expect(
        cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", config, "--calibration", file], io),
        fixture.name,
      ).rejects.toThrow(fixture.pattern);
      expect(runIds(root), fixture.name).toEqual([]);
    }
  });

  it("refuses an episode count the admitted envelope cannot serve, non-none apply, campaign authority, and --calibration without search", { timeout: 60_000 }, async () => {
    const { root, backend, io } = setup();
    // Fixture envelope: 100 evaluator invocations; 51 episodes need >= 102.
    const tooMany = writeJson(root, "too-many.json", { search: { episodes: 51 } });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", tooMany], io))
      .rejects.toThrow(/search.episodes 51 needs at least 102 evaluator invocations .* allows 100/);
    const tightened = writeJson(root, "tightened.json", { search: { episodes: 3 }, budget: { maxEvaluatorInvocations: 5 } });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", tightened], io))
      .rejects.toThrow(/needs at least 6 evaluator invocations .* allows 5/);
    const branch = writeJson(root, "branch.json", { search: { episodes: 2 }, apply: "branch" });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", branch], io))
      .rejects.toThrow(/apply none only/);
    const ok = writeJson(root, "ok.json", { search: { episodes: 2 } });
    await expect(cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", ok], io, { measurementEpoch: "m1:x" }))
      .rejects.toThrow(/never from campaign orchestration/);
    const file = writeJson(root, "calibration.json", calibration());
    await expect(cliRunCommand(["capsule", "--headless", "--backend", backend, "--calibration", file], io))
      .rejects.toThrow(/add `search` to --config/);
    await expect(cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", writeJson(root, "x.json", { search: { episodes: 2, extra: 1 } })], io))
      .rejects.toThrow();
    expect(runIds(root)).toEqual([]);
  });
});

describe("hone run search: resume", () => {
  it("reuses the sealed epoch and authority on resume, and --run targets the exact run", { timeout: 90_000 }, async () => {
    const { root, backend, io } = setup({ RECORDING_PAUSE_FIRST: "1" });
    const config = writeJson(root, "search.json", { search: { episodes: 4, measurementEpoch: EPOCH } });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", config], io)).toBe(0);
    const [runId] = runIds(root);
    if (runId === undefined) throw new Error("no run minted");

    await expect(cliRunCommand(["capsule", "--headless", "--run", runId], io)).rejects.toThrow(/requires --resume/);
    await expect(cliRunCommand(["capsule", "--headless", "--resume", "--run", runId, "--calibration", "x.json"], io))
      .rejects.toThrow(/sealed at run creation/);
    await expect(cliRunCommand(["capsule", "--headless", "--resume", "--run", "run_missing"], io))
      .rejects.toThrow(/nothing to resume: run_missing is not an unfinished run/);

    expect(await cliRunCommand(["capsule", "--headless", "--resume", "--run", runId], io)).toBe(0);
    const [first, second] = contexts(root);
    expect(second?.["resumeCount"]).toBe(1);
    for (const ctx of [first, second]) {
      expect(ctx).toMatchObject({
        runId,
        measurementEpoch: EPOCH,
        optimizerEpisodesMax: 4,
        maxPublicCandidateEvaluations: 8,
        maxCandidateArtifacts: 8,
        promotionNoiseCalibrations: [],
      });
    }
    expect(sealedConfig(root, runId).search?.measurementEpoch).toBe(EPOCH);
  });
});

describe("hone run without search: M0 unchanged", () => {
  it("seals no search, renders the M0 contract line, hands the backend no search authority, and reports no search section", { timeout: 60_000 }, async () => {
    const { root, backend, io, out, err } = setup();
    expect(await cliRunCommand(["capsule", "--headless", "--backend", backend], io)).toBe(0);
    const [runId] = runIds(root);
    if (runId === undefined) throw new Error("no run minted");
    const raw = readFileSync(join(root, ".hone-runs", runId, "runconfig.json"), "utf8");
    expect(raw).not.toContain("search");
    expect(raw).not.toContain("noiseCalibration");
    const contract = readFileSync(join(root, ".hone-runs", runId, "contract.md"), "utf8");
    expect(contract).toContain("_M0 is one cache-safe candidate: the approved probe is immediately finalized and delivered. Multi-episode inner search requires M1 fresh evaluator cache domains. The rule above is sealed now for the M1 outer champion decision._");
    expect(contract).not.toContain("## Search");
    expect(contexts(root)).toEqual([{
      runId,
      resumeCount: 0,
      measurementEpoch: null,
      optimizerEpisodesMax: null,
      maxPublicCandidateEvaluations: null,
      maxCandidateArtifacts: null,
      promotionNoiseCalibrations: null,
    }]);
    expect(Object.keys(JSON.parse(out[out.length - 1] ?? "{}") as object)).toEqual([
      "runId", "status", "best", "aggregate", "deltaVsBaseline", "spend", "lifetimeSec",
    ]);
    expect(err.join("\n")).not.toMatch(/calibration/);
  });
});

describe("search report", () => {
  it("walks the best incumbent's promotions back to the baseline with each broker-paired delta", () => {
    const runId = "run_report";
    const [b, c1, c3] = [fakeHash("b"), fakeHash("c"), fakeHash("e")];
    const gate = (episode: number, parentScore: number, childScore: number, passed: boolean, decision: string) => ({
      runId, at: at(), type: "gate.paired" as const, episode, parentScore, childScore, passed,
      gateVersion: PROMOTION_GATE_VERSION, calibrationEvidenceVersion: "v", delta: childScore - parentScore,
      noiseFloor: 0.03, noiseEnvelope: 0.045, decision: decision as "promote",
    });
    const events = [
      { runId, at: at(), type: "episode.started" as const, episode: 0, parent: { hash: b } },
      gate(0, 0.5, 0.6, true, "promote"),
      { runId, at: at(), type: "incumbent.new" as const, artifact: { hash: c1 }, aggregate: 0.6, deltaVsBaseline: 0.1, episode: 0 },
      { runId, at: at(), type: "episode.completed" as const, episode: 0 },
      { runId, at: at(), type: "episode.started" as const, episode: 1, parent: { hash: c1 } },
      gate(1, 0.6, 0.62, false, "refuse-within-noise"),
      { runId, at: at(), type: "episode.completed" as const, episode: 1 },
      { runId, at: at(), type: "episode.started" as const, episode: 2, parent: { hash: c1 } },
      gate(2, 0.61, 0.7, true, "promote"),
      { runId, at: at(), type: "incumbent.new" as const, artifact: { hash: c3 }, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 2 },
      { runId, at: at(), type: "episode.completed" as const, episode: 2 },
    ];
    const search = RunConfig.parse({
      version: 1,
      capsuleId: CAP_ID,
      objective: "x",
      budget: manifestObject().budget,
      routing: {},
      search: { episodes: 4, measurementEpoch: EPOCH, calibrations: [calibration()] },
    }).search;
    if (search === undefined) throw new Error("search did not parse");
    const report = searchReport(RunEvent.array().parse(events), search, manifestObject());
    expect(report.calibrated).toBe(true);
    expect(report.episodes).toEqual({ planned: 4, completed: 3 });
    expect(report.gates).toEqual({ promote: 2, "refuse-within-noise": 1 });
    expect(report.lineage.map((step) => [step.episode, step.parent, step.artifact, step.delta, step.deltaVsBaseline])).toEqual([
      [0, b, c1, expect.closeTo(0.1), 0.1],
      [2, c1, c3, expect.closeTo(0.09), 0.2],
    ]);
  });
});
