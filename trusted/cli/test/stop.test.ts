import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { stopCommand } from "../src/commands/stop.js";
import { fixtureEvents, gitIn, initScratchRepo, makeIo, makeRoot, readLogLines, tarToCas, writeEvents } from "./helpers.js";

describe("hone stop", () => {
  it("finalizes a crashed run (dead supervisor) as stopped", async () => {
    const root = makeRoot();
    const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    writeEvents(root, "run_dead", fixtureEvents({ runId: "run_dead", baselineHash, bestHash, finished: false }));
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
    const { io } = makeIo(root);
    expect(await stopCommand(["--take-best", "--repo", "repo"], io)).toBe(0);
    expect(gitIn(repo, "show", "hone/run_tb:hello.txt")).toBe("improved");
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("is idempotent on an already-finished run", async () => {
    const root = makeRoot();
    const baselineHash = tarToCas(root, { "a.txt": "a\n" });
    const bestHash = tarToCas(root, { "a.txt": "b\n" });
    writeEvents(root, "run_done", fixtureEvents({ runId: "run_done", baselineHash, bestHash, finished: true }));
    const { io } = makeIo(root);
    expect(await stopCommand([], io)).toBe(0);
    const events = readLogLines(root, "run_done").map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
  });
});
