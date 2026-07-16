import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliver, syncPublishedRef } from "../src/deliver.js";
import { gitIn, initScratchRepo, makeRoot, tarToCas } from "./helpers.js";

/**
 * Reftable ref-storage backend (release blocker): the delivery durability
 * epilogue (loose-object dirents, loose/packed ref publication,
 * crash-idempotent recovery) is proven ONLY for the files backend, so any
 * store that is not canonically the files backend must be rejected
 * fail-closed BEFORE any object or ref write — at the entry preflight, at
 * the immediate prewrite gate of every publication, and at every recovery
 * arm (a store can flip formats WHILE a delivery is in flight or between a
 * crash and its resume).
 *
 * The running git here may predate reftable (2.45), so these tests pin the
 * ONE probe deliver() trusts — `rev-parse --show-ref-format` — via a PATH
 * shim and drive everything else through the real git. Empirically verified
 * against git 2.39: old rev-parse ECHOES unknown flags back with exit 0, and
 * opening a v1 store with extensions.refstorage fails every command with
 * exit 128; the shim behaviors below reproduce exactly those two shapes.
 */

type ProbeBehavior = "reftable" | "echo" | "fail";

const SHIM_ACTIONS: Record<ProbeBehavior, string> = {
  reftable: "echo reftable; exit 0",
  echo: "printf '%s\\n' --show-ref-format; exit 0",
  fail: "echo 'fatal: unknown repository extension found: refstorage' >&2; exit 128",
};

/**
 * PATH git shim controlling ONLY `rev-parse --show-ref-format`; every other
 * invocation delegates to the real git. "reftable": a reftable-capable git
 * answering for a reftable store. "echo": old-git rev-parse flag passthrough
 * (prints the flag verbatim, exit 0). "fail": old git opening a
 * repositoryformatversion=1 store with extensions.refstorage (exit 128).
 * The shim can be REWRITTEN mid-delivery (setProbeShim) to model a store
 * whose canonical format flips while a delivery is in flight.
 */
function installProbeShim(root: string, behavior: ProbeBehavior): string {
  const which = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  const realGit = (which.stdout ?? "").trim();
  expect(realGit).not.toBe("");
  const shimDir = join(root, "shims");
  mkdirSync(shimDir, { recursive: true });
  writeShim(shimDir, realGit, behavior);
  return shimDir;
}

function writeShim(shimDir: string, realGit: string, behavior: ProbeBehavior): void {
  writeFileSync(
    join(shimDir, "git"),
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--show-ref-format" ]; then ${SHIM_ACTIONS[behavior]}; fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
}

/** Flip an installed shim's probe answer mid-flight. */
function setProbeShim(shimDir: string, behavior: ProbeBehavior): void {
  const which = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  writeShim(shimDir, (which.stdout ?? "").trim(), behavior);
}

const TABLE_NAME = "0x000000000001-0x000000000002-8f3a90aa.ref";

/**
 * Plant a minimal reftable stack inside a scratch store. With the probe
 * shimmed to answer "reftable", deliver() must treat this store's refs as
 * reftable-backed — the real git underneath still operates its files
 * backend, which is exactly what keeps the scenario drivable (and every
 * pre-rejection read working) on any git version.
 */
function plantReftableStack(gitDir: string): { stackDir: string; list: string; table: string } {
  const stackDir = join(gitDir, "reftable");
  mkdirSync(stackDir, { recursive: true });
  const table = join(stackDir, TABLE_NAME);
  writeFileSync(table, "REFT-fixture");
  const list = join(stackDir, "tables.list");
  writeFileSync(list, `${TABLE_NAME}\n`);
  return { stackDir, list, table };
}

/** Recursive `<path>[:size]` listing — the no-external-side-effect proof for rejection tests. */
function snapshotDir(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      const st = lstatSync(path);
      if (st.isDirectory()) {
        out.push(`${path}/`);
        walk(path);
      } else {
        out.push(`${path}:${st.size}`);
      }
    }
  };
  walk(dir);
  return out;
}

/** Append a v1 + extensions.refstorage declaration directly to the store's config (writing it through an old git would fail once the extension exists). */
function declareRefStorage(gitDir: string, value: string): void {
  appendFileSync(join(gitDir, "config"), `[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefstorage = ${value}\n`);
}

