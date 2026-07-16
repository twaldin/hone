import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliver, syncLooseObjectDirs, syncPublishedRef } from "../src/deliver.js";
import { gitIn, initScratchRepo, makeRoot, tarToCas } from "./helpers.js";

/**
 * Git publication durability (release gate P1): every delivery git call —
 * from the very first object write (hash-object -w) through the ref updates
 * that make anything reachable (update-ref) — must carry the command-scope
 * `core.fsync=objects,reference` + `core.fsyncMethod=fsync` pin, and that
 * pin must OUTRANK a hostile repo-local `core.fsync=none`. An acknowledged
 * delivery (which the supervisor terminalizes on) must therefore be durable
 * before any success event, in every crash ordering after the git call
 * returns.
 */

interface GitCall {
  argv: string;
  config: Record<string, string>;
}

/** PATH shim that records every git invocation's argv + command-scope GIT_CONFIG_* env, then delegates to the real git. */
function installGitShim(root: string): { shimDir: string; calls: () => GitCall[] } {
  const which = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  const realGit = (which.stdout ?? "").trim();
  expect(realGit).not.toBe("");
  const shimDir = join(root, "shims");
  mkdirSync(shimDir, { recursive: true });
  const log = join(root, "git-calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(shimDir, "git"),
    `#!/bin/sh\n{ echo "ARGV:$*"; env | grep '^GIT_CONFIG_' | sort; echo "==="; } >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  const calls = (): GitCall[] => {
    const records: GitCall[] = [];
    for (const block of readFileSync(log, "utf8").split("===\n")) {
      if (block.trim() === "") continue;
      const lines = block.split("\n").filter((l) => l !== "");
      const argv = (lines[0] ?? "").replace(/^ARGV:/, "");
      const env: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const eq = line.indexOf("=");
        env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      const config: Record<string, string> = {};
      const count = Number(env["GIT_CONFIG_COUNT"] ?? "0");
      for (let i = 0; i < count; i++) {
        const key = env[`GIT_CONFIG_KEY_${i}`];
        const value = env[`GIT_CONFIG_VALUE_${i}`];
        if (key !== undefined && value !== undefined) config[key.toLowerCase()] = value;
      }
      records.push({ argv, config });
    }
    return records;
  };
  return { shimDir, calls };
}

function hostileRepo(root: string): string {
  const repo = join(root, "repo");
  initScratchRepo(repo);
  // Adversarial repo-local durability sabotage: without the command-scope
  // pin, git would write objects/refs through the page cache only.
  gitIn(repo, "config", "core.fsync", "none");
  gitIn(repo, "config", "core.fsyncMethod", "writeout-only");
  return repo;
}

describe("delivery git durability pin (command scope, every invocation)", () => {
  it("branch delivery: EVERY git call — object writes and the publication update-ref included — carries the fsync pin", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    const { shimDir, calls } = installGitShim(root);
    const artifact = tarToCas(root, { "hello.txt": "improved\n", "added.txt": "new\n" });
    const result = deliver({
      mode: "branch",
      repo,
      runId: "run_fsync",
      artifact,
      casDir: join(root, ".hone-cas"),
      improverSeat: false,
      baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
      env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    expect(result.ref).toMatch(/^hone\//);
    const recorded = calls();
    expect(recorded.length).toBeGreaterThan(3);
    for (const call of recorded) {
      expect(call.config["core.fsync"], call.argv).toBe("objects,reference");
      expect(call.config["core.fsyncmethod"], call.argv).toBe("fsync");
    }
    // The crash-ordering-critical calls really happened under the pin.
    expect(recorded.some((c) => c.argv.includes("hash-object -w"))).toBe(true);
    expect(recorded.some((c) => c.argv.includes("update-ref"))).toBe(true);
  });

  it("auto delivery: the HEAD-branch publication update-ref carries the pin too", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    // Move HEAD past the baseline so auto performs a real merge + CAS ref update.
    const baseline = gitIn(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "other.txt"), "post-baseline\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-m", "post-baseline");
    const { shimDir, calls } = installGitShim(root);
    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    const result = deliver({
      mode: "auto",
      repo,
      runId: "run_fsync_auto",
      runDir: root,
      artifact,
      casDir: join(root, ".hone-cas"),
      improverSeat: false,
      baselineCommit: baseline,
      autoRef: "refs/heads/main",
      env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    expect(result.ref).toBe("main");
    const updates = calls().filter((c) => c.argv.includes("update-ref"));
    expect(updates.length).toBeGreaterThanOrEqual(2); // branch creation + HEAD-branch CAS
    for (const call of updates) {
      expect(call.config["core.fsync"], call.argv).toBe("objects,reference");
      expect(call.config["core.fsyncmethod"], call.argv).toBe("fsync");
    }
  });

  it("command-scope pin OUTRANKS hostile repo-local core.fsync=none (git precedence, resolved value)", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    // Exactly the mechanism deliver() uses: GIT_CONFIG_{COUNT,KEY_i,VALUE_i}
    // command-scope entries. The resolved single-value read must be ours.
    const env = {
      PATH: process.env["PATH"] ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.fsync",
      GIT_CONFIG_VALUE_0: "objects,reference",
      GIT_CONFIG_KEY_1: "core.fsyncmethod",
      GIT_CONFIG_VALUE_1: "fsync",
    };
    const fsync = spawnSync("git", ["-C", repo, "config", "core.fsync"], { encoding: "utf8", env });
    expect(fsync.stdout.trim()).toBe("objects,reference");
    const method = spawnSync("git", ["-C", repo, "config", "core.fsyncMethod"], { encoding: "utf8", env });
    expect(method.stdout.trim()).toBe("fsync");
    // Without the command scope the hostile local values would win — the
    // sabotage this pin exists to defeat is real in this repo.
    const bare = spawnSync("git", ["-C", repo, "config", "core.fsync"], { encoding: "utf8", env: { PATH: env.PATH, GIT_CONFIG_NOSYSTEM: "1" } });
    expect(bare.stdout.trim()).toBe("none");
  });
});

/**
 * Dirent durability epilogue (release gate P1 follow-up): core.fsync covers
 * FILE contents, but git's files backend renames lockfiles into place
 * without fsyncing parent directories. The delivery must fsync every
 * loose-object fanout dir + objects/ BEFORE the ref update, and the
 * published loose ref file + its whole directory chain through the git
 * store AFTER it — failing the delivery (before delivery.applied) when any
 * sync fails.
 */
describe("publication dirent durability (fanout dirs before update-ref; ref chain after)", () => {
  it("branch delivery with a NESTED new ref: syncs interleave the publication in exactly the safe order", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    const { shimDir, calls } = installGitShim(root);
    // The shim log and the fsync seam append to the same file — one total order.
    const log = join(root, "git-calls.log");
    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    const result = deliver({
      mode: "branch",
      repo,
      runId: "run_dirent",
      artifact,
      casDir: join(root, ".hone-cas"),
      improverSeat: false,
      baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
      branch: "hone/deep/nested/run_dirent",
      env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
      fsyncPath: (path) => appendFileSync(log, `SYNC:${path}\n===\n`),
    });
    expect(result.ref).toBe("hone/deep/nested/run_dirent");
    const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("ARGV:") || l.startsWith("SYNC:"));
    const updateRefAt = lines.findIndex((l) => l.startsWith("ARGV:") && l.includes("update-ref refs/heads/hone/deep/nested/run_dirent"));
    expect(updateRefAt).toBeGreaterThan(0);
    // BEFORE publication: objects/ and at least one fanout dir were synced.
    const before = lines.slice(0, updateRefAt);
    expect(before.some((l) => l === `SYNC:${join(repo, ".git", "objects")}`)).toBe(true);
    expect(before.some((l) => new RegExp(`^SYNC:.*/objects/[0-9a-f]{2}$`).test(l))).toBe(true);
    // AFTER publication: the loose ref file, every newly created refs/…
    // intermediate dir, refs/heads, refs, and the git store itself.
    const after = lines.slice(updateRefAt + 1);
    const gitDir = join(repo, ".git");
    for (const expected of [
      join(gitDir, "refs", "heads", "hone", "deep", "nested", "run_dirent"),
      join(gitDir, "refs", "heads", "hone", "deep", "nested"),
      join(gitDir, "refs", "heads", "hone", "deep"),
      join(gitDir, "refs", "heads", "hone"),
      join(gitDir, "refs", "heads"),
      join(gitDir, "refs"),
      gitDir,
    ]) {
      expect(after, expected).toContain(`SYNC:${expected}`);
    }
    // …and the loose ref file really exists where we synced it.
    expect(existsSync(join(gitDir, "refs", "heads", "hone", "deep", "nested", "run_dirent"))).toBe(true);
  });

  it("a failing OBJECT-DIRENT sync fails the delivery BEFORE any ref is published", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    expect(() =>
      deliver({
        mode: "branch",
        repo,
        runId: "run_syncfail",
        artifact,
        casDir: join(root, ".hone-cas"),
        improverSeat: false,
        baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
        env: process.env,
        fsyncPath: () => {
          throw new Error("EIO: injected fsync failure");
        },
      }),
    ).toThrow(/injected fsync failure/);
    const refs = spawnSync("git", ["-C", repo, "for-each-ref", "refs/heads/hone"], { encoding: "utf8" });
    expect((refs.stdout ?? "").trim()).toBe("");
  });

  it("a failing REF sync (after update-ref) still fails the delivery — no acknowledged-but-volatile publication", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    let objectSyncs = 0;
    expect(() =>
      deliver({
        mode: "branch",
        repo,
        runId: "run_refsyncfail",
        artifact,
        casDir: join(root, ".hone-cas"),
        improverSeat: false,
        baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
        env: process.env,
        fsyncPath: (path) => {
          if (path.includes(join(".git", "refs"))) throw new Error("EIO: injected ref-sync failure");
          objectSyncs++;
        },
      }),
    ).toThrow(/injected ref-sync failure/);
    expect(objectSyncs).toBeGreaterThan(0);
    // The ref exists (update-ref ran) but the delivery FAILED — the caller
    // never emits delivery.applied; the idempotent recovery path completes
    // (and re-syncs) it on the next attempt.
    const again = deliver({
      mode: "branch",
      repo,
      runId: "run_refsyncfail",
      artifact,
      casDir: join(root, ".hone-cas"),
      improverSeat: false,
      baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
      env: process.env,
    });
    expect(again.ref).toBe("hone/run_refsyncfail");
  });

  it("auto delivery syncs the HEAD-branch ref file + chain after the CAS update", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    const synced: string[] = [];
    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    const result = deliver({
      mode: "auto",
      repo,
      runId: "run_dirent_auto",
      runDir: root,
      artifact,
      casDir: join(root, ".hone-cas"),
      improverSeat: false,
      baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
      autoRef: "refs/heads/main",
      env: process.env,
      fsyncPath: (path) => synced.push(path),
    });
    expect(result.ref).toBe("main");
    const gitDir = join(repo, ".git");
    for (const expected of [join(gitDir, "refs", "heads", "main"), join(gitDir, "refs", "heads"), join(gitDir, "refs"), gitDir, join(gitDir, "objects")]) {
      expect(synced).toContain(expected);
    }
  });

  it("idempotent recovery re-syncs a prior publication, tolerating a legitimately packed ref", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    const opts = {
      mode: "branch" as const,
      repo,
      runId: "run_packed",
      artifact,
      casDir: join(root, ".hone-cas"),
      improverSeat: false,
      baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
      env: process.env,
    };
    const first = deliver(opts);
    // A user packs refs between the crashed attempt and the recovery.
    gitIn(repo, "pack-refs", "--all");
    expect(existsSync(join(repo, ".git", "refs", "heads", "hone", "run_packed"))).toBe(false);
    const synced: string[] = [];
    const again = deliver({ ...opts, fsyncPath: (path) => synced.push(path) });
    expect(again.ref).toBe(first.ref);
    expect(synced).toContain(join(repo, ".git", "packed-refs"));
    expect(synced).toContain(join(repo, ".git"));
  });

  it("recovery refuses when the requested loose ref vanishes behind an unrelated packed-refs file", () => {
    const root = makeRoot();
    const repo = hostileRepo(root);
    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    const opts = {
      mode: "branch" as const,
      repo,
      runId: "run_refvanish",
      artifact,
      casDir: join(root, ".hone-cas"),
      improverSeat: false,
      baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
      env: process.env,
    };
    deliver(opts);
    const loose = join(repo, ".git", "refs", "heads", "hone", "run_refvanish");
    const main = gitIn(repo, "rev-parse", "refs/heads/main");
    writeFileSync(join(repo, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${main} refs/heads/main\n`);
    let removed = false;
    expect(() =>
      deliver({
        ...opts,
        fsyncPath: (path) => {
          if (removed || !path.includes(join(".git", "objects"))) return;
          rmSync(loose);
          removed = true;
        },
      }),
    ).toThrow(/published ref refs\/heads\/hone\/run_refvanish.*expected/);
    expect(removed).toBe(true);
  });
});

describe("epilogue primitives (fail closed)", () => {
  it("syncPublishedRef refuses a ref that exists neither loose nor packed", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    expect(() => syncPublishedRef(join(repo, ".git"), "refs/heads/ghost", gitIn(repo, "rev-parse", "HEAD"))).toThrow(/neither.*loose ref nor.*packed ref/);
  });

  it("syncLooseObjectDirs covers every two-hex fanout dir plus objects/ itself", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    mkdirSync(join(repo, ".git", "objects", "ab"), { recursive: true });
    mkdirSync(join(repo, ".git", "objects", "zz-not-fanout"), { recursive: true });
    const synced: string[] = [];
    syncLooseObjectDirs(join(repo, ".git"), (path) => synced.push(path));
    expect(synced).toContain(join(repo, ".git", "objects", "ab"));
    expect(synced[synced.length - 1]).toBe(join(repo, ".git", "objects"));
    expect(synced).not.toContain(join(repo, ".git", "objects", "zz-not-fanout"));
    expect(synced).not.toContain(join(repo, ".git", "objects", "pack"));
  });
});
