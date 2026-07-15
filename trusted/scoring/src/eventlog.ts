import { open, readFile, truncate, type FileHandle } from "node:fs/promises";
import { RunEvent } from "@hone/schema";
import type { ArtifactRef, BudgetState } from "@hone/schema";

/**
 * Contract 4 — append-only NDJSON event log + cursor reader.
 *
 * `cursor` is the 0-based line index. Replay of this file is the ONLY
 * resumability mechanism in the seed: `replay()` must reconstruct everything
 * a resuming runner (or attaching UI) needs.
 */

export interface CursoredEvent {
  cursor: number;
  event: RunEvent;
}

export interface TailOptions {
  /** Poll interval while waiting for new lines. */
  pollMs?: number;
  /** Abort tailing; the iterator finishes cleanly. */
  signal?: AbortSignal;
}

/**
 * `Promise.withResolvers` ponyfill: Node 18 lacks the native API, so the
 * executor form is required here — confined to this single helper.
 */
function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/**
 * Split raw log content into COMPLETE (newline-terminated) lines.
 * A trailing partial without a newline is a torn crash-write: the append
 * never acknowledged, so the line does not exist.
 */
function completeLines(content: string): string[] {
  const parts = content.split("\n");
  parts.pop(); // "" for a well-terminated file, or the torn partial
  return parts;
}

export class EventLog {
  readonly path: string;
  #handle: FileHandle | null = null;
  #nextCursor: number | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async #readRaw(): Promise<string> {
    try {
      return await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  /** Open (once) for appending; seals any torn trailing partial by truncating it. */
  async #appendHandle(): Promise<FileHandle> {
    if (this.#handle !== null) return this.#handle;
    const content = await this.#readRaw();
    const lines = completeLines(content);
    const completeLength = lines.reduce((n, l) => n + l.length + 1, 0);
    if (completeLength < content.length) {
      // Torn trailing partial from a crash: discard it before appending.
      await truncate(this.path, completeLength);
    }
    this.#nextCursor = lines.length;
    this.#handle = await open(this.path, "a");
    return this.#handle;
  }

  /**
   * Validate, append one NDJSON line, fsync. Returns the event's cursor.
   * Nothing hits disk unless the event parses against the contract.
   */
  async append(event: RunEvent): Promise<number> {
    const parsed = RunEvent.parse(event);
    const handle = await this.#appendHandle();
    const cursor = this.#nextCursor;
    if (cursor === null) throw new Error("event log append handle not initialized");
    await handle.write(`${JSON.stringify(parsed)}\n`, null, "utf8");
    await handle.sync();
    this.#nextCursor = cursor + 1;
    return cursor;
  }

  /** Read all events from `fromCursor` (inclusive). Missing file = empty log. */
  async read(fromCursor = 0): Promise<CursoredEvent[]> {
    const lines = completeLines(await this.#readRaw());
    const out: CursoredEvent[] = [];
    for (let cursor = fromCursor; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line === undefined || line === "") {
        throw new Error(`event log ${this.path}: corrupt empty line ${cursor}`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new Error(`event log ${this.path}: corrupt line ${cursor} is not JSON`);
      }
      out.push({ cursor, event: RunEvent.parse(raw) });
    }
    return out;
  }

  /**
   * Async-iterate events from `fromCursor`, polling for new lines.
   * Ends cleanly at `run.finished` or when the signal aborts.
   */
  async *tail(fromCursor = 0, opts: TailOptions = {}): AsyncGenerator<CursoredEvent, void> {
    const pollMs = opts.pollMs ?? 200;
    let cursor = fromCursor;
    while (!opts.signal?.aborted) {
      for (const item of await this.read(cursor)) {
        cursor = item.cursor + 1;
        yield item;
        if (item.event.type === "run.finished" || opts.signal?.aborted) return;
      }
      await sleep(pollMs, opts.signal);
    }
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    this.#nextCursor = null;
    if (handle !== null) await handle.close();
  }
}

/** Materialized run state — everything resume/attach needs, nothing else. */
export interface RunState {
  /** Last `incumbent.new` artifact (or `run.finished.best`). */
  incumbent: ArtifactRef | null;
  /** Episodes that reached a terminal event: `gate.paired`, or `episode.invalid` with `repaired: false`. */
  episodesDone: number;
  /** Last `budget.snapshot`. */
  budgetLast: BudgetState | null;
  status: "pending" | "running" | "completed" | "stopped" | "failed" | "budget";
  /** Last `holdout.accessed` ledger reading. */
  holdoutLedger: { count: number; budget: number } | null;
}

/**
 * Pure, deterministic fold of an event stream into run state.
 * THIS is the resumability contract: same events in, byte-identical state out.
 */
export function replay(events: Iterable<RunEvent>): RunState {
  let incumbent: ArtifactRef | null = null;
  let budgetLast: BudgetState | null = null;
  let status: RunState["status"] = "pending";
  let holdoutLedger: RunState["holdoutLedger"] = null;
  const finishedEpisodes = new Set<number>();

  for (const event of events) {
    switch (event.type) {
      case "run.started":
      case "run.resumed":
        status = "running";
        break;
      case "gate.paired":
        finishedEpisodes.add(event.episode);
        break;
      case "episode.invalid":
        if (!event.repaired) finishedEpisodes.add(event.episode);
        break;
      case "incumbent.new":
        incumbent = event.artifact;
        break;
      case "budget.snapshot":
        budgetLast = event.budget;
        break;
      case "holdout.accessed":
        holdoutLedger = { count: event.ledgerCount, budget: event.ledgerBudget };
        break;
      case "run.finished":
        status = event.status;
        if (event.best !== undefined) incumbent = event.best;
        break;
      default:
        break; // episode.started, episode.candidate, eval.completed, budget.exhausted, delivery.applied
    }
  }

  return { incumbent, episodesDone: finishedEpisodes.size, budgetLast, status, holdoutLedger };
}
