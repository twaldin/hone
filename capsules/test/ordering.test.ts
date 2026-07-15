import { describe, expect, it } from "vitest";
import { runOrderingCheck } from "../tools/ordering-check.js";

describe("seeded-astar diagnostic ordering", () => {
  it(
    "orders broken < naive < baseline < improved and proves split integrity",
    { timeout: 300_000 },
    () => {
      const report = runOrderingCheck();
      expect(report.failures).toEqual([]);

      // Redundant with report.failures, but keeps the invariants visible in
      // the test output when something regresses.
      const { broken, naive, baseline, improved, shortcut } = report.results;
      expect(broken.combined).toBeLessThan(naive.combined);
      expect(naive.combined).toBeLessThan(baseline.combined);
      expect(baseline.combined).toBeLessThan(improved.combined);
      expect(shortcut.train).toBeGreaterThan(baseline.train);
      expect(shortcut.validation).toBeLessThan(baseline.validation);
    },
  );
});
