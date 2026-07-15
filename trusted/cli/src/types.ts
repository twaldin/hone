import type { CapsuleManifest, RunConfig, RunEvent } from "@hone/schema";
import type { RunState } from "./eventlog.js";

/** Minimal duck-typed child handle so the supervisor can SIGTERM-then-SIGKILL real backends. */
export interface ChildLike {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Everything a backend needs, injected by the supervisor. WP7's real backend
 * composes broker + proxy + optimizer behind this same interface; this
 * package's tests use scripted backends.
 */
export interface RunnerBackendContext {
  runId: string;
  root: string;
  runDir: string;
  casDir: string;
  capsuleDir: string;
  manifest: CapsuleManifest;
  config: RunConfig;
  env: NodeJS.ProcessEnv;
  /** State replayed from the event log — resume dedupe starts here (nextEpisode, incumbent, budget). */
  replayed: RunState;
  /** Aborted on stop request or budget exhaustion; backends must wind down. */
  signal: AbortSignal;
  /** Validate + append to events.ndjson (and stream in headless mode). */
  emit(event: RunEvent): RunEvent;
  /** Register spawned processes for SIGTERM-then-SIGKILL enforcement. */
  registerChild(child: ChildLike): void;
  /**
   * Trusted-authority barrier. A backend that recovers durable authority
   * (broker journal reconciliation) MUST register a promise SYNCHRONOUSLY
   * before its first await: the supervisor will not fence backend events,
   * deliver, or emit run.finished until it settles. Rejection means trusted
   * authority could not be established — the supervisor fails the run
   * WITHOUT a terminal event so it stays resumable. Backends that never
   * register are ready by default.
   */
  registerAuthorityBarrier(barrier: Promise<void>): void;
}

export interface RunnerBackend {
  start(ctx: RunnerBackendContext): Promise<void>;
}
