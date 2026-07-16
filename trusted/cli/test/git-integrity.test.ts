import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deliver } from "../src/deliver.js";
import { materializeGitCommit } from "../src/git-baseline.js";
import { appendGitConfigEnv } from "../src/git-integrity.js";
import { gitIn, initScratchRepo, makeRoot, tarToCas } from "./helpers.js";

/**
 * Git object/ref AUTHENTICITY (release blocker): ordinary read plumbing
 * (cat-file, ls-tree, rev-parse, merge-base) serves loose objects without
 * recomputing their ids, so a valid-zlib object stored under the WRONG oid
 * silently rides every ancestry/tree/byte proof. Every trusted store must be
 * hash-verified with `git fsck --strict` BEFORE any read is trusted or any
 * write is made — and none of the repo-local config knobs that defang fsck
 * (fsck.skipList, fsck.<msg>=ignore/warn), nor grafts/replace-ref ancestry
 * rewriting, may survive into the verification or the proofs.
 */

const CAS = ".hone-cas";

function branchOpts(root: string, repo: string, runId: string) {
  const artifact = tarToCas(root, { "hello.txt": "improved\n" });
  return {
    mode: "branch" as const,
    repo,
    runId,
    artifact,
    casDir: join(root, CAS),
    improverSeat: false,
    baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
    env: process.env,
  };
}

/** Recursive `<path>[:size]` listing — the no-side-effect proof for refusal tests. */
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

/**
 * Overwrite the loose object file of `oid` with DIFFERENT valid object bytes
 * — the forgery ordinary read plumbing serves as `oid` without complaint.
 */
function forgeLooseObject(gitDir: string, oid: string, type: string, content: Buffer): void {
  const path = join(gitDir, "objects", oid.slice(0, 2), oid.slice(2));
  expect(existsSync(path)).toBe(true);
  chmodSync(path, 0o644);
  writeFileSync(path, deflateSync(Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content])));
}

function refExists(repo: string, ref: string): boolean {
  return spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref]).status === 0;
}

const INTEGRITY_REFUSAL = /object-integrity verification failed[\s\S]*refusing before any read is trusted or any write is made/;

describe("forged object bytes under valid ids are refused before any trust or write", () => {
  it("a forged loose BLOB (served verbatim by cat-file) fails the delivery-target verification with zero side effects", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_forged_blob");
    const blob = gitIn(repo, "rev-parse", "HEAD:hello.txt");
    forgeLooseObject(join(repo, ".git"), blob, "blob", Buffer.from("forged\n"));
    // The vulnerability premise: the ordinary read path serves the forged
    // bytes as the original oid without any complaint.
    expect(gitIn(repo, "cat-file", "blob", blob)).toBe("forged");
    const before = snapshotDir(join(repo, ".git"));
    expect(() => deliver(opts)).toThrow(INTEGRITY_REFUSAL);
    expect(refExists(repo, "refs/heads/hone/run_forged_blob")).toBe(false);
    expect(snapshotDir(join(repo, ".git"))).toEqual(before);
  });

  it("a forged loose COMMIT (valid commit bytes, wrong oid) fails the same way", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_forged_commit");
    const head = gitIn(repo, "rev-parse", "HEAD");
    // Valid commit object text with a different message — only the bytes lie.
    const original = gitIn(repo, "cat-file", "commit", head);
    const forged = Buffer.from(`${original.slice(0, original.lastIndexOf("\n\n"))}\n\nforged\n`);
    forgeLooseObject(join(repo, ".git"), head, "commit", forged);
    expect(() => deliver(opts)).toThrow(INTEGRITY_REFUSAL);
    expect(refExists(repo, "refs/heads/hone/run_forged_commit")).toBe(false);
  });

  it("a forged loose TREE (structurally valid, retargeted entry) fails the same way", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_forged_tree");
    const tree = gitIn(repo, "rev-parse", "HEAD^{tree}");
    // Raw tree bytes with the final entry-sha byte flipped: still a
    // structurally valid tree, pointing somewhere else.
    const raw = spawnSync("git", ["-C", repo, "cat-file", "tree", tree]);
    expect(raw.status).toBe(0);
    const bytes = Buffer.from(raw.stdout);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    forgeLooseObject(join(repo, ".git"), tree, "tree", bytes);
    expect(() => deliver(opts)).toThrow(INTEGRITY_REFUSAL);
    expect(refExists(repo, "refs/heads/hone/run_forged_tree")).toBe(false);
  });

  it("a corrupted PACKED store fails verification before any write", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_forged_pack");
    gitIn(repo, "repack", "-adq");
    const packDir = join(repo, ".git", "objects", "pack");
    const pack = readdirSync(packDir).find((f) => f.endsWith(".pack"));
    expect(pack).toBeDefined();
    const packPath = join(packDir, pack ?? "");
    const raw = spawnSync("cat", [packPath]);
    const bytes = Buffer.from(raw.stdout);
    // Flip one byte in the object data region (past the 12-byte header,
    // before the trailing checksum): both the per-object CRC and the pack
    // checksum break deterministically.
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = bytes[mid]! ^ 0xff;
    chmodSync(packPath, 0o644);
    writeFileSync(packPath, bytes);
    expect(() => deliver(opts)).toThrow(INTEGRITY_REFUSAL);
    expect(refExists(repo, "refs/heads/hone/run_forged_pack")).toBe(false);
  });

  it("baseline materialization refuses a forged store BEFORE creating the destination", () => {
    const root = makeRoot();
    const baselineDir = join(root, "baseline");
    initScratchRepo(baselineDir);
    const commit = gitIn(baselineDir, "rev-parse", "HEAD");
    const blob = gitIn(baselineDir, "rev-parse", "HEAD:hello.txt");
    forgeLooseObject(join(baselineDir, ".git"), blob, "blob", Buffer.from("forged\n"));
    const dest = join(root, "materialized");
    expect(() => materializeGitCommit(baselineDir, commit, dest)).toThrow(INTEGRITY_REFUSAL);
    // Refused before a single byte of the destination exists.
    expect(existsSync(dest)).toBe(false);
  });
});

