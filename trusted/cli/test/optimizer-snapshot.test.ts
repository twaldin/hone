import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPTIMIZER_BUILD_CONTRACT,
  collectOptimizerSnapshot,
  computeOptimizerDigest,
  optimizerOverridden,
  resolveOptimizerDigest,
  snapshotDigest,
  writeOptimizerStaging,
} from "../src/optimizer-digest.js";
import { FIX_IMAGE } from "./helpers.js";

/**
 * Exact-snapshot identity (M1 containment): the digest seals the exact bytes,
 * relative paths, and modes of the allowlisted optimizer closure plus the
 * image and the container build contract; collection lstat-refuses anything
 * that is not a regular file or directory; staging replays the CAPTURED
 * bytes, never a re-read of the repo.
 */

/** Minimal synthetic repo tree that satisfies the allowlist. */
function syntheticRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hone-fakerepo-"));
  mkdirSync(join(root, "optimizer", "src"), { recursive: true });
  mkdirSync(join(root, "optimizer", "assets"), { recursive: true });
  mkdirSync(join(root, "optimizer", "node_modules", "zod"), { recursive: true });
  mkdirSync(join(root, "schema", "src"), { recursive: true });
  writeFileSync(join(root, "optimizer", "src", "main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "optimizer", "assets", "policy.ts"), "export const policy = 1;\n");
  writeFileSync(join(root, "optimizer", "package.json"), '{"name":"@hone/optimizer"}\n');
  writeFileSync(join(root, "optimizer", "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "optimizer", "node_modules", "zod", "package.json"), '{"name":"zod","main":"index.js"}\n');
  writeFileSync(join(root, "optimizer", "node_modules", "zod", "index.js"), "module.exports = {};\n");
  writeFileSync(join(root, "schema", "src", "index.ts"), "export const schema = 1;\n");
  writeFileSync(join(root, "schema", "package.json"), '{"name":"@hone/schema"}\n');
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  return root;
}

describe("lstat collection gate: regular files and directories ONLY", () => {
  it("refuses a symlink anywhere in the allowlisted graph", () => {
    const root = syntheticRepo();
    symlinkSync("/etc/hosts", join(root, "optimizer", "src", "evil.ts"));
    expect(() => collectOptimizerSnapshot(root)).toThrow(/refuses symlink/);
  });

  it("refuses a symlinked DIRECTORY (a graph escape, not just a file alias)", () => {
    const root = syntheticRepo();
    symlinkSync(tmpdir(), join(root, "schema", "src", "outside"));
    expect(() => collectOptimizerSnapshot(root)).toThrow(/refuses symlink/);
  });

  it("refuses a special file (fifo)", () => {
    const root = syntheticRepo();
    const fifo = join(root, "optimizer", "src", "pipe.ts");
    const made = spawnSync("mkfifo", [fifo]);
    if (made.status !== 0) return; // platform without mkfifo — the symlink cases still cover the gate
    expect(() => collectOptimizerSnapshot(root)).toThrow(/refuses special file/);
  });
});

describe("digest inputs: bytes, paths, modes, image, build contract", () => {
  it("is deterministic for an unchanged tree", () => {
    const root = syntheticRepo();
    expect(computeOptimizerDigest("img@sha256:aa", root)).toBe(computeOptimizerDigest("img@sha256:aa", root));
  });

  it("changes when optimizer source changes", () => {
    const root = syntheticRepo();
    const before = computeOptimizerDigest("img@sha256:aa", root);
    writeFileSync(join(root, "optimizer", "src", "main.ts"), "export const main = 2;\n");
    expect(computeOptimizerDigest("img@sha256:aa", root)).not.toBe(before);
  });

  it("changes when trusted SCHEMA SOURCE changes (not only the lock)", () => {
    const root = syntheticRepo();
    const before = computeOptimizerDigest("img@sha256:aa", root);
    writeFileSync(join(root, "schema", "src", "index.ts"), "export const schema = 2;\n");
    expect(computeOptimizerDigest("img@sha256:aa", root)).not.toBe(before);
  });

  it("changes when the resolved zod dependency changes", () => {
    const root = syntheticRepo();
    const before = computeOptimizerDigest("img@sha256:aa", root);
    writeFileSync(join(root, "optimizer", "node_modules", "zod", "index.js"), "module.exports = { hacked: true };\n");
    expect(computeOptimizerDigest("img@sha256:aa", root)).not.toBe(before);
  });

  it("changes when the workspace lock changes", () => {
    const root = syntheticRepo();
    const before = computeOptimizerDigest("img@sha256:aa", root);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 10\n");
    expect(computeOptimizerDigest("img@sha256:aa", root)).not.toBe(before);
  });

  it("changes with the pinned image", () => {
    const root = syntheticRepo();
    expect(computeOptimizerDigest("img@sha256:aa", root)).not.toBe(computeOptimizerDigest("img@sha256:bb", root));
  });

  it("changes when a file's mode changes", () => {
    const root = syntheticRepo();
    const before = computeOptimizerDigest("img@sha256:aa", root);
    chmodSync(join(root, "optimizer", "src", "main.ts"), 0o755);
    expect(computeOptimizerDigest("img@sha256:aa", root)).not.toBe(before);
  });

  it("the real default-optimizer digest computes and matches the snapshot digest", () => {
    const snapshot = collectOptimizerSnapshot();
    expect(snapshotDigest(FIX_IMAGE, snapshot)).toBe(computeOptimizerDigest(FIX_IMAGE));
    // The sealed closure includes the trusted schema source and the resolved zod package.
    const keys = [...snapshot.files.keys()];
    expect(keys).toContain("optimizer/src/main.ts");
    expect(keys.some((k) => k.startsWith("schema/src/"))).toBe(true);
    expect(keys).toContain("schema/package.json");
    expect(keys.some((k) => k.startsWith("zod/"))).toBe(true);
  });
});

describe("staging: the CAPTURED bytes at the frozen layout", () => {
  it("writes exact captured bytes even when the repo mutates after collection", () => {
    const root = syntheticRepo();
    const snapshot = collectOptimizerSnapshot(root);
    // Race window attack: mutate the repo AFTER collection — the staged tree
    // must carry the hashed capture, not the drifted re-read.
    writeFileSync(join(root, "optimizer", "src", "main.ts"), "export const main = 666;\n");
    const staging = mkdtempSync(join(tmpdir(), "hone-staging-"));
    writeOptimizerStaging(snapshot, staging);
    expect(readFileSync(join(staging, "optimizer", "src", "main.ts"), "utf8")).toBe("export const main = 1;\n");
    // Layout per OPTIMIZER_BUILD_CONTRACT: schema + zod become physical node_modules.
    expect(readFileSync(join(staging, "optimizer", "node_modules", "@hone", "schema", "src", "index.ts"), "utf8")).toBe("export const schema = 1;\n");
    expect(readFileSync(join(staging, "optimizer", "node_modules", "zod", "index.js"), "utf8")).toBe("module.exports = {};\n");
    expect(existsSync(join(staging, "pnpm-lock.yaml"))).toBe(true);
  });

  it("the build contract compiles the staged entry with no repo path", () => {
    expect(OPTIMIZER_BUILD_CONTRACT.build[0]).toBe("bun");
    expect(OPTIMIZER_BUILD_CONTRACT.build).toContain("/hone/src/optimizer/src/main.ts");
    expect(OPTIMIZER_BUILD_CONTRACT.run).toEqual(["node", "/hone/bundle/optimizer.mjs"]);
  });
});

describe("resolveOptimizerDigest: entry escape is gone", () => {
  it("refuses HONE_OPTIMIZER_ENTRY outright", () => {
    expect(() => resolveOptimizerDigest({ HONE_OPTIMIZER_ENTRY: "/tmp/x.mjs" }, FIX_IMAGE)).toThrow(/no longer supported/);
  });

  it("only HONE_OPTIMIZER_CMD counts as an override", () => {
    expect(optimizerOverridden({ HONE_OPTIMIZER_CMD: "node x.mjs" })).toBe(true);
    expect(optimizerOverridden({})).toBe(false);
  });
});
