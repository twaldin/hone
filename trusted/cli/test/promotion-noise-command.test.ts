import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DETERMINISTIC_ZERO_NOISE_ESTIMATOR, PromotionNoiseCalibration, RunConfig, capsuleDigest } from "@hone/schema";
import { promotionNoiseCommand } from "../src/commands/promotion-noise.js";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import { CAP_ID, FIX_IMAGE, fakeHash, makeCapsule, makeIo, makeRoot, manifestObject } from "./helpers.js";

/**
 * `hone promotion-noise` drives R sealed baseline-only noise runs through the
 * ordinary trusted `hone run` path and derives one calibration from their
 * broker journals. A dev backend stands in for the Docker evaluator: it
 * journals one trusted baseline measurement per sealed seed, exactly the facts
 * the local backend's noise branch writes (that branch itself is covered by
 * probe.test.ts on Linux).
 */

const EPOCH = "compress-2026-10";

function noiseBackend(root: string): string {
  writeFileSync(
    join(root, "noise-backend.mjs"),
    `import { appendFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    import { join } from "node:path";
    export function createBackend() {
      return {
        async start(ctx) {
          appendFileSync(${JSON.stringify(join(root, "starts.ndjson"))}, JSON.stringify({
            runId: ctx.runId,
            resumeCount: ctx.replayed.resumeCount,
            measurementEpoch: ctx.measurementEpoch ?? null,
            optimizerEpisodesMax: ctx.optimizerEpisodesMax ?? null,
          }) + "\\n");
          if (ctx.config.noiseCalibration === undefined) return;
          // Host death stand-in: the first start of the selected repeat leaves a durable pause.
          if (ctx.env.NOISE_PAUSE_SUFFIX !== undefined && ctx.runId.endsWith(ctx.env.NOISE_PAUSE_SUFFIX) && ctx.replayed.resumeCount === 0) {
            ctx.requestPause({ reason: "operator" });
            return;
          }
          const repeat = Number(ctx.runId.split("_r").pop());
          const deterministic = ctx.env.NOISE_DETERMINISTIC === "1";
          const vary = ctx.env.NOISE_VARY === "1" && repeat === 1;
          const namespace = "eval-run-" + createHash("sha256").update(JSON.stringify({
            measurementEpoch: ctx.measurementEpoch, runId: ctx.runId,
          })).digest("hex");
          const lines = ctx.config.noiseCalibration.seeds.map((seed) => JSON.stringify({
            t: "eval",
            measurementEpoch: ctx.measurementEpoch,
            ...(ctx.env.NOISE_MISSING_NAMESPACE === "1" ? {} : {
              evaluationCacheNamespace: ctx.env.NOISE_SHARED_NAMESPACE === "1" ? "eval-run-" + "1".repeat(64) : namespace,
            }),
            record: {
              capsuleId: ctx.admittedManifest.id,
              artifactHash: ctx.env.NOISE_WRONG_BASELINE === "1" ? ${JSON.stringify(fakeHash("a"))} : ${JSON.stringify(fakeHash("b"))},
              assetGroupId: ctx.config.noiseCalibration.assetGroupId,
              seed,
              output: {
                valid: true,
                objectives: { score: deterministic ? 0.5 + seed * 0.1 + (vary ? 0.001 : 0) : 0.5 + seed * 0.1 + (repeat % 2 === 0 ? 0.01 : -0.01) },
                constraints: {},
                perExample: { a: { score: ctx.env.NOISE_EXAMPLE_VARY === "1" && repeat === 1 ? 0.26 : 0.25 }, b: { score: 0.75 } },
              },
              costUsd: 0,
              durationMs: 1,
              cached: ctx.env.NOISE_MEMO === "1",
              evaluatedAt: new Date().toISOString(),
            },
            events: [],
          }));
          appendFileSync(join(ctx.runDir, "broker-state.ndjson"), lines.join("\\n") + "\\n");
        },
      };
    }
    `,
  );
  return "./noise-backend.mjs";
}

