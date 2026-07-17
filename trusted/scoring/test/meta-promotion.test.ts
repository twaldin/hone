import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MetaCampaignConfigV1 } from "@hone/schema";
import { describe, expect, it } from "vitest";
import {
  finalizeMetaHoldout,
  selectMetaTrainWinner,
  type MetaMeasurementEpochs,
  type MetaOptimizerIdentity,
  type MetaPromotionIdentity,
  type MetaSha256Digest,
  type MetaTrainWinnerSelection,
  type TrustedMetaMeasurementRow,
} from "../src/meta-promotion.js";
import type { MetaControlAuthentications, MetaControlSourceSeal } from "../src/meta-promotion.js";

const config = MetaCampaignConfigV1.parse(JSON.parse(readFileSync(new URL("../../../schema/fixtures/meta-campaign.m1.json", import.meta.url), "utf8")));

function digest(value: string): MetaSha256Digest {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error("test fixture digest is invalid");
  return `sha256:${value.slice("sha256:".length)}`;
}

function optimizerIdentity(sourceArtifact: string, bundleDigest: string): MetaOptimizerIdentity {
  return { sourceArtifact: digest(sourceArtifact), bundleDigest: digest(bundleDigest) };
}
const candidate: MetaOptimizerIdentity = {
  sourceArtifact: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  bundleDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};
const identity: MetaPromotionIdentity = {
  configHash: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
  protocolHash: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
  analysisConfigHash: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
  requestedModel: "gpt-5.6-sol",
  responseModel: "gpt-5.6-sol-2026-07-01",
  providerFingerprint: "fp_m1",
  modelDriftSentinel: "sentinel-stable",
};
const sourceFileHash: MetaSha256Digest = "sha256:6666666666666666666666666666666666666666666666666666666666666666";
const controlSourceSeal: MetaControlSourceSeal = {
  version: 1,
  files: [{ path: "src/main.ts", sha256: sourceFileHash, mode: 0o644 }],
};
const controlSourceSealHash: MetaSha256Digest =
  `sha256:${createHash("sha256").update(JSON.stringify(controlSourceSeal), "utf8").digest("hex")}`;
const controlAuthentications: MetaControlAuthentications = {
  broken: {
    ...optimizerIdentity(config.controls.brokenSourceArtifact, config.controls.brokenBundleDigest),
    sourceSeal: controlSourceSeal,
    receipt: {
      version: 1,
      kind: "broken",
      transformation: "broken-no-candidate-v1",
      sourceSealHash: controlSourceSealHash,
      artifactDigest: digest(config.controls.brokenSourceArtifact),
      files: 1,
      transformedFiles: [{
        path: "src/main.ts",
        beforeSha256: sourceFileHash,
        afterSha256: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
        mode: 0o644,
      }],
    },
  },
  degraded: {
    ...optimizerIdentity(config.controls.degradedSourceArtifact, config.controls.degradedBundleDigest),
    sourceSeal: controlSourceSeal,
    receipt: {
      version: 1,
      kind: "degraded",
      transformation: "degraded-blind-restart-v1",
      sourceSealHash: controlSourceSealHash,
      artifactDigest: digest(config.controls.degradedSourceArtifact),
      files: 1,
      transformedFiles: [{
        path: "src/main.ts",
        beforeSha256: sourceFileHash,
        afterSha256: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
        mode: 0o644,
      }],
    },
  },
};

function epochsFor(phase: "confirmation" | "holdout"): MetaMeasurementEpochs {
  const entries = (phase === "confirmation" ? config.train : config.holdout).map((capsule) => [
    capsule.capsuleId,
    Array.from({ length: 3 }, (_, replicate) => `${config.measurementEpochNamespace}:${phase}:${capsule.capsuleId}:${replicate}`),
  ] as const);
  return { byCapsule: Object.fromEntries(entries) };
}

