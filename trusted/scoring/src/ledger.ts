import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * Holdout query ledger (review IV.2, Dwork adaptive-validity argument):
 * a file-backed monotonic counter with a HARD lifetime budget, safe across
 * CONCURRENT broker processes without a lock file.
 *
 * Authority = lock-free append order (v2). Every charge appends exactly one
 * unique nonce+timestamp line through an O_APPEND handle, fsyncs it, then
 * rereads the file and locates its OWN line's ordinal among the attempt
 * lines. O_APPEND makes concurrent appends land at distinct offsets, so the
 * file's line order is a total order over attempts shared by every handle
 * and process:
 *
 *   - ordinal <= budget  -> the charge is GRANTED with count = ordinal.
 *   - ordinal >  budget  -> the charge is DENIED; the appended line REMAINS
 *                           on disk as a durable denial record (attempts are
 *                           never erased), so the boundary slot can never be
 *                           granted twice — not even by two processes racing
 *                           the final slot through independent handles.
 *
 * The charge line is durable BEFORE the grant decision (write-ahead), so a
 * crash never under-counts: a full-but-unacknowledged line conservatively
 * consumes capacity. Reported state clamps the successful count at the
 * budget.
 *
 * Fail-closed: malformed UTF-8, malformed JSON, a duplicate nonce, a missing
 * own line after a durable append, and any non-newline-terminated (torn)
 * bytes — interior or tail — all REFUSE rather than guess. A torn tail means
 * some write never completed; the ledger never silently reinterprets it.
 */

const Header = z.object({ v: z.literal(2), budget: z.number().int().positive() }).strict();
const AttemptLine = z.object({ nonce: z.string().min(1), at: z.string() }).strict();

export class HoldoutBudgetExceededError extends Error {
  readonly count: number;
  readonly budget: number;

  constructor(count: number, budget: number) {
    super(`holdout budget exhausted: ${count}/${budget} lifetime queries already charged — refusing`);
    this.name = "HoldoutBudgetExceededError";
    this.count = count;
    this.budget = budget;
  }
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function decodeStrict(raw: Buffer, path: string): string {
  try {
    return utf8Strict.decode(raw);
  } catch {
    throw new Error(`holdout ledger ${path}: corrupt — not valid UTF-8`);
  }
}

/**
 * Parse the full ledger text: header, then attempt lines in append order.
 * Only complete newline-terminated lines are legal; ANY torn bytes fail
 * closed. Duplicate nonces fail closed — nonces are what let a charge find
 * its own ordinal, so a duplicate would make the grant decision ambiguous.
 */
function parseLedger(text: string, path: string, expectedBudget?: number): { budget: number; nonces: string[] } {
  if (!text.endsWith("\n")) {
    throw new Error(`holdout ledger ${path}: corrupt — torn (non-newline-terminated) trailing bytes; refusing`);
  }
  const lines = text.split("\n");
  lines.pop(); // trailing "" from the final newline
  const headerLine = lines[0];
  if (headerLine === undefined) throw new Error(`holdout ledger ${path}: corrupt — missing header`);
  let header: z.infer<typeof Header>;
  try {
    header = Header.parse(JSON.parse(headerLine));
  } catch {
    throw new Error(`holdout ledger ${path}: corrupt header line`);
  }
  if (expectedBudget !== undefined && expectedBudget !== header.budget) {
    throw new Error(
      `holdout ledger ${path}: budget mismatch — file says ${header.budget}, caller says ${expectedBudget}; the lifetime budget is immutable`,
    );
  }
  const nonces: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    let attempt: z.infer<typeof AttemptLine>;
    try {
      attempt = AttemptLine.parse(JSON.parse(lines[i] ?? ""));
    } catch {
      throw new Error(`holdout ledger ${path}: corrupt attempt line ${i}`);
    }
    if (seen.has(attempt.nonce)) {
      throw new Error(`holdout ledger ${path}: corrupt — duplicate nonce on attempt line ${i}`);
    }
    seen.add(attempt.nonce);
    nonces.push(attempt.nonce);
  }
  return { budget: header.budget, nonces };
}

