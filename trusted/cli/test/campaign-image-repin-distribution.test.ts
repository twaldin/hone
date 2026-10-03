import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MetaCampaignConfigV2 } from "@hone/schema";
import { describe, expect, test } from "vitest";
import {
  repinCampaignImage,
  verifyStructuralNondeterminism,
} from "../src/commands/hone.js";
import { makeRoot } from "./helpers.js";
import {
  SYNTHETIC_EVALUATOR_SOURCE,
  evaluatorCitation,
  evaluatorRelativePath,
  installCampaignCapsule,
} from "./support/installed-campaign-capsule.js";
import { syntheticFrozenCampaign } from "./support/synthetic-campaign.js";

const CAPSULE_LABEL = "distribution-evaluator";
const EVALUATOR_PATH = evaluatorRelativePath(CAPSULE_LABEL);
const TO_IMAGE = `hone-distribution@sha256:${"d".repeat(64)}`;

function sha256(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The honest structural proof for the installed synthetic evaluator. */
function structuralProof(): MutableStructuralProof {
  return {
    evaluatorSourcePath: EVALUATOR_PATH,
    evaluatorSourceSha256: sha256(SYNTHETIC_EVALUATOR_SOURCE),
    seedEnvironmentVariable: "HONE_SEED",
    entropySources: [evaluatorCitation("measured_nonce = "), evaluatorCitation("warmup_nonce = ")],
    timingSources: [evaluatorCitation("started = "), evaluatorCitation("elapsed_ms = ")],
  };
}

interface DistributionReplay {
  artifact: string;
  historicalScore: number;
  rawScores: number[];
  min: number;
  max: number;
  mean: number;
  selfSpread: number;
  relativeMeanOffset: number;
}

interface MutableStructuralProof {
  evaluatorSourcePath: string;
  evaluatorSourceSha256: string;
  seedEnvironmentVariable: string;
  entropySources: Array<{ line: number; exactSourceLine: string }>;
  timingSources: Array<{ line: number; exactSourceLine: string }>;
}

function replay(artifact: string, historicalScore: number, rawScores: number[]): DistributionReplay {
  const min = Math.min(...rawScores);
  const max = Math.max(...rawScores);
  const mean = rawScores.reduce((sum, score) => sum + score, 0) / rawScores.length;
  const selfSpread = mean === 0 ? 0 : (max - min) / Math.abs(mean);
  const relativeMeanOffset = mean === 0
    ? Math.abs(historicalScore - mean)
    : Math.abs(historicalScore - mean) / Math.abs(mean);
  return { artifact, historicalScore, rawScores, min, max, mean, selfSpread, relativeMeanOffset };
}

interface Fixture {
  root: string;
  campaignPath: string;
  evidencePath: string;
  preRegistrationPath: string;
  preRegistration: Record<string, unknown>;
  evidence: Record<string, unknown>;
  capsuleId: string;
  fromImage: string;
}

function fixture(): Fixture {
  const root = makeRoot();
  const campaignPath = join(root, "campaign-frozen.json");
  // Bind the last development slot to an installed synthetic evaluator capsule
  // with an owner Gate-2 receipt in this root's CAS.
  const { config } = installCampaignCapsule(syntheticFrozenCampaign(), {
    root,
    capsulesRoot: join(root, "capsules"),
    trainIndex: 5,
    label: CAPSULE_LABEL,
  });
  const capsule = config.train[5]!;
  writeFileSync(campaignPath, `${JSON.stringify(config, null, 2)}\n`);
  const evidencePath = join(root, "evidence", "distribution-equivalence.v1.json");
  const preRegistrationPath = join(root, "evidence", "distribution-preregistration.v1.json");
  const structuralNondeterminism = structuralProof();
  const baseline = { artifact: `sha256:${"1".repeat(64)}`, historicalScore: 10 };
  const settledCandidate = { artifact: `sha256:${"2".repeat(64)}`, historicalScore: 20 };
  const preRegistration: Record<string, unknown> = {
    version: 1,
    evidenceMode: "distribution-preregistration",
    registeredAt: "2026-08-27T04:00:00.000Z",
    capsuleId: capsule.capsuleId,
    fromImage: capsule.image,
    toImage: TO_IMAGE,
    structuralNondeterminism,
    measurementPlan: { replicatesPerArtifact: 12, k: 0.5 },
    baseline,
    settledCandidate,
  };
  const evidence: Record<string, unknown> = {
    version: 1,
    evidenceMode: "distribution",
    generatedAt: "2026-08-27T04:30:00.000Z",
    measurementStartedAt: "2026-08-27T04:01:00.000Z",
    measurementCompletedAt: "2026-08-27T04:29:00.000Z",
    capsuleId: capsule.capsuleId,
    fromImage: capsule.image,
    toImage: TO_IMAGE,
    preRegistrationPath: "distribution-preregistration.v1.json",
    preRegistrationSha256: "",
    structuralNondeterminism,
    k: 0.5,
    exploratoryMeasurements: {
      excluded: true,
      statement: "Pre-registration measurements were exploratory and are excluded; only post-pre-registration measurements are confirmatory.",
    },
    baseline: replay(baseline.artifact, baseline.historicalScore, [9, 11, 9, 11, 9, 11, 9, 11, 9, 11, 9, 11]),
    settledCandidate: replay(
      settledCandidate.artifact,
      settledCandidate.historicalScore,
      [18, 22, 18, 22, 18, 22, 18, 22, 18, 22, 18, 22],
    ),
    tripwires: [{ name: "ordering", passed: true }],
    modelCalls: 0,
    result: "passed",
  };
  return {
    root,
    campaignPath,
    evidencePath,
    preRegistrationPath,
    preRegistration,
    evidence,
    capsuleId: capsule.capsuleId,
    fromImage: capsule.image,
  };
}

function writeFixture(f: Fixture): void {
  mkdirSync(dirname(f.evidencePath), { recursive: true });
  const proof = structuralProof();
  f.preRegistration.structuralNondeterminism = proof;
  f.evidence.structuralNondeterminism = proof;
  const preRegistrationBytes = `${JSON.stringify(f.preRegistration, null, 2)}\n`;
  writeFileSync(f.preRegistrationPath, preRegistrationBytes);
  f.evidence.preRegistrationSha256 = sha256(preRegistrationBytes);
  writeFileSync(f.evidencePath, `${JSON.stringify(f.evidence, null, 2)}\n`);
}

function repin(f: Fixture): void {
  repinCampaignImage({
    root: f.root,
    capsulesRoot: join(f.root, "capsules"),
    campaignPath: f.campaignPath,
    capsuleId: f.capsuleId,
    fromImage: f.fromImage,
    toImage: TO_IMAGE,
    evidencePath: f.evidencePath,
    reason: "pre-registered distribution equivalence",
    at: "2026-08-27T04:31:00.000Z",
  });
}

describe("campaign repin-image distribution evidence", () => {
  test("accepts only a pre-registered, recomputable two-artifact distribution", () => {
    const f = fixture();
    writeFixture(f);
    repin(f);
    const config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(f.campaignPath, "utf8")));
    expect(config.train.find((entry) => entry.capsuleId === f.capsuleId)?.image).toBe(TO_IMAGE);
    expect(config.imageRepinJournal?.repins[0]?.evidenceSha256)
      .toBe(sha256(readFileSync(f.evidencePath)));
  });

  test("refuses a seed-reading evaluator from the distribution arm", () => {
    const root = makeRoot();
    const sourcePath = join(root, "evaluator.py");
    const sourceText = [
      "import os, secrets, time",
      "seed = os.environ[\"HONE_SEED\"]",
      "measured_nonce = secrets.randbits(63)",
      "started = time.monotonic()",
      "",
    ].join("\n");
    writeFileSync(sourcePath, sourceText);
    expect(() => verifyStructuralNondeterminism(
      { root, capsulesRoot: join(root, "capsules") },
      {
        evaluatorSourcePath: "evaluator.py",
        evaluatorSourceSha256: sha256(sourceText),
        seedEnvironmentVariable: "HONE_SEED",
        entropySources: [{ line: 3, exactSourceLine: "measured_nonce = secrets.randbits(63)" }],
        timingSources: [{ line: 4, exactSourceLine: "started = time.monotonic()" }],
      },
      sourcePath,
    )).toThrow("evaluator reads HONE_SEED");
  });

  test("refuses source hash drift, false citations, and a decoy evaluator", () => {
    const driftedSource = fixture();
    writeFixture(driftedSource);
    const driftedPreregProof =
      driftedSource.preRegistration.structuralNondeterminism as MutableStructuralProof;
    const driftedEvidenceProof =
      driftedSource.evidence.structuralNondeterminism as MutableStructuralProof;
    driftedPreregProof.evaluatorSourceSha256 = `sha256:${"f".repeat(64)}`;
    driftedEvidenceProof.evaluatorSourceSha256 = `sha256:${"f".repeat(64)}`;
    let preregBytes = `${JSON.stringify(driftedSource.preRegistration, null, 2)}\n`;
    writeFileSync(driftedSource.preRegistrationPath, preregBytes);
    driftedSource.evidence.preRegistrationSha256 = sha256(preregBytes);
    writeFileSync(driftedSource.evidencePath, `${JSON.stringify(driftedSource.evidence, null, 2)}\n`);
    expect(() => repin(driftedSource)).toThrow("source hash does not match");

    const falseCitation = fixture();
    writeFixture(falseCitation);
    const preregProof = falseCitation.preRegistration.structuralNondeterminism as MutableStructuralProof;
    const evidenceProof = falseCitation.evidence.structuralNondeterminism as MutableStructuralProof;
    preregProof.entropySources[0]!.exactSourceLine = "measured_nonce = deterministic";
    evidenceProof.entropySources[0]!.exactSourceLine = "measured_nonce = deterministic";
    preregBytes = `${JSON.stringify(falseCitation.preRegistration, null, 2)}\n`;
    writeFileSync(falseCitation.preRegistrationPath, preregBytes);
    falseCitation.evidence.preRegistrationSha256 = sha256(preregBytes);
    writeFileSync(falseCitation.evidencePath, `${JSON.stringify(falseCitation.evidence, null, 2)}\n`);
    expect(() => repin(falseCitation)).toThrow("source citation does not match");

    const decoy = fixture();
    const decoyRelativePath = ".hone-runs/decoy-evaluator.py";
    const decoyPath = join(decoy.root, decoyRelativePath);
    const decoySource = "import secrets, time\nnonce = secrets.randbits(63)\nstarted = time.monotonic()\n";
    mkdirSync(dirname(decoyPath), { recursive: true });
    writeFileSync(decoyPath, decoySource);
    try {
      writeFixture(decoy);
      const decoyProof = {
        evaluatorSourcePath: decoyRelativePath,
        evaluatorSourceSha256: sha256(decoySource),
        seedEnvironmentVariable: "HONE_SEED",
        entropySources: [{ line: 2, exactSourceLine: "nonce = secrets.randbits(63)" }],
        timingSources: [{ line: 3, exactSourceLine: "started = time.monotonic()" }],
      };
      decoy.preRegistration.structuralNondeterminism = decoyProof;
      decoy.evidence.structuralNondeterminism = decoyProof;
      preregBytes = `${JSON.stringify(decoy.preRegistration, null, 2)}\n`;
      writeFileSync(decoy.preRegistrationPath, preregBytes);
      decoy.evidence.preRegistrationSha256 = sha256(preregBytes);
      writeFileSync(decoy.evidencePath, `${JSON.stringify(decoy.evidence, null, 2)}\n`);
      expect(() => repin(decoy)).toThrow("must match the installed capsule evaluator");

    const missingSignal = fixture();
    writeFixture(missingSignal);
    const missingSignalPrereg =
      missingSignal.preRegistration.structuralNondeterminism as MutableStructuralProof;
    const missingSignalEvidence =
      missingSignal.evidence.structuralNondeterminism as MutableStructuralProof;
    const nonsignal = evaluatorCitation("repetitions = int(");
    missingSignalPrereg.entropySources[0] = nonsignal;
    missingSignalEvidence.entropySources[0] = nonsignal;
    preregBytes = `${JSON.stringify(missingSignal.preRegistration, null, 2)}\n`;
    writeFileSync(missingSignal.preRegistrationPath, preregBytes);
    missingSignal.evidence.preRegistrationSha256 = sha256(preregBytes);
    writeFileSync(missingSignal.evidencePath, `${JSON.stringify(missingSignal.evidence, null, 2)}\n`);
    expect(() => repin(missingSignal)).toThrow("does not contain the required nondeterminism signal");
    } finally {
      rmSync(decoyPath, { force: true });
    }
  });

  test("refuses missing structural proof, an operator-chosen k, and fewer than 12 reps", () => {
    const missingProof = fixture();
    delete missingProof.evidence.structuralNondeterminism;
    writeFixture(missingProof);
    delete missingProof.evidence.structuralNondeterminism;
    writeFileSync(missingProof.evidencePath, `${JSON.stringify(missingProof.evidence, null, 2)}\n`);
    expect(() => repin(missingProof)).toThrow("invalid image equivalence evidence");

    const chosenK = fixture();
    chosenK.evidence.k = 0.6;
    writeFixture(chosenK);
    chosenK.evidence.k = 0.6;
    writeFileSync(chosenK.evidencePath, `${JSON.stringify(chosenK.evidence, null, 2)}\n`);
    expect(() => repin(chosenK)).toThrow("invalid image equivalence evidence");


    const chosenPlanK = fixture();
    const measurementPlan = chosenPlanK.preRegistration.measurementPlan as {
      replicatesPerArtifact: number;
      k: number;
    };
    measurementPlan.k = 0.6;
    writeFixture(chosenPlanK);
    expect(() => repin(chosenPlanK)).toThrow("invalid distribution pre-registration");

    const forgedMean = fixture();
    writeFixture(forgedMean);
    const forgedBaseline = forgedMean.evidence.baseline as DistributionReplay;
    forgedBaseline.mean += 0.001;
    writeFileSync(forgedMean.evidencePath, `${JSON.stringify(forgedMean.evidence, null, 2)}\n`);
    expect(() => repin(forgedMean)).toThrow("mean does not match the raw score distribution");

    const fixedBoundary = fixture();
    const boundaryBaseline = fixedBoundary.evidence.baseline as DistributionReplay;
    fixedBoundary.evidence.baseline = replay(
      boundaryBaseline.artifact,
      9,
      [9, 11, 9, 11, 9, 11, 9, 11, 9, 11, 9, 11],
    );
    const fixedBoundaryPrereg =
      fixedBoundary.preRegistration.baseline as { artifact: string; historicalScore: number };
    fixedBoundaryPrereg.historicalScore = 9;
    writeFixture(fixedBoundary);
    expect(() => repin(fixedBoundary)).toThrow("less than 0.5 times self-spread");

    const planShortfall = fixture();
    const plan = planShortfall.preRegistration.measurementPlan as {
      replicatesPerArtifact: number;
      k: number;
    };
    plan.replicatesPerArtifact = 24;
    writeFixture(planShortfall);
    expect(() => repin(planShortfall)).toThrow("does not satisfy its pre-registered measurement plan");

    for (const exploratoryMeasurements of [
      {
        excluded: false,
        statement: "Pre-registration measurements were exploratory and are excluded; only post-pre-registration measurements are confirmatory.",
      },
      { excluded: true, statement: "operator supplied statement" },
    ]) {
      const exploratory = fixture();
      exploratory.evidence.exploratoryMeasurements = exploratoryMeasurements;
      writeFixture(exploratory);
      exploratory.evidence.exploratoryMeasurements = exploratoryMeasurements;
      writeFileSync(exploratory.evidencePath, `${JSON.stringify(exploratory.evidence, null, 2)}\n`);
      expect(() => repin(exploratory)).toThrow("invalid image equivalence evidence");
    }
    const tooFew = fixture();
    const baseline = tooFew.evidence.baseline as DistributionReplay;
    tooFew.evidence.baseline = replay(baseline.artifact, baseline.historicalScore, baseline.rawScores.slice(0, 11));
    writeFixture(tooFew);
    expect(() => repin(tooFew)).toThrow("invalid image equivalence evidence");
  });

  test("refuses range exclusion and an offset at or above half self-spread", () => {
    const outside = fixture();
    const baseline = outside.evidence.baseline as DistributionReplay;
    outside.evidence.baseline = replay(baseline.artifact, 100, baseline.rawScores);
    const preregBaseline = outside.preRegistration.baseline as { artifact: string; historicalScore: number };
    preregBaseline.historicalScore = 100;
    writeFixture(outside);
    expect(() => repin(outside)).toThrow("outside the rebuilt distribution range");

    const equalInstant = fixture();
    equalInstant.evidence.measurementStartedAt = "2026-08-27T04:00:00.000Z";
    writeFixture(equalInstant);
    expect(() => repin(equalInstant)).toThrow("not performed after pre-registration");

    const bindingDrift = fixture();
    writeFixture(bindingDrift);
    const bindingBaseline = bindingDrift.evidence.baseline as DistributionReplay;
    bindingBaseline.artifact = `sha256:${"3".repeat(64)}`;
    writeFileSync(bindingDrift.evidencePath, `${JSON.stringify(bindingDrift.evidence, null, 2)}\n`);
    expect(() => repin(bindingDrift)).toThrow("does not match its pre-registration");

    const escaped = fixture();
    writeFixture(escaped);
    const escapedPath = join(dirname(dirname(escaped.preRegistrationPath)), "escaped-preregistration.json");
    writeFileSync(escapedPath, readFileSync(escaped.preRegistrationPath));
    escaped.evidence.preRegistrationPath = "../escaped-preregistration.json";
    escaped.evidence.preRegistrationSha256 = sha256(readFileSync(escapedPath));
    writeFileSync(escaped.evidencePath, `${JSON.stringify(escaped.evidence, null, 2)}\n`);
    try {
      expect(() => repin(escaped)).toThrow("must stay inside");
    } finally {
      rmSync(escapedPath, { force: true });
    }

    const offset = fixture();
    const candidate = offset.evidence.settledCandidate as DistributionReplay;
    const scores = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 11];
    offset.evidence.settledCandidate = replay(candidate.artifact, 11, scores);
    const preregCandidate = offset.preRegistration.settledCandidate as { artifact: string; historicalScore: number };
    preregCandidate.historicalScore = 11;
    writeFixture(offset);
    expect(() => repin(offset)).toThrow("less than 0.5 times self-spread");
  });

  test("refuses measurement before pre-registration and a forged pre-registration hash", () => {
    const early = fixture();
    early.evidence.measurementStartedAt = "2026-08-27T03:59:59.000Z";
    writeFixture(early);
    expect(() => repin(early)).toThrow("not performed after pre-registration");

    const forged = fixture();
    writeFixture(forged);
    forged.evidence.preRegistrationSha256 = `sha256:${"f".repeat(64)}`;
    writeFileSync(forged.evidencePath, `${JSON.stringify(forged.evidence, null, 2)}\n`);
    expect(() => repin(forged)).toThrow("pre-registration hash does not match");
  });
});
