/**
 * Validating tar parser for artifact archives (broker-local, wire-adjacent).
 *
 * An artifact is a tar rooted at exactly one real `workspace/` directory —
 * what `docker cp <c>:/workspace -` emits and what `packDirAsArtifact`
 * produces. Because these bytes come from ADVERSARIAL sandboxes, the archive
 * is validated structurally before it is ever accepted into CAS or handed to
 * a tar binary for extraction:
 *
 *   - exactly one top-level root, the directory entry `workspace`
 *   - no absolute paths, no `..` segments, no NUL bytes, no backslashes,
 *     no `.`/empty segments (a single leading `./` and the trailing `/` on
 *     directory names are normalized away — everything else is ambiguous)
 *   - no symlinks, hardlinks, devices, FIFOs, sockets, or sparse files —
 *     regular files and directories only, so no extracted path can
 *     dereference outside the destination
 *   - no `.git` path segment anywhere (case-insensitive): gitlink/hook
 *     smuggling into delivery worktrees is rejected at the boundary
 *   - no duplicate entries and no file/directory type conflicts
 *   - PAX (`x`) per-entry headers and GNU longnames (`L`) are understood so
 *     overrides cannot smuggle a second, unvalidated name; PAX globals (`g`),
 *     GNU longlinks (`K`), and sparse markers are rejected outright
 *
 * Deliberately dependency-free: this is trusted-kernel code and must be
 * auditable at a glance (same rule as glob.ts).
 */

const BLOCK = 512;
/** Sanity cap on PAX / GNU-longname metadata payloads. */
const MAX_META_BYTES = 1024 * 1024;

export type ArtifactEntryKind = "file" | "dir";

export interface ArtifactTarEntry {
  /** Normalized relative path, e.g. `workspace/src/main.ts`. */
  path: string;
  kind: ArtifactEntryKind;
  /** Payload bytes (always 0 for directories). */
  size: number;
}

export class ArtifactValidationError extends Error {
  constructor(
    readonly reason: string,
    readonly entryName?: string,
  ) {
    super(
      entryName === undefined
        ? `invalid artifact archive: ${reason}`
        : `invalid artifact archive: ${reason} (entry ${JSON.stringify(entryName)})`,
    );
    this.name = "ArtifactValidationError";
  }
}

function fail(reason: string, entryName?: string): never {
  throw new ArtifactValidationError(reason, entryName);
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/** NUL-terminated string field. */
function cString(block: Buffer, off: number, len: number): string {
  let end = off;
  while (end < off + len && block[end] !== 0) end++;
  return block.subarray(off, end).toString("utf8");
}

/** `workspace/a/b` → `workspace/a`; `workspace` → `""`. */
function parentOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx < 0 ? "" : p.slice(0, idx);
}

/** Octal numeric field; GNU base-256 (high bit set) supported for size. */
function numericField(block: Buffer, off: number, len: number, what: string): number {
  const first = block[off]!;
  if ((first & 0x80) !== 0) {
    let v = first & 0x7f;
    for (let i = 1; i < len; i++) {
      v = v * 256 + block[off + i]!;
      if (!Number.isSafeInteger(v)) fail(`${what} field overflows`);
    }
    return v;
  }
  const text = cString(block, off, len).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) fail(`malformed octal ${what} field`);
  const v = parseInt(text, 8);
  if (!Number.isSafeInteger(v)) fail(`${what} field overflows`);
  return v;
}

