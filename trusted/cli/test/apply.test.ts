import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/commands/apply.js";
import { fakeHash, fixtureEvents, gitIn, initScratchRepo, makeIo, makeRoot, tarToCas, writeEvents } from "./helpers.js";

function setup(finished = true): { root: string; repo: string; bestHash: string; baselineHash: string } {
  const root = makeRoot();
  const repo = join(root, "repo");
  initScratchRepo(repo);
  const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
  const bestHash = tarToCas(root, { "hello.txt": "improved\n", "added.txt": "new file\n" });
  writeEvents(root, "run_fix1", fixtureEvents({ runId: "run_fix1", baselineHash, bestHash, finished }));
  return { root, repo, bestHash, baselineHash };
}

describe("hone apply --best — branch delivery", () => {
  it("lands the best artifact on hone/<runId> without touching the working tree", async () => {
    const { root, repo, bestHash } = setup();
    const { io, out } = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("hone/run_fix1");

    // branch exists and carries the artifact tree
    expect(gitIn(repo, "rev-parse", "--verify", "hone/run_fix1")).toMatch(/^[0-9a-f]{40}$/);
    expect(gitIn(repo, "show", "hone/run_fix1:hello.txt")).toBe("improved");
    expect(gitIn(repo, "show", "hone/run_fix1:added.txt")).toBe("new file");
    expect(out.join("\n")).toContain(bestHash);

    // the user's working tree is untouched
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("baseline\n");
    expect(existsSync(join(repo, "added.txt"))).toBe(false);
    // and HEAD did not move
    expect(gitIn(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("works mid-run from the incumbent (no run.finished yet)", async () => {
    const { root, repo } = setup(false);
    const { io } = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], io);
    expect(code).toBe(0);
    expect(gitIn(repo, "show", "hone/run_fix1:hello.txt")).toBe("improved");
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("--branch NAME overrides the branch", async () => {
    const { root, repo } = setup();
    const { io } = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1", "--branch", "custom/spot"], io);
    expect(code).toBe(0);
    expect(gitIn(repo, "show", "custom/spot:hello.txt")).toBe("improved");
  });

  it("refuses to clobber an existing branch", async () => {
    const { root, repo } = setup();
    const { io } = makeIo(root);
    expect(await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], io)).toBe(0);
    const again = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_fix1"], again.io);
    expect(code).not.toBe(0);
    expect(again.err.join("\n")).toMatch(/exists/i);
    // still clean
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("errors when the run has no incumbent yet", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    writeEvents(root, "run_empty", [
      { runId: "run_empty", at: new Date().toISOString(), type: "run.started", capsuleId: "cap_00000000abcd", contractHash: fakeHash("c"), optimizerDigest: "unpinned" },
    ]);
    const { io } = makeIo(root);
    const code = await applyCommand(["--best", "--repo", "repo", "--run", "run_empty"], io);
    expect(code).not.toBe(0);
  });
});
