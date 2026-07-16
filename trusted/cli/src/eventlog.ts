import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunEvent } from "@hone/schema";
import type { ApplyMode, ArtifactRef, BudgetState } from "@hone/schema";

/**
 * Append-only NDJSON event log — the ONLY run-state store (contract 4).
 * Replay of this file reconstructs everything status/best/diff/resume need.
 */

export const EVENTS_FILE = "events.ndjson";

export function eventsPath(runDir: string): string {
  return join(runDir, EVENTS_FILE);
}

/** fsync a directory so a just-created or just-renamed entry survives power loss. */
export function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write the WHOLE buffer: writeSync may write short, and a short seal that
 * gets fsync+renamed anyway would publish a truncated file as durable. A
 * zero-progress write fails rather than spinning. `write` is a test seam
 * for injected short writes.
 */
export function writeAllSync(
  fd: number,
  data: Buffer,
  write: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number) => number = writeSync,
): void {
  let offset = 0;
  while (offset < data.length) {
    const wrote = write(fd, data, offset, data.length - offset);
    if (wrote <= 0) throw new Error(`short write stalled at ${offset}/${data.length} bytes`);
    offset += wrote;
  }
}

/**
 * Durable sidecar publication (write-all → fsync tmp → rename → fsync parent
 * — the same discipline as this event log and the broker journal): a
 * resume-required file (runtime pin, capsule snapshot, run config, contract,
 * delivery target) must never be lost or torn by power loss once
 * run.started is durable, or the run would be unresumable while its
 * terminal authority survives.
 */
export function writeFileDurable(
  path: string,
  content: string,
  write?: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number) => number,
): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeAllSync(fd, Buffer.from(content, "utf8"), write ?? writeSync);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDir(dirname(path));
}

/**
 * Durable append (review finding 11 + FinalSecurityGate finding 3): broker
 * authority is journaled+fsynced before it reaches this sink, so the sink
 * itself must not sit in the page cache, must never fuse with a crashed
 * writer's torn tail, and must survive short writes. An acknowledged event
 * is a complete, newline-terminated, fsynced line.
 */
export function appendEvent(runDir: string, event: RunEvent, sync: (dir: string) => void = syncDir): RunEvent {
  const parsed = RunEvent.parse(event);
  const path = eventsPath(runDir);
  const fd = openSync(path, "a+");
  try {
    repairTornTail(fd);
    writeAllSync(fd, Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // EVERY acknowledged append also pins the log's directory entry — not just
  // the append that observed itself creating the file. This process may be
  // RECOVERING a log a killed creator opened but never made durable: a
  // power loss after the fd fsync would otherwise acknowledge an event into
  // a file whose dirent never reached disk. One fsync of the run dir per
  // append is the simplest policy that is safe for every crash interleaving
  // (creator killed pre-syncDir, concurrent creators, rename recovery).
  // `sync` is a test seam.
  sync(runDir);
  return parsed;
}

/**
 * A SIGKILL mid-append leaves a torn, non-newline-terminated tail; appending
 * after it would fuse two records into one corrupt interior line that replay
 * hard-rejects. Truncate (+fsync) to the last complete line first — the torn
 * bytes were never acknowledged, so dropping them is the resume contract.
 */
function repairTornTail(fd: number): void {
  const size = fstatSync(fd).size;
  if (size === 0) return;
  const probe = Buffer.alloc(1);
  readSync(fd, probe, 0, 1, size - 1);
  if (probe[0] === 0x0a) return;
  // Torn tail confirmed: scan backwards for the last newline.
  const chunk = Buffer.alloc(4096);
  let pos = size - 1;
  let keep = 0;
  while (pos > 0) {
    const n = Math.min(chunk.length, pos);
    readSync(fd, chunk, 0, n, pos - n);
    const idx = chunk.subarray(0, n).lastIndexOf(0x0a);
    if (idx !== -1) {
      keep = pos - n + idx + 1;
      break;
    }
    pos -= n;
  }
  ftruncateSync(fd, keep);
  fsyncSync(fd);
}

/**
 * Strict on every acknowledged line. Bytes after the last newline were never
 * fsynced as a complete record—even valid JSON there is a torn tail.
 */
export function readEvents(runDir: string): RunEvent[] {
  const p = eventsPath(runDir);
  if (!existsSync(p)) return [];
  const rawLog = readFileSync(p, "utf8");
  const acknowledgedEnd = rawLog.lastIndexOf("\n");
  if (acknowledgedEnd < 0) return [];
  const lines = rawLog.slice(0, acknowledgedEnd).split("\n");
  const events: RunEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`corrupt event log ${p} at line ${i + 1}: unparseable JSON`);
    }
    const result = RunEvent.safeParse(raw);
    if (!result.success) {
      throw new Error(`corrupt event log ${p} at line ${i + 1}: ${result.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; ")}`);
    }
    events.push(result.data);
  }
  return events;
}