function branchOpts(root: string, repo: string, runId: string, shimDir?: string) {
  const artifact = tarToCas(root, { "hello.txt": "improved\n" });
  return {
    mode: "branch" as const,
    repo,
    runId,
    runDir: root,
    artifact,
    casDir: join(root, ".hone-cas"),
    autoRef: "refs/heads/main",
    improverSeat: false,
    baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
    env: shimDir === undefined ? process.env : { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
  };
}

const REFUSAL = /refusing before any object or ref write/;

describe("reftable preflight — fail closed BEFORE any object or ref write", () => {
  it("a store declaring reftable that the running git cannot canonically operate is rejected with zero external side effects", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const gitDir = join(repo, ".git");
    const opts = branchOpts(root, repo, "run_rt_reject", installProbeShim(root, "fail"));
    declareRefStorage(gitDir, "reftable");
    plantReftableStack(gitDir);
    const before = snapshotDir(gitDir);
    const synced: string[] = [];
    expect(() => deliver({ ...opts, fsyncPath: (path) => synced.push(path) })).toThrow(
      /uses ref storage format "reftable"[\s\S]*refusing before any object or ref write/,
    );
    // No object, ref, reftable-stack, or worktree side effect of any kind.
    expect(snapshotDir(gitDir)).toEqual(before);
    expect(synced).toEqual([]);
  });

  it("a store CANONICALLY reporting reftable (modern-git probe answer) is rejected with zero external side effects", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const gitDir = join(repo, ".git");
    plantReftableStack(gitDir);
    const opts = branchOpts(root, repo, "run_rt_canonical", installProbeShim(root, "reftable"));
    const before = snapshotDir(gitDir);
    const synced: string[] = [];
    expect(() => deliver({ ...opts, fsyncPath: (path) => synced.push(path) })).toThrow(
      /uses ref storage format "reftable"[\s\S]*refusing before any object or ref write/,
    );
    expect(snapshotDir(gitDir)).toEqual(before);
    expect(synced).toEqual([]);
  });

  it("an UNKNOWN future ref storage format is rejected before any write (real git, no shim)", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_rt_future");
    declareRefStorage(join(repo, ".git"), "luminous");
    const before = snapshotDir(join(repo, ".git"));
    expect(() => deliver(opts)).toThrow(/"luminous"[\s\S]*refusing before any object or ref write/);
    expect(snapshotDir(join(repo, ".git"))).toEqual(before);
  });

  it("a files store carrying a decoy reftable stack is rejected when git cannot canonically disambiguate (old-git flag passthrough)", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    // No extensions.refstorage declared — but the stack marker exists. An
    // old git echoes the probe flag back (exit 0), so the format cannot be
    // proven; syncing loose refs of what might be a reftable store (or the
    // decoy of a files store) must not be guessed at.
    plantReftableStack(join(repo, ".git"));
    const opts = branchOpts(root, repo, "run_rt_decoy", installProbeShim(root, "echo"));
    const before = snapshotDir(join(repo, ".git"));
    expect(() => deliver(opts)).toThrow(REFUSAL);
    expect(snapshotDir(join(repo, ".git"))).toEqual(before);
  });

  it("an explicitly bound store (gitDir) declaring reftable is rejected the same way", () => {
    const root = makeRoot();
    const repo = join(root, "store");
    initScratchRepo(repo);
    const gitDir = join(repo, ".git");
    const opts = branchOpts(root, repo, "run_rt_bound", installProbeShim(root, "fail"));
    declareRefStorage(gitDir, "reftable");
    const before = snapshotDir(gitDir);
    expect(() => deliver({ ...opts, gitDir })).toThrow(REFUSAL);
    expect(snapshotDir(gitDir)).toEqual(before);
  });

  it("plain files repos still deliver under an old-git probe (flag passthrough falls back to the store config)", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_rt_files", installProbeShim(root, "echo"));
    const result = deliver(opts);
    expect(result.ref).toBe("hone/run_rt_files");
  });
});

