import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { UsageError } from "./args.js";

/**
 * The capsules root is the directory whose direct children are capsule
 * directories. It is independent of the hone state root (`io.root`, where
 * `.hone-runs/`, `.hone-cas/` and `.hone-sources/` live), so capsules can come
 * from a separate checkout.
 *
 * Precedence: `--capsules-root <dir>` > `HONE_CAPSULES_ROOT` > `<root>/capsules`.
 * Relative values resolve against the state root.
 */
export const CAPSULES_ROOT_FLAG = "--capsules-root";
export const CAPSULES_ROOT_ENV = "HONE_CAPSULES_ROOT";
/**
 * Default capsules directory name under the state root, and the leading
 * segment of repository-relative capsule paths recorded in frozen evidence
 * (`capsules/<label>/...`).
 */
export const CAPSULES_DIR_NAME = "capsules";

export interface CapsulesRootSource {
  /** Hone state root (the CLI's io.root). */
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  /** Raw `--capsules-root` value, when given. */
  readonly capsulesRoot?: string | undefined;
}

/** Both roots a command needs to locate capsules and repository-relative evidence. */
export interface CapsulePaths {
  /** Hone state root: run state and non-capsule repository-relative paths. */
  readonly root: string;
  /** Absolute capsules root: direct children are capsule directories. */
  readonly capsulesRoot: string;
}

export interface ResolveCapsulesRootOptions {
  /**
   * Accept an absent default `<root>/capsules` (the caller creates it). An
   * explicit flag or environment value must always name an existing directory.
   */
  readonly allowMissingDefault?: boolean;
}

/** Split a global `--capsules-root <dir>` / `--capsules-root=<dir>` out of argv. */
export function extractCapsulesRootFlag(argv: readonly string[]): { argv: string[]; capsulesRoot?: string } {
  const rest: string[] = [];
  let capsulesRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    let value: string | undefined;
    if (arg === CAPSULES_ROOT_FLAG) {
      value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${CAPSULES_ROOT_FLAG} requires a value`);
      index += 1;
    } else if (arg.startsWith(`${CAPSULES_ROOT_FLAG}=`)) {
      value = arg.slice(CAPSULES_ROOT_FLAG.length + 1);
    } else {
      rest.push(arg);
      continue;
    }
    if (capsulesRoot !== undefined) throw new UsageError(`${CAPSULES_ROOT_FLAG} may be given only once`);
    if (value === "") throw new UsageError(`${CAPSULES_ROOT_FLAG} requires a non-empty directory`);
    capsulesRoot = value;
  }
  return capsulesRoot === undefined ? { argv: rest } : { argv: rest, capsulesRoot };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The one resolver for the capsules root: flag > env > `<root>/capsules`. */
export function resolveCapsulesRoot(
  source: CapsulesRootSource,
  options: ResolveCapsulesRootOptions = {},
): string {
  if (source.capsulesRoot !== undefined) {
    const dir = resolve(source.root, source.capsulesRoot);
    if (!isDirectory(dir)) {
      throw new UsageError(`${CAPSULES_ROOT_FLAG} ${source.capsulesRoot}: ${dir} is not an existing directory`);
    }
    return dir;
  }
  const fromEnv = source.env[CAPSULES_ROOT_ENV];
  if (fromEnv !== undefined) {
    if (fromEnv === "") {
      throw new UsageError(`${CAPSULES_ROOT_ENV} is set but empty; unset it for ${join(source.root, CAPSULES_DIR_NAME)} or name a capsules directory`);
    }
    const dir = resolve(source.root, fromEnv);
    if (!isDirectory(dir)) {
      throw new UsageError(`${CAPSULES_ROOT_ENV}=${fromEnv}: ${dir} is not an existing directory`);
    }
    return dir;
  }
  const dir = resolve(source.root, CAPSULES_DIR_NAME);
  if (options.allowMissingDefault !== true && !isDirectory(dir)) {
    throw new UsageError(
      `capsules root ${dir} does not exist; pass ${CAPSULES_ROOT_FLAG} <dir> or set ${CAPSULES_ROOT_ENV}`,
    );
  }
  return dir;
}

export function capsulePaths(source: CapsulesRootSource): CapsulePaths {
  return { root: resolve(source.root), capsulesRoot: resolveCapsulesRoot(source) };
}

/**
 * Resolve a repository-relative path recorded in frozen configs and evidence.
 * `capsules/<rest>` names a file inside the capsules root, whatever that
 * directory is called; every other relative path resolves against the state
 * root. Absolute paths are returned unchanged.
 */
export function resolveRepoPath(paths: CapsulePaths, path: string): string {
  const prefix = `${CAPSULES_DIR_NAME}/`;
  if (path.startsWith(prefix)) return resolve(paths.capsulesRoot, path.slice(prefix.length));
  return resolve(paths.root, path);
}
