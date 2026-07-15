import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@hone/schema";
import { UsageError } from "./args.js";

/**
 * Deterministic optimizer identity (M0 conformance): the run seals the EXACT
 * bytes of the default optimizer that will execute — an allowlisted closed
 * dependency graph collected with lstat (regular files and directories only;
 * any symlink or special file refuses), hashed together with each file's
 * relative path and permission bits, the immutable manifest image, and the
 * container build contract (the exact bun-build/run argv the trusted runner
 * executes). Sealed into the contract, run.started, and BrokerConfig (eval
 * memo key).
 *
 * The same collected snapshot is what actually runs: backend setup recollects,
 * requires digest equality with the run.started seal, writes the CAPTURED
 * bytes to a staging tree, and compiles them inside the pinned image with no
 * network and no repo mount — an import outside this graph cannot resolve.
 *
 * Allowlisted graph:
 *   optimizer/src, optimizer/assets, optimizer/package.json,
 *   optimizer/tsconfig.json          — the executed loop
 *   schema/src, schema/package.json  — trusted @hone/schema SOURCE (not just
 *                                      the lock: the workspace link resolves
 *                                      to this tree)
 *   pnpm-lock.yaml                   — workspace-wide dependency resolution
 *   the resolved zod package         — the loop's only external runtime dep
 */

export const OPTIMIZER_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Entries under the optimizer trees that never affect the executed loop. */
const OPTIMIZER_SKIP: Record<string, true> = {
  test: true,
  node_modules: true,
  dist: true,
  ".cache": true,
  "vitest.config.ts": true,
  ".tsbuildinfo": true,
};

/** One captured snapshot entry: the exact bytes and permission bits sealed by the digest. */
export interface SnapshotFile {
  bytes: Buffer;
  /** lstat mode & 0o777 at collection time. */
  mode: number;
}

/** The collected optimizer closure, keyed by collection-relative posix path. */
export interface OptimizerSnapshot {
  files: Map<string, SnapshotFile>;
}

/**
 * The frozen container build/run contract — hashed into the optimizer digest
 * so a changed compiler invocation, entrypoint, staging layout, or runtime
 * argv re-seals the identity. /hone/src is the read-only staging mount,
 * /hone/out the isolated writable output, /hone/bundle the read-only bundle
 * mount of the run container.
 */
export const OPTIMIZER_BUILD_CONTRACT = {
  version: 1,
  layout: {
    optimizer: "optimizer",
    schema: "optimizer/node_modules/@hone/schema",
    zod: "optimizer/node_modules/zod",
    "pnpm-lock.yaml": "pnpm-lock.yaml",
  },
  build: ["bun", "build", "/hone/src/optimizer/src/main.ts", "--target=node", "--outfile=/hone/out/optimizer.mjs"],
  run: ["node", "/hone/bundle/optimizer.mjs"],
} as const;

/** The hone repo root: this module lives at trusted/cli/src/. */
export function repoRootFromHere(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** lstat gate: the collected graph admits regular files and directories ONLY. */
function lstatGuard(abs: string, rel: string): Stats {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new UsageError(`optimizer snapshot refuses symlink ${rel} (${abs}) — the sealed graph admits regular files and directories only`);
  }
  if (!st.isFile() && !st.isDirectory()) {
    throw new UsageError(`optimizer snapshot refuses special file ${rel} (${abs}) — the sealed graph admits regular files and directories only`);
  }
  return st;
}

function collectTree(absDir: string, relDir: string, into: Map<string, SnapshotFile>, skip: Record<string, true> | null): void {
  lstatGuard(absDir, relDir);
  for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip !== null && skip[entry.name] === true) continue;
    const abs = join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    const st = lstatGuard(abs, rel);
    if (st.isDirectory()) collectTree(abs, rel, into, skip);
    else into.set(rel, { bytes: readFileSync(abs), mode: st.mode & 0o777 });
  }
}

function collectFile(abs: string, rel: string, into: Map<string, SnapshotFile>): void {
  const st = lstatGuard(abs, rel);
  if (!st.isFile()) throw new UsageError(`optimizer snapshot input is not a regular file: ${rel} (${abs})`);
  into.set(rel, { bytes: readFileSync(abs), mode: st.mode & 0o777 });
}

