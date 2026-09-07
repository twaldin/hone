import { basename } from "node:path";
import { runCommand, type RunCommand } from "@hone/broker";
import { UsageError, boolFlag, parseFlags, strFlag } from "../args.js";
import { authenticateCapsuleSnapshot } from "../admission.js";
import { resolveDeliveryTarget } from "../delivery-target.js";
import {
  incumbentsAligned,
  journalEventsAligned,
  readJournalEvents,
  readJournalIncumbents,
  removeRunHostSockets,
  residualRunDockerResources,
  sweepStaleRunResources,
} from "../backends/local.js";
import { dispatchAuthorityAligned } from "../dispatch-authority.js";
import { readOpenDockerCreateIntents } from "../docker-create-gate.js";
import { openStopDockerClient, type StopDockerClient } from "../docker-engine-seal.js";
import { appendEvent, readEvents, replayRun } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { sleep } from "../promise.js";
import { resolveRun } from "../runs.js";
import { acquireRunLock, leaseRunLockIdentity, optimizerCompleteForRun, pidAlive, readSupervisorSentinel } from "../supervisor.js";
import type { RunLockLease } from "../supervisor.js";
import { applyBest } from "./apply.js";

interface StopFlags {
  takeBest: boolean;
  repo: string | undefined;
  branch: string | undefined;
}

/**
 * A held lease on the run lock whose identity metadata names the exact
 * sentinel PID, or null. PIDs recycle: a live pid in supervisor.json is
 * NEVER trusted (let alone signalled) unless the run lock is live (kernel-
 * level connect) AND its metadata names the exact same pid/nonce/runId — a
 * bare live PID with no matching lock is an unrelated process wearing a
 * recycled number. The lease OUTLIVES the check: it stays connected to the
 * proven holder across the SIGTERM decision and the stop wait, so the proof
 * cannot silently rot into a different process. It needs no event-loop
 * progress from the holder, so a supervisor blocked in synchronous delivery
 * is still confirmable.
 */
async function confirmSupervisor(runDir: string, runId: string): Promise<RunLockLease | null> {
  const sentinel = readSupervisorSentinel(runDir);
  if (sentinel === null || sentinel.nonce === undefined || !pidAlive(sentinel.pid)) return null;
  const lease = await leaseRunLockIdentity(runDir);
  if (lease === null) return null;
  if (lease.identity.pid !== sentinel.pid || lease.identity.nonce !== sentinel.nonce || lease.identity.runId !== runId) {
    lease.close();
    return null;
  }
  return lease;
}

