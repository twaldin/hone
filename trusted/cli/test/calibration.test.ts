import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdmissionReceiptRecord,
  CapsuleManifest,
  DiagnosticOrderingReport,
  admissionReceiptRecordHash,
  capsuleDigest,
  deriveCapsuleId,
  type AdmissionReceiptRecordBody,
} from "@hone/schema";
import { describe, expect, it, vi } from "vitest";
import { admitCapsule, type AdmittedCapsule } from "../src/admission.js";
import { buildCalibrationPlan, calibrationCommand } from "../src/commands/calibration.js";
import type { CmdIo } from "../src/io.js";

const digest = (label: string): `sha256:${string}` =>
  `sha256:${Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64)}`;

function approvedReceipt(capsuleDigestValue: string): AdmissionReceiptRecord {
  const identities = {
    author: { kind: "agent" as const, identity: "calibration-author" },
    "adversarial-validator": { kind: "agent" as const, identity: "calibration-validator" },
    "final-reviewer": { kind: "owner" as const, identity: "calibration-owner" },
  };
  const body: AdmissionReceiptRecordBody = {
    v: 1,
    sequence: 1,
    previousReceiptHash: digest("gate1"),
    capsuleDigest: capsuleDigestValue,
    action: "gate2-approve",
    identities,
    provisional: false,
    timestamp: "2026-08-12T00:00:00.000Z",
  };
  return AdmissionReceiptRecord.parse({ ...body, recordHash: admissionReceiptRecordHash(body) });
}

function admitted(index: number): AdmittedCapsule {
  const orderingReport = DiagnosticOrderingReport.parse({
    version: 1,
    variants: {
      broken: { train: 0, validation: 0, combined: 0, trainTestsPass: false, validationTestsPass: false },
      naive: { train: 0.1, validation: 0.1, combined: 0.1, trainTestsPass: true, validationTestsPass: true },
      baseline: { train: 0.2, validation: 0.2, combined: 0.2, trainTestsPass: true, validationTestsPass: true },
      shortcut: { train: 0.3, validation: 0.1, combined: 0.2, trainTestsPass: true, validationTestsPass: false },
      improved: { train: 0.4, validation: 0.4, combined: 0.4, trainTestsPass: true, validationTestsPass: true },
    },
    stability: { aggregates: [0.2, 0.2, 0.2], spread: 0, band: 0.15 },
    failures: [],
  });
  const sansId = {
    schemaVersion: 2 as const,
    objective: `independent calibration task ${index}`,
    baseline: { kind: "cas" as const, hash: digest(`baseline-${index}`) },
    image: `hone-calibration-runtime@${digest("image")}`,
    evalEntrypoint: ["python3", "/opt/hone/eval.py"],
    protectedPaths: ["challenge.json"],
    assetGroups: [
      { id: "train", visibility: "public" as const, paths: ["assets/train/cases.json"] },
      { id: "validation", visibility: "protected" as const, paths: ["assets/validation/cases.json"] },
    ],
    budget: { maxTokens: 12_000_000, maxUsd: 25, maxWallClockSec: 10_800, maxEvaluatorInvocations: 200 },
    diagnosticOrdering: { path: "diagnostics/ordering-report.json", hash: digest(`ordering-${index}`) },
    contentHashes: {
      "assets/train/cases.json": digest(`train-${index}`),
      "assets/validation/cases.json": digest(`validation-${index}`),
    },
    meta: { provenance: `clean-room calibration-only fixture ${index}` },
  };
  const manifest = CapsuleManifest.parse({ ...sansId, id: deriveCapsuleId(sansId) });
  const fullDigest = capsuleDigest(manifest);
  return {
    manifest,
    digest: fullDigest,
    orderingReport,
    approval: { approved: true, provisional: false, receipt: approvedReceipt(fullDigest) },
    provisional: false,
  };
}

function dependencies(capsules: readonly AdmittedCapsule[]) {
  const byDir = new Map(capsules.map((capsule, index) => [`calibration-${index}`, capsule]));
  return {
    admit: ((dir: string) => {
      const capsule = byDir.get(dir.split("/").at(-1) ?? "");
      if (capsule === undefined) throw new Error(`unknown fixture capsule ${dir}`);
      return capsule;
    }) as typeof admitCapsule,
    inspectImage: (reference: string) => ({ reference, id: digest("image-id"), os: "linux" as const, architecture: "amd64" as const }),
    prepareOptimizer: async (_root: string, images: readonly string[]) => ({
      sourceCommit: "a".repeat(40),
      trustedRuntimeDigest: digest("runtime"),
      sourceArtifact: digest("optimizer-artifact"),
      baseSnapshot: { files: new Map() },
      bundleDigests: new Map(images.map((image) => [image, digest("optimizer-bundle")])),
    }),
  };
}

