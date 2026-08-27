import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  campaignRuntimeClosureRecordDigest,
  metaCampaignConfigHash,
} from "@hone/meta";
import type { Sha256Digest } from "@hone/meta";
import {
  MetaCampaignConfigV2,
  canonicalJson,
} from "@hone/schema";
import type {
  CampaignRuntimeClosureCaptureV1,
  MetaCampaignConfigV2 as RecursiveMetaCampaignConfig,
} from "@hone/schema";
import { z } from "zod";
import { UsageError } from "./args.js";
import { casPath, readCas, writeCas } from "./cas.js";
import { writeFileDurable } from "./eventlog.js";
import { collectOptimizerSnapshot, snapshotDigest } from "./optimizer-digest.js";
import { computeTrustedRuntimeDigestAt } from "./runtime-digest.js";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CHUNK_SIZE = 1024 * 1024;
const MAX_CLOSURE_ENTRIES = 200_000;
const MAX_CLOSURE_BYTES = 8 * 1024 * 1024 * 1024;
const PACKAGE_MAP_FILE = "node_modules/.package-map.json";
const SKIPPED_WORKSPACE_NODE_MODULES: Readonly<Record<string, true>> = {
  ".bin": true,
  ".cache": true,
  ".vite": true,
};

const Digest = z.string().regex(DIGEST_PATTERN);
const Chunk = z.object({ hash: Digest, size: z.number().int().positive().max(CHUNK_SIZE) }).strict();
const FileEntry = z.object({
  kind: z.literal("file"),
  path: z.string().min(1),
  mode: z.number().int().min(0).max(0o777),
  size: z.number().int().nonnegative(),
  sha256: Digest,
  chunks: z.array(Chunk),
}).strict();
const SymlinkEntry = z.object({
  kind: z.literal("symlink"),
  path: z.string().min(1),
  target: z.string().min(1),
}).strict();
const RuntimeClosureTreeV1 = z.object({
  version: z.literal(1),
  chunkSize: z.literal(CHUNK_SIZE),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  entries: z.array(z.discriminatedUnion("kind", [FileEntry, SymlinkEntry])),
}).strict();
type RuntimeClosureTreeV1 = z.infer<typeof RuntimeClosureTreeV1>;
type RuntimeClosureEntry = RuntimeClosureTreeV1["entries"][number];

const RuntimeClosureManifestV1 = z.object({
  version: z.literal(1),
  campaignConfigHash: Digest,
  closureDigest: Digest,
  sourceCommit: z.string().regex(GIT_COMMIT_PATTERN),
  bootDigest: Digest,
  campaignBootDigest: Digest,
  optimizerImage: z.string().min(1).max(4_096),
  optimizerBaseDigest: Digest,
  capturedAt: z.string().datetime({ offset: true }),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
}).strict();
type RuntimeClosureManifestV1 = z.infer<typeof RuntimeClosureManifestV1>;

interface GitTreeEntry {
  readonly mode: "100644" | "100755" | "120000";
  readonly oid: string;
  readonly path: string;
}

