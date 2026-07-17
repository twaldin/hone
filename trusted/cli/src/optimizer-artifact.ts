import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
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
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { CasStore, unpackArtifact } from "@hone/broker";
import { canonicalJson } from "@hone/schema";
import { z } from "zod";
import { UsageError } from "./args.js";
import { casPath } from "./cas.js";
import { syncDir, writeAllSync } from "./eventlog.js";
import {
  OPTIMIZER_DIGEST_RE,
  OPTIMIZER_SKIP,
  collectOptimizerSnapshot,
  repoRootFromHere,
  snapshotDigest,
} from "./optimizer-digest.js";
import type { OptimizerSnapshot, SnapshotFile } from "./optimizer-digest.js";

/** Durable run-dir receipt for a selected candidate optimizer. */
export const OPTIMIZER_ARTIFACT_SEAL_FILE = "optimizer-artifact.json";

/** Candidate-specific ceilings, deliberately much smaller than general sandbox artifacts. */
export const MAX_CANDIDATE_OPTIMIZER_ENTRIES = 2_048;
export const MAX_CANDIDATE_OPTIMIZER_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_CANDIDATE_OPTIMIZER_TOTAL_BYTES = 64 * 1024 * 1024;
/** Payload ceiling plus bounded ustar headers/padding and metadata. */
export const MAX_CANDIDATE_OPTIMIZER_ARCHIVE_BYTES = 72 * 1024 * 1024;

const BLOCK = 512;
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
const MUTABLE_PREFIXES = ["src/", "assets/"] as const;
const REQUIRED_IMMUTABLE_FILES = ["package.json", "tsconfig.json"] as const;

export interface CandidateOptimizerSelection {
  sourceArtifact: string;
  baseDigest: string;
  mergedDigest: string;
  /** Every selected mutable file, workspace-relative, mapped to its exact bytes hash. Absence expresses deletion. */
  mutablePaths: Record<string, string>;
}

export interface ResolvedCandidateOptimizer extends CandidateOptimizerSelection {
  /** Full captured optimizer closure: candidate src/assets over the captured trusted base. */
  snapshot: OptimizerSnapshot;
}

export interface OptimizerArtifactSeal extends CandidateOptimizerSelection {
  version: 1;
  runId: string;
}

export interface ResolvedSealedCandidateOptimizer extends ResolvedCandidateOptimizer {
  seal: OptimizerArtifactSeal;
}

