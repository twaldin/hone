import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Power-loss-ordered publication primitives. A CAS hash handed back to a
 * caller is a durable promise — callers journal references to it immediately,
 * so the blob must survive a crash the instant the returned promise resolves:
 * fsync temp contents → atomic rename → fsync parent directory. Grouped in a
 * mutable object so focused tests can observe/instrument the exact ordering.
 */
export const durability = {
  /** Write `content` to a fresh temp path and fsync it before close. */
  async writeFileSynced(tmpPath: string, content: Buffer | string): Promise<void> {
    const fh = await open(tmpPath, "wx", 0o644);
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  /** Publish the fsynced temp file at its final name (atomic on one filesystem). */
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  },
  /** fsync an existing file (dedup hit: content may predate this process). */
  async syncFile(filePath: string): Promise<void> {
    const fh = await open(filePath, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  /** fsync a directory so the rename that published an entry survives power loss. */
  async syncDir(dir: string): Promise<void> {
    const fh = await open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
};

/**
 * Every directory level from `dir` through the PARENT of `rootDir`, leaf
 * first. `mkdir recursive` may have created ANY of these levels, and a level
 * is only durable once its parent's entry for it is fsynced — so publication
 * syncs the whole chain, unconditionally (also repairs a concurrent creator
 * that crashed mid-chain). Syncing the store root's parent persists a newly
 * created `.hone-cas` entry before a journal can reference its contents.
 */
function dirChain(rootDir: string, dir: string): string[] {
  const stop = path.resolve(rootDir);
  const chain: string[] = [];
  let current = path.resolve(dir);
  while (true) {
    chain.push(current);
    if (current === stop) {
      const parent = path.dirname(current);
      if (parent !== current) chain.push(parent);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`CAS path ${dir} escapes store root ${rootDir}`);
    current = parent;
  }
  return chain;
}

/** fsync(temp) → rename → fsync each dir level through the store root's parent; resolves only once `dest` is durable. */
async function publishDurable(rootDir: string, dest: string, content: Buffer | string): Promise<void> {
  const dir = path.dirname(dest);
  await mkdir(dir, { recursive: true });
  const tmp = `${dest}.tmp-${randomUUID()}`;
  try {
    await durability.writeFileSynced(tmp, content);
    await durability.rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  for (const level of dirChain(rootDir, dir)) await durability.syncDir(level);
}

/**
 * Dedup hit: the visible blob may have been renamed into place by a writer
 * that crashed before its fsyncs, so durability of the bytes AND of every
 * directory level must be (re-)established before the caller may journal a
 * reference to it.
 */
async function ensureDurable(rootDir: string, dest: string): Promise<void> {
  await durability.syncFile(dest);
  for (const level of dirChain(rootDir, path.dirname(dest))) await durability.syncDir(level);
}

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
    if (await this.has(hash)) {
      await ensureDurable(this.rootDir, dest);
      return hash;
    }
    await publishDurable(this.rootDir, dest, content);
    return hash;
  }

  /**
   * Single read: the bytes that are hashed ARE the bytes that are published
   * (a source file mutated mid-put can never publish content under another
   * content's hash).
   */
  async putFile(srcPath: string): Promise<string> {
    return this.putBuffer(await readFile(srcPath));
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
    await publishDurable(this.rootDir, this.indexPath(namespace, key), hash);
  }
}

function hexOf(hash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error(`malformed CAS hash: ${hash}`);
  return hash.slice("sha256:".length);
}

export async function removeIfExists(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true });
}
