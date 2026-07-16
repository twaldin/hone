import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalJson } from "@hone/schema";
import { UsageError } from "./args.js";
import { trustedRepoRoot } from "./runtime-digest.js";

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
 *   optimizer/worker                 — the mutation-session worker source
 *                                      (built into a self-contained bundle
 *                                      the loop ships into every sandbox)
 *   schema/src, schema/package.json  — trusted @hone/schema SOURCE (not just
 *                                      the lock: the workspace link resolves
 *                                      to this tree)
 *   pnpm-lock.yaml                   — workspace-wide dependency resolution
 *   the resolved zod package         — the loop's only external runtime dep
 *   the Pi SDK pnpm closure          — the worker's dependency graph
 *                                      (@oh-my-pi/pi-coding-agent and every
 *                                      transitively linked store package),
 *                                      filtered to build-readable files; the
 *                                      symlink topology is sealed as the
 *                                      generated pi/links.json manifest
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
 *
 * ONE no-network build container emits BOTH bundles: the loop
 * (optimizer.mjs, run under node) and the self-contained mutation worker
 * (worker.mjs, run under bun inside each sandbox after the loop putFiles the
 * exact built bytes there). `--external omp-legacy-pi-modules` keeps the Pi
 * SDK's optional legacy-plugin dynamic import a runtime import — the module
 * is not part of the sealed closure and is never loaded by the worker.
 */
export const OPTIMIZER_BUILD_CONTRACT = {
  version: 2,
  layout: {
    optimizer: "optimizer",
    schema: "optimizer/node_modules/@hone/schema",
    zod: "optimizer/node_modules/zod",
    pi: "pi-store",
    "pnpm-lock.yaml": "pnpm-lock.yaml",
  },
  build: [
    "/bin/sh",
    "-c",
    "bun build /hone/src/optimizer/src/main.ts --target=node --outfile=/hone/out/optimizer.mjs && " +
      "bun build /hone/src/optimizer/worker/mutate.ts --target=bun --external omp-legacy-pi-modules --outfile=/hone/out/worker.mjs",
  ],
  run: ["node", "/hone/bundle/optimizer.mjs"],
} as const;

/** Bundle filenames the build emits into /hone/out (mounted at /hone/bundle for the run). */
export const OPTIMIZER_BUNDLE_FILES = ["optimizer.mjs", "worker.mjs"] as const;

/** The hone repo root of the LIVE repository. Pinned at boot (bin/hone.js)
 * so the value stays correct even though the trusted runtime executes from
 * an immutable sealed snapshot outside the repo tree; in-repo processes
 * (tests) derive the same root from the module location. */
