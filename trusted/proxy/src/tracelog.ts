import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DEFAULT_DURABLE_IO, dirSyncTargets, writeAll, type DurableIo } from "./durable-io.js";

/**
 * Power-loss-durable, strictly ordered NDJSON append log.
 *
 * INVARIANTS:
 * - `append(line)` resolves only after the COMPLETE line (with trailing
 *   newline) has been written — short writes are looped — and fsynced.
 * - The first append additionally fsyncs every directory whose entry was
 *   created on the way (each created ancestor's parent, plus the log file's
 *   own directory), so the file itself survives power loss.
 * - First open recovers a torn tail from a PREVIOUS crash: an unterminated
 *   final fragment is truncated back to the last newline (fsynced) before
 *   any new append — a new line is never concatenated behind a torn tail.
 * - Appends are serialized through an internal queue: concurrent callers can
 *   never interleave bytes, and lines land in call order.
 * - Any write/fsync/open failure permanently poisons the log: the failing
 *   append rejects AND every later append rejects immediately (fail closed).
 *   A torn tail line may exist on disk after such a failure; no append ever
 *   resolves for it.
 * - `close()` drains queued appends, then closes the handle. Appends issued
 *   after `close()` reject. If the log was EVER poisoned, `close()` rejects
 *   with the stored poison (idempotently — every call observes the same
 *   rejection), so an owner can never report a clean shutdown over a corpus
 *   whose authority failed. Idempotent.
 */
export class DurableLineLog {
  private readonly filePath: string;
  private readonly io: DurableIo;
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private poison: Error | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(filePath: string, io?: Partial<DurableIo>) {
    this.filePath = resolve(filePath);
    this.io = { ...DEFAULT_DURABLE_IO, ...io };
  }

  /**
   * Externally poison the log — first error wins, later calls are no-ops.
   * Used when a publication step OUTSIDE the log (e.g. CAS content for the
   * line about to be appended) fails: the corpus authority is then failed,
   * every later append rejects, and `close()` rejects.
   */
  fail(err: Error): void {
    this.poison ??= err;
  }

  /** The stored poison, if the log has ever failed. */
  get poisoned(): Error | undefined {
    return this.poison;
  }

  /**
   * Durably append one line (a trailing newline is added). Resolution means
   * the line is complete, ordered after every earlier append, and fsynced.
   */
  append(line: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("trace log is closed"));
    if (this.poison !== undefined) return Promise.reject(this.poisonedError());
    const run = this.queue.then(() => this.doAppend(line));
    // The queue itself must never carry a rejection: each entry's failure is
    // delivered to ITS caller; later entries observe it via `poison`.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Drain queued appends and close the handle, then reject with the stored
   * poison if any append ever failed (fail closed: a poisoned log has no
   * clean shutdown). New appends reject. Idempotent — repeated calls return
   * the same settled promise.
   */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      // Every append chained before this point is inside `queue`; poisoned
      // entries settle (rejections are routed to their callers, not here).
      await this.queue;
      const handle = this.handle;
      this.handle = undefined;
      if (handle !== undefined) await handle.close().catch(() => undefined);
      // Checked AFTER the drain so a failure inside a queued append (or the
      // drain itself) is also surfaced to the closer.
      if (this.poison !== undefined) throw this.poisonedError();
    })();
    return this.closePromise;
  }

  private poisonedError(): Error {
    return new Error(`trace log poisoned by earlier failure: ${this.poison?.message ?? "unknown"}`, {
      cause: this.poison,
    });
  }

  private async doAppend(line: string): Promise<void> {
    // A failure while this entry was queued poisons it too — never write
    // after the log has lost its ordering/durability guarantee.
    if (this.poison !== undefined) throw this.poisonedError();
    try {
      const handle = await this.ensureOpen();
      await writeAll(this.io, handle, Buffer.from(line.endsWith("\n") ? line : `${line}\n`, "utf8"));
      await this.io.syncFile(handle);
    } catch (err) {
      this.poison = err instanceof Error ? err : new Error(String(err));
      throw this.poison;
    }
  }

  /**
   * First-use open: create the directory chain, open the file for append,
   * recover any torn tail a previous crash left behind, then fsync every
   * directory that gained a new entry. The log's own directory AND its
   * parent are synced UNCONDITIONALLY: a preexisting run dir may be a
   * merely-visible leftover of a crashed process whose chain fsyncs never
   * completed, and its durability must never be assumed.
   */
  private async ensureOpen(): Promise<FileHandle> {
    if (this.handle !== undefined) return this.handle;
    const dir = dirname(this.filePath);
    const firstCreated = await mkdir(dir, { recursive: true });
    // `a+`: append-only writes, but readable for the backward tail scan.
    this.handle = await open(this.filePath, "a+");
    await this.recoverTornTail(this.handle);
    const targets = new Set<string>([
      ...dirSyncTargets(dir, firstCreated === undefined ? undefined : resolve(firstCreated)),
      dirname(dir),
    ]);
    for (const p of targets) {
      await this.io.syncDir(p);
    }
    return this.handle;
  }

  /**
   * Crash recovery: a previous writer may have died mid-line, leaving an
   * unterminated final fragment. Appending behind it would concatenate the
   * torn tail with the next line FOREVER, so the tail is truncated back to
   * the last newline (or to empty when no newline exists) and the truncation
   * fsynced before any new append. Bounded backward chunk reads — the scan
   * never buffers the whole file. Fully newline-terminated files (and empty
   * or fresh files) are untouched.
   */
  private async recoverTornTail(handle: FileHandle): Promise<void> {
    const { size } = await handle.stat();
    if (size === 0) return;
    const CHUNK = 4096;
    const buf = Buffer.alloc(Math.min(CHUNK, size));
    let end = size; // exclusive upper bound of the unscanned region
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const want = end - start;
      const { bytesRead } = await handle.read(buf, 0, want, start);
      if (bytesRead !== want) {
        throw new Error(`torn-tail scan short read at ${start} (${bytesRead}/${want} bytes)`);
      }
      const idx = buf.lastIndexOf(0x0a, bytesRead - 1);
      if (idx !== -1) {
        const keep = start + idx + 1;
        if (keep === size) return; // final line is newline-terminated: no torn tail
        await handle.truncate(keep);
        await this.io.syncFile(handle);
        return;
      }
      end = start;
    }
    // No newline anywhere: the whole file is one torn fragment.
    await handle.truncate(0);
    await this.io.syncFile(handle);
  }
}
