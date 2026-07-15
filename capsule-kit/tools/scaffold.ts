/**
 * Capsule scaffolder.
 *
 * Given a task directory containing `capsule.config.json` plus the capsule
 * tree (baseline/ git repo, assets/), this:
 *   1. expands asset-group paths to files and sha256-hashes every one,
 *   2. reads the baseline git HEAD commit,
 *   3. assembles a CapsuleManifest and zod-validates it,
 *   4. derives the content-addressed id: "cap_" + first 12 hex of sha256 over
 *      the canonical (sorted-key, no-whitespace JSON) manifest sans id,
 *   5. writes manifest.json into the task dir.
 *
 * Re-running over an unchanged tree yields byte-identical output — the id is
 * reproducible because nothing time- or machine-dependent enters the hash.
 *
 * Usage: npx tsx capsules/tools/scaffold.ts <task-dir>
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CapsuleManifest, SCHEMA_VERSION } from "@hone/schema";

/** Deterministic JSON: recursively sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** "cap_" + first 12 hex of sha256 over the canonical manifest sans id. */
export function deriveCapId(manifestSansId: Record<string, unknown>): string {
  const { id: _dropped, ...rest } = manifestSansId;
  const digest = createHash("sha256")
    .update(canonicalJson(rest))
    .digest("hex");
  return `cap_${digest.slice(0, 12)}`;
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Expand a capsule-relative path (file or directory) to sorted file paths. */
function expandPaths(taskDir: string, relPath: string): string[] {
  const abs = join(taskDir, relPath);
  const stat = statSync(abs);
  if (stat.isFile()) return [relPath];
  const files: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath ?? abs;
    const rel = join(relPath, parent.slice(abs.length + 1) || "", entry.name)
      .split("\\")
      .join("/");
    files.push(rel);
  }
  return files.sort();
}

function baselineGitHead(taskDir: string): string {
  // The inner repo's git dir is stored as `.gitdir` (not `.git`) so the outer
  // hone repo tracks baseline FILES instead of a content-less gitlink.
  const baselineDir = join(taskDir, "baseline");
  const gitDir = existsSync(join(baselineDir, ".gitdir"))
    ? join(baselineDir, ".gitdir")
    : join(baselineDir, ".git");
  try {
    return execFileSync("git", ["--git-dir", gitDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    throw new Error(
      `baseline/ must contain a git dir (.gitdir or .git) with at least one commit (${String(err)})`,
    );
  }
}

/** Scaffold input, colocated with the capsule tree. */
interface CapsuleConfig {
  objective: string;
  image: string;
  evalEntrypoint: string[];
  protectedPaths?: string[];
  assetGroups: { id: string; visibility: string; paths: string[] }[];
  budget: Record<string, number>;
  meta?: Record<string, unknown>;
}

export function scaffold(taskDirArg: string): CapsuleManifest {
  const taskDir = resolve(taskDirArg);
  const config = JSON.parse(
    readFileSync(join(taskDir, "capsule.config.json"), "utf8"),
  ) as CapsuleConfig;

  const assetGroups = config.assetGroups.map((group) => ({
    ...group,
    paths: group.paths.flatMap((p) => expandPaths(taskDir, p)),
  }));
  const contentHashes: Record<string, string> = {};
  for (const group of assetGroups) {
    for (const rel of group.paths) {
      contentHashes[rel] = sha256File(join(taskDir, rel));
    }
  }

  const sansId: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    objective: config.objective,
    baseline: { kind: "git", commit: baselineGitHead(taskDir) },
    image: config.image,
    evalEntrypoint: config.evalEntrypoint,
    protectedPaths: config.protectedPaths ?? [],
    assetGroups,
    budget: config.budget,
    contentHashes,
    ...(config.meta !== undefined ? { meta: config.meta } : {}),
  };

  const manifest = CapsuleManifest.parse({ ...sansId, id: deriveCapId(sansId) });
  writeFileSync(
    join(taskDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const taskDir = process.argv[2];
  if (!taskDir) {
    console.error("usage: tsx capsules/tools/scaffold.ts <task-dir>");
    process.exit(2);
  }
  const manifest = scaffold(taskDir);
  console.log(`${manifest.id}  ->  ${join(resolve(taskDir), "manifest.json")}`);
}
