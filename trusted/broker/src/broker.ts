import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BudgetState,
  CapsuleManifest,
  CreateSandboxParams,
  EvaluateParams,
  EvaluationRecord,
  EvaluatorOutput,
  ExecParams,
  ExecResult,
  FinishParams,
  GetFileParams,
  GetFileResult,
  GetTaskResult,
  PutFileParams,
  ReportIncumbentParams,
  SandboxRef,
  SaveArtifactParams,
  type ArtifactRef,
  type RunEvent,
} from "@hone/schema";
import { diffProtectedPaths, dirSizeBytes, unpackArtifact } from "./artifact.js";
import { CasStore } from "./cas.js";
import { runCommand, type CmdResult, type RunCommand } from "./command.js";
import { BrokerError } from "./errors.js";
import { ArtifactValidationError, validateWorkspaceTar } from "./tarcheck.js";

/** Internal method (admin socket only): the proxy reports LLM spend. */
export const RecordSpendParams = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});

export interface CallContext {
  /** True only for connections on the trusted admin socket (broker-admin.sock). */
  privileged: boolean;
}

/** Mutation-sandbox network: fully isolated, or attached to a broker-managed internal network. */
export type SandboxNetworkMode = { mode: "none" } | { mode: "internal"; network: string };

export interface BrokerConfig {
  runId: string;
  manifest: CapsuleManifest;
  /** Directory holding the capsule's asset groups (paths in the manifest are relative to it). */
  capsuleRootDir: string;
  /** CAS hash of the trusted-measured baseline artifact. */
  baselineArtifactHash: string;
  /** OCI image for both mutation and eval sandboxes (seed: one image). */
  image: string;
  /** Per-run dir: sockets, scratch, unpack cache, durable run state live here. */
  runDir: string;
  /** Repo-wide CAS root (.hone-cas). */
  casDir: string;
  /** Event sink — the runner appends these to events.ndjson. The broker never touches the log itself. */
  onEvent: (event: RunEvent) => void;
  scratchQuotaBytes?: number | undefined;
  defaultTtlSec?: number | undefined;
  reaperIntervalMs?: number | undefined;
  evalTimeoutSec?: number | undefined;
  execOutputLimitBytes?: number | undefined;
  /** Lifetime holdout-access ledger budget; defaults to maxEvaluatorInvocations. */
  holdoutBudget?: number | undefined;
  /**
   * Network mode for MUTATION sandboxes only (WP7 macOS decision: proxy runs
   * as a container on a shared --internal network; sandboxes attach to it as
   * their only reachable endpoint). Eval sandboxes are ALWAYS --network none.
   * Default: { mode: "none" }.
   */
  sandboxNetwork?: SandboxNetworkMode | undefined;
  /**
   * Env injected into MUTATION sandboxes only (e.g. HONE_PROXY_BASE_URL,
   * HONE_PROXY_TOKEN) — trusted config, never transits the client protocol.
   */
  mutationEnv?: Record<string, string> | undefined;
  /** DI seam for the docker/tar CLI — tests observe container spawns through it. */
  runCommand?: RunCommand | undefined;
  /** Injectable clock (ms) for TTL/wall-clock determinism in tests. */
  now?: (() => number) | undefined;
  /**
   * First episode ordinal (resume: the runner passes replayed nextEpisode so
   * trusted episode numbering stays monotone across restarts). The broker's
   * own durable state is authoritative; the max of both wins. Default 0.
   */
  episodeOrigin?: number | undefined;
  /** Hard cap on simultaneously-live mutation sandboxes. Default 8. */
  maxActiveSandboxes?: number | undefined;
  /** docker --pids-limit for every container this broker spawns. Default 512. */
  sandboxPidsLimit?: number | undefined;
  /** docker --memory (bytes) for every container this broker spawns. Default 2 GiB. */
  sandboxMemoryBytes?: number | undefined;
  /** docker --cpus for every container this broker spawns. Default 2. */
  sandboxCpus?: number | undefined;
  /**
   * When true, /scratch is a per-run docker LOCAL tmpfs volume sized to
   * scratchQuotaBytes — the kernel enforces the quota at write time. If the
   * daemon cannot create such a volume, the broker falls back CLOSED to the
   * host bind mount whose polling quota (checkScratchQuota) still binds;
   * scratch is never silently unquota'd. Default false (host bind + polling).
   */
  scratchVolume?: boolean | undefined;
}

interface SandboxEntry {
  containerId: string;
  expiresAtMs: number;
  /** Trusted episode ordinal assigned at creation (one per mutation sandbox). */
  episode: number;
  /** Artifact the sandbox was unpacked from — trusted lineage parent for candidates it saves. */
  parentHash: string;
  /** sha256 of the most recent exec stdout — trusted session-trace provenance. */
  lastExecStdoutHash: string | null;
  /** Exit code of the most recent exec; a candidate save requires 0. */
  lastExecExitCode: number | null;
}

const MISSING_CONTAINER_RE = /no such container|is not running|no such object/i;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const STATE_FILE = "broker-state.ndjson";

type CreateSandboxP = z.infer<typeof CreateSandboxParams>;
type ExecP = z.infer<typeof ExecParams>;
type ExecR = z.infer<typeof ExecResult>;
type PutFileP = z.infer<typeof PutFileParams>;
type GetFileP = z.infer<typeof GetFileParams>;
type GetFileR = z.infer<typeof GetFileResult>;
type SaveArtifactP = z.infer<typeof SaveArtifactParams>;
type EvaluateP = z.infer<typeof EvaluateParams>;
type ReportIncumbentP = z.infer<typeof ReportIncumbentParams>;
type FinishP = z.infer<typeof FinishParams>;
type GetTaskR = z.infer<typeof GetTaskResult>;
type RecordSpendP = z.infer<typeof RecordSpendParams>;

/**
 * Trusted-side event derivation (WP7 boundary ruling): the mutable optimizer
 * has NO event authority — every RunEvent about its activity is derived here
 * from the broker method calls it makes, with scores recomputed from the
 * broker's own EvaluationRecords (claimed metrics are never trusted).
 */
