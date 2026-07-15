import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@hone/schema";
import { UsageError } from "./args.js";

/**
 * Deterministic optimizer digest (M0 conformance): binds the run to the exact
 * default optimizer that will execute — its source, prompt/policy assets, its
 * package manifest, the workspace-wide dependency resolution (root
 * pnpm-lock.yaml), and the sandbox image the mutations run in. Sealed into the
 * contract, run.started, and BrokerConfig (eval memo key).
 *
 * Tests, node_modules, and runtime caches are excluded: they cannot change
 * what the optimizer executes.
 */

export const OPTIMIZER_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Directory entries under optimizer/ that never affect the executed loop. */
const OPTIMIZER_SKIP: Record<string, true> = {
  test: true,
  node_modules: true,
  dist: true,
  ".cache": true,
  "vitest.config.ts": true,
  ".tsbuildinfo": true,
};

/** Digest inputs: the executed entry/source/assets plus dependency resolution. */
const OPTIMIZER_INPUT_DIRS = ["src", "assets"];
const OPTIMIZER_INPUT_FILES = ["package.json", "tsconfig.json"];
const ROOT_INPUT_FILES = ["pnpm-lock.yaml"];

/** The hone repo root: this module lives at trusted/cli/src/. */
export function repoRootFromHere(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

function collectFiles(dir: string, root: string, into: Record<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (OPTIMIZER_SKIP[entry.name] === true) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(abs, root, into);
    } else if (entry.isFile()) {
      into[relative(root, abs)] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  }
}

/** Digest of the DEFAULT optimizer inputs plus the manifest image. */
export function computeOptimizerDigest(image: string, repoRoot: string = repoRootFromHere()): string {
  const optimizerDir = join(repoRoot, "optimizer");
  if (!existsSync(optimizerDir)) {
    throw new UsageError(`default optimizer not found at ${optimizerDir} — cannot compute an optimizer digest`);
  }
  const files: Record<string, string> = {};
  for (const dir of OPTIMIZER_INPUT_DIRS) {
    const abs = join(optimizerDir, dir);
    if (existsSync(abs)) collectFiles(abs, repoRoot, files);
  }
  for (const rel of OPTIMIZER_INPUT_FILES) {
    const abs = join(optimizerDir, rel);
    if (existsSync(abs)) files[relative(repoRoot, abs)] = createHash("sha256").update(readFileSync(abs)).digest("hex");
  }
  for (const rel of ROOT_INPUT_FILES) {
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) files[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
  }
  if (Object.keys(files).length === 0) {
    throw new UsageError(`no optimizer digest inputs found under ${optimizerDir}`);
  }
  return `sha256:${createHash("sha256").update(canonicalJson({ image, files })).digest("hex")}`;
}

/** True when HONE_OPTIMIZER_CMD/HONE_OPTIMIZER_ENTRY replace the default optimizer. */
export function optimizerOverridden(env: NodeJS.ProcessEnv): boolean {
  const cmd = env["HONE_OPTIMIZER_CMD"];
  return (cmd !== undefined && cmd.trim().length > 0) || env["HONE_OPTIMIZER_ENTRY"] !== undefined;
}

/**
 * The digest sealed into the run. Default optimizer → computed from the real
 * inputs (an explicit HONE_OPTIMIZER_DIGEST must then MATCH — a stale pin is
 * misleading and fails closed). Overridden command → the operator must supply
 * a valid explicit digest; there is nothing trusted to compute one from.
 */
export function resolveOptimizerDigest(env: NodeJS.ProcessEnv, image: string, repoRoot: string = repoRootFromHere()): string {
  const explicit = env["HONE_OPTIMIZER_DIGEST"];
  if (optimizerOverridden(env)) {
    if (explicit === undefined || !OPTIMIZER_DIGEST_RE.test(explicit)) {
      throw new UsageError(
        "HONE_OPTIMIZER_CMD/HONE_OPTIMIZER_ENTRY replace the default optimizer — supply a valid explicit HONE_OPTIMIZER_DIGEST (sha256:<64 hex>) for the run to seal",
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
