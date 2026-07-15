import { randomUUID } from "node:crypto";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
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

/** How long a fresh open waits for a concurrent creator to flush the header. */
const INIT_RACE_RETRIES = 100;
const INIT_RACE_DELAY_MS = 10;

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

  static async open(path: string, opts: { budget?: number } = {}): Promise<HoldoutLedger> {
    for (let attempt = 0; ; attempt += 1) {
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
        let handle: FileHandle;
        try {
          handle = await open(path, "ax");
        } catch (err) {
          // Lost the O_EXCL creation race — recover by re-reading the
          // winner's initialized ledger on the next loop iteration.
          if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw err;
        }
        await appendLineDurable(handle, `${JSON.stringify({ v: 2, budget })}\n`, path);
        return new HoldoutLedger(path, handle, 0, budget);
      }

      const text = decodeStrict(raw, path);
      if (!text.includes("\n")) {
        // No complete header line yet. Either a concurrent creator won the
        // O_EXCL race but has not flushed the header, or the very first init
        // crashed mid-write. Wait briefly for the former; fail closed on the
        // latter.
        if (attempt >= INIT_RACE_RETRIES) throw new Error(`holdout ledger ${path}: corrupt — missing header`);
        await sleep(INIT_RACE_DELAY_MS);
        continue;
      }
      const { budget, nonces } = parseLedger(text, path, opts.budget);
      return new HoldoutLedger(path, await open(path, "a"), nonces.length, budget);
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
