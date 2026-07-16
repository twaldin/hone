import type { ArtifactRef, BudgetState, CapsuleManifest, RunConfig, RunEvent } from "@hone/schema";
import type { RunState } from "./eventlog.js";

/** Minimal duck-typed child handle so the supervisor can SIGTERM-then-SIGKILL real backends. */
export interface ChildLike {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Trusted paired measurement derived from broker events after the bounded
 * probe invocation — the numbers the owner approves before the full run.
 */
export interface ProbeReport {
  baseline: { artifact: ArtifactRef; aggregate: number };
  candidate: { artifact: ArtifactRef; aggregate: number; delta: number } | null;
  /** True only when the broker journal records this exact candidate as the episode's sole promoted incumbent. */
  promoted: boolean;
  assetGroupId: string;
  seed: number;
  budget: BudgetState;
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
  /** Canonical digest of the admitted capsule manifest (sha256:<64 hex>). */
  capsuleDigest: string;
  /** Sealed optimizer digest (sha256:<64 hex>) — computed or explicitly pinned. */
  optimizerDigest: string;
  /** State replayed from the event log — resume dedupe starts here (nextEpisode, incumbent, budget). */
  replayed: RunState;
  /** Aborted on stop request or budget exhaustion; backends must wind down. */
  signal: AbortSignal;
  /** Validate + append to events.ndjson (and stream in headless mode). */
  emit(event: RunEvent): RunEvent;
  /**
   * Register a spawned process for SIGTERM-then-SIGKILL enforcement. Returns
   * an unregister closure: a backend that has POSITIVELY reaped a child (and
   * its process group) MUST unregister it, or a much-later stop would signal
   * a recycled PID/PGID wearing the dead child's number. A child that exits
   * on abort or with a failure stays registered — the supervisor's
   * TERM→KILL barrier still owns its cleanup.
   */
  registerChild(child: ChildLike): () => void;
  /**
   * Probe gate (VI.4): called once with the trusted paired report after the
   * bounded first invocation. Resolves true to continue the full run;
   * false = owner declined — the backend must request a trusted stop.
   * Headless supervisors auto-approve.
   */
  probeGate(report: ProbeReport): Promise<boolean>;
  /**
   * Request a trusted stop: the supervisor aborts, reaps children, and
   * terminalizes the run with status "stopped" (same path as SIGTERM).
   */
  requestStop(): void;
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
  /**
   * Full-teardown barrier. A backend that opens external resources
   * (containers, broker, proxy, egress network, temp snapshots) MUST
   * register a promise SYNCHRONOUSLY before its first await. The supervisor
   * never delivers, emits run.finished, or returns until it settles:
   * resolution proves every resource is fully closed; rejection (or a
   * timeout) means cleanup is incomplete — the supervisor fails the run
   * WITHOUT a terminal event so it stays resumable. Backends that never
   * register are clean by default.
   */
  registerCleanupBarrier(barrier: Promise<void>): void;
}

export interface RunnerBackend {
  start(ctx: RunnerBackendContext): Promise<void>;
}