export type RunStatus = "pending" | "running" | "completed" | "stopped" | "failed" | "budget";

export interface IncumbentState {
  artifact: ArtifactRef;
  aggregate: number;
  deltaVsBaseline: number;
  episode: number;
}

export interface FinishedState {
  status: "completed" | "stopped" | "failed" | "budget";
  best: ArtifactRef | null;
  at: string;
}

export interface RunState {
  runId: string | null;
  capsuleId: string | null;
  contractHash: string | null;
  /** Optimizer digest sealed by run.started (null before the run started). */
  optimizerDigest: string | null;
  /** Last probe.completed outcome (null when no probe has been decided). */
  probe: { approved: boolean } | null;
  /** Number of events consumed = the next event's 0-based line index. */
  cursor: number;
  status: RunStatus;
  episodes: Set<number>;
  nextEpisode: number;
  /** Parent artifact of the earliest episode — the baseline snapshot. */
  baselineArtifact: ArtifactRef | null;
  incumbent: IncumbentState | null;
  lastBudget: BudgetState | null;
  /** Durable broker-authored exhaustion latch, even before run.finished. */
  budgetExhaustedDimension: string | null;
  /** Trusted delivery outcome already made durable before run.finished. */
  delivery: { mode: ApplyMode; ref: string | null } | null;
  finished: FinishedState | null;
  resumeCount: number;
  evalCount: number;
}

export function replay(events: RunEvent[]): RunState {
  const state: RunState = {
    runId: null,
    capsuleId: null,
    contractHash: null,
    optimizerDigest: null,
    probe: null,
    cursor: 0,
    status: "pending",
    episodes: new Set<number>(),
    nextEpisode: 0,
    baselineArtifact: null,
    incumbent: null,
    lastBudget: null,
    budgetExhaustedDimension: null,
    delivery: null,
    finished: null,
    resumeCount: 0,
    evalCount: 0,
  };
  let minEpisode = Number.POSITIVE_INFINITY;
  for (const event of events) {
    state.cursor++;
    switch (event.type) {
      case "run.started":
        state.runId = event.runId;
        state.capsuleId = event.capsuleId;
        state.contractHash = event.contractHash;
        state.optimizerDigest = event.optimizerDigest;
        state.status = "running";
        break;
      case "run.resumed":
        state.resumeCount++;
        break;
      case "probe.completed":
        state.probe = { approved: event.approved };
        break;
      case "episode.started":
        state.episodes.add(event.episode);
        state.nextEpisode = Math.max(state.nextEpisode, event.episode + 1);
        if (event.episode < minEpisode) {
          minEpisode = event.episode;
          state.baselineArtifact = event.parent;
        }
        break;
      case "eval.completed":
        state.evalCount++;
        break;
      case "incumbent.new":
        state.incumbent = {
          artifact: event.artifact,
          aggregate: event.aggregate,
          deltaVsBaseline: event.deltaVsBaseline,
          episode: event.episode,
        };
        break;
      case "budget.snapshot":
        state.lastBudget = event.budget;
        break;
      case "budget.exhausted":
        if (
          state.budgetExhaustedDimension !== null
          && state.budgetExhaustedDimension !== event.dimension
        ) {
          throw new Error(
            `contradictory budget exhaustion dimensions ${state.budgetExhaustedDimension} and ${event.dimension}`,
          );
        }
        state.budgetExhaustedDimension = event.dimension;
        break;
      case "delivery.applied": {
        const delivery = { mode: event.mode, ref: event.ref ?? null };
        if (
          state.delivery !== null
          && (state.delivery.mode !== delivery.mode || state.delivery.ref !== delivery.ref)
        ) {
          throw new Error("contradictory durable delivery outcomes in one run");
        }
        state.delivery = delivery;
        break;
      }
      case "run.finished":
        state.finished = { status: event.status, best: event.best ?? null, at: event.at };
        state.status = event.status;
        break;
      default:
        break;
    }
  }
  return state;
}

export function replayRun(runDir: string): RunState {
  return replay(readEvents(runDir));
}

/** Anytime answer: the finished best if recorded, else the live incumbent. */
export function bestArtifact(state: RunState): ArtifactRef | null {
  return state.finished?.best ?? state.incumbent?.artifact ?? null;
}