function measurement(
  phase: "confirmation" | "holdout",
  arm: "seed" | "winner" | "broken-control" | "degraded-control",
  capsuleIndex: number,
  replicate: number,
  normalized: number,
): TrustedMetaMeasurementRow {
  const capsules = phase === "confirmation" ? config.train : config.holdout;
  const capsule = capsules[capsuleIndex];
  if (capsule === undefined) throw new Error("test capsule index out of range");
  const identityByArm: Record<typeof arm, MetaOptimizerIdentity> = {
    seed: optimizerIdentity(config.seedOptimizer.sourceArtifact, config.seedOptimizer.bundleDigest),
    winner: candidate,
    "broken-control": optimizerIdentity(
      config.controls.brokenSourceArtifact,
      config.controls.brokenBundleDigest,
    ),
    "degraded-control": optimizerIdentity(
      config.controls.degradedSourceArtifact,
      config.controls.degradedBundleDigest,
    ),
  };
  const optimizer = identityByArm[arm];
  if (![optimizer.sourceArtifact, optimizer.bundleDigest, capsule.capsuleDigest].every((digest) => /^sha256:[0-9a-f]{64}$/.test(digest))) {
    throw new Error("fixture digest is invalid");
  }
  const capsuleIdentity: MetaSha256Digest = `sha256:${capsule.capsuleDigest.slice("sha256:".length)}`;
  return {
    ...identity,
    phase,
    arm,
    sourceArtifact: optimizer.sourceArtifact,
    bundleDigest: optimizer.bundleDigest,
    capsuleId: capsule.capsuleId,
    capsuleDigest: capsuleIdentity,
    replicate,
    measurementEpoch: epochsFor(phase).byCapsule[capsule.capsuleId]?.[replicate] ?? "",
    qRaw: capsule.qBase + normalized * capsule.scale,
    qBase: capsule.qBase,
    scale: capsule.scale,
    qNormalized: normalized,
  };
}

function confirmationRows(
  winnerDeltas: readonly (number | readonly number[])[],
  broken = -1,
  degraded = -0.5,
): TrustedMetaMeasurementRow[] {
  const rows: TrustedMetaMeasurementRow[] = [];
  for (let capsule = 0; capsule < 5; capsule += 1) {
    const capsuleDeltas = winnerDeltas[capsule];
    if (capsuleDeltas === undefined) throw new Error("test winner delta missing");
    for (let replicate = 0; replicate < 3; replicate += 1) {
      const delta = typeof capsuleDeltas === "number" ? capsuleDeltas : capsuleDeltas[replicate];
      if (delta === undefined) throw new Error("test replicate delta missing");
      rows.push(
        measurement("confirmation", "seed", capsule, replicate, 0),
        measurement("confirmation", "winner", capsule, replicate, delta),
        measurement("confirmation", "broken-control", capsule, replicate, broken),
        measurement("confirmation", "degraded-control", capsule, replicate, degraded),
      );
    }
  }
  return rows;
}

function select(
  rows: readonly TrustedMetaMeasurementRow[],
  controls: MetaControlAuthentications = controlAuthentications,
): MetaTrainWinnerSelection {
  return selectMetaTrainWinner({ config, identity, candidate, controlAuthentications: controls, epochs: epochsFor("confirmation"), rows });
}

function selected(): MetaTrainWinnerSelection {
  const result = select(confirmationRows([1, 1, 1, 1, -0.1]));
  if (result.status !== "selected") throw new Error(`test setup did not select: ${JSON.stringify(result.reasons)}`);
  return result;
}

function holdoutRows(deltas: readonly number[]): TrustedMetaMeasurementRow[] {
  const rows: TrustedMetaMeasurementRow[] = [];
  for (let capsule = 0; capsule < 2; capsule += 1) {
    const delta = deltas[capsule];
    if (delta === undefined) throw new Error("test holdout delta missing");
    for (let replicate = 0; replicate < 3; replicate += 1) {
      rows.push(measurement("holdout", "seed", capsule, replicate, 0), measurement("holdout", "winner", capsule, replicate, delta));
    }
  }
  return rows;
}

