import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type Sha256Digest = `sha256:${string}`;
export type CanonicalFileMode = 0o644 | 0o755;

export interface MetaControlSourceFile {
  readonly path: string;
  readonly sha256: Sha256Digest;
  readonly mode: CanonicalFileMode;
}

export interface MetaControlSourceSeal {
  readonly version: 1;
  readonly files: readonly MetaControlSourceFile[];
}

export type MetaControlKind = "broken" | "degraded";

export interface MetaControlTransformation {
  readonly path: string;
  readonly beforeSha256: Sha256Digest;
  readonly afterSha256: Sha256Digest;
  readonly mode: CanonicalFileMode;
}

export interface MetaControlTransformationReceipt {
  readonly version: 1;
  readonly kind: MetaControlKind;
  readonly transformation: "broken-no-candidate-v1" | "degraded-blind-restart-v1";
  readonly sourceSealHash: Sha256Digest;
  readonly artifactDigest: Sha256Digest;
  readonly files: number;
  readonly transformedFiles: readonly MetaControlTransformation[];
}

export interface MetaControlArtifact {
  readonly bytes: Buffer;
  readonly digest: Sha256Digest;
  readonly receipt: MetaControlTransformationReceipt;
}

interface CapturedFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: Sha256Digest;
  readonly mode: CanonicalFileMode;
}

const BLOCK_BYTES = 512;
const CANDIDATE_ROOT_FILES = ["package.json", "tsconfig.json"] as const;
const CANDIDATE_ROOT_DIRS = ["src", "assets", "worker"] as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_CONTROL_ENTRIES = 2_048;
const MAX_CONTROL_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_ARCHIVE_BYTES = 72 * 1024 * 1024;

const BROKEN_MAIN = `import { BrokerClient } from "./client.js";

async function main(): Promise<void> {
  const endpoint = process.env["HONE_BROKER_SOCK"];
  if (endpoint === undefined || endpoint.length === 0) throw new Error("HONE_BROKER_SOCK is not set");
  const broker = await BrokerClient.connect(endpoint);
  try {
    const task = await broker.getTask();
    await broker.finish({ best: task.baselineArtifact });
  } finally {
    broker.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
`;

const DEGRADED_RESTART_BEFORE = "const restart = incumbent !== null && rand(episode) < epsilonRestart;";
const DEGRADED_RESTART_AFTER = "const restart = true; // pre-registered degraded control: discard incumbent history";
const DEGRADED_REPAIR_BEFORE = "export const oneRepair = true;";
const DEGRADED_REPAIR_AFTER = "export const oneRepair = false; // pre-registered degraded control: never consume failure feedback";
const DEGRADED_EVALUATION_BEFORE = `  sections.push(
    \`# \${mode === "repair" ? "Evaluation of the artifact the failed change was based on" : "Current evaluation of this artifact"}\\n\\n\${renderEvaluation(input.parentEvaluation)}\`,
  );

  if (input.lineage.length > 0) {
    const rows = input.lineage.map((l) => \`- episode \${l.episode}: \${l.approach} (delta \${l.delta >= 0 ? "+" : ""}\${l.delta.toFixed(4)})\`);
    sections.push(\`# Prior episodes\\n\\n\${rows.join("\\n")}\`);
  }`;
const DEGRADED_EVALUATION_AFTER = `  sections.push("# Blind mutation\\n\\nNo evaluation history, scores, diagnostics, or prior-episode feedback are available.");`;