type EmittableEvent =
  | { type: "budget.exhausted"; dimension: string }
  | { type: "holdout.accessed"; capsuleId: string; ledgerCount: number; ledgerBudget: number }
  | { type: "episode.started"; episode: number; parent: ArtifactRef }
  | { type: "episode.candidate"; episode: number; candidate: ArtifactRef; sessionTrace: string }
  | { type: "eval.completed"; artifact: ArtifactRef; assetGroupId: string; seed: number; aggregate: number; cached: boolean }
  | { type: "incumbent.new"; artifact: ArtifactRef; aggregate: number; deltaVsBaseline: number; episode: number }
  | { type: "budget.snapshot"; budget: BudgetState };

/**
 * Durable run-state journal, one JSON line per authority-bearing fact. Every
 * line is appended + fsynced BEFORE the corresponding action is acknowledged
 * (write-ahead), so a broker restart replays to exactly the authority and
 * budgets that were ever granted — resume can never reset them. All writes
 * are SYNCHRONOUS: single-threaded JS makes every check-then-append atomic,
 * which is what serializes concurrent holdout charges.
 */
const StateLine = z.discriminatedUnion("t", [
  z.object({ t: z.literal("start"), atMs: z.number() }),
  z.object({ t: z.literal("spend"), tokens: z.number().int().nonnegative(), usd: z.number().nonnegative() }),
  z.object({ t: z.literal("inv") }),
  z.object({ t: z.literal("holdout"), seq: z.number().int().positive() }),
  z.object({ t: z.literal("eval"), record: EvaluationRecord }),
  z.object({ t: z.literal("episode"), episode: z.number().int().nonnegative() }),
  z.object({ t: z.literal("lineage"), candidate: z.string(), parent: z.string(), episode: z.number().int().nonnegative() }),
  z.object({ t: z.literal("repair"), hash: z.string(), parent: z.string(), episode: z.number().int().nonnegative() }),
  z.object({ t: z.literal("incumbent"), hash: z.string(), aggregate: z.number(), episode: z.number().int().nonnegative() }),
]);
type StateLine = z.infer<typeof StateLine>;

class RunStateLog {
  private constructor(
    private readonly fd: number,
    readonly replayed: readonly StateLine[],
  ) {}

  static open(filePath: string): RunStateLog {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // Only newline-terminated lines exist; a trailing partial is a torn
    // crash-write whose action was never acknowledged — discard it.
    const rawLines = content.split("\n");
    rawLines.pop();
    const replayed = rawLines.map((line, i) => {
      try {
        return StateLine.parse(JSON.parse(line));
      } catch {
        throw new BrokerError("INTERNAL", `run state log corrupt at line ${i + 1}: ${filePath}`);
      }
    });
    return new RunStateLog(openSync(filePath, "a"), replayed);
  }