function selection() {
  return {
    version: 1,
    capsuleDirs: [
      "capsules/calibration-3",
      "capsules/calibration-1",
      "capsules/calibration-0",
      "capsules/calibration-2",
    ],
    episodeCaps: [12, 2, 8, 4],
    seeds: [55, 11, 44, 22, 33],
    bootstrap: { rngSeed: 1234, samples: 500 },
  };
}

describe("trusted calibration coordinator", () => {
  it("canonically plans the exact 4 x 4 x 5 ladder with per-cell episode caps", async () => {
    const root = mkdtempSync(join(tmpdir(), "hone-calibration-plan-"));
    mkdirSync(join(root, "capsules"), { recursive: true });
    const capsules = [admitted(0), admitted(1), admitted(2), admitted(3)];
    const first = await buildCalibrationPlan(root, selection(), dependencies(capsules));
    const second = await buildCalibrationPlan(root, selection(), dependencies(capsules));

    expect(first.plan).toEqual(second.plan);
    expect(first.plan.cells).toHaveLength(80);
    expect(first.plan.selection.episodeCaps).toEqual([2, 4, 8, 12]);
    expect(first.plan.selection.seeds).toEqual([11, 22, 33, 44, 55]);
    expect(new Set(first.plan.cells.map((cell) => cell.childRunId))).toHaveLength(80);
    for (const cell of first.plan.cells) {
      expect(cell.measurementEpoch).toContain(cell.workKey.slice("sha256:".length));
      expect(cell.budget).toEqual({ maxTokens: 12_000_000, maxUsd: 25, maxWallClockSec: 10_800, maxEvaluatorInvocations: 200 });
    }
  });

  it("runs the trusted CLI dry structure end to end without preflight or model calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "hone-calibration-cli-"));
    mkdirSync(join(root, "capsules"), { recursive: true });
    const campaignPath = join(root, "selection.json");
    writeFileSync(campaignPath, JSON.stringify(selection()));
    const out: string[] = [];
    const io: CmdIo = { root, env: {}, isTTY: false, out: (line) => out.push(line), err: vi.fn() };
    const deps = dependencies([admitted(0), admitted(1), admitted(2), admitted(3)]);
    const createProxy = vi.fn();

    await expect(calibrationCommand(
      ["--campaign", campaignPath, "--headless", "--dry-structure"],
      io,
      { ...deps, createProxy },
    )).resolves.toBe(0);

    expect(createProxy).not.toHaveBeenCalled();
    const event = JSON.parse(out.at(-1) ?? "{}");
    expect(event).toMatchObject({ type: "calibration-dry-structure", cells: 80, modelCalls: 0 });
    const dry = JSON.parse(readFileSync(join(event.stateDir, "dry-structure.json"), "utf8"));
    expect(dry.coordinates).toHaveLength(80);
    expect(dry.modelCalls).toBe(0);
  });

  it("rejects provisional approval, holdout assets, and Bun image reuse before planning cells", async () => {
    const root = mkdtempSync(join(tmpdir(), "hone-calibration-refusal-"));
    mkdirSync(join(root, "capsules"), { recursive: true });
    const base = [admitted(0), admitted(1), admitted(2), admitted(3)];
    const provisional = { ...base[0]!, provisional: true };
    await expect(buildCalibrationPlan(root, selection(), dependencies([provisional, ...base.slice(1)]))).rejects.toThrow(/non-provisional Gate-2/);

    const holdoutManifest = CapsuleManifest.parse({
      ...base[0]!.manifest,
      assetGroups: [{ id: "terminal", visibility: "holdout", paths: ["assets/train/cases.json"] }],
    });
    await expect(buildCalibrationPlan(root, selection(), dependencies([{ ...base[0]!, manifest: holdoutManifest }, ...base.slice(1)]))).rejects.toThrow(/terminal holdout/);

    const bunManifest = CapsuleManifest.parse({ ...base[0]!.manifest, image: `hone-bun-module-loader@${digest("bun")}` });
    await expect(buildCalibrationPlan(root, selection(), dependencies([{ ...base[0]!, manifest: bunManifest }, ...base.slice(1)]))).rejects.toThrow(/Bun runtime digest/);
  });
});
