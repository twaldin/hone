import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapsuleManifest,
  DiagnosticOrderingReport,
  capsuleDigest,
  deriveCapsuleId,
} from "@hone/schema";
import { afterEach, describe, expect, it } from "vitest";
import { loadDiagnosticOrdering, scaffold } from "../tools/scaffold.js";

const CAPSULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASK_DIR = join(CAPSULES_DIR, "seeded-astar");
const REPORT_REL = "diagnostics/ordering-report.json";
const PINNED_IMAGE =
  "hone-mutation@sha256:3d790d856bdf214c1e0d3ac60af139bd806bef67c13930950cc745bf8379b01d";

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Copy the whole capsule tree so tamper tests never touch the real one. */
function cloneTaskDir(): string {
  const clone = mkdtempSync(join(tmpdir(), "hone-scaffold-test-"));
  temporaryDirs.push(clone);
  cpSync(TASK_DIR, clone, { recursive: true });
  return clone;
}

describe("scaffold(seeded-astar)", () => {
  it("produces a zod-valid v2 manifest with a reproducible content-addressed id", () => {
    const first = scaffold(TASK_DIR);
    const second = scaffold(TASK_DIR);
    expect(second.id).toBe(first.id);
    expect(first.schemaVersion).toBe(2);

    // What landed on disk is the validated manifest, and re-deriving the id
    // from the written file round-trips via the canonical schema helpers.
    const written = CapsuleManifest.parse(
      JSON.parse(readFileSync(join(TASK_DIR, "manifest.json"), "utf8")),
    );
    expect(written).toEqual(first);
    expect(deriveCapsuleId(written)).toBe(written.id);
    expect(capsuleDigest(written)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("re-running over the unchanged tree is byte-identical", () => {
    scaffold(TASK_DIR);
    const first = readFileSync(join(TASK_DIR, "manifest.json"));
    scaffold(TASK_DIR);
    expect(readFileSync(join(TASK_DIR, "manifest.json")).equals(first)).toBe(true);
  });

  it("covers every asset-group file with a content hash", () => {
    const manifest = scaffold(TASK_DIR);
    const hashed = Object.keys(manifest.contentHashes).sort();
    const referenced = manifest.assetGroups.flatMap((g) => g.paths).sort();
    expect(hashed).toEqual(referenced);
    expect(referenced.length).toBe(14); // 6 train + 4 validation + 4 holdout
  });

  it("pins the diagnostic-ordering report by path and exact byte hash", () => {
    const manifest = scaffold(TASK_DIR);
    expect(manifest.diagnosticOrdering.path).toBe(REPORT_REL);
    expect(manifest.image).toBe(PINNED_IMAGE);
    const bytes = readFileSync(join(TASK_DIR, REPORT_REL));
    expect(manifest.diagnosticOrdering.hash).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
    // The pinned report itself is schema-valid and clean.
    const report = DiagnosticOrderingReport.parse(JSON.parse(bytes.toString("utf8")));
    expect(report.failures).toEqual([]);
  });
});

describe("tamper rejection", () => {
  it("tampering the report changes its hash and the derived capsule id", () => {
    const original = scaffold(TASK_DIR);
    const clone = cloneTaskDir();
    const reportPath = join(clone, REPORT_REL);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.stability.aggregates[0] += 0.001;
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

    const tampered = scaffold(clone);
    expect(tampered.diagnosticOrdering.hash).not.toBe(original.diagnosticOrdering.hash);
    expect(tampered.id).not.toBe(original.id);
  });

  it("refuses a report that fails the schema", () => {
    const clone = cloneTaskDir();
    const reportPath = join(clone, REPORT_REL);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    delete report.variants.shortcut;
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
    expect(() => scaffold(clone)).toThrow();
  });

  it("refuses a report that records ordering failures", () => {
    const clone = cloneTaskDir();
    const reportPath = join(clone, REPORT_REL);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.failures = ["broken(0.9) < naive(0.1)"];
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
    expect(() => scaffold(clone)).toThrow(/failures/);
  });

  it("refuses a missing report", () => {
    const clone = cloneTaskDir();
    rmSync(join(clone, REPORT_REL));
    expect(() => scaffold(clone)).toThrow(/ordering report missing/);
  });

  it("refuses a mutable image tag — digest pinning is schema law", () => {
    const clone = cloneTaskDir();
    const configPath = join(clone, "capsule.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.image = "hone-mutation:latest";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(() => scaffold(clone)).toThrow();
  });

  it("a tampered committed manifest no longer derives its own id", () => {
    const manifest = CapsuleManifest.parse(
      JSON.parse(readFileSync(join(TASK_DIR, "manifest.json"), "utf8")),
    );
    expect(deriveCapsuleId(manifest)).toBe(manifest.id);
    expect(
      deriveCapsuleId({ ...manifest, image: `hone-mutation@sha256:${"f".repeat(64)}` }),
    ).not.toBe(manifest.id);
    expect(
      deriveCapsuleId({
        ...manifest,
        diagnosticOrdering: { ...manifest.diagnosticOrdering, hash: `sha256:${"e".repeat(64)}` },
      }),
    ).not.toBe(manifest.id);
  });
});

describe("loadDiagnosticOrdering", () => {
  it("returns the capsule-relative path plus the sha256 of the exact bytes", () => {
    const ref = loadDiagnosticOrdering(TASK_DIR, REPORT_REL);
    const bytes = readFileSync(join(TASK_DIR, REPORT_REL));
    expect(ref).toEqual({
      path: REPORT_REL,
      hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  });
});
