import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * CAS layout (contract-adjacent, shared convention):
 *   <casDir>/sha256/<first2>/<fullhash>
 * A write is sha256 + rename-into-place. The LAYOUT is the contract.
 */

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function casPath(casDir: string, hash: string): string {
  if (!HASH_RE.test(hash)) throw new Error(`not a CAS hash: ${hash}`);
  const hex = hash.slice("sha256:".length);
  return join(casDir, "sha256", hex.slice(0, 2), hex);
}

export function writeCas(casDir: string, data: Buffer): string {
  const hex = sha256Hex(data);
  const hash = `sha256:${hex}`;
  const dest = casPath(casDir, hash);
  if (existsSync(dest)) return hash;
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, dest);
  return hash;
}

export function readCas(casDir: string, hash: string): Buffer {
  const p = casPath(casDir, hash);
  if (!existsSync(p)) throw new Error(`artifact ${hash} not found in CAS (${p})`);
  return readFileSync(p);
}

/** Unpack an artifact tar from CAS into destDir (created if missing). */
export function extractArtifact(casDir: string, hash: string, destDir: string): void {
  const blob = casPath(casDir, hash);
  if (!existsSync(blob)) throw new Error(`artifact ${hash} not found in CAS (${blob})`);
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("tar", ["-xf", blob, "-C", destDir], { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`tar extract of ${hash} failed: ${r.stderr.trim()}`);
}
