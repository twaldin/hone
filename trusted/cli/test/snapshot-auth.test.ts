import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authenticateCapsuleSnapshot } from "../src/admission.js";
import { applyCommand } from "../src/commands/apply.js";
import { readSealedDeliveryTarget, sealDeliveryTarget } from "../src/delivery-target.js";
import {
  fixtureEvents,
  gitIn,
  initScratchRepo,
  makeIo,
  makeRoot,
  manifestRaw,
  sealGitBaselineSnapshot,
  tarToCas,
  writeEvents,
} from "./helpers.js";

/**
 * Capsule-snapshot authentication (release gate P1): the snapshot names the
 * frozen baseline every delivery validates its target against, so a swapped
 * capsule-manifest.json could re-point delivery at a different repository or
 * commit. Manual AND automatic delivery must refuse unless the snapshot's
 * content-addressed id recomputes, equals run.started.capsuleId, and the
 * approved contract (hash-sealed in run.started) literally binds the
 * snapshot's id, recomputed canonical digest, and baseline.
 */

interface Fix {
  root: string;
  repo: string;
  runDir: string;
}

function setup(runId = "run_auth"): Fix {
  const root = makeRoot();
  const repo = join(root, "repo");
  initScratchRepo(repo);
  const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
  const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
  writeEvents(root, runId, fixtureEvents({ runId, baselineHash, bestHash, finished: true }));
  sealGitBaselineSnapshot(root, runId, repo);
  return { root, repo, runDir: join(root, ".hone-runs", runId) };
}

function honeRefs(repo: string): string {
  const r = spawnSync("git", ["-C", repo, "for-each-ref", "refs/heads/hone"], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

describe("authenticateCapsuleSnapshot — tamper regressions", () => {
  it("an untampered bound snapshot authenticates", () => {
    const { runDir } = setup();
    expect(() => authenticateCapsuleSnapshot(runDir)).not.toThrow();
  });

  it("a snapshot whose content was altered under its frozen id refuses (id does not recompute)", () => {
    const { runDir } = setup();
    const path = join(runDir, "capsule-manifest.json");
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    snapshot["objective"] = "silently retargeted";
    writeFileSync(path, JSON.stringify(snapshot, null, 2));
    expect(() => authenticateCapsuleSnapshot(runDir)).toThrow(/does not recompute/);
  });

  it("a COHERENT swap to a different capsule (id recomputed) refuses: run.started capsuleId is the root of trust", () => {
    const { root, repo, runDir } = setup();
    // Attacker re-derives a valid manifest binding a DIFFERENT baseline
    // commit — the id recomputes, but the event log cannot be rewritten.
    writeFileSync(join(repo, "extra.txt"), "x\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-m", "another commit");
    const forged = manifestRaw({ baseline: { kind: "git", commit: gitIn(repo, "rev-parse", "HEAD") } });
    writeFileSync(join(runDir, "capsule-manifest.json"), `${JSON.stringify(forged, null, 2)}\n`);
    expect(() => authenticateCapsuleSnapshot(runDir)).toThrow(/!= run\.started capsuleId/);
  });

  it("an altered contract refuses (hash != run.started seal); a missing contract refuses too", () => {
    const { runDir } = setup();
    const contractPath = join(runDir, "contract.md");
    writeFileSync(contractPath, `${readFileSync(contractPath, "utf8")}\n<!-- tampered -->\n`);
    expect(() => authenticateCapsuleSnapshot(runDir)).toThrow(/does not hash to the run\.started contract seal/);
    rmSync(contractPath);
    expect(() => authenticateCapsuleSnapshot(runDir)).toThrow(/missing contract\.md/);
  });

  it("a run with no run.started refuses", () => {
    const { root, repo } = setup();
    const runDir = writeEvents(root, "run_nostart", [
      { runId: "run_nostart", at: new Date().toISOString(), type: "episode.started", episode: 0, parent: { hash: tarToCas(root, { "a.txt": "a\n" }) } },
    ]);
    sealGitBaselineSnapshot(root, "run_nostart", repo);
    // sealGitBaselineSnapshot patches only run.started lines; none exist.
    expect(() => authenticateCapsuleSnapshot(runDir)).toThrow(/no acknowledged run\.started/);
  });
});

describe("manual delivery authenticates the snapshot BEFORE consuming its baseline", () => {
  it("hone apply --best refuses a swapped snapshot and publishes nothing", async () => {
    const { root, repo, runDir } = setup("run_auth_apply");
    const path = join(runDir, "capsule-manifest.json");
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    snapshot["objective"] = "silently retargeted";
    writeFileSync(path, JSON.stringify(snapshot, null, 2));
    const { io, err } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_auth_apply"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/does not recompute/);
    expect(honeRefs(repo)).toBe("");
  });
});

describe("automatic delivery path (readSealedDeliveryTarget) authenticates too", () => {
  it("a sealed target refuses once the snapshot is swapped, even when the target itself still validates", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_auth_auto", fixtureEvents({ runId: "run_auth_auto", baselineHash: bestHash, bestHash, finished: false }));
    sealGitBaselineSnapshot(root, "run_auth_auto", repo);
    const runDir = join(root, ".hone-runs", "run_auth_auto");
    sealDeliveryTarget(root, runDir, "repo");
    expect(readSealedDeliveryTarget(root, runDir)).not.toBeNull();
    const path = join(runDir, "capsule-manifest.json");
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    snapshot["protectedPaths"] = [];
    writeFileSync(path, JSON.stringify(snapshot, null, 2));
    expect(() => readSealedDeliveryTarget(root, runDir)).toThrow(/does not recompute/);
  });
});