describe("hostile fsck-defanging config is neutralized", () => {
  it("a repo-local fsck.skipList listing the forged oid does not exempt it", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_skiplist");
    const blob = gitIn(repo, "rev-parse", "HEAD:hello.txt");
    forgeLooseObject(join(repo, ".git"), blob, "blob", Buffer.from("forged\n"));
    const skips = join(root, "skips.txt");
    writeFileSync(skips, `${blob}\n`);
    gitIn(repo, "config", "fsck.skipList", skips);
    expect(() => deliver(opts)).toThrow(INTEGRITY_REFUSAL);
    expect(refExists(repo, "refs/heads/hone/run_skiplist")).toBe(false);
  });

  it("a repo-local fsck.<msg>=ignore cannot silence a malformed object (severity re-pinned to error)", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_fsck_ignore");
    // A structurally malformed commit object (author line without an email)
    // written under its REAL id — content-level, not a hash mismatch, so
    // its detection lives entirely in msg-id-classified fsck checks.
    const tree = gitIn(repo, "rev-parse", "HEAD^{tree}");
    const bad = `tree ${tree}\nauthor A U Thor 1112911993 -0700\ncommitter A U Thor 1112911993 -0700\n\nbad\n`;
    const hashed = spawnSync("git", ["-C", repo, "hash-object", "-t", "commit", "--literally", "-w", "--stdin"], {
      input: bad,
      encoding: "utf8",
    });
    expect(hashed.status).toBe(0);
    // The downgrade a hostile store would ship: without neutralization this
    // makes `git fsck --strict` exit 0 over the malformed object.
    gitIn(repo, "config", "fsck.missingEmail", "ignore");
    expect(() => deliver(opts)).toThrow(INTEGRITY_REFUSAL);
    expect(refExists(repo, "refs/heads/hone/run_fsck_ignore")).toBe(false);
  });

  it("the same severity downgrade on a CLEAN store does not break delivery (neutralization has no false positives)", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_fsck_clean");
    gitIn(repo, "config", "fsck.missingEmail", "ignore");
    gitIn(repo, "config", "fsck.badTimezone", "warn");
    const result = deliver(opts);
    expect(result.ref).toBe("hone/run_fsck_clean");
    expect(refExists(repo, "refs/heads/hone/run_fsck_clean")).toBe(true);
  });
});

describe("caller GIT_CONFIG_COUNT entries survive the verification pins", () => {
  it("appended pins resolve at command scope WITHOUT clobbering the caller's own injected entries", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    // A hostile local pin the command scope must outrank.
    gitIn(repo, "config", "core.commitGraph", "true");
    const callerEnv: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"] ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: devNull,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "hone.caller",
      GIT_CONFIG_VALUE_0: "kept",
    };
    const env = appendGitConfigEnv(callerEnv, [
      ["core.commitgraph", "false"],
      ["fsck.skiplist", devNull],
    ]);
    const resolve = (key: string): string => {
      const r = spawnSync("git", ["-C", repo, "config", "--get", key], { env, encoding: "utf8" });
      expect(r.status).toBe(0);
      return r.stdout.trim();
    };
    // Git's own config resolution: the caller entry is still visible…
    expect(resolve("hone.caller")).toBe("kept");
    // …and the appended pin wins over the hostile local value.
    expect(resolve("core.commitgraph")).toBe("false");
    expect(resolve("fsck.skiplist")).toBe(devNull);
  });
});

