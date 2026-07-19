import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase A gate (plans/001-lock-m2-owner-oss-cohort.md): exactly 16 train and
 * 12 terminal task contracts, unique task/capsule/source identities, no
 * train/terminal overlap, frozen 4+4 owner/OSS panel split, and all required
 * fields present. Contract identities are LOCKED by plan 001 — a failing
 * assertion here means the plan must be revised, never silently substituted.
 */

const CONTRACT_DIR = join(__dirname, "..", "contracts");

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

  it("has exactly 16 train and 12 terminal contracts with unique, matching task ids", () => {
    expect(train.length).toBe(16);
    expect(terminal.length).toBe(12);
    const ids = all.map((c) => c.taskId);
    expect(new Set(ids).size).toBe(28);
    for (const c of all) {
      expect(existsSync(join(CONTRACT_DIR, `${c.taskId}.json`))).toBe(true);
      expect(c.taskId).toMatch(/^(OWN|OSS)-[TH]\d\d$/);
      expect(c.cohort).toBe(c.taskId.includes("-T") ? "train" : "terminal");
      expect(c.stratum).toBe(c.taskId.startsWith("OWN") ? "owner" : "oss");
    }
  });

  it("has unique capsule names and unique source identities with no train/terminal overlap", () => {
    const capsules = all.map((c) => c.capsule);
    expect(new Set(capsules).size).toBe(28);
    // Source identity: existing capsule id, or repository@revision.
    const sources = all.map((c) => c.source.existingCapsuleId ?? `${c.source.repository}@${c.source.revision}`);
    expect(new Set(sources).size).toBe(28);
    // OSS terminal repositories never appear in any train source (repository-level holdout).
    const trainRepos = new Set(train.map((c) => c.source.repository).filter((r) => r !== undefined));
    for (const c of terminal.filter((t) => t.stratum === "oss")) {
      expect(trainRepos.has(c.source.repository)).toBe(false);
    }
  });

  it("splits each cohort exactly 50/50 owner/OSS per the plan", () => {
    expect(train.filter((c) => c.stratum === "owner").length).toBe(8);
    expect(train.filter((c) => c.stratum === "oss").length).toBe(8);
    expect(terminal.filter((c) => c.stratum === "owner").length).toBe(4);
    expect(terminal.filter((c) => c.stratum === "oss").length).toBe(8);
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

  it("requires admitted contracts to reference a live capsule directory with a matching manifest", () => {
    for (const c of all.filter((x) => x.status === "existing-admitted")) {
      const manifestPath = join(__dirname, "..", c.capsule, "manifest.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id: string };
      if (c.source.existingCapsuleId !== undefined) {
        expect(manifest.id).toBe(c.source.existingCapsuleId);
      }
      expect(c.authoring.buildTestEvalCommands).not.toBeNull();
      expect(c.authoring.workloadHashes).not.toBeNull();
    }
  });
});
