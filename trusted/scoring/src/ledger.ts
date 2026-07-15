import { open, readFile, type FileHandle } from "node:fs/promises";
import { z } from "zod";

/**
 * Holdout query ledger (review IV.2, Dwork adaptive-validity argument):
 * a file-backed monotonic counter with a HARD lifetime budget. Every holdout
 * access is charged BEFORE it is granted: the charge line is written and
 * fsynced first (write-ahead), so a crash never under-counts. A torn trailing
 * line means fsync never returned — the access was never granted — so it is
 * discarded on re-open.
 */

const Header = z.object({ v: z.literal(1), budget: z.number().int().positive() });
const ChargeLine = z.object({ seq: z.number().int().positive(), at: z.string() });

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

export class HoldoutLedger {
  readonly path: string;
  #handle: FileHandle;
  #count: number;
  #budget: number;

  private constructor(path: string, handle: FileHandle, count: number, budget: number) {
    this.path = path;
    this.#handle = handle;
    this.#count = count;
    this.#budget = budget;
  }

  static async open(path: string, opts: { budget?: number } = {}): Promise<HoldoutLedger> {
    let content: string | null;
    try {
      content = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      content = null;
    }

    if (content === null) {
      const budget = opts.budget;
      if (budget === undefined) throw new Error(`holdout ledger ${path}: a fresh ledger needs an explicit budget`);
      Header.parse({ v: 1, budget }); // positive-int validation
      const handle = await open(path, "ax");
      await handle.write(`${JSON.stringify({ v: 1, budget })}\n`, null, "utf8");
      await handle.sync();
      return new HoldoutLedger(path, handle, 0, budget);
    }

    // Only newline-terminated lines exist; a trailing partial is a torn crash-write.
    const lines = content.split("\n");
    lines.pop();
    const headerLine = lines[0];
    if (headerLine === undefined) throw new Error(`holdout ledger ${path}: corrupt — missing header`);
    let header: z.infer<typeof Header>;
    try {
      header = Header.parse(JSON.parse(headerLine));
    } catch {
      throw new Error(`holdout ledger ${path}: corrupt header line`);
    }
    if (opts.budget !== undefined && opts.budget !== header.budget) {
      throw new Error(
        `holdout ledger ${path}: budget mismatch — file says ${header.budget}, caller says ${opts.budget}; the lifetime budget is immutable`,
      );
    }
    let count = 0;
    for (let i = 1; i < lines.length; i += 1) {
      let charge: z.infer<typeof ChargeLine>;
      try {
        charge = ChargeLine.parse(JSON.parse(lines[i] ?? ""));
      } catch {
        throw new Error(`holdout ledger ${path}: corrupt charge line ${i}`);
      }
      if (charge.seq !== count + 1) {
        throw new Error(`holdout ledger ${path}: corrupt — charge line ${i} has seq ${charge.seq}, expected ${count + 1}`);
      }
      count = charge.seq;
    }
    return new HoldoutLedger(path, await open(path, "a"), count, header.budget);
  }

  state(): { count: number; budget: number } {
    return { count: this.#count, budget: this.#budget };
  }

  /**
   * Charge one holdout access. Write-ahead: the line is durable BEFORE the
   * new count is returned; past the budget it throws and writes NOTHING.
   */
  async charge(): Promise<{ count: number; budget: number }> {
    if (this.#count >= this.#budget) throw new HoldoutBudgetExceededError(this.#count, this.#budget);
    const seq = this.#count + 1;
    await this.#handle.write(`${JSON.stringify({ seq, at: new Date().toISOString() })}\n`, null, "utf8");
    await this.#handle.sync();
    this.#count = seq;
    return { count: seq, budget: this.#budget };
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}
