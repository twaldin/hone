import { basename } from "node:path";
import {
  incumbentsAligned,
  journalEventsAligned,
  readJournalEvents,
  readJournalIncumbents,
} from "./backends/local.js";
import { bestArtifact, readEvents, replay, type RunState } from "./eventlog.js";
import type { RunEvent } from "@hone/schema";
import type { CmdIo } from "./io.js";

/**
 * Anytime commands read the public event stream, but broker-state.ndjson is
 * the durable authority. Refuse stale/destructive views across the narrow
 * journal-fsync -> public-append crash window; `hone run --resume` performs
 * the trusted repair before the command is retried.
 */

/** The exact public replay a command may act on: alignment was proven against THESE events. */
export interface AlignedAuthoritySnapshot {
  aligned: true;
  runId: string;
  state: RunState;
  /** The literal event list the journal was compared against — `state` is its replay. */
  events: RunEvent[];
}

export interface AuthorityAlignmentFailure {
  aligned: false;
  reason: "journal-diverged" | "incumbent-unseen" | "unreadable";
  message: string;
}

export type AuthoritySnapshot = AlignedAuthoritySnapshot | AuthorityAlignmentFailure;

/**
 * A live broker may append between our public read and our journal read; a
 * bounded re-read lets the command converge on the NEW authority instead of
 * failing spuriously. Divergence that survives every attempt is treated as
 * the crash-window gap and fails closed.
 */
const MAX_ALIGNMENT_ATTEMPTS = 3;

/**
 * Fail-closed authority gate: read the public log, replay it, and prove the
 * broker journal (event authority AND promotion history) matches THAT exact
 * read. On success the returned state is the only run view the caller may
 * render or deliver — consuming any earlier replay would reintroduce the
 * stale-A-after-B TOCTOU this helper exists to close.
 */
export function alignedAuthoritySnapshot(runDir: string, io: CmdIo): AuthoritySnapshot {
  const snapshot = readAlignedSnapshot(runDir);
  if (!snapshot.aligned) io.err(snapshot.message);
  return snapshot;
}

/**
 * Delivery-time drift guard, invoked by deliver's verifyTarget hook
 * IMMEDIATELY before every ref mutation: the run's authority must still be
 * aligned and its current best must still be the exact artifact the command
 * selected. An incumbent that published after selection fails the delivery
 * closed — a superseded artifact is never published.
 */
export function assertAuthorityStillSelected(runDir: string, selectedHash: string, runId: string): void {
  const snapshot = readAlignedSnapshot(runDir);
  if (!snapshot.aligned) throw new Error(snapshot.message);
  const current = bestArtifact(snapshot.state);
  if (current === null || current.hash !== selectedHash) {
    throw new Error(
      `run ${runId}: incumbent authority advanced past the selected artifact ${selectedHash}`
      + ` (current: ${current?.hash ?? "none"}) during delivery — refusing to publish a superseded incumbent; re-run apply`,
    );
  }
}

function readAlignedSnapshot(runDir: string): AuthoritySnapshot {
  let failure: AuthorityAlignmentFailure | null = null;
  for (let attempt = 0; attempt < MAX_ALIGNMENT_ATTEMPTS; attempt++) {
    let runId = basename(runDir);
    try {
      const events = readEvents(runDir);
      const state = replay(events);
      runId = state.runId ?? runId;
      const journalEvents = readJournalEvents(runDir);
      if (journalEvents !== null && !journalEventsAligned(journalEvents, events)) {
        failure = {
          aligned: false,
          reason: "journal-diverged",
          message: `run ${runId}: broker event authority and the public event log are not exactly aligned — resume required (\`hone run --resume\`) before reading or applying the incumbent`,
        };
        continue;
      }
      const incumbents = readJournalIncumbents(runDir);
      if (incumbents !== null && !incumbentsAligned(incumbents, events)) {
        failure = {
          aligned: false,
          reason: "incumbent-unseen",
          message: `run ${runId}: the broker journal holds incumbent authority the event log never saw — resume required (\`hone run --resume\`) before reading or applying the incumbent`,
        };
        continue;
      }
      return { aligned: true, runId, state, events };
    } catch (error) {
      // Corrupt data does not heal on re-read — fail closed immediately.
      return {
        aligned: false,
        reason: "unreadable",
        message: `run ${runId}: ${error instanceof Error ? error.message : String(error)} — resume required; refusing a stale incumbent view`,
      };
    }
  }
  if (failure === null) throw new Error("unreachable: alignment loop made no attempt");
  return failure;
}
