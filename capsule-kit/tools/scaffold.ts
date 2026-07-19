/**
 * Capsule scaffolder.
 *
 * Given a task directory containing `capsule.config.json` plus the capsule
 * tree (baseline/ git repo, assets/, diagnostics/ordering-report.json), this:
 *   1. expands asset-group paths to files and sha256-hashes every one,
 *   2. reads the baseline git HEAD commit,
 *   3. validates + hashes the persisted diagnostic-ordering report and embeds
 *      the {path, hash} reference,
 *   4. assembles a CapsuleManifest and zod-validates it,
 *   5. derives the content-addressed id via the canonical @hone/schema
 *      deriveCapsuleId (sha256 over sorted-key no-whitespace JSON sans id),
 *   6. writes manifest.json into the task dir.
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
import {
  CapsuleManifest,
  DiagnosticOrderingReport,
  SCHEMA_VERSION,
  deriveCapsuleId,
} from "@hone/schema";


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

/**
 * Validate the persisted diagnostic-ordering report against the schema and
 * return the manifest reference: capsule-relative path + hash of the exact
 * file bytes. A report that does not parse (or records failures) is not
 * evidence, so scaffolding refuses it.
 */
export function loadDiagnosticOrdering(
  taskDir: string,
  relPath: string,
): { path: string; hash: string } {
  const abs = join(taskDir, relPath);
  if (!existsSync(abs)) {
    throw new Error(
      `diagnostic ordering report missing at ${relPath} — run "pnpm ordering-check -- --report" first`,
    );
  }
  const bytes = readFileSync(abs);
  const report = DiagnosticOrderingReport.parse(JSON.parse(bytes.toString("utf8")));
  if (report.failures.length > 0) {
    throw new Error(
      `diagnostic ordering report records failures — refusing to scaffold: ${report.failures.join("; ")}`,
    );
  }
  return {
    path: relPath,
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/** Scaffold input, colocated with the capsule tree. */
interface CapsuleConfig {
  objective: string;
  image: string;
  evalEntrypoint: string[];
  protectedPaths: string[];
  assetGroups: { id: string; visibility: string; paths: string[] }[];
  budget: Record<string, number>;
  diagnosticOrdering: { path: string };
  sandbox?: { memoryBytes: number; cpus?: number };
  meta?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

/**
 * Boundary validation for capsule.config.json. Structural only — the emitted
 * manifest goes through the authoritative CapsuleManifest.parse afterwards,
 * so anything semantically off (bad visibility, mutable image, partial
 * budget) is still rejected by the shared schema.
 */
function parseCapsuleConfig(raw: unknown): CapsuleConfig {
  const fail = (field: string): never => {
    throw new Error(`capsule.config.json: invalid or missing "${field}"`);
  };
  if (!isRecord(raw)) return fail("<root>");
  const { objective, image, evalEntrypoint, protectedPaths, assetGroups, budget, diagnosticOrdering, meta, sandbox } = raw;
  if (typeof objective !== "string" || objective.length === 0) return fail("objective");
  if (typeof image !== "string" || image.length === 0) return fail("image");
  if (!isStringArray(evalEntrypoint) || evalEntrypoint.length === 0) return fail("evalEntrypoint");
  if (protectedPaths !== undefined && !isStringArray(protectedPaths)) return fail("protectedPaths");
  if (!Array.isArray(assetGroups) || assetGroups.length === 0) return fail("assetGroups");
  const groups = assetGroups.map((g, index) => {
    if (!isRecord(g)) return fail(`assetGroups[${index}]`);
    const { id, visibility, paths } = g;
    if (typeof id !== "string" || id.length === 0) return fail(`assetGroups[${index}].id`);
    if (typeof visibility !== "string") return fail(`assetGroups[${index}].visibility`);
    if (!isStringArray(paths) || paths.length === 0) return fail(`assetGroups[${index}].paths`);
    return { id, visibility, paths };
  });
  if (!isRecord(budget)) return fail("budget");
  const budgetNumbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(budget)) {
    if (typeof value !== "number") return fail(`budget.${key}`);
    budgetNumbers[key] = value;
  }
  if (!isRecord(diagnosticOrdering) || typeof diagnosticOrdering.path !== "string" || diagnosticOrdering.path.length === 0) {
    return fail("diagnosticOrdering.path");
  }
  if (meta !== undefined && !isRecord(meta)) return fail("meta");
  return {
    objective,
    image,
    evalEntrypoint,
    protectedPaths: protectedPaths ?? [],
    assetGroups: groups,
    budget: budgetNumbers,
    diagnosticOrdering: { path: diagnosticOrdering.path },
    ...(isRecord(sandbox) && typeof sandbox.memoryBytes === "number"
      ? {
          sandbox: {
            memoryBytes: sandbox.memoryBytes,
            ...(typeof sandbox.cpus === "number" ? { cpus: sandbox.cpus } : {}),
          },
        }
      : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

export function scaffold(taskDirArg: string): CapsuleManifest {
  const taskDir = resolve(taskDirArg);
  const config = parseCapsuleConfig(
    JSON.parse(readFileSync(join(taskDir, "capsule.config.json"), "utf8")),
  );

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
    ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }),
    diagnosticOrdering: loadDiagnosticOrdering(taskDir, config.diagnosticOrdering.path),
    contentHashes,
    ...(config.meta !== undefined ? { meta: config.meta } : {}),
  };

  const manifest = CapsuleManifest.parse({ ...sansId, id: deriveCapsuleId(sansId) });
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
