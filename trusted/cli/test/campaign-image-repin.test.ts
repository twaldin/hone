import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  campaignImageRepinRecordDigest,
  campaignRecordExtends,
  campaignRuntimeClosureRecordDigest,
  metaCampaignConfigHash,
} from "@hone/meta";
import {
  CapsuleManifest,
  DiagnosticOrderingReport,
  MetaCampaignConfigV2,
  capsuleDigest,
  type CampaignImageEquivalenceEvidenceV1,
  type CampaignImageRepinV1,
  type CampaignRuntimeClosureCaptureV1,
} from "@hone/schema";
import { describe, expect, test } from "vitest";
import {
  capsuleOracleDigest,
  capsuleScalarizerDigest,
  type AdmittedCapsule,
} from "../src/admission.js";
import {
  assertCampaignImageRepinOnly,
  campaignAdmittedCapsuleImage,
  migrateCampaignSource,
  recursivePhaseReceipt,
  repinCampaignImage,
  resolveRegisteredCapsuleLocation,
} from "../src/commands/hone.js";
import type { CmdIo } from "../src/io.js";
import { main } from "../src/main.js";
import {
  acquireCampaignRecordLock,
  appendRuntimeClosureCaptureRecord,
} from "../src/runtime-closure.js";
import { trajectoryCampaignJournals } from "../src/meta-trajectory.js";
import { makeRoot } from "./helpers.js";
import { installCampaignCapsule } from "./support/installed-campaign-capsule.js";
import { syntheticFrozenCampaign } from "./support/synthetic-campaign.js";

const TO_IMAGE = `hone-equivalent@sha256:${"a".repeat(64)}`;
const NEXT_IMAGE = `hone-equivalent@sha256:${"b".repeat(64)}`;
type ExactImageEvidence = Exclude<
  CampaignImageEquivalenceEvidenceV1,
  { evidenceMode: "distribution" }
>;

function evidence(
  capsuleId: string,
  fromImage: string,
  toImage: string,
): ExactImageEvidence {
  return {
    version: 1,
    generatedAt: "2026-08-27T01:00:00.000Z",
    capsuleId,
    fromImage,
    toImage,
    baseline: {
      artifact: `sha256:${"1".repeat(64)}`,
      recordedScore: 0.25,
      reproducedScores: [0.25, 0.25, 0.25],
    },
    settledCandidate: {
      artifact: `sha256:${"2".repeat(64)}`,
      recordedScore: 0.5,
      reproducedScores: [0.5, 0.5, 0.5],
    },
    tripwires: [{ name: "capsule determinism and shortcut tripwires", passed: true }],
    modelCalls: 0,
    result: "passed",
  };
}

function writeEvidence(
  root: string,
  value: CampaignImageEquivalenceEvidenceV1,
  name = "image-equivalence.v1.json",
): string {
  return writeRawEvidence(root, value, name);
}