export function repoRootFromHere(): string {
  return trustedRepoRoot();
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

/** The optimizer package's installed zod directory. Resolve the workspace
 * link as a filesystem identity only: using createRequire here would invoke
 * CommonJS module resolution from the trusted supervisor and could climb
 * outside the sealed runtime root. The resolved bytes are collected below
 * into the separately sealed optimizer snapshot before execution. */
function resolveZodDir(optimizerDir: string): string {
  const requested = join(optimizerDir, "node_modules", "zod");
  try {
    const resolved = realpathSync(requested);
    const manifest: unknown = JSON.parse(readFileSync(join(resolved, "package.json"), "utf8"));
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("name" in manifest) ||
      manifest.name !== "zod"
    ) {
      throw new Error("resolved package manifest is not zod");
    }
    return resolved;
  } catch (e) {
    throw new UsageError(`cannot resolve the optimizer's zod dependency at ${requested}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The worker's Pi SDK root package — its pnpm store closure is sealed for the worker build. */
export const PI_WORKER_PACKAGE = "@oh-my-pi/pi-coding-agent";
/** Collection prefix of the sealed Pi closure; `pi/links.json` is the generated topology manifest. */
const PI_PREFIX = "pi";
export const PI_LINKS_REL = `${PI_PREFIX}/links.json`;

/**
 * Capture filter for Pi store package files: everything EXCEPT formats a
 * `bun build` module graph can never read (platform binaries, sourcemaps,
 * type declarations, archives, media). A denylist — not an allowlist —
 * because the Pi SDK text-imports arbitrary extensions (`.md`, `.lark`,
 * `.rb`, ... via `with { type: "text" }`); anything unexpectedly missing
 * fails the sealed build closed at launch, never silently.
 */
const PI_DENY_SUFFIXES = [
  ".node", ".wasm", ".map", ".d.ts", ".d.mts", ".d.cts",
  ".so", ".dylib", ".dll", ".a", ".lib", ".exe",
  ".onnx", ".ort", ".tar", ".tgz", ".gz", ".zip", ".br", ".zst", ".7z",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".svg",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".mp3", ".mp4", ".wav", ".pdf",
] as const;
const PI_DENY_VERSIONED_SO = /\.so\.[0-9.]+$/;

/** One pnpm-store link edge endpoint: store entry id + package name inside it. */
interface PiLinkTarget {
  id: string;
  name: string;
}

/** The sealed symlink topology of the Pi closure — serialized as pi/links.json. */
interface PiClosureMeta {
  version: 1;
  root: PiLinkTarget;
  /** Store entry id -> dependency-name -> link target. */
  entries: Record<string, Record<string, PiLinkTarget>>;
}

/** A single path segment that can never escape its directory. */
function safeSegment(segment: string, what: string): string {
  if (segment.length === 0 || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    throw new UsageError(`optimizer snapshot refuses unsafe ${what}: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/** A package name: one segment, or `@scope/name`. */
function safePackageName(name: string): string {
  const parts = name.split("/");
  if (parts.length === 2 && parts[0]?.startsWith("@") === true) {
    safeSegment(parts[0], "package scope");
    safeSegment(parts[1] ?? "", "package name");
    return name;
  }
  if (parts.length === 1) return safeSegment(name, "package name");
  throw new UsageError(`optimizer snapshot refuses unsafe package name: ${JSON.stringify(name)}`);
}

/**
 * Locate the pnpm virtual store from the resolved physical directory of a
 * store-linked package: `<store>/<id>/node_modules/<name>`.
 */
function splitStorePath(physicalDir: string): { storeDir: string; id: string; name: string } {
  const marker = "/node_modules/.pnpm/";
  const at = physicalDir.lastIndexOf(marker);
  if (at < 0) {
    throw new UsageError(
      `optimizer snapshot requires the pnpm store layout for ${PI_WORKER_PACKAGE}; resolved ${physicalDir} is not inside node_modules/.pnpm — run pnpm install`,
    );
  }
  const storeDir = physicalDir.slice(0, at + marker.length - 1);
  const parts = physicalDir.slice(storeDir.length + 1).split("/");
  const [id, nm, ...nameParts] = parts;
  if (id === undefined || nm !== "node_modules" || nameParts.length === 0) {
    throw new UsageError(`optimizer snapshot cannot parse the pnpm store path ${physicalDir}`);
  }
  return { storeDir, id: safeSegment(id, "store entry id"), name: safePackageName(nameParts.join("/")) };
}


/**
 * Capture the Pi SDK's pnpm store closure: every store entry reachable from
 * the worker's root package through pnpm's link topology. Physical files are
 * captured (filtered by piCaptured) under `pi/<storeId>/<pkgName>/...`; the
 * link edges become the generated, digested `pi/links.json` manifest that
 * staging replays as relative symlinks. Unlike the lstat-only trees above,
 * symlinks here are the pnpm store's own dependency edges — they are sealed
 * as data, never followed blindly outside the store.
 */
function collectPiClosure(optimizerDir: string, into: Map<string, SnapshotFile>): void {
  const rootLinkDir = join(optimizerDir, "node_modules", PI_WORKER_PACKAGE);
  if (!existsSync(rootLinkDir)) {
    throw new UsageError(`worker dependency ${PI_WORKER_PACKAGE} not found under ${join(optimizerDir, "node_modules")} — run pnpm install`);
  }
  const { storeDir, id: rootId, name: rootName } = splitStorePath(realpathSync(rootLinkDir));
  if (rootName !== PI_WORKER_PACKAGE) {
    throw new UsageError(`worker dependency ${PI_WORKER_PACKAGE} resolves to a different store package ${rootName}`);
  }

  const entries: Record<string, Record<string, PiLinkTarget>> = {};
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined || entries[id] !== undefined) continue;
    const deps: Record<string, PiLinkTarget> = {};
    entries[id] = deps;
    const nmDir = join(storeDir, id, "node_modules");
    const walkEntry = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (prefix === "" && entry.name === ".bin") continue;
        const abs = join(dir, entry.name);
        const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) {
          // A pnpm dependency edge: <store>/<id>/node_modules/<name> -> <store>/<targetId>/node_modules/<targetName>
          const target = resolve(dir, readlinkSync(abs));
          const split = splitStorePath(target);
          if (split.storeDir !== storeDir) {
            throw new UsageError(`optimizer snapshot refuses a Pi store link escaping the store: ${abs} -> ${target}`);
          }
          deps[safePackageName(name)] = { id: split.id, name: split.name };
          queue.push(split.id);
        } else if (st.isDirectory()) {
          if (prefix === "" && entry.name.startsWith("@")) walkEntry(abs, entry.name);
          else capturePiPackage(abs, `${PI_PREFIX}/${id}/${safePackageName(name)}`, into);
        }
        // Plain files at the store-entry root (none in practice) carry no resolution meaning; ignored.
      }
    };
    walkEntry(nmDir, "");
  }

  const meta: PiClosureMeta = { version: 1, root: { id: rootId, name: rootName }, entries };
  into.set(PI_LINKS_REL, { bytes: Buffer.from(canonicalJson(meta), "utf8"), mode: 0o644 });
}

