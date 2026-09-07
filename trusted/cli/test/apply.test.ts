import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/args.js";
import { applyCommand, defaultApplyBranch } from "../src/commands/apply.js";
import {
  bindSnapshotFixture,
  fakeHash,
  fixtureEvents,
  gitIn,
  initScratchRepo,
  makeIo,
  makeRoot,
  manifestRaw,
  sealBaselineCommitSnapshot,
  sealGitBaselineSnapshot,
  tarToCas,
  writeEvents,
} from "./helpers.js";

interface Fix {
  root: string;
  repo: string;
  bestHash: string;
  baselineHash: string;
  baselineCommit: string;
  /** Artifact-specific default delivery branch for run_fix1's best. */
  branch: string;
}

function setup(finished = true): Fix {
  const root = makeRoot();
  const repo = join(root, "repo");
  initScratchRepo(repo);
  const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
  const bestHash = tarToCas(root, { "hello.txt": "improved\n", "added.txt": "new file\n" });
  writeEvents(root, "run_fix1", fixtureEvents({ runId: "run_fix1", baselineHash, bestHash, finished }));
  const baselineCommit = sealGitBaselineSnapshot(root, "run_fix1", repo);
  return { root, repo, bestHash, baselineHash, baselineCommit, branch: defaultApplyBranch("run_fix1", bestHash) };
}

function honeRefs(repo: string): string {
  const r = spawnSync("git", ["-C", repo, "for-each-ref", "refs/heads/hone"], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

describe("hone apply --best — branch delivery", () => {
  it("lands the best artifact on an artifact-specific branch without touching the working tree", async () => {
    const { root, repo, bestHash, branch } = setup();
    const { io, out } = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(branch);

    // branch exists and carries the artifact tree
    expect(gitIn(repo, "rev-parse", "--verify", branch)).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(repo, "show", `${branch}:hello.txt`)).toBe("improved");
    expect(gitIn(repo, "show", `${branch}:added.txt`)).toBe("new file");
    expect(out.join("\n")).toContain(bestHash);

    // the user's working tree is untouched
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("baseline\n");
    expect(existsSync(join(repo, "added.txt"))).toBe(false);
    // and HEAD did not move
    expect(gitIn(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("default branches are artifact-specific: two different incumbents never collide on one ref", () => {
    expect(defaultApplyBranch("run_x", fakeHash("a"))).toBe(`hone/run_x-${"a".repeat(12)}`);
    expect(defaultApplyBranch("run_x", fakeHash("b"))).not.toBe(defaultApplyBranch("run_x", fakeHash("a")));
  });

  it("works mid-run from the incumbent (no run.finished yet)", async () => {
    const { root, repo, branch } = setup(false);
    const { io } = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], io);
    expect(code).toBe(0);
    expect(gitIn(repo, "show", `${branch}:hello.txt`)).toBe("improved");
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("--branch NAME overrides the branch", async () => {
    const { root, repo } = setup();
    const { io } = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1", "--branch", "custom/spot"], io);
    expect(code).toBe(0);
    expect(gitIn(repo, "show", "custom/spot:hello.txt")).toBe("improved");
  });

  it("idempotently accepts an existing run branch with the exact artifact", async () => {
    const { root, repo, branch } = setup();
    const { io } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], io)).toBe(0);
    const before = gitIn(repo, "rev-parse", branch);
    const again = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], again.io)).toBe(0);
    expect(gitIn(repo, "rev-parse", branch)).toBe(before);
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses an existing run branch whose tree differs", async () => {
    const { root, repo, branch } = setup();
    gitIn(repo, "branch", branch, "main");
    const attempt = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], attempt.io)).not.toBe(0);
    expect(attempt.err.join("\n")).toMatch(/delivery verification failed/i);
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("errors when the run has no incumbent yet", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    writeEvents(root, "run_empty", [
      { runId: "run_empty", at: new Date().toISOString(), type: "run.started", capsuleId: "cap_00000000abcd", contractHash: fakeHash("c"), optimizerDigest: "unpinned" },
    ]);
    sealGitBaselineSnapshot(root, "run_empty", repo);
    const { io } = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_empty"], io);
    expect(code).not.toBe(0);
  });
});

describe("hone apply — explicit target requirement", () => {
  it("refuses a destructive apply without --repo (never defaults to the working root)", async () => {
    const { root, repo } = setup();
    // even with a root that IS a valid target, omission is a usage error
    void repo;
    const { io } = makeIo(root);
    await expect(applyCommand(["--best", "--run", "run_fix1"], io)).rejects.toThrow(UsageError);
    await expect(applyCommand(["--best", "--run", "run_fix1"], io)).rejects.toThrow(/--repo is required/);
    // nothing was delivered anywhere
    expect(honeRefs(repo)).toBe("");
  });
});