/** Append one line and fsync it; a short write is corruption, not a retry. */
async function appendLineDurable(handle: FileHandle, line: string, path: string): Promise<void> {
  const buf = Buffer.from(line, "utf8");
  const { bytesWritten } = await handle.write(buf);
  if (bytesWritten !== buf.byteLength) {
    throw new Error(`holdout ledger ${path}: short write (${bytesWritten}/${buf.byteLength} bytes) — refusing`);
  }
  await handle.sync();
}

const HEADER_STEM = '{"v":2,"budget":';

/**
 * Is `raw` a strict prefix of SOME valid v2 header line (a newline would
 * mean the header completed)? These are exactly — and only — the states the
 * LEGACY creator (`open('ax')` + in-place header write) could leave behind
 * by crashing before its header completed. Since no complete header ever
 * existed at that path, no charge can exist either, so such a file is
 * provably dead and safely repairable. Any other nonempty content is real
 * corruption and is refused.
 */
function isLegacyHeaderPrefix(raw: Buffer): boolean {
  let text: string;
  try {
    text = utf8Strict.decode(raw);
  } catch {
    return false;
  }
  if (text.includes("\n")) return false;
  if (text.length <= HEADER_STEM.length) return HEADER_STEM.startsWith(text);
  if (!text.startsWith(HEADER_STEM)) return false;
  return /^[1-9][0-9]*\}?$/.test(text.slice(HEADER_STEM.length));
}

/**
 * Complete a crashed LEGACY header in place. The file's bytes must still be
 * a strict prefix of THIS budget's exact header line; the missing suffix is
 * written at a FIXED offset, so concurrent repairers with the same budget
 * write byte-identical data and any interleaving converges on the same
 * complete header. No name is ever unlinked, renamed, or relinked here —
 * repair cannot destroy a live ledger, and crashing mid-repair just leaves
 * a longer prefix: still headerless, still dead, still repairable. A prefix
 * that cannot extend to this budget's header pins a DIFFERENT identity and
 * is refused.
 */