/** Filtered physical-package capture: regular files only; a symlink INSIDE a package refuses. */
function capturePiPackage(absDir: string, relDir: string, into: Map<string, SnapshotFile>): void {
  for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    const st = lstatGuard(abs, rel);
    if (st.isDirectory()) {
      capturePiPackage(abs, rel, into);
    } else {
      const lower = entry.name.toLowerCase();
      if (PI_DENY_SUFFIXES.some((s) => lower.endsWith(s)) || PI_DENY_VERSIONED_SO.test(lower)) continue;
      into.set(rel, { bytes: readFileSync(abs), mode: st.mode & 0o777 });
    }
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
  for (const entry of ["src/main.ts", "worker/mutate.ts"]) {
    if (!existsSync(join(optimizerDir, entry))) {
      throw new UsageError(`optimizer entry missing: ${join(optimizerDir, entry)}`);
    }
  }
  collectTree(join(optimizerDir, "src"), "optimizer/src", files, OPTIMIZER_SKIP);
  collectTree(join(optimizerDir, "worker"), "optimizer/worker", files, OPTIMIZER_SKIP);
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
  collectPiClosure(optimizerDir, files);
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
  if (rel.startsWith(`${PI_PREFIX}/`)) {
    // pi/<storeId>/<pkgPath...> -> pi-store/<storeId>/node_modules/<pkgPath...>
    const rest = rel.slice(PI_PREFIX.length + 1);
    const slash = rest.indexOf("/");
    if (slash > 0) return `${OPTIMIZER_BUILD_CONTRACT.layout.pi}/${rest.slice(0, slash)}/node_modules/${rest.slice(slash + 1)}`;
  }
  if (rel === "pnpm-lock.yaml") return rel;
  throw new UsageError(`optimizer snapshot entry outside the allowlisted layout: ${rel}`);
}

/** Parse and validate the sealed pi/links.json manifest out of a snapshot. */
function piClosureMeta(snapshot: OptimizerSnapshot): PiClosureMeta {
  const raw = snapshot.files.get(PI_LINKS_REL);
  if (raw === undefined) throw new UsageError(`optimizer snapshot is missing ${PI_LINKS_REL}`);
  const malformed = (): UsageError => new UsageError(`optimizer snapshot has a malformed ${PI_LINKS_REL}`);
  const parseTarget = (value: unknown): PiLinkTarget => {
    if (value === null || typeof value !== "object") throw malformed();
    const { id, name } = value as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || typeof name !== "string") throw malformed();
    return { id: safeSegment(id, "store entry id"), name: safePackageName(name) };
  };
  const parsed: unknown = JSON.parse(raw.bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object") throw malformed();
  const { version, root, entries } = parsed as { version?: unknown; root?: unknown; entries?: unknown };
  if (version !== 1 || entries === null || typeof entries !== "object") throw malformed();
  const meta: PiClosureMeta = { version: 1, root: parseTarget(root), entries: {} };
  for (const [id, deps] of Object.entries(entries)) {
    safeSegment(id, "store entry id");
    if (deps === null || typeof deps !== "object") throw malformed();
    const parsedDeps: Record<string, PiLinkTarget> = {};
    for (const [depName, target] of Object.entries(deps as Record<string, unknown>)) {
      parsedDeps[safePackageName(depName)] = parseTarget(target);
    }
    meta.entries[id] = parsedDeps;
  }
  return meta;
}

/**
 * Materialize the CAPTURED bytes as the build container's source tree. The
 * workspace @hone/schema link and the zod dependency become plain physical
 * node_modules directories, so module resolution inside the container cannot
 * escape the sealed graph. Files are written with the captured mode plus
 * world-read (the build runs as an unprivileged uid).
 *
 * The Pi closure keeps pnpm's shape: physical packages under
 * pi-store/<id>/node_modules/<name>, dependency edges as RELATIVE symlinks
 * replayed from the sealed pi/links.json — every link lands inside the
 * staging tree (validated segments, store-relative targets), so resolution
 * inside the read-only /hone/src mount cannot escape the sealed graph.
 */
export function writeOptimizerStaging(snapshot: OptimizerSnapshot, stagingDir: string): void {
  for (const [rel, f] of snapshot.files) {
    if (rel === PI_LINKS_REL) continue; // topology manifest, not a staged source file
    const abs = join(stagingDir, stagedRel(rel));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.bytes, { mode: f.mode | 0o444 });
  }
  const meta = piClosureMeta(snapshot);
  const piRoot = join(stagingDir, OPTIMIZER_BUILD_CONTRACT.layout.pi);
  for (const [id, deps] of Object.entries(meta.entries)) {
    for (const [depName, target] of Object.entries(deps)) {
      const linkPath = join(piRoot, id, "node_modules", depName);
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(relative(dirname(linkPath), join(piRoot, target.id, "node_modules", target.name)), linkPath);
    }
  }
  const rootLink = join(stagingDir, OPTIMIZER_BUILD_CONTRACT.layout.optimizer, "node_modules", meta.root.name);
  mkdirSync(dirname(rootLink), { recursive: true });
  symlinkSync(relative(dirname(rootLink), join(piRoot, meta.root.id, "node_modules", meta.root.name)), rootLink);
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
