import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alignedAuthoritySnapshot, assertAuthorityStillSelected } from "../src/authority.js";
import { applyBest, defaultApplyBranch } from "../src/commands/apply.js";
import { bestCommand } from "../src/commands/best.js";
import { diffCommand } from "../src/commands/diff.js";
import { statusCommand } from "../src/commands/status.js";
import {
  at,
  fakeHash,
  fixtureEvents,
  gitIn,
  initScratchRepo,
  makeIo,
  makeRoot,
  sealGitBaselineSnapshot,
  tarToCas,
  writeEvents,
} from "./helpers.js";
import type * as Eventlog from "../src/eventlog.js";

/**
 * TOCTOU seal (final release gate): a command must consume the EXACT public
 * replay whose events the alignment helper compared against the broker
 * journal — never an earlier separate read. The mock below is the
 * deterministic interleaving probe: it fires after every real public-log
 * read, letting a test advance authority (public + journal) between the
 * helper's public read and its journal read, exactly the window the old
 * two-read command shape (replayRun, then journalAuthorityAligned) raced.
 */
let afterPublicRead: ((runDir: string) => void) | null = null;
vi.mock("../src/eventlog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Eventlog>();
  return {
    ...actual,
    readEvents: (runDir: string) => {
      const events = actual.readEvents(runDir);
      afterPublicRead?.(runDir);
      return events;
    },
  };
});

afterEach(() => {
  afterPublicRead = null;
});

const RUN = "run_snap";

interface Fix {
  root: string;
  runDir: string;
  /** Incumbent A — the fixture's initial (soon stale) authority. */
  hashA: string;
  baselineHash: string;
}

function setup(): Fix {
  const root = makeRoot();
  const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
  const hashA = tarToCas(root, { "hello.txt": "improved A\n" });
  const runDir = writeEvents(root, RUN, fixtureEvents({ runId: RUN, baselineHash, bestHash: hashA, finished: false }));
  writeFileSync(join(runDir, "broker-state.ndjson"), `${JSON.stringify(incumbentLine(hashA, 0.62, 0.12, 0))}\n`);
  return { root, runDir, hashA, baselineHash };
}

function incumbentLine(hash: string, aggregate: number, deltaVsBaseline: number, episode: number): Record<string, unknown> {
  return { t: "incumbent", hash, aggregate, deltaVsBaseline, episode };
}

function incumbentEvent(hash: string, aggregate: number, deltaVsBaseline: number, episode: number): Record<string, unknown> {
  return { runId: RUN, at: at(), type: "incumbent.new", artifact: { hash }, aggregate, deltaVsBaseline, episode };
}

/** Publish a NEW incumbent to BOTH stores — the durable journal and the public log advance together. */
function publishIncumbent(runDir: string, hash: string, aggregate: number, episode: number): void {
  appendFileSync(join(runDir, "events.ndjson"), `${JSON.stringify(incumbentEvent(hash, aggregate, 0.3, episode))}\n`);
  appendFileSync(join(runDir, "broker-state.ndjson"), `${JSON.stringify(incumbentLine(hash, aggregate, 0.3, episode))}\n`);
}

/** One-shot interleaving trigger: the FIRST public read returns A, then the world advances to B. */
function advanceOnceAfterFirstRead(runDir: string, hash: string): void {
  afterPublicRead = () => {
    afterPublicRead = null;
    publishIncumbent(runDir, hash, 0.8, 1);
  };
}