describe("selectMetaTrainWinner", () => {
  it("selects a winner with exactly 4/5 positive train capsule means and 60 paired four-arm rows", () => {
    const result = select(confirmationRows([1, 1, 1, 1, -0.1]));
    expect(result.status).toBe("selected");
    expect(result.statistics?.positiveCapsules).toBe(4);
    expect(result.statistics?.pairedRows).toBe(15);
    expect(result.selectedWinner).toEqual(candidate);
  });

  it("rejects 3/5 positive capsules", () => {
    const result = select(confirmationRows([1, 1, 1, -0.1, -0.1]));
    expect(result.status).toBe("rejected");
    expect(result.reasons.map((reason) => reason.code)).toContain("insufficient-positive-capsules");
  });

  it("enforces the registered sign-consistency and standardized-delta gates independently", () => {
    const signFailure = select(confirmationRows(Array.from({ length: 5 }, () => [1, 1, -0.1])));
    expect(signFailure.reasons.map((reason) => reason.code)).toContain("insufficient-sign-consistency");

    const deltaFailure = select(confirmationRows([0.1, 0.1, 0.1, 0.1, [0.01, -0.5, -0.5]]));
    expect(deltaFailure.statistics?.positiveCapsules).toBe(4);
    expect(deltaFailure.reasons.map((reason) => reason.code)).toContain("insufficient-standardized-delta");
  });

  it("requires both real negative controls to rank strictly below the paired seed", () => {
    const brokenFailure = select(confirmationRows([1, 1, 1, 1, -0.1], 0, -0.5));
    expect(brokenFailure.reasons.map((reason) => reason.code)).toContain("broken-control-not-below-seed");
    const degradedFailure = select(confirmationRows([1, 1, 1, 1, -0.1], -1, 0.1));
    expect(degradedFailure.reasons.map((reason) => reason.code)).toContain("degraded-control-not-below-seed");
  });

  it("rejects config, model, epoch, capsule, candidate, and replicate identity mismatches", () => {
    const mutators: Array<{ code: string; change: (row: TrustedMetaMeasurementRow) => TrustedMetaMeasurementRow }> = [
      { code: "identity-mismatch", change: (row) => ({ ...row, configHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) },
      { code: "model-identity-mismatch", change: (row) => ({ ...row, responseModel: "drifted-model" }) },
      { code: "model-identity-mismatch", change: (row) => ({ ...row, modelDriftSentinel: "other-campaign-sentinel" }) },
      { code: "measurement-epoch-mismatch", change: (row) => ({ ...row, measurementEpoch: "wrong-epoch" }) },
      { code: "capsule-identity-mismatch", change: (row) => ({ ...row, capsuleDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }) },
      { code: "optimizer-identity-mismatch", change: (row) => ({ ...row, bundleDigest: "sha256:fafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafa" }) },
      { code: "replicate-identity-mismatch", change: (row) => ({ ...row, replicate: 3 }) },
    ];
    for (const { code, change } of mutators) {
      const rows = confirmationRows([1, 1, 1, 1, -0.1]);
      const first = rows[0];
      if (first === undefined) throw new Error("test row missing");
      rows[0] = change(first);
      expect(select(rows).reasons.map((reason) => reason.code), code).toContain(code);
    }
  });

  it("rejects cross-domain digest substitution and a swapped source with the claimed bundle", () => {
    const crossDomain = confirmationRows([1, 1, 1, 1, -0.1]);
    const seed = crossDomain[0];
    if (seed === undefined) throw new Error("test seed row missing");
    crossDomain[0] = { ...seed, sourceArtifact: seed.bundleDigest, bundleDigest: seed.sourceArtifact };
    expect(select(crossDomain).reasons.map((reason) => reason.code)).toContain("optimizer-identity-mismatch");

    const swappedSource = confirmationRows([1, 1, 1, 1, -0.1]);
    const broken = swappedSource[2];
    if (broken === undefined) throw new Error("test control row missing");
    swappedSource[2] = { ...broken, sourceArtifact: digest(config.controls.degradedSourceArtifact) };
    expect(select(swappedSource).reasons.map((reason) => reason.code)).toContain("optimizer-identity-mismatch");
  });

  it("rejects a control whose receipt does not authenticate its registered source", () => {
    const controls: MetaControlAuthentications = {
      ...controlAuthentications,
      broken: {
        ...controlAuthentications.broken,
        receipt: {
          ...controlAuthentications.broken.receipt,
          artifactDigest: digest(config.controls.degradedSourceArtifact),
        },
      },
    };
    expect(select(confirmationRows([1, 1, 1, 1, -0.1]), controls).reasons.map((reason) => reason.code)).toContain(
      "control-authentication-mismatch",
    );
  });

  it("rejects missing, duplicate, nonfinite, and incorrectly normalized rows", () => {
    const missing = confirmationRows([1, 1, 1, 1, -0.1]);
    missing.pop();
    expect(select(missing).reasons.map((reason) => reason.code)).toContain("missing-row");

    const duplicate = confirmationRows([1, 1, 1, 1, -0.1]);
    const duplicateRow = duplicate[0];
    if (duplicateRow === undefined) throw new Error("test row missing");
    duplicate.push(duplicateRow);
    expect(select(duplicate).reasons.map((reason) => reason.code)).toContain("duplicate-row");

    const nonfinite = confirmationRows([1, 1, 1, 1, -0.1]);
    const finiteRow = nonfinite[1];
    if (finiteRow === undefined) throw new Error("test row missing");
    nonfinite[1] = { ...finiteRow, qNormalized: Number.NaN };
    expect(select(nonfinite).reasons.map((reason) => reason.code)).toContain("nonfinite-row");

    const misnormalized = confirmationRows([1, 1, 1, 1, -0.1]);
    const normalizedRow = misnormalized[1];
    if (normalizedRow === undefined) throw new Error("test row missing");
    misnormalized[1] = { ...normalizedRow, qNormalized: normalizedRow.qNormalized + 0.01 };
    expect(select(misnormalized).reasons.map((reason) => reason.code)).toContain("normalization-mismatch");
  });

  it("does not dereference a holdout score during train selection", () => {
    const rows = confirmationRows([1, 1, 1, 1, -0.1]);
    const base = rows[0];
    if (base === undefined) throw new Error("test row missing");
    const poison: TrustedMetaMeasurementRow = { ...base, phase: "holdout" };
    Object.defineProperty(poison, "qNormalized", {
      enumerable: true,
      get(): number {
        throw new Error("holdout score was observed");
      },
    });
    expect(() => select([...rows, poison])).not.toThrow();
  });
});

describe("finalizeMetaHoldout", () => {
  it("promotes only the exact selected source and bundle after 2 holdouts × 3 paired replicates", () => {
    const result = finalizeMetaHoldout({
      config,
      identity,
      selectedWinner: candidate,
      selection: selected(),
      epochs: epochsFor("holdout"),
      rows: holdoutRows([0.1, 0]),
    });
    expect(result).toMatchObject({ decision: "promote", selectedWinner: candidate, reasons: [], statistics: { pairedRows: 6 } });
    expect(result.claim).toBe("No observed regression on these two frozen capsules under this exact protocol.");
  });

  it("rejects missing and observed-regressing holdout evidence with bounded reasons", () => {
    const missing = holdoutRows([0.1, 0.1]);
    missing.pop();
    const missingResult = finalizeMetaHoldout({ config, identity, selectedWinner: candidate, selection: selected(), epochs: epochsFor("holdout"), rows: missing });
    expect(missingResult.decision).toBe("reject");
    expect(missingResult.reasons.map((reason) => reason.code)).toContain("missing-row");

    const regression = finalizeMetaHoldout({
      config,
      identity,
      selectedWinner: candidate,
      selection: selected(),
      epochs: epochsFor("holdout"),
      rows: holdoutRows([0.1, -0.01]),
    });
    expect(regression.decision).toBe("reject");
    expect(regression.reasons).toHaveLength(1);
    expect(regression.reasons[0]?.code).toBe("holdout-regression");
    expect(regression.claim).toBeNull();
  });

  it("rejects either half of an identity other than the exact train-selected winner", () => {
    const alternatives: readonly MetaOptimizerIdentity[] = [
      {
        sourceArtifact: candidate.sourceArtifact,
        bundleDigest: "sha256:bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc",
      },
      {
        sourceArtifact: "sha256:acacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacac",
        bundleDigest: candidate.bundleDigest,
      },
    ];
    for (const selectedWinner of alternatives) {
      const result = finalizeMetaHoldout({ config, identity, selectedWinner, selection: selected(), epochs: epochsFor("holdout"), rows: holdoutRows([0.1, 0.1]) });
      expect(result.decision).toBe("reject");
      expect(result.reasons.map((reason) => reason.code)).toContain("selection-identity-mismatch");
    }
  });
});
