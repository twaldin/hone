import { describe, expect, it } from "vitest";
import { resolveStabilityRuns } from "../tools/ordering-check.js";

describe("ordering stability evidence options", () => {
  it("uses three passes by default and accepts an explicit larger sample", () => {
    expect(resolveStabilityRuns([])).toBe(3);
    expect(resolveStabilityRuns(["--stability-runs", "5"])).toBe(5);
  });

  it("rejects missing, repeated, fractional, and undersized samples", () => {
    expect(() => resolveStabilityRuns(["--stability-runs"])).toThrow(
      "--stability-runs requires a value",
    );
    expect(() =>
      resolveStabilityRuns(["--stability-runs", "5", "--stability-runs", "6"]),
    ).toThrow("--stability-runs may be specified only once");
    expect(() => resolveStabilityRuns(["--stability-runs", "3.5"])).toThrow(
      "safe integer >= 3",
    );
    expect(() => resolveStabilityRuns(["--stability-runs", "2"])).toThrow(
      "safe integer >= 3",
    );
  });
});