describe("alignedAuthoritySnapshot — one-read fail-closed helper", () => {
  it("returns the exact replay it aligned (state, events, runId)", () => {
    const { root, runDir, hashA } = setup();
    const { io, err } = makeIo(root);
    const snapshot = alignedAuthoritySnapshot(runDir, io);
    expect(snapshot.aligned).toBe(true);
    if (!snapshot.aligned) return;
    expect(snapshot.runId).toBe(RUN);
    expect(snapshot.state.incumbent?.artifact.hash).toBe(hashA);
    expect(snapshot.events).toHaveLength(7);
    expect(err).toHaveLength(0);
  });

  it("fails closed when the journal holds a promotion the public log never saw", () => {
    const { root, runDir } = setup();
    appendFileSync(join(runDir, "broker-state.ndjson"), `${JSON.stringify(incumbentLine(fakeHash("f"), 0.9, 0.4, 1))}\n`);
    const { io, err } = makeIo(root);
    const snapshot = alignedAuthoritySnapshot(runDir, io);
    expect(snapshot.aligned).toBe(false);
    if (snapshot.aligned) return;
    expect(snapshot.reason).toBe("incumbent-unseen");
    expect(err.join("\n")).toMatch(/resume required/);
  });

  it("fails closed when broker event authority diverges from the public log", () => {
    const { root, runDir, hashA } = setup();
    // Event-format journal: vouches for incumbent A AND a successor the
    // public log never saw — exclusive broker sequences no longer match.
    writeFileSync(
      join(runDir, "broker-state.ndjson"),
      [
        JSON.stringify({ t: "event", event: incumbentEvent(hashA, 0.62, 0.12, 0) }),
        JSON.stringify({ t: "event", event: incumbentEvent(fakeHash("f"), 0.9, 0.4, 1) }),
      ].join("\n") + "\n",
    );
    const { io, err } = makeIo(root);
    const snapshot = alignedAuthoritySnapshot(runDir, io);
    expect(snapshot.aligned).toBe(false);
    if (snapshot.aligned) return;
    expect(snapshot.reason).toBe("journal-diverged");
    expect(err.join("\n")).toMatch(/not exactly aligned/);
  });

  it("a corrupt journal is unreadable and never retried into success", () => {
    const { root, runDir } = setup();
    writeFileSync(join(runDir, "broker-state.ndjson"), 'not json\n{"t":"incumbent"}\n');
    const { io, err } = makeIo(root);
    const snapshot = alignedAuthoritySnapshot(runDir, io);
    expect(snapshot.aligned).toBe(false);
    if (snapshot.aligned) return;
    expect(snapshot.reason).toBe("unreadable");
    expect(err.join("\n")).toMatch(/resume required; refusing a stale incumbent view/);
  });

  it("interleaving: authority advancing A→B between the public and journal reads converges on B, never A", () => {
    const { root, runDir, hashA } = setup();
    const hashB = fakeHash("b");
    advanceOnceAfterFirstRead(runDir, hashB);
    const { io } = makeIo(root);
    const snapshot = alignedAuthoritySnapshot(runDir, io);
    expect(snapshot.aligned).toBe(true);
    if (!snapshot.aligned) return;
    // The bounded re-read converged on the NEW authority; the stale first
    // read (incumbent A) was discarded, not returned as "aligned".
    expect(snapshot.state.incumbent?.artifact.hash).toBe(hashB);
    expect(snapshot.state.incumbent?.artifact.hash).not.toBe(hashA);
  });

  it("authority that keeps advancing past every bounded attempt fails closed", () => {
    const { root, runDir } = setup();
    let n = 0;
    afterPublicRead = () => {
      n++;
      publishIncumbent(runDir, fakeHash(String(n % 10)), 0.8 + n / 100, n);
    };
    const { io, err } = makeIo(root);
    const snapshot = alignedAuthoritySnapshot(runDir, io);
    expect(snapshot.aligned).toBe(false);
    expect(err.join("\n")).toMatch(/resume required/);
  });
});

