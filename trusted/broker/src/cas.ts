import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deferred } from "./deferred.js";

/**
 * Content-addressed store. Layout is contract-adjacent and shared repo-wide:
 *   <root>/sha256/<first2>/<fullhash>
 * A write is: hash → write sibling temp file → rename into place (atomic on
 * one filesystem; concurrent writers of the same content converge).
 */
export class CasStore {
  constructor(readonly rootDir: string) {}

  blobPath(hash: string): string {
    const hex = hexOf(hash);
    return path.join(this.rootDir, "sha256", hex.slice(0, 2), hex);
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.blobPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async putBuffer(content: Buffer): Promise<string> {
    const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const dest = this.blobPath(hash);
    if (await this.has(hash)) return hash;
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${randomUUID()}`;
    await writeFile(tmp, content);
    await rename(tmp, dest);
    return hash;
  }

  /** Streams `srcPath` through sha256, then copies it into place. */
  async putFile(srcPath: string): Promise<string> {
    const hasher = createHash("sha256");
    const { promise, resolve, reject } = deferred<void>();
    const stream = createReadStream(srcPath);
    stream.on("data", (chunk) => hasher.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
    await promise;
    const hash = `sha256:${hasher.digest("hex")}`;
    const dest = this.blobPath(hash);
    if (await this.has(hash)) return hash;
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${randomUUID()}`;
    await writeFile(tmp, await readFile(srcPath));
    await rename(tmp, dest);
    return hash;
  }

  async readBuffer(hash: string): Promise<Buffer> {
    return readFile(this.blobPath(hash));
  }

  /**
   * Key→hash index for the evaluate memo, stored beside the blob tree under
   * <root>/index/<namespace>/<sha256(key)>. Values are CAS hashes, so the
   * index is a pointer table over content-addressed records.
   */
  private indexPath(namespace: string, key: string): string {
    const keyHex = createHash("sha256").update(key).digest("hex");
    return path.join(this.rootDir, "index", namespace, keyHex);
  }

  async indexGet(namespace: string, key: string): Promise<string | undefined> {
    try {
      return (await readFile(this.indexPath(namespace, key))).toString("utf8").trim();
    } catch {
      return undefined;
    }
  }

  async indexPut(namespace: string, key: string, hash: string): Promise<void> {
    const dest = this.indexPath(namespace, key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${randomUUID()}`;
    await writeFile(tmp, hash);
    await rename(tmp, dest);
  }
}

function hexOf(hash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`malformed CAS hash: ${hash}`);
  return hash.slice("sha256:".length);
}

export async function removeIfExists(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true });
}