const DigestSchema = z.string().regex(OPTIMIZER_DIGEST_RE);
const OptimizerArtifactSealSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    sourceArtifact: DigestSchema,
    baseDigest: DigestSchema,
    mergedDigest: DigestSchema,
    mutablePaths: z.record(DigestSchema),
  })
  .strict();

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isMutablePath(rel: string): boolean {
  if (!MUTABLE_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
  return rel.split("/").every((component) =>
    component !== ""
    && component !== "."
    && component !== ".."
    && !component.includes("\\")
    && !component.includes("\0")
  );
}

function optimizerRel(rel: string): string {
  return `optimizer/${rel}`;
}


function parseTarNumber(field: Buffer, what: string): number {
  if ((field[0] ?? 0) >= 0x80) throw new UsageError(`candidate optimizer tar uses unsupported base-256 ${what}`);
  const nul = field.indexOf(0);
  const raw = field.subarray(0, nul < 0 ? field.length : nul).toString("latin1").trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) throw new UsageError(`candidate optimizer tar has an invalid ${what}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new UsageError(`candidate optimizer tar has an invalid ${what}`);
  return value;
}

function tarString(field: Buffer, what: string): string {
  const nul = field.indexOf(0);
  const bytes = field.subarray(0, nul < 0 ? field.length : nul);
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    throw new UsageError(`candidate optimizer tar ${what} contains invalid UTF-8`);
  }
}

function parsePaxPath(content: Buffer): string | undefined {
  let off = 0;
  let path: string | undefined;
  while (off < content.length) {
    const space = content.indexOf(0x20, off);
    if (space < 0) throw new UsageError("candidate optimizer tar has malformed pax metadata");
    const lengthText = content.subarray(off, space).toString("latin1");
    if (!/^[0-9]+$/.test(lengthText)) throw new UsageError("candidate optimizer tar has malformed pax metadata");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= space - off + 2 || off + length > content.length || content[off + length - 1] !== 0x0a) {
      throw new UsageError("candidate optimizer tar has malformed pax metadata");
    }
    const record = tarString(content.subarray(space + 1, off + length - 1), "pax record");
    const equals = record.indexOf("=");
    if (equals < 0) throw new UsageError("candidate optimizer tar has malformed pax metadata");
    if (record.slice(0, equals) === "path") {
      if (path !== undefined) throw new UsageError("candidate optimizer tar has duplicate pax path metadata");
      path = record.slice(equals + 1);
    }
    off += length;
  }
  return path;
}

function normalizedTarPath(raw: string, kind: "file" | "dir"): string {
  if (raw.startsWith("./")) raw = raw.slice(2);
  if (raw.endsWith("/") && kind === "dir") raw = raw.slice(0, -1);
  if (
    raw === ""
    || raw.startsWith("/")
    || raw.includes("\\")
    || raw.includes("\0")
    || raw.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new UsageError(`candidate optimizer tar has an invalid entry path ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Filesystems used by supported hosts are not byte-name authorities: Darwin
 * normalizes Unicode and commonly ignores case, while Linux deployments are
 * frequently backed by case-insensitive bind mounts. NFKC + Unicode's
 * upper/lower expansion is a deterministic, locale-independent conservative
 * case-fold (including e.g. ß/SS and final sigma) on both platforms.
 */
function portablePathKey(path: string): string {
  return path
    .split("/")
    .map((component) => component.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC"))
    .join("/");
}

interface PortableTarNode {
  path: string;
  kind: "file" | "dir";
  explicit: boolean;
}

function admitPortableTarPath(nodes: Map<string, PortableTarNode>, path: string, kind: "file" | "dir"): void {
  const parts = path.split("/");
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const current = parts.slice(0, depth).join("/");
    const currentKind = depth === parts.length ? kind : "dir";
    const explicit = depth === parts.length;
    const key = portablePathKey(current);
    const prior = nodes.get(key);
    if (prior === undefined) {
      nodes.set(key, { path: current, kind: currentKind, explicit });
      continue;
    }
    if (prior.path !== current) {
      throw new UsageError(
        `candidate optimizer tar has portable path collision between ${JSON.stringify(prior.path)} and ${JSON.stringify(current)}`,
      );
    }
    if (prior.kind !== currentKind) {
      throw new UsageError(
        `candidate optimizer tar has portable file/directory collision at ${JSON.stringify(current)}`,
      );
    }
    if (explicit && prior.explicit) {
      throw new UsageError(`candidate optimizer tar has duplicate entry ${JSON.stringify(current)}`);
    }
    if (explicit) nodes.set(key, { ...prior, explicit: true });
  }
}

/**
 * Cheap candidate-specific resource preflight. The broker's authoritative
 * bounded validator still checks checksums, paths, types, duplicates, pax,
 * traversal and end markers before extraction; this pass only applies the
 * tighter optimizer count/byte ceilings before host inodes are created.
 */
function preflightCandidateTar(bytes: Buffer): void {
  if (bytes.length > MAX_CANDIDATE_OPTIMIZER_ARCHIVE_BYTES) {
    throw new UsageError(`candidate optimizer archive exceeds ${MAX_CANDIDATE_OPTIMIZER_ARCHIVE_BYTES} bytes`);
  }
  let off = 0;
  let entries = 0;
  let totalBytes = 0;
  let pendingPaxPath: string | undefined;
  let pendingLongName: string | undefined;
  const portableNodes = new Map<string, PortableTarNode>();
  while (off + BLOCK <= bytes.length) {
    const header = bytes.subarray(off, off + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = parseTarNumber(header.subarray(124, 136), "entry size");
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const next = off + BLOCK + padded;
    if (!Number.isSafeInteger(next) || next <= off || next > bytes.length) {
      throw new UsageError("candidate optimizer tar is truncated or has invalid entry framing");
    }
    const content = bytes.subarray(off + BLOCK, off + BLOCK + size);
    const typeByte = header[156] ?? 0;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    if (type === "x") {
      if (pendingPaxPath !== undefined) throw new UsageError("candidate optimizer tar has consecutive pax path metadata");
      pendingPaxPath = parsePaxPath(content);
      off = next;
      continue;
    }
    if (type === "L") {
      if (pendingLongName !== undefined) throw new UsageError("candidate optimizer tar has consecutive GNU longname metadata");
      let end = content.length;
      while (end > 0 && (content[end - 1] === 0 || content[end - 1] === 0x0a)) end -= 1;
      pendingLongName = tarString(content.subarray(0, end), "GNU longname");
      off = next;
      continue;
    }
    if (type === "0" || type === "5") {
      entries += 1;
      if (entries > MAX_CANDIDATE_OPTIMIZER_ENTRIES) {
        throw new UsageError(`candidate optimizer archive exceeds ${MAX_CANDIDATE_OPTIMIZER_ENTRIES} entries`);
      }
      if (type === "0") {
        if (size > MAX_CANDIDATE_OPTIMIZER_FILE_BYTES) {
          throw new UsageError(`candidate optimizer archive contains a file larger than ${MAX_CANDIDATE_OPTIMIZER_FILE_BYTES} bytes`);
        }
        totalBytes += size;
        if (totalBytes > MAX_CANDIDATE_OPTIMIZER_TOTAL_BYTES) {
          throw new UsageError(`candidate optimizer archive payload exceeds ${MAX_CANDIDATE_OPTIMIZER_TOTAL_BYTES} bytes`);
        }
      }
      let name = tarString(header.subarray(0, 100), "entry name");
      const prefix = tarString(header.subarray(345, 500), "entry prefix");
      if (prefix !== "") name = `${prefix}/${name}`;
      if (pendingLongName !== undefined && pendingPaxPath !== undefined) {
        throw new UsageError("candidate optimizer tar supplies both pax and GNU path overrides");
      }
      name = pendingLongName ?? pendingPaxPath ?? name;
      pendingLongName = undefined;
      pendingPaxPath = undefined;
      const kind = type === "5" ? "dir" : "file";
      admitPortableTarPath(portableNodes, normalizedTarPath(name, kind), kind);
    }
    off = next;
  }
}

/** Single captured read from the named CAS inode, followed by content-address verification. */
function readCandidateCasBytes(casDir: string, artifactHash: string): Buffer {
  if (!OPTIMIZER_DIGEST_RE.test(artifactHash)) throw new UsageError(`--optimizer-artifact must be sha256:<64 lowercase hex>`);
  const path = casPath(casDir, artifactHash);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") throw new UsageError(`optimizer artifact ${artifactHash} is missing from CAS (${path})`);
    throw new UsageError(`cannot open optimizer artifact ${artifactHash} from CAS: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) {
      throw new UsageError(`optimizer artifact ${artifactHash} is not a single-link regular CAS file`);
    }
    if (before.size > MAX_CANDIDATE_OPTIMIZER_ARCHIVE_BYTES) {
      throw new UsageError(`candidate optimizer archive exceeds ${MAX_CANDIDATE_OPTIMIZER_ARCHIVE_BYTES} bytes`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) {
      throw new UsageError(`optimizer artifact ${artifactHash} changed during its captured read`);
    }
    const actual = sha256(bytes);
    if (actual !== artifactHash) {
      throw new UsageError(`optimizer artifact CAS hash mismatch: requested ${artifactHash}, captured bytes hash ${actual}`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

interface CandidateTree {
  files: Map<string, SnapshotFile>;
  directories: Set<string>;
}

function collectCandidateTree(workspaceDir: string): CandidateTree {
  const files = new Map<string, SnapshotFile>();
  const directories = new Set<string>();
  let entries = 0;
  let totalBytes = 0;
  const walk = (absDir: string, relDir: string): void => {
    for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(absDir, entry.name);
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const st = lstatSync(abs);
      entries += 1;
      if (entries > MAX_CANDIDATE_OPTIMIZER_ENTRIES) {
        throw new UsageError(`candidate optimizer tree exceeds ${MAX_CANDIDATE_OPTIMIZER_ENTRIES} entries`);
      }
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
        throw new UsageError(`candidate optimizer contains a non-regular entry at ${JSON.stringify(rel)}`);
      }
      if (st.isDirectory()) {
        const mode = st.mode & 0o777;
        if (mode !== 0o755) throw new UsageError(`candidate optimizer directory ${JSON.stringify(rel)} has non-canonical mode ${mode.toString(8)}`);
        directories.add(rel);
        walk(abs, rel);
        continue;
      }
      const mode = st.mode & 0o777;
      if (mode !== 0o644 && mode !== 0o755) {
        throw new UsageError(`candidate optimizer file ${JSON.stringify(rel)} has non-canonical mode ${mode.toString(8)}`);
      }
      if (st.size > MAX_CANDIDATE_OPTIMIZER_FILE_BYTES) {
        throw new UsageError(`candidate optimizer file ${JSON.stringify(rel)} exceeds ${MAX_CANDIDATE_OPTIMIZER_FILE_BYTES} bytes`);
      }
      totalBytes += st.size;
      if (totalBytes > MAX_CANDIDATE_OPTIMIZER_TOTAL_BYTES) {
        throw new UsageError(`candidate optimizer tree payload exceeds ${MAX_CANDIDATE_OPTIMIZER_TOTAL_BYTES} bytes`);
      }
      files.set(rel, { bytes: readFileSync(abs), mode });
    }
  };
  walk(workspaceDir, "");
  return { files, directories };
}

function hasSkippedComponent(rel: string): boolean {
  return rel.split("/").some((component) => OPTIMIZER_SKIP[component] === true);
}

function expectedImmutableDirectories(base: OptimizerSnapshot): Set<string> {
  const expected = new Set<string>(["worker"]);
  for (const rel of base.files.keys()) {
    if (!rel.startsWith("optimizer/")) continue;
    const packageRel = rel.slice("optimizer/".length);
    if (isMutablePath(packageRel)) continue;
    let parent = dirname(packageRel);
    while (parent !== ".") {
      expected.add(parent);
      parent = dirname(parent);
    }
  }
  return expected;
}

function validateAndMergeCandidate(base: OptimizerSnapshot, candidate: CandidateTree): { snapshot: OptimizerSnapshot; mutablePaths: Record<string, string> } {
  if (!candidate.directories.has("src")) throw new UsageError("candidate optimizer must contain a src/ directory");
  if (!candidate.directories.has("worker")) throw new UsageError("candidate optimizer must contain the complete worker/ directory");
  if (!candidate.files.has("src/main.ts")) throw new UsageError("candidate optimizer is missing required src/main.ts");
  for (const rel of REQUIRED_IMMUTABLE_FILES) {
    if (!candidate.files.has(rel)) throw new UsageError(`candidate optimizer is missing immutable ${rel}`);
  }

  for (const rel of [...candidate.files.keys(), ...candidate.directories]) {
    if (hasSkippedComponent(rel)) {
      throw new UsageError(`candidate optimizer refuses skipped path ${JSON.stringify(rel)}`);
    }
    const allowed =
      isMutablePath(rel)
      || rel === "src"
      || rel === "assets"
      || rel === "worker"
      || rel.startsWith("worker/")
      || rel === "package.json"
      || rel === "tsconfig.json";
    if (!allowed) throw new UsageError(`candidate optimizer path ${JSON.stringify(rel)} is outside src/**, assets/** and the immutable package tree`);
  }

  const immutableCandidateFiles = new Set<string>();
  for (const [rel, file] of candidate.files) {
    if (isMutablePath(rel)) continue;
    immutableCandidateFiles.add(rel);
    const trusted = base.files.get(optimizerRel(rel));
    if (trusted === undefined) throw new UsageError(`candidate optimizer adds immutable file ${JSON.stringify(rel)}`);
    if (!trusted.bytes.equals(file.bytes)) throw new UsageError(`candidate optimizer mutates immutable file ${JSON.stringify(rel)}`);
    if (trusted.mode !== file.mode) {
      throw new UsageError(`candidate optimizer changes immutable mode for ${JSON.stringify(rel)} (${file.mode.toString(8)} != base ${trusted.mode.toString(8)})`);
    }
  }
  for (const rel of base.files.keys()) {
    if (!rel.startsWith("optimizer/")) continue;
    const packageRel = rel.slice("optimizer/".length);
    if (!isMutablePath(packageRel) && !immutableCandidateFiles.has(packageRel)) {
      throw new UsageError(`candidate optimizer deletes immutable file ${JSON.stringify(packageRel)}`);
    }
  }

  const actualImmutableDirs = new Set([...candidate.directories].filter((rel) => rel === "worker" || rel.startsWith("worker/")));
  const expectedDirs = expectedImmutableDirectories(base);
  for (const rel of actualImmutableDirs) {
    if (!expectedDirs.has(rel)) throw new UsageError(`candidate optimizer adds immutable directory ${JSON.stringify(rel)}`);
  }
  for (const rel of expectedDirs) {
    if (!actualImmutableDirs.has(rel)) throw new UsageError(`candidate optimizer deletes immutable directory ${JSON.stringify(rel)}`);
  }

  const mergedFiles = new Map(base.files);
  for (const rel of [...mergedFiles.keys()]) {
    if (rel.startsWith("optimizer/src/") || rel.startsWith("optimizer/assets/")) mergedFiles.delete(rel);
  }
  const mutableEntries: Array<[string, string]> = [];
  for (const [rel, file] of candidate.files) {
    if (!isMutablePath(rel)) continue;
    // Candidate mode bits never influence identity: TS/assets are build inputs,
    // never executables. Canonical 0644 keeps equivalent candidate bytes deterministic.
    mergedFiles.set(optimizerRel(rel), { bytes: file.bytes, mode: 0o644 });
    mutableEntries.push([rel, sha256(file.bytes)]);
  }
  mutableEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { snapshot: { files: mergedFiles }, mutablePaths: Object.fromEntries(mutableEntries) };
}

/**
 * Resolve one CAS candidate before run creation. The CAS bytes and trusted
 * base are each captured once; the returned merged snapshot owns the exact
 * buffers later staged by the optimizer container.
 */
export async function resolveCandidateOptimizer(opts: {
  casDir: string;
  artifactHash: string;
  image: string;
  repoRoot?: string;
  /** Exact campaign-captured seed closure. When present repoRoot is never read. */
  baseSnapshot?: OptimizerSnapshot;
}): Promise<ResolvedCandidateOptimizer> {
  const sourceArtifact = opts.artifactHash;
  const bytes = readCandidateCasBytes(opts.casDir, sourceArtifact);
  preflightCandidateTar(bytes);
  const base = opts.baseSnapshot ?? collectOptimizerSnapshot(opts.repoRoot ?? repoRootFromHere());
  const baseDigest = snapshotDigest(opts.image, base);

  const scratch = mkdtempSync(join(tmpdir(), "hone-optartifact-"));
  chmodSync(scratch, 0o700);
  try {
    const privateCasDir = join(scratch, "cas");
    const capturedPath = casPath(privateCasDir, sourceArtifact);
    mkdirSync(dirname(capturedPath), { recursive: true, mode: 0o700 });
    const fd = openSync(capturedPath, "wx", 0o600);
    try {
      writeAllSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const workspaceDir = await unpackArtifact(new CasStore(privateCasDir), sourceArtifact, join(scratch, "unpacked"));
    const candidate = collectCandidateTree(workspaceDir);
    const merged = validateAndMergeCandidate(base, candidate);
    return {
      snapshot: merged.snapshot,
      sourceArtifact,
      baseDigest,
      mergedDigest: snapshotDigest(opts.image, merged.snapshot),
      mutablePaths: merged.mutablePaths,
    };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`optimizer artifact ${sourceArtifact} was refused: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}


/** Atomic owner-only publication: fsync bytes, rename, then fsync the run dir. */
export function writeOptimizerArtifactSeal(runDir: string, runId: string, selection: CandidateOptimizerSelection): OptimizerArtifactSeal {
  const seal = OptimizerArtifactSealSchema.parse({
    version: 1,
    runId,
    sourceArtifact: selection.sourceArtifact,
    baseDigest: selection.baseDigest,
    mergedDigest: selection.mergedDigest,
    mutablePaths: selection.mutablePaths,
  });
  const path = join(runDir, OPTIMIZER_ARTIFACT_SEAL_FILE);
  if (existsSync(path)) throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} already exists — refusing to replace the optimizer selection`);
  const tmp = join(runDir, `.${OPTIMIZER_ARTIFACT_SEAL_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeAllSync(fd, Buffer.from(`${canonicalJson(seal)}\n`, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    syncDir(runDir);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  return seal;
}

/** Read and authenticate the owner-only, single-link regular selection seal. */
export function readOptimizerArtifactSeal(runDir: string): OptimizerArtifactSeal | null {
  const path = join(runDir, OPTIMIZER_ARTIFACT_SEAL_FILE);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return null;
    throw new UsageError(`cannot open ${OPTIMIZER_ARTIFACT_SEAL_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile() || st.nlink !== 1) throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} must be a single-link regular file`);
    if ((st.mode & 0o077) !== 0 || (st.mode & 0o400) === 0) {
      throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} must be owner-readable and inaccessible to group/other (mode ${(st.mode & 0o777).toString(8)})`);
    }
    if (uid !== undefined && st.uid !== uid) throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} is not owned by the current user`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fd, "utf8"));
    } catch (error) {
      throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} is unreadable JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const seal = OptimizerArtifactSealSchema.safeParse(parsed);
    if (!seal.success) throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} has an invalid or non-canonical shape`);
    for (const pathKey of Object.keys(seal.data.mutablePaths)) {
      if (!isMutablePath(pathKey) || hasSkippedComponent(pathKey)) {
        throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} names forbidden mutable path ${JSON.stringify(pathKey)}`);
      }
    }
    return seal.data;
  } finally {
    closeSync(fd);
  }
}

/** Re-read a durable seal under the run lock and prove it is exactly the selection already resolved. */
export function assertOptimizerArtifactSeal(runDir: string, expected: OptimizerArtifactSeal | null): void {
  const actual = readOptimizerArtifactSeal(runDir);
  if (expected === null) {
    if (actual !== null) throw new UsageError(`unexpected ${OPTIMIZER_ARTIFACT_SEAL_FILE} appeared after run selection`);
    return;
  }
  if (actual === null) throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} disappeared after run selection`);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} drifted after run selection`);
  }
}

/**
 * Resume an artifact-selected run from its receipt. An absent flag reuses the
 * receipt; an equal restatement is accepted; any new/conflicting selection is
 * refused. The source CAS bytes and base digest must reproduce the receipt.
 */
export async function resolveSealedCandidateOptimizer(opts: {
  runDir: string;
  runId: string;
  artifactHash?: string;
  casDir: string;
  image: string;
  repoRoot?: string;
  /** Exact campaign-captured seed closure. When present repoRoot is never read. */
  baseSnapshot?: OptimizerSnapshot;
}): Promise<ResolvedSealedCandidateOptimizer | null> {
  const seal = readOptimizerArtifactSeal(opts.runDir);
  if (seal === null) {
    if (opts.artifactHash !== undefined) {
      throw new UsageError("--optimizer-artifact cannot select a new optimizer while resuming a run that used the default optimizer");
    }
    return null;
  }
  if (seal.runId !== opts.runId) throw new UsageError(`${OPTIMIZER_ARTIFACT_SEAL_FILE} belongs to run ${seal.runId}, not ${opts.runId}`);
  if (opts.artifactHash !== undefined && opts.artifactHash !== seal.sourceArtifact) {
    throw new UsageError(`--optimizer-artifact ${opts.artifactHash} conflicts with the run's sealed optimizer artifact ${seal.sourceArtifact}`);
  }
  const resolved = await resolveCandidateOptimizer({
    casDir: opts.casDir,
    artifactHash: seal.sourceArtifact,
    image: opts.image,
    ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
    ...(opts.baseSnapshot !== undefined ? { baseSnapshot: opts.baseSnapshot } : {}),
  });
  if (resolved.baseDigest !== seal.baseDigest) {
    throw new UsageError(`base optimizer drift since run creation: digest ${resolved.baseDigest} != sealed ${seal.baseDigest}`);
  }
  if (resolved.mergedDigest !== seal.mergedDigest) {
    throw new UsageError(`merged optimizer drift on resume: digest ${resolved.mergedDigest} != sealed ${seal.mergedDigest}`);
  }
  if (canonicalJson(resolved.mutablePaths) !== canonicalJson(seal.mutablePaths)) {
    throw new UsageError("optimizer artifact mutable file hashes no longer match the run's selection seal");
  }
  return { ...resolved, seal };
}