describe("interleaving regressions — commands render/deliver B or refuse, never stale A", () => {
  it("status renders the advanced incumbent B, never the stale first read A", async () => {
    const { root, runDir, hashA } = setup();
    const hashB = fakeHash("b");
    advanceOnceAfterFirstRead(runDir, hashB);
    const { io, out } = makeIo(root);
    expect(await statusCommand([], io)).toBe(0);
    const rendered = out.join("\n");
    expect(rendered).toContain(`incumbent: ${hashB}`);
    expect(rendered).not.toContain(hashA);
  });

  it("best reports the advanced incumbent B, never the stale first read A", async () => {
    const { root, runDir, hashA } = setup();
    const hashB = fakeHash("b");
    advanceOnceAfterFirstRead(runDir, hashB);
    const { io, out } = makeIo(root);
    expect(await bestCommand([], io)).toBe(0);
    const rendered = out.join("\n");
    expect(rendered).toContain(`best: ${hashB}`);
    expect(rendered).not.toContain(hashA);
  });

  it("diff previews the advanced incumbent B, never the stale first read A", async () => {
    const { root, runDir, hashA } = setup();
    // B must be a real CAS artifact — diff extracts it.
    const hashB = tarToCas(root, { "hello.txt": "improved B\n" });
    advanceOnceAfterFirstRead(runDir, hashB);
    const { io, out } = makeIo(root);
    expect(await diffCommand([], io)).toBe(0);
    const rendered = out.join("\n");
    expect(rendered).toContain(`# incumbent ${hashB}`);
    expect(rendered).not.toContain(`# incumbent ${hashA}`);
    expect(rendered).toContain("improved B");
  });

  it("apply delivers the advanced incumbent B, never the stale first read A", async () => {
    const { root, runDir, hashA } = setup();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    sealGitBaselineSnapshot(root, RUN, repo);
    const hashB = tarToCas(root, { "hello.txt": "improved B\n" });
    advanceOnceAfterFirstRead(runDir, hashB);
    const { io, out } = makeIo(root);
    expect(await applyBest(io, { runId: RUN, repo: "repo" })).toBe(0);
    const branchB = defaultApplyBranch(RUN, hashB);
    expect(gitIn(repo, "show", `${branchB}:hello.txt`)).toBe("improved B");
    expect(out.join("\n")).toContain(hashB);
    // The stale incumbent A was never published under ITS branch either.
    const refs = spawnSync("git", ["-C", repo, "for-each-ref", "refs/heads/hone"], { encoding: "utf8" }).stdout.trim();
    expect(refs).not.toContain(defaultApplyBranch(RUN, hashA));
  });
});

describe("apply — pre-ref drift guard (incumbent C publishes after selection, before the ref moves)", () => {
  it("refuses to publish the superseded B and leaves no hone ref behind", async () => {
    const { root, runDir } = setup();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    sealGitBaselineSnapshot(root, RUN, repo);
    const { io } = makeIo(root);
    // Selection sees aligned authority B (= the fixture incumbent); C then
    // publishes AFTER the helper returned, BEFORE deliver moves the ref.
    // deliver's verifyTarget fires immediately pre-ref and must refuse —
    // the throw is what applyCommand surfaces as message + exit 1.
    const hashC = fakeHash("c");
    await expect(
      applyBest(io, {
        runId: RUN,
        repo: "repo",
        beforeDeliver: () => publishIncumbent(runDir, hashC, 0.9, 1),
      }),
    ).rejects.toThrow(/advanced past the selected artifact .* refusing to publish a superseded incumbent/);
    const refs = spawnSync("git", ["-C", repo, "for-each-ref", "refs/heads/hone"], { encoding: "utf8" }).stdout.trim();
    expect(refs).toBe("");
  });

  it("a run finishing on the SAME selected artifact is not drift — delivery proceeds", async () => {
    const { root, runDir, hashA } = setup();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    sealGitBaselineSnapshot(root, RUN, repo);
    const { io } = makeIo(root);
    expect(
      await applyBest(io, {
        runId: RUN,
        repo: "repo",
        beforeDeliver: () => {
          appendFileSync(
            join(runDir, "events.ndjson"),
            `${JSON.stringify({ runId: RUN, at: at(), type: "run.finished", best: { hash: hashA }, status: "completed" })}\n`,
          );
        },
      }),
    ).toBe(0);
    expect(gitIn(repo, "show", `${defaultApplyBranch(RUN, hashA)}:hello.txt`)).toBe("improved A");
  });

  it("assertAuthorityStillSelected also fails closed on misaligned authority at delivery time", () => {
    const { root, runDir, hashA } = setup();
    void root;
    appendFileSync(join(runDir, "broker-state.ndjson"), `${JSON.stringify(incumbentLine(fakeHash("f"), 0.9, 0.4, 1))}\n`);
    expect(() => assertAuthorityStillSelected(runDir, hashA, RUN)).toThrow(/resume required/);
  });
});