  /** Append + fsync, blocking. Returns only once the line is durable. */
  append(line: StateLine): void {
    writeSync(this.fd, `${JSON.stringify(line)}\n`);
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/**
 * Trusted scalarization gate: a record grants promotion authority only when
 * the evaluator declared it valid, produced at least one finite objective,
 * and EVERY constraint passed. Returns the aggregate (mean of objectives) or
 * undefined for ineligible records.
 */
function eligibleAggregate(record: EvaluationRecord): number | undefined {
  const out = record.output;
  if (!out.valid) return undefined;
  const values = Object.values(out.objectives);
  if (values.length === 0 || !values.every((v) => Number.isFinite(v))) return undefined;
  if (!Object.values(out.constraints).every(Boolean)) return undefined;
  const aggregate = values.reduce((a, b) => a + b, 0) / values.length;
  return Number.isFinite(aggregate) ? aggregate : undefined;
}

/**
 * Sandbox broker (review IV.1): the optimizer is an unprivileged CLIENT; all
 * containers are SIBLINGS spawned by this trusted daemon via the docker CLI.
 * No global state — everything hangs off the config so the runner (WP7) can
 * compose several brokers in one process.
 */
export class Broker {
  readonly manifest: CapsuleManifest;
  readonly cas: CasStore;
  private readonly run: RunCommand;
  private readonly now: () => number;
  private readonly safeRunId: string;
  private readonly scratchDir: string;
  private readonly proxySockPath: string;
  private readonly unpackRoot: string;
  private readonly tmpDir: string;
  private readonly scratchQuotaBytes: number;
  private readonly defaultTtlSec: number;
  private readonly evalTimeoutSec: number;
  private readonly execOutputLimitBytes: number;
  private readonly holdoutBudget: number;
  private readonly maxActiveSandboxes: number;
  private readonly sandboxPidsLimit: number;
  private readonly sandboxMemoryBytes: number;
  private readonly sandboxCpus: number;

  private startedAtMs: number;
  private readonly spent = { tokens: 0, usd: 0, evaluatorInvocations: 0 };
  private readonly sandboxes = new Map<string, SandboxEntry>();
  private readonly exhaustedAnnounced = new Set<string>();
  private holdoutCount = 0;
  private lastIncumbent: ReportIncumbentP | undefined;
  private best: ArtifactRef | undefined;
  private reaper: NodeJS.Timeout | undefined;
  /** Next trusted episode ordinal (one per mutation sandbox created). */
  private episodeOrdinal: number;
  /** True once any episode of this RUN (including replayed ones) started — gates eval.completed emission. */
  private anyEpisodeStarted = false;
  /**
   * artifactHash -> (assetGroupId|seed -> trusted aggregate) over this run's
   * ELIGIBLE non-holdout EvaluationRecords — the only promotion authority.
   */
  private readonly trusted = new Map<string, Map<string, number>>();
  /** Candidate artifact -> trusted lineage (parent it was mutated from + episode). */
  private readonly lineage = new Map<string, { parent: string; episode: number }>();
  /** Failed-exec repair snapshots: NOT candidates; sandboxes resumed from one reuse its episode. */
  private readonly repairs = new Map<string, { parent: string; episode: number }>();
  /** Trusted current incumbent — promotion is monotone against this. */
  private currentIncumbent: { hash: string; aggregate: number; episode: number } | undefined;
  private stateLog: RunStateLog | undefined;
  /** Set when /scratch is a quota-enforcing docker tmpfs volume (else host bind + polling quota). */
  private scratchVolumeName: string | undefined;

  constructor(private readonly config: BrokerConfig) {
    this.manifest = CapsuleManifest.parse(config.manifest);
    assertAssetGroupIsolation(this.manifest);
    assertAssetPathsResolveSafely(this.manifest, config.capsuleRootDir);
    this.cas = new CasStore(config.casDir);
    this.run = config.runCommand ?? runCommand;
    this.now = config.now ?? Date.now;
    this.safeRunId = config.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
    this.scratchDir = path.join(config.runDir, "scratch");
    this.proxySockPath = path.join(config.runDir, "proxy.sock");
    this.unpackRoot = path.join(config.runDir, "unpacked");
    this.tmpDir = path.join(config.runDir, "tmp");
    this.scratchQuotaBytes = config.scratchQuotaBytes ?? 1024 * 1024 * 1024;
    this.defaultTtlSec = config.defaultTtlSec ?? 3_600;
    this.evalTimeoutSec = config.evalTimeoutSec ?? 600;
    this.execOutputLimitBytes = config.execOutputLimitBytes ?? 1024 * 1024;
    this.holdoutBudget = config.holdoutBudget ?? this.manifest.budget.maxEvaluatorInvocations;
    this.maxActiveSandboxes = config.maxActiveSandboxes ?? 8;
    this.sandboxPidsLimit = config.sandboxPidsLimit ?? 512;
    this.sandboxMemoryBytes = config.sandboxMemoryBytes ?? 2 * 1024 * 1024 * 1024;
    this.sandboxCpus = config.sandboxCpus ?? 2;
    this.episodeOrdinal = config.episodeOrigin ?? 0;
    this.startedAtMs = this.now();
    // Durable state opens (and replays) synchronously at construction — a
    // broker NEVER exists without its journal, so no method can act before
    // replay and no acknowledged fact can be lost to ordering.
    mkdirSync(config.runDir, { recursive: true });
    this.replayState(RunStateLog.open(path.join(config.runDir, STATE_FILE)));
  }

  async init(): Promise<void> {
    await mkdir(this.scratchDir, { recursive: true });
    await mkdir(this.unpackRoot, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    if (this.config.scratchVolume) await this.provisionScratchVolume();
    const interval = this.config.reaperIntervalMs ?? 30_000;
    this.reaper = setInterval(() => {
      void this.reapExpired();
    }, interval);
    this.reaper.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.reaper);
    const ids = [...this.sandboxes.values()].map((s) => s.containerId);
    this.sandboxes.clear();
    await Promise.all(ids.map((id) => this.run(["docker", "rm", "-f", id])));
    if (this.scratchVolumeName !== undefined) {
      await this.run(["docker", "volume", "rm", "-f", this.scratchVolumeName]);
      this.scratchVolumeName = undefined;
    }
    this.stateLog?.close();
    this.stateLog = undefined;
  }

  // ---------- durable run state ----------

  private state(): RunStateLog {
    if (!this.stateLog) throw new BrokerError("INTERNAL", "broker is closed");
    return this.stateLog;
  }

  /** Replays the journal into in-memory authority/budget state. Never emits events. */
  private replayState(log: RunStateLog): void {
    this.stateLog = log;
    let firstStartMs: number | undefined;
    for (const line of log.replayed) {
      switch (line.t) {
        case "start":
          firstStartMs ??= line.atMs;
          break;
        case "spend":
          this.spent.tokens += line.tokens;
          this.spent.usd += line.usd;
          break;
        case "inv":
          this.spent.evaluatorInvocations += 1;
          break;
        case "holdout":
          if (line.seq !== this.holdoutCount + 1) {
            throw new BrokerError("INTERNAL", `run state log corrupt: holdout seq ${line.seq}, expected ${this.holdoutCount + 1}`);
          }
          this.holdoutCount = line.seq;
          break;
        case "eval":
          this.acceptRecord(line.record);
          break;
        case "episode":
          this.episodeOrdinal = Math.max(this.episodeOrdinal, line.episode + 1);
          this.anyEpisodeStarted = true;
          break;
        case "lineage":
          this.lineage.set(line.candidate, { parent: line.parent, episode: line.episode });
          break;
        case "repair":
          this.repairs.set(line.hash, { parent: line.parent, episode: line.episode });
          break;
        case "incumbent":
          this.currentIncumbent = { hash: line.hash, aggregate: line.aggregate, episode: line.episode };
          break;
      }
    }
    // Wall clock is metered from the FIRST start of this run, ever — a
    // restart cannot rewind it.
    if (firstStartMs === undefined) {
      log.append({ t: "start", atMs: this.startedAtMs });
    } else {
      this.startedAtMs = Math.min(firstStartMs, this.startedAtMs);
    }
  }

  /** Stores an eligible record in the trusted table. Returns its aggregate on first sight, else undefined. */
  private acceptRecord(record: EvaluationRecord): number | undefined {
    const aggregate = eligibleAggregate(record);
    if (aggregate === undefined) return undefined;
    let perArtifact = this.trusted.get(record.artifactHash);
    if (!perArtifact) {
      perArtifact = new Map();
      this.trusted.set(record.artifactHash, perArtifact);
    }
    const pairKey = `${record.assetGroupId}|${record.seed}`;
    if (perArtifact.has(pairKey)) return undefined;
    perArtifact.set(pairKey, aggregate);
    return aggregate;
  }

  // ---------- events + budget ----------

  private emit(event: EmittableEvent): void {
    const full: RunEvent = {
      runId: this.config.runId,
      at: new Date(this.now()).toISOString(),
      ...event,
    };
    this.config.onEvent(full);
  }

  private budgetStateNow(): BudgetState {
    return BudgetState.parse({
      envelope: this.manifest.budget,
      spent: {
        tokens: this.spent.tokens,
        usd: this.spent.usd,
        wallClockSec: (this.now() - this.startedAtMs) / 1000,
        evaluatorInvocations: this.spent.evaluatorInvocations,
      },
    });
  }

  private announceExhaustion(): string | undefined {
    const e = this.manifest.budget;
    let dim: string | undefined;
    if (this.spent.tokens >= e.maxTokens) dim = "tokens";
    else if (this.spent.usd >= e.maxUsd) dim = "usd";
    else if ((this.now() - this.startedAtMs) / 1000 >= e.maxWallClockSec) dim = "wallClockSec";
    else if (this.spent.evaluatorInvocations >= e.maxEvaluatorInvocations) dim = "evaluatorInvocations";
    if (dim !== undefined && !this.exhaustedAnnounced.has(dim)) {
      this.exhaustedAnnounced.add(dim);
      this.emit({ type: "budget.exhausted", dimension: dim });
    }
    return dim;
  }

  /** Every metered method calls this; getBudget/finish/recordSpend stay reachable for observability + teardown. */
  private budgetGate(): void {
    const dim = this.announceExhaustion();
    if (dim !== undefined) throw new BrokerError("BUDGET_EXCEEDED", `budget dimension exhausted: ${dim}`);
  }

  // ---------- helpers ----------

  private async requireArtifact(hash: string): Promise<void> {
    if (!(await this.cas.has(hash))) throw new BrokerError("INTERNAL", `artifact not in CAS: ${hash}`);
  }

  /**
   * Reads a CAS artifact and validates its tar layout (WP-ArchiveWire
   * contract): a hash in CAS is NOT trusted to be well-formed — malformed or
   * hostile archives (symlinks, .. paths, non-workspace roots) are rejected
   * before any extraction or container sees them.
   */
  private async readValidatedArtifact(hash: string): Promise<Buffer> {
    await this.requireArtifact(hash);
    const bytes = await this.cas.readBuffer(hash);
    try {
      validateWorkspaceTar(bytes);
    } catch (err) {
      if (err instanceof ArtifactValidationError) {
        throw new BrokerError("INTERNAL", `artifact ${hash} rejected: ${err.message}`, {
          reason: err.reason,
          ...(err.entryName !== undefined ? { entryName: err.entryName } : {}),
        });
      }
      throw err;
    }
    return bytes;
  }

  private async requireSandbox(sandboxId: string): Promise<SandboxEntry> {
    const entry = this.sandboxes.get(sandboxId);
    if (!entry) throw new BrokerError("SANDBOX_NOT_FOUND", `unknown sandbox: ${sandboxId}`);
    if (this.now() >= entry.expiresAtMs) {
      this.sandboxes.delete(sandboxId);
      await this.run(["docker", "rm", "-f", entry.containerId]);
      throw new BrokerError("SANDBOX_NOT_FOUND", `sandbox expired: ${sandboxId}`);
    }
    return entry;
  }

  private async reapExpired(): Promise<void> {
    const nowMs = this.now();
    for (const [id, entry] of [...this.sandboxes]) {
      if (nowMs >= entry.expiresAtMs) {
        this.sandboxes.delete(id);
        await this.run(["docker", "rm", "-f", entry.containerId]);
      }
    }
  }

  private async checkScratchQuota(): Promise<void> {
    // Volume mode: the tmpfs size cap enforces the quota at write time.
    if (this.scratchVolumeName !== undefined) return;
    const size = await dirSizeBytes(this.scratchDir);
    if (size > this.scratchQuotaBytes) {
      throw new BrokerError("QUOTA_EXCEEDED", `scratch dir ${size}B exceeds quota ${this.scratchQuotaBytes}B`);
    }
  }

  /**
   * Attempts a per-run size-capped tmpfs volume for /scratch. On ANY failure
   * the broker falls back to the host bind mount, whose polling quota
   * (checkScratchQuota) still binds — the fallback fails closed, never
   * silently unquota'd.
   */
  private async provisionScratchVolume(): Promise<void> {
    const name = `hone-scratch-${this.safeRunId}`;
    const res = await this.run(
      [
        "docker", "volume", "create",
        "--driver", "local",
        "--opt", "type=tmpfs",
        "--opt", "device=tmpfs",
        "--opt", `o=size=${this.scratchQuotaBytes}`,
        "--label", `hone.runId=${this.config.runId}`,
        name,
      ],
      { timeoutMs: 30_000 },
    );
    if (res.exitCode === 0) this.scratchVolumeName = name;
  }

  private missingContainer(res: CmdResult, sandboxId: string): BrokerError | undefined {
    if (res.exitCode !== 0 && MISSING_CONTAINER_RE.test(res.stderr.toString("utf8"))) {
      this.sandboxes.delete(sandboxId);
      return new BrokerError("SANDBOX_NOT_FOUND", `sandbox container gone: ${sandboxId}`);
    }
    return undefined;
  }

  /** Absolute in-container path; relative paths resolve against /workspace. */
  private containerPath(p: string): string {
    const abs = path.posix.normalize(p.startsWith("/") ? p : path.posix.join("/workspace", p));
    if (abs === "/run/hone/proxy.sock" || abs.startsWith("/run/hone/")) {
      throw new BrokerError("INTERNAL", `path not allowed: ${abs}`);
    }
    return abs;
  }

  /**
   * Defense in depth: a mutation sandbox may see EXACTLY the scratch mount
   * (host dir or the run's quota volume) and the proxy socket. Protected/
   * holdout assets, credentials, the docker socket, and the event log can
   * never appear because nothing outside this allowlist is mountable.
   */
  private assertMutationMounts(mounts: ReadonlyArray<{ host: string; container: string }>): void {
    const allowed = new Set([this.scratchVolumeName ?? this.scratchDir, this.proxySockPath]);
    for (const m of mounts) {
      if (!allowed.has(m.host)) throw new BrokerError("INTERNAL", `mount not allowlisted: ${m.host}`);
    }
  }

  private resolveAssetHostPath(rel: string): string {
    const abs = path.resolve(this.config.capsuleRootDir, rel);
    const relBack = path.relative(this.config.capsuleRootDir, abs);
    if (relBack.startsWith("..") || path.isAbsolute(relBack)) {
      throw new BrokerError("INTERNAL", `asset path escapes capsule root: ${rel}`);
    }
    return abs;
  }

  private async ensureUnpacked(hash: string): Promise<string> {
    await this.requireArtifact(hash);
    return unpackArtifact(this.cas, hash, this.unpackRoot, this.run);
  }

  /** Shared per-container resource ceilings (mutation AND eval containers). */
  private resourceArgs(): string[] {
    return [
      "--pids-limit", String(this.sandboxPidsLimit),
      "--memory", String(this.sandboxMemoryBytes),
      "--cpus", String(this.sandboxCpus),
      "--security-opt", "no-new-privileges",
    ];
  }

  // ---------- methods ----------

  getTask(_ctx: CallContext): GetTaskR {
    this.budgetGate();
    return {
      capsuleId: this.manifest.id,
      objective: this.manifest.objective,
      baselineArtifact: { hash: this.config.baselineArtifactHash },
      visibleAssetGroups: this.manifest.assetGroups.filter((g) => g.visibility !== "holdout").map((g) => g.id),
      budget: this.budgetStateNow(),
    };
  }

  async createSandbox(params: CreateSandboxP, _ctx: CallContext): Promise<SandboxRef> {
    this.budgetGate();
    if (this.sandboxes.size >= this.maxActiveSandboxes) {
      throw new BrokerError("QUOTA_EXCEEDED", `active sandbox cap reached (${this.maxActiveSandboxes})`);
    }
    await this.checkScratchQuota();
    // A CAS hash is not trusted layout — validate the archive before any
    // container extracts it.
    const artifactBytes = await this.readValidatedArtifact(params.artifact.hash);

    // The proxy socket is the sandbox's ONLY egress. If the proxy has not
    // bound it yet, a placeholder keeps docker from creating a host DIRECTORY
    // at the path; real runs start the proxy before the first sandbox.
    try {
      await stat(this.proxySockPath);
    } catch {
      await writeFile(this.proxySockPath, "");
    }

    const mounts = [
      { host: this.scratchVolumeName ?? this.scratchDir, container: "/scratch", mode: "rw" },
      { host: this.proxySockPath, container: "/run/hone/proxy.sock", mode: "rw" },
    ];
    this.assertMutationMounts(mounts);

    const sandboxId = `sb_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const net = this.config.sandboxNetwork ?? { mode: "none" };
    const networkArg = net.mode === "internal" ? net.network : "none";
    const argv = [
      "docker",
      "run",
      "-d",
      "--network",
      networkArg,
      "--name",
      `hone-${this.safeRunId}-${sandboxId}`,
      "--label",
      `hone.runId=${this.config.runId}`,
      ...this.resourceArgs(),
      "-w",
      "/workspace",
    ];
    // Trusted-side env injection (WP7 contract with WP5): proxy endpoint +
    // per-run bearer reach mutation sandboxes via broker config, never over
    // the client wire protocol. Values are role-scoped and metered; the
    // upstream credentials themselves never enter any sandbox.
    for (const [k, v] of Object.entries(this.config.mutationEnv ?? {})) {
      argv.push("-e", `${k}=${v}`);
    }
    for (const m of mounts) argv.push("-v", `${m.host}:${m.container}:${m.mode}`);
    argv.push(this.config.image, "sleep", "2147483647");

    const res = await this.run(argv, { timeoutMs: 120_000 });
    if (res.exitCode !== 0) throw new BrokerError("INTERNAL", `docker run failed: ${stderrText(res)}`);
    const containerId = res.stdout.toString("utf8").trim();

    const unpack = await this.run(["docker", "cp", "-", `${containerId}:/`], {
      stdin: artifactBytes,
      timeoutMs: 300_000,
    });
    if (unpack.exitCode !== 0) {
      await this.run(["docker", "rm", "-f", containerId]);
      throw new BrokerError("INTERNAL", `artifact unpack failed: ${stderrText(unpack)}`);
    }

    // `docker cp` preserves the tar's host uid; the image may run as a
    // different unprivileged user — hand the workspace to whoever execs run as.
    const whoami = await this.run(["docker", "exec", containerId, "sh", "-c", "echo \"$(id -u):$(id -g)\""]);
    const owner = whoami.stdout.toString("utf8").trim();
    const chown =
      whoami.exitCode === 0 && /^\d+:\d+$/.test(owner)
        ? await this.run(["docker", "exec", "-u", "root", containerId, "chown", "-R", owner, "/workspace"])
        : whoami;
    if (chown.exitCode !== 0) {
      await this.run(["docker", "rm", "-f", containerId]);
      throw new BrokerError("INTERNAL", `workspace ownership fixup failed: ${stderrText(chown)}`);
    }

    const ttlSec = params.ttlSec ?? this.defaultTtlSec;
    // Trusted episode boundary: one ordinal per mutation sandbox — EXCEPT a
    // sandbox resumed from a failed-exec repair snapshot, which safely
    // continues the snapshot's original episode (the snapshot was never a
    // candidate, so no episode boundary passed).
    const repair = this.repairs.get(params.artifact.hash);
    let episode: number;
    let parentHash: string;
    if (repair !== undefined) {
      episode = repair.episode;
      parentHash = repair.parent;
    } else {
      episode = this.episodeOrdinal;
      parentHash = params.artifact.hash;
      // Durable BEFORE the ordinal is observable anywhere — a restart can
      // never hand out the same episode twice.
      this.state().append({ t: "episode", episode });
      this.episodeOrdinal = episode + 1;
      this.anyEpisodeStarted = true;
    }
    this.sandboxes.set(sandboxId, {
      containerId,
      expiresAtMs: this.now() + ttlSec * 1000,
      episode,
      parentHash,
      lastExecStdoutHash: null,
      lastExecExitCode: null,
    });
    if (repair === undefined) this.emit({ type: "episode.started", episode, parent: { hash: parentHash } });
    return { sandboxId };
  }

  async exec(params: ExecP, _ctx: CallContext): Promise<ExecR> {
    this.budgetGate();
    const sb = await this.requireSandbox(params.sandboxId);
    const argv = ["docker", "exec", "-i"];
    if (params.cwd !== undefined) argv.push("-w", params.cwd);
    argv.push(sb.containerId, ...params.argv);
    const res = await this.run(argv, {
      stdin: params.stdin ?? "",
      timeoutMs: (params.timeoutSec ?? 600) * 1000,
      maxOutputBytes: this.execOutputLimitBytes,
    });
    const gone = this.missingContainer(res, params.sandboxId);
    if (gone) throw gone;
    if (res.timedOut) {
      // Killing the local docker CLI does NOT kill in-container work — the
      // sandbox may still be running arbitrary code. Invalidate and remove it
      // so the orphan cannot keep computing against the run.
      this.sandboxes.delete(params.sandboxId);
      await this.run(["docker", "rm", "-f", sb.containerId]);
      return { exitCode: 124, stdout: res.stdout.toString("utf8"), stderr: res.stderr.toString("utf8"), truncated: res.truncated };
    }
    sb.lastExecExitCode = res.exitCode;
    sb.lastExecStdoutHash = `sha256:${createHash("sha256").update(res.stdout).digest("hex")}`;
    return {
      exitCode: res.exitCode,
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr.toString("utf8"),
      truncated: res.truncated,
    };
  }

  async putFile(params: PutFileP, _ctx: CallContext): Promise<Record<string, never>> {
    this.budgetGate();
    const sb = await this.requireSandbox(params.sandboxId);
    const target = this.containerPath(params.path);
    const mkdirRes = await this.run(["docker", "exec", sb.containerId, "mkdir", "-p", path.posix.dirname(target)]);
    const goneMkdir = this.missingContainer(mkdirRes, params.sandboxId);
    if (goneMkdir) throw goneMkdir;
    if (mkdirRes.exitCode !== 0) throw new BrokerError("INTERNAL", `mkdir failed: ${stderrText(mkdirRes)}`);

    const tmp = path.join(this.tmpDir, `put-${randomUUID()}`);
    await writeFile(tmp, Buffer.from(params.contentBase64, "base64"));
    try {
      const cp = await this.run(["docker", "cp", tmp, `${sb.containerId}:${target}`]);
      const gone = this.missingContainer(cp, params.sandboxId);
      if (gone) throw gone;
      if (cp.exitCode !== 0) throw new BrokerError("INTERNAL", `docker cp failed: ${stderrText(cp)}`);
    } finally {
      await rm(tmp, { force: true });
    }
    return {};
  }

  async getFile(params: GetFileP, _ctx: CallContext): Promise<GetFileR> {
    this.budgetGate();
    const sb = await this.requireSandbox(params.sandboxId);
    const target = this.containerPath(params.path);
    const res = await this.run(["docker", "exec", sb.containerId, "cat", target], {
      maxOutputBytes: 64 * 1024 * 1024,
    });
    const gone = this.missingContainer(res, params.sandboxId);
    if (gone) throw gone;
    if (res.exitCode !== 0) throw new BrokerError("INTERNAL", `read failed: ${stderrText(res)}`);
    if (res.truncated) throw new BrokerError("QUOTA_EXCEEDED", `file too large: ${target}`);
    return { contentBase64: res.stdout.toString("base64") };
  }

  async saveArtifact(params: SaveArtifactP, _ctx: CallContext): Promise<ArtifactRef> {
    this.budgetGate();
    const sb = await this.requireSandbox(params.sandboxId);
    await this.checkScratchQuota();
    const res = await this.run(["docker", "cp", `${sb.containerId}:/workspace`, "-"], {
      maxOutputBytes: MAX_ARTIFACT_BYTES,
      timeoutMs: 300_000,
    });
    const gone = this.missingContainer(res, params.sandboxId);
    if (gone) throw gone;
    if (res.exitCode !== 0) throw new BrokerError("INTERNAL", `docker cp out failed: ${stderrText(res)}`);
    if (res.truncated) throw new BrokerError("QUOTA_EXCEEDED", "artifact exceeds size cap");
    // The sandbox ran adversarial code — its tar is untrusted until the
    // archive validator accepts it. Nothing malformed ever enters CAS.
    try {
      validateWorkspaceTar(res.stdout);
    } catch (err) {
      if (err instanceof ArtifactValidationError) {
        throw new BrokerError("INTERNAL", `saved artifact rejected: ${err.message}`, {
          reason: err.reason,
          ...(err.entryName !== undefined ? { entryName: err.entryName } : {}),
        });
      }
      throw err;
    }
    const hash = await this.cas.putBuffer(res.stdout);

    if (sb.lastExecExitCode === 0) {
      // Candidate: the last exec in the episode exited 0. Durable lineage
      // BEFORE the candidate event — promotion authority survives restarts.
      if (!this.lineage.has(hash) && hash !== sb.parentHash) {
        this.state().append({ t: "lineage", candidate: hash, parent: sb.parentHash, episode: sb.episode });
        this.lineage.set(hash, { parent: sb.parentHash, episode: sb.episode });
        this.emit({ type: "episode.candidate", episode: sb.episode, candidate: { hash }, sessionTrace: sb.lastExecStdoutHash ?? "" });
      }
    } else if (hash !== sb.parentHash && !this.lineage.has(hash) && !this.repairs.has(hash)) {
      // Repair snapshot (no exec, or last exec failed): NOT a candidate, no
      // event; remembered so a follow-up sandbox reuses the original episode.
      this.state().append({ t: "repair", hash, parent: sb.parentHash, episode: sb.episode });
      this.repairs.set(hash, { parent: sb.parentHash, episode: sb.episode });
    }
    return { hash };
  }

  async evaluate(params: EvaluateP, ctx: CallContext): Promise<EvaluationRecord> {
    this.budgetGate();
    const group = this.manifest.assetGroups.find((g) => g.id === params.assetGroupId);
    if (!group) throw new BrokerError("INTERNAL", `unknown asset group: ${params.assetGroupId}`);

    if (group.visibility === "holdout") {
      if (!ctx.privileged) {
        throw new BrokerError("HOLDOUT_ACCESS_DENIED", "holdout asset groups are only reachable on the admin socket");
      }
      this.chargeHoldout();
    }

    const memoKey = `${params.artifact.hash}|${this.manifest.id}|${params.assetGroupId}|${params.seed}`;
    const memoHash = await this.cas.indexGet("eval", memoKey);
    if (memoHash !== undefined && (await this.cas.has(memoHash))) {
      const record = EvaluationRecord.parse(JSON.parse((await this.cas.readBuffer(memoHash)).toString("utf8")));
      const cached = { ...record, cached: true };
      this.recordEvaluation(cached, group.visibility);
      return this.redactRecord(cached, group.visibility, ctx);
    }

    const workspaceDir = await this.ensureUnpacked(params.artifact.hash);
    // The evaluator ALWAYS runs from the frozen baseline tree — candidate
    // code cannot substitute its own copy of the evaluator (scoring attack).
    const baselineDir = await this.ensureUnpacked(this.config.baselineArtifactHash);
    if (params.artifact.hash !== this.config.baselineArtifactHash && this.manifest.protectedPaths.length > 0) {
      const violations = await diffProtectedPaths(baselineDir, workspaceDir, this.manifest.protectedPaths);
      if (violations.length > 0) {
        throw new BrokerError("PROTECTED_PATH_VIOLATION", `protected paths modified: ${violations.join(", ")}`, {
          paths: violations,
        });
      }
    }

    // Resolve asset mounts BEFORE burning the invocation: a missing host
    // asset is trusted-side misconfiguration, not an attempted evaluation.
    const assetMounts: string[] = [];
    for (const rel of group.paths) {
      const host = this.resolveAssetHostPath(rel);
      try {
        await stat(host);
      } catch {
        throw new BrokerError("INTERNAL", `asset path missing on host: ${rel}`);
      }
      assetMounts.push("-v", `${host}:${path.posix.join("/capsule/assets", rel)}:ro`);
    }

    // Burn the invocation DURABLY before the spawn so a crashed evaluator (or
    // a crashed broker) still counts — candidates cannot farm free retries,
    // and a restart replays the charge.
    this.state().append({ t: "inv" });
    this.spent.evaluatorInvocations += 1;

    const evalName = `hone-${this.safeRunId}-eval-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const argv = [
      "docker",
      "run",
      "--rm",
      "--name",
      evalName,
      "--network",
      "none",
      "--label",
      `hone.runId=${this.config.runId}`,
      ...this.resourceArgs(),
      "--read-only",
      "--tmpfs",
      "/tmp",
      // Entrypoints are baseline-relative; the candidate workspace is DATA,
      // never the working directory the evaluator executes from.
      "-w",
      "/trusted/baseline",
      "-e",
      `HONE_SEED=${params.seed}`,
      "-v",
      `${workspaceDir}:/workspace:ro`,
      "-v",
      `${baselineDir}:/trusted/baseline:ro`,
      ...assetMounts,
    ];
    argv.push(this.config.image, ...this.manifest.evalEntrypoint);

    const startedMs = Date.now();
    let res: CmdResult;
    try {
      res = await this.run(argv, { timeoutMs: this.evalTimeoutSec * 1000, maxOutputBytes: 32 * 1024 * 1024 });
    } finally {
      // A timed-out `docker run` kills only the local CLI; the container (and
      // the adversarial code inside it) keeps running. Always reap by name —
      // a no-op for containers --rm already removed.
      await this.run(["docker", "rm", "-f", evalName]);
    }
    const durationMs = Date.now() - startedMs;
    if (res.timedOut) throw new BrokerError("INTERNAL", `evaluator timed out after ${this.evalTimeoutSec}s`);
    if (res.exitCode !== 0) throw new BrokerError("INTERNAL", `evaluator exited ${res.exitCode}: ${stderrText(res)}`);

    let output: EvaluatorOutput;
    try {
      output = EvaluatorOutput.parse(JSON.parse(res.stdout.toString("utf8")));
    } catch (err) {
      throw new BrokerError("INTERNAL", `evaluator emitted invalid EvaluatorOutput: ${String(err)}`);
    }

    const record = EvaluationRecord.parse({
      capsuleId: this.manifest.id,
      artifactHash: params.artifact.hash,
      assetGroupId: params.assetGroupId,
      seed: params.seed,
      output,
      costUsd: 0, // eval containers have no network — no LLM spend to attribute
      durationMs,
      cached: false,
      evaluatedAt: new Date().toISOString(),
    });
    const recordHash = await this.cas.putBuffer(Buffer.from(JSON.stringify(record)));
    await this.cas.indexPut("eval", memoKey, recordHash);
    this.recordEvaluation(record, group.visibility);
    this.emit({ type: "budget.snapshot", budget: this.budgetStateNow() });
    return this.redactRecord(record, group.visibility, ctx);
  }

  /**
   * Write-ahead holdout charge against the durable ledger. Synchronous
   * check-then-append — single-threaded JS serializes concurrent charges, so
   * the budget can never be double-granted.
   */
  private chargeHoldout(): void {
    if (this.holdoutCount >= this.holdoutBudget) {
      throw new BrokerError("HOLDOUT_ACCESS_DENIED", "holdout ledger budget exhausted");
    }
    const seq = this.holdoutCount + 1;
    this.state().append({ t: "holdout", seq });
    this.holdoutCount = seq;
    this.emit({
      type: "holdout.accessed",
      capsuleId: this.manifest.id,
      ledgerCount: seq,
      ledgerBudget: this.holdoutBudget,
    });
  }

  /**
   * Trusted scalarization + the eval.completed event. Holdout results NEVER
   * enter the log or the promotion table — scores of ledger-gated groups stay
   * admin-side. Ineligible outputs (invalid, objective-less, non-finite, or
   * any failed constraint) grant no authority. Pre-episode evaluations (the
   * optimizer measuring its parent before any sandbox exists) populate
   * authority but emit nothing — the event log keeps episode.started first.
   */
  private recordEvaluation(record: EvaluationRecord, visibility: string): void {
    if (visibility === "holdout") return;
    const aggregate = this.acceptRecord(record);
    if (aggregate === undefined) return;
    // Durable BEFORE the event: replayed authority is exactly what was announced.
    this.state().append({ t: "eval", record });
    if (!this.anyEpisodeStarted) return;
    this.emit({
      type: "eval.completed",
      artifact: { hash: record.artifactHash },
      assetGroupId: record.assetGroupId,
      seed: record.seed,
      aggregate,
      cached: record.cached,
    });
  }

  /**
   * Result minimization at the trust boundary: unprivileged clients querying
   * a PROTECTED asset group get scores only — per-example feedback, example
   * ids, and evaluator diagnostics stay admin-side (they exist to leak).
   */
  private redactRecord(record: EvaluationRecord, visibility: string, ctx: CallContext): EvaluationRecord {
    if (ctx.privileged || visibility === "public") return record;
    return {
      ...record,
      output: {
        valid: record.output.valid,
        objectives: record.output.objectives,
        constraints: record.output.constraints,
        perExample: {},
      },
    };
  }

  /**
   * Promotion authority (contract 2): the client's report is a HINT. An
   * artifact becomes incumbent only when this broker's own eligible records
   * prove it — same-group/same-seed paired child-vs-parent positive delta,
   * plus monotone improvement over the current incumbent on paired records.
   * Claimed metrics are never read.
   */
  reportIncumbent(params: ReportIncumbentP, _ctx: CallContext): Record<string, never> {
    this.budgetGate();
    const hash = params.artifact.hash;
    if (this.currentIncumbent?.hash === hash) return {}; // idempotent re-report

    const lin = this.lineage.get(hash);
    if (!lin) {
      throw new BrokerError("INTERNAL", `reportIncumbent: ${hash} is not a saved candidate of this run (no lineage)`);
    }
    const cand = this.trusted.get(hash);
    if (!cand || cand.size === 0) {
      throw new BrokerError("INTERNAL", `reportIncumbent: no trusted evaluation for artifact ${hash}`);
    }
    const parentScores = this.trusted.get(lin.parent);
    const pairedParent = parentScores === undefined ? [] : [...cand.keys()].filter((k) => parentScores.has(k));
    if (parentScores === undefined || pairedParent.length === 0) {
      throw new BrokerError(
        "INTERNAL",
        "reportIncumbent: insufficient authority — no same-group/same-seed paired evaluations of candidate and parent",
      );
    }
    const deltaVsParent = meanOver(cand, pairedParent) - meanOver(parentScores, pairedParent);
    if (!(deltaVsParent > 0)) {
      throw new BrokerError("INTERNAL", `reportIncumbent: no positive trusted delta vs parent (paired delta ${deltaVsParent})`);
    }
    const inc = this.currentIncumbent;
    if (inc !== undefined && inc.hash !== lin.parent) {
      const incScores = this.trusted.get(inc.hash);
      const pairedInc = incScores === undefined ? [] : [...cand.keys()].filter((k) => incScores.has(k));
      if (incScores === undefined || pairedInc.length === 0) {
        throw new BrokerError(
          "INTERNAL",
          "reportIncumbent: insufficient authority — no paired evaluations of candidate and current incumbent",
        );
      }
      const deltaVsInc = meanOver(cand, pairedInc) - meanOver(incScores, pairedInc);
      if (!(deltaVsInc > 0)) {
        throw new BrokerError("INTERNAL", `reportIncumbent: not an improvement over current incumbent (paired delta ${deltaVsInc})`);
      }
    }

    const aggregate = meanOver(cand, [...cand.keys()]);
    const baselineScores = this.trusted.get(this.config.baselineArtifactHash);
    const deltaVsBaseline =
      baselineScores !== undefined && baselineScores.size > 0
        ? aggregate - meanOver(baselineScores, [...baselineScores.keys()])
        : aggregate;

    // Durable BEFORE the ack and the event — a restart replays exactly the
    // promotions that were announced.
    this.state().append({ t: "incumbent", hash, aggregate, episode: lin.episode });
    this.currentIncumbent = { hash, aggregate, episode: lin.episode };
    this.lastIncumbent = params;
    this.emit({
      type: "incumbent.new",
      artifact: { hash },
      aggregate,
      deltaVsBaseline,
      episode: lin.episode,
    });
    this.emit({ type: "budget.snapshot", budget: this.budgetStateNow() });
    return {};
  }

  getBudget(_ctx: CallContext): BudgetState {
    return this.budgetStateNow();
  }

  finish(params: FinishP, _ctx: CallContext): Record<string, never> {
    this.best = params.best;
    return {};
  }

  notImplemented(): never {
    this.budgetGate();
    throw new BrokerError("NOT_IMPLEMENTED", "reserved method — not available in the seed");
  }

  recordSpend(params: RecordSpendP, ctx: CallContext): Record<string, never> {
    if (!ctx.privileged) throw new BrokerError("INTERNAL", "recordSpend requires the admin socket");
    // Durable BEFORE the counters move — an acked spend survives restart.
    this.state().append({ t: "spend", tokens: params.tokens, usd: params.usd });
    this.spent.tokens += params.tokens;
    this.spent.usd += params.usd;
    this.announceExhaustion();
    return {};
  }

  get incumbent(): ReportIncumbentP | undefined {
    return this.lastIncumbent;
  }

  /** Trusted current incumbent (survives restarts via the run state log). */
  get trustedIncumbent(): { hash: string; aggregate: number; episode: number } | undefined {
    return this.currentIncumbent;
  }

  get finishedBest(): ArtifactRef | undefined {
    return this.best;
  }
}

function meanOver(scores: Map<string, number>, keys: readonly string[]): number {
  let sum = 0;
  for (const k of keys) sum += scores.get(k) ?? 0;
  return sum / keys.length;
}

/**
 * Preflight (constructor): asset-group paths must not overlap or nest across
 * visibility classes — otherwise mounting a public group could smuggle
 * protected/holdout files into a container that must never see them.
 */
function assertAssetGroupIsolation(manifest: CapsuleManifest): void {
  const entries = manifest.assetGroups.flatMap((g) =>
    g.paths.map((p) => ({ group: g.id, visibility: g.visibility, path: path.posix.normalize(p).replace(/\/+$/, "") })),
  );
  for (const e of entries) {
    if (e.path.startsWith("..") || path.posix.isAbsolute(e.path)) {
      throw new BrokerError("INTERNAL", `asset group ${e.group}: path escapes capsule root: ${e.path}`);
    }
  }
  for (const [i, a] of entries.entries()) {
    for (const b of entries.slice(i + 1)) {
      if (a.visibility === b.visibility) continue;
      // "." mounts the whole capsule root — it is an ancestor of everything.
      if (a.path === "." || b.path === "." || a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`)) {
        throw new BrokerError(
          "INTERNAL",
          `asset group paths overlap across visibility classes: ${a.group}:${a.path} (${a.visibility}) vs ${b.group}:${b.path} (${b.visibility})`,
        );
      }
    }
  }
}

/**
 * Preflight (constructor), filesystem half: the overlap check above is
 * LEXICAL, so a symlink inside the capsule root could still alias one
 * visibility class into another (public/train -> holdout). Reject any
 * symlink component in a declared asset path, require every path to exist,
 * and require its resolution to stay inside the (resolved) capsule root.
 * Fails closed at boot — independent of whatever capsule ingestion rejects.
 */
function assertAssetPathsResolveSafely(manifest: CapsuleManifest, capsuleRootDir: string): void {
  const realRoot = realpathSync(capsuleRootDir);
  for (const g of manifest.assetGroups) {
    for (const rel of g.paths) {
      const norm = path.posix.normalize(rel).replace(/\/+$/, "");
      let cur = capsuleRootDir;
      for (const part of norm.split("/")) {
        if (part === "." || part === "") continue;
        cur = path.join(cur, part);
        let st;
        try {
          st = lstatSync(cur);
        } catch {
          throw new BrokerError("INTERNAL", `asset group ${g.id}: asset path missing on host: ${rel}`);
        }
        if (st.isSymbolicLink()) {
          throw new BrokerError(
            "INTERNAL",
            `asset group ${g.id}: symlink in asset path is not allowed: ${path.relative(capsuleRootDir, cur)}`,
          );
        }
      }
      const real = realpathSync(path.join(capsuleRootDir, norm));
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new BrokerError("INTERNAL", `asset group ${g.id}: asset path escapes capsule root after resolution: ${rel}`);
      }
    }
  }
}

function stderrText(res: CmdResult): string {
  return res.stderr.toString("utf8").slice(0, 2_000);
}