function sha256(bytes: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalMode(mode: number): CanonicalFileMode {
  return (mode & 0o100) !== 0 ? 0o755 : 0o644;
}

function validateRelativeFilePath(value: string): void {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    throw new Error(`invalid control source path: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`invalid control source path: ${value}`);
  }
  const root = parts[0];
  const allowedRootFile = parts.length === 1 && CANDIDATE_ROOT_FILES.some((entry) => entry === root);
  const allowedRootDir = parts.length > 1 && CANDIDATE_ROOT_DIRS.some((entry) => entry === root);
  if (!allowedRootFile && !allowedRootDir) throw new Error(`path is outside the candidate optimizer package: ${value}`);
}

async function captureDirectory(optimizerDir: string, relativeDir: string, files: CapturedFile[]): Promise<number> {
  const absoluteDir = path.join(optimizerDir, relativeDir);
  const directoryStat = await lstat(absoluteDir);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`control source must be a real directory: ${relativeDir}`);
  }
  let totalBytes = 0;
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const relative = `${relativeDir}/${entry.name}`;
    validateRelativeFilePath(relative);
    if (entry.isDirectory()) {
      totalBytes += await captureDirectory(optimizerDir, relative, files);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`control source contains a link or special file: ${relative}`);
    if (files.length >= MAX_CONTROL_ENTRIES) throw new Error(`control source exceeds ${MAX_CONTROL_ENTRIES} files`);
    const absolute = path.join(optimizerDir, relative);
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`control source changed while reading: ${relative}`);
    if (before.size > MAX_CONTROL_FILE_BYTES) throw new Error(`control source file exceeds byte limit: ${relative}`);
    if (totalBytes + before.size > MAX_CONTROL_SOURCE_BYTES) throw new Error("control source exceeds byte limit");
    const bytes = await readFile(absolute);
    const after = await lstat(absolute);
    if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw new Error(`control source changed while reading: ${relative}`);
    }
    totalBytes += bytes.length;
    files.push({ path: relative, bytes, sha256: sha256(bytes), mode: canonicalMode(before.mode) });
  }
  return totalBytes;
}

async function captureSourceFiles(optimizerDir: string): Promise<CapturedFile[]> {
  const rootStat = await lstat(optimizerDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("optimizer source root must be a real directory");
  const files: CapturedFile[] = [];
  let totalBytes = 0;
  for (const rootFile of CANDIDATE_ROOT_FILES) {
    const absolute = path.join(optimizerDir, rootFile);
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`required optimizer source file is not regular: ${rootFile}`);
    if (before.size > MAX_CONTROL_FILE_BYTES) throw new Error(`control source file exceeds byte limit: ${rootFile}`);
    const bytes = await readFile(absolute);
    const after = await lstat(absolute);
    if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      throw new Error(`control source changed while reading: ${rootFile}`);
    }
    totalBytes += bytes.length;
    files.push({ path: rootFile, bytes, sha256: sha256(bytes), mode: canonicalMode(before.mode) });
  }
  for (const rootDir of CANDIDATE_ROOT_DIRS) {
    const absolute = path.join(optimizerDir, rootDir);
    try {
      totalBytes += await captureDirectory(optimizerDir, rootDir, files);
    } catch (error: unknown) {
      if (rootDir === "assets" && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  if (totalBytes > MAX_CONTROL_SOURCE_BYTES) throw new Error("control source exceeds byte limit");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.some((file) => file.path === "src/main.ts")) throw new Error("optimizer source is missing src/main.ts");
  return files;
}

function sourceSealFromFiles(files: readonly CapturedFile[]): MetaControlSourceSeal {
  return {
    version: 1,
    files: files.map((file) => ({ path: file.path, sha256: file.sha256, mode: file.mode })),
  };
}

function validateSourceSeal(seal: MetaControlSourceSeal): void {
  if (seal.version !== 1 || seal.files.length === 0 || seal.files.length > MAX_CONTROL_ENTRIES) throw new Error("invalid control source seal");
  let previous = "";
  for (const file of seal.files) {
    validateRelativeFilePath(file.path);
    if (file.path <= previous) throw new Error("control source seal paths must be unique and sorted");
    if (!SHA256_PATTERN.test(file.sha256)) throw new Error(`invalid source hash for ${file.path}`);
    if (file.mode !== 0o644 && file.mode !== 0o755) throw new Error(`invalid canonical mode for ${file.path}`);
    previous = file.path;
  }
}

function assertMatchesSeal(files: readonly CapturedFile[], seal: MetaControlSourceSeal): void {
  validateSourceSeal(seal);
  if (files.length !== seal.files.length) throw new Error(`optimizer source file set drift: expected ${seal.files.length}, got ${files.length}`);
  for (let index = 0; index < files.length; index += 1) {
    const actual = files[index];
    const expected = seal.files[index];
    if (actual === undefined || expected === undefined) throw new Error("optimizer source file set drift");
    if (actual.path !== expected.path || actual.sha256 !== expected.sha256 || actual.mode !== expected.mode) {
      throw new Error(`optimizer source drift at ${expected.path}: expected ${expected.sha256}/${expected.mode.toString(8)}, got ${actual.path} ${actual.sha256}/${actual.mode.toString(8)}`);
    }
  }
}

function replaceExactlyOnce(source: string, before: string, after: string, file: string): string {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`degraded control transform anchor is not unique in ${file}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function transformFiles(kind: MetaControlKind, captured: readonly CapturedFile[]): { files: CapturedFile[]; changes: MetaControlTransformation[] } {
  const replacements = new Map<string, Buffer>();
  if (kind === "broken") {
    replacements.set("src/main.ts", Buffer.from(BROKEN_MAIN, "utf8"));
  } else {
    const loop = captured.find((file) => file.path === "src/loop.ts");
    const context = captured.find((file) => file.path === "assets/context.ts");
    const policy = captured.find((file) => file.path === "assets/policy.ts");
    if (loop === undefined || context === undefined || policy === undefined) {
      throw new Error("degraded control requires src/loop.ts, assets/context.ts, and assets/policy.ts");
    }
    replacements.set(
      loop.path,
      Buffer.from(replaceExactlyOnce(loop.bytes.toString("utf8"), DEGRADED_RESTART_BEFORE, DEGRADED_RESTART_AFTER, loop.path), "utf8"),
    );
    replacements.set(
      context.path,
      Buffer.from(replaceExactlyOnce(context.bytes.toString("utf8"), DEGRADED_EVALUATION_BEFORE, DEGRADED_EVALUATION_AFTER, context.path), "utf8"),
    );
    replacements.set(
      policy.path,
      Buffer.from(replaceExactlyOnce(policy.bytes.toString("utf8"), DEGRADED_REPAIR_BEFORE, DEGRADED_REPAIR_AFTER, policy.path), "utf8"),
    );
  }
  const changes: MetaControlTransformation[] = [];
  const files = captured.map((file): CapturedFile => {
    const replacement = replacements.get(file.path);
    if (replacement === undefined) return file;
    const afterSha256 = sha256(replacement);
    if (afterSha256 === file.sha256) throw new Error(`control transform did not change ${file.path}`);
    changes.push({ path: file.path, beforeSha256: file.sha256, afterSha256, mode: file.mode });
    return { ...file, bytes: replacement, sha256: afterSha256 };
  });
  if (changes.length !== replacements.size) throw new Error("control transform target was missing");
  if (changes.some((change) => !change.path.startsWith("src/") && !change.path.startsWith("assets/"))) {
    throw new Error("control transform escaped the mutable source surface");
  }
  return { files, changes };
}

function splitUstarPath(entryPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(entryPath) <= 100) return { name: entryPath, prefix: "" };
  for (let index = entryPath.indexOf("/"); index !== -1; index = entryPath.indexOf("/", index + 1)) {
    const prefix = entryPath.slice(0, index);
    const name = entryPath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`control artifact path does not fit ustar: ${entryPath}`);
}

function ustarHeader(entryPath: string, kind: "file" | "dir", size: number, mode: CanonicalFileMode | 0o755): Buffer {
  const header = Buffer.alloc(BLOCK_BYTES);
  const tarPath = kind === "dir" ? `${entryPath}/` : entryPath;
  const { name, prefix } = splitUstarPath(tarPath);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write(kind === "dir" ? "5" : "0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  if (prefix.length > 0) header.write(prefix, 345, 155, "utf8");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
}

function packCanonicalCandidate(files: readonly CapturedFile[]): Buffer {
  const directories = new Set<string>(["workspace"]);
  for (const file of files) {
    const segments = file.path.split("/");
    for (let count = 1; count < segments.length; count += 1) directories.add(`workspace/${segments.slice(0, count).join("/")}`);
  }
  const entries: Array<{ path: string; kind: "file" | "dir"; file?: CapturedFile }> = [];
  for (const directory of directories) entries.push({ path: directory, kind: "dir" });
  for (const file of files) entries.push({ path: `workspace/${file.path}`, kind: "file", file });
  if (entries.length > MAX_CONTROL_ENTRIES) throw new Error(`control artifact exceeds ${MAX_CONTROL_ENTRIES} entries`);
  entries.sort((a, b) => {
    if (a.path === "workspace") return -1;
    if (b.path === "workspace") return 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.kind === "dir") {
      parts.push(ustarHeader(entry.path, "dir", 0, 0o755));
      continue;
    }
    const file = entry.file;
    if (file === undefined) throw new Error("internal control artifact entry error");
    parts.push(ustarHeader(entry.path, "file", file.bytes.length, file.mode), file.bytes);
    const padding = (BLOCK_BYTES - (file.bytes.length % BLOCK_BYTES)) % BLOCK_BYTES;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK_BYTES * 2));
  const archive = Buffer.concat(parts);
  if (archive.length > MAX_CONTROL_ARCHIVE_BYTES) throw new Error("control artifact exceeds archive byte limit");
  return archive;
}

/** Capture the immutable source-hash registration input before a campaign is opened. */
export async function captureMetaControlSourceSeal(optimizerDir: string): Promise<MetaControlSourceSeal> {
  return sourceSealFromFiles(await captureSourceFiles(optimizerDir));
}

async function buildMetaControl(kind: MetaControlKind, optimizerDir: string, expectedSource: MetaControlSourceSeal): Promise<MetaControlArtifact> {
  const captured = await captureSourceFiles(optimizerDir);
  assertMatchesSeal(captured, expectedSource);
  const { files, changes } = transformFiles(kind, captured);
  const bytes = packCanonicalCandidate(files);
  const digest = sha256(bytes);
  const canonicalSeal: MetaControlSourceSeal = {
    version: 1,
    files: expectedSource.files.map((file) => ({ path: file.path, sha256: file.sha256, mode: file.mode })),
  };
  const sourceSealHash = sha256(Buffer.from(JSON.stringify(canonicalSeal), "utf8"));
  const transformation = kind === "broken" ? "broken-no-candidate-v1" : "degraded-blind-restart-v1";
  return {
    bytes,
    digest,
    receipt: {
      version: 1,
      kind,
      transformation,
      sourceSealHash,
      artifactDigest: digest,
      files: files.length,
      transformedFiles: changes,
    },
  };
}

/** Build the runnable control that completes with the baseline and evaluates no candidate. */
export async function buildBrokenMetaControl(optimizerDir: string, expectedSource: MetaControlSourceSeal): Promise<MetaControlArtifact> {
  return buildMetaControl("broken", optimizerDir, expectedSource);
}

/** Build the runnable blind/restart control that discards feedback and incumbent history. */
export async function buildDegradedMetaControl(optimizerDir: string, expectedSource: MetaControlSourceSeal): Promise<MetaControlArtifact> {
  return buildMetaControl("degraded", optimizerDir, expectedSource);
}
