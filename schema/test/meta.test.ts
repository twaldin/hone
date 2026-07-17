import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  M1_ALLOWED_CLAIM,
  M1_CONFIRMATION_ARMS,
  M1_HOLDOUT_ARMS,
  M1_HOLDOUT_CAPSULE_COUNT,
  M1_MODEL_ROUTE,
  M1_TRAIN_CAPSULE_COUNT,
  MetaCampaignConfigV1,
} from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
// Untyped on purpose (same convention as conformance.test.ts): rejection tests
// mutate the raw JSON, including mutations the inferred type forbids.
const load = () =>
  JSON.parse(readFileSync(join(fixtures, "meta-campaign.m1.json"), "utf8"));

const FIXTURE: MetaCampaignConfigV1 = MetaCampaignConfigV1.parse(load());

/** Fresh raw config per test; every rejection starts from a green fixture. */
const cfg = () => load();

const reject = (mutated: unknown, label: string) =>
  expect(() => MetaCampaignConfigV1.parse(mutated), label).toThrow();

describe("contract 6: MetaCampaignConfigV1 — valid fixture", () => {
  it("parses the frozen M1 fixture", () => {
    expect(FIXTURE.version).toBe(1);
    expect(FIXTURE.train).toHaveLength(M1_TRAIN_CAPSULE_COUNT);
    expect(FIXTURE.holdout).toHaveLength(M1_HOLDOUT_CAPSULE_COUNT);
    // The frozen count is total unique artifacts and includes the seed arm.
    expect(FIXTURE.counts.candidates).toBe(20);
    expect(FIXTURE.counts.candidateAttemptsMax).toBe(40);
    expect(FIXTURE.seedOptimizer.sourceArtifact).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(FIXTURE.controls.brokenSourceArtifact).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(FIXTURE.controls.brokenBundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(FIXTURE.allowedClaim).toBe(M1_ALLOWED_CLAIM);
    expect(FIXTURE.counts.innerEpisodesMax).toBe(8);
    expect(FIXTURE.routing.outerMutation).toBe(M1_MODEL_ROUTE);
    expect(FIXTURE.routing.innerMutation).toBe(M1_MODEL_ROUTE);
    expect(FIXTURE.modelObservation.identity).toBe("alias-observation");
    expect(FIXTURE.invariants.apply).toBe("none");
  });

  it("round-trips every registered artifact identity and count", () => {
    const roundTripped = MetaCampaignConfigV1.parse(JSON.parse(JSON.stringify(FIXTURE)));
    expect(roundTripped).toEqual(FIXTURE);
    expect(roundTripped.seedOptimizer).toEqual({
      sourceCommit: FIXTURE.seedOptimizer.sourceCommit,
      sourceArtifact: FIXTURE.seedOptimizer.sourceArtifact,
      bundleDigest: FIXTURE.seedOptimizer.bundleDigest,
    });
    expect(roundTripped.controls).toEqual(FIXTURE.controls);
    expect(roundTripped.counts).toEqual(FIXTURE.counts);
  });
});

describe("corpus cardinality and uniqueness", () => {
  it("rejects a 3-train config", () => {
    const c = cfg();
    c.train = c.train.slice(0, 3);
    reject(c, "3 train capsules");
  });

  it("rejects a 6-train / 1-holdout config", () => {
    const c = cfg();
    c.train.push(c.holdout.shift());
    reject(c, "6 train / 1 holdout");
  });

  it("rejects a duplicate capsule digest within train", () => {
    const c = cfg();
    c.train[1].capsuleDigest = c.train[0].capsuleDigest;
    reject(c, "duplicate train digest");
  });

  it("rejects the same capsule digest appearing in train AND holdout", () => {
    const c = cfg();
    c.holdout[0].capsuleDigest = c.train[0].capsuleDigest;
    reject(c, "cross-partition duplicate digest");
  });

  it("rejects a duplicate capsule id across partitions", () => {
    const c = cfg();
    c.holdout[1].capsuleId = c.train[2].capsuleId;
    reject(c, "duplicate capsule id");
  });

  it("rejects an unpinned (tag-mutable) capsule image", () => {
    const c = cfg();
    c.train[0].image = "hone-task:latest";
    reject(c, "mutable image tag");
  });
});

describe("normalization: q registration and scale", () => {
  it.each(["qFail", "qBase", "qReference"] as const)(
    "rejects %s outside the closed [0,1] interval",
    (field) => {
      for (const value of [-0.01, 1.01]) {
        const c = cfg();
        c.train[0][field] = value;
        reject(c, `${field}=${value}`);
      }
    },
  );

  it("rejects qFail greater than qBase", () => {
    const c = cfg();
    c.train[0].qFail = c.train[0].qBase + 0.01;
    reject(c, "qFail > qBase");
  });

  it("rejects a zero scale", () => {
    const c = cfg();
    c.train[0].scale = 0;
    reject(c, "zero scale");
  });

  it("rejects a negative scale", () => {
    const c = cfg();
    c.train[0].scale = -0.5;
    reject(c, "negative scale");
  });

  it("rejects a nonpositive reference gap (qReference <= qBase)", () => {
    const c = cfg();
    c.train[2].qReference = c.train[2].qBase;
    reject(c, "qReference == qBase");
    const d = cfg();
    d.train[2].qReference = d.train[2].qBase - 0.1;
    d.train[2].scale = 0.1; // positive on its own, but the gap is negative
    reject(d, "qReference < qBase");
  });

  it("rejects a registered scale that mismatches qReference - qBase", () => {
    const c = cfg();
    c.holdout[0].scale = c.holdout[0].qReference - c.holdout[0].qBase + 0.25;
    reject(c, "mismatched scale");
  });
});

describe("optimizer artifact identity", () => {
  it("rejects a seed optimizer without its canonical source artifact", () => {
    const c = cfg();
    delete c.seedOptimizer.sourceArtifact;
    reject(c, "missing seed source artifact");
  });

  it.each([
    "brokenSourceArtifact",
    "brokenBundleDigest",
    "degradedSourceArtifact",
    "degradedBundleDigest",
  ] as const)("rejects a control missing %s", (field) => {
    const c = cfg();
    delete c.controls[field];
    reject(c, `missing ${field}`);
  });

  it("rejects legacy control digest aliases even when exact pairs are present", () => {
    const c = cfg();
    c.controls.brokenOptimizerDigest = c.controls.brokenBundleDigest;
    c.controls.degradedOptimizerDigest = c.controls.degradedBundleDigest;
    reject(c, "legacy optimizer digest aliases");
  });
});

describe("negative controls", () => {
  it("rejects broken and degraded controls with the same source artifact", () => {
    const c = cfg();
    c.controls.degradedSourceArtifact = c.controls.brokenSourceArtifact;
    reject(c, "broken source == degraded source");
  });

  it("rejects broken and degraded controls with the same bundle digest", () => {
    const c = cfg();
    c.controls.degradedBundleDigest = c.controls.brokenBundleDigest;
    reject(c, "broken bundle == degraded bundle");
  });

  it("rejects a control source artifact that is the seed optimizer source", () => {
    const c = cfg();
    c.controls.brokenSourceArtifact = c.seedOptimizer.sourceArtifact;
    reject(c, "control source == seed source");
  });

  it("rejects a control bundle that is the seed optimizer bundle", () => {
    const c = cfg();
    c.controls.brokenBundleDigest = c.seedOptimizer.bundleDigest;
    reject(c, "control bundle == seed bundle");
  });
});

describe("campaign counts", () => {
  it("rejects candidate counts outside the written 20-30 range", () => {
    for (const n of [0, 19, 31]) {
      const c = cfg();
      c.counts.candidates = n;
      reject(c, `candidates=${n}`);
    }
  });

  it("requires the separately bounded non-seed mutation-attempt cap", () => {
    const c = cfg();
    delete c.counts.candidateAttemptsMax;
    reject(c, "missing candidateAttemptsMax");
  });

  it("rejects fewer attempt slots than candidates minus the seed", () => {
    for (const n of [0, 18]) {
      const c = cfg();
      c.counts.candidateAttemptsMax = n;
      reject(c, `candidateAttemptsMax=${n}`);
    }
  });

  it("accepts the lower attempt bound of candidates minus the seed", () => {
    const c = cfg();
    c.counts.candidateAttemptsMax = c.counts.candidates - 1;
    expect(MetaCampaignConfigV1.parse(c).counts.candidateAttemptsMax).toBe(19);
  });

  it("accepts the upper attempt bound of four times candidates", () => {
    const c = cfg();
    c.counts.candidateAttemptsMax = 4 * c.counts.candidates;
    expect(MetaCampaignConfigV1.parse(c).counts.candidateAttemptsMax).toBe(80);
  });

  it("rejects an attempt cap above four times candidates", () => {
    const c = cfg();
    c.counts.candidateAttemptsMax = 4 * c.counts.candidates + 1;
    reject(c, "candidateAttemptsMax > 4*candidates");
  });

  it("rejects a fractional mutation-attempt cap", () => {
    const c = cfg();
    c.counts.candidateAttemptsMax = 39.5;
    reject(c, "fractional candidateAttemptsMax");
  });

  it("rejects inner episode caps outside the written 8-12 range", () => {
    for (const n of [0, 7, 13]) {
      const c = cfg();
      c.counts.innerEpisodesMax = n;
      reject(c, `innerEpisodesMax=${n}`);
    }
  });

  it("rejects non-frozen replicate counts", () => {
    const a = cfg();
    a.counts.searchReplicates = 3;
    reject(a, "searchReplicates=3");
    const b = cfg();
    b.counts.confirmationReplicates = 1;
    reject(b, "confirmationReplicates=1");
    const d = cfg();
    d.counts.holdoutReplicates = 0;
    reject(d, "holdoutReplicates=0");
  });

  it("rejects nonpositive child concurrency", () => {
    const c = cfg();
    c.counts.childConcurrency = 0;
    reject(c, "childConcurrency=0");
  });
});

describe("M1 invariants: delivery and terminal holdout", () => {
  it("rejects non-none delivery", () => {
    for (const mode of ["branch", "pr", "auto"]) {
      const c = cfg();
      c.invariants.apply = mode;
      reject(c, `apply=${mode}`);
    }
  });

  it("rejects holdout feedback reaching the outer optimizer", () => {
    const c = cfg();
    c.invariants.holdoutFeedbackToOptimizer = true;
    reject(c, "holdout feedback");
  });

  it("rejects holdout capsules being search-eligible", () => {
    const c = cfg();
    c.invariants.holdoutSearchEligible = true;
    reject(c, "holdout in search coordinates");
  });

  it("rejects more than one terminal holdout phase", () => {
    const c = cfg();
    c.invariants.terminalHoldoutPhases = 2;
    reject(c, "two holdout phases");
  });
});

describe("mutable path allowlist vs protected surface", () => {
  it("rejects a mutable path that IS a protected path", () => {
    const c = cfg();
    c.mutablePaths.push("optimizer/src/broker-client.ts");
    reject(c, "exact protected overlap");
  });

  it("rejects a mutable path nested under a protected directory", () => {
    const c = cfg();
    c.mutablePaths.push("schema/src/meta.ts");
    reject(c, "mutable inside protected");
  });

  it("rejects a mutable directory that contains a protected path", () => {
    const c = cfg();
    c.mutablePaths.push("optimizer");
    reject(c, "protected inside mutable");
  });
});

describe("routing and model observation", () => {
  it("rejects a mutation role routed off the observed route", () => {
    const c = cfg();
    c.routing.innerMutation = "gpt-5.6-terra";
    reject(c, "inner route mismatch");
    const d = cfg();
    d.routing.outerMutation = "glm-5.2";
    reject(d, "outer route mismatch");
  });
  it("rejects a different requested route even when both mutation roles match it", () => {
    const c = cfg();
    c.modelObservation.requestedRoute = "gpt-5.6-terra";
    c.routing.outerMutation = "gpt-5.6-terra";
    c.routing.innerMutation = "gpt-5.6-terra";
    reject(c, "requested route is not the frozen M1 route");
  });


  it("rejects a policy that skips the drift sentinel", () => {
    const c = cfg();
    c.modelObservation.driftSentinel = false;
    reject(c, "no drift sentinel");
  });
});

describe("claim boundary", () => {
  it("rejects any claim other than the frozen-corpus directional claim", () => {
    const c = cfg();
    c.allowedClaim = "directional-reversible";
    reject(c, "claim exceeds or changes the frozen boundary");
  });
});

describe("componentwise campaign budget reservation", () => {
  const dims = ["maxTokens", "maxUsd", "maxWallClockSec", "maxEvaluatorInvocations"] as const;

  it("fixture reservation equals search + 4-arm confirmation + 2-arm holdout + outer", () => {
    const c = FIXTURE;
    const childRuns =
      c.counts.candidates * M1_TRAIN_CAPSULE_COUNT * c.counts.searchReplicates +
      M1_CONFIRMATION_ARMS * M1_TRAIN_CAPSULE_COUNT * c.counts.confirmationReplicates +
      M1_HOLDOUT_ARMS * M1_HOLDOUT_CAPSULE_COUNT * c.counts.holdoutReplicates;
    expect(childRuns).toBe(172);
    for (const dim of dims) {
      expect(c.budgets.campaign[dim]).toBe(c.budgets.child[dim] * childRuns + c.budgets.outer[dim]);
    }
  });

  for (const dim of dims) {
    it(`rejects a campaign ${dim} one unit under the reservation`, () => {
      const c = cfg();
      c.budgets.campaign[dim] -= dim === "maxUsd" ? 0.01 : 1;
      reject(c, `under-reserved ${dim}`);
    });
  }

  it("rejects a raised candidate count without a matching reservation raise", () => {
    const c = cfg();
    c.counts.candidates = 30; // +50 child runs, budgets unchanged
    reject(c, "candidates=30 without budget");
  });
});
