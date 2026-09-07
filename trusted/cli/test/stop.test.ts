import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import type { RunCommand } from "@hone/broker";
import { stopCommand } from "../src/commands/stop.js";
import { DOCKER_ENGINE_SEAL } from "../src/docker-engine-seal.js";
import { defaultApplyBranch } from "../src/commands/apply.js";
import { fixtureEvents, gitIn, initScratchRepo, makeIo, makeRoot, readLogLines, sealGitBaselineSnapshot, tarToCas, writeAlignedDispatchJournal, writeEvents } from "./helpers.js";

describe("hone stop", () => {
  it("finalizes a crashed run (dead supervisor) as stopped", async () => {
    const root = makeRoot();
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_dead", fixtureEvents({ runId: "run_dead", baselineHash, bestHash, finished: false }));
    writeAlignedDispatchJournal(root, "run_dead");
    const { io } = makeIo(root);
    expect(await stopCommand([], io)).toBe(0);
    const events = readLogLines(root, "run_dead").map((l) => RunEvent.parse(JSON.parse(l)));
    const last = events[events.length - 1];
    expect(last?.type).toBe("run.finished");
    if (last?.type === "run.finished") {
      expect(last.status).toBe("stopped");
      expect(last.best?.hash).toBe(bestHash);
    }
  });

  it("--take-best also lands the incumbent on a branch", async () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_tb", fixtureEvents({ runId: "run_tb", baselineHash, bestHash, finished: false }));
    writeAlignedDispatchJournal(root, "run_tb");
    // Manual take-best validates --repo against the run's sealed git-baseline snapshot.
    sealGitBaselineSnapshot(root, "run_tb", repo);
    const { io } = makeIo(root);
    expect(await stopCommand(["--take-best", "--repo", "repo"], io)).toBe(0);
    expect(gitIn(repo, "show", `${defaultApplyBranch("run_tb", bestHash)}:hello.txt`)).toBe("improved");
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("--repo/--branch without --take-best are a usage error; nothing is stopped or finalized", async () => {
    const root = makeRoot();
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    writeEvents(root, "run_flags", fixtureEvents({ runId: "run_flags", baselineHash, bestHash: baselineHash, finished: false }));
    for (const args of [["--repo", "repo"], ["--branch", "spot"]]) {
      const { io } = makeIo(root);
      await expect(stopCommand(args, io)).rejects.toThrow(/require --take-best/);
    }
    const events = readLogLines(root, "run_flags").map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.some((e) => e.type === "run.finished")).toBe(false);
  });

  it("--take-best without --repo is a usage error BEFORE any stop request or finalization", async () => {
    const root = makeRoot();
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    writeEvents(root, "run_norepo", fixtureEvents({ runId: "run_norepo", baselineHash, bestHash: baselineHash, finished: false }));
    const { io } = makeIo(root);
    await expect(stopCommand(["--take-best"], io)).rejects.toThrow(/--take-best delivers into a repository/);
    const events = readLogLines(root, "run_norepo").map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.some((e) => e.type === "run.finished")).toBe(false); // the run was NOT stopped for a doomed delivery
  });

  it("--take-best with an unvalidatable target refuses BEFORE finalizing: the run stays live/resumable", async () => {
    const root = makeRoot();
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    // No sealed capsule snapshot: the target cannot validate.
    writeEvents(root, "run_badtb", fixtureEvents({ runId: "run_badtb", baselineHash, bestHash, finished: false }));
    const { io, err } = makeIo(root);
    expect(await stopCommand(["--take-best", "--repo", "repo"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/refusing to stop: --take-best target does not validate/);
    const events = readLogLines(root, "run_badtb").map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.some((e) => e.type === "run.finished")).toBe(false); // ordering regression: validation precedes the stop
  });

  it("is idempotent on an already-finished run", async () => {
    const root = makeRoot();
    const baselineHash = tarToCas(root, { "a.txt": "a\n" });
    const bestHash = tarToCas(root, { "a.txt": "b\n" });
    writeAlignedDispatchJournal(root, "run_done");
    writeEvents(root, "run_done", fixtureEvents({ runId: "run_done", baselineHash, bestHash, finished: true }));
    const { io } = makeIo(root);
    expect(await stopCommand([], io)).toBe(0);
    const events = readLogLines(root, "run_done").map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
  });
  it("refuses to terminalize a dead run when Docker resources cannot be verified clean", async () => {
    const root = makeRoot();
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const runDir = writeEvents(root, "run_leaked", fixtureEvents({ runId: "run_leaked", baselineHash, bestHash: baselineHash, finished: false }));
    writeAlignedDispatchJournal(root, "run_leaked");
    // A SEALED run (only a sealed run can own Docker resources: the seal is
    // written before the create journal and before any resource operation).
    writeFileSync(join(runDir, DOCKER_ENGINE_SEAL), `${JSON.stringify({ v: 1, engineId: "ENGINE-A", endpointKind: "unverified", at: "2026-07-16T00:00:00Z" })}\n`);
    const { io, err } = makeIo(root);
    const run: RunCommand = async (argv) => ({
      exitCode: argv[1] === "ps" ? 1 : 0,
      stdout: argv[1] === "info" ? Buffer.from("ENGINE-A\n") : Buffer.alloc(0),
      stderr: argv[1] === "ps" ? Buffer.from("daemon unavailable") : Buffer.alloc(0),
      truncated: false,
      timedOut: false,
    });

    expect(await stopCommand([], io, run)).toBe(1);
    expect(err.join("\n")).toMatch(/resource cleanup incomplete/);
    const events = readLogLines(root, "run_leaked").map((line) => RunEvent.parse(JSON.parse(line)));
    expect(events.some((event) => event.type === "run.finished")).toBe(false);
  });
});
