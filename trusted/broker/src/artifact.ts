import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasStore } from "./cas.js";
import { runCommand, type RunCommand } from "./command.js";
import { matchesAnyGlob } from "./glob.js";

/**
 * Artifact layout contract (broker-local): an artifact is a tar whose entries
 * are rooted at `workspace/` — exactly what `docker cp <c>:/workspace -`
 * emits. Extracting it at `/` inside a container recreates /workspace, and
 * extracting it on the host yields `<dir>/workspace/…`.
 */

/** Packs a directory tree into a `workspace/`-rooted tar and stores it in CAS. */
export async function packDirAsArtifact(dir: string, cas: CasStore, run: RunCommand = runCommand): Promise<string> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hone-pack-"));
  try {
    await cp(dir, path.join(tmp, "workspace"), { recursive: true });
    const tarPath = path.join(tmp, "artifact.tar");
    // Strip host metadata: macOS xattrs (com.apple.provenance & co.) cannot be
    // restored inside minimal container rootfs and would poison docker cp.
    const metaFlags =
      process.platform === "darwin"
        ? ["--no-xattrs", "--no-mac-metadata", "--no-acls", "--no-fflags"]
        : ["--no-xattrs"];
    const res = await run(["tar", "-C", tmp, ...metaFlags, "-cf", tarPath, "workspace"]);
    if (res.exitCode !== 0) throw new Error(`tar pack failed: ${res.stderr.toString()}`);
    return await cas.putFile(tarPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Unpacks artifact `hash` under `destRoot` and returns the workspace dir.
 * Idempotent: an already-unpacked artifact is returned as-is; extraction goes
 * through a temp dir + rename so a crashed unpack never looks complete.
 */
export async function unpackArtifact(
  cas: CasStore,
  hash: string,
  destRoot: string,
  run: RunCommand = runCommand,
): Promise<string> {
  const finalDir = path.join(destRoot, hash.replace(":", "-"));
  const workspaceDir = path.join(finalDir, "workspace");
  try {
    const entries = await readdir(finalDir);
    if (entries.includes("workspace")) return workspaceDir;
  } catch {
    // not unpacked yet
  }
  const tmp = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(tmp, { recursive: true });
  const res = await run(["tar", "-xf", cas.blobPath(hash), "-C", tmp]);
  if (res.exitCode !== 0) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`tar unpack failed for ${hash}: ${res.stderr.toString()}`);
  }
  try {
    await rename(tmp, finalDir);
  } catch {
    // A concurrent unpack won the rename; ours is redundant.
    await rm(tmp, { recursive: true, force: true });
  }
  return workspaceDir;
}

async function walkFiles(root: string, rel = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [k, v] of await walkFiles(root, entryRel)) out.set(k, v);
    } else if (entry.isFile()) {
      const digest = createHash("sha256")
        .update(await readFile(path.join(root, rel, entry.name)))
        .digest("hex");
      out.set(entryRel, digest);
    } else {
      // symlinks/devices inside an artifact: record kind so a type change diffs
      out.set(entryRel, "special");
    }
  }
  return out;
}

/**
 * Diffs two unpacked trees over the protected globs. Returns every relative
 * path matching a glob that was modified, deleted, or added — any of which is
 * a violation (the protected namespace is frozen wholesale).
 */
export async function diffProtectedPaths(
  baselineDir: string,
  candidateDir: string,
  protectedGlobs: readonly string[],
): Promise<string[]> {
  if (protectedGlobs.length === 0) return [];
  const [base, cand] = await Promise.all([walkFiles(baselineDir), walkFiles(candidateDir)]);
  const violations = new Set<string>();
  for (const [rel, digest] of base) {
    if (!matchesAnyGlob(rel, protectedGlobs)) continue;
    if (cand.get(rel) !== digest) violations.add(rel);
  }
  for (const rel of cand.keys()) {
    if (!base.has(rel) && matchesAnyGlob(rel, protectedGlobs)) violations.add(rel);
  }
  return [...violations].sort();
}

/** Recursive on-disk size in bytes — scratch quota accounting. */
export async function dirSizeBytes(root: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(p);
    } else if (entry.isFile()) {
      total += (await stat(p)).size;
    }
  }
  return total;
}