describe("grafted ancestry and replace refs cannot forge containment", () => {
  it("a nonempty info/grafts refuses delivery before any write, with zero side effects", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_grafts");
    writeFileSync(join(repo, ".git", "info", "grafts"), `${opts.baselineCommit}\n`);
    const before = snapshotDir(join(repo, ".git"));
    const synced: string[] = [];
    expect(() => deliver({ ...opts, fsyncPath: (path) => synced.push(path) })).toThrow(/nonempty info\/grafts/);
    expect(refExists(repo, "refs/heads/hone/run_grafts")).toBe(false);
    expect(snapshotDir(join(repo, ".git"))).toEqual(before);
    expect(synced).toEqual([]);
  });

  it("a whitespace-only grafts file is inert and delivery proceeds", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_grafts_ws");
    writeFileSync(join(repo, ".git", "info", "grafts"), "\n  \n");
    expect(deliver(opts).ref).toBe("hone/run_grafts_ws");
  });

  it("a grafts file appearing MID-FLIGHT aborts at the prewrite gate before the branch ref is created", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_grafts_mid");
    // syncLooseObjectDirs fires immediately before the prewrite gate.
    let planted = false;
    expect(() =>
      deliver({
        ...opts,
        fsyncPath: () => {
          if (!planted) {
            planted = true;
            writeFileSync(join(repo, ".git", "info", "grafts"), `${opts.baselineCommit}\n`);
          }
        },
      }),
    ).toThrow(/nonempty info\/grafts/);
    expect(planted).toBe(true);
    expect(refExists(repo, "refs/heads/hone/run_grafts_mid")).toBe(false);
  });

  it("a grafts file appearing between a delivery and its resume refuses recovery with no durability work", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const opts = branchOpts(root, repo, "run_grafts_rec");
    expect(deliver(opts).ref).toBe("hone/run_grafts_rec");
    const tip = gitIn(repo, "rev-parse", "--verify", "refs/heads/hone/run_grafts_rec");
    writeFileSync(join(repo, ".git", "info", "grafts"), `${opts.baselineCommit}\n`);
    const synced: string[] = [];
    expect(() => deliver({ ...opts, fsyncPath: (path) => synced.push(path) })).toThrow(/nonempty info\/grafts/);
    expect(synced).toEqual([]);
    expect(gitIn(repo, "rev-parse", "--verify", "refs/heads/hone/run_grafts_rec")).toBe(tip);
  });

  it("a replace ref grafting the baseline into an unrelated repository does not forge containment", () => {
    const root = makeRoot();
    const source = join(root, "source");
    initScratchRepo(source);
    const baseline = gitIn(source, "rev-parse", "HEAD");

    // An UNRELATED repository that imported the baseline objects and
    // replace-grafted its own HEAD onto them.
    const repo = join(root, "unrelated");
    mkdirSync(repo);
    gitIn(repo, "init", "-b", "main");
    gitIn(repo, "config", "user.name", "hone-test");
    gitIn(repo, "config", "user.email", "hone-test@localhost");
    writeFileSync(join(repo, "other.txt"), "unrelated\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-m", "unrelated");
    gitIn(repo, "fetch", source, "HEAD");
    const head = gitIn(repo, "rev-parse", "HEAD");
    // The classic replace-graft: a twin of HEAD whose parent is the sealed
    // baseline, substituted for HEAD via refs/replace/.
    const graft = gitIn(repo, "commit-tree", `${head}^{tree}`, "-p", baseline, "-m", "grafted twin");
    gitIn(repo, "replace", "-f", head, graft);
    // The escape exists: with replace refs honored, the baseline "is" an
    // ancestor of HEAD in this unrelated repository.
    expect(spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", baseline, "HEAD"]).status).toBe(0);

    const artifact = tarToCas(root, { "hello.txt": "improved\n" });
    const opts = {
      mode: "branch" as const,
      repo,
      runId: "run_replace",
      artifact,
      casDir: join(root, CAS),
      improverSeat: false,
      baselineCommit: baseline,
      env: process.env,
    };
    expect(() => deliver(opts)).toThrow(/does not contain the sealed baseline commit/);
    expect(refExists(repo, "refs/heads/hone/run_replace")).toBe(false);
  });
});