async function repairLegacyHeader(path: string, budget: number): Promise<void> {
  const target = Buffer.from(`${JSON.stringify({ v: 2, budget })}\n`, "utf8");
  const fh = await open(path, "r+");
  try {
    // Re-verify through THIS handle so the check and the write are bound to
    // one inode, whatever happened between the caller's read and now.
    const raw = await fh.readFile();
    if (raw.includes(0x0a)) return; // a concurrent repairer finished — the caller rereads
    if (raw.byteLength >= target.byteLength || !target.subarray(0, raw.byteLength).equals(raw)) {
      throw new Error(
        `holdout ledger ${path}: budget mismatch — crashed header prefix cannot complete to budget ${budget}; the lifetime budget is immutable`,
      );
    }
    const suffix = target.subarray(raw.byteLength);
    const { bytesWritten } = await fh.write(suffix, 0, suffix.byteLength, raw.byteLength);
    if (bytesWritten !== suffix.byteLength) {
      throw new Error(`holdout ledger ${path}: short write (${bytesWritten}/${suffix.byteLength} bytes) — refusing`);
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Durability primitives, grouped in a mutable object so focused tests can
 * observe/instrument ordering (mirrors the broker CAS `durability` seam).
 */
export const ledgerIo = {
  /** fsync an existing file (its creator may have crashed before its own fsync). */
  async syncFile(filePath: string): Promise<void> {
    const fh = await open(filePath, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  /** fsync a directory so a newly created entry (file or subdirectory) survives power loss. */
  async syncDir(dir: string): Promise<void> {
    const fh = await open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  /**
   * Atomically publish `src` at `dest` WITHOUT clobbering: link(2) fails
   * with EEXIST when `dest` already exists, on every platform — the
   * strongest portable no-clobber publication primitive. The new dirent is
   * durable only after its directory is fsynced.
   */
  async linkNoClobber(src: string, dest: string): Promise<void> {
    await link(src, dest);
  },
};

/**
 * Every directory level from `dir` through the PARENT of `durableRoot`, leaf
 * first (mirrors the broker CAS `dirChain`). `mkdir recursive` may have
 * created ANY of these levels, and a level is only durable once its parent's
 * entry for it is fsynced — so every opener syncs the whole chain,
 * unconditionally. That also repairs a concurrent creator that crashed (or is
 * still paused) mid-chain: an O_EXCL loser that observes a complete header
 * must NOT trust the winner to have persisted the directory entries.
 */
function dirChain(durableRoot: string, dir: string): string[] {
  const stop = resolve(durableRoot);
  const chain: string[] = [];
  let current = resolve(dir);
  while (true) {
    chain.push(current);
    if (current === stop) {
      const parent = dirname(current);
      if (parent !== current) chain.push(parent);
      break;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`holdout ledger dir ${dir} escapes durable root ${durableRoot}`);
    current = parent;
  }
  return chain;
}

export class HoldoutLedger {
  readonly path: string;
  #handle: FileHandle;
  /** Attempt lines this instance has OBSERVED on disk — never higher than reality, never decreases. */
  #attempts: number;
  #budget: number;
  /** Tail of the charge queue — this instance's charge() calls run strictly one at a time. */
  #chain: Promise<unknown> = Promise.resolve();

  private constructor(path: string, handle: FileHandle, attempts: number, budget: number) {
    this.path = path;
    this.#handle = handle;
    this.#attempts = attempts;
    this.#budget = budget;
  }

  /**
   * Open (creating if absent) the ledger at `path`.
   *
   * Creation never exposes the final pathname until the EXACT header bytes
   * are fully written and file-fsynced in a same-directory unique temp;
   * publication is an atomic no-clobber hard link, so concurrent creators
   * cannot clobber each other and a crash at any phase leaves the final
   * path either absent or complete — never empty, never a partial header.
   * A LEGACY leftover (empty, or a strict header-line prefix — the old
   * in-place creator crashing before its header completed) provably holds
   * no charge and is repaired in place given an explicit budget; any other
   * malformed nonempty file is refused.
   *
   * The ledger's directory chain is created here and made DURABLE here:
   * every successful open — creator, publication-race loser, or plain
   * re-open — fsyncs the ledger bytes and every directory level from the
   * ledger's dir through the parent of `opts.durableRoot` (default: the
   * ledger's dir) BEFORE returning. Until open resolves no charge can be
   * accepted, so no acknowledged fact can ever depend on a directory entry
   * that would not survive power loss — even when the creating process
   * crashed (or is still paused) between publishing the header and syncing
   * the directory chain.
   */
  static async open(path: string, opts: { budget?: number; durableRoot?: string } = {}): Promise<HoldoutLedger> {
    const dir = dirname(path);
    const chain = dirChain(opts.durableRoot ?? dir, dir); // validates ancestry before any I/O
    for (;;) {
      // Recreates the chain if missing — including after a power loss that
      // discarded an unsynced dirent. Durability of every level (whether we
      // created it, a concurrent opener did, or it pre-existed) is
      // established by the unconditional chain sync below.
      await mkdir(dir, { recursive: true });
      let raw: Buffer | null;
      try {
        raw = await readFile(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        raw = null;
      }

      if (raw === null) {
        const budget = opts.budget;
        if (budget === undefined) throw new Error(`holdout ledger ${path}: a fresh ledger needs an explicit budget`);
        Header.parse({ v: 2, budget }); // positive-int validation
        // Never expose the final pathname before the exact header bytes are
        // fully written AND file-fsynced: build the ledger in a
        // same-directory unique temp, then publish it with an atomic
        // no-clobber hard link.
        const tmpPath = `${path}.${randomUUID()}.tmp`;
        let published = false;
        try {
          const tmpHandle = await open(tmpPath, "wx");
          try {
            await appendLineDurable(tmpHandle, `${JSON.stringify({ v: 2, budget })}\n`, tmpPath);
          } finally {
            await tmpHandle.close();
          }
          try {
            await ledgerIo.linkNoClobber(tmpPath, path);
            published = true;
          } catch (err) {
            // Lost the no-clobber publication race — adopt the winner's
            // ledger on the next loop iteration.
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          }
        } finally {
          // Winner and loser alike clean up — but ONLY their own temp; a
          // foreign temp may belong to a live contender mid-publication.
          await unlink(tmpPath).catch(() => undefined);
        }
        if (!published) continue;
        // The header bytes were already fsynced through the temp handle
        // (same inode), so only the DIRECTORY entries still need
        // durability: sync the chain leaf first — an fsynced file in an
        // unsynced directory does not survive power loss, and neither does
        // a subdirectory whose parent's entry for it was never fsynced.
        const handle = await open(path, "a");
        try {
          for (const level of chain) await ledgerIo.syncDir(level);
        } catch (err) {
          await handle.close().catch(() => undefined);
          throw err;
        }
        return new HoldoutLedger(path, handle, 0, budget);
      }

      if (!raw.includes(0x0a)) {
        // No complete header line. The current creator never exposes the
        // final pathname before its full header is durable, so this is a
        // LEGACY leftover: the old in-place creator crashed between
        // creating the final path and completing its header. No complete
        // header means no charge can exist — repair in place (idempotent,
        // fixed-offset, identical bytes); refuse anything else.
        if (!isLegacyHeaderPrefix(raw)) {
          throw new Error(`holdout ledger ${path}: corrupt — headerless and not a crashed header prefix; refusing`);
        }
        const budget = opts.budget;
        if (budget === undefined) {
          throw new Error(
            `holdout ledger ${path}: creation crashed before its header completed — re-open with an explicit budget to repair`,
          );
        }
        Header.parse({ v: 2, budget }); // positive-int validation
        await repairLegacyHeader(path, budget);
        continue; // reread and adopt the repaired (or concurrently completed) header
      }
      const text = decodeStrict(raw, path);
      const { budget, nonces } = parseLedger(text, path, opts.budget);
      const handle = await open(path, "a");
      try {
        // A complete header proves nothing about durability: the creator may
        // have crashed — or still be paused — before ITS fsyncs, so this
        // opener re-establishes durability itself (mirrors the broker CAS
        // dedup-hit path): bytes first, then the directory chain, leaf first.
        await ledgerIo.syncFile(path);
        for (const level of chain) await ledgerIo.syncDir(level);
      } catch (err) {
        await handle.close().catch(() => undefined);
        throw err;
      }
      return new HoldoutLedger(path, handle, nonces.length, budget);
    }
  }

  /** Successful count is clamped at the budget; over-budget lines are denial records, not grants. */
  state(): { count: number; budget: number } {
    return { count: Math.min(this.#attempts, this.#budget), budget: this.#budget };
  }

  /**
   * Charge one holdout access. Write-ahead: the attempt line is durable
   * BEFORE any grant, and the grant decision is the line's ordinal in the
   * reread file — the shared append order, not this instance's cached view.
   * Calls on this instance are SERIALIZED; instances in other processes are
   * ordered by O_APPEND itself.
   */
  charge(): Promise<{ count: number; budget: number }> {
    const run = this.#chain.then(() => this.#chargeLocked());
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #chargeLocked(): Promise<{ count: number; budget: number }> {
    // Fast-path denial WITHOUT a write: attempts only ever grow, so a ledger
    // this instance has already observed to be full stays full forever. This
    // keeps repeated over-budget charges from appending unbounded denial
    // records; only a charge that might still win a slot appends.
    if (this.#attempts >= this.#budget) throw new HoldoutBudgetExceededError(this.#budget, this.#budget);

    const nonce = randomUUID();
    await appendLineDurable(this.#handle, `${JSON.stringify({ nonce, at: new Date().toISOString() })}\n`, this.path);

    // Append order is the authority: reread and find our own line's ordinal.
    const text = decodeStrict(await readFile(this.path), this.path);
    const { nonces } = parseLedger(text, this.path, this.#budget);
    const ordinal = nonces.indexOf(nonce) + 1;
    if (ordinal === 0) {
      throw new Error(
        `holdout ledger ${this.path}: corrupt — own charge line (nonce ${nonce}) missing after a durable append; refusing`,
      );
    }
    this.#attempts = Math.max(this.#attempts, nonces.length);
    if (ordinal > this.#budget) {
      // Lost the race for the final slot. The appended line REMAINS on disk
      // as a durable denial record — attempts are never erased.
      throw new HoldoutBudgetExceededError(this.#budget, this.#budget);
    }
    return { count: ordinal, budget: this.#budget };
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}