/** True when the lease released within `ms` — an identity-bound wait, never a bare-PID poll. */
async function releasedWithin(lease: RunLockLease, ms: number): Promise<boolean> {
  if (lease.isReleased()) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([lease.released.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function resourcesSwept(runId: string, runDir: string, run: RunCommand, production: boolean, io: CmdIo): Promise<boolean> {
  // Freeze ONE Docker client for the WHOLE attempt (P1 TOCTOU: resources on
  // Engine A, preflight on A, ambient context switched to B before the
  // sweep — a sweep observing an empty B would terminalize while A keeps
  // every resource and pending create). The endpoint is resolved exactly
  // once, unix sockets are canonicalized and inode-pinned, and every later
  // docker argv carries the frozen endpoint explicitly — context/config
  // mutations after this line steer nothing in production and fail closed
  // (identity drift) for injected seams. An absent seal is acceptable only
  // because the seal is written BEFORE the create journal can exist: no
  // seal + no journal = provably no Docker contact.
  let docker: StopDockerClient;
  try {
    docker = await openStopDockerClient(runDir, runId, run, production);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)} — refusing completion`);
    return false;
  }
  if (docker.neverContactedDocker) {
    // No seal + no create journal: the seal is durably written BEFORE the
    // journal and before ANY resource operation, so this run provably never
    // contacted Docker. There is nothing to sweep or verify, and demanding
    // a resolvable endpoint or live daemon here would leave a zero-resource
    // run unfinalizeable. Only the fs-only host socket cleanup remains.
    removeRunHostSockets(runDir);
    return true;
  }
  // Engine identity preflight: the latch judgment and the strict sweep are
  // only meaningful against the Engine this run is sealed to.
  const preflight = await docker.verifyEngine();
  if (preflight !== null) {
    io.err(`${preflight} — refusing completion`);
    return false;
  }
  // Durable docker-create latch: an open write-ahead intent means a create
  // dispatched by a crashed attempt may STILL publish a container/volume/
  // network daemon-side. Only a resumed backend can causally prove it dead
  // (donor-epoch claim) or observe-and-reap it — a one-shot sweep here is
  // cleanup, never that proof, so finalization refuses.
  const open = readOpenDockerCreateIntents(runDir);
  if (open.length > 0) {
    const detail = open.map((i) => `${i.kind} ${i.name ?? "<unnamed>"}`).join(", ");
    io.err(
      `run ${runId}: ${open.length} docker create outcome(s) from a crashed attempt are unresolved (${detail}) — resume required (\`hone run --resume\`) before stop can finalize`,
    );
    return false;
  }
  try {
    await sweepStaleRunResources(runId, runDir, docker.run, true);
  } catch (err) {
    io.err(`run ${runId}: resource cleanup incomplete: ${err instanceof Error ? err.message : String(err)} — refusing completion`);
    return false;
  }
  // Zero-resource proof on the SAME frozen endpoint: removal exit codes are
  // never trusted alone — re-list the label set and every deterministic name.
  try {
    const residual = await residualRunDockerResources(runId, docker.run);
    if (residual.length > 0) {
      io.err(`run ${runId}: docker resources still exist after cleanup (${residual.join(", ")}) — refusing completion`);
      return false;
    }
  } catch (err) {
    io.err(`run ${runId}: resource cleanup incomplete: ${err instanceof Error ? err.message : String(err)} — refusing completion`);
    return false;
  }
  // Identity recheck LAST: terminal success is claimed only after the swept,
  // provably-empty daemon re-proves it is the exact sealed Engine (and the
  // exact socket incarnation) — the final act before any run.finished.
  const drift = await docker.verifyEngine();
  if (drift !== null) {
    io.err(`${drift} — refusing completion`);
    return false;
  }
  return true;
}

function journalAuthorityAligned(runId: string, runDir: string, io: CmdIo): boolean {
  try {
    const publicEvents = readEvents(runDir);
    const journalEvents = readJournalEvents(runDir);
    if (journalEvents !== null && !journalEventsAligned(journalEvents, publicEvents)) {
      io.err(
        `run ${runId}: broker event authority and the public event log are not exactly aligned — resume required (\`hone run --resume\`) before stop or apply`,
      );
      return false;
    }
    const incumbents = readJournalIncumbents(runDir);
    if (incumbents !== null && !incumbentsAligned(incumbents, publicEvents)) {
      io.err(
        `run ${runId}: the broker journal holds incumbent authority the event log never saw — resume required (\`hone run --resume\`) before stop or apply`,
      );
      return false;
    }
    return true;
  } catch (e) {
    io.err(`run ${runId}: ${e instanceof Error ? e.message : String(e)} — resume required; refusing to finalize or apply`);
    return false;
  }
}

/**
 * Stop a run. A live, identity-confirmed supervisor is SIGTERM'd and awaited
 * (terminal event + lock release + process death). A dead run is finalized
 * as stopped — but ONLY while holding the same per-run lock the supervisor
 * uses and only when the broker journal is aligned, so a concurrent resume
 * and this finalization can never both write authority, and no stale state
 * is ever sealed or applied. --take-best lands the incumbent on a branch.
 */
export async function stopCommand(args: string[], io: CmdIo, run: RunCommand = runCommand): Promise<number> {
  const { flags } = parseFlags(args, { booleans: ["take-best"], strings: ["run", "repo", "branch"] });
  const runDir = resolveRun(io.root, strFlag(flags, "run"));
  const runId = replayRun(runDir).runId ?? basename(runDir);
  const stopFlags: StopFlags = { takeBest: boolFlag(flags, "take-best"), repo: strFlag(flags, "repo"), branch: strFlag(flags, "branch") };
  // Endpoint authority mirrors the run path: only the default RunCommand has
  // an ambient docker client env to freeze; an injected seam IS the endpoint.
  const production = run === runCommand;

  // Argument validation and target resolution happen BEFORE any stop
  // request or dead-run finalization: a take-best whose flags are malformed
  // or whose target cannot be validated must not stop the run only to fail
  // the delivery afterwards.
  if (!stopFlags.takeBest && (stopFlags.repo !== undefined || stopFlags.branch !== undefined)) {
    throw new UsageError("--repo/--branch configure the post-stop delivery and require --take-best");
  }
  if (stopFlags.takeBest) {
    if (stopFlags.repo === undefined) {
      throw new UsageError("--take-best delivers into a repository — pass an explicit --repo DIR (delivery never defaults to the current root)");
    }
    try {
      authenticateCapsuleSnapshot(runDir);
      resolveDeliveryTarget(io.root, runDir, stopFlags.repo, "branch");
    } catch (e) {
      if (e instanceof UsageError) throw e;
      io.err(`refusing to stop: --take-best target does not validate: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  // The run's state machine can move underneath us — a concurrent resume can
  // acquire the run lock between our reads. Loop over a bounded number of
  // observations; the terminal-appending path only ever runs UNDER the lock,
  // so exactly one authority path (resume or finalization) wins.
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = replayRun(runDir);
    const lease = await confirmSupervisor(runDir, runId);

    if (state.finished !== null) {
      if (lease !== null) {
        // Terminal logged but the confirmed supervisor still holds its lock
        // (draining delivery/teardown). Wait on the LEASE, not the PID:
        // release is the identity-bound completion signal — the held
        // connection closes exactly when the holder releases or dies. After
        // release the identity is intentionally gone, so NOTHING gates on
        // the (recyclable) PID: the supervisor never touches the run again
        // after its awaited release, which makes release completion.
        const released = await releasedWithin(lease, 15_000);
        lease.close();
        if (!released) {
          io.err(`run ${runId}: run.finished is logged but the supervisor (pid ${lease.identity.pid}) has not released the run lock within 15s`);
          return 1;
        }
      }
      if (!journalAuthorityAligned(runId, runDir, io)) return 1;
      if (!(await dispatchAuthorityAligned(runId, runDir, io))) return 1;
      if (!(await resourcesSwept(runId, runDir, run, production, io))) return 1;
      io.out(`run ${runId} already finished (${state.finished.status})`);
      return takeBest(stopFlags, io, runDir);
    }

    if (lease !== null) {
      // Stop THROUGH the lease: a byte on the identity-bound lock connection
      // is the trusted stop request. No PID is ever signalled, so a holder
      // that released or died since the proof (whose PID the kernel may
      // already have handed to an unrelated process) is simply re-observed —
      // the write fails or lands on a socket nobody will read, and the lease
      // close tells us which. Kernel buffering delivers the byte to a
      // supervisor blocked in synchronous delivery once its loop resumes.
      if (!lease.requestStop()) {
        lease.close();
        await sleep(150);
        continue;
      }
      // Terminal order: callers apply the result right after we return. The
      // supervisor appends run.finished BEFORE its awaited lock release, so
      // waiting on the lease covers both — and unlike a replay/PID poll it
      // is bound to the exact holder the proof named. Release is completion;
      // no bare-PID wait follows it.
      const released = await releasedWithin(lease, 15_000);
      lease.close();
      if (!released) {
        io.err(`run ${runId}: supervisor (pid ${lease.identity.pid}) did not release the run lock within 15s of the stop request`);
        return 1;
      }
      const live = replayRun(runDir);
      if (live.finished === null) {
        io.err(
          `run ${runId}: supervisor (pid ${lease.identity.pid}) exited without a terminal event (teardown or delivery incomplete) — run left resumable; retry \`hone stop\``,
        );
        return 1;
      }
      if (!journalAuthorityAligned(runId, runDir, io)) return 1;
      if (!(await dispatchAuthorityAligned(runId, runDir, io))) return 1;
      if (!(await resourcesSwept(runId, runDir, run, production, io))) return 1;
      io.out(`run ${runId} stopped (${live.finished.status})`);
      return takeBest(stopFlags, io, runDir);
    }

    // No identity-confirmed supervisor: dead run, stale/unrelated sentinel,
    // or a holder that has not written its sentinel yet. Finalization NEVER
    // happens without the run lock — and never signals an unconfirmed PID.
    let release: () => Promise<void>;
    try {
      release = await acquireRunLock(runDir, runId);
    } catch (e) {
      if (e instanceof UsageError) {
        // Someone owns the run right now (e.g. a resume between lock and
        // sentinel write) — observe its outcome and retry.
        await sleep(150);
        continue;
      }
      throw e;
    }
    try {
      // Re-validate UNDER the lock: a resume may have started and finished
      // between our observation and this acquisition. Holding the lock also
      // proves no supervisor is live — a still-alive sentinel PID here is a
      // recycled number and must NOT block finalization (or be signalled).
      const under = replayRun(runDir);
      // Validate even an already-finished run before applying it. A stale
      // terminal must never turn an older public incumbent into authority.
      if (!journalAuthorityAligned(runId, runDir, io)) return 1;
      // Proxy dispatch authority gates BOTH branches below: an already-
      // finished historical terminal must not be applied over a failed
      // dispatch ledger, and a dead unfinished run must not be finalized
      // over one. Dead-stop NEVER mutates or recovers unmatched dispatches
      // (there is no live broker to deliver charges to) — reconciliation is
      // exclusively resume's.
      if (!(await dispatchAuthorityAligned(runId, runDir, io))) return 1;
      if (under.finished !== null) {
        if (!(await resourcesSwept(runId, runDir, run, production, io))) return 1;
        io.out(`run ${runId} already finished (${under.finished.status})`);
        return takeBest(stopFlags, io, runDir);
      }

      // Dead-stop delivery seal (release gate P1): the durable
      // optimizer-completion seal is written ONLY by a delivering run
      // (apply != none, incumbent present) strictly BEFORE its delivery
      // attempt. If it exists without a trusted delivery.applied, a crashed
      // supervisor may already have PUBLISHED a ref whose event never hit
      // the log (SIGKILL between update-ref and the append). Terminalizing
      // as stopped would seal that unrecorded publication forever — refuse,
      // and require a resume: its idempotent delivery recovery adopts or
      // completes the exact publication and records it before any terminal.
      let deliverySealed: boolean;
      try {
        deliverySealed = optimizerCompleteForRun(runDir, runId);
      } catch (e) {
        io.err(`run ${runId}: ${e instanceof Error ? e.message : String(e)} — refusing to finalize; resume with \`hone run --resume\``);
        return 1;
      }
      if (deliverySealed && !readEvents(runDir).some((event) => event.type === "delivery.applied")) {
        io.err(
          `run ${runId}: a delivering run completed its optimizer but no delivery.applied is logged — a crashed supervisor may have published a ref that was never recorded; refusing to finalize as stopped. Resume with \`hone run --resume\` to reconcile the delivery, then stop.`,
        );
        return 1;
      }

      if (!(await resourcesSwept(runId, runDir, run, production, io))) return 1;
      const best = under.incumbent?.artifact ?? null;
      appendEvent(runDir, {
        runId,
        at: new Date().toISOString(),
        type: "run.finished",
        ...(best !== null ? { best } : {}),
        status: "stopped",
      });
      io.out(`run ${runId}: supervisor not running — finalized log as stopped`);
      return takeBest(stopFlags, io, runDir);
    } finally {
      await release();
    }
  }

  io.err(`run ${runId}: run state kept changing underneath stop (live resume contention) — retry \`hone stop\``);
  return 1;
}

function takeBest(flags: StopFlags, io: CmdIo, runDir: string): Promise<number> | number {
  if (!flags.takeBest) return 0;
  return applyBest(io, { runDir, repo: flags.repo, branch: flags.branch });
}
