import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Low-level file operations the durable writers (trace log, CAS) perform,
 * injectable so tests can simulate short writes and fsync failures.
 * Production always uses DEFAULT_DURABLE_IO; nothing else should override
 * these.
 */
export interface DurableIo {
  /**
   * One write attempt of `length` bytes from `buf` starting at `offset`,
   * written at the handle's current file position. MAY write fewer bytes
   * (short write); returns the count actually written.
   */
  write(handle: FileHandle, buf: Buffer, offset: number, length: number): Promise<number>;
  /** fsync a file (contents + metadata, so the written length survives power loss). */
  syncFile(handle: FileHandle): Promise<void>;
  /** fsync a directory so a newly created/renamed entry inside it survives power loss. */
  syncDir(path: string): Promise<void>;
}

export const DEFAULT_DURABLE_IO: DurableIo = {
  async write(handle, buf, offset, length): Promise<number> {
    const { bytesWritten } = await handle.write(buf, offset, length);
    return bytesWritten;
  },
  async syncFile(handle): Promise<void> {
    await handle.sync();
  },
  async syncDir(path): Promise<void> {
    const dir = await open(path, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  },
};

/**
 * Write `buf` fully at the handle's current position, looping short writes.
 * A zero/negative/absurd progress report is a failure, never a spin.
 */
export async function writeAll(io: DurableIo, handle: FileHandle, buf: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const wrote = await io.write(handle, buf, offset, buf.length - offset);
    if (!Number.isSafeInteger(wrote) || wrote <= 0 || wrote > buf.length - offset) {
      throw new Error(`durable write made no progress (reported ${wrote} bytes)`);
    }
    offset += wrote;
  }
}

/**
 * Directories whose entries must be fsynced after `mkdir(dir, {recursive})`
 * reported `firstCreated` as the first level it created: `dir` itself (it
 * gained — or is about to gain — a new entry), each created level's parent,
 * and the pre-existing parent of `firstCreated`. `firstCreated === undefined`
 * (nothing created) yields `[dir]` only. Both paths MUST be pre-resolved
 * against the same base.
 */
export function dirSyncTargets(dir: string, firstCreated: string | undefined): string[] {
  const targets = new Set<string>([dir]);
  if (firstCreated !== undefined) {
    // The first created directory's entry lives in its (pre-existing) parent.
    targets.add(dirname(firstCreated));
    // Every created level between `firstCreated` and `dir` is an entry in ITS parent.
    let d = dir;
    while (d !== firstCreated) {
      const parent = dirname(d);
      targets.add(parent);
      if (parent === d) break; // filesystem root; defensive
      d = parent;
    }
  }
  return [...targets];
}
