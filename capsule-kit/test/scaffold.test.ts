import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/capsule-kit/scaffold-capsule");
const REPORT_REL = "diagnostics/ordering-report.json";
const PINNED_IMAGE = `hone-test@sha256:${"a".repeat(64)}`;

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Copy the fixture capsule and give its baseline a committed git store. */
function taskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hone-scaffold-test-"));
  temporaryDirs.push(dir);
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: join(dir, "baseline"), stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=Scaffold Test", "-c", "user.email=scaffold@example.invalid", "commit", "-qm", "baseline");
  return dir;
}

/** Copy a prepared task dir (baseline store included) so tamper tests leave the original intact. */
function cloneTaskDir(source: string): string {
  const clone = mkdtempSync(join(tmpdir(), "hone-scaffold-clone-"));
  temporaryDirs.push(clone);
  cpSync(source, clone, { recursive: true });
  return clone;
}

describe("scaffold", () => {
  it("produces a zod-valid v2 manifest with a reproducible content-addressed id", () => {
    const dir = taskDir();
    const first = scaffold(dir);
    const second = scaffold(dir);
    expect(second.id).toBe(first.id);
    expect(first.schemaVersion).toBe(2);

    // What landed on disk is the validated manifest, and re-deriving the id
    // from the written file round-trips via the canonical schema helpers.
    const written = CapsuleManifest.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
    expect(written).toEqual(first);
    expect(deriveCapsuleId(written)).toBe(written.id);
    expect(capsuleDigest(written)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("re-running over the unchanged tree is byte-identical", () => {
    const dir = taskDir();
    scaffold(dir);
    const first = readFileSync(join(dir, "manifest.json"));
    scaffold(dir);
    expect(readFileSync(join(dir, "manifest.json")).equals(first)).toBe(true);
  });

  it("covers every asset-group file with a content hash", () => {
    const manifest = scaffold(taskDir());
    const hashed = Object.keys(manifest.contentHashes).sort();
    const referenced = manifest.assetGroups.flatMap((g) => g.paths).sort();
    expect(hashed).toEqual(referenced);
    expect(referenced).toEqual([
      "assets/holdout/a.json",
      "assets/train/a.json",
      "assets/train/b.json",
      "assets/validation/a.json",
    ]);
  });

  it("pins the diagnostic-ordering report by path and exact byte hash", () => {
    const dir = taskDir();
    const manifest = scaffold(dir);
    expect(manifest.diagnosticOrdering.path).toBe(REPORT_REL);
    expect(manifest.image).toBe(PINNED_IMAGE);
    const bytes = readFileSync(join(dir, REPORT_REL));
    expect(manifest.diagnosticOrdering.hash).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    const report = DiagnosticOrderingReport.parse(JSON.parse(bytes.toString("utf8")));
    expect(report.failures).toEqual([]);
  });
});

describe("tamper rejection", () => {
  it("tampering the report changes its hash and the derived capsule id", () => {
    const dir = taskDir();
    const original = scaffold(dir);
    const clone = cloneTaskDir(dir);
    const reportPath = join(clone, REPORT_REL);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.stability.aggregates[0] += 0.001;
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`);

    const tampered = scaffold(clone);
    expect(tampered.diagnosticOrdering.hash).not.toBe(original.diagnosticOrdering.hash);
    expect(tampered.id).not.toBe(original.id);
  });

  it("refuses a report that fails the schema", () => {
    const clone = taskDir();
    const reportPath = join(clone, REPORT_REL);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    delete report.variants.shortcut;
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
    expect(() => scaffold(clone)).toThrow();
  });

  it("refuses a report that records ordering failures", () => {
    const clone = taskDir();
    const reportPath = join(clone, REPORT_REL);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.failures = ["broken(0.9) < naive(0.1)"];
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
    expect(() => scaffold(clone)).toThrow(/failures/);
  });

  it("refuses a missing report", () => {
    const clone = taskDir();
    rmSync(join(clone, REPORT_REL));
    expect(() => scaffold(clone)).toThrow(/ordering report missing/);
  });

  it("refuses a mutable image tag — digest pinning is schema law", () => {
    const clone = taskDir();
    const configPath = join(clone, "capsule.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.image = "hone-test:latest";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(() => scaffold(clone)).toThrow();
  });

  it("a tampered manifest no longer derives its own id", () => {
    const manifest = scaffold(taskDir());
    expect(deriveCapsuleId(manifest)).toBe(manifest.id);
    expect(deriveCapsuleId({ ...manifest, image: `hone-test@sha256:${"f".repeat(64)}` })).not.toBe(manifest.id);
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
    const ref = loadDiagnosticOrdering(FIXTURE_DIR, REPORT_REL);
    const bytes = readFileSync(join(FIXTURE_DIR, REPORT_REL));
    expect(ref).toEqual({
      path: REPORT_REL,
      hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  });
});
