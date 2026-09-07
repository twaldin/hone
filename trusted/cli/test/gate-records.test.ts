import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalJson } from "@hone/schema";
import { metaCampaignConfigHash, type MetaMeasurement } from "@hone/meta";
import { describe, expect, it } from "vitest";
import {
  G1_RECORD_FILE,
  G1_SEARCH_APPROVAL_FILE,
  GATE_RECORDS_VERSION,
  assembleG1Authorization,
  assembleG1Record,
  assembleG1SearchApproval,
  assembleG2Authorization,
  assembleG2Record,
  assertG1Authorized,
  assertG1SearchApproved,
  assertG2Authorized,
  readG1Record,
  readConfirmationReceipt,
  readGateThresholdsFile,
  verifyAuthorization,
  verifyG1Record,
  verifyG2Record,
  writeAuthorization,
  writeG1Record,
  writeG1SearchApproval,
  writeG2Record,
  type VerifiedG1Record,
} from "../src/gate-records.js";
import {
  G1_THRESHOLDS,
  G2_THRESHOLDS,
  HUMAN,
  ID,
  buildConfig,
  buildMeasurements,
  constant,
  digest,
  passingG1Specs,
  passingG2Specs,
  receiptFor,
  sha,
  tmp,
} from "./helpers/gate-fixtures.js";

describe("assembleG1Record: Stage-A statistical gate", () => {
  it("passes when winner beats seed across every capsule with controls below", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
      generatedAt: HUMAN.decidedAt,
    });
    expect(measurements).toHaveLength(96);
    expect(record.criteria).toEqual({
      pairedImprovement: true,
      taskSigns: true,
      stratumSigns: true,
      controlsBelow: true,
      cardinalityComplete: true,
      artifactsBound: true,
    });
    expect(record.pass).toBe(true);
    expect(record.stats.taskSignPositives).toBe(8);
    expect(record.stats.ownerSignPositives).toBe(4);
    expect(record.stats.ossSignPositives).toBe(4);
    // Digest binding round-trips.
    expect(verifyG1Record(record)).toEqual(record);
  });

  it("fails paired-improvement when the mean delta is within 2*SE", () => {
    const config = buildConfig("A");
    // seed constant, winner = seed + high-variance near-zero-mean noise.
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1) },
      {
        arm: "winner",
        identity: ID.winner,
        score: (capIndex, rep) => 0.1 + (((capIndex * 3 + rep) % 2 === 0) ? 0.3 : -0.28),
      },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(-0.1) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.criteria.pairedImprovement).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails task-signs when fewer than 6/8 capsules improve", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1) },
      { arm: "winner", identity: ID.winner, score: (capIndex) => (capIndex < 5 ? 0.3 : 0.05) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.01) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.stats.taskSignPositives).toBe(5);
    expect(record.criteria.taskSigns).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails stratum-signs when a stratum has fewer than 3/4 positive even with 6/8 overall", () => {
    const config = buildConfig("A");
    // Owner (capIndex 0-3): only 0,1 improve. OSS (capIndex 4-7): all improve. Total 6/8.
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1) },
      { arm: "winner", identity: ID.winner, score: (capIndex) => (capIndex === 2 || capIndex === 3 ? 0.05 : 0.3) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.01) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.stats.taskSignPositives).toBe(6);
    expect(record.criteria.taskSigns).toBe(true);
    expect(record.stats.ownerSignPositives).toBe(2);
    expect(record.criteria.stratumSigns).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails controls-below when a control is not under both G0 and G1", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1) },
      { arm: "winner", identity: ID.winner, score: constant(0.3) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.2) }, // above seed 0.1
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.criteria.controlsBelow).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("refuses when the measurement digest does not match the confirmation receipt", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    expect(() =>
      assembleG1Record({
        config,
        measurements,
        receipt: { measurementCount: measurements.length, measurementHash: sha("tampered") },
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.winner,
      }),
    ).toThrow(/measurement digest does not match/);
  });

  it("refuses when a measurement carries a foreign configHash", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    measurements[0] = { ...measurements[0]!, configHash: digest("foreign") };
    expect(() =>
      assembleG1Record({
        config,
        measurements,
        receipt: receiptFor(measurements),
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.winner,
      }),
    ).toThrow(/does not belong to campaign/);
  });

  it("refuses an unexpected arm and a duplicate replicate", () => {
    const config = buildConfig("A");
    const base = buildMeasurements(config, passingG1Specs());
    const foreignArm = [{ ...base[0]!, arm: "generation-0" as MetaMeasurement["arm"] }];
    expect(() =>
      assembleG1Record({
        config,
        measurements: foreignArm,
        receipt: receiptFor(foreignArm),
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.winner,
      }),
    ).toThrow(/unexpected arm/);
    const dup = [base[0]!, { ...base[0]! }];
    expect(() =>
      assembleG1Record({
        config,
        measurements: dup,
        receipt: receiptFor(dup),
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.winner,
      }),
    ).toThrow(/duplicate measurement/);
  });

  it("refuses when the accepted winner identity does not match the winner arm", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    expect(() =>
      assembleG1Record({
        config,
        measurements,
        receipt: receiptFor(measurements),
        thresholds: G1_THRESHOLDS,
        seed: ID.seed,
        winner: ID.seed, // wrong — winner arm carries ID.winner
      }),
    ).toThrow(/does not carry|not the accepted/);
  });

  it("marks cardinality incomplete when a replicate is missing", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.1), reps: (capIndex) => (capIndex === 0 ? [0, 1] : [0, 1, 2]) },
      { arm: "winner", identity: ID.winner, score: constant(0.3) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.criteria.cardinalityComplete).toBe(false);
    expect(record.pass).toBe(false);
  });
});