describe("hone apply — durable target binding (fail closed)", () => {
  it("refuses when the run has no sealed capsule snapshot", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_nosnap", fixtureEvents({ runId: "run_nosnap", baselineHash, bestHash, finished: true }));
    const { io, err } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_nosnap"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/does not durably bind a delivery baseline/);
    expect(honeRefs(repo)).toBe("");
  });

  it("refuses a CAS-baseline capsule: no git target is durably bound", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_cas", fixtureEvents({ runId: "run_cas", baselineHash, bestHash, finished: true }));
    // Authenticated snapshot (bound to run.started + contract) whose sealed
    // baseline is a CAS artifact — the refusal must be the missing git
    // target, not an authentication failure.
    bindSnapshotFixture(root, "run_cas", manifestRaw());
    const { io, err } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_cas"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/binds no git delivery target/);
    expect(honeRefs(repo)).toBe("");
  });
});

describe("hone apply — exact repository validation", () => {
  it("never escalates a plain subdirectory to a parent repository, even when the parent contains the baseline commit", async () => {
    const root = makeRoot();
    // the working root IS a git repo (the Hone-monorepo shape) …
    initScratchRepo(root);
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_esc", fixtureEvents({ runId: "run_esc", baselineHash, bestHash, finished: true }));
    // … and the sealed baseline commit IS the root's HEAD, so containment
    // alone would pass — only exact-root validation stands in the way.
    sealGitBaselineSnapshot(root, "run_esc", root);
    const sub = join(root, "sub");
    mkdirSync(sub);
    const { io, err } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "sub", "--run", "run_esc"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/not a git repository root/);
    expect(honeRefs(root)).toBe("");
  });

  it("refuses a subdirectory of the target repository itself", async () => {
    const { root, repo } = setup();
    mkdirSync(join(repo, "nested"));
    const { io, err } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", join("repo", "nested"), "--run", "run_fix1"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/not a git repository root/);
    expect(honeRefs(repo)).toBe("");
  });

  it("refuses a repository that does not contain the sealed baseline commit", async () => {
    const { root, repo } = setup();
    void repo;
    const stranger = join(root, "stranger");
    initScratchRepo(stranger);
    // initScratchRepo is deterministic (same tree/identity/second ⇒ same
    // sha) — rewrite the root commit so this history genuinely diverges.
    gitIn(stranger, "commit", "--amend", "-m", "a different root commit");
    const { io, err } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "stranger", "--run", "run_fix1"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/does not contain the sealed baseline commit/);
    expect(honeRefs(stranger)).toBe("");
  });
});

describe("hone apply — split journal authority", () => {
  it("refuses to apply when the broker journal holds a promotion the public log never saw", async () => {
    const { root, repo, bestHash } = setup(false);
    const runDir = join(root, ".hone-runs", "run_fix1");
    writeFileSync(
      join(runDir, "broker-state.ndjson"),
      [
        JSON.stringify({ t: "incumbent", hash: bestHash, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 }),
        JSON.stringify({ t: "incumbent", hash: fakeHash("f"), aggregate: 0.9, deltaVsBaseline: 0.4, episode: 1 }),
      ].join("\n") + "\n",
    );
    const { io, err } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/resume required/);
    expect(honeRefs(repo)).toBe("");
  });

  it("applies normally when the journal and public log are exactly aligned", async () => {
    const { root, repo, bestHash, branch } = setup(false);
    const runDir = join(root, ".hone-runs", "run_fix1");
    writeFileSync(
      join(runDir, "broker-state.ndjson"),
      `${JSON.stringify({ t: "incumbent", hash: bestHash, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 })}\n`,
    );
    const { io } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], io)).toBe(0);
    expect(gitIn(repo, "show", `${branch}:hello.txt`)).toBe("improved");
  });
});

describe("hone apply — embedded baseline target (.gitdir)", () => {
  function embeddedFixture(root: string, runId: string): { baselineDir: string; commit: string; bestHash: string } {
    const baselineDir = join(root, "capsule-baseline");
    initScratchRepo(baselineDir);
    const commit = gitIn(baselineDir, "rev-parse", "HEAD");
    renameSync(join(baselineDir, ".git"), join(baselineDir, ".gitdir"));
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, runId, fixtureEvents({ runId, baselineHash, bestHash, finished: true }));
    return { baselineDir, commit, bestHash };
  }

  it("delivers into an explicitly bound embedded store without changing the Hone root", async () => {
    const root = makeRoot();
    initScratchRepo(root); // stand-in for the Hone monorepo the CLI runs from
    const { baselineDir, commit, bestHash } = embeddedFixture(root, "run_emb");
    sealBaselineCommitSnapshot(root, "run_emb", commit);
    const { io, out } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "capsule-baseline", "--run", "run_emb"], io)).toBe(0);

    const branch = defaultApplyBranch("run_emb", bestHash);
    expect(out.join("\n")).toContain(branch);
    const show = spawnSync("git", ["--git-dir", join(baselineDir, ".gitdir"), "show", `${branch}:hello.txt`], {
      encoding: "utf8",
    });
    expect(show.status).toBe(0);
    expect(show.stdout).toBe("improved\n");

    // the Hone root repository gained nothing
    expect(honeRefs(root)).toBe("");
  });

  it("refuses an embedded store whose HEAD is not the frozen baseline commit", async () => {
    const root = makeRoot();
    const { baselineDir } = embeddedFixture(root, "run_embx");
    void baselineDir;
    sealBaselineCommitSnapshot(root, "run_embx", "f".repeat(40));
    const { io, err } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "capsule-baseline", "--run", "run_embx"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/sealed to baseline commit/);
  });
});