describe("reftable rejection covers EVERY publication and recovery arm (mid-flight format flips)", () => {
  it("initial branch path: a flip between entry preflight and the prewrite gate aborts BEFORE the branch ref is created", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const shimDir = installProbeShim(root, "echo"); // entry preflight passes via the store-config fallback
    const opts = branchOpts(root, repo, "run_rt_midflight", shimDir);
    // syncLooseObjectDirs runs IMMEDIATELY before the prewrite gate — the
    // first fsync is therefore strictly after object writes and strictly
    // before the gate re-probes the store's format.
    let flipped = false;
    expect(() =>
      deliver({
        ...opts,
        fsyncPath: () => {
          if (!flipped) {
            flipped = true;
            plantReftableStack(join(repo, ".git"));
            setProbeShim(shimDir, "reftable");
          }
        },
      }),
    ).toThrow(REFUSAL);
    expect(flipped).toBe(true);
    // The gate fired between update-ref and the flip: the branch must not exist.
    const ref = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/hone/run_rt_midflight"]);
    expect(ref.status).not.toBe(0);
  });

  it("branch recovery arm: a store flipped to reftable after a successful delivery refuses recovery before ANY durability work", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const shimDir = installProbeShim(root, "echo");
    const opts = branchOpts(root, repo, "run_rt_recovery", shimDir);
    const first = deliver(opts);
    expect(first.ref).toBe("hone/run_rt_recovery");
    const tip = gitIn(repo, "rev-parse", "--verify", "refs/heads/hone/run_rt_recovery");

    // Flip strictly INSIDE the recovery arm: the resume's entry preflight
    // passes (echo + files config), then the sealed-identity hook — which
    // runs immediately before the recovery gate — flips the store.
    const synced: string[] = [];
    let calls = 0;
    expect(() =>
      deliver({
        ...opts,
        fsyncPath: (path) => synced.push(path),
        verifyTarget: () => {
          calls += 1;
          if (calls === 1) {
            plantReftableStack(join(repo, ".git"));
            setProbeShim(shimDir, "reftable");
          }
        },
      }),
    ).toThrow(REFUSAL);
    // Refused before a single fsync of the recovered publication.
    expect(synced).toEqual([]);
    expect(gitIn(repo, "rev-parse", "--verify", "refs/heads/hone/run_rt_recovery")).toBe(tip);
  });

  it("auto entry: an auto delivery over a canonically reftable store is rejected with zero external side effects", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const gitDir = join(repo, ".git");
    plantReftableStack(gitDir);
    const opts = { ...branchOpts(root, repo, "run_rt_auto_entry", installProbeShim(root, "reftable")), mode: "auto" as const };
    const before = snapshotDir(gitDir);
    const synced: string[] = [];
    expect(() => deliver({ ...opts, fsyncPath: (path) => synced.push(path) })).toThrow(REFUSAL);
    expect(snapshotDir(gitDir)).toEqual(before);
    expect(synced).toEqual([]);
  });

  it("auto already-applied recovery arm: a flip before the recovery epilogue refuses with no further durability work", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const shimDir = installProbeShim(root, "echo");
    const opts = { ...branchOpts(root, repo, "run_rt_auto_rec", shimDir), mode: "auto" as const };
    const first = deliver(opts);
    expect(first.ref).toBe("main");
    const mainTip = gitIn(repo, "rev-parse", "refs/heads/main");

    // Resume: the branch recovery arm completes (verifyTarget #1/#2), then
    // auto's already-applied arm re-verifies the sealed identity (#3)
    // immediately before ITS recovery gate — flip there.
    const synced: string[] = [];
    let calls = 0;
    let syncedAtFlip = -1;
    expect(() =>
      deliver({
        ...opts,
        fsyncPath: (path) => synced.push(path),
        verifyTarget: () => {
          calls += 1;
          if (calls === 3) {
            plantReftableStack(join(repo, ".git"));
            setProbeShim(shimDir, "reftable");
            syncedAtFlip = synced.length;
          }
        },
      }),
    ).toThrow(REFUSAL);
    // The flip arm was reached, and nothing was synced after it.
    expect(syncedAtFlip).toBeGreaterThanOrEqual(0);
    expect(synced.length).toBe(syncedAtFlip);
    expect(gitIn(repo, "rev-parse", "refs/heads/main")).toBe(mainTip);
  });
});

describe("syncPublishedRef — files-backend durability primitive (fail closed)", () => {
  it("syncs a loose ref file plus every directory on its chain up through the store", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const gitDir = join(repo, ".git");
    gitIn(repo, "update-ref", "refs/heads/hone/x", "HEAD");
    const synced: string[] = [];
    syncPublishedRef(gitDir, "refs/heads/hone/x", gitIn(repo, "rev-parse", "HEAD"), (path) => synced.push(path));
    expect(synced).toEqual([
      join(gitDir, "refs", "heads", "hone", "x"),
      join(gitDir, "refs", "heads", "hone"),
      join(gitDir, "refs", "heads"),
      join(gitDir, "refs"),
      gitDir,
    ]);
  });

  it("falls back to packed-refs + store dir when the ref is packed — never a reftable stack", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const gitDir = join(repo, ".git");
    // A decoy stack (e.g. left by a format migration) must never be
    // consulted: only the files backend ever reaches this epilogue.
    plantReftableStack(gitDir);
    gitIn(repo, "update-ref", "refs/heads/hone/x", "HEAD");
    gitIn(repo, "pack-refs", "--all");
    expect(existsSync(join(gitDir, "packed-refs"))).toBe(true);
    expect(existsSync(join(gitDir, "refs", "heads", "hone", "x"))).toBe(false);
    const synced: string[] = [];
    syncPublishedRef(gitDir, "refs/heads/hone/x", gitIn(repo, "rev-parse", "HEAD"), (path) => synced.push(path));
    expect(synced).toEqual([join(gitDir, "packed-refs"), gitDir]);
    expect(synced.some((p) => p.includes(join(gitDir, "reftable")))).toBe(false);
  });

  it("refuses when the ref exists neither loose nor packed — even with a reftable stack present", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    plantReftableStack(join(repo, ".git"));
    expect(() => syncPublishedRef(join(repo, ".git"), "refs/heads/ghost", gitIn(repo, "rev-parse", "HEAD"))).toThrow(/neither.*loose ref nor.*packed ref/);
  });
});
