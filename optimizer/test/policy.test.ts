import { describe, expect, it } from "vitest";
import * as policy from "../assets/policy.js";

/**
 * The policy file is the documented tuning surface: exactly these constants,
 * nothing hidden elsewhere. A new strategy knob belongs HERE — update this
 * test when adding one.
 */

describe("assets/policy", () => {
  it("exports exactly the documented constants", () => {
    expect(Object.keys(policy).sort()).toEqual([
      "epsilonRestart",
      "maxFeedbackChars",
      "mutationTimeoutSec",
      "oneRepair",
      "trainAssetGroupId",
    ]);
  });

  it("holds the seed strategy values", () => {
    expect(policy.epsilonRestart).toBe(0.2);
    expect(policy.oneRepair).toBe(true);
    expect(policy.mutationTimeoutSec).toBe(1800);
    expect(policy.trainAssetGroupId).toBe("train");
    expect(policy.maxFeedbackChars).toBe(4000);
  });
});