function writeRawEvidence(root: string, value: unknown, name: string): string {
  const path = join(root, "evidence", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function rehash(record: CampaignImageRepinV1): void {
  const { recordDigest: _recordDigest, ...body } = record;
  record.recordDigest = campaignImageRepinRecordDigest(body);
}
function initializeGitRoot(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "repin-test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Repin Test"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "campaign-frozen.json\nevidence/\n.hone-runs/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
}

function commandIo(root: string, lines: { out: string[]; err: string[] }): CmdIo {
  return {
    root,
    env: { ...process.env, USER: "repin-test-operator" },
    isTTY: false,
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
  };
}


describe("campaign repin-image", () => {
  test("re-pins one capsule under the campaign lock with exact evidence and append-only identity", () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    const before = syntheticFrozenCampaign();
    const configHash = metaCampaignConfigHash(before);
    const capsule = before.train[0]!;
    const evidencePath = writeEvidence(root, evidence(capsule.capsuleId, capsule.image, TO_IMAGE));
    writeFileSync(campaignPath, `${JSON.stringify(before, null, 2)}\n`);

    const registeredPath = join(
      root,
      ".hone-runs",
      `recursive-cell-${configHash.slice("sha256:".length)}`,
      "campaign.json",
    );
    mkdirSync(dirname(registeredPath), { recursive: true });
    writeFileSync(registeredPath, `${JSON.stringify(before, null, 2)}\n`);

    const result = repinCampaignImage({
      root,
      capsulesRoot: join(root, "capsules"),
      campaignPath,
      capsuleId: capsule.capsuleId,
      fromImage: capsule.image,
      toImage: TO_IMAGE,
      evidencePath,
      reason: "the original image is unavailable; exact replay equivalence passed",
      at: "2026-08-27T01:01:00.000Z",
      operator: "repin-test",
    });

    const after = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    const registered = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(registeredPath, "utf8")));
    expect(result.configHash).toBe(configHash);
    expect(metaCampaignConfigHash(after)).toBe(configHash);
    expect(campaignRecordExtends(before, after)).toBe(true);
    expect(registered).toEqual(after);
    expect(after.train.find((entry) => entry.capsuleId === capsule.capsuleId)?.image).toBe(TO_IMAGE);
    expect(campaignAdmittedCapsuleImage(after, capsule.capsuleId, TO_IMAGE)).toBe(capsule.image);
    expect(after.developmentPanel.members.find((member) => member.capsule.capsuleId === capsule.capsuleId)?.capsule.image)
      .toBe(TO_IMAGE);
    expect(after.imageRepinJournal?.repins[0]).toMatchObject({
      capsuleId: capsule.capsuleId,
      fromImage: capsule.image,
      toImage: TO_IMAGE,
      evidenceSha256: `sha256:${createHash("sha256").update(readFileSync(evidencePath)).digest("hex")}`,
      previousRecordDigest: null,
    });
    expect(() => assertCampaignImageRepinOnly(before, after, capsule.capsuleId)).not.toThrow();
  });

  test("resolves a repinned installed capsule at its new execution image and original identity", () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    // The last development slot is bound to an installed synthetic capsule.
    const installed = installCampaignCapsule(syntheticFrozenCampaign(), {
      root,
      capsulesRoot: join(root, "capsules"),
      trainIndex: 5,
    });
    const before = installed.config;
    const registered = before.train[5]!;
    const capsuleDir = installed.dir;
    const manifest = CapsuleManifest.parse(JSON.parse(
      readFileSync(join(capsuleDir, "manifest.json"), "utf8"),
    ));
    const admitted: AdmittedCapsule = {
      manifest,
      digest: capsuleDigest(manifest),
      orderingReport: DiagnosticOrderingReport.parse(JSON.parse(
        readFileSync(join(capsuleDir, manifest.diagnosticOrdering.path), "utf8"),
      )),
      approval: null,
      provisional: false,
    };
    expect(admitted.digest).toBe(registered.capsuleDigest);
    expect(capsuleOracleDigest(admitted)).toBe(registered.oracleDigest);
    expect(capsuleScalarizerDigest(admitted)).toBe(registered.scalarizerDigest);

    const evidencePath = writeEvidence(
      root,
      evidence(registered.capsuleId, registered.image, TO_IMAGE),
    );
    writeFileSync(campaignPath, `${JSON.stringify(before, null, 2)}\n`);
    repinCampaignImage({
      root,
      capsulesRoot: join(root, "capsules"),
      campaignPath,
      capsuleId: registered.capsuleId,
      fromImage: registered.image,
      toImage: TO_IMAGE,
      evidencePath,
      reason: "resolution regression",
      at: "2026-08-27T01:01:30.000Z",
    });
    const repinned = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    const current = repinned.train.find((entry) => entry.capsuleId === registered.capsuleId)!;
    const location = resolveRegisteredCapsuleLocation(
      repinned,
      current,
      { dir: capsuleDir, admitted },
    );
    expect(location.executionImage).toBe(TO_IMAGE);

    const forged = structuredClone(repinned);
    delete forged.imageRepinJournal;
    expect(() => resolveRegisteredCapsuleLocation(
      forged,
      forged.train.find((entry) => entry.capsuleId === registered.capsuleId)!,
      { dir: capsuleDir, admitted },
    )).toThrow("identity drift");
  });

  test("refuses missing, mismatched, and nondeterministic equivalence evidence before mutation", () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    const before = syntheticFrozenCampaign();
    const capsule = before.train[0]!;
    writeFileSync(campaignPath, `${JSON.stringify(before, null, 2)}\n`);
    const request = {
      root,
      capsulesRoot: join(root, "capsules"),
      campaignPath,
      capsuleId: capsule.capsuleId,
      fromImage: capsule.image,
      toImage: TO_IMAGE,
      reason: "equivalence gate",
      at: "2026-08-27T01:02:00.000Z",
    } as const;

    expect(() => repinCampaignImage({ ...request, evidencePath: join(root, "missing.json") }))
      .toThrow("--evidence must name an existing regular file");

    const wrongIdentity = writeEvidence(root, evidence(capsule.capsuleId, capsule.image, NEXT_IMAGE));
    expect(() => repinCampaignImage({ ...request, evidencePath: wrongIdentity }))
      .toThrow("evidence identity does not match");

    const nondeterministic = evidence(capsule.capsuleId, capsule.image, TO_IMAGE);
    nondeterministic.baseline.reproducedScores[2] = 0.251;
    const nondeterministicPath = writeEvidence(root, nondeterministic);
    expect(() => repinCampaignImage({ ...request, evidencePath: nondeterministicPath }))
      .toThrow("does not exactly match recorded score");
    expect(readFileSync(campaignPath, "utf8")).toBe(`${JSON.stringify(before, null, 2)}\n`);

    const twoReplays = structuredClone(evidence(capsule.capsuleId, capsule.image, TO_IMAGE)) as {
      baseline: { reproducedScores: number[] };
    };
    twoReplays.baseline.reproducedScores = [0.25, 0.25];
    expect(() => repinCampaignImage({
      ...request,
      evidencePath: writeRawEvidence(root, twoReplays, "two-replays.json"),
    })).toThrow("invalid image equivalence evidence");

    const modelCall = {
      ...evidence(capsule.capsuleId, capsule.image, TO_IMAGE),
      modelCalls: 1,
    };
    expect(() => repinCampaignImage({
      ...request,
      evidencePath: writeRawEvidence(root, modelCall, "model-call.json"),
    })).toThrow("invalid image equivalence evidence");

    const failedTripwire = {
      ...evidence(capsule.capsuleId, capsule.image, TO_IMAGE),
      tripwires: [{ name: "determinism", passed: false }],
    };
    expect(() => repinCampaignImage({
      ...request,
      evidencePath: writeRawEvidence(root, failedTripwire, "failed-tripwire.json"),
    })).toThrow("invalid image equivalence evidence");

    const otherCapsuleEvidence = evidence(before.train[1]!.capsuleId, capsule.image, TO_IMAGE);
    expect(() => repinCampaignImage({
      ...request,
      evidencePath: writeRawEvidence(root, otherCapsuleEvidence, "other-capsule.json"),
    })).toThrow("evidence identity does not match");

    expect(() => repinCampaignImage({
      ...request,
      toImage: capsule.image,
      evidencePath: wrongIdentity,
    })).toThrow("requires different --from-image and --to-image");
  });

  test("exposes the evidence-required operator command with the documented flags", async () => {
    const root = makeRoot();
    initializeGitRoot(root);
    const campaignPath = join(root, "campaign-frozen.json");
    const before = syntheticFrozenCampaign();
    const capsule = before.train[0]!;
    const evidencePath = writeEvidence(root, evidence(capsule.capsuleId, capsule.image, TO_IMAGE));
    writeFileSync(campaignPath, `${JSON.stringify(before, null, 2)}\n`);
    const lines = { out: [] as string[], err: [] as string[] };
    const args = [
      "campaign",
      "repin-image",
      "--campaign",
      campaignPath,
      "--capsule",
      capsule.capsuleId,
      "--from-image",
      capsule.image,
      "--to-image",
      TO_IMAGE,
      "--reason",
      "equivalence-gated replacement",
    ];
    expect(await main(args, commandIo(root, lines))).toBe(2);
    expect(lines.err.join("\n")).toContain("usage: hone campaign repin-image");

    lines.err.length = 0;
    args.push("--evidence", evidencePath);
    expect(await main(args, commandIo(root, lines))).toBe(0);
    expect(JSON.parse(lines.out.at(-1)!).command).toBe("campaign.repin-image");
  });

  test("authenticates record digests, continuity, frozen fields, and lock serialization", () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    const before = syntheticFrozenCampaign();
    const capsule = before.train[0]!;
    const evidencePath = writeEvidence(root, evidence(capsule.capsuleId, capsule.image, TO_IMAGE));
    writeFileSync(campaignPath, `${JSON.stringify(before, null, 2)}\n`);
    const request = {
      root,
      capsulesRoot: join(root, "capsules"),
      campaignPath,
      capsuleId: capsule.capsuleId,
      fromImage: capsule.image,
      toImage: TO_IMAGE,
      evidencePath,
      reason: "equivalence gate",
      at: "2026-08-27T01:03:00.000Z",
    } as const;

    const held = acquireCampaignRecordLock(campaignPath);
    try {
      expect(() => repinCampaignImage(request)).toThrow("campaign record is locked");
    } finally {
      held.release();
    }
    repinCampaignImage(request);
    const migrated = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));

    const changedReason = structuredClone(migrated);
    changedReason.imageRepinJournal!.repins[0]!.reason = "tampered";
    expect(() => metaCampaignConfigHash(changedReason)).toThrow("record digest mismatch");

    const receiptDir = join(root, "phase-receipts");
    mkdirSync(receiptDir, { recursive: true });
    const receipt = JSON.parse(readFileSync(
      recursivePhaseReceipt(receiptDir, "search", migrated, {}),
      "utf8",
    ));
    expect(receipt.imageRepinJournal).toEqual(migrated.imageRepinJournal);
    expect(trajectoryCampaignJournals(migrated).imageRepinJournal)
      .toEqual(migrated.imageRepinJournal);

    const staleEvidencePath = writeEvidence(
      root,
      evidence(capsule.capsuleId, capsule.image, NEXT_IMAGE),
      "image-equivalence-stale.v1.json",
    );
    expect(() => repinCampaignImage({
      ...request,
      toImage: NEXT_IMAGE,
      evidencePath: staleEvidencePath,
    })).toThrow("does not exactly match capsule");

    const forgedTarget = structuredClone(migrated);
    forgedTarget.imageRepinJournal!.repins[0]!.toImage = NEXT_IMAGE;
    rehash(forgedTarget.imageRepinJournal!.repins[0]!);
    expect(() => metaCampaignConfigHash(forgedTarget)).toThrow("provenance is discontinuous");

    const divergentHistory = structuredClone(migrated);
    divergentHistory.imageRepinJournal!.repins[0]!.reason = "same length, divergent history";
    rehash(divergentHistory.imageRepinJournal!.repins[0]!);
    expect(campaignRecordExtends(migrated, divergentHistory)).toBe(false);

    const noOpJournal = structuredClone(migrated);
    noOpJournal.train[0]!.image = capsule.image;
    noOpJournal.developmentPanel.members[0]!.capsule.image = capsule.image;
    noOpJournal.imageRepinJournal!.repins[0]!.toImage = capsule.image;
    rehash(noOpJournal.imageRepinJournal!.repins[0]!);
    expect(() => metaCampaignConfigHash(noOpJournal)).toThrow("must change the pinned image");

    const alteredOriginal = structuredClone(migrated);
    alteredOriginal.imageRepinJournal!.repins[0]!.fromImage = NEXT_IMAGE;
    rehash(alteredOriginal.imageRepinJournal!.repins[0]!);
    expect(() => metaCampaignConfigHash(alteredOriginal))
      .toThrow("altered frozen fields outside the sanctioned image reference");

    const nextEvidencePath = writeEvidence(
      root,
      evidence(capsule.capsuleId, TO_IMAGE, NEXT_IMAGE),
      "image-equivalence-next.v1.json",
    );
    repinCampaignImage({
      ...request,
      fromImage: TO_IMAGE,
      toImage: NEXT_IMAGE,
      evidencePath: nextEvidencePath,
      at: "2026-08-27T01:04:00.000Z",
    });
    const twiceMigrated = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    const brokenChain = structuredClone(twiceMigrated);
    brokenChain.imageRepinJournal!.repins[1]!.previousRecordDigest = null;
    rehash(brokenChain.imageRepinJournal!.repins[1]!);
    expect(() => metaCampaignConfigHash(brokenChain)).toThrow("record chain is not append-only");

    const other = migrated.train[1]!;
    const alteredFrozenField = structuredClone(migrated);
    alteredFrozenField.train[1]!.image = NEXT_IMAGE;
    const panelMember = alteredFrozenField.developmentPanel.members
      .find((member) => member.capsule.capsuleId === other.capsuleId)!;
    panelMember.capsule.image = NEXT_IMAGE;
    expect(() => assertCampaignImageRepinOnly(migrated, alteredFrozenField, capsule.capsuleId))
      .toThrow("attempted to alter frozen campaign fields");

    const removed = structuredClone(migrated);
    removed.imageRepinJournal!.repins.length = 0;
    expect(() => MetaCampaignConfigV2.parse(removed)).toThrow();
    expect(campaignRecordExtends(migrated, before)).toBe(false);
  });

  test("composes with later source migration and closure capture without changing campaign identity", async () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    const before = syntheticFrozenCampaign();
    const configHash = metaCampaignConfigHash(before);
    const capsule = before.train[0]!;
    const evidencePath = writeEvidence(root, evidence(capsule.capsuleId, capsule.image, TO_IMAGE));
    writeFileSync(campaignPath, `${JSON.stringify(before, null, 2)}\n`);
    repinCampaignImage({
      root,
      capsulesRoot: join(root, "capsules"),
      campaignPath,
      capsuleId: capsule.capsuleId,
      fromImage: capsule.image,
      toImage: TO_IMAGE,
      evidencePath,
      reason: "compose image first",
      at: "2026-08-27T01:10:00.000Z",
    });

    const nextCommit = "f".repeat(40);
    const nextBootDigest = `sha256:${"9".repeat(64)}` as const;
    await migrateCampaignSource({
      root,
      campaignPath,
      from: before.trustedRuntime.sourceCommit,
      to: nextCommit,
      reason: "compose source second",
      at: "2026-08-27T01:11:00.000Z",
      bootDigest: nextBootDigest,
    });
    const migrated = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    expect(migrated.imageRepinJournal?.repins).toHaveLength(1);
    expect(migrated.sourceMigrationJournal?.migrations).toHaveLength(1);
    expect(metaCampaignConfigHash(migrated)).toBe(configHash);

    const closureBody = {
      version: 1,
      at: "2026-08-27T01:12:00.000Z",
      sourceCommit: nextCommit,
      bootDigest: `sha256:${"8".repeat(64)}`,
      campaignBootDigest: nextBootDigest,
      optimizerImage: migrated.optimizerRuntime.image,
      optimizerBaseDigest: migrated.seedOptimizer.bundleDigest,
      closureDigest: `sha256:${"7".repeat(64)}`,
      manifestArtifact: `sha256:${"6".repeat(64)}`,
      fileCount: 0,
      totalBytes: 0,
      previousRecordDigest: null,
    } as const;
    const closure = {
      ...closureBody,
      recordDigest: campaignRuntimeClosureRecordDigest(closureBody),
    } satisfies CampaignRuntimeClosureCaptureV1;
    const held = acquireCampaignRecordLock(campaignPath);
    try {
      appendRuntimeClosureCaptureRecord(campaignPath, closure, held.lock);
    } finally {
      held.release();
    }
    const composed = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    expect(composed.imageRepinJournal?.repins).toHaveLength(1);
    expect(composed.sourceMigrationJournal?.migrations).toHaveLength(1);
    expect(composed.runtimeClosureJournal?.captures).toHaveLength(1);
    expect(metaCampaignConfigHash(composed)).toBe(configHash);
  });

});
