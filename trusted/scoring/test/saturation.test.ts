import { describe, expect, it } from "vitest";
import {
  saturationCeilingReportJson,
  selectSaturationCeiling,
  type SaturationCell,
} from "../src/index.js";
import { runSaturationCli } from "../src/saturation-cli.js";

const CAPSULES = ["cal-a", "cal-b", "cal-c", "cal-d"] as const;
const SEEDS = [11, 22, 33, 44, 55] as const;
const BOOTSTRAP = { rngSeed: 0x1234abcd, bootstrapSamples: 200 } as const;

function cellsForDeltas(deltas: readonly [number, number, number]): SaturationCell[] {
  const cells: SaturationCell[] = [];
  for (const capsuleId of CAPSULES) {
    for (const seed of SEEDS) {
      const cap2 = 0;
      const cap4 = cap2 + deltas[0];
      const cap8 = cap4 + deltas[1];
      const cap12 = cap8 + deltas[2];
      cells.push(
        { capsuleId, cap: 2, seed, status: "valid", normalizedGain: cap2 },
        { capsuleId, cap: 4, seed, status: "valid", normalizedGain: cap4 },
        { capsuleId, cap: 8, seed, status: "valid", normalizedGain: cap8 },
        { capsuleId, cap: 12, seed, status: "valid", normalizedGain: cap12 },
      );
    }
  }
  return cells;
}

function cellsForFirstPairStrata(strata: readonly (readonly number[])[]): SaturationCell[] {
  const cells: SaturationCell[] = [];
  for (const [capsuleIndex, capsuleId] of CAPSULES.entries()) {
    for (const [seedIndex, seed] of SEEDS.entries()) {
      const delta = strata[capsuleIndex]?.[seedIndex];
      if (delta === undefined) throw new Error("test fixture must provide 4 capsule strata of 5 seeds");
      cells.push(
        { capsuleId, cap: 2, seed, status: "valid", normalizedGain: 0 },
        { capsuleId, cap: 4, seed, status: "valid", normalizedGain: delta },
        { capsuleId, cap: 8, seed, status: "valid", normalizedGain: delta + 0.03 },
        { capsuleId, cap: 12, seed, status: "valid", normalizedGain: delta + 0.06 },
      );
    }
  }
  return cells;
}

