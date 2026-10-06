import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromotionNoiseCalibration, RunConfig, capsuleDigest } from "@hone/schema";
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
          const lines = ctx.config.noiseCalibration.seeds.map((seed) => JSON.stringify({
            t: "eval",
            measurementEpoch: ctx.measurementEpoch,
            record: {
              capsuleId: ctx.admittedManifest.id,
              artifactHash: ${JSON.stringify(fakeHash("b"))},
              assetGroupId: ctx.config.noiseCalibration.assetGroupId,
              seed,
              output: { valid: true, objectives: { score: 0.5 + seed * 0.1 + (repeat % 2 === 0 ? 0.01 : -0.01) }, constraints: {}, perExample: {} },
              costUsd: 0,
              durationMs: 1,
              cached: false,
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

  it("refuses cohorts below the calibration minimums and malformed epochs before any run", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const backend = noiseBackend(root);
    const { io } = makeIo(root, BASE_ENV);
    const base = ["capsule", "--out", "noise.json", "--headless", "--backend", backend];
    await expect(promotionNoiseCommand([...base, "--epoch", EPOCH, "--repeats", "6"], io)).rejects.toThrow(/below the calibration minimums/);
    await expect(promotionNoiseCommand([...base, "--epoch", EPOCH, "--seeds", "2", "--repeats", "20"], io)).rejects.toThrow(/below the calibration minimums/);
    // Fixture envelope: 100 evaluator invocations. 100 seeds would end the run as `budget`, never `completed`.
    await expect(promotionNoiseCommand([...base, "--epoch", EPOCH, "--seeds", "100", "--repeats", "3"], io))
      .rejects.toThrow(/needs more than 100 evaluator invocations to complete under its budget, but the run budget allows 100/);
    await expect(promotionNoiseCommand([...base, "--epoch", "bad\nepoch"], io)).rejects.toThrow(/--epoch/);
    await expect(promotionNoiseCommand(["capsule", "--out", "noise.json", "--headless"], io)).rejects.toThrow(/usage: hone promotion-noise/);
    expect(starts(root)).toEqual([]);
  });
});
