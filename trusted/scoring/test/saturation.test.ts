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
