import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capsuleDigest, deriveCapsuleId, type CapsuleManifest } from "@hone/schema";
import { describe, expect, it } from "vitest";

/**
 * Current cohort: 16 development and 11 terminal task contracts. Contract
 * source IDs identify historical inputs; current launch IDs come from
 * admitted manifests. Verify those two boundaries separately.
 */

const CONTRACT_DIR = join(__dirname, "..", "contracts");
const REPO_ROOT = join(__dirname, "..", "..");

const PANEL_A = ["OWN-T01", "OWN-T03", "OWN-T06", "OWN-T08", "OSS-T01", "OSS-T03", "OSS-T05", "OSS-T07"];
const PANEL_B = ["OWN-T02", "OWN-T04", "OWN-T05", "OWN-T07", "OSS-T02", "OSS-T04", "OSS-T06", "OSS-T08"];

interface Contract {
  contractVersion: number;
  taskId: string;
  capsule: string;
  cohort: "train" | "terminal";
  stratum: "owner" | "oss";
  panel: "A" | "B" | null;
  status: "existing-admitted" | "pending-authoring";
  objective: string;
  source: Record<string, string>;
  authoring: Record<string, string | null>;
  publication: string;
}

function loadAll(): Contract[] {
  return readdirSync(CONTRACT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(CONTRACT_DIR, f), "utf8")) as Contract);
}

describe("M2 task contracts", () => {
  const all = loadAll();
  const train = all.filter((c) => c.cohort === "train");
  const terminal = all.filter((c) => c.cohort === "terminal");

  it("has exactly 16 train and 11 terminal contracts with unique, matching task ids", () => {
    expect(train.length).toBe(16);
    expect(terminal.length).toBe(11);
    const ids = all.map((c) => c.taskId);
    expect(new Set(ids).size).toBe(27);
    for (const c of all) {
      expect(existsSync(join(CONTRACT_DIR, `${c.taskId}.json`))).toBe(true);
      expect(c.taskId).toMatch(/^(OWN|OSS)-[TH]\d\d$/);
      expect(c.cohort).toBe(c.taskId.includes("-T") ? "train" : "terminal");
      expect(c.stratum).toBe(c.taskId.startsWith("OWN") ? "owner" : "oss");
    }
  });

  it("has unique capsule names and unique source identities with no train/terminal overlap", () => {
    const capsules = all.map((c) => c.capsule);
    expect(new Set(capsules).size).toBe(27);
    // Source identity: existing capsule id, or repository@revision.
    const sources = all.map((c) => c.source.existingCapsuleId ?? `${c.source.repository}@${c.source.revision}`);
    expect(new Set(sources).size).toBe(27);
    // OSS terminal repositories never appear in any train source (repository-level holdout).
    const trainRepos = new Set(train.map((c) => c.source.repository).filter((r): r is string => r !== undefined));
    for (const c of terminal.filter((t) => t.stratum === "oss")) {
      const repo = c.source.repository;
      expect(repo).toBeDefined();
      expect(repo !== undefined && trainRepos.has(repo)).toBe(false);
    }
  });

  it("retains the approved owner and OSS composition of each cohort", () => {
    expect(train.filter((c) => c.stratum === "owner").length).toBe(8);
    expect(train.filter((c) => c.stratum === "oss").length).toBe(8);
    expect(terminal.filter((c) => c.stratum === "owner").length).toBe(4);
    expect(terminal.filter((c) => c.stratum === "oss").length).toBe(7);
  });

  it("freezes panels A and B as 4 owner + 4 OSS, disjoint, covering all 16 train tasks", () => {
    const a = train.filter((c) => c.panel === "A").map((c) => c.taskId).sort();
    const b = train.filter((c) => c.panel === "B").map((c) => c.taskId).sort();
    expect(a).toEqual([...PANEL_A].sort());
    expect(b).toEqual([...PANEL_B].sort());
    for (const c of terminal) expect(c.panel).toBeNull();
  });

  it("carries all required fields: pinned source, objective, authoring surfaces, publication", () => {
    for (const c of all) {
      expect(c.contractVersion).toBe(1);
      expect(c.objective.length).toBeGreaterThan(20);
      expect(c.publication).toMatch(/^(private-redacted|license-permitting-publishable|license-dependent)$/);
      expect(c.authoring.mutableSurface).toBeTruthy();
      expect(c.authoring.protectedSurface).toBeTruthy();
      if (c.source.existingCapsuleId === undefined) {
        // Pinned upstream revision: full 40-hex for OSS; owner baselines allow short refs.
        expect(c.source.repository).toBeTruthy();
        expect(c.source.revision).toMatch(c.stratum === "oss" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{7,40}$/);
      } else {
        expect(c.source.existingCapsuleId).toMatch(/^cap_[0-9a-f]{12}$/);
      }
      if (c.stratum === "oss") {
        expect(c.source.url).toContain(c.source.revision);
        expect(c.publication).toBe("license-permitting-publishable");
      }
    }
  });

  it("keeps development manifests and terminal source references distinct", () => {
    for (const c of all) {
      const filename = c.cohort === "terminal" ? "manifest.reference.json" : "manifest.json";
      const manifestPath = join(__dirname, "..", c.capsule, filename);
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CapsuleManifest;
      expect(manifest.id).toMatch(/^cap_[0-9a-f]{12}$/);
      if (c.cohort === "terminal") {
        expect(existsSync(join(__dirname, "..", c.capsule, "manifest.json"))).toBe(false);
      } else {
        expect(deriveCapsuleId(manifest)).toBe(manifest.id);
      }
    }
  });

  it("preserves the historical source IDs and supplied digests without re-labeling them as current admissions", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    let shallow: string;
    try {
      shallow = git("rev-parse", "--is-shallow-repository");
    } catch {
      throw new Error("Contract provenance tests require a full Git clone; see docs/getting-started.md");
    }
    expect(shallow, "Contract provenance tests require full Git history; see docs/getting-started.md").toBe("false");
    for (const c of all.filter((x) => x.status === "existing-admitted")) {
      const filename = c.cohort === "terminal" ? "manifest.reference.json" : "manifest.json";
      const path = `capsules/${c.capsule}/${filename}`;
      const commits = git("log", "--format=%H", "--diff-filter=AM", "HEAD", "--", path).split("\n").filter(Boolean);
      const versions = commits.map((commit) => JSON.parse(git("show", `${commit}:${path}`)) as CapsuleManifest);
      const matching = versions.find((manifest) => manifest.id === c.source.existingCapsuleId
        && (c.source.existingCapsuleDigest === undefined || capsuleDigest(manifest) === c.source.existingCapsuleDigest));
      expect(matching, `${c.taskId}: historical source identity must remain in Git`).toBeDefined();
      expect(deriveCapsuleId(matching!)).toBe(c.source.existingCapsuleId);
      expect(c.authoring.buildTestEvalCommands).not.toBeNull();
      expect(c.authoring.workloadHashes).not.toBeNull();
    }
  });
});
