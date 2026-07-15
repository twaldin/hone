import { describe, expect, it } from "vitest";
import * as policy from "../assets/policy.js";

/**
 * Behavioral invariants for the tuning surface — NOT a snapshot. Strategy
 * values (and any new knobs hone adds) may legitimately mutate in M1; this
 * suite pins only the safety/resource rules the loop and trusted side rely
 * on: every documented knob exists and stays within its valid domain.
 */

describe("assets/policy", () => {
  it("keeps the ε-restart draw a valid probability", () => {
    expect(typeof policy.epsilonRestart).toBe("number");
    expect(policy.epsilonRestart).toBeGreaterThanOrEqual(0);
    expect(policy.epsilonRestart).toBeLessThanOrEqual(1);
  });

  it("keeps the repair grant a boolean", () => {
    expect(typeof policy.oneRepair).toBe("boolean");
  });

  it("bounds every mutation session with a positive finite timeout", () => {
    expect(Number.isFinite(policy.mutationTimeoutSec)).toBe(true);
    expect(policy.mutationTimeoutSec).toBeGreaterThan(0);
  });

  it("names a non-empty training asset group", () => {
    expect(typeof policy.trainAssetGroupId).toBe("string");
    expect(policy.trainAssetGroupId.length).toBeGreaterThan(0);
  });

  it("caps per-example feedback blobs with a positive integer bound", () => {
    expect(Number.isInteger(policy.maxFeedbackChars)).toBe(true);
    expect(policy.maxFeedbackChars).toBeGreaterThan(0);
  });
});
