import { createHash, randomUUID } from "node:crypto";
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
  /** Per-run dir: sockets, scratch, unpack cache live here. */
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
   * trusted episode numbering stays monotone across restarts). Default 0.
   */
  episodeOrigin?: number | undefined;
}

interface SandboxEntry {
  containerId: string;
  expiresAtMs: number;
  /** Trusted episode ordinal assigned at creation (one per mutation sandbox). */
  episode: number;
  /** sha256 of the most recent exec stdout — trusted session-trace provenance. */
  lastExecStdoutHash: string | null;
}

const MISSING_CONTAINER_RE = /no such container|is not running|no such object/i;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

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
  private readonly scratchDir: string;
  private readonly proxySockPath: string;
  private readonly unpackRoot: string;
  private readonly tmpDir: string;
  private readonly scratchQuotaBytes: number;
  private readonly defaultTtlSec: number;
  private readonly evalTimeoutSec: number;
  private readonly execOutputLimitBytes: number;
  private readonly holdoutBudget: number;

  private readonly startedAtMs: number;
  private readonly spent = { tokens: 0, usd: 0, evaluatorInvocations: 0 };
  private readonly sandboxes = new Map<string, SandboxEntry>();
  private readonly exhaustedAnnounced = new Set<string>();
  private holdoutCount = 0;
  private lastIncumbent: ReportIncumbentP | undefined;
  private best: ArtifactRef | undefined;
  private reaper: NodeJS.Timeout | undefined;
  /** Next trusted episode ordinal (one per mutation sandbox created). */
  private episodeOrdinal: number;
  /** Ordinal of the most recently created mutation sandbox (stamps incumbent.new). */
  private lastEpisode: number | null = null;
  /** artifactHash -> trusted aggregate recomputed from this run's non-holdout EvaluationRecords. */
  private readonly trustedAggregates = new Map<string, number>();

  constructor(private readonly config: BrokerConfig) {
    this.manifest = CapsuleManifest.parse(config.manifest);
    this.cas = new CasStore(config.casDir);
    this.run = config.runCommand ?? runCommand;
    this.now = config.now ?? Date.now;
    this.scratchDir = path.join(config.runDir, "scratch");
    this.proxySockPath = path.join(config.runDir, "proxy.sock");
    this.unpackRoot = path.join(config.runDir, "unpacked");
    this.tmpDir = path.join(config.runDir, "tmp");
    this.scratchQuotaBytes = config.scratchQuotaBytes ?? 1024 * 1024 * 1024;
    this.defaultTtlSec = config.defaultTtlSec ?? 3_600;
    this.evalTimeoutSec = config.evalTimeoutSec ?? 600;
    this.execOutputLimitBytes = config.execOutputLimitBytes ?? 1024 * 1024;
    this.holdoutBudget = config.holdoutBudget ?? this.manifest.budget.maxEvaluatorInvocations;
    this.episodeOrdinal = config.episodeOrigin ?? 0;
    this.startedAtMs = this.now();
  }

  async init(): Promise<void> {
    await mkdir(this.scratchDir, { recursive: true });
    await mkdir(this.unpackRoot, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
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
    const size = await dirSizeBytes(this.scratchDir);
    if (size > this.scratchQuotaBytes) {
      throw new BrokerError("QUOTA_EXCEEDED", `scratch dir ${size}B exceeds quota ${this.scratchQuotaBytes}B`);
    }
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
   * Defense in depth: a mutation sandbox may see EXACTLY the scratch dir and
   * the proxy socket. Protected/holdout assets, credentials, the docker
   * socket, and the event log can never appear because nothing outside this
   * allowlist is mountable.
   */
  private assertMutationMounts(mounts: ReadonlyArray<{ host: string; container: string }>): void {
    const allowed = new Set([this.scratchDir, this.proxySockPath]);
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
    await this.checkScratchQuota();
    await this.requireArtifact(params.artifact.hash);

    // The proxy socket is the sandbox's ONLY egress. If the proxy has not
    // bound it yet, a placeholder keeps docker from creating a host DIRECTORY
    // at the path; real runs start the proxy before the first sandbox.
    try {
      await stat(this.proxySockPath);
    } catch {
      await writeFile(this.proxySockPath, "");
    }

    const mounts = [
      { host: this.scratchDir, container: "/scratch", mode: "rw" },
      { host: this.proxySockPath, container: "/run/hone/proxy.sock", mode: "rw" },
    ];
    this.assertMutationMounts(mounts);

    const sandboxId = `sb_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const safeRunId = this.config.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
    const net = this.config.sandboxNetwork ?? { mode: "none" };
    const networkArg = net.mode === "internal" ? net.network : "none";
    const argv = [
      "docker",
      "run",
      "-d",
      "--network",
      networkArg,
      "--name",
      `hone-${safeRunId}-${sandboxId}`,
      "--label",
      `hone.runId=${this.config.runId}`,
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
      stdinFile: this.cas.blobPath(params.artifact.hash),
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
    // Trusted episode boundary: one ordinal per mutation sandbox. The parent
    // artifact is whatever the client asked to unpack — recorded verbatim.
    const episode = this.episodeOrdinal++;
    this.lastEpisode = episode;
    this.sandboxes.set(sandboxId, { containerId, expiresAtMs: this.now() + ttlSec * 1000, episode, lastExecStdoutHash: null });
    this.emit({ type: "episode.started", episode, parent: { hash: params.artifact.hash } });
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
    sb.lastExecStdoutHash = `sha256:${createHash("sha256").update(res.stdout).digest("hex")}`;
    return {
      exitCode: res.timedOut ? 124 : res.exitCode,
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
    const hash = await this.cas.putBuffer(res.stdout);
    this.emit({ type: "episode.candidate", episode: sb.episode, candidate: { hash }, sessionTrace: sb.lastExecStdoutHash ?? "" });
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
      if (this.holdoutCount >= this.holdoutBudget) {
        throw new BrokerError("HOLDOUT_ACCESS_DENIED", "holdout ledger budget exhausted");
      }
      this.holdoutCount += 1;
      this.emit({
        type: "holdout.accessed",
        capsuleId: this.manifest.id,
        ledgerCount: this.holdoutCount,
        ledgerBudget: this.holdoutBudget,
      });
    }

    const memoKey = `${params.artifact.hash}|${this.manifest.id}|${params.assetGroupId}|${params.seed}`;
    const memoHash = await this.cas.indexGet("eval", memoKey);
    if (memoHash !== undefined && (await this.cas.has(memoHash))) {
      const record = EvaluationRecord.parse(JSON.parse((await this.cas.readBuffer(memoHash)).toString("utf8")));
      const cached = { ...record, cached: true };
      this.recordEvaluation(cached, group.visibility);
      return cached;
    }

    const workspaceDir = await this.ensureUnpacked(params.artifact.hash);
    if (params.artifact.hash !== this.config.baselineArtifactHash && this.manifest.protectedPaths.length > 0) {
      const baselineDir = await this.ensureUnpacked(this.config.baselineArtifactHash);
      const violations = await diffProtectedPaths(baselineDir, workspaceDir, this.manifest.protectedPaths);
      if (violations.length > 0) {
        throw new BrokerError("PROTECTED_PATH_VIOLATION", `protected paths modified: ${violations.join(", ")}`, {
          paths: violations,
        });
      }
    }

    // Count the invocation before the spawn so a crashed evaluator still burns
    // budget — candidates cannot farm free retries out of induced crashes.
    this.spent.evaluatorInvocations += 1;

    const argv = [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--label",
      `hone.runId=${this.config.runId}`,
      // Entrypoints are workspace-relative (e.g. ["python3", "eval.py"]);
      // never trust the image's WORKDIR.
      "-w",
      "/workspace",
      "-e",
      `HONE_SEED=${params.seed}`,
      "-v",
      `${workspaceDir}:/workspace:ro`,
    ];
    for (const rel of group.paths) {
      const host = this.resolveAssetHostPath(rel);
      try {
        await stat(host);
      } catch {
        throw new BrokerError("INTERNAL", `asset path missing on host: ${rel}`);
      }
      argv.push("-v", `${host}:${path.posix.join("/capsule/assets", rel)}:ro`);
    }
    argv.push(this.config.image, ...this.manifest.evalEntrypoint);

    const startedMs = Date.now();
    const res = await this.run(argv, { timeoutMs: this.evalTimeoutSec * 1000, maxOutputBytes: 32 * 1024 * 1024 });
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
    return record;
  }

  /**
   * Trusted scalarization (scoring default: mean of objective values) + the
   * eval.completed event. Holdout results NEVER enter the log or the
   * incumbent-verification table — scores of ledger-gated groups stay
   * admin-side. Invalid/objective-less outputs record no aggregate.
   */
  private recordEvaluation(record: EvaluationRecord, visibility: string): void {
    if (visibility === "holdout") return;
    const values = Object.values(record.output.objectives);
    if (!record.output.valid || values.length === 0) return;
    const aggregate = values.reduce((a, b) => a + b, 0) / values.length;
    if (!Number.isFinite(aggregate)) return;
    this.trustedAggregates.set(record.artifactHash, aggregate);
    this.emit({
      type: "eval.completed",
      artifact: { hash: record.artifactHash },
      assetGroupId: record.assetGroupId,
      seed: record.seed,
      aggregate,
      cached: record.cached,
    });
  }

  reportIncumbent(params: ReportIncumbentP, _ctx: CallContext): Record<string, never> {
    this.budgetGate();
    // Claimed metrics are display-only (contract 2); the incumbent event
    // carries the aggregate this broker measured itself. An artifact we never
    // evaluated cannot become incumbent.
    const trusted = this.trustedAggregates.get(params.artifact.hash);
    if (trusted === undefined) {
      throw new BrokerError("INTERNAL", `reportIncumbent: no trusted evaluation for artifact ${params.artifact.hash}`);
    }
    const baseline = this.trustedAggregates.get(this.config.baselineArtifactHash);
    this.lastIncumbent = params;
    this.emit({
      type: "incumbent.new",
      artifact: { hash: params.artifact.hash },
      aggregate: trusted,
      deltaVsBaseline: baseline === undefined ? trusted : trusted - baseline,
      episode: this.lastEpisode ?? 0,
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
    this.spent.tokens += params.tokens;
    this.spent.usd += params.usd;
    this.announceExhaustion();
    return {};
  }

  get incumbent(): ReportIncumbentP | undefined {
    return this.lastIncumbent;
  }

  get finishedBest(): ArtifactRef | undefined {
    return this.best;
  }
}

function stderrText(res: CmdResult): string {
  return res.stderr.toString("utf8").slice(0, 2_000);
}
