import type { BrokerCorpusConfig, BrokerRecursiveConfig, TrustedEvaluationStrategy } from "@hone/broker";
import type {
  ArtifactRef,
  BudgetState,
  CampaignPauseSignal,
  CampaignResumeSignal,
  CapsuleManifest,
  M2ProxyRole,
  RunConfig,
  RunEvent,
} from "@hone/schema";
import type { RunState } from "./eventlog.js";
import type { OptimizerSnapshot } from "./optimizer-digest.js";

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

export interface CampaignDispatchFence {
  readonly epoch: string;
  readonly paused: boolean;
}

export interface CampaignDispatchFenceValidation {
  readonly allowPaused: boolean;
}

/** Campaign-wide authority shared by outer and descendant trusted runners. */
export interface CampaignPauseAuthority {
  /** Durable campaign identity, required for M2 run/resume sealing. */
  readonly configHash?: string | undefined;
  /** Exact durable authority file identity for campaign session sealing. */
  readonly path?: string | undefined;
  /** Snapshot used to reject a pause transition racing an admitted provider call. */
  captureCampaignDispatchFence?(): CampaignDispatchFence;
  /** Final synchronous pre-dispatch comparison; implementations refresh durable state. */
  validateCampaignDispatchFence?(
    epoch: string,
    validation: CampaignDispatchFenceValidation,
  ): boolean;
  isCampaignPaused(): boolean;
  recordCampaignPause(signal: CampaignPauseSignal): void | Promise<void>;
  recordCampaignResume(signal: CampaignResumeSignal): void | Promise<void>;
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
  /** Candidate-selected merged closure; takes precedence over the captured base at execution. */
  optimizerSnapshot?: OptimizerSnapshot | undefined;
  /** Exact campaign/default base closure captured once during trusted admission. */
  optimizerBaseSnapshot?: OptimizerSnapshot | undefined;
  /** Trusted M1 full-run replicate identity, absent on M0. */
  measurementEpoch?: string | undefined;
  /** Trusted outer-broker evaluator; never serialized or exposed to a sandbox. */
  evaluationStrategy?: TrustedEvaluationStrategy | undefined;
  /** Total optimizer episodes for this trusted run. M0 leaves this absent. */
  optimizerEpisodesMax?: number | undefined;
  /** Distinct public candidate admissions. M0 leaves this absent (broker default 1). */
  maxPublicCandidateEvaluations?: number | undefined;
  /** Trusted outer-only target of distinct valid non-baseline strategy results. */
  trustedValidPublicCandidateTarget?: number | undefined;
  /** Holdout groups released only inside a terminal-latched child run. */
  terminalHoldoutAssetGroupIds?: readonly string[] | undefined;
  /** Frozen M2 proxy bearer role. Absent only for legacy M0/M1 mutation routing. */
  proxyRole?: M2ProxyRole | undefined;
  /** Shared durable M2 provider-pause authority. */
  campaignPauseAuthority?: CampaignPauseAuthority | undefined;
  /** Explicitly off only for a trusted synthetic capsule's post-seal byte validation. */
  admissionReview?: "required" | "off" | undefined;
  /** Trusted spawnRun authority for M2 outer/descendant brokers. */
  recursiveBroker?: BrokerRecursiveConfig | undefined;
  /** Frozen development-corpus wire config (M2); trusted-only, never from CLI flags or run config. */
  corpus?: BrokerCorpusConfig | undefined;
  /**
   * Calibration host binding (trusted plan only): the aggregate cgroup parent
   * every sandbox container is created under, and the exact Docker engine
   * id the binding was inspected on. Absent on ungrouped M0/M1 runs.
   */
  sandboxCgroupParent?: string | undefined;
  sandboxDockerEngineId?: string | undefined;
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
