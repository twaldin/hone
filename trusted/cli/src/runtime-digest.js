// Plain-JS trusted-runtime digest — the boot-time seal of everything this
// process executes as trusted code. DELIBERATELY dependency-free (node:
// builtins only) so `bin/hone.js` can compute and seal the digest BEFORE
// tsx is registered and before any trusted TypeScript (or zod, or esbuild)
// is ever loaded from disk: the bytes are hashed strictly before they can
// run. The supervisor imports THIS SAME module for its recomputations, so
// the boot value and every later recheck are produced by identical code.
//
// Digest domain (v3):
//   - repo workspace manifests (package.json, pnpm-lock.yaml,
//     pnpm-workspace.yaml) — dependency-graph identity;
//   - the tsconfig closure the tsx loader can consult (extends chains,
//     baseUrl/paths remaps), fail-closed against escapes;
//   - every trusted workspace package's runtime files (package.json, bin/,
//     src/ or dist/);
//   - the ACTUAL INSTALLED BYTES of every non-workspace production
//     dependency reachable from the trusted workspace closure
//     (tsx → esbuild → platform binary; zod; …): regular-file bytes and
//     modes and the resolution topology (importer → name → resolved real
//     path), recursively through each package's dependency/optional/peer
//     closure, bounded and fail-closed. A lockfile-stable edit of installed
//     dependency bytes drifts the digest.
//
// Two closure-wide hardening rules bind the digest to the EXACT bytes that
// execute:
//   - SYMLINKS ARE REFUSED everywhere in the authenticated closure. A
//     symlink's literal never seals its target's bytes: a dependency file
//     replaced by a link whose target mutates later would keep a
//     literal-hashing digest stable while different bytes execute. Any
//     symlink in a trusted workspace tree, a tsconfig chain, or an
//     installed dependency package fails the seal closed.
//   - EVERY FILE IS READ EXACTLY ONCE per computation, through O_NOFOLLOW +
//     fstat on the very fd that is read; the same buffer feeds the hash AND
//     (when sealing an execution snapshot) the staged copy — there is no
//     hash-then-reread window.
//
// sealRuntimeSnapshot() extends the boot seal into an EXECUTION seal: the
// captured bytes are staged into a fresh no-clobber, fsynced,
// mode-restricted snapshot directory (workspace packages and installed
// dependencies hoisted under one node_modules), the whole snapshot is
// rehashed immediately before the loader handoff, and bin/hone.js imports
// tsx and main.ts ONLY from that sealed path. A mutable-repo edit landing
// after the seal is therefore inert for the running process: the sealed
// prior bytes execute, and the boot-bound recheck against the LIVE repo
// (verifiedBootRuntimeDigest) still refuses to pin or resume a run over
// drifted source.
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Process-wide, write-once boot seal. A Symbol.for registry key survives
 * any accidental double-instantiation of this module (native import from
 * bin/hone.js vs a loader-served copy, or the sealed-snapshot copy the
 * supervisor executes): there is exactly ONE boot digest per process,
 * sealed non-writable and non-configurable. */
const BOOT_KEY = Symbol.for("hone.trusted-runtime-boot-digest");

/** Process-wide, write-once pin of the trusted CLI package root in the
 * LIVE repository. bin/hone.js pins it (via the repo copy of this module)
 * before any snapshot exists; the snapshot copy the supervisor executes
 * reads the pin, so boot-bound recomputations keep hashing the live repo
 * — never the immutable snapshot they happen to run from. */
const CLI_ROOT_KEY = Symbol.for("hone.trusted-runtime-cli-root");

/** Dependency-closure bounds — generous for the trusted seed (tsx + esbuild
 * + one platform binary + zod ≈ 16 MB / ~700 files) yet hard, so a hostile
 * store can never stall the boot seal. Exceeding any bound fails closed. */
const MAX_DEP_PACKAGES = 256;
const MAX_DEP_FILES = 50_000;
const MAX_DEP_BYTES = 512 * 1024 * 1024;

/** Per-file sink used while sealing an execution snapshot: receives the
 * SAME buffer that was hashed, plus the snapshot-relative destination and
 * the source mode.
 * @typedef {(rel: string, bytes: Buffer, mode: number) => void} SnapshotSink */

/** @param {string} startPath @returns {string} */
export function packageRootOf(startPath) {
  let dir = dirname(startPath);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${startPath} — cannot identify the trusted runtime`);
    dir = parent;
  }
}

/**
 * The trusted CLI package root in the live repository, pinned write-once on
 * first use. The pin is taken from the module instance that actually runs
 * first — for a real boot that is the repo copy imported by bin/hone.js,
 * strictly before any snapshot copy of this module can exist.
 * @returns {string}
 */
export function trustedCliRoot() {
  const holder = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  const existing = holder[CLI_ROOT_KEY];
  if (typeof existing === "string") return existing;
  const root = packageRootOf(fileURLToPath(import.meta.url));
  Object.defineProperty(globalThis, CLI_ROOT_KEY, {
    value: root,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return root;
}

/** The hone repository root above the pinned trusted CLI package root.
 * @returns {string} */
export function trustedRepoRoot() {
  return packageRootOf(dirname(trustedCliRoot()));
}

/**
 * Read one trusted file's exact bytes, fail-closed against link games: the
 * final path component is opened O_NOFOLLOW (a symlink refuses with a
 * precise error), the open fd is fstat-checked to be a regular file (a
 * FIFO/device/socket planted in the closure refuses), and the returned
 * buffer is read from that very fd — every caller hashes (and stages) the
 * one byte sequence that was actually read.
 * @param {string} abs @returns {{ bytes: Buffer, mode: number }}
 */
function readTrustedFile(abs) {
  /** @type {number} */
  let fd;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = e instanceof Error ? /** @type {NodeJS.ErrnoException} */ (e).code : undefined;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(
        `trusted runtime input ${abs} is a symlink — symlinks are refused in the trusted runtime closure (a link literal never seals its target's bytes); refusing to seal the trusted runtime`,
      );
    }
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`trusted runtime input ${abs} is not a regular file — refusing to seal the trusted runtime`);
    }
    return { bytes: readFileSync(fd), mode: st.mode & 0o7777 };
  } finally {
    closeSync(fd);
  }
}