describe("assembleG2Record: Stage-B paired transfer gate", () => {
  it("passes when the G1-controller wins on ordinal + tokens and G2 improves over G1", () => {
    const config = buildConfig("B");
    const measurements = buildMeasurements(config, passingG2Specs());
    const record = assembleG2Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
      generatedAt: HUMAN.decidedAt,
    });
    expect(measurements).toHaveLength(120);
    expect(record.criteria).toEqual({
      pairedAucWinFraction: true,
      pairedMeanAucPositive: true,
      tokenParity: true,
      validYieldNotLower: true,
      g2SignGate: true,
      g2ControlsBelow: true,
      cardinalityComplete: true,
      artifactsBound: true,
    });
    expect(record.pass).toBe(true);
    expect(record.transfer.pairWinCount).toBe(24);
    expect(record.transfer.pairWinFraction).toBe(1);
    expect(verifyG2Record(record)).toEqual(record);
  });

  it("fails the win fraction when the G1-controller wins too few pairs", () => {
    const config = buildConfig("B");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.target, score: (capIndex) => (capIndex < 3 ? 0.3 : 0.05), tokens: constant(90) },
      { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
      { arm: "generation-2", identity: ID.gen2, score: constant(0.4), tokens: constant(90) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.02) },
    ]);
    const record = assembleG2Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    expect(record.transfer.pairWinCount).toBe(9);
    expect(record.criteria.pairedAucWinFraction).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails token parity when the G1-controller spends more tokens", () => {
    const config = buildConfig("B");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.target, score: constant(0.3), tokens: constant(200) },
      { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
      { arm: "generation-2", identity: ID.gen2, score: constant(0.4), tokens: constant(90) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.02) },
    ]);
    const record = assembleG2Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    expect(record.criteria.tokenParity).toBe(false);
    expect(record.criteria.pairedAucWinFraction).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("fails valid-yield and cardinality when the G1-controller produced fewer measurements", () => {
    const config = buildConfig("B");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.target, score: constant(0.3), tokens: constant(90), reps: (capIndex) => (capIndex < 2 ? [0] : [0, 1, 2]) },
      { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
      { arm: "generation-2", identity: ID.gen2, score: constant(0.4), tokens: constant(90) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.02) },
    ]);
    const record = assembleG2Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    expect(record.transfer.g1ValidYield).toBeLessThan(1);
    expect(record.transfer.g0ValidYield).toBe(1);
    expect(record.criteria.validYieldNotLower).toBe(false);
    expect(record.criteria.cardinalityComplete).toBe(false);
    expect(record.pass).toBe(false);
  });

  it("requires a stage-B config", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    expect(() =>
      assembleG2Record({
        config,
        measurements,
        receipt: receiptFor(measurements),
        thresholds: G2_THRESHOLDS,
        target: ID.target,
        controlWinner: ID.controlWinner,
        generation2: ID.gen2,
      }),
    ).toThrow(/requires a stage-B/);
  });
});

