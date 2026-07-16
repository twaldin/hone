import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bestCommand } from "../src/commands/best.js";
import { diffCommand } from "../src/commands/diff.js";
import { statusCommand } from "../src/commands/status.js";
import { fakeHash, fixtureEvents, makeIo, makeRoot, tarToCas, writeEvents } from "./helpers.js";

function setup(finished: boolean): { root: string; bestHash: string; baselineHash: string } {
  const root = makeRoot();
  const baselineHash = tarToCas(root, { "hello.txt": "baseline\n", "src/lib.ts": "export const speed = 1;\n" });
  const bestHash = tarToCas(root, { "hello.txt": "improved\n", "src/lib.ts": "export const speed = 9;\n", "added.txt": "new\n" });
  writeEvents(root, "run_fix2", fixtureEvents({ runId: "run_fix2", baselineHash, bestHash, finished }));
  return { root, bestHash, baselineHash };
}

describe("hone status", () => {
  it("reports live run state from the event log alone", async () => {
    const { root } = setup(false);
    const { io, out } = makeIo(root);
    expect(await statusCommand([], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("run_fix2");
    expect(text).toMatch(/status:\s+running/);
    expect(text).toMatch(/episodes:\s+1/);
    expect(text).toContain("0.62");
    expect(text).toContain("1.25"); // spent usd
  });

  it("reports finished state", async () => {
    const { root } = setup(true);
    const { io, out } = makeIo(root);
    expect(await statusCommand([], io)).toBe(0);
    expect(out.join("\n")).toMatch(/status:\s+completed/);
  });
});

describe("hone best — incumbent scorecard", () => {
  it("prints aggregate, delta, episode, spend, and the honest score scope", async () => {
    const { root, bestHash } = setup(false);
    const { io, out } = makeIo(root);
    expect(await bestCommand([], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(bestHash);
    expect(text).toContain("0.62");
    expect(text).toContain("non-holdout search score");
    expect(text).toContain("+0.12");
    expect(text).toMatch(/episode:?\s+0/);
    expect(text).toContain("1.25");
    expect(text).toContain("4200"); // tokens from last budget.snapshot
  });

  it("exits nonzero when there is no incumbent yet", async () => {
    const root = makeRoot();
    writeEvents(root, "run_none", [
      { runId: "run_none", at: new Date().toISOString(), type: "run.started", capsuleId: "cap_00000000abcd", contractHash: `sha256:${"c".repeat(64)}`, optimizerDigest: "unpinned" },
    ]);
    const { io } = makeIo(root);
    expect(await bestCommand([], io)).not.toBe(0);
  });
});

describe("hone diff — baseline vs incumbent", () => {
  it("shows the file-level diff between baseline and incumbent artifacts", async () => {
    const { root } = setup(false);
    const { io, out } = makeIo(root);
    expect(await diffCommand([], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("hello.txt");
    expect(text).toContain("added.txt");
    expect(text).toContain("-baseline");
    expect(text).toContain("+improved");
    expect(text).toContain("speed = 9");
  });

  it("--stat prints a summary", async () => {
    const { root } = setup(true);
    const { io, out } = makeIo(root);
    expect(await diffCommand(["--stat"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/3 files changed/);
  });

  it("targets a specific run with --run", async () => {
    const { root } = setup(false);
    const { io, out } = makeIo(root);
    expect(await diffCommand(["--run", "run_fix2"], io)).toBe(0);
    expect(out.join("\n")).toContain("hello.txt");
  });
  it("never executes a caller-supplied GIT_EXTERNAL_DIFF / hostile global diff helper", async () => {
    const { root } = setup(false);
    const marker = join(root, "ext-diff-ran");
    const helper = join(root, "evil-diff.sh");
    writeFileSync(helper, `#!/bin/sh\ntouch ${marker}\necho pwned\nexit 0\n`, { mode: 0o755 });
    // hostile global config defining an external diff driver, plus the env var
    const home = join(root, "evil-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".gitconfig"), `[diff]\n\texternal = ${helper}\n[core]\n\tpager = ${helper}\n`);
    const { io, out } = makeIo(root, {
      GIT_EXTERNAL_DIFF: helper,
      GIT_PAGER: helper,
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    });
    expect(await diffCommand([], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("+improved");
    expect(text).not.toContain("pwned");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("anytime views — split journal authority (durable journal vs public log)", () => {
  /** fixtureEvents' single public incumbent line, plus one promotion the log never saw. */
  function splitJournal(root: string, bestHash: string): void {
    writeFileSync(
      join(root, ".hone-runs", "run_fix2", "broker-state.ndjson"),
      [
        JSON.stringify({ t: "incumbent", hash: bestHash, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 }),
        JSON.stringify({ t: "incumbent", hash: fakeHash("f"), aggregate: 0.9, deltaVsBaseline: 0.4, episode: 1 }),
      ].join("\n") + "\n",
    );
  }

  it("status refuses the stale view and demands a resume", async () => {
    const { root, bestHash } = setup(false);
    splitJournal(root, bestHash);
    const { io, out, err } = makeIo(root);
    expect(await statusCommand([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/resume required/);
    expect(out.join("\n")).not.toMatch(/status:/);
  });

  it("best refuses the stale scorecard", async () => {
    const { root, bestHash } = setup(false);
    splitJournal(root, bestHash);
    const { io, out, err } = makeIo(root);
    expect(await bestCommand([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/resume required/);
    expect(out.join("\n")).not.toContain(bestHash);
  });

  it("diff refuses the stale preview", async () => {
    const { root, bestHash } = setup(false);
    splitJournal(root, bestHash);
    const { io, out, err } = makeIo(root);
    expect(await diffCommand([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/resume required/);
    expect(out.join("\n")).not.toContain("hello.txt");
  });

  it("a corrupt journal fails every view closed", async () => {
    const { root } = setup(false);
    writeFileSync(join(root, ".hone-runs", "run_fix2", "broker-state.ndjson"), 'not json\n{"t":"incumbent"}\n');
    const { io, err } = makeIo(root);
    expect(await statusCommand([], io)).toBe(1);
    expect(err.join("\n")).toMatch(/resume required/);
  });

  it("an exactly aligned journal changes nothing", async () => {
    const { root, bestHash } = setup(false);
    writeFileSync(
      join(root, ".hone-runs", "run_fix2", "broker-state.ndjson"),
      `${JSON.stringify({ t: "incumbent", hash: bestHash, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 })}\n`,
    );
    const { io, out } = makeIo(root);
    expect(await statusCommand([], io)).toBe(0);
    expect(out.join("\n")).toMatch(/status:\s+running/);
  });
});