interface PackageMapEntry {
  readonly url: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

interface PackageMap {
  readonly packages: Readonly<Record<string, PackageMapEntry>>;
}

export interface CaptureRuntimeClosureRequest {
  readonly sourceRoot: string;
  readonly sourceCommit: string;
  readonly campaignBootDigest: Sha256Digest;
  /** Freeze supplies this gate; historical base backfill records the computed closure boot digest. */
  readonly expectedBootDigest?: Sha256Digest;
  readonly optimizerImage: string;
  readonly optimizerBaseDigest: Sha256Digest;
  readonly campaignConfigHash: Sha256Digest;
  readonly capturedAt: string;
  readonly casDir: string;
  readonly previousRecordDigest: Sha256Digest | null;
  readonly nodeModulesArchive?: string;
  readonly nodeModulesArchiveSha256?: Sha256Digest;
  /** Test-only mutation seam after the first disk read and before CAS capture. */
  readonly beforeFileCapture?: () => void;
}

export interface CaptureRuntimeClosureResult {
  readonly record: CampaignRuntimeClosureCaptureV1;
  readonly marginalBytes: number;
  readonly reusedBytes: number;
}

export interface RestoreRuntimeClosureRequest {
  readonly casDir: string;
  readonly targetDir: string;
  readonly campaignConfigHash: Sha256Digest;
  readonly record: CampaignRuntimeClosureCaptureV1;
}

export interface RestoreRuntimeClosureResult {
  readonly targetDir: string;
  readonly closureDigest: Sha256Digest;
  readonly optimizerBaseDigest: Sha256Digest;
  readonly bootDigest: Sha256Digest;
  readonly fileCount: number;
  readonly totalBytes: number;
}

function sha256(bytes: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeRelativePath(input: string): string {
  const parts = input.split("/");
  if (
    input.length === 0
    || input.startsWith("/")
    || input.includes("\\")
    || input.includes("\0")
    || parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")
  ) {
    throw new UsageError(`runtime closure contains unsafe path ${JSON.stringify(input)}`);
  }
  return input;
}

function closurePath(root: string, rel: string): string {
  const safe = safeRelativePath(rel);
  const target = resolve(root, ...safe.split("/"));
  const resolvedRoot = resolve(root);
  if (!target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new UsageError(`runtime closure path escapes its root: ${JSON.stringify(rel)}`);
  }
  return target;
}

function assertContainedSymlink(root: string, rel: string, target: string): void {
  if (target.includes("\0") || target.startsWith("/")) {
    throw new UsageError(`runtime closure refuses absolute or NUL symlink ${rel} -> ${JSON.stringify(target)}`);
  }
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(dirname(closurePath(root, rel)), target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new UsageError(`runtime closure refuses escaping symlink ${rel} -> ${JSON.stringify(target)}`);
  }
}

function gitOutput(root: string, args: readonly string[], maxBuffer = 128 * 1024 * 1024): Buffer {
  try {
    return execFileSync("git", ["-C", root, "--no-pager", ...args], {
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (error) {
    throw new UsageError(`runtime closure git preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCleanSourceTree(root: string): void {
  const status = gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"]).toString("utf8").trim();
  if (status.length > 0) throw new UsageError("runtime closure capture requires a clean source worktree");
}

function sourceHead(root: string): string {
  return gitOutput(root, ["rev-parse", "--verify", "HEAD^{commit}"], 1024).toString("utf8").trim();
}

function parseGitTree(root: string, commit: string): GitTreeEntry[] {
  if (!GIT_COMMIT_PATTERN.test(commit)) throw new UsageError("runtime closure source commit must be a full lowercase git commit id");
  const resolved = gitOutput(root, ["rev-parse", "--verify", `${commit}^{commit}`], 1024).toString("utf8").trim();
  if (resolved !== commit) throw new UsageError(`runtime closure source commit ${commit} did not resolve exactly`);
  const listing = gitOutput(root, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const records = listing.toString("utf8").split("\0");
  if (records.at(-1) !== "") throw new UsageError("git ls-tree returned a non-NUL-terminated runtime closure");
  records.pop();
  if (records.length > MAX_CLOSURE_ENTRIES) {
    throw new UsageError(`runtime closure source tree exceeds ${MAX_CLOSURE_ENTRIES} entries`);
  }
  const seen = new Set<string>();
  return records.map((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new UsageError("git ls-tree returned a malformed runtime closure entry");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if ((mode !== "100644" && mode !== "100755" && mode !== "120000") || type !== "blob" || oid === undefined) {
      throw new UsageError(`runtime closure refuses unsupported git entry ${JSON.stringify(record.slice(0, tab))}`);
    }
    const path = safeRelativePath(record.slice(tab + 1));
    const collisionKey = path.normalize("NFC").toLowerCase();
    if (seen.has(collisionKey)) throw new UsageError(`runtime closure source has a case/Unicode path collision at ${path}`);
    seen.add(collisionKey);
    return { mode, oid, path };
  });
}

function gitBlobDigest(bytes: Buffer, oid: string): string {
  const algorithm = oid.length === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function readVerifiedSourceEntry(
  root: string,
  entry: GitTreeEntry,
): { kind: "file"; abs: string; gitOid: string; diskSha256: Sha256Digest; mode: number } | { kind: "symlink"; target: string } {
  const abs = closurePath(root, entry.path);
  const stat = lstatSync(abs);
  if (entry.mode === "120000") {
    if (!stat.isSymbolicLink()) throw new UsageError(`tracked symlink changed during closure capture: ${entry.path}`);
    const target = readlinkSync(abs);
    const bytes = Buffer.from(target, "utf8");
    if (gitBlobDigest(bytes, entry.oid) !== entry.oid) throw new UsageError(`tracked symlink bytes drifted during closure capture: ${entry.path}`);
    assertContainedSymlink(root, entry.path, target);
    return { kind: "symlink", target };
  }
  if (!stat.isFile() || stat.nlink < 1) throw new UsageError(`tracked source is not a regular file: ${entry.path}`);
  const executable = (stat.mode & 0o111) === 0 ? "100644" : "100755";
  if (executable !== entry.mode) throw new UsageError(`tracked source mode drifted during closure capture: ${entry.path}`);
  const bytes = readFileSync(abs);
  return {
    kind: "file",
    abs,
    gitOid: entry.oid,
    diskSha256: sha256(bytes),
    mode: stat.mode & 0o777,
  };
}

async function sha256File(path: string): Promise<Sha256Digest> {
  const digest = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) digest.update(chunk as Buffer);
  return `sha256:${digest.digest("hex")}`;
}

function validateArchiveListing(archivePath: string): void {
  let listing: string;
  try {
    listing = execFileSync("tar", ["--zstd", "-tf", archivePath], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new UsageError(`could not inspect node_modules evidence archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const names = listing.split("\n").filter((name) => name.length > 0);
  if (names.length === 0) throw new UsageError("node_modules evidence archive is empty");
  for (const raw of names) {
    const name = raw.replace(/\/$/, "");
    if (name === "node_modules") continue;
    if (!name.startsWith("node_modules/")) {
      throw new UsageError(`node_modules evidence archive contains an entry outside node_modules: ${raw}`);
    }
    safeRelativePath(name);
  }
}

function extractNodeModulesArchive(archivePath: string, expectedDigest: Sha256Digest, destination: string): Promise<void> {
  return sha256File(archivePath).then((actual) => {
    if (actual !== expectedDigest) {
      throw new UsageError(`node_modules evidence archive digest mismatch: ${actual} != ${expectedDigest}`);
    }
    validateArchiveListing(archivePath);
    try {
      execFileSync("tar", [
        "--zstd",
        "-xf",
        archivePath,
        "-C",
        destination,
        "--no-same-owner",
      ], { timeout: 300_000, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      throw new UsageError(`could not extract node_modules evidence archive: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function materializeGitCommit(root: string, entries: readonly GitTreeEntry[], destination: string): void {
  for (let offset = 0; offset < entries.length; offset += 512) {
    const batch = entries.slice(offset, offset + 512);
    let output: Buffer;
    try {
      output = execFileSync("git", ["-C", root, "--no-pager", "cat-file", "--batch"], {
        input: `${batch.map((entry) => entry.oid).join("\n")}\n`,
        maxBuffer: 512 * 1024 * 1024,
        timeout: 300_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new UsageError(`could not read frozen source blobs: ${error instanceof Error ? error.message : String(error)}`);
    }
    let cursor = 0;
    for (const entry of batch) {
      const newline = output.indexOf(0x0a, cursor);
      if (newline < 0) throw new UsageError("git cat-file returned a truncated source header");
      const [oid, type, sizeText] = output.subarray(cursor, newline).toString("ascii").split(" ");
      const size = Number(sizeText);
      if (oid !== entry.oid || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
        throw new UsageError(`git cat-file returned an invalid source blob header for ${entry.path}`);
      }
      const start = newline + 1;
      const end = start + size;
      if (end >= output.length || output[end] !== 0x0a) {
        throw new UsageError(`git cat-file returned truncated source bytes for ${entry.path}`);
      }
      const bytes = output.subarray(start, end);
      if (gitBlobDigest(bytes, entry.oid) !== entry.oid) {
        throw new UsageError(`git source blob hash mismatch for ${entry.path}`);
      }
      const target = closurePath(destination, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      if (entry.mode === "120000") {
        const linkTarget = bytes.toString("utf8");
        if (!Buffer.from(linkTarget, "utf8").equals(bytes)) {
          throw new UsageError(`git source symlink target is not UTF-8: ${entry.path}`);
        }
        assertContainedSymlink(destination, entry.path, linkTarget);
        symlinkSync(linkTarget, target);
      } else {
        const mode = entry.mode === "100755" ? 0o755 : 0o644;
        writeFileSync(target, bytes, { flag: "wx", mode });
        chmodSync(target, mode);
      }
      cursor = end + 1;
    }
    if (cursor !== output.length) throw new UsageError("git cat-file returned unexpected trailing source bytes");
  }
}

function removePrivateTree(root: string): void {
  if (!existsSync(root)) return;
  const makeWritable = (dir: string): void => {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(dir, (stat.mode & 0o777) | 0o700);
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      const childStat = lstatSync(child);
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) makeWritable(child);
    }
  };
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
}

function readPackageMap(root: string): PackageMap {
  const path = join(root, PACKAGE_MAP_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`runtime closure requires ${PACKAGE_MAP_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new UsageError(`${PACKAGE_MAP_FILE} must contain an object`);
  const packagesRaw = (raw as Record<string, unknown>)["packages"];
  if (packagesRaw === null || typeof packagesRaw !== "object" || Array.isArray(packagesRaw)) {
    throw new UsageError(`${PACKAGE_MAP_FILE} has no package map`);
  }
  const packages: Record<string, PackageMapEntry> = {};
  for (const [key, value] of Object.entries(packagesRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UsageError(`${PACKAGE_MAP_FILE} package ${key} is malformed`);
    const row = value as Record<string, unknown>;
    const dependenciesRaw = row["dependencies"];
    if (typeof row["url"] !== "string" || dependenciesRaw === null || typeof dependenciesRaw !== "object" || Array.isArray(dependenciesRaw)) {
      throw new UsageError(`${PACKAGE_MAP_FILE} package ${key} is malformed`);
    }
    const dependencies: Record<string, string> = {};
    for (const [name, dependency] of Object.entries(dependenciesRaw as Record<string, unknown>)) {
      if (typeof dependency !== "string") throw new UsageError(`${PACKAGE_MAP_FILE} dependency ${name} is malformed`);
      dependencies[name] = dependency;
    }
    packages[key] = { url: row["url"], dependencies };
  }
  return { packages };
}

function packageMapTarget(root: string, url: string): string {
  const nodeModules = resolve(root, "node_modules");
  const target = resolve(nodeModules, url);
  const resolvedRoot = resolve(root);

  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new UsageError(`${PACKAGE_MAP_FILE} target escapes the runtime closure: ${url}`);
  }
  return target;
}

function dependencyLinkPath(workspace: string, name: string): string {
  const parts = name.split("/");
  if (
    (parts.length !== 1 && !(parts.length === 2 && parts[0]?.startsWith("@")))
    || parts.some((part) => part === undefined || part === "" || part === "." || part === ".." || part.includes("\\"))
  ) throw new UsageError(`${PACKAGE_MAP_FILE} contains unsafe dependency name ${JSON.stringify(name)}`);
  return join(workspace, "node_modules", ...parts);
}

function materializeWorkspaceDependencyLinks(root: string, packageMap: PackageMap): void {
  const nodeModules = resolve(root, "node_modules");
  for (const row of Object.values(packageMap.packages)) {
    const workspace = packageMapTarget(root, row.url);
    if (workspace.startsWith(`${nodeModules}${sep}`)) continue;
    for (const [name, dependencyKey] of Object.entries(row.dependencies)) {
      const dependency = packageMap.packages[dependencyKey];
      if (dependency === undefined) throw new UsageError(`${PACKAGE_MAP_FILE} has no target ${dependencyKey} for ${name}`);
      const target = packageMapTarget(root, dependency.url);
      if (target === workspace) continue;
      const link = dependencyLinkPath(workspace, name);
      mkdirSync(dirname(link), { recursive: true, mode: 0o755 });
      const relativeTarget = relative(dirname(link), target);
      if (existsSync(link)) {
        const stat = lstatSync(link);
        if (!stat.isSymbolicLink() || resolve(dirname(link), readlinkSync(link)) !== target) {
          throw new UsageError(`installed dependency link disagrees with ${PACKAGE_MAP_FILE}: ${link}`);
        }
        continue;
      }
      symlinkSync(relativeTarget, link, "dir");
    }
  }
}

function workspaceDirectories(root: string, packageMap: PackageMap): string[] {
  const nodeModules = resolve(root, "node_modules");
  const workspaces = new Set<string>();
  for (const row of Object.values(packageMap.packages)) {
    const target = packageMapTarget(root, row.url);
    if (target !== resolve(root) && !target.startsWith(`${nodeModules}${sep}`)) workspaces.add(target);
  }
  return [...workspaces].sort();
}

interface CollectedNode {
  readonly path: string;
  readonly kind: "file" | "symlink";
  readonly abs?: string;
  readonly gitOid?: string;
  readonly diskSha256?: Sha256Digest;
  readonly mode?: number;
  readonly target?: string;
}

function collectNodeModulesTree(root: string, startRel: string, into: Map<string, CollectedNode>): void {
  const start = closurePath(root, startRel);
  if (!existsSync(start)) throw new UsageError(`runtime closure dependency tree is missing ${startRel}`);
  const walk = (rel: string): void => {
    const dir = closurePath(root, rel);
    for (const name of readdirSync(dir).sort()) {
      const childRel = `${rel}/${name}`;
      const abs = closurePath(root, childRel);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(abs);
        assertContainedSymlink(root, childRel, target);
        into.set(childRel, { path: childRel, kind: "symlink", target });
      } else if (stat.isDirectory()) {
        walk(childRel);
      } else if (stat.isFile()) {
        into.set(childRel, { path: childRel, kind: "file", abs, mode: stat.mode & 0o777 });
      } else {
        throw new UsageError(`runtime closure refuses non-file dependency entry ${childRel}`);
      }
      if (into.size > MAX_CLOSURE_ENTRIES) throw new UsageError(`runtime closure exceeds ${MAX_CLOSURE_ENTRIES} entries`);
    }
  };
  walk(startRel);
}

function collectWorkspaceDependencyLinks(root: string, workspace: string, into: Map<string, CollectedNode>): void {
  const nodeModules = join(workspace, "node_modules");
  if (!existsSync(nodeModules)) return;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIPPED_WORKSPACE_NODE_MODULES[name] === true) continue;
      const abs = join(dir, name);
      const rel = relative(resolve(root), abs).split(sep).join("/");
      safeRelativePath(rel);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(abs);
        assertContainedSymlink(root, rel, target);
        into.set(rel, { path: rel, kind: "symlink", target });
      } else if (stat.isDirectory()) {
        walk(abs);
      } else if (!stat.isFile()) {
        throw new UsageError(`runtime closure refuses non-file workspace dependency entry ${rel}`);
      }
      if (into.size > MAX_CLOSURE_ENTRIES) throw new UsageError(`runtime closure exceeds ${MAX_CLOSURE_ENTRIES} entries`);
    }
  };
  walk(nodeModules);
}

function readCasVerified(casDir: string, hash: string): Buffer {
  const bytes = readCas(casDir, hash);
  const actual = sha256(bytes);
  if (actual !== hash) throw new UsageError(`CAS content hash mismatch for ${hash}: got ${actual}`);
  return bytes;
}

function storeCasVerified(casDir: string, bytes: Buffer): { hash: Sha256Digest; marginalBytes: number } {
  const hash = sha256(bytes);
  if (existsSync(casPath(casDir, hash))) {
    readCasVerified(casDir, hash);
    return { hash, marginalBytes: 0 };
  }
  const written = writeCas(casDir, bytes) as Sha256Digest;
  if (written !== hash) throw new UsageError(`CAS returned an unexpected digest ${written} for ${hash}`);
  readCasVerified(casDir, hash);
  return { hash, marginalBytes: bytes.length };
}

function captureFile(casDir: string, node: CollectedNode): { entry: RuntimeClosureEntry; marginalBytes: number } {
  if (node.kind === "symlink") {
    if (node.target === undefined) throw new UsageError(`runtime closure symlink ${node.path} has no target`);
    return { entry: { kind: "symlink", path: node.path, target: node.target }, marginalBytes: 0 };
  }
  if (node.abs === undefined || node.mode === undefined) throw new UsageError(`runtime closure file ${node.path} has no source or mode`);
  const bytes = readFileSync(node.abs);
  if (node.diskSha256 !== undefined && sha256(bytes) !== node.diskSha256) {
    throw new UsageError(`tracked source bytes drifted during closure capture: ${node.path}`);
  }
  const chunks: Array<{ hash: string; size: number }> = [];
  let marginalBytes = 0;
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
    const stored = storeCasVerified(casDir, chunk);
    chunks.push({ hash: stored.hash, size: chunk.length });
    marginalBytes += stored.marginalBytes;
  }
  const fileDigest = sha256(bytes);
  return {
    entry: {
      kind: "file",
      path: node.path,
      mode: node.mode,
      size: bytes.length,
      sha256: fileDigest,
      chunks,
    },
    marginalBytes,
  };
}

function validateTreeShape(tree: RuntimeClosureTreeV1): void {
  if (tree.entries.length > MAX_CLOSURE_ENTRIES) throw new UsageError(`runtime closure exceeds ${MAX_CLOSURE_ENTRIES} entries`);
  const seen = new Map<string, string>();
  for (const entry of tree.entries) {
    safeRelativePath(entry.path);
    const collisionKey = entry.path.normalize("NFC").toLowerCase();
    if (seen.has(collisionKey)) {
      throw new UsageError(`runtime closure has a duplicate or case/Unicode-colliding path ${entry.path}`);
    }
    seen.set(collisionKey, entry.path);
  }
  for (const [key, path] of seen) {
    const parts = key.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      const ancestor = parts.slice(0, length).join("/");
      if (seen.has(ancestor)) {
        throw new UsageError(`runtime closure path ${path} is nested beneath non-directory ${seen.get(ancestor)}`);
      }
    }
  }
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of tree.entries) {
    if (entry.kind === "symlink") continue;
    fileCount += 1;
    totalBytes += entry.size;
    const chunkBytes = entry.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    if (chunkBytes !== entry.size) throw new UsageError(`runtime closure chunk sizes do not reconstruct ${entry.path}`);
    if (entry.size === 0 && entry.chunks.length !== 0) throw new UsageError(`empty runtime closure file ${entry.path} has chunks`);
    if (entry.size > 0 && entry.chunks.length === 0) throw new UsageError(`runtime closure file ${entry.path} has no chunks`);
  }
  if (fileCount !== tree.fileCount || totalBytes !== tree.totalBytes) {
    throw new UsageError("runtime closure tree totals do not match its entries");
  }
  if (totalBytes > MAX_CLOSURE_BYTES) throw new UsageError(`runtime closure exceeds ${MAX_CLOSURE_BYTES} bytes`);
}

function verifyRuntimeClosureArtifacts(casDir: string, closureDigest: Sha256Digest): RuntimeClosureTreeV1 {
  const treeBytes = readCasVerified(casDir, closureDigest);
  const tree = RuntimeClosureTreeV1.parse(JSON.parse(treeBytes.toString("utf8")));
  validateTreeShape(tree);
  for (const entry of tree.entries) {
    if (entry.kind !== "file") continue;
    const digest = createHash("sha256");
    let size = 0;
    for (const chunk of entry.chunks) {
      const bytes = readCasVerified(casDir, chunk.hash);
      if (bytes.length !== chunk.size) throw new UsageError(`runtime closure chunk length mismatch for ${entry.path}`);
      size += bytes.length;
      digest.update(bytes);
    }
    const actual = `sha256:${digest.digest("hex")}`;
    if (size !== entry.size || actual !== entry.sha256) {
      throw new UsageError(`runtime closure file content mismatch for ${entry.path}`);
    }
  }
  return tree;
}

function manifestForRecord(
  campaignConfigHash: Sha256Digest,
  record: CampaignRuntimeClosureCaptureV1,
): RuntimeClosureManifestV1 {
  return {
    version: 1,
    campaignConfigHash,
    closureDigest: record.closureDigest,
    sourceCommit: record.sourceCommit,
    bootDigest: record.bootDigest,
    campaignBootDigest: record.campaignBootDigest,
    optimizerImage: record.optimizerImage,
    optimizerBaseDigest: record.optimizerBaseDigest,
    capturedAt: record.at,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
  };
}

function readBoundManifest(
  casDir: string,
  campaignConfigHash: Sha256Digest,
  record: CampaignRuntimeClosureCaptureV1,
): RuntimeClosureManifestV1 {
  const bytes = readCasVerified(casDir, record.manifestArtifact);
  const manifest = RuntimeClosureManifestV1.parse(JSON.parse(bytes.toString("utf8")));
  if (canonicalJson(manifest) !== canonicalJson(manifestForRecord(campaignConfigHash, record))) {
    throw new UsageError("runtime closure manifest does not match its campaign record binding");
  }
  return manifest;
}

export async function captureRuntimeClosure(
  request: CaptureRuntimeClosureRequest,
): Promise<CaptureRuntimeClosureResult> {
  if (
    !DIGEST_PATTERN.test(request.campaignBootDigest)
    || (request.expectedBootDigest !== undefined && !DIGEST_PATTERN.test(request.expectedBootDigest))
    || !DIGEST_PATTERN.test(request.optimizerBaseDigest)
  ) {
    throw new UsageError("runtime closure expected identities must be lowercase sha256 digests");
  }
  if ((request.nodeModulesArchive === undefined) !== (request.nodeModulesArchiveSha256 === undefined)) {
    throw new UsageError("node_modules archive capture requires both archive path and verified sha256");
  }
  const parsedAt = new Date(request.capturedAt);
  if (!Number.isFinite(parsedAt.valueOf()) || parsedAt.toISOString() !== request.capturedAt) {
    throw new UsageError("runtime closure capture time must be a canonical UTC timestamp");
  }

  const sourceRoot = realpathSync(request.sourceRoot);
  assertCleanSourceTree(sourceRoot);
  const treeEntries = parseGitTree(sourceRoot, request.sourceCommit);
  let captureRoot = sourceRoot;
  let scratch: string | undefined;
  if (request.nodeModulesArchive === undefined) {
    if (sourceHead(sourceRoot) !== request.sourceCommit) {
      throw new UsageError("runtime closure capture from a non-HEAD source commit requires a verified node_modules archive");
    }
  } else {
    scratch = mkdtempSync(join(tmpdir(), "hone-runtime-closure-capture-"));
    chmodSync(scratch, 0o700);
    materializeGitCommit(sourceRoot, treeEntries, scratch);
    await extractNodeModulesArchive(
      request.nodeModulesArchive,
      request.nodeModulesArchiveSha256 as Sha256Digest,
      scratch,
    );
    captureRoot = scratch;
  }

  try {
    const packageMap = readPackageMap(captureRoot);
    if (scratch !== undefined) materializeWorkspaceDependencyLinks(captureRoot, packageMap);
    const actualBootDigest = computeTrustedRuntimeDigestAt(captureRoot);
    if (request.expectedBootDigest !== undefined && actualBootDigest !== request.expectedBootDigest) {
      throw new UsageError(
        `runtime closure boot digest mismatch: ${actualBootDigest} != sealed ${request.expectedBootDigest}`,
      );
    }
    const actualOptimizerDigest = snapshotDigest(
      request.optimizerImage,
      collectOptimizerSnapshot(captureRoot),
    ) as Sha256Digest;
    if (actualOptimizerDigest !== request.optimizerBaseDigest) {
      throw new UsageError(
        `runtime closure optimizer base digest mismatch: ${actualOptimizerDigest} != sealed ${request.optimizerBaseDigest}`,
      );
    }

    const nodes = new Map<string, CollectedNode>();
    for (const source of treeEntries) {
      const captured = readVerifiedSourceEntry(captureRoot, source);
      nodes.set(source.path, captured.kind === "file"
        ? {
          path: source.path,
          kind: "file",
          abs: captured.abs,
          gitOid: captured.gitOid,
          diskSha256: captured.diskSha256,
          mode: captured.mode,
        }
        : { path: source.path, kind: "symlink", target: captured.target });
    }
    collectNodeModulesTree(captureRoot, "node_modules", nodes);
    for (const workspace of workspaceDirectories(captureRoot, packageMap)) {
      collectWorkspaceDependencyLinks(captureRoot, workspace, nodes);
    }

    request.beforeFileCapture?.();
    const entries: RuntimeClosureEntry[] = [];
    let marginalBytes = 0;
    let marginalContentBytes = 0;
    let totalBytes = 0;
    let fileCount = 0;
    for (const path of [...nodes.keys()].sort()) {
      const node = nodes.get(path);
      if (node === undefined) continue;
      const captured = captureFile(request.casDir, node);
      entries.push(captured.entry);
      marginalBytes += captured.marginalBytes;
      marginalContentBytes += captured.marginalBytes;
      if (captured.entry.kind === "file") {
        totalBytes += captured.entry.size;
        fileCount += 1;
      }
      if (totalBytes > MAX_CLOSURE_BYTES) throw new UsageError(`runtime closure exceeds ${MAX_CLOSURE_BYTES} bytes`);
    }

    const tree = RuntimeClosureTreeV1.parse({ version: 1, chunkSize: CHUNK_SIZE, fileCount, totalBytes, entries });
    validateTreeShape(tree);
    const treeStored = storeCasVerified(request.casDir, Buffer.from(canonicalJson(tree), "utf8"));
    marginalBytes += treeStored.marginalBytes;
    const manifest = RuntimeClosureManifestV1.parse({
      version: 1,
      campaignConfigHash: request.campaignConfigHash,
      closureDigest: treeStored.hash,
      sourceCommit: request.sourceCommit,
      bootDigest: actualBootDigest,
      campaignBootDigest: request.campaignBootDigest,
      optimizerImage: request.optimizerImage,
      optimizerBaseDigest: request.optimizerBaseDigest,
      capturedAt: request.capturedAt,
      fileCount,
      totalBytes,
    });
    const manifestStored = storeCasVerified(request.casDir, Buffer.from(canonicalJson(manifest), "utf8"));
    marginalBytes += manifestStored.marginalBytes;
    const body = {
      version: 1,
      at: request.capturedAt,
      sourceCommit: request.sourceCommit,
      bootDigest: actualBootDigest,
      campaignBootDigest: request.campaignBootDigest,
      optimizerImage: request.optimizerImage,
      optimizerBaseDigest: request.optimizerBaseDigest,
      closureDigest: treeStored.hash,
      manifestArtifact: manifestStored.hash,
      fileCount,
      totalBytes,
      previousRecordDigest: request.previousRecordDigest,
    } as const;
    const record = {
      ...body,
      recordDigest: campaignRuntimeClosureRecordDigest(body),
    } satisfies CampaignRuntimeClosureCaptureV1;

    const verified = verifyRuntimeClosureArtifacts(request.casDir, record.closureDigest);
    if (verified.fileCount !== record.fileCount || verified.totalBytes !== record.totalBytes) {
      throw new UsageError("captured runtime closure verification did not reproduce its record totals");
    }
    readBoundManifest(request.casDir, request.campaignConfigHash, record);
    assertCleanSourceTree(sourceRoot);
    if (request.nodeModulesArchive === undefined && sourceHead(sourceRoot) !== request.sourceCommit) {
      throw new UsageError("source HEAD changed during runtime closure capture");
    }
    return { record, marginalBytes, reusedBytes: totalBytes - marginalContentBytes };
  } finally {
    if (scratch !== undefined) removePrivateTree(scratch);
  }
}

export function assertCampaignRuntimeClosureOnly(
  beforeInput: RecursiveMetaCampaignConfig,
  afterInput: RecursiveMetaCampaignConfig,
): void {
  const before = MetaCampaignConfigV2.parse(beforeInput);
  const after = MetaCampaignConfigV2.parse(afterInput);
  const { runtimeClosureJournal: _beforeJournal, ...beforeFrozen } = before;
  const { runtimeClosureJournal: _afterJournal, ...afterFrozen } = after;
  if (canonicalJson(beforeFrozen) !== canonicalJson(afterFrozen)) {
    throw new UsageError("runtime closure append attempted to alter frozen campaign fields");
  }
}

export function withRuntimeClosureCapture(
  configInput: RecursiveMetaCampaignConfig,
  record: CampaignRuntimeClosureCaptureV1,
): RecursiveMetaCampaignConfig {
  const config = MetaCampaignConfigV2.parse(configInput);
  const configHash = metaCampaignConfigHash(config);
  const previous = config.runtimeClosureJournal?.captures.at(-1);
  if (record.previousRecordDigest !== (previous?.recordDigest ?? null)) {
    throw new UsageError("runtime closure record does not extend the campaign capture chain");
  }
  const updated = MetaCampaignConfigV2.parse({
    ...config,
    runtimeClosureJournal: {
      version: 1,
      campaignConfigHash: config.runtimeClosureJournal?.campaignConfigHash ?? configHash,
      captures: [...(config.runtimeClosureJournal?.captures ?? []), record],
    },
  });
  assertCampaignRuntimeClosureOnly(config, updated);
  if (metaCampaignConfigHash(updated) !== configHash) {
    throw new UsageError("runtime closure append changed the frozen campaign identity");
  }
  return updated;
}

const activeCampaignLocks = new WeakSet<CampaignRecordLock>();

export class CampaignRecordLock {
  readonly campaignPath: string;
  readonly lockPath: string;
  readonly token: string;

  constructor(campaignPath: string, lockPath: string, token: string) {
    this.campaignPath = campaignPath;
    this.lockPath = lockPath;
    this.token = token;
  }
}

export interface AcquiredCampaignRecordLock {
  readonly lock: CampaignRecordLock;
  readonly release: () => void;
}

export function acquireCampaignRecordLock(campaignPathInput: string): AcquiredCampaignRecordLock {
  const campaignPath = resolve(campaignPathInput);
  const lockPath = `${campaignPath}.campaign-record.lock`;
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error) {
    throw new UsageError(`campaign record is locked (${lockPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const bytes = Buffer.from(canonicalJson({ version: 1, pid: process.pid, token, acquiredAt: new Date().toISOString() }), "utf8");
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const lock = new CampaignRecordLock(campaignPath, lockPath, token);
  activeCampaignLocks.add(lock);
  let released = false;
  return {
    lock,
    release: () => {
      if (released) return;
      released = true;
      activeCampaignLocks.delete(lock);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch (error) {
        throw new UsageError(`campaign record lock changed before release: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (parsed === null || typeof parsed !== "object" || (parsed as Record<string, unknown>)["token"] !== token) {
        throw new UsageError("campaign record lock ownership changed before release");
      }
      unlinkSync(lockPath);
    },
  };
}

export function appendRuntimeClosureCaptureRecord(
  campaignPathInput: string,
  record: CampaignRuntimeClosureCaptureV1,
  lock: CampaignRecordLock,
  expectedCampaignBytes?: Buffer,
): RecursiveMetaCampaignConfig {
  const campaignPath = resolve(campaignPathInput);
  if (!activeCampaignLocks.has(lock) || lock.campaignPath !== campaignPath) {
    throw new UsageError("runtime closure record append requires the matching held campaign lock");
  }
  const currentBytes = readFileSync(campaignPath);
  if (expectedCampaignBytes !== undefined && !currentBytes.equals(expectedCampaignBytes)) {
    throw new UsageError("campaign file changed during runtime closure capture; retry");
  }
  const config = MetaCampaignConfigV2.parse(JSON.parse(currentBytes.toString("utf8")));
  const updated = withRuntimeClosureCapture(config, record);
  writeFileDurable(campaignPath, `${JSON.stringify(updated, null, 2)}\n`);
  chmodSync(campaignPath, 0o600);
  return updated;
}

function materializeTree(casDir: string, tree: RuntimeClosureTreeV1, destination: string): void {
  for (const entry of tree.entries) {
    if (entry.kind !== "file") continue;
    const target = closurePath(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    const fd = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, entry.mode);
    const digest = createHash("sha256");
    let written = 0;
    try {
      for (const chunk of entry.chunks) {
        const bytes = readCasVerified(casDir, chunk.hash);
        if (bytes.length !== chunk.size) throw new UsageError(`runtime closure chunk length mismatch for ${entry.path}`);
        writeFileSync(fd, bytes);
        written += bytes.length;
        digest.update(bytes);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(target, entry.mode);
    const actual = `sha256:${digest.digest("hex")}`;
    if (written !== entry.size || actual !== entry.sha256) {
      throw new UsageError(`restored runtime closure file hash mismatch for ${entry.path}`);
    }
  }
  for (const entry of tree.entries) {
    if (entry.kind !== "symlink") continue;
    assertContainedSymlink(destination, entry.path, entry.target);
    const target = closurePath(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    symlinkSync(entry.target, target);
  }
}

function verifyMaterializedTree(root: string, tree: RuntimeClosureTreeV1): void {
  const expected = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const observed = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      const stat = lstatSync(abs);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(abs);
        continue;
      }
      const entry = expected.get(rel);
      if (entry === undefined) throw new UsageError(`restored runtime closure contains unexpected entry ${rel}`);
      observed.add(rel);
      if (entry.kind === "symlink") {
        if (!stat.isSymbolicLink() || readlinkSync(abs) !== entry.target) {
          throw new UsageError(`restored runtime closure symlink mismatch for ${rel}`);
        }
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new UsageError(`restored runtime closure file type mismatch for ${rel}`);
      if ((stat.mode & 0o777) !== entry.mode) throw new UsageError(`restored runtime closure mode mismatch for ${rel}`);
      const bytes = readFileSync(abs);
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
        throw new UsageError(`restored runtime closure file hash mismatch for ${rel}`);
      }
    }
  };
  walk(root);
  if (observed.size !== expected.size) {
    const missing = [...expected.keys()].filter((path) => !observed.has(path));
    throw new UsageError(`restored runtime closure is missing ${missing.slice(0, 3).join(", ")}`);
  }
}

export function runtimeClosureCaptureRecord(
  configInput: RecursiveMetaCampaignConfig,
  manifestArtifact?: string,
): CampaignRuntimeClosureCaptureV1 {
  const config = MetaCampaignConfigV2.parse(configInput);
  metaCampaignConfigHash(config);
  const captures = config.runtimeClosureJournal?.captures;
  if (captures === undefined || captures.length === 0) throw new UsageError("campaign has no captured runtime closure");
  if (manifestArtifact === undefined) return captures[captures.length - 1] as CampaignRuntimeClosureCaptureV1;
  if (!DIGEST_PATTERN.test(manifestArtifact)) throw new UsageError("--manifest must be a lowercase sha256 digest");
  const match = captures.find((record) => record.manifestArtifact === manifestArtifact);
  if (match === undefined) throw new UsageError(`campaign has no runtime closure manifest ${manifestArtifact}`);
  return match;
}

export function restoreRuntimeClosure(
  request: RestoreRuntimeClosureRequest,
): RestoreRuntimeClosureResult {
  const target = resolve(request.targetDir);
  if (existsSync(target)) throw new UsageError(`runtime closure restore target already exists: ${target}`);
  const manifest = readBoundManifest(request.casDir, request.campaignConfigHash, request.record);
  const tree = verifyRuntimeClosureArtifacts(request.casDir, manifest.closureDigest as Sha256Digest);
  if (tree.fileCount !== manifest.fileCount || tree.totalBytes !== manifest.totalBytes) {
    throw new UsageError("runtime closure manifest totals do not match its content tree");
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  mkdirSync(temporary, { mode: 0o700 });
  try {
    materializeTree(request.casDir, tree, temporary);
    verifyMaterializedTree(temporary, tree);
    const optimizerBaseDigest = snapshotDigest(
      manifest.optimizerImage,
      collectOptimizerSnapshot(temporary),
    ) as Sha256Digest;
    if (optimizerBaseDigest !== manifest.optimizerBaseDigest) {
      throw new UsageError(
        `restored optimizer base digest mismatch: ${optimizerBaseDigest} != sealed ${manifest.optimizerBaseDigest}`,
      );
    }
    const bootDigest = computeTrustedRuntimeDigestAt(temporary) as Sha256Digest;
    if (bootDigest !== manifest.bootDigest) {
      throw new UsageError(`restored boot digest mismatch: ${bootDigest} != sealed ${manifest.bootDigest}`);
    }
    renameSync(temporary, target);
    return {
      targetDir: target,
      closureDigest: manifest.closureDigest as Sha256Digest,
      optimizerBaseDigest,
      bootDigest,
      fileCount: tree.fileCount,
      totalBytes: tree.totalBytes,
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function parseSha256Sidecar(path: string, archivePath: string): Sha256Digest {
  const sidecar = readFileSync(path, "utf8").trim();
  const match = /^([0-9a-f]{64})\s+(.+)$/.exec(sidecar);
  if (match === null) throw new UsageError(`invalid sha256 sidecar ${path}`);
  const [, hex, namedPath] = match;
  if (hex === undefined || namedPath === undefined) throw new UsageError(`invalid sha256 sidecar ${path}`);
  if (basename(namedPath) !== basename(archivePath)) {
    throw new UsageError(`sha256 sidecar names ${namedPath}, not ${archivePath}`);
  }
  return `sha256:${hex}`;
}
