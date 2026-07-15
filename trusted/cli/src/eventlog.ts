import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunEvent } from "@hone/schema";
import type { ArtifactRef, BudgetState } from "@hone/schema";

/**
 * Append-only NDJSON event log — the ONLY run-state store (contract 4).
 * Replay of this file reconstructs everything status/best/diff/resume need.
 */

export const EVENTS_FILE = "events.ndjson";

export function eventsPath(runDir: string): string {
  return join(runDir, EVENTS_FILE);
}

export function appendEvent(runDir: string, event: RunEvent): RunEvent {
  const parsed = RunEvent.parse(event);
  appendFileSync(eventsPath(runDir), `${JSON.stringify(parsed)}\n`, "utf8");
  return parsed;
}

/**
 * Strict on interior lines (a corrupt trusted log is an error), tolerant of a
 * single torn trailing line (crash mid-append is the resume contract's normal case).
 */
export function readEvents(runDir: string): RunEvent[] {
  const p = eventsPath(runDir);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n");
  const events: RunEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      const isTail = lines.slice(i + 1).every((l) => l.trim() === "");
      if (isTail) break; // torn tail write — ignore, cursor stops before it
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
  /** Number of events consumed = the next event's 0-based line index. */
  cursor: number;
  status: RunStatus;
  episodes: Set<number>;
  nextEpisode: number;
  /** Parent artifact of the earliest episode — the baseline snapshot. */
  baselineArtifact: ArtifactRef | null;
  incumbent: IncumbentState | null;
  lastBudget: BudgetState | null;
  finished: FinishedState | null;
  resumeCount: number;
  evalCount: number;
}

export function replay(events: RunEvent[]): RunState {
  const state: RunState = {
    runId: null,
    capsuleId: null,
    contractHash: null,
    cursor: 0,
    status: "pending",
    episodes: new Set<number>(),
    nextEpisode: 0,
    baselineArtifact: null,
    incumbent: null,
    lastBudget: null,
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
        state.status = "running";
        break;
      case "run.resumed":
        state.resumeCount++;
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
