import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CapsuleManifest, deriveCapsuleId } from "@hone/schema";
import { describe, expect, it } from "vitest";
import { admitCapsule } from "../../trusted/cli/src/admission.js";
import { assertBaselineMatchesGitCommit } from "../../trusted/cli/src/git-baseline.js";
import { loadDiagnosticOrdering } from "../tools/scaffold.js";
const root = resolve(__dirname, "..");
const names = ["postings-intersection", "sequence-diff", "weighted-coverage", "online-cache"];
const approvedImage = JSON.parse(readFileSync(join(root, "seeded-astar/manifest.json"), "utf8")).image;

describe("fresh calibration-only capsule authoring", () => {
  it("preserves pinned baseline/asset identities outside both cohorts without permitting draft admission", () => {
    const contracts = readdirSync(join(root, "contracts")).map((name) => JSON.parse(readFileSync(join(root, "contracts", name), "utf8")));
    const cohortNames = new Set(contracts.map((contract) => contract.capsule));
    const cohortIds = new Set(contracts.map((contract) => contract.source.existingCapsuleId));
    const ids = new Set<string>();
    for (const name of names) {
      const directory = join(root, `calibration-${name}`);
      const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(directory, "manifest.draft.json"), "utf8")));
      expect(manifest.id).toBe(deriveCapsuleId(manifest));
      expect(ids.has(manifest.id)).toBe(false);
      ids.add(manifest.id);
      expect(cohortNames.has(`calibration-${name}`)).toBe(false);
      expect(cohortIds.has(manifest.id)).toBe(false);
      expect(existsSync(join(directory, "manifest.json"))).toBe(false);
      expect(manifest.image).toBe(approvedImage);
      if (manifest.baseline.kind !== "git") throw new Error("expected pinned Git baseline");
      assertBaselineMatchesGitCommit(join(directory, "baseline"), manifest.baseline.commit);
      for (const [path, hash] of Object.entries(manifest.contentHashes)) {
        expect(`sha256:${createHash("sha256").update(readFileSync(join(directory, path))).digest("hex")}`).toBe(hash);
      }
      expect(() => loadDiagnosticOrdering(directory, manifest.diagnosticOrdering.path)).toThrow();
      // Even copying a draft to the active filename cannot turn offline
      // observations into evidence accepted by the existing admission gate.
      const isolated = mkdtempSync(join(tmpdir(), "hone-calibration-admission-"));
      try {
        cpSync(directory, isolated, { recursive: true });
        writeFileSync(join(isolated, "manifest.json"), JSON.stringify(manifest));
        expect(() => admitCapsule(isolated, { review: "off" })).toThrow();
      } finally {
        rmSync(isolated, { recursive: true, force: true });
      }
    }
  });

  it("checks exact outputs, hard bounds, online transitions, fixtures and worker protocol", () => {
    execFileSync("python3", ["-I", "-B", join(root, "test/calibration_checks.py")], { timeout: 120_000, stdio: "pipe" });
  }, 130_000);

  it("prevents confined same-UID workers from signalling each other", () => {
    execFileSync("docker", [
      "run", "--rm", "--pull", "never", "--network", "none", "--memory", "2g", "--cpus", "2",
      "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL",
      "--security-opt", "no-new-privileges", "--security-opt", "seccomp=unconfined",
      "--read-only", "--tmpfs", "/tmp:size=16m,nosuid,nodev,noexec", "--user", "0:0",
      "-v", `${root}:/capsules:ro`, approvedImage,
      "python3", "-I", "-B", "/capsules/test/calibration_signal_check.py",
    ], { timeout: 30_000, stdio: "pipe" });
  }, 40_000);
});
