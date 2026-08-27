import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MetaCampaignConfigV2 } from "@hone/schema";
import { describe, expect, test } from "vitest";
import { repinCampaignImage } from "../src/commands/hone.js";
import { makeRoot } from "./helpers.js";

const preservedPath = fileURLToPath(new URL(
  "../../../data/m2-refreeze-final/campaign-frozen.json",
  import.meta.url,
));
const TO_IMAGE = `hone-distribution@sha256:${"d".repeat(64)}`;

function sha256(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
  sourcePath: string;
  sourceText: string;
  preRegistration: Record<string, unknown>;
  evidence: Record<string, unknown>;
  capsuleId: string;
  fromImage: string;
}

function fixture(): Fixture {
  const root = makeRoot();
  const campaignPath = join(root, "campaign-frozen.json");
  const config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(preservedPath, "utf8")));
  const capsule = config.train[0]!;
  writeFileSync(campaignPath, `${JSON.stringify(config, null, 2)}\n`);
  const evidencePath = join(root, "evidence", "distribution-equivalence.v1.json");
  const preRegistrationPath = join(root, "evidence", "distribution-preregistration.v1.json");
  const sourcePath = join(root, "evaluator.py");
  const sourceText = [
    "import secrets, time",
    "measured_nonce = secrets.randbits(63)",
    "started = time.monotonic()",
    "",
  ].join("\n");
  const structuralNondeterminism = {
    evaluatorSourcePath: "evaluator.py",
    evaluatorSourceSha256: sha256(sourceText),
    seedEnvironmentVariable: "HONE_SEED",
    entropySources: [{ line: 2, exactSourceLine: "measured_nonce = secrets.randbits(63)" }],
    timingSources: [{ line: 3, exactSourceLine: "started = time.monotonic()" }],
  };
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
    sourcePath,
    sourceText,
    preRegistration,
    evidence,
    capsuleId: capsule.capsuleId,
    fromImage: capsule.image,
  };
}

function writeFixture(f: Fixture): void {
  mkdirSync(dirname(f.evidencePath), { recursive: true });
  writeFileSync(f.sourcePath, f.sourceText);
  const proof = {
    evaluatorSourcePath: "evaluator.py",
    evaluatorSourceSha256: sha256(f.sourceText),
    seedEnvironmentVariable: "HONE_SEED",
    entropySources: [{ line: 2, exactSourceLine: "measured_nonce = secrets.randbits(63)" }],
    timingSources: [{ line: 3, exactSourceLine: "started = time.monotonic()" }],
  };
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
    const f = fixture();
    f.sourceText += 'seed = os.environ["HONE_SEED"]\n';
    writeFixture(f);
    expect(() => repin(f)).toThrow("evaluator reads HONE_SEED");
  });

  test("refuses source hash drift and false structural source citations", () => {
    const driftedSource = fixture();
    writeFixture(driftedSource);
    writeFileSync(driftedSource.sourcePath, `${driftedSource.sourceText}# drift\n`);
    expect(() => repin(driftedSource)).toThrow("source hash does not match");

    const falseCitation = fixture();
    writeFixture(falseCitation);
    const preregProof = falseCitation.preRegistration.structuralNondeterminism as MutableStructuralProof;
    const evidenceProof = falseCitation.evidence.structuralNondeterminism as MutableStructuralProof;
    preregProof.entropySources[0]!.exactSourceLine = "measured_nonce = deterministic";
    evidenceProof.entropySources[0]!.exactSourceLine = "measured_nonce = deterministic";
    const preregBytes = `${JSON.stringify(falseCitation.preRegistration, null, 2)}\n`;
    writeFileSync(falseCitation.preRegistrationPath, preregBytes);
    falseCitation.evidence.preRegistrationSha256 = sha256(preregBytes);
    writeFileSync(falseCitation.evidencePath, `${JSON.stringify(falseCitation.evidence, null, 2)}\n`);
    expect(() => repin(falseCitation)).toThrow("source citation does not match");
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