interface Start {
  runId: string;
  resumeCount: number;
  measurementEpoch: string | null;
  optimizerEpisodesMax: number | null;
}

function starts(root: string): Start[] {
  const path = join(root, "starts.ndjson");
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Start)
    : [];
}

const BASE_ENV = {
  HONE_UNSAFE_BACKEND: "1",
  HONE_KILL_GRACE_MS: "50",
  HONE_OPTIMIZER_CMD: "true",
  HONE_OPTIMIZER_DIGEST: fakeHash("0"),
};

describe("hone promotion-noise", () => {
  it("produces a sealed-epoch calibration a search run accepts, resuming an interrupted cohort without re-measuring", { timeout: 180_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const backend = noiseBackend(root);
    const args = ["capsule", "--epoch", EPOCH, "--out", "noise.json", "--headless", "--backend", backend];

    // Repeat 3 "dies" on its first start: the command stops and asks for a re-run.
    const interrupted = makeIo(root, { ...BASE_ENV, NOISE_PAUSE_SUFFIX: "_r3" });
    expect(await promotionNoiseCommand(args, interrupted.io)).toBe(1);
    expect(interrupted.err.join("\n")).toMatch(/repeat 4\/7\) is not finished; re-run this command to resume it/);
    expect(starts(root).map((start) => start.runId.slice(-3))).toEqual(["_r0", "_r1", "_r2", "_r3"]);
    expect(existsSync(join(root, "noise.json"))).toBe(false);

    // Re-run: finished repeats are reused, r3 resumes, r4..r6 start fresh.
    const resumed = makeIo(root, { ...BASE_ENV, NOISE_PAUSE_SUFFIX: "_r3" });
    expect(await promotionNoiseCommand(args, resumed.io)).toBe(0);
    const all = starts(root);
    expect(all.slice(4).map((start) => [start.runId.slice(-3), start.resumeCount])).toEqual([
      ["_r3", 1], ["_r4", 0], ["_r5", 0], ["_r6", 0],
    ]);
    for (const start of all) {
      expect(start.measurementEpoch).toBe(EPOCH);
      expect(start.optimizerEpisodesMax).toBeNull();
    }
    const runDir = join(root, ".hone-runs", all[0]?.runId ?? "");
    const sealed = RunConfig.parse(JSON.parse(readFileSync(join(runDir, "runconfig.json"), "utf8")));
    expect(sealed.noiseCalibration).toEqual({ measurementEpoch: EPOCH, assetGroupId: "train", seeds: [0, 1, 2] });
    expect(sealed.apply).toBe("none");
    expect(readFileSync(join(runDir, "contract.md"), "utf8")).toContain("## Noise calibration (sealed)");

    const calibration = PromotionNoiseCalibration.parse(JSON.parse(readFileSync(join(root, "noise.json"), "utf8")));
    expect(calibration).toMatchObject({
      capsuleId: CAP_ID,
      admittedCapsuleDigest: capsuleDigest(manifestObject()),
      executionImage: FIX_IMAGE,
      assetGroupId: "train",
      measurementEpoch: EPOCH,
      estimator: "pooled-within-coordinate-sd-v1",
      informationFreeMeasurements: 21,
    });
    expect(JSON.parse(resumed.out[resumed.out.length - 1] ?? "{}")).toMatchObject({ type: "promotion-noise.calibrated", measurementEpoch: EPOCH });

    // Idempotent: a third invocation measures nothing and reproduces the same file.
    const again = makeIo(root, BASE_ENV);
    const before = readFileSync(join(root, "noise.json"), "utf8");
    expect(await promotionNoiseCommand(args, again.io)).toBe(0);
    expect(starts(root)).toHaveLength(all.length);
    expect(readFileSync(join(root, "noise.json"), "utf8")).toBe(before);

    // The produced calibration seals into a search run in the same epoch.
    writeFileSync(join(root, "search.json"), JSON.stringify({ search: { episodes: 2, measurementEpoch: EPOCH } }));
    const search = makeIo(root, BASE_ENV);
    expect(await cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", "search.json", "--calibration", "noise.json"], search.io))
      .toBe(0);
    const searchRun = readdirSync(join(root, ".hone-runs")).filter((name) => name.startsWith("run_") && !name.startsWith("run_noise_"));
    expect(searchRun).toHaveLength(1);
    const searchConfig = RunConfig.parse(JSON.parse(readFileSync(join(root, ".hone-runs", searchRun[0] ?? "", "runconfig.json"), "utf8")));
    expect(searchConfig.search?.calibrations).toEqual([calibration]);
  });

  it("opts into three fresh identical baseline runs and a reusable zero-noise calibration", { timeout: 180_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const backend = noiseBackend(root);
    const { io } = makeIo(root, { ...BASE_ENV, NOISE_DETERMINISTIC: "1" });
    const args = ["capsule", "--epoch", EPOCH, "--out", "zero.json", "--headless", "--deterministic", "--backend", backend];
    expect(await promotionNoiseCommand(args, io)).toBe(0);
    const all = starts(root);
    expect(all).toHaveLength(3);
    const runDir = join(root, ".hone-runs", all[0]!.runId);
    const sealed = RunConfig.parse(JSON.parse(readFileSync(join(runDir, "runconfig.json"), "utf8")));
    expect(sealed.noiseCalibration?.seeds).toEqual([0]);
    const calibration = PromotionNoiseCalibration.parse(JSON.parse(readFileSync(join(root, "zero.json"), "utf8")));
    expect(calibration).toMatchObject({
      estimator: DETERMINISTIC_ZERO_NOISE_ESTIMATOR,
      baselineArtifactHash: fakeHash("b"),
      informationFreeMeasurements: 3, informationFreePairs: 3, informationFreePositive: 0,
      maxObservedPairDelta: 0, noiseFloor: 0, noiseEnvelope: 0,
    });
    if (calibration.estimator !== DETERMINISTIC_ZERO_NOISE_ESTIMATOR) throw new Error("unexpected estimator");
    expect(new Set(calibration.baselineRuns.map((run) => run.evaluationCacheNamespace)).size).toBe(3);
    expect(calibration.baselineRuns[0]?.scores).toEqual([{ seed: 0, aggregate: 0.5, perExample: { a: 0.25, b: 0.75 } }]);
    const before = readFileSync(join(root, "zero.json"), "utf8");
    expect(await promotionNoiseCommand(args, io)).toBe(0);
    expect(starts(root)).toHaveLength(3);
    expect(readFileSync(join(root, "zero.json"), "utf8")).toBe(before);

    // The pooled estimator must use separate runs even at the same seed/repeat
    // counts; opting in does not contaminate or alter the default plan.
    expect(await promotionNoiseCommand([
      "capsule", "--epoch", EPOCH, "--out", "zero-full.json", "--headless", "--deterministic",
      "--seeds", "3", "--repeats", "7", "--backend", backend,
    ], io)).toBe(0);
    const deterministicRunIds = new Set(starts(root).map((start) => start.runId));
    expect(await promotionNoiseCommand([
      "capsule", "--epoch", EPOCH, "--out", "pooled.json", "--headless", "--seeds", "3", "--repeats", "7", "--backend", backend,
    ], io)).toBe(0);
    const pooled = PromotionNoiseCalibration.parse(JSON.parse(readFileSync(join(root, "pooled.json"), "utf8")));
    expect(pooled).toMatchObject({ estimator: "pooled-within-coordinate-sd-v1", informationFreeMeasurements: 21 });
    expect(starts(root)).toHaveLength(17);
    expect(starts(root).slice(10).every((start) => !deterministicRunIds.has(start.runId))).toBe(true);

    writeFileSync(join(root, "search.json"), JSON.stringify({ search: { episodes: 2, measurementEpoch: EPOCH } }));
    expect(await cliRunCommand(["capsule", "--headless", "--backend", backend, "--config", "search.json", "--calibration", "zero.json"], io)).toBe(0);
    const searchRun = readdirSync(join(root, ".hone-runs")).find((name) => name.startsWith("run_") && !name.startsWith("run_noise_"));
    const searchConfig = RunConfig.parse(JSON.parse(readFileSync(join(root, ".hone-runs", searchRun!, "runconfig.json"), "utf8")));
    expect(searchConfig.search?.calibrations).toEqual([calibration]);
  });

  it.each([
    { name: "changed aggregate", env: { NOISE_VARY: "1" } },
    { name: "changed example despite identical aggregate", env: { NOISE_EXAMPLE_VARY: "1" } },
    { name: "wrong baseline in every run", env: { NOISE_WRONG_BASELINE: "1" } },
    { name: "missing cache namespace", env: { NOISE_MISSING_NAMESPACE: "1" } },
    { name: "shared cache namespace", env: { NOISE_SHARED_NAMESPACE: "1" } },
    { name: "memo hits", env: { NOISE_MEMO: "1" } },
  ])("refuses $name without publishing calibration or observations or switching estimator", { timeout: 90_000 }, async ({ env }) => {
    const root = makeRoot();
    makeCapsule(root);
    const backend = noiseBackend(root);
    const { io, out } = makeIo(root, { ...BASE_ENV, NOISE_DETERMINISTIC: "1", ...env });
    await expect(promotionNoiseCommand([
      "capsule", "--epoch", EPOCH, "--out", "zero.json", "--headless", "--deterministic", "--backend", backend,
    ], io)).rejects.toThrow(/full default 3 × 7/);
    expect(starts(root)).toHaveLength(3);
    expect(existsSync(join(root, "zero.json"))).toBe(false);
    for (const state of readdirSync(join(root, ".hone-runs")).filter((name) => name.startsWith("promotion-noise-"))) {
      expect(existsSync(join(root, ".hone-runs", state, "observations.json"))).toBe(false);
    }
    expect(out.some((line) => {
      try { return JSON.parse(line).type === "promotion-noise.calibrated"; } catch { return false; }
    })).toBe(false);
  });

  it("refuses cohorts below the calibration minimums and malformed epochs before any run", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const backend = noiseBackend(root);
    const { io } = makeIo(root, BASE_ENV);
    const base = ["capsule", "--out", "noise.json", "--headless", "--backend", backend];
    await expect(promotionNoiseCommand([...base, "--epoch", EPOCH, "--repeats", "6"], io)).rejects.toThrow(/below the calibration minimums/);
    await expect(promotionNoiseCommand([...base, "--epoch", EPOCH, "--seeds", "2", "--repeats", "20"], io)).rejects.toThrow(/below the calibration minimums/);
    await expect(promotionNoiseCommand([...base, "--epoch", EPOCH, "--deterministic", "--repeats", "2"], io)).rejects.toThrow(/at least 3 fresh baseline repeats/);
    // Fixture envelope: 100 evaluator invocations. 100 seeds would end the run as `budget`, never `completed`.
    await expect(promotionNoiseCommand([...base, "--epoch", EPOCH, "--seeds", "100", "--repeats", "3"], io))
      .rejects.toThrow(/needs more than 100 evaluator invocations to complete under its budget, but the run budget allows 100/);
    await expect(promotionNoiseCommand([...base, "--epoch", "bad\nepoch"], io)).rejects.toThrow(/--epoch/);
    await expect(promotionNoiseCommand(["capsule", "--out", "noise.json", "--headless"], io)).rejects.toThrow(/usage: hone promotion-noise/);
    expect(starts(root)).toEqual([]);
  });
});