function verifyChecksum(header: Buffer): void {
  const stored = numericField(header, 148, 8, "checksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  if (sum !== stored) fail("header checksum mismatch");
}

/** PAX extended header body: repeated `<len> <key>=<value>\n` records. */
function parsePaxRecords(content: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let off = 0;
  while (off < content.length) {
    const sp = content.indexOf(0x20, off);
    if (sp < 0) fail("malformed pax record: missing length delimiter");
    const lenText = content.subarray(off, sp).toString("latin1");
    if (!/^[0-9]+$/.test(lenText)) fail("malformed pax record: bad length");
    const len = parseInt(lenText, 10);
    if (len < sp - off + 3 || off + len > content.length) fail("malformed pax record: length out of range");
    if (content[off + len - 1] !== 0x0a) fail("malformed pax record: missing newline");
    const body = content.subarray(sp + 1, off + len - 1).toString("utf8");
    const eq = body.indexOf("=");
    if (eq < 0) fail("malformed pax record: missing '='");
    const key = body.slice(0, eq);
    if (out.has(key)) fail(`duplicate pax key: ${key}`);
    out.set(key, body.slice(eq + 1));
    off += len;
  }
  return out;
}

/**
 * Normalizes and validates one entry path. Returns the canonical relative
 * path (`workspace` or `workspace/...`) or throws.
 */
function normalizeEntryPath(raw: string, kind: ArtifactEntryKind): string {
  const original = raw;
  if (raw.includes("\0")) fail("entry name contains NUL", original);
  if (raw.includes("\\")) fail("entry name contains backslash", original);
  if (raw.startsWith("/")) fail("absolute entry path", original);
  if (raw.startsWith("./")) raw = raw.slice(2); // benign producer prefix
  if (raw.endsWith("/")) {
    if (kind !== "dir") fail("file entry named like a directory", original);
    raw = raw.slice(0, -1);
  }
  if (raw === "") fail("empty entry name", original);
  const segments = raw.split("/");
  for (const seg of segments) {
    if (seg === "") fail("empty path segment", original);
    if (seg === ".") fail("'.' path segment", original);
    if (seg === "..") fail("'..' path segment", original);
    if (seg.toLowerCase() === ".git") fail(".git is not allowed in artifacts", original);
  }
  if (segments[0] !== "workspace") fail("entry outside the workspace/ root", original);
  return segments.join("/");
}

const TYPEFLAG_REJECT: Record<string, string> = {
  "1": "hardlink entries are not allowed",
  "2": "symlink entries are not allowed",
  "3": "character-device entries are not allowed",
  "4": "block-device entries are not allowed",
  "6": "FIFO entries are not allowed",
  "7": "contiguous-file entries are not allowed",
  S: "GNU sparse entries are not allowed",
  K: "GNU longlink entries are not allowed",
  g: "pax global headers are not allowed",
};

/**
 * Validates `bytes` as a workspace artifact tar. Returns the normalized entry
 * list on success; throws ArtifactValidationError on ANY structural or safety
 * violation. Call this on raw tar bytes BEFORE storing them in CAS and before
 * handing any CAS blob to `tar -x`.
 */
export function validateWorkspaceTar(bytes: Buffer): ArtifactTarEntry[] {
  if (bytes.length === 0) fail("empty archive");
  if (bytes.length % BLOCK !== 0) fail("archive length is not a multiple of 512");

  const entries: ArtifactTarEntry[] = [];
  const explicit = new Map<string, ArtifactEntryKind>();
  const impliedDirs = new Set<string>();
  let pendingPax: Map<string, string> | null = null;
  let pendingLongName: string | null = null;
  let sawEnd = false;
  let off = 0;

  while (off < bytes.length) {
    const header = bytes.subarray(off, off + BLOCK);
    if (isZeroBlock(header)) {
      for (let o = off + BLOCK; o < bytes.length; o += BLOCK) {
        if (!isZeroBlock(bytes.subarray(o, o + BLOCK))) fail("data after end-of-archive marker");
      }
      sawEnd = true;
      break;
    }
    const magic = header.subarray(257, 262).toString("latin1");
    if (magic !== "ustar") fail("unsupported tar format (missing ustar magic)");
    verifyChecksum(header);

    const typeByte = header[156]!;
    const typeflag = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    let size = numericField(header, 124, 12, "size");
    const dataStart = off + BLOCK;
    const paddedSize = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + paddedSize > bytes.length) fail("truncated archive: entry data exceeds archive length");
    const content = bytes.subarray(dataStart, dataStart + size);
    off = dataStart + paddedSize;

    const reject = TYPEFLAG_REJECT[typeflag];
    if (reject !== undefined) fail(reject, cString(header, 0, 100));

    if (typeflag === "x" || typeflag === "L") {
      if (size === 0 || size > MAX_META_BYTES) fail(`unreasonable ${typeflag === "x" ? "pax" : "longname"} metadata size`);
      if (typeflag === "x") {
        if (pendingPax !== null) fail("consecutive pax headers");
        pendingPax = parsePaxRecords(content);
        if (pendingPax.has("linkpath")) fail("pax linkpath override is not allowed");
        for (const key of pendingPax.keys()) {
          if (key.startsWith("GNU.sparse")) fail("GNU sparse pax entries are not allowed");
        }
      } else {
        if (pendingLongName !== null) fail("consecutive GNU longname headers");
        let end = content.length;
        while (end > 0 && content[end - 1] === 0) end--;
        pendingLongName = content.subarray(0, end).toString("utf8");
      }
      continue;
    }

    if (typeflag !== "0" && typeflag !== "5") fail(`unsupported entry type '${typeflag}'`, cString(header, 0, 100));
    const kind: ArtifactEntryKind = typeflag === "5" ? "dir" : "file";

    // Resolve the entry name: header name (+ustar prefix), overridden by
    // exactly one of GNU longname or pax `path`.
    let name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    if (prefix !== "") name = `${prefix}/${name}`;
    const paxPath = pendingPax?.get("path");
    if (pendingLongName !== null && paxPath !== undefined) fail("both pax path and GNU longname present", name);
    if (pendingLongName !== null) name = pendingLongName;
    else if (paxPath !== undefined) name = paxPath;
    const paxSize = pendingPax?.get("size");
    if (paxSize !== undefined) {
      if (!/^[0-9]+$/.test(paxSize)) fail("malformed pax size override", name);
      size = parseInt(paxSize, 10);
      if (!Number.isSafeInteger(size)) fail("pax size override overflows", name);
    }
    pendingPax = null;
    pendingLongName = null;

    const p = normalizeEntryPath(name, kind);
    if (kind === "dir" && size !== 0) fail("directory entry with nonzero size", p);
    if (explicit.has(p)) fail("duplicate entry", p);
    if (kind === "file" && impliedDirs.has(p)) fail("entry is both a file and a directory", p);
    explicit.set(p, kind);
    for (let anc = parentOf(p); anc !== ""; anc = parentOf(anc)) {
      if (explicit.get(anc) === "file") fail("file entry used as a directory", anc);
      impliedDirs.add(anc);
    }
    entries.push({ path: p, kind, size: kind === "dir" ? 0 : size });
  }

  if (pendingPax !== null || pendingLongName !== null) fail("dangling metadata header at end of archive");
  if (!sawEnd) fail("missing end-of-archive marker");
  if (explicit.get("workspace") !== "dir") fail("archive must contain exactly one real workspace/ directory root");
  return entries;
}