describe("calibrated inner safety ceiling", () => {
  it("selects 4 for a hand-computable fixture whose first marginal gain is 0.01", () => {
    const report = selectSaturationCeiling(cellsForDeltas([0.01, 0.04, 0.04]), BOOTSTRAP);

    expect(report.cells).toHaveLength(80);
    expect(report.deltas).toHaveLength(60);
    for (const [index, expected] of [0.01, 0.04, 0.04].entries()) {
      expect(report.comparisons[index]?.percentile75).toBeCloseTo(expected, 12);
      expect(report.comparisons[index]?.upperConfidenceBound90).toBeCloseTo(expected, 12);
    }
    expect(report.comparisons.map((comparison) => comparison.qualifies)).toEqual([true, false, false]);
    expect(report.selectedCeiling).toBe(4);
    expect(report.selectionReason).toBe("threshold");
  });

  it("selects 12 when only the 8-to-12 comparison qualifies", () => {
    const report = selectSaturationCeiling(cellsForDeltas([0.03, 0.03, 0.01]), BOOTSTRAP);

    expect(report.comparisons.map((comparison) => comparison.qualifies)).toEqual([false, false, true]);
    expect(report.selectedCeiling).toBe(12);
    expect(report.selectionReason).toBe("threshold");
  });

  it("falls back to 12 when no comparison qualifies", () => {
    const report = selectSaturationCeiling(cellsForDeltas([0.02, 0.03, 0.03]), BOOTSTRAP);

    expect(report.comparisons.every((comparison) => !comparison.qualifies)).toBe(true);
    expect(report.comparisons[0]?.upperConfidenceBound90).toBe(0.02);
    expect(report.selectedCeiling).toBe(12);
    expect(report.selectionReason).toBe("fallback");
  });

  it("assigns invalid deeper cells negative infinity, pushing the ceiling shallow-ward", () => {
    const complete = cellsForDeltas([0.03, 0.03, 0.03]);
    const withInvalidCap8 = complete.map<SaturationCell>((cell) => {
      if (cell.cap !== 8) return cell;
      return cell.seed < 40
        ? { capsuleId: cell.capsuleId, cap: cell.cap, seed: cell.seed, status: "incomplete" }
        : { capsuleId: cell.capsuleId, cap: cell.cap, seed: cell.seed, status: "invalid" };
    });

    const completeReport = selectSaturationCeiling(complete, BOOTSTRAP);
    const invalidReport = selectSaturationCeiling(withInvalidCap8, BOOTSTRAP);
    const cap8Deltas = invalidReport.deltas.filter((delta) => delta.lowerCap === 4 && delta.upperCap === 8);

    expect(completeReport.selectedCeiling).toBe(12);
    expect(cap8Deltas).toHaveLength(20);
    expect(cap8Deltas.every((delta) => delta.value === "negative-infinity" && delta.source === "invalid-deeper")).toBe(true);
    expect(new Set(cap8Deltas.map((delta) => delta.upperStatus))).toEqual(new Set(["invalid", "incomplete"]));
    expect(invalidReport.comparisons[1]?.percentile75).toBe("negative-infinity");
    expect(invalidReport.comparisons[1]?.upperConfidenceBound90).toBe("negative-infinity");
    expect(invalidReport.selectedCeiling).toBe(8);
  });

  it("never lets a deeper-cell failure increase the ceiling through the following pair", () => {
    const middleDeltas = [
      [0, 0.015, 0, 0.015, 0.015],
      [0.04, 0.015, 0.01, 0.019, 0.019],
      [0.04, 0.005, 0.005, 0.019, 0.019],
      [0.005, 0.005, 0.005, 0.005, 0.04],
    ] as const;
    const complete: SaturationCell[] = [];
    for (const [capsuleIndex, capsuleId] of CAPSULES.entries()) {
      for (const [seedIndex, seed] of SEEDS.entries()) {
        const cap4 = 0.03;
        const cap8 = cap4 + (middleDeltas[capsuleIndex]?.[seedIndex] ?? 0);
        complete.push(
          { capsuleId, cap: 2, seed, status: "valid", normalizedGain: 0 },
          { capsuleId, cap: 4, seed, status: "valid", normalizedGain: cap4 },
          { capsuleId, cap: 8, seed, status: "valid", normalizedGain: cap8 },
          { capsuleId, cap: 12, seed, status: "valid", normalizedGain: cap8 + 0.03 },
        );
      }
    }
    const oneInvalid = complete.map<SaturationCell>((cell) =>
      cell.capsuleId === "cal-a" && cell.cap === 4 && cell.seed === 11
        ? { capsuleId: cell.capsuleId, cap: cell.cap, seed: cell.seed, status: "invalid" }
        : cell,
    );

    expect(selectSaturationCeiling(complete, BOOTSTRAP).selectedCeiling).toBe(8);
    const invalidReport = selectSaturationCeiling(oneInvalid, BOOTSTRAP);
    const followingDelta = invalidReport.deltas.find(
      (delta) => delta.capsuleId === "cal-a" && delta.seed === 11 && delta.lowerCap === 4,
    );
    expect(followingDelta?.source).toBe("invalid-shallower");
    expect(followingDelta?.value).toBe("negative-infinity");
    expect(invalidReport.selectedCeiling).toBe(8);
  });

  it("resamples exactly five seeds within each capsule and uses the nearest-rank percentile", () => {
    const cells = cellsForFirstPairStrata([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0.04, 0.04, 0.04, 0.04, 0.04],
    ]);
    const report = selectSaturationCeiling(cells, { rngSeed: 7, bootstrapSamples: 50 });

    // Every stratified draw has exactly 15 zeros and 5 highs, so rank 15 is
    // always zero. Pooled resampling can draw >5 highs and produce UCB .04;
    // linear R7 interpolation would instead report observed p75 = .01.
    expect(report.comparisons[0]?.percentile75).toBe(0);
    expect(report.comparisons[0]?.upperConfidenceBound90).toBe(0);
    expect(report.bootstrap).toEqual({
      method: "stratified-seed-resampling-within-capsule",
      rng: "mulberry32-v1",
      rngSeed: 7,
      samples: 50,
    });
  });

  it("uses the explicit RNG seed for a seed-sensitive bootstrap distribution", () => {
    const cells = cellsForFirstPairStrata([
      [0.019, 0.019, 0.01, 0.021, 0.019],
      [0.03, 0, 0.019, 0.025, 0],
      [0.019, 0.025, 0.019, 0.005, 0.04],
      [0.015, 0.005, 0.015, 0, 0.015],
    ]);

    const seedOne = selectSaturationCeiling(cells, { rngSeed: 1, bootstrapSamples: 25 });
    const seedTwo = selectSaturationCeiling(cells, { rngSeed: 2, bootstrapSamples: 25 });
    expect(seedOne.comparisons[0]?.upperConfidenceBound90).toBe(0.021);
    expect(seedTwo.comparisons[0]?.upperConfidenceBound90).toBe(0.025);
  });

  it("takes the 90th, not 95th, nearest-rank bootstrap upper bound", () => {
    const cells = cellsForFirstPairStrata([
      [0.03, 0, 0.01, 0.01, 0],
      [0.01, 0, 0.01, 0.01, 0],
      [0.01, 0.01, 0, 0.04, 0.01],
      [0, 0.01, 0, 0.03, 0.01],
    ]);
    const report = selectSaturationCeiling(cells, { rngSeed: 0x1234abcd, bootstrapSamples: 20 });

    // The 20 bootstrap p75 statistics are eighteen .01 values and two .03
    // values: rank 18 (90%) is .01, while rank 19 (95%) would be .03.
    expect(report.comparisons[0]?.upperConfidenceBound90).toBe(0.01);
    expect(report.comparisons[0]?.qualifies).toBe(true);
  });

  it("round-trips the sentinel when both cells in a pair are non-valid", () => {
    const cells = cellsForDeltas([0.03, 0.03, 0.03]).map<SaturationCell>((cell) => {
      if (cell.capsuleId !== "cal-a" || cell.seed !== 11) return cell;
      if (cell.cap === 4) return { capsuleId: cell.capsuleId, cap: cell.cap, seed: cell.seed, status: "invalid" };
      if (cell.cap === 8) return { capsuleId: cell.capsuleId, cap: cell.cap, seed: cell.seed, status: "incomplete" };
      return cell;
    });
    const report = selectSaturationCeiling(cells, BOOTSTRAP);
    const bothInvalid = report.deltas.find(
      (delta) => delta.capsuleId === "cal-a" && delta.seed === 11 && delta.lowerCap === 4,
    );

    expect(bothInvalid).toMatchObject({
      lowerStatus: "invalid",
      upperStatus: "incomplete",
      value: "negative-infinity",
      source: "invalid-deeper",
    });
    const json = saturationCeilingReportJson(cells, BOOTSTRAP);
    expect(JSON.parse(json)).toEqual(report);
    expect(json).toContain('"value": "negative-infinity"');
    expect(json).not.toContain('"value": null');
  });

  it("rejects incomplete direct input and malformed CLI input", () => {
    const cells = cellsForDeltas([0.01, 0.03, 0.04]);
    expect(() => selectSaturationCeiling(cells.slice(1), BOOTSTRAP)).toThrow(/exactly 80 cells/);
    const nonFinite = cells.map<SaturationCell>((cell, index) =>
      index === 0 && cell.status === "valid" ? { ...cell, normalizedGain: Number.NaN } : cell,
    );
    expect(() => selectSaturationCeiling(nonFinite, BOOTSTRAP)).toThrow(/must be finite/);

    const malformed = JSON.stringify({ cells, ...BOOTSTRAP }).replace('"status":"valid"', '"status":"broken"');
    const stderr: string[] = [];
    const exitCode = runSaturationCli([], {
      read: () => malformed,
      out: () => undefined,
      err: (text) => stderr.push(text),
    });
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toMatch(/status must be valid, invalid, or incomplete/);
  });

  it("emits byte-identical, canonically ordered reports for the same seed", () => {
    const cells = cellsForDeltas([0.01, 0.03, 0.04]).map<SaturationCell>((cell, index) =>
      cell.status === "valid" ? { ...cell, normalizedGain: cell.normalizedGain + (index % 5) * 0.001 } : cell,
    );

    const first = saturationCeilingReportJson(cells, BOOTSTRAP);
    const second = saturationCeilingReportJson([...cells].reverse(), BOOTSTRAP);

    expect(second).toBe(first);
  });

  it("provides a CLI-callable JSON-in/JSON-out entry", () => {
    const input = JSON.stringify({ cells: cellsForDeltas([0.01, 0.04, 0.04]), ...BOOTSTRAP });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = runSaturationCli([], {
      read: () => input,
      out: (text) => stdout.push(text),
      err: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toEqual([`${saturationCeilingReportJson(cellsForDeltas([0.01, 0.04, 0.04]), BOOTSTRAP)}\n`]);
  });
});