/** The resolved zod package directory, from the optimizer package's own resolution. */
function resolveZodDir(optimizerDir: string): string {
  try {
    const require = createRequire(join(optimizerDir, "package.json"));
    return dirname(require.resolve("zod/package.json"));
  } catch (e) {
    throw new UsageError(`cannot resolve the optimizer's zod dependency from ${optimizerDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Collect the exact allowlisted optimizer closure. Every entry is captured
 * as bytes at collection time — the digest and the staged build both consume
 * THIS capture, so nothing can drift between hashing and execution.
 */
export function collectOptimizerSnapshot(repoRoot: string = repoRootFromHere()): OptimizerSnapshot {
  const optimizerDir = join(repoRoot, "optimizer");
  if (!existsSync(optimizerDir)) {
    throw new UsageError(`default optimizer not found at ${optimizerDir} — cannot collect an optimizer snapshot`);
  }
  const files = new Map<string, SnapshotFile>();
  if (!existsSync(join(optimizerDir, "src", "main.ts"))) {
    throw new UsageError(`optimizer entry missing: ${join(optimizerDir, "src", "main.ts")}`);
  }
  collectTree(join(optimizerDir, "src"), "optimizer/src", files, OPTIMIZER_SKIP);
  if (existsSync(join(optimizerDir, "assets"))) collectTree(join(optimizerDir, "assets"), "optimizer/assets", files, OPTIMIZER_SKIP);
  for (const rel of ["package.json", "tsconfig.json"]) {
    const abs = join(optimizerDir, rel);
    if (existsSync(abs)) collectFile(abs, `optimizer/${rel}`, files);
  }
  const schemaDir = join(repoRoot, "schema");
  if (!existsSync(join(schemaDir, "src"))) {
    throw new UsageError(`trusted schema source not found at ${join(schemaDir, "src")} — the optimizer snapshot must seal it`);
  }
  collectTree(join(schemaDir, "src"), "schema/src", files, null);
  collectFile(join(schemaDir, "package.json"), "schema/package.json", files);
  const lock = join(repoRoot, "pnpm-lock.yaml");
  if (existsSync(lock)) collectFile(lock, "pnpm-lock.yaml", files);
  collectTree(resolveZodDir(optimizerDir), "zod", files, null);
  return { files };
}

/** Digest of a collected snapshot: exact bytes + paths + modes + image + build contract. */
export function snapshotDigest(image: string, snapshot: OptimizerSnapshot): string {
  const files: Record<string, { hash: string; mode: number }> = {};
  for (const rel of [...snapshot.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const f = snapshot.files.get(rel);
    if (f === undefined) continue;
    files[rel] = { hash: sha256Hex(f.bytes), mode: f.mode };
  }
  return `sha256:${sha256Hex(canonicalJson({ image, build: OPTIMIZER_BUILD_CONTRACT, files }))}`;
}

/** Digest of the DEFAULT optimizer inputs plus the manifest image. */
export function computeOptimizerDigest(image: string, repoRoot: string = repoRootFromHere()): string {
  return snapshotDigest(image, collectOptimizerSnapshot(repoRoot));
}

/** Collection-relative path -> staging-tree path (OPTIMIZER_BUILD_CONTRACT.layout). */
function stagedRel(rel: string): string {
  if (rel.startsWith("optimizer/")) return rel;
  if (rel.startsWith("schema/")) return `${OPTIMIZER_BUILD_CONTRACT.layout.schema}/${rel.slice("schema/".length)}`;
  if (rel.startsWith("zod/")) return `${OPTIMIZER_BUILD_CONTRACT.layout.zod}/${rel.slice("zod/".length)}`;
  if (rel === "pnpm-lock.yaml") return rel;
  throw new UsageError(`optimizer snapshot entry outside the allowlisted layout: ${rel}`);
}

/**
 * Materialize the CAPTURED bytes as the build container's source tree. The
 * workspace @hone/schema link and the zod dependency become plain physical
 * node_modules directories, so module resolution inside the container cannot
 * escape the sealed graph. Files are written with the captured mode plus
 * world-read (the build runs as an unprivileged uid).
 */
export function writeOptimizerStaging(snapshot: OptimizerSnapshot, stagingDir: string): void {
  for (const [rel, f] of snapshot.files) {
    const abs = join(stagingDir, stagedRel(rel));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.bytes, { mode: f.mode | 0o444 });
  }
}

/** True when HONE_OPTIMIZER_CMD replaces the in-container run argv. */
export function optimizerOverridden(env: NodeJS.ProcessEnv): boolean {
  const cmd = env["HONE_OPTIMIZER_CMD"];
  return cmd !== undefined && cmd.trim().length > 0;
}

/**
 * The digest sealed into the run. Default optimizer → computed from the real
 * inputs (an explicit HONE_OPTIMIZER_DIGEST must then MATCH — a stale pin is
 * misleading and fails closed). Overridden in-container command → the operator
 * must supply a valid explicit digest; there is nothing trusted to compute
 * one from. HONE_OPTIMIZER_ENTRY (the old host-path entry escape) is gone:
 * the optimizer only ever executes from the sealed containerized snapshot.
 */
export function resolveOptimizerDigest(env: NodeJS.ProcessEnv, image: string, repoRoot: string = repoRootFromHere()): string {
  if (env["HONE_OPTIMIZER_ENTRY"] !== undefined) {
    throw new UsageError(
      "HONE_OPTIMIZER_ENTRY is no longer supported: the optimizer executes only from the sealed containerized snapshot (use HONE_OPTIMIZER_CMD with an explicit HONE_OPTIMIZER_DIGEST for an in-container argv override)",
    );
  }
  const explicit = env["HONE_OPTIMIZER_DIGEST"];
  if (optimizerOverridden(env)) {
    if (explicit === undefined || !OPTIMIZER_DIGEST_RE.test(explicit)) {
      throw new UsageError(
        "HONE_OPTIMIZER_CMD replaces the in-container optimizer argv — supply a valid explicit HONE_OPTIMIZER_DIGEST (sha256:<64 hex>) for the run to seal",
      );
    }
    return explicit;
  }
  const computed = computeOptimizerDigest(image, repoRoot);
  if (explicit !== undefined && explicit !== computed) {
    throw new UsageError(`HONE_OPTIMIZER_DIGEST ${explicit} does not match the computed default-optimizer digest ${computed} — refusing a misleading pin`);
  }
  return computed;
}