/** Fail-closed minimal package.json shape (plain JS — this runs before zod
 * is admitted): name optional string; each dependency map, when present,
 * must be a string→string record.
 * @param {string} path @returns {{ name: string | undefined, dependencies: Record<string, string>, optionalDependencies: Record<string, string>, peerDependencies: Record<string, string> }} */
function readManifest(path) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readTrustedFile(path).bytes.toString("utf8"));
  } catch (e) {
    throw new Error(`package manifest ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — refusing to seal the trusted runtime`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`package manifest ${path} is not an object — refusing to seal the trusted runtime`);
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const name = record["name"];
  if (name !== undefined && typeof name !== "string") {
    throw new Error(`package manifest ${path} has a non-string name — refusing to seal the trusted runtime`);
  }
  /** @param {string} field @returns {Record<string, string>} */
  const depMap = (field) => {
    const value = record[field];
    if (value === undefined) return {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`package manifest ${path} has a malformed ${field} — refusing to seal the trusted runtime`);
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const [dep, version] of Object.entries(value)) {
      if (typeof version !== "string") {
        throw new Error(`package manifest ${path} pins ${field}.${dep} to a non-string — refusing to seal the trusted runtime`);
      }
      out[dep] = version;
    }
    return out;
  };
  return {
    name,
    dependencies: depMap("dependencies"),
    optionalDependencies: depMap("optionalDependencies"),
    peerDependencies: depMap("peerDependencies"),
  };
}

/**
 * Transitive trusted workspace closure, COMPUTED from package.json
 * `workspace:` dependencies starting at the CLI package — never a hand
 * list, so a trusted dependency of a dependency (e.g. broker → scoring)
 * can never silently escape the pin. Sorted by package name.
 * @returns {[string, string][]}
 */
function trustedRuntimeRoots() {
  /** @type {Map<string, string>} */
  const roots = new Map();
  /** @param {string} root @returns {void} */
  const visit = (root) => {
    const pkg = readManifest(join(root, "package.json"));
    const name = pkg.name ?? root;
    if (roots.has(name)) return;
    roots.set(name, root);
    for (const [dep, version] of Object.entries(pkg.dependencies)) {
      if (!version.startsWith("workspace:")) continue;
      const depRoot = resolvePackageDir(dep, root);
      if (depRoot === null) {
        throw new Error(`trusted workspace dependency ${dep} from ${root} is not installed — refusing to seal the trusted runtime`);
      }
      visit(depRoot);
    }
  };
  visit(trustedCliRoot());
  return [...roots.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Sorted runtime files (package-relative): package.json, the runtime entry stubs under bin/, and everything under src/ (dev checkout) or dist/ (compiled). Symlinks anywhere in the tree refuse.
 * @param {string} root @returns {string[]} */
function runtimeFilesOf(root) {
  /** @type {string[]} */
  const files = ["package.json"];
  /** @param {string} rel @returns {void} */
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = join(rel, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `trusted workspace entry ${join(root, child)} is a symlink — symlinks are refused in the trusted runtime closure; refusing to seal the trusted runtime`,
        );
      }
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|js|mjs|cjs|json)$/.test(entry.name)) files.push(child);
    }
  };
  for (const base of [existsSync(join(root, "src")) ? "src" : "dist", "bin"]) {
    const abs = join(root, base);
    if (!existsSync(abs)) continue;
    if (lstatSync(abs).isSymbolicLink()) {
      throw new Error(
        `trusted workspace entry ${abs} is a symlink — symlinks are refused in the trusted runtime closure; refusing to seal the trusted runtime`,
      );
    }
    walk(base);
  }
  return files.sort();
}

/** The tsconfig fields the tsx loader acts on: extends chain + module-resolution remaps (plain-JS fail-closed shape check).
 * @param {string} abs @param {unknown} raw @returns {{ extendsList: string[], baseUrl: string | undefined, paths: Record<string, string[]> }} */
function tsconfigShape(abs, raw) {
  const refuse = () => new Error(`tsconfig ${abs} does not have a sealable shape — refusing to seal the trusted runtime`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw refuse();
  const record = /** @type {Record<string, unknown>} */ (raw);
  const ext = record["extends"];
  /** @type {string[]} */
  let extendsList = [];
  if (typeof ext === "string") extendsList = [ext];
  else if (Array.isArray(ext)) {
    if (ext.some((base) => typeof base !== "string")) throw refuse();
    extendsList = /** @type {string[]} */ (ext);
  } else if (ext !== undefined) throw refuse();
  const options = record["compilerOptions"];
  /** @type {string | undefined} */
  let baseUrl;
  /** @type {Record<string, string[]>} */
  const paths = {};
  if (options !== undefined) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) throw refuse();
    const opts = /** @type {Record<string, unknown>} */ (options);
    const rawBase = opts["baseUrl"];
    if (rawBase !== undefined && typeof rawBase !== "string") throw refuse();
    baseUrl = /** @type {string | undefined} */ (rawBase);
    const rawPaths = opts["paths"];
    if (rawPaths !== undefined) {
      if (typeof rawPaths !== "object" || rawPaths === null || Array.isArray(rawPaths)) throw refuse();
      for (const [alias, targets] of Object.entries(rawPaths)) {
        if (!Array.isArray(targets) || targets.some((t) => typeof t !== "string")) throw refuse();
        paths[alias] = /** @type {string[]} */ (targets);
      }
    }
  }
  return { extendsList, baseUrl, paths };
}

/** Refuse a tsconfig closure member that is itself a symlink (before any
 * realpath canonicalization can silently follow it).
 * @param {string} abs @returns {void} */
function refuseTsconfigSymlink(abs) {
  if (lstatSync(abs).isSymbolicLink()) {
    throw new Error(
      `tsconfig ${abs} is a symlink — symlinks are refused in the trusted runtime closure; refusing to seal the trusted runtime`,
    );
  }
}

