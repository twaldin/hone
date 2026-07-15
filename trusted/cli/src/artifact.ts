import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { casPath } from "./cas.js";

/**
 * Trusted-side artifact layout validation for delivery (security review:
 * "Validate artifact tar layout before extraction", "Strip the artifact
 * workspace root during delivery", "Reject Git metadata").
 *
 * Broker artifacts are tars whose every entry lives under a single
 * `workspace/` root (trusted/broker/src/artifact.ts). Anything else — and any
 * entry type other than a plain file or directory — is adversarial input and
 * is rejected BEFORE tar ever touches a filesystem. The headers are parsed
 * here directly (ustar + pax `x` + GNU `L` longname) rather than trusting a
 * host tar listing.
 */

export class ArtifactLayoutError extends Error {}

const BLOCK = 512;

export interface TarEntry {
  name: string;
  /** Normalized typeflag: "0" file, "5" dir, others as-is. */
  type: string;
}

function cstr(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function parseOctal(buf: Buffer, what: string): number {
  const first = buf[0];
  if (first !== undefined && (first & 0x80) !== 0) {
    throw new ArtifactLayoutError(`artifact tar uses base-256 ${what} encoding — rejected`);
  }
  const text = cstr(buf, 0, buf.length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) throw new ArtifactLayoutError(`artifact tar has an invalid ${what} field`);
  return value;
}

/**
 * Parse pax extended-header records: repeated "<len> key=value\n" where
 * <len> counts BYTES of the whole record. Values may be raw binary (e.g.
 * SCHILY.xattr.*), so framing walks the raw buffer; each record is decoded
 * to UTF-8 individually only after its byte boundaries are known.
 */
function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let off = 0;
  while (off < data.length) {
    if (data[off] === 0) break; // padding
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const len = Number.parseInt(data.subarray(off, space).toString("latin1"), 10);
    if (!Number.isFinite(len) || len <= 0 || off + len > data.length) {
      throw new ArtifactLayoutError("artifact tar has a malformed pax record");
    }
    if (data[off + len - 1] !== 0x0a) throw new ArtifactLayoutError("artifact tar has a malformed pax record");
    const kv = data.subarray(space + 1, off + len - 1).toString("utf8");
    const eq = kv.indexOf("=");
    if (eq === -1) throw new ArtifactLayoutError("artifact tar has a malformed pax record");
    records.set(kv.slice(0, eq), kv.slice(eq + 1));
    off += len;
  }
  return records;
}

/** Walk every entry header (no extraction). Throws ArtifactLayoutError on malformed input. */
export function listTarEntries(blob: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let overrideName: string | null = null;
  while (off + BLOCK <= blob.length) {
    const header = blob.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const rawName = cstr(header, 0, 100);
    const size = parseOctal(header.subarray(124, 136), "size");
    const typeByte = header[156] ?? 0;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const magic = cstr(header, 257, 6);
    const prefix = magic.startsWith("ustar") ? cstr(header, 345, 155) : "";
    const dataStart = off + BLOCK;
    const data = blob.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x") {
      const records = parsePaxRecords(data);
      if (records.has("linkpath")) throw new ArtifactLayoutError("artifact tar carries a pax linkpath override — link entries are rejected");
      const path = records.get("path");
      if (path !== undefined) overrideName = path;
      continue;
    }
    if (type === "g") {
      const records = parsePaxRecords(data);
      if (records.has("path") || records.has("linkpath")) {
        throw new ArtifactLayoutError("artifact tar carries global pax path overrides — rejected");
      }
      continue;
    }
    if (type === "L") {
      // GNU longname: data is the (NUL-terminated) name of the NEXT entry.
      overrideName = cstr(data, 0, data.length);
      continue;
    }
    if (type === "K") throw new ArtifactLayoutError("artifact tar carries a GNU long linkname — link entries are rejected");

    const name = overrideName ?? (prefix !== "" ? `${prefix}/${rawName}` : rawName);
    overrideName = null;
    entries.push({ name, type });
  }
  return entries;
}

const TYPE_LABEL: Record<string, string> = {
  "1": "hardlink",
  "2": "symlink",
  "3": "character device",
  "4": "block device",
  "6": "fifo",
  "7": "contiguous file",
};

/**
 * Enforce the delivery layout contract:
 *  - only plain files and directories;
 *  - every entry under exactly one `workspace/` root;
 *  - no absolute paths, no `..` traversal;
 *  - no `.git` component anywhere (any case — macOS is case-insensitive).
 */
export function validateWorkspaceTar(blob: Buffer): void {
  const entries = listTarEntries(blob);
  if (entries.length === 0) throw new ArtifactLayoutError("artifact tar is empty");
  for (const entry of entries) {
    if (entry.type !== "0" && entry.type !== "5") {
      const label = TYPE_LABEL[entry.type] ?? `typeflag '${entry.type}'`;
      throw new ArtifactLayoutError(`artifact tar entry ${JSON.stringify(entry.name)} is a ${label} — only plain files and directories are deliverable`);
    }
    if (entry.name.startsWith("/")) {
      throw new ArtifactLayoutError(`artifact tar entry ${JSON.stringify(entry.name)} is an absolute path — rejected`);
    }
    const components = entry.name.split("/").filter((c) => c !== "" && c !== ".");
    if (components.some((c) => c === "..")) {
      throw new ArtifactLayoutError(`artifact tar entry ${JSON.stringify(entry.name)} contains '..' traversal — rejected`);
    }
    if (components.some((c) => c.toLowerCase() === ".git")) {
      throw new ArtifactLayoutError(`artifact tar entry ${JSON.stringify(entry.name)} contains a .git component — rejected`);
    }
    const rootComponent = components[0];
    if (rootComponent === undefined || rootComponent !== "workspace") {
      throw new ArtifactLayoutError(`artifact tar entry ${JSON.stringify(entry.name)} is outside the single workspace/ root — rejected`);
    }
    if (components.length === 1 && entry.type !== "5") {
      throw new ArtifactLayoutError("artifact tar has a non-directory 'workspace' root entry — rejected");
    }
  }
}

/**
 * Validate then unpack an artifact from CAS into destDir with the single
 * `workspace/` component stripped: files land at destDir root. The blob is
 * fully validated first, so extraction never processes links, traversal, or
 * git metadata.
 */
export function extractWorkspaceArtifact(casDir: string, hash: string, destDir: string): void {
  const blobPath = casPath(casDir, hash);
  if (!existsSync(blobPath)) throw new Error(`artifact ${hash} not found in CAS (${blobPath})`);
  validateWorkspaceTar(readFileSync(blobPath));
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("tar", ["-x", "--strip-components", "1", "-f", blobPath, "-C", destDir], { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`tar extract of ${hash} failed: ${r.stderr.trim()}`);
}