describe("digest tamper refusal", () => {
  it("refuses a G1 record whose statistic drifted after assembly", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, passingG1Specs());
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    const tampered = { ...record, pass: false };
    expect(() => verifyG1Record(tampered)).toThrow(/inputsDigest mismatch/);
  });

  it("refuses an authorization record tampered on disk", () => {
    const config = buildConfig("A");
    const dir = tmp();
    const measurements = buildMeasurements(config, passingG1Specs());
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    const authorization = assembleG1Authorization({
      configHash: metaCampaignConfigHash(buildConfig("B")),
      record,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
      humanDecision: HUMAN,
    });
    const path = writeAuthorization(dir, authorization);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, canonicalJson({ ...onDisk, acceptedArtifacts: { ...onDisk.acceptedArtifacts, generation2: ID.gen0 } }));
    expect(() => verifyAuthorization(JSON.parse(readFileSync(path, "utf8")))).toThrow(/inputsDigest mismatch/);
  });
});

describe("human authorization assembly fails closed on failing statistics", () => {
  it("refuses to authorize Stage B from a failing G1 record", () => {
    const config = buildConfig("A");
    const measurements = buildMeasurements(config, [
      { arm: "seed", identity: ID.seed, score: constant(0.3) },
      { arm: "winner", identity: ID.winner, score: constant(0.1) }, // winner worse than seed
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(record.pass).toBe(false);
    expect(() =>
      assembleG1Authorization({
        configHash: metaCampaignConfigHash(buildConfig("B")),
        record,
        controlWinner: ID.controlWinner,
        generation2: ID.gen2,
        humanDecision: HUMAN,
      }),
    ).toThrow(/did not pass/);
  });
});

describe("dispatch guards fail closed", () => {
  function seededStageB(): { dir: string; stageBHash: string } {
    const stageA = buildConfig("A");
    const stageB = buildConfig("B");
    const stageBHash = metaCampaignConfigHash(stageB);
    const dir = tmp();
    const measurements = buildMeasurements(stageA, passingG1Specs());
    const record = assembleG1Record({
      config: stageA,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    const authorization = assembleG1Authorization({
      configHash: stageBHash,
      record,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
      humanDecision: HUMAN,
    });
    writeAuthorization(dir, authorization);
    return { dir, stageBHash };
  }

  const STAGE_B_EXPECT = { target: ID.winner, controlWinner: ID.controlWinner, generation2: ID.gen2 };
  // Terminal artifacts MUST be the identities the G2 record validated:
  // G0 == controlWinner, G1 == target, G2 == generation2.
  const TERMINAL_EXPECT = { generation0: ID.controlWinner, generation1: ID.target, generation2: ID.gen2 };

  function seededG2(dir: string, stageBHash: string): void {
    const stageB = buildConfig("B");
    const measurements = buildMeasurements(stageB, passingG2Specs());
    const g2Record = assembleG2Record({
      config: stageB,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    writeG2Record(dir, g2Record);
    writeAuthorization(dir, assembleG2Authorization({
      configHash: stageBHash,
      record: g2Record,
      generation0: ID.controlWinner,
      generation1: ID.target,
      generation2: ID.gen2,
      humanDecision: HUMAN,
    }));
  }

  it("Stage B refuses when the G1 authorization is absent", () => {
    const stageBHash = metaCampaignConfigHash(buildConfig("B"));
    expect(() => assertG1Authorized(tmp(), stageBHash, STAGE_B_EXPECT)).toThrow(/absent/);
  });

  it("Stage B accepts the matching G1 authorization and refuses mismatched artifacts", () => {
    const { dir, stageBHash } = seededStageB();
    expect(assertG1Authorized(dir, stageBHash, STAGE_B_EXPECT).gate).toBe("G1");
    expect(() => assertG1Authorized(dir, stageBHash, { ...STAGE_B_EXPECT, controlWinner: ID.seed }))
      .toThrow(/control-winner/);
    expect(() => assertG1Authorized(dir, metaCampaignConfigHash(buildConfig("A")), STAGE_B_EXPECT))
      .toThrow(/not the dispatched campaign/);
  });

  it("Stage B refuses when the dispatched target is not the Stage-A validated winner", () => {
    const { dir, stageBHash } = seededStageB();
    // The G1 authorization binds target = record.winner (ID.winner); a different Stage-B target fails closed.
    expect(() => assertG1Authorized(dir, stageBHash, { ...STAGE_B_EXPECT, target: ID.target }))
      .toThrow(/Stage-B target does not match/);
  });

  it("terminal requires both G1 and G2 authorizations and the matching artifacts", () => {
    const { dir, stageBHash } = seededStageB();
    // G2 authorization missing → fail closed.
    expect(() => assertG2Authorized(dir, stageBHash, TERMINAL_EXPECT)).toThrow(/G2 authorization/);
    seededG2(dir, stageBHash);
    expect(assertG2Authorized(dir, stageBHash, TERMINAL_EXPECT).gate).toBe("G2");
    // Mismatched terminal artifact → fail closed.
    expect(() => assertG2Authorized(dir, stageBHash, { ...TERMINAL_EXPECT, generation0: ID.gen0 }))
      .toThrow(/generation0/);
  });

  it("terminal refuses when the G1 dev gate authorization is absent", () => {
    const stageBHash = metaCampaignConfigHash(buildConfig("B"));
    const dir = tmp();
    seededG2(dir, stageBHash);
    // No G1 authorization present.
    expect(() => assertG2Authorized(dir, stageBHash, TERMINAL_EXPECT)).toThrow(/absent/);
  });

  it("terminal refuses when the on-disk G2 record drifted from the authorization", () => {
    const { dir, stageBHash } = seededStageB();
    seededG2(dir, stageBHash);
    // Overwrite the persisted G2 record with a different validated set (different G2 identity).
    const stageB = buildConfig("B");
    const drifted = buildMeasurements(stageB, [
      { arm: "seed", identity: ID.target, score: constant(0.3), tokens: constant(90) },
      { arm: "controller-control-winner", identity: ID.controlWinner, score: constant(0.1), tokens: constant(100) },
      { arm: "generation-2", identity: ID.gen0, score: constant(0.4), tokens: constant(90) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    writeG2Record(dir, assembleG2Record({
      config: stageB,
      measurements: drifted,
      receipt: receiptFor(drifted),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen0,
    }));
    expect(() => assertG2Authorized(dir, stageBHash, TERMINAL_EXPECT)).toThrow(/drifted/);
  });

  it("refuses to authorize terminal for artifacts the G2 record did not validate", () => {
    const stageB = buildConfig("B");
    const measurements = buildMeasurements(stageB, passingG2Specs());
    const g2Record = assembleG2Record({
      config: stageB,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G2_THRESHOLDS,
      target: ID.target,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
    });
    const configHash = metaCampaignConfigHash(stageB);
    // Wrong G2 (generation2 != record.generation2).
    expect(() => assembleG2Authorization({ configHash, record: g2Record, generation0: ID.controlWinner, generation1: ID.target, generation2: ID.gen0, humanDecision: HUMAN }))
      .toThrow(/generation2 is not the G2/);
    // Wrong G1 (generation1 != record.target).
    expect(() => assembleG2Authorization({ configHash, record: g2Record, generation0: ID.controlWinner, generation1: ID.gen1, generation2: ID.gen2, humanDecision: HUMAN }))
      .toThrow(/generation1 is not the G1 target/);
    // Wrong G0 (generation0 != record.controlWinner).
    expect(() => assembleG2Authorization({ configHash, record: g2Record, generation0: ID.gen0, generation1: ID.target, generation2: ID.gen2, humanDecision: HUMAN }))
      .toThrow(/generation0 is not the G0 controller/);
  });

  it("round-trips a persisted G1 record and reads it back verified", () => {
    const config = buildConfig("A");
    const dir = tmp();
    const measurements = buildMeasurements(config, passingG1Specs());
    const record = assembleG1Record({
      config,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    writeG1Record(dir, record);
    expect(readG1Record(dir)).toEqual(record);
  });
});

describe("owner threshold file fails closed when unset", () => {
  it("refuses a thresholds file missing the g2 block", () => {
    const dir = tmp();
    const path = join(dir, "gate-thresholds.json");
    writeFileSync(path, JSON.stringify({ version: GATE_RECORDS_VERSION, g1: G1_THRESHOLDS }));
    expect(() => readGateThresholdsFile(path)).toThrow(/owner input required/);
  });

  it("loads a complete thresholds file", () => {
    const dir = tmp();
    const path = join(dir, "gate-thresholds.json");
    writeFileSync(path, JSON.stringify({ version: GATE_RECORDS_VERSION, g1: G1_THRESHOLDS, g2: G2_THRESHOLDS }));
    expect(readGateThresholdsFile(path)).toEqual({ version: GATE_RECORDS_VERSION, g1: G1_THRESHOLDS, g2: G2_THRESHOLDS });
  });
});

describe("gate records bind against the independently persisted confirmation receipt", () => {
  it("reads the persisted receipt and refuses when the measurement set does not reproduce its digest", () => {
    const config = buildConfig("A");
    const dir = tmp();
    const measurements = buildMeasurements(config, passingG1Specs());
    const receiptPath = join(dir, "confirmation-receipt.json");
    // The confirmation phase persists this; the gate binds against it, not an inline value.
    writeFileSync(receiptPath, canonicalJson({ version: 1, phase: "confirmation", ...receiptFor(measurements) }));
    const persisted = readConfirmationReceipt(receiptPath);
    expect(persisted.measurementCount).toBe(96);
    // Assembling against the persisted receipt with the confirmed set succeeds.
    expect(assembleG1Record({ config, measurements, receipt: persisted, thresholds: G1_THRESHOLDS, seed: ID.seed, winner: ID.winner }).pass).toBe(true);
    // A tampered persisted receipt digest is refused.
    const tamperedPath = join(dir, "tampered-receipt.json");
    writeFileSync(tamperedPath, canonicalJson({ version: 1, phase: "confirmation", measurementCount: 96, measurementHash: sha("not-the-set") }));
    expect(() =>
      assembleG1Record({ config, measurements, receipt: readConfirmationReceipt(tamperedPath), thresholds: G1_THRESHOLDS, seed: ID.seed, winner: ID.winner }),
    ).toThrow(/measurement digest does not match/);
  });

  it("refuses a malformed confirmation receipt", () => {
    const dir = tmp();
    const path = join(dir, "confirmation-receipt.json");
    writeFileSync(path, JSON.stringify({ version: 1, phase: "confirmation", measurementCount: 96 }));
    expect(() => readConfirmationReceipt(path)).toThrow(/bound measurement digest/);
  });
});

describe("G1 search approval gates Stage-B search without Stage-B products", () => {
  /** Writes a passing Stage-A G1 record into dir; a different generatedAt yields a different digest. */
  function passingG1(dir: string, generatedAt = "2026-07-24T00:00:00.000Z"): VerifiedG1Record {
    const stageA = buildConfig("A");
    const measurements = buildMeasurements(stageA, passingG1Specs());
    const record = assembleG1Record({
      config: stageA,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
      generatedAt,
    });
    writeG1Record(dir, record);
    return record;
  }

  function approvedStageB(controllerGeneration: 0 | 1) {
    const stageADir = tmp();
    const stageBDir = tmp();
    const record = passingG1(stageADir);
    const config = buildConfig("B", { controllerGeneration });
    const approval = assembleG1SearchApproval({ config, record, recordDir: stageADir, humanDecision: HUMAN });
    writeG1SearchApproval(stageBDir, approval);
    return { stageADir, stageBDir, config, record, approval };
  }

  it("approves search for the controllerGeneration-0 cell: target = G1 winner, controller = G0 seed", () => {
    const { stageADir, stageBDir, config, record, approval } = approvedStageB(0);
    expect(approval.acceptedArtifacts).toEqual({ target: ID.winner, controller: ID.seed });
    expect(approval.sourceRecordDir).toBe(stageADir);
    expect(approval.statisticalRecordDigest).toBe(record.inputsDigest);
    expect(approval.configHash).toBe(metaCampaignConfigHash(config));
    expect(assertG1SearchApproved(stageBDir, config)).toEqual(approval);
  });

  it("approves search for the controllerGeneration-1 cell: controller = G1 winner", () => {
    const { stageBDir, config, approval } = approvedStageB(1);
    expect(approval.acceptedArtifacts).toEqual({ target: ID.winner, controller: ID.winner });
    expect(assertG1SearchApproved(stageBDir, config)).toEqual(approval);
  });

  it("binds the source record directory as an absolute path", () => {
    const stageADir = tmp();
    const record = passingG1(stageADir);
    // A cwd-relative recordDir is resolved before binding (the schema refuses a non-absolute path outright).
    const approval = assembleG1SearchApproval({
      config: buildConfig("B"),
      record,
      recordDir: relative(process.cwd(), stageADir),
      humanDecision: HUMAN,
    });
    expect(approval.sourceRecordDir).toBe(stageADir);
  });

  it("refuses search when the approval is absent — and the confirmation-phase G1 authorization does not stand in", () => {
    const stageADir = tmp();
    const stageBDir = tmp();
    const record = passingG1(stageADir);
    const config = buildConfig("B");
    expect(() => assertG1SearchApproved(stageBDir, config)).toThrow(/absent/);
    writeAuthorization(stageBDir, assembleG1Authorization({
      configHash: metaCampaignConfigHash(config),
      record,
      controlWinner: ID.controlWinner,
      generation2: ID.gen2,
      humanDecision: HUMAN,
    }));
    expect(() => assertG1SearchApproved(stageBDir, config)).toThrow(/search approval .* is absent/);
  });

  it("refuses to record anything but a strict approved decision", () => {
    const stageADir = tmp();
    const record = passingG1(stageADir);
    const config = buildConfig("B");
    const rejected = { ...HUMAN, decision: "rejected" } as unknown as typeof HUMAN;
    expect(() => assembleG1SearchApproval({ config, record, recordDir: stageADir, humanDecision: rejected })).toThrow();
    const unconfined = { ...HUMAN, diffConfinedIntelligible: false } as unknown as typeof HUMAN;
    expect(() => assembleG1SearchApproval({ config, record, recordDir: stageADir, humanDecision: unconfined })).toThrow();
  });

  it("refuses a failing G1 record and a non-stage-B destination", () => {
    const stageADir = tmp();
    const stageA = buildConfig("A");
    const measurements = buildMeasurements(stageA, [
      { arm: "seed", identity: ID.seed, score: constant(0.3) },
      { arm: "winner", identity: ID.winner, score: constant(0.1) },
      { arm: "broken-control", identity: ID.broken, score: constant(0.0) },
      { arm: "degraded-control", identity: ID.degraded, score: constant(0.05) },
    ]);
    const failing = assembleG1Record({
      config: stageA,
      measurements,
      receipt: receiptFor(measurements),
      thresholds: G1_THRESHOLDS,
      seed: ID.seed,
      winner: ID.winner,
    });
    expect(failing.pass).toBe(false);
    writeG1Record(stageADir, failing);
    expect(() => assembleG1SearchApproval({ config: buildConfig("B"), record: failing, recordDir: stageADir, humanDecision: HUMAN }))
      .toThrow(/did not pass/);
    const passing = passingG1(tmp());
    expect(() => assembleG1SearchApproval({ config: stageA, record: passing, recordDir: stageADir, humanDecision: HUMAN }))
      .toThrow(/stage-B/);
    expect(() => assertG1SearchApproved(tmp(), stageA)).toThrow(/stage-B search only/);
  });

  it("refuses a destination whose target or controller is not what the G1 record validated", () => {
    const stageADir = tmp();
    const record = passingG1(stageADir);
    expect(() =>
      assembleG1SearchApproval({ config: buildConfig("B", { target: ID.target }), record, recordDir: stageADir, humanDecision: HUMAN }),
    ).toThrow(/target is not the G1 winner/);
    expect(() =>
      assembleG1SearchApproval({ config: buildConfig("B", { controller: ID.controlWinner }), record, recordDir: stageADir, humanDecision: HUMAN }),
    ).toThrow(/controller is not the G0 seed/);
  });

  it("refuses a recordDir that does not hold the record being approved", () => {
    const stageADir = tmp();
    const record = passingG1(stageADir);
    const otherDir = tmp();
    passingG1(otherDir, "2026-07-25T00:00:00.000Z");
    expect(() => assembleG1SearchApproval({ config: buildConfig("B"), record, recordDir: otherDir, humanDecision: HUMAN }))
      .toThrow(/different G1 record/);
    expect(() => assembleG1SearchApproval({ config: buildConfig("B"), record, recordDir: tmp(), humanDecision: HUMAN }))
      .toThrow(/not readable JSON/);
  });

  it("refuses an approval bound to a different Stage-B cell", () => {
    const { stageBDir } = approvedStageB(0);
    expect(() => assertG1SearchApproved(stageBDir, buildConfig("B", { controllerGeneration: 1 })))
      .toThrow(/not the dispatched campaign/);
  });

  it("refuses an approval tampered on disk", () => {
    const { stageBDir, config } = approvedStageB(0);
    const path = join(stageBDir, G1_SEARCH_APPROVAL_FILE);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, canonicalJson({ ...onDisk, acceptedArtifacts: { ...onDisk.acceptedArtifacts, controller: ID.controlWinner } }));
    expect(() => assertG1SearchApproved(stageBDir, config)).toThrow(/inputsDigest mismatch/);
    writeFileSync(path, canonicalJson({ ...onDisk, sourceRecordDir: "relative/stage-a" }));
    expect(() => assertG1SearchApproved(stageBDir, config)).toThrow(/not a valid G1 search approval/);
  });

  it("fails closed when the source G1 record is gone or was regenerated after approval", () => {
    const { stageADir, stageBDir, config } = approvedStageB(0);
    // Regenerated (still passing, still the same identities) → different digest → stale approval.
    passingG1(stageADir, "2026-07-25T00:00:00.000Z");
    expect(() => assertG1SearchApproved(stageBDir, config)).toThrow(/stale approval/);
    rmSync(join(stageADir, G1_RECORD_FILE));
    expect(() => assertG1SearchApproved(stageBDir, config)).toThrow(/source G1 record .* is absent/);
  });

  it("fails closed when the source G1 record was tampered to fail", () => {
    const { stageADir, stageBDir, config } = approvedStageB(0);
    const path = join(stageADir, G1_RECORD_FILE);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, canonicalJson({ ...onDisk, pass: false }));
    expect(() => assertG1SearchApproved(stageBDir, config)).toThrow(/inputsDigest mismatch/);
  });
});