/**
 * Every tsconfig the tsx loader can consult for the trusted runtime: the
 * repo-root tsconfig(.base).json, each trusted package root's
 * tsconfig.json, and everything reachable through `extends`. Fail-closed
 * validation (exported for adversarial tests):
 *  - every file in the closure must live at the repo root or inside a
 *    trusted package root (never node_modules) — an `extends` that walks
 *    outside the trusted workspace closure refuses;
 *  - `extends` must be a relative path — package-resolved (node_modules)
 *    or absolute bases refuse;
 *  - `compilerOptions.baseUrl`/`paths` remaps must resolve inside a trusted
 *    package root — a mapping that redirects a trusted import to unsealed
 *    code (optimizer/, /tmp, node_modules) refuses;
 *  - a closure member that is itself a symlink refuses.
 * @param {string} repoRoot @param {string[]} packageRoots @returns {{ rel: string, abs: string }[]}
 */
export function collectTsconfigClosure(repoRoot, packageRoots) {
  const realRepoRoot = realpathSync(repoRoot);
  const trustedRoots = packageRoots.map((r) => realpathSync(r));
  /** @param {string} abs @returns {boolean} */
  const insideTrustedPackage = (abs) =>
    trustedRoots.some((r) => abs === r || abs.startsWith(`${r}${sep}`)) && !abs.split(sep).includes("node_modules");

  /** @type {string[]} */
  const queue = [];
  for (const candidate of [
    join(realRepoRoot, "tsconfig.json"),
    join(realRepoRoot, "tsconfig.base.json"),
    ...trustedRoots.map((r) => join(r, "tsconfig.json")),
  ]) {
    if (!existsSync(candidate)) continue;
    refuseTsconfigSymlink(candidate);
    queue.push(realpathSync(candidate));
  }
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {{ rel: string, abs: string }[]} */
  const files = [];
  while (queue.length > 0) {
    const abs = queue.shift();
    if (abs === undefined || seen.has(abs)) continue;
    seen.add(abs);
    if (dirname(abs) !== realRepoRoot && !insideTrustedPackage(abs)) {
      throw new Error(`tsconfig ${abs} escapes the trusted workspace closure — refusing to seal the trusted runtime`);
    }
    /** @type {unknown} */
    let raw;
    try {
      raw = JSON.parse(readTrustedFile(abs).bytes.toString("utf8"));
    } catch (e) {
      throw new Error(`tsconfig ${abs} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — refusing to seal the trusted runtime`);
    }
    const parsed = tsconfigShape(abs, raw);
    files.push({ rel: relative(realRepoRoot, abs), abs });

    const dir = dirname(abs);
    for (const base of parsed.extendsList) {
      if (!base.startsWith("./") && !base.startsWith("../")) {
        throw new Error(
          `tsconfig ${abs} extends ${JSON.stringify(base)} — package-resolved (node_modules) or absolute bases escape the trusted workspace closure; refusing to seal the trusted runtime`,
        );
      }
      let target = resolve(dir, base);
      if (!existsSync(target) && existsSync(`${target}.json`)) target = `${target}.json`;
      if (!existsSync(target)) {
        throw new Error(`tsconfig ${abs} extends ${JSON.stringify(base)}, which does not resolve — refusing to seal the trusted runtime`);
      }
      refuseTsconfigSymlink(target);
      queue.push(realpathSync(target));
    }

    const mapBase = parsed.baseUrl === undefined ? dir : resolve(dir, parsed.baseUrl);
    const canonBase = existsSync(mapBase) ? realpathSync(mapBase) : mapBase;
    if (parsed.baseUrl !== undefined && !insideTrustedPackage(canonBase)) {
      throw new Error(
        `tsconfig ${abs} sets baseUrl ${JSON.stringify(parsed.baseUrl)} outside the trusted workspace closure — refusing to seal the trusted runtime`,
      );
    }
    for (const [alias, targets] of Object.entries(parsed.paths)) {
      for (const mapped of targets) {
        const dest = resolve(canonBase, mapped.replace(/\*/g, ""));
        const canonDest = existsSync(dest) ? realpathSync(dest) : dest;
        if (!insideTrustedPackage(canonDest)) {
          throw new Error(
            `tsconfig ${abs} maps ${JSON.stringify(alias)} → ${JSON.stringify(mapped)}, escaping the trusted workspace closure — refusing to seal the trusted runtime`,
          );
        }
      }
    }
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Resolve the installed directory of package `name` exactly as Node module
 * resolution would from `fromDir`: nearest `node_modules/<name>` walking up,
 * then realpath (pnpm's node_modules entries are symlinks into the store).
 * Deliberately independent of the package's `exports` map or main entry —
 * platform binary packages (@esbuild/*) have no resolvable JS entry, but
 * their installed bytes ARE part of the executed runtime.
 * @param {string} name @param {string} fromDir @returns {string | null}
 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Deterministic capture of one installed package directory: every regular
 * file's mode and bytes, sorted, bounded, fail-closed on anything that is
 * not a file or a directory. SYMLINKS REFUSE OUTRIGHT: a link literal never
 * seals its target's bytes, so a dependency file replaced by a symlink
 * whose out-of-package target mutates later must never verify.
 * @param {import("node:crypto").Hash} digest
 * @param {string} key stable digest key of this package (repo-relative real path)
 * @param {string} pkgDir
 * @param {{ files: number, bytes: number }} budget
 * @param {SnapshotSink | null} sink
 * @param {string} hoistName snapshot node_modules name (import specifier)
 * @returns {void}
 */
function hashInstalledPackage(digest, key, pkgDir, budget, sink, hoistName) {
  /** @param {string} rel @returns {void} */
  const walk = (rel) => {
    const dirAbs = rel === "" ? pkgDir : join(pkgDir, rel);
    for (const name of readdirSync(dirAbs).sort()) {
      const abs = join(dirAbs, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        throw new Error(
          `installed dependency ${key} contains a symlink at ${JSON.stringify(childRel)} — symlinks are refused in the trusted runtime closure (a link literal never seals its target's bytes); refusing to seal the trusted runtime`,
        );
      }
      if (st.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!st.isFile()) {
        throw new Error(`installed dependency ${key} contains a non-regular entry at ${JSON.stringify(childRel)} — refusing to seal the trusted runtime`);
      }
      const { bytes, mode } = readTrustedFile(abs);
      budget.files += 1;
      budget.bytes += bytes.length;
      if (budget.files > MAX_DEP_FILES || budget.bytes > MAX_DEP_BYTES) {
        throw new Error(
          `trusted dependency closure exceeds the seal bounds (${budget.files} files / ${budget.bytes} bytes) — refusing to seal the trusted runtime`,
        );
      }
      digest.update(`\0depfile\0${key}\0${childRel}\0${mode.toString(8)}\0`);
      digest.update(bytes);
      if (sink !== null) sink(`node_modules/${hoistName}/${childRel}`, bytes, mode);
    }
  };
  walk("");
}

/**
 * Seal the ACTUAL installed production dependency bytes of the trusted
 * workspace closure — not just the manifests and lockfile. Every
 * non-workspace dependency of every trusted package is resolved from ITS
 * importing package's context, then each resolved package's own
 * dependency/optional/peer closure is followed recursively (skipping
 * optional/peer names that do not resolve — a per-platform absence is
 * expected; a missing REQUIRED dependency refuses). Each distinct resolved
 * real path is hashed once (bytes + modes; symlinks refuse), and every
 * resolution EDGE is hashed too, so retargeting a pnpm symlink to a
 * different store entry drifts the digest even when both entries' bytes are
 * individually intact.
 *
 * When `sink` is set (execution-snapshot sealing) the closure must also be
 * HOISTABLE: every import name resolves to exactly one installed directory
 * and every directory is imported under exactly one name, so the snapshot's
 * single flat node_modules reproduces the live resolution topology exactly.
 * Anything else refuses.
 * @param {import("node:crypto").Hash} digest
 * @param {string} repoRoot
 * @param {[string, string][]} roots trusted workspace [name, root] pairs
 * @param {SnapshotSink | null} sink
 * @returns {void}
 */
function hashDependencyClosure(digest, repoRoot, roots, sink) {
  const realRepoRoot = realpathSync(repoRoot);
  /** @param {string} abs @returns {string} */
  const keyOf = (abs) => {
    const rel = relative(realRepoRoot, abs);
    if (rel === "" || rel.startsWith("..")) {
      throw new Error(`trusted dependency resolves outside the repository (${abs}) — refusing to seal the trusted runtime`);
    }
    return rel.split(sep).join("/");
  };

  /** @type {{ importerKey: string, importerDir: string, name: string, optional: boolean }[]} */
  const queue = [];
  for (const [name, root] of roots) {
    const pkg = readManifest(join(root, "package.json"));
    for (const [dep, version] of Object.entries(pkg.dependencies)) {
      if (version.startsWith("workspace:")) continue;
      queue.push({ importerKey: `workspace:${name}`, importerDir: realpathSync(root), name: dep, optional: false });
    }
    for (const dep of Object.keys(pkg.optionalDependencies)) {
      queue.push({ importerKey: `workspace:${name}`, importerDir: realpathSync(root), name: dep, optional: true });
    }
  }
  // Deterministic order regardless of discovery interleaving: hash edges and
  // packages from sorted collections, not from queue order.
  /** @type {Map<string, string>} */
  const packages = new Map(); // key → absolute real path
  /** @type {Map<string, string>} */
  const hoistNameOf = new Map(); // key → import name (snapshot hoist name)
  /** @type {Map<string, string>} */
  const hoistOwner = new Map(); // import name → key
  /** @type {Set<string>} */
  const edges = new Set(); // "importerKey → name → resolvedKey"
  /** @type {Set<string>} */
  const seenEdges = new Set();
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const edgeId = `${item.importerKey}\0${item.name}`;
    if (seenEdges.has(edgeId)) continue;
    seenEdges.add(edgeId);
    const resolved = resolvePackageDir(item.name, item.importerDir);
    if (resolved === null) {
      if (item.optional) {
        edges.add(`\0depedge\0${item.importerKey}\0${item.name}\0(unresolved-optional)\0`);
        continue;
      }
      throw new Error(
        `trusted dependency ${item.name} (required by ${item.importerKey}) does not resolve to an installed package — refusing to seal the trusted runtime`,
      );
    }
    const key = keyOf(resolved);
    edges.add(`\0depedge\0${item.importerKey}\0${item.name}\0${key}\0`);
    if (sink !== null) {
      const owner = hoistOwner.get(item.name);
      if (owner !== undefined && owner !== key) {
        throw new Error(
          `trusted dependency ${item.name} resolves to two installed directories (${owner} and ${key}) — the closure is not hoistable; refusing to seal the execution snapshot`,
        );
      }
      hoistOwner.set(item.name, key);
      const named = hoistNameOf.get(key);
      if (named !== undefined && named !== item.name) {
        throw new Error(
          `installed dependency ${key} is imported under two names (${named} and ${item.name}) — the closure is not hoistable; refusing to seal the execution snapshot`,
        );
      }
      hoistNameOf.set(key, item.name);
    }
    if (!packages.has(key)) {
      if (packages.size >= MAX_DEP_PACKAGES) {
        throw new Error(`trusted dependency closure exceeds ${MAX_DEP_PACKAGES} packages — refusing to seal the trusted runtime`);
      }
      packages.set(key, resolved);
      const pkg = readManifest(join(resolved, "package.json"));
      for (const dep of Object.keys(pkg.dependencies)) {
        queue.push({ importerKey: key, importerDir: resolved, name: dep, optional: false });
      }
      for (const dep of [...Object.keys(pkg.optionalDependencies), ...Object.keys(pkg.peerDependencies)]) {
        queue.push({ importerKey: key, importerDir: resolved, name: dep, optional: true });
      }
    }
  }
  for (const edge of [...edges].sort()) digest.update(edge);
  const budget = { files: 0, bytes: 0 };
  for (const [key, abs] of [...packages.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hashInstalledPackage(digest, key, abs, budget, sink, hoistNameOf.get(key) ?? key);
  }
}

/**
 * Deterministic digest of the trusted runtime this process executes: the
 * COMPUTED transitive workspace closure (cli, broker, proxy, scoring,
 * schema — whatever `workspace:` dependencies actually reach), each hashed
 * as sorted package-scoped path + content pairs, plus the repo lockfile and
 * workspace manifest, the tsx-consulted tsconfig closure, and the installed
 * bytes of the non-workspace production dependency closure. Pinned into
 * each run dir at creation (.hone-version); resume recomputes and REFUSES
 * on any drift before an event is appended or a backend launches — a run
 * never mixes trusted source. Optimizer files are deliberately excluded:
 * they are mutable by design and sealed separately (optimizerDigest), as is
 * the frozen capsule (capsule snapshot digest).
 *
 * `sink`, when set, receives every EXECUTABLE closure file (workspace
 * package runtime files and installed dependency files) as the exact buffer
 * that was hashed plus its snapshot-relative hoisted destination — the
 * capture that sealRuntimeSnapshot() stages. One read serves both.
 *
 * `captured`, when set by the launcher, supplies bytes that the launcher
 * itself already read O_NOFOLLOW and is executing from memory. In
 * production this contains runtime-digest.js, so the boot-critical sealer
 * implementation is hashed and staged from the exact buffer being
 * executed, never from a second pathname read.
 * @param {SnapshotSink | null} [sink]
 * @param {Map<string, { bytes: Buffer, mode: number }> | null} [captured]
 * @returns {string}
 */
export function computeTrustedRuntimeDigest(sink = null, captured = null) {
  const digest = createHash("sha256");
  digest.update("hone-trusted-runtime-v3");
  const repoRoot = trustedRepoRoot();
  /** @type {Set<string>} */
  const consumedCaptured = new Set();
  for (const rel of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const path = join(repoRoot, rel);
    if (existsSync(path)) {
      digest.update(`\0workspace\0${rel}\0`);
      digest.update(readTrustedFile(path).bytes);
    }
  }
  const roots = trustedRuntimeRoots();
  // The tsx loader consults tsconfig for the module graph it actually
  // builds (extends chains, baseUrl/paths remaps): a mapping edit could
  // redirect a trusted import to unsealed code without touching src/.
  // Seal the whole consulted closure; a closure that escapes the trusted
  // workspace refuses outright (collectTsconfigClosure throws).
  for (const file of collectTsconfigClosure(repoRoot, roots.map(([, root]) => root))) {
    digest.update(`\0tsconfig\0${file.rel}\0`);
    digest.update(readTrustedFile(file.abs).bytes);
  }
  for (const [name, root] of roots) {
    if (sink !== null && (name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === "" || part === "." || part === ".."))) {
      throw new Error(`trusted workspace package at ${root} has no hoistable package name — refusing to seal the execution snapshot`);
    }
    for (const rel of runtimeFilesOf(root)) {
      const abs = join(root, rel);
      const supplied = captured?.get(abs);
      if (
        supplied !== undefined &&
        (!Buffer.isBuffer(supplied.bytes) || !Number.isInteger(supplied.mode) || supplied.mode < 0)
      ) {
        throw new Error(`launcher-supplied trusted runtime capture for ${abs} is malformed — refusing to seal`);
      }
      const { bytes, mode } = supplied ?? readTrustedFile(abs);
      if (supplied !== undefined) consumedCaptured.add(abs);
      digest.update(`\0${name}\0${rel}\0`);
      digest.update(bytes);
      if (sink !== null) sink(`node_modules/${name}/${rel.split(sep).join("/")}`, bytes, mode);
    }
  }
  if (captured !== null && consumedCaptured.size !== captured.size) {
    const unused = [...captured.keys()].filter((abs) => !consumedCaptured.has(abs));
    throw new Error(
      `launcher supplied ${unused.length} capture(s) outside the trusted runtime closure (${unused.slice(0, 3).join(", ")}) — refusing to seal`,
    );
  }
  hashDependencyClosure(digest, repoRoot, roots, sink);
  return `sha256:${digest.digest("hex")}`;
}

/**
 * Seal the boot digest: compute the complete trusted closure digest NOW and
 * retain it as immutable process state (non-writable, non-configurable).
 * `bin/hone.js` seals it (via sealRuntimeSnapshot) BEFORE registering tsx
 * and before importing any trusted TypeScript, so the sealed value
 * describes the bytes that were on disk strictly before any of them could
 * execute. Idempotent: a second call returns the already-sealed value.
 * @returns {string}
 */
export function sealBootRuntimeDigest() {
  const holder = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
  const existing = holder[BOOT_KEY];
  if (typeof existing === "string") return existing;
  const digest = computeTrustedRuntimeDigest();
  Object.defineProperty(globalThis, BOOT_KEY, {
    value: digest,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return digest;
}

/**
 * Boot-bound drift gate: recompute the complete closure digest RIGHT NOW
 * and refuse unless it still equals the boot seal (sealed on first use when
 * no bootstrap ran — from then on the process is boot-bound exactly like a
 * production start). Returns the BOOT value — callers persist the digest of
 * the source that is actually executing, never a late disk state.
 * Synchronous end to end: there is no await between the comparison and the
 * returned value's use.
 * @returns {string}
 */
export function verifiedBootRuntimeDigest() {
  const boot = sealBootRuntimeDigest();
  const now = computeTrustedRuntimeDigest();
  if (now !== boot) {
    throw new Error(
      `trusted-runtime drift since process boot: digest ${now} != boot-sealed ${boot} — trusted source or installed dependencies changed under a live supervisor; refusing (restart from unmodified trusted source)`,
    );
  }
  return boot;
}

// ─── Sealed execution snapshot ──────────────────────────────────────────────

/** Snapshot-relative path of the generated boot stage. */
const SNAPSHOT_BOOT_FILE = "boot.mjs";
/** Snapshot-relative path of the authenticated ESM resolution guard. */
const SNAPSHOT_LOADER_FILE = "sealed-resolver.mjs";

/** Snapshot roots are created with mkdtemp DIRECTLY under the OS tmpdir
 * (sticky/per-user private) — there is deliberately NO fixed shared parent
 * directory an attacker could pre-create and own. */
const SNAPSHOT_PREFIX = "hone-runtime-seal-";

/** Ownership marker sealed into every snapshot root, first thing after
 * mkdtemp: lets a later boot prove the owning process is dead before
 * sweeping a SIGKILL-stranded tree. */
const OWNER_MARKER = ".seal-owner.json";

/** Sweep at most this many stranded roots per boot — the sweep is hygiene
 * and must never dominate boot latency. */
const MAX_SWEEP_PER_BOOT = 32;

/**
 * Best-effort sweep of SIGKILL-stranded snapshot roots (`hone-runtime-seal-*`
 * siblings in the OS tmpdir): a kill never runs the bin's exit cleanup, so
 * without sweeping, repeated crashes would leak closure-sized temp trees
 * unboundedly. A root is deleted ONLY when every proof holds, each checked
 * without following links:
 *  - the entry lstats as a real directory we own with zero group/other
 *    access (a planted SYMLINK is unlinked, never followed into its target);
 *  - its sealed ownership marker is a regular file (O_NOFOLLOW read) naming
 *    an owner pid that probes dead (signal 0 → ESRCH). EPERM or any doubt
 *    means "alive" — a recycled pid at worst RETAINS a tree, never deletes
 *    a live one; the tree is reclaimed once that pid dies.
 * Deletion is a bounded recursive rm that removes symlinks as entries
 * without traversal. Every failure is swallowed: sweeping must never block
 * or fail a boot.
 * @param {string} tmpRoot @returns {void}
 */
function sweepStaleSnapshots(tmpRoot) {
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let swept = 0;
  for (const name of entries) {
    if (!name.startsWith(SNAPSHOT_PREFIX) || swept >= MAX_SWEEP_PER_BOOT) continue;
    const abs = join(tmpRoot, name);
    try {
      const st = lstatSync(abs);
      if (uid !== null && st.uid !== uid) continue; // foreign — never touch
      // A real seal is always an exact private directory. Symlinks and
      // other planted entries are inert and are never followed or deleted.
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if ((st.mode & 0o7777) !== 0o700) continue;
      const markerPath = join(abs, OWNER_MARKER);
      const markerSt = lstatSync(markerPath);
      if (markerSt.isSymbolicLink() || !markerSt.isFile()) continue;
      if (uid !== null && markerSt.uid !== uid) continue;
      if ((markerSt.mode & 0o7777) !== 0o400) continue;
      const marker = JSON.parse(readTrustedFile(markerPath).bytes.toString("utf8"));
      const pid = typeof marker === "object" && marker !== null ? /** @type {Record<string, unknown>} */ (marker)["pid"] : undefined;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0); // signal 0: existence probe, no delivery
        continue; // owner still alive — never touch a live seal
      } catch (e) {
        const code = e instanceof Error ? /** @type {NodeJS.ErrnoException} */ (e).code : undefined;
        if (code !== "ESRCH") continue; // EPERM/unknown: assume alive
      }
      rmSync(abs, { recursive: true, force: true, maxRetries: 1 });
      swept += 1;
    } catch {
      // unreadable marker, racing sweeper, permissions — the next boot retries
    }
  }
}

/**
 * ESM resolver guard registered by the tiny launcher BEFORE boot.mjs. Every
 * resolved non-builtin URL must canonicalize beneath the pinned snapshot
 * root. This closes normal ESM ancestor lookup (`/tmp/node_modules/pwn`) for
 * static and dynamic imports; the generated boot stage separately seals the
 * CommonJS `_resolveFilename` path used by createRequire/require.
 * @returns {string}
 */
function resolverStageSource() {
  return [
    'import { realpathSync } from "node:fs";',
    'import { isAbsolute, relative, sep } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "let sealedRoot;",
    "let allowedDataUrl;",
    "const inside = (candidate) => {",
    "  const rel = relative(sealedRoot, realpathSync(candidate));",
    '  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));',
    "};",
    "export function initialize(data) {",
    '  if (data === null || typeof data !== "object" || typeof data.root !== "string" || typeof data.allowedDataUrl !== "string") throw new Error("sealed resolver received no root/boot URL");',
    "  sealedRoot = realpathSync(data.root);",
    "  allowedDataUrl = data.allowedDataUrl;",
    "}",
    "export async function resolve(specifier, context, nextResolve) {",
    "  const result = await nextResolve(specifier, context);",
    "  if (result.url === allowedDataUrl) return result;",
    '  if (result.url.startsWith("node:")) return result;',
    '  if (!result.url.startsWith("file:") || !inside(fileURLToPath(result.url))) {',
    '    throw new Error(`trusted runtime import ${specifier} resolved outside the sealed snapshot (${result.url}) — refusing to execute`);',
    "  }",
    "  return result;",
    "}",
    "",
  ].join("\n");
}

/** Generated second boot stage, WRITTEN INTO the snapshot so its own bare
 * imports resolve exclusively through the snapshot's node_modules. The
 * launcher-installed ESM resolver confines static/dynamic imports; this
 * stage installs the equivalent CommonJS/createRequire guard BEFORE tsx is
 * loaded, then registers tsx with ambient tsconfig discovery disabled.
 * @param {string} entryRel snapshot-relative CLI entry (node_modules/<cli>/src/main.ts)
 * @returns {string} */
function bootStageSource(entryRel) {
  return [
    "// Generated sealed boot stage — executes ONLY captured bytes.",
    'import Module, { builtinModules, createRequire } from "node:module";',
    'import { realpathSync } from "node:fs";',
    'import { isAbsolute, join, relative, sep } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const rootValue = globalThis[Symbol.for("hone.trusted-runtime-snapshot-root")];',
    'if (typeof rootValue !== "string") throw new Error("sealed runtime root is not pinned — refusing to execute");',
    "const sealedRoot = realpathSync(rootValue);",
    'const builtins = new Set(builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name : `node:${name}`]));',
    "const inside = (candidate) => {",
    "  const rel = relative(sealedRoot, realpathSync(candidate));",
    '  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));',
    "};",
    'const requireFromSeal = createRequire(pathToFileURL(join(sealedRoot, "boot.mjs")));',
    'const tsxEntry = requireFromSeal.resolve("tsx/esm/api");',
    'if (!isAbsolute(tsxEntry) || !inside(tsxEntry)) throw new Error(`tsx resolved outside the sealed snapshot (${tsxEntry}) — refusing to execute`);',
    'const { register } = await import(pathToFileURL(tsxEntry).href);',
    "register({ tsconfig: false });",
    "// tsx installs its own CommonJS transform hook during register(). Wrap",
    "// that final resolver, rather than freezing Module._resolveFilename",
    "// before tsx has installed the captured hook.",
    "const sealedResolveFilename = Module._resolveFilename;",
    'if (typeof sealedResolveFilename !== "function") throw new Error("CommonJS resolver is unavailable — refusing to execute");',
    'Object.defineProperty(Module, "_resolveFilename", {',
    "  configurable: false,",
    "  writable: false,",
    "  value(request, parent, isMain, options) {",
    "    const resolved = sealedResolveFilename.call(this, request, parent, isMain, options);",
    '    if (typeof resolved !== "string" || builtins.has(resolved) || builtins.has(request)) return resolved;',
    "    if (!isAbsolute(resolved) || !inside(resolved)) {",
    '      throw new Error(`trusted CommonJS import ${request} resolved outside the sealed snapshot (${resolved}) — refusing to execute`);',
    "    }",
    "    return resolved;",
    "  },",
    "});",
    `await import(pathToFileURL(join(sealedRoot, ${JSON.stringify(entryRel)})).href);`,
    "",
  ].join("\n");
}

/** @param {Buffer | string} bytes @returns {string} */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** fsync a directory so freshly created entries are durable before handoff.
 * @param {string} abs @returns {void} */
function fsyncDir(abs) {
  const fd = openSync(abs, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Stage one sealed snapshot file: parents created 0o700, the file created
 * no-clobber (O_EXCL — a pre-planted path refuses), written from the exact
 * hashed buffer, fsynced on its own fd, then mode-restricted to the source
 * mode minus every write bit (fchmod on the fd, immune to umask). The
 * expected byte hash and final mode are recorded for the handoff rehash.
 * @param {string} root
 * @param {string} rel snapshot-relative destination ("/"-separated)
 * @param {Buffer} bytes
 * @param {number} mode source file mode
 * @param {Map<string, { sha256: string, mode: number }>} expected
 * @param {Set<string>} dirs
 * @returns {void}
 */
function writeSealedFile(root, rel, bytes, mode, expected, dirs) {
  if (expected.has(rel)) {
    throw new Error(`sealed runtime snapshot path collision at ${rel} — refusing to seal the execution snapshot`);
  }
  const parts = rel.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (!dirs.has(parent)) {
      mkdirSync(parent, { mode: 0o700 });
      dirs.add(parent);
    }
  }
  const restricted = (mode & 0o555) | 0o400;
  const fd = openSync(join(root, ...parts), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fchmodSync(fd, restricted);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  expected.set(rel, { sha256: sha256Hex(bytes), mode: restricted });
}

/**
 * Rehash the sealed snapshot AT THE EXECUTION HANDOFF: every file on disk
 * must be a regular non-symlink file whose bytes and mode match exactly
 * what was staged from the hashed capture, with nothing missing and nothing
 * extra. Any deviation refuses execution.
 * The snapshot ROOT's pinned identity is reverified first: it must still be
 * the very directory (device+inode) created by this process's mkdtemp, a
 * real non-symlink 0o700 directory we own — a renamed/swapped tree refuses
 * before a single byte is compared.
 * @param {{ root: string, rootId: { dev: number, ino: number, uid: number }, files: Map<string, { sha256: string, mode: number }> }} snapshot
 * @returns {void}
 */
export function assertRuntimeSnapshotIntact(snapshot) {
  const rootSt = lstatSync(snapshot.root);
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
    throw new Error(`sealed runtime snapshot root ${snapshot.root} is no longer a real directory — refusing to execute`);
  }
  if (rootSt.dev !== snapshot.rootId.dev || rootSt.ino !== snapshot.rootId.ino) {
    throw new Error(`sealed runtime snapshot root ${snapshot.root} was replaced (device/inode changed since the seal) — refusing to execute`);
  }
  if (typeof process.getuid === "function" && rootSt.uid !== process.getuid()) {
    throw new Error(`sealed runtime snapshot root ${snapshot.root} is owned by uid ${rootSt.uid}, not this process — refusing to execute`);
  }
  if ((rootSt.mode & 0o7777) !== 0o700) {
    throw new Error(`sealed runtime snapshot root ${snapshot.root} mode drifted (0${(rootSt.mode & 0o7777).toString(8)} != 0700) — refusing to execute`);
  }
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} rel @returns {void} */
  const walk = (rel) => {
    const dirAbs = rel === "" ? snapshot.root : join(snapshot.root, ...rel.split("/"));
    for (const name of readdirSync(dirAbs).sort()) {
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const abs = join(dirAbs, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        throw new Error(`sealed runtime snapshot contains a symlink at ${childRel} — refusing to execute`);
      }
      if (st.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!st.isFile()) {
        throw new Error(`sealed runtime snapshot contains a non-regular entry at ${childRel} — refusing to execute`);
      }
      const want = snapshot.files.get(childRel);
      if (want === undefined) {
        throw new Error(`sealed runtime snapshot contains an unexpected file at ${childRel} — refusing to execute`);
      }
      const { bytes, mode } = readTrustedFile(abs);
      if (mode !== want.mode) {
        throw new Error(
          `sealed runtime snapshot file ${childRel} mode drifted (0${mode.toString(8)} != 0${want.mode.toString(8)}) — refusing to execute`,
        );
      }
      if (sha256Hex(bytes) !== want.sha256) {
        throw new Error(`sealed runtime snapshot file ${childRel} bytes drifted from the sealed capture — refusing to execute`);
      }
      seen.add(childRel);
    }
  };
  walk("");
  if (seen.size !== snapshot.files.size) {
    const missing = [...snapshot.files.keys()].filter((rel) => !seen.has(rel));
    throw new Error(
      `sealed runtime snapshot is missing ${missing.length} sealed file(s) (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}) — refusing to execute`,
    );
  }
}

/**
 * Capture-and-seal the executable trusted runtime: ONE pass reads every
 * closure file exactly once, feeding the boot digest and staging the same
 * buffers into a fresh no-clobber snapshot directory (0o700, unique path
 * under the private tmpdir) with workspace packages and installed
 * dependencies hoisted beneath a single node_modules. Every file is
 * created O_EXCL, fsynced, and stripped of write bits; directories are
 * fsynced after staging. The generated boot stage (boot.mjs) is sealed the
 * same way. The digest of the captured bytes is then sealed as (or verified
 * against) the process boot digest, and the entire snapshot is rehashed
 * immediately before the URL is handed to the loader — so the digest this
 * process pins identifies the immutable exact bytes it executes. A repo
 * edit after the capture is inert: the sealed prior bytes run, and the
 * live-repo drift gate (verifiedBootRuntimeDigest) still refuses to pin or
 * resume over drifted source. On ANY failure the partial snapshot is
 * removed and the error propagates — never a half-sealed handoff.
 * @param {{ helperPath: string, helperBytes: Buffer, helperMode: number } | undefined} [launcherCapture]
 * @returns {{ digest: string, root: string, rootId: { dev: number, ino: number, uid: number }, bootUrl: string, loaderUrl: string, files: Map<string, { sha256: string, mode: number }> }}
 */
export function sealRuntimeSnapshot(launcherCapture = undefined) {
  const cliName = readManifest(join(trustedCliRoot(), "package.json")).name;
  if (cliName === undefined) {
    throw new Error("the trusted CLI package has no name — refusing to seal the execution snapshot");
  }
  const helperPath = join(trustedCliRoot(), "src", "runtime-digest.js");
  /** @type {Map<string, { bytes: Buffer, mode: number }> | null} */
  let captured = null;
  if (launcherCapture !== undefined) {
    if (
      resolve(launcherCapture.helperPath) !== resolve(helperPath) ||
      !Buffer.isBuffer(launcherCapture.helperBytes) ||
      !Number.isInteger(launcherCapture.helperMode) ||
      launcherCapture.helperMode < 0
    ) {
      throw new Error("launcher-supplied runtime sealer capture is malformed or names the wrong file — refusing to seal");
    }
    captured = new Map([[helperPath, { bytes: launcherCapture.helperBytes, mode: launcherCapture.helperMode }]]);
  }

  // Each root is created DIRECTLY under the OS sticky/per-user-private
  // tmpdir. There is no predictable parent an attacker can pre-create,
  // rename, or use to swap the sealed tree.
  const tmpRoot = realpathSync(tmpdir());
  sweepStaleSnapshots(tmpRoot);
  const root = mkdtempSync(join(tmpRoot, SNAPSHOT_PREFIX));
  /** @type {Map<string, { sha256: string, mode: number }>} */
  const files = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  try {
    chmodSync(root, 0o700);
    const rootLstat = lstatSync(root);
    const directoryFlags =
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
    const rootFd = openSync(root, directoryFlags);
    let rootFstat;
    try {
      rootFstat = fstatSync(rootFd);
    } finally {
      closeSync(rootFd);
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : rootLstat.uid;
    if (
      rootLstat.isSymbolicLink() ||
      !rootLstat.isDirectory() ||
      !rootFstat.isDirectory() ||
      rootLstat.dev !== rootFstat.dev ||
      rootLstat.ino !== rootFstat.ino ||
      rootLstat.uid !== uid ||
      rootFstat.uid !== uid ||
      (rootLstat.mode & 0o7777) !== 0o700 ||
      (rootFstat.mode & 0o7777) !== 0o700
    ) {
      throw new Error(`fresh sealed runtime root ${root} failed its no-follow ownership/identity check`);
    }
    const rootId = { dev: rootFstat.dev, ino: rootFstat.ino, uid: rootFstat.uid };
    writeSealedFile(
      root,
      OWNER_MARKER,
      Buffer.from(`${JSON.stringify({ version: 1, pid: process.pid })}\n`, "utf8"),
      0o400,
      files,
      dirs,
    );
    const digest = computeTrustedRuntimeDigest(
      (rel, bytes, mode) => writeSealedFile(root, rel, bytes, mode, files, dirs),
      captured,
    );
    const entryRel = `node_modules/${cliName}/src/main.ts`;
    if (!files.has(entryRel)) {
      throw new Error(`sealed runtime snapshot is missing the CLI entry ${entryRel} — refusing to seal the execution snapshot`);
    }
    if (!files.has("node_modules/tsx/package.json")) {
      throw new Error("sealed runtime snapshot is missing the tsx loader package — refusing to seal the execution snapshot");
    }
    writeSealedFile(root, SNAPSHOT_LOADER_FILE, Buffer.from(resolverStageSource(), "utf8"), 0o400, files, dirs);
    writeSealedFile(root, SNAPSHOT_BOOT_FILE, Buffer.from(bootStageSource(entryRel), "utf8"), 0o400, files, dirs);
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) fsyncDir(dir);
    fsyncDir(root);
    fsyncDir(tmpRoot);
    // Seal (or verify against) the process boot digest: the sealed value IS
    // the digest of the exact bytes staged above — one read produced both.
    const holder = /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis));
    const existing = holder[BOOT_KEY];
    if (typeof existing === "string") {
      if (existing !== digest) {
        throw new Error(
          `trusted-runtime drift since process boot: digest ${digest} != boot-sealed ${existing} — trusted source or installed dependencies changed under a live supervisor; refusing (restart from unmodified trusted source)`,
        );
      }
    } else {
      Object.defineProperty(globalThis, BOOT_KEY, {
        value: digest,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    }
    const snapshot = {
      digest,
      root,
      rootId,
      bootUrl: pathToFileURL(join(root, SNAPSHOT_BOOT_FILE)).href,
      loaderUrl: pathToFileURL(join(root, SNAPSHOT_LOADER_FILE)).href,
      files,
    };
    // Rehash at the execution handoff: what the loader is about to import
    // is byte-for-byte what was hashed, or nothing runs.
    assertRuntimeSnapshotIntact(snapshot);
    return snapshot;
  } catch (e) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of a refused partial snapshot; the refusal itself propagates.
    }
    throw e;
  }
}
