import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ApplyMode, BudgetEnvelope, ModelRouting, PromotionRule, RunConfig, RunEvent } from "@hone/schema";
import type { BudgetState, CapsuleManifest, DiagnosticOrderingReport } from "@hone/schema";
import { admitCapsule, revalidateForResume, writeCapsuleSnapshot } from "./admission.js";
import { UsageError, boolFlag, parseFlags, strFlag } from "./args.js";
import { createBackend as createLocalBackend } from "./backends/local.js";
import { createBackend as createStubBackend } from "./backends/stub.js";
import { applyContractRevision, budgetEnvelopeError, contractHash, renderContract } from "./contract.js";
import { LadderLockedError, deliver, isGitRepo, ladderLocked, LADDER_REFUSAL } from "./deliver.js";
import { appendEvent, readEvents, replayRun } from "./eventlog.js";
import type { RunState } from "./eventlog.js";
import type { CmdIo } from "./io.js";
import { resolveOptimizerDigest } from "./optimizer-digest.js";
import { deferred, sleep } from "./promise.js";
import { exitReport, formatDelta, formatHumanReport, formatSpend } from "./report.js";
import { resumeSealError } from "./resume-seal.js";
import {
  CONTRACT_FILE,
  SUPERVISOR_FILE,
  casRoot,
  findResumableRun,
  loadRunConfigFile,
  mintRunId,
  runsRoot,
  writeRunConfigFile,
} from "./runs.js";
import type { ChildLike, ProbeReport, RunnerBackend, RunnerBackendContext } from "./types.js";

const RUN_USAGE =
  "usage: hone run <capsule-dir> [--headless] [--budget-usd N] [--apply none|branch|pr|auto] [--resume] [--backend stub|local|<module>] [--config <json>]";

/** Optional per-run overrides (routing, seat, seed, budget dims, promotion rule) — the CLI flags cover the common ones. */
const ConfigOverrides = z
  .object({
    routing: ModelRouting.optional(),
    apply: ApplyMode.optional(),
    headless: z.boolean().optional(),
    improverSeat: z.boolean().optional(),
    seed: z.number().int().nonnegative().optional(),
    budget: BudgetEnvelope.partial().optional(),
    promotion: PromotionRule.optional(),
  })
  .strict();
type ConfigOverrides = z.infer<typeof ConfigOverrides>;

/** Structural check at the plugin boundary: anything with a callable start(ctx). */
function coerceBackend(candidate: unknown): RunnerBackend | null {
  if (candidate === null || typeof candidate !== "object" || !("start" in candidate)) return null;
  const start: unknown = candidate.start;
  if (typeof start !== "function") return null;
  // Runtime-verified callable; the parameter/return types are unknowable at the plugin boundary.
  const startFn = start as (ctx: RunnerBackendContext) => unknown;
  return {
    start: async (ctx: RunnerBackendContext): Promise<void> => {
      await startFn.call(candidate, ctx);
    },
  };
}

function loadBackendModule(mod: unknown, spec: string): RunnerBackend {
  if (mod !== null && typeof mod === "object") {
    if ("createBackend" in mod) {
      const factory: unknown = mod.createBackend;
      if (typeof factory === "function") {
        const backend = coerceBackend(factory.call(mod));
        if (backend !== null) return backend;
        throw new UsageError(`backend module ${spec}: createBackend() did not return a { start } object`);
      }
    }
    if ("default" in mod) {
      const backend = coerceBackend(mod.default);
      if (backend !== null) return backend;
    }
  }
  throw new UsageError(`backend module ${spec} must export createBackend() or a default { start } object`);
}

/** Backends compiled into the trusted CLI — selectable without any trust escape hatch. */
const BUILTIN_BACKENDS: Record<string, true> = { local: true, stub: true };

export const UNSAFE_BACKEND_REFUSAL =
  "--backend <module> loads arbitrary code into the trusted supervisor process and is a test-only seam; production runs use the built-in backends (local, stub). Set HONE_UNSAFE_BACKEND=1 to acknowledge the trust collapse in a development run.";

/** Checked BEFORE any run state exists — a refused spec never mints a run. */
export function backendSpecAllowed(spec: string, env: NodeJS.ProcessEnv): boolean {
  return BUILTIN_BACKENDS[spec] === true || env["HONE_UNSAFE_BACKEND"] === "1";
}

async function loadBackend(spec: string, root: string, env: NodeJS.ProcessEnv): Promise<RunnerBackend> {
  if (spec === "local") return createLocalBackend();
  if (spec === "stub") return createStubBackend();
  if (!backendSpecAllowed(spec, env)) throw new UsageError(UNSAFE_BACKEND_REFUSAL);
  const url = pathToFileURL(resolve(root, spec)).href;
  // Plugin boundary (dev/test only, gated above): the module is runtime-selected via --backend.
  const mod: unknown = await import(url);
  return loadBackendModule(mod, spec);
}

interface RunPlan {
  runId: string;
  runDir: string;
  config: RunConfig;
  resumed: boolean;
}

/** Default mutation model for a bare `hone run` (no --config): HONE_MODEL_ID or glm-5.2 via the standard upstream. */
const DEFAULT_MUTATION_MODEL = "glm-5.2";

function buildConfig(
  manifest: CapsuleManifest,
  overrides: ConfigOverrides,
  flags: { headless: boolean; apply: string | undefined; budgetUsd: number | undefined; backend: string },
  env: NodeJS.ProcessEnv,
): RunConfig {
  const routing: ModelRouting = { ...(overrides.routing ?? {}) };
  if (routing["mutation"] === undefined) {
    // Bare run: default the mutation route so `hone run <capsule>` works with
    // zero config. The upstream base URL stays the proxy's single configured
    // default (vibeproxy); only the model id is chosen here.
    routing["mutation"] = { model: env["HONE_MODEL_ID"] ?? DEFAULT_MUTATION_MODEL };
  }
  const config = RunConfig.parse({
    version: 1,
    capsuleId: manifest.id,
    objective: manifest.objective,
    budget: {
      ...manifest.budget,
      ...(overrides.budget ?? {}),
      ...(flags.budgetUsd !== undefined ? { maxUsd: flags.budgetUsd } : {}),
    },
    routing,
    apply: flags.apply ?? overrides.apply ?? "none",
    headless: flags.headless || overrides.headless === true,
    // Sealed at run creation: a resume with an absent --backend reuses it;
    // a conflicting flag refuses (see runCommand's resume branch).
    backend: flags.backend,
    improverSeat: overrides.improverSeat ?? false,
    seed: overrides.seed ?? 0,
    ...(overrides.promotion !== undefined ? { promotion: overrides.promotion } : {}),
  });
  // Hard upper envelope (same validator as interactive E-edits): a --config or
  // --budget-usd value above the frozen capsule manifest refuses HERE, before
  // any run state exists. Tightening (or exact-cap) always passes.
  const envelopeError = budgetEnvelopeError(config.budget, manifest.budget);
  if (envelopeError !== null) throw new UsageError(envelopeError);
  return config;
}

/**
 * Interactive approval loop. `E` opens $EDITOR on the contract; afterwards the
 * unique executable run-config block is parsed back, validated (frozen
 * capsule id, capsule budget envelope, ladder), and the WHOLE contract is
 * re-rendered from the approved config so no narrative goes stale. Any
 * revision that does not survive that pipeline fails closed: no run starts.
 * Returns the approved (possibly revised) config, or null when declined.
 */
async function promptApproval(
  contractPath: string,
  seal: { runId: string; manifest: CapsuleManifest; capsuleDigest: string; optimizerDigest: string; orderingReport: DiagnosticOrderingReport },
  initial: RunConfig,
  io: CmdIo,
): Promise<RunConfig | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let config = initial;
  try {
    for (;;) {
      io.out("");
      io.out(readFileSync(contractPath, "utf8"));
      io.out(`(contract on disk: ${contractPath})`);
      const answer = (await rl.question("approve run contract? [Y]es / [E]dit / [N]o: ")).trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") return config;
      if (answer === "n" || answer === "no") return null;
      if (answer === "e" || answer === "edit") {
        const editor = io.env["EDITOR"] ?? io.env["VISUAL"] ?? "vi";
        const before = readFileSync(contractPath, "utf8");
        spawnSync(editor, [contractPath], { stdio: "inherit" });
        const after = readFileSync(contractPath, "utf8");
        if (after === before) continue;
        const outcome = applyContractRevision({ preEdit: before, edited: after, original: config, manifest: seal.manifest, env: io.env });
        if (!outcome.ok) {
          io.err(`contract revision rejected (fail closed): ${outcome.error}`);
          return null;
        }
        config = outcome.config;
        writeFileSync(contractPath, renderContract({ ...seal, config }));
        io.out("contract re-rendered from the revised run config — re-review before approving:");
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * M0 VI.4 headless probe policy: the probe is ONE paired eval + approval —
 * NOT the N≥2 statistical PromotionGate (that rule stays frozen in the
 * contract and governs the M1 outer champion decision; consulting it here
 * would make a one-eval probe mathematically impossible). Headless
 * auto-approves only a VALID completed pair whose broker-authored candidate
 * delta is strictly positive; anything else declines and the run stops.
 */
export function headlessProbeVerdict(report: ProbeReport): boolean {
  return report.candidate !== null && report.candidate.delta > 0;
}

/**
 * Interactive probe gate: print the trusted paired measurement, ask to
 * continue. Abort-aware (exported for the abort-during-probe regression): a
 * stop landing while the question is pending resolves false immediately —
 * the backend then observes the aborted signal and seals NO durable verdict,
 * so the run stays resumable and re-gates on the next resume. `streams` is a
 * DI seam for tests; production reads the real TTY.
 */
export async function promptProbe(
  report: ProbeReport,
  io: CmdIo,
  signal: AbortSignal,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<boolean> {
  if (signal.aborted) return false;
  const rl = createInterface({ input: streams.input, output: streams.output });
  try {
    io.out("");
    io.out("probe episode complete — trusted paired measurement (broker events, not optimizer claims):");
    io.out(`  baseline  ${report.baseline.artifact.hash}  aggregate ${report.baseline.aggregate}`);
    if (report.candidate !== null) {
      io.out(`  candidate ${report.candidate.artifact.hash}  aggregate ${report.candidate.aggregate} (Δ ${formatDelta(report.candidate.delta)})`);
    } else {
      io.out("  candidate: none produced by the probe episode");
    }
    io.out(`  measured on ${report.assetGroupId} (seed ${report.seed}) | ${formatSpend(report.budget)}`);
    for (;;) {
      let answer: string;
      try {
        answer = (await rl.question("continue the full run? [Y]es / [N]o: ", { signal })).trim().toLowerCase();
      } catch {
        return false; // aborted mid-question — no verdict
      }
      if (answer === "" || answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  } finally {
    rl.close();
  }
}

export async function runCommand(args: string[], io: CmdIo): Promise<number> {
  const { positionals, flags } = parseFlags(args, {
    booleans: ["headless", "resume"],
    // Deliberately NO --repo: automatic delivery always targets io.root; the
    // operator-driven `hone apply/stop --repo` remains the explicit path.
    strings: ["budget-usd", "apply", "backend", "config"],
  });
  const capsuleArg = positionals[0];
  if (capsuleArg === undefined) throw new UsageError(RUN_USAGE);
  const capsuleDir = resolve(io.root, capsuleArg);

  const configPath = strFlag(flags, "config");
  const overrides: ConfigOverrides = configPath
    ? ConfigOverrides.parse(JSON.parse(readFileSync(resolve(io.root, configPath), "utf8")))
    : {};
  const budgetUsdRaw = strFlag(flags, "budget-usd");
  const budgetUsd = budgetUsdRaw !== undefined ? Number(budgetUsdRaw) : undefined;
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
    throw new UsageError("--budget-usd must be a nonnegative number");
  }
  const applyFlag = strFlag(flags, "apply");
  if (applyFlag !== undefined && !ApplyMode.safeParse(applyFlag).success) {
    throw new UsageError(`--apply must be one of ${ApplyMode.options.join("|")}`);
  }
  // Production default: the trusted local backend. Arbitrary module specs are
  // refused here, before a runId is minted or any run state touches disk.
  const backendFlag = strFlag(flags, "backend");
  if (backendFlag !== undefined && !backendSpecAllowed(backendFlag, io.env)) {
    io.err(UNSAFE_BACKEND_REFUSAL);
    return 2;
  }

  // Frozen admission (M0 conformance): id recompute, exact asset-hash set,
  // hashed+schema-validated ordering report, clean baseline worktree — all
  // BEFORE any run state exists. The optimizer identity resolves here too, so
  // a refused digest never mints a run.
  const admitted = admitCapsule(capsuleDir);
  const manifest = admitted.manifest;
  const optimizerDigest = resolveOptimizerDigest(io.env, manifest.image);

  let plan: RunPlan;
  if (boolFlag(flags, "resume")) {
    const found = findResumableRun(io.root, manifest.id);
    if (found === null) throw new UsageError(`nothing to resume: no unfinished run for capsule ${manifest.id} under ${runsRoot(io.root)}`);
    // The capsule must re-admit at the EXACT digest snapshotted when the run
    // was created, and the optimizer identity sealed into run.started must
    // still describe the optimizer that would relaunch.
    revalidateForResume(found.runDir, capsuleDir);
    if (found.state.optimizerDigest !== null && found.state.optimizerDigest !== optimizerDigest) {
      throw new UsageError(
        `optimizer drift since the run started: digest ${optimizerDigest} != sealed ${found.state.optimizerDigest} — refusing to resume (start a fresh run)`,
      );
    }
    const config = loadRunConfigFile(found.runDir);
    // The backend is sealed at run creation: an absent flag reuses it; a
    // conflicting flag refuses. The stored spec still passes the trust gate
    // (a module spec needs HONE_UNSAFE_BACKEND=1 on THIS invocation too).
    if (backendFlag !== undefined && backendFlag !== config.backend) {
      throw new UsageError(`--backend ${backendFlag} conflicts with the run's sealed backend "${config.backend}" — resume without --backend, or start a fresh run`);
    }
    if (!backendSpecAllowed(config.backend, io.env)) {
      io.err(UNSAFE_BACKEND_REFUSAL);
      return 2;
    }
    // Headless is sealed too: absence preserves the stored mode; --headless
    // on a run approved interactively (stored false) may NOT flip it — the
    // probe gate and stop semantics the owner approved would silently change.
    if (boolFlag(flags, "headless") && !config.headless) {
      throw new UsageError("--headless conflicts with the run's sealed interactive mode (headless=false) — resume without --headless, or start a fresh run");
    }
    plan = { runId: found.runId, runDir: found.runDir, config, resumed: true };
  } else {
    let config = buildConfig(
      manifest,
      overrides,
      {
        headless: boolFlag(flags, "headless"),
        apply: applyFlag,
        budgetUsd,
        backend: backendFlag ?? "local",
      },
      io.env,
    );

    // Autonomy-ladder lock (review IV.2): trusted-side, checked before ANY run state exists.
    if (ladderLocked(config.apply, config.improverSeat, io.env)) {
      io.err(LADDER_REFUSAL);
      return 3;
    }
    if (!config.headless && !io.isTTY) {
      io.err("interactive contract approval requires a TTY; re-run with --headless to auto-approve");
      return 2;
    }

    const runId = mintRunId();
    const runDir = join(runsRoot(io.root), runId);
    mkdirSync(runDir, { recursive: true });
    // Snapshot the ADMITTED manifest: resume proves capsule identity against it.
    writeCapsuleSnapshot(runDir, manifest);
    const seal = { runId, manifest, capsuleDigest: admitted.digest, optimizerDigest, orderingReport: admitted.orderingReport };
    writeFileSync(join(runDir, CONTRACT_FILE), renderContract({ ...seal, config }));
    if (!config.headless) {
      const approved = await promptApproval(join(runDir, CONTRACT_FILE), seal, config, io);
      if (approved === null) {
        rmSync(runDir, { recursive: true, force: true });
        io.err("contract declined — no run started");
        return 1;
      }
      config = approved;
    }
    // Persist the APPROVED config — the one the (possibly revised) contract renders.
    writeRunConfigFile(runDir, config);
    plan = { runId, runDir, config, resumed: false };
  }

  return superviseRun(
    plan,
    {
      manifest,
      capsuleDir,
      capsuleDigest: admitted.digest,
      optimizerDigest,
      orderingReport: admitted.orderingReport,
    },
    io,
  );
}

/**
 * Lock socket path: SHORT and deterministic. macOS truncates a unix bind
 * path silently at sun_path (~104 bytes) — a lock inside a deep runDir would
 * bind a DIFFERENT, truncated path (colliding with the run dir itself), so
 * the socket lives under tmpdir keyed by the runDir's real path.
 */
export function runLockPath(runDir: string): string {
  const key = createHash("sha256").update(realpathSync(runDir)).digest("hex").slice(0, 16);
  return join(tmpdir(), `hone-${key}.lck`);
}

/** Short path of the lock's identity metadata file, beside the socket. */
function runLockMetaPath(sockPath: string): string {
  return `${sockPath}.id`;
}

/**
 * Kernel-level connect probe. A unix connect to a bound, listening socket
 * completes in the KERNEL (backlog) — it succeeds even while the holder's JS
 * loop is blocked for seconds inside a synchronous delivery, and it fails
 * (ECONNREFUSED/ENOENT) on a crashed holder's leftover. `onTimeout` picks the
 * fail direction: the stale-arbitration probe fails CLOSED (treated as live,
 * never unlink a possibly-live lock); the identity probe fails OPEN to null
 * (never confirm without positive proof).
 */
function connectProbe(sockPath: string, onTimeout: boolean): Promise<boolean> {
  const { promise, resolve } = deferred<boolean>();
  const probe = net.connect(sockPath);
  const settle = (alive: boolean): void => {
    probe.destroy();
    resolve(alive);
  };
  probe.once("connect", () => settle(true));
  probe.once("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    // ECONNREFUSED/ENOENT: crashed owner's leftover. ENOTSOCK: junk file.
    settle(code !== "ECONNREFUSED" && code !== "ENOENT" && code !== "ENOTSOCK" && onTimeout);
  });
  probe.setTimeout(1000, () => settle(onTimeout));
  return promise;
}

/** Identity served by a supervisor's held run lock — binds a sentinel PID to THIS lock holder (PIDs recycle; nonces do not). */
export interface RunLockIdentity {
  pid: number;
  runId: string;
  nonce: string;
}

const RunLockIdentitySchema = z.object({
  pid: z.number().int().positive(),
  runId: z.string(),
  nonce: z.string().min(1),
});

function readLockMetadata(sockPath: string): RunLockIdentity | null {
  try {
    const parsed = RunLockIdentitySchema.safeParse(JSON.parse(readFileSync(runLockMetaPath(sockPath), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic (write + rename) so a probe never reads a torn identity. */
function writeLockMetadata(sockPath: string, identity: RunLockIdentity): void {
  const metaPath = runLockMetaPath(sockPath);
  const tmpPath = `${metaPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(identity)}\n`);
  renameSync(tmpPath, metaPath);
}

/**
 * Who holds the run lock? Identity proof deliberately requires NO event-loop
 * progress from the holder (FinalSecurityGate): a supervisor blocked >5s in
 * synchronous delivery must still be identifiable, or an external stop can
 * never signal it. Proof = durable metadata written by the bind holder PLUS
 * a kernel-level connect success on the socket. The metadata is read on BOTH
 * sides of the connect and must match exactly — a bind→metadata or
 * release→rebind race yields a mismatch, which resolves null (callers
 * re-observe; a null identity NEVER licenses signalling a sentinel PID).
 * Stale crash metadata is harmless: the connect fails. An identity-less
 * holder (e.g. `stop`'s transient lock) clears predecessor metadata at bind,
 * so its live socket can never vouch for a dead supervisor's identity.
 */
export async function probeRunLockIdentity(runDir: string): Promise<RunLockIdentity | null> {
  const sockPath = runLockPath(runDir);
  const before = readLockMetadata(sockPath);
  if (before === null) return null;
  if (!(await connectProbe(sockPath, false))) return null;
  const after = readLockMetadata(sockPath);
  if (after === null || after.pid !== before.pid || after.nonce !== before.nonce || after.runId !== before.runId) return null;
  return after;
}

const RunLockClaim = z.object({
  pid: z.number().int().positive(),
  birth: z.string().min(1),
  nonce: z.string().uuid(),
});

/** Stable process identity: PID plus kernel/ps birth token defeats PID reuse. */
function processBirthToken(pid: number): string | null {
  if (!pidAlive(pid)) return null;
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      const fields = close < 0 ? [] : raw.slice(close + 2).trim().split(/\s+/);
      const started = fields[19];
      if (started !== undefined && started !== "") return `linux:${started}`;
    } catch {
      // Fall through to ps; a lookup failure for a live PID fails closed.
    }
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C" },
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value === "" ? null : `${process.platform}:${value}`;
}

/**
 * Atomic claim ownership is encoded in a symlink target—creation publishes
 * pid+birth+nonce in one syscall. A live/SIGSTOP'd owner is never expired.
 */
function tryAcquireRunLockClaim(claimPath: string): (() => void) | null {
  const birth = processBirthToken(process.pid);
  if (birth === null) throw new Error("cannot establish this process's run-lock claim identity");
  const payload = JSON.stringify({ pid: process.pid, birth, nonce: randomUUID() });
  try {
    symlinkSync(payload, claimPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let owner: z.infer<typeof RunLockClaim> | null = null;
    try {
      const parsed = RunLockClaim.safeParse(JSON.parse(readlinkSync(claimPath)));
      owner = parsed.success ? parsed.data : null;
    } catch {
      // A non-symlink claim may belong to an older live binary. Fail closed:
      // never age-expire an owner whose liveness cannot be proved.
      try {
        if (!statSync(claimPath).isSymbolicLink()) return null;
      } catch {
        return null;
      }
    }
    if (owner !== null && pidAlive(owner.pid)) {
      const currentBirth = processBirthToken(owner.pid);
      if (currentBirth === null || currentBirth === owner.birth) return null;
    }
    rmSync(claimPath, { force: true });
    return null;
  }
  return () => {
    try {
      if (readlinkSync(claimPath) === payload) rmSync(claimPath, { force: true });
    } catch {
      // Already removed only after this process died—which cannot resume.
    }
  };
}

/**
 * OS-enforced exclusive per-run lock (FinalSecurityGate finding 2): a bound
 * unix-domain socket. Liveness is the kernel accepting a connection — the
 * pid file is display metadata only (pids recycle). Bind is the atomic
 * arbiter; a stale leftover may be unlinked ONLY while holding an O_EXCL
 * claim file and ONLY after a re-probe under that claim. A socket can become
 * live only by binding an ABSENT path, and absence is only ever created by a
 * claim holder, so no contender can ever unlink a live lock — concurrent
 * stale contenders yield exactly one winner. An identity-bearing holder
 * publishes {pid,runId,nonce} in an adjacent metadata file at bind (see
 * probeRunLockIdentity). Returned closure releases and unlinks.
 */
export async function acquireRunLock(runDir: string, runId: string, identity?: RunLockIdentity): Promise<() => Promise<void>> {
  const sockPath = runLockPath(runDir);
  const metaPath = runLockMetaPath(sockPath);
  const claimPath = `${sockPath}.claim`;
  const alreadySupervised = (): UsageError =>
    new UsageError(`run ${runId} is already being supervised by a live process — \`hone stop\` it first`);
  for (let attempt = 0; attempt < 10; attempt++) {
    // Incoming probe connections carry no payload — identity lives in the
    // metadata file, so a probe needs no accept-handler progress from us.
    const server = net.createServer((sock) => sock.end());
    server.unref(); // the lock must never keep a finished supervisor alive
    const bound = deferred<boolean>();
    server.once("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") bound.resolve(false);
      else bound.reject(err);
    });
    server.listen(sockPath, () => bound.resolve(true));
    if (await bound.promise) {
      // Under the bind, the metadata file is OURS alone: contenders cannot
      // bind while the socket path exists, and reclaimers only touch it
      // after a connect-probe proves the holder dead. An identity holder
      // publishes atomically; an identity-less holder (stop's transient
      // lock) clears any predecessor leftover IMMEDIATELY — otherwise stale
      // crash metadata plus OUR live socket would falsely confirm a dead
      // supervisor's (possibly recycled) PID.
      if (identity !== undefined) writeLockMetadata(sockPath, identity);
      else rmSync(metaPath, { force: true });
      // Ownership token for the path-CAS at release: server.close stops the
      // listener BEFORE its callback fires (it drains live connections), so
      // a contender can connect-fail, reclaim, and rebind a successor socket
      // while our callback is still pending — the callback may only ever
      // unlink THIS bind's inode, never whatever the path holds by then.
      const sockStat = statSync(sockPath, { bigint: true });
      return () => {
        const closed = deferred<void>();
        server.close(() => {
          // Post-close cleanup runs under the SAME O_EXCL claim as stale
          // arbitration. No claim (a live claimant is mid-reclaim): remove
          // NOTHING — the claimant owns clearing our now-dead leftovers.
          // The claim serializes against claimants, but a fresh binder needs
          // no claim once the path is free (node may unlink the path at
          // close-initiation), so each removal is ownership-guarded on its
          // own: the socket only by dev+ino equality with OUR bind, the
          // metadata only by exact identity match — a successor's socket or
          // metadata is never removed.
          const releaseClaim = tryAcquireRunLockClaim(claimPath);
          if (releaseClaim === null) {
            closed.resolve();
            return;
          }
          try {
            if (identity !== undefined) {
              const current = readLockMetadata(sockPath);
              if (current !== null && current.pid === identity.pid && current.nonce === identity.nonce && current.runId === identity.runId) {
                rmSync(metaPath, { force: true });
              }
            }
            try {
              const now = statSync(sockPath, { bigint: true });
              if (now.dev === sockStat.dev && now.ino === sockStat.ino) rmSync(sockPath, { force: true });
            } catch {
              // already gone — a claimant cleared it before our claim
            }
          } finally {
            releaseClaim();
          }
          closed.resolve();
        });
        return closed.promise;
      };
    }
    if (await connectProbe(sockPath, true)) throw alreadySupervised();

    // Stale leftover. Claim the exclusive right to clear it.
    const releaseClaim = tryAcquireRunLockClaim(claimPath);
    if (releaseClaim === null) {
      await sleep(25);
      continue;
    }
    try {
      // Re-probe UNDER the claim: the leftover may have gone live since ours.
      if (await connectProbe(sockPath, true)) throw alreadySupervised();
      // Dead holder confirmed. Its metadata goes FIRST — while the stale
      // socket path still exists nobody can bind, so this can never delete
      // a successor's metadata; removing the socket path then frees the
      // kernel-arbitrated bind.
      rmSync(metaPath, { force: true });
      rmSync(sockPath, { force: true });
    } finally {
      releaseClaim();
    }
    // Loop: the next bind is kernel-arbitrated among contenders.
  }
  throw new Error(`run lock ${sockPath}: could not acquire after repeated stale-rebind attempts`);
}

function exhaustedBudgetDimension(budget: BudgetState): string | null {
  if (budget.spent.tokens >= budget.envelope.maxTokens) return "tokens";
  if (budget.spent.usd >= budget.envelope.maxUsd) return "usd";
  if (budget.spent.wallClockSec >= budget.envelope.maxWallClockSec) return "wallClockSec";
  if (budget.spent.evaluatorInvocations >= budget.envelope.maxEvaluatorInvocations) return "evaluatorInvocations";
  return null;
}

/** Wall budget is measured from run.started, including time spent offline between supervisors. */
export function remainingWallBudgetMs(
  maxWallClockSec: number,
  lastSpentWallSec: number,
  runStartedAt: string | undefined,
  nowMs: number = Date.now(),
): number {
  const parsedStart = runStartedAt === undefined ? Number.NaN : Date.parse(runStartedAt);
  const elapsedSinceStart = Number.isFinite(parsedStart) ? Math.max(0, (nowMs - parsedStart) / 1000) : 0;
  const spent = Math.max(lastSpentWallSec, elapsedSinceStart);
  return Math.max(0, (maxWallClockSec - spent) * 1000);
}

/** Frozen inputs superviseRun carries beside the plan (all admission-derived). */
export interface SuperviseExtra {
  manifest: CapsuleManifest;
  capsuleDir: string;
  capsuleDigest: string;
  optimizerDigest: string;
  orderingReport: DiagnosticOrderingReport;
}

/** Exported for the late-contender lock regression only. */
export async function superviseRun(
  plan: RunPlan,
  extra: SuperviseExtra,
  io: CmdIo,
): Promise<number> {
  // The lock precedes ANY event append or docker sweep: a competing resume
  // must fail before it can touch the log or rm -f live containers. The
  // lock publishes this supervisor's identity metadata; the sentinel repeats
  // the nonce, so `stop` only ever trusts a PID the live lock holder vouches for.
  const identity: RunLockIdentity = { pid: process.pid, runId: plan.runId, nonce: randomUUID() };
  const releaseLock = await acquireRunLock(plan.runDir, plan.runId, identity);
  try {
    // The resume plan was chosen BEFORE the lock: a contender that planned
    // against an unfinished log can acquire only after the winner released —
    // by then the run may have finished. Re-validate under the lock, before
    // any append or sweep, or a late contender re-runs a settled run.
    if (plan.resumed && replayRun(plan.runDir).finished !== null) {
      throw new UsageError(`run ${plan.runId} already finished — nothing to resume`);
    }
    return await superviseLocked(plan, extra, io, identity.nonce);
  } finally {
    await releaseLock();
  }
}

async function superviseLocked(
  plan: RunPlan,
  extra: SuperviseExtra,
  io: CmdIo,
  nonce: string,
): Promise<number> {
  const { runId, runDir, config } = plan;
  const { manifest, capsuleDir, capsuleDigest, optimizerDigest } = extra;
  const headless = config.headless;
  const casDir = casRoot(io.root);
  mkdirSync(casDir, { recursive: true });
  // Durable last-supervisor metadata, written ONLY while holding the run
  // lock and NEVER unlinked — not even at exit. An exit-time unlink is a
  // path-CAS race: after this supervisor releases the lock, the next one
  // overwrites the file, and a late exit hook would delete the SUCCESSOR's
  // sentinel. A dead/stale sentinel is tiny and safe (same semantics as a
  // SIGKILL leftover); consumers gate on pidAlive AND the lock identity
  // probe (a bare PID is meaningless — PIDs recycle, nonces do not).
  writeFileSync(join(runDir, SUPERVISOR_FILE), `${JSON.stringify({ pid: process.pid, runId, nonce })}\n`);

  // Terminal-status flags, declared BEFORE the emit closure (TDZ) so it can
  // normalize a broker-authored budget.exhausted into the terminal status.
  let budgetDimension: string | null = null;
  let budgetEventLogged = false;
  let stopRequested = false;
  // Bound after the AbortController/termination barrier exist. Broker events
  // cannot arrive before backend.start, so this placeholder is never the
  // active path; it keeps event normalization linear during setup.
  let requestBudgetAbort = (dimension: string): void => {
    budgetDimension ??= dimension;
  };

  let liveBudget = replayRun(runDir).lastBudget;
  const emit = (event: RunEvent): RunEvent => {
    const parsed = appendEvent(runDir, event);
    if (parsed.type === "budget.snapshot") {
      liveBudget = parsed.budget;
      const dimension = exhaustedBudgetDimension(parsed.budget);
      if (dimension !== null) requestBudgetAbort(dimension);
    }
    if (parsed.type === "budget.exhausted") {
      // Trusted broker budget authority: ANY logged exhaustion normalizes the
      // terminal/report status to "budget" and immediately aborts the whole
      // registered process tree. An explicit operator stop still wins status.
      budgetEventLogged = true;
      requestBudgetAbort(parsed.dimension);
    }
    if (headless) {
      io.out(JSON.stringify(parsed));
    } else if (parsed.type === "incumbent.new") {
      // Anytime surface: new-incumbent line with budget burn-down in the attached stream.
      io.out(`new incumbent ${parsed.artifact.hash} — aggregate ${parsed.aggregate} (Δ ${formatDelta(parsed.deltaVsBaseline)}) @ episode ${parsed.episode} | ${formatSpend(liveBudget)}`);
    } else if (parsed.type === "run.started") {
      io.out(`run ${runId} started (capsule ${parsed.capsuleId})`);
    } else if (parsed.type === "run.resumed") {
      io.out(`run ${runId} resumed from cursor ${parsed.fromCursor}`);
    } else if (parsed.type === "budget.exhausted") {
      io.out(`budget exhausted: ${parsed.dimension}`);
    }
    return parsed;
  };

  if (plan.resumed) {
    // Under-lock seal verification (the plan was chosen from PRE-lock reads):
    // runconfig.json, contract.md, the run.started contract hash, and the
    // capsule/optimizer/backend/headless seals must all still hold before
    // run.resumed is appended or any backend launches. Tamper refuses with
    // NO event and NO terminal — the run stays resumable as-is.
    const underLock = replayRun(runDir);
    const sealError = resumeSealError({
      runId,
      runDir,
      config,
      manifest,
      capsuleDigest,
      optimizerDigest,
      orderingReport: extra.orderingReport,
      sealedContractHash: underLock.contractHash,
      sealedOptimizerDigest: underLock.optimizerDigest,
    });
    if (sealError !== null) {
      io.err(`resume seal violated: ${sealError}`);
      return 1;
    }
    emit({ runId, at: new Date().toISOString(), type: "run.resumed", fromCursor: underLock.cursor });
  } else {
    emit({
      runId,
      at: new Date().toISOString(),
      type: "run.started",
      capsuleId: manifest.id,
      contractHash: contractHash(readFileSync(join(runDir, CONTRACT_FILE), "utf8")),
      optimizerDigest,
    });
  }

  const replayed = replayRun(runDir);
  // The backend is the SEALED one from the run config — never a flag.
  const backend = await loadBackend(config.backend, io.root, io.env);

  const abort = new AbortController();
  const children = new Set<ChildLike>();
  const timers: NodeJS.Timeout[] = [];
  const graceMs = Number(io.env["HONE_KILL_GRACE_MS"] ?? 5000);

  // Watchdog timers stay referenced (they must keep a headless process alive
  // while a listener-only backend waits); every one is cleared in the finally.
  const armTimer = (fn: () => void, ms: number): void => {
    timers.push(setTimeout(fn, ms));
  };
  /**
   * Idempotent termination barrier, deliberately OUTSIDE the generic timer
   * pool: SIGTERM every registered child group, wait the grace, SIGKILL,
   * then a short reap settle. A settling backend promise must NEVER cancel
   * the escalation — the optimizer leader exiting can leave a TERM-ignoring
   * descendant that only the delayed group SIGKILL removes. Any abort path
   * awaits this barrier before delivery and the terminal event.
   */
  let terminationBarrier: Promise<void> | null = null;
  const termThenKill = (): Promise<void> => {
    terminationBarrier ??= (async () => {
      for (const child of children) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      await sleep(graceMs);
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      // Confirm the leaders are reaped (descendants die with the group kill).
      const settleDeadline = Date.now() + 2000;
      while (Date.now() < settleDeadline && [...children].some((c) => typeof c.pid === "number" && pidAlive(c.pid))) {
        await sleep(50);
      }
    })();
    return terminationBarrier;
  };
  requestBudgetAbort = (dimension: string): void => {
    budgetDimension ??= dimension;
    if (!abort.signal.aborted) abort.abort(new Error(`budget exhausted: ${dimension}`));
    void termThenKill();
  };

  // Wall clock is run lifetime, not supervisor uptime: resume includes the
  // offline interval since the durable run.started timestamp.
  const runStartedAt = readEvents(runDir).find((event) => event.type === "run.started")?.at;
  const spentWallSec = replayed.lastBudget?.spent.wallClockSec ?? 0;
  const remainMs = remainingWallBudgetMs(config.budget.maxWallClockSec, spentWallSec, runStartedAt);
  armTimer(() => requestBudgetAbort("wallClockSec"), remainMs);

  const onSignal = (): void => {
    stopRequested = true;
    abort.abort(new Error("stop requested"));
    void termThenKill();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Terminal-order fence: once the backend settled or the hard-stop deadline
  // passed, a late ctx.emit from an abort-ignoring backend (or a straggler
  // optimizer event) must never reach the log or stdout — run.finished is
  // the final event. The supervisor's own emit stays unfenced.
  let backendFenced = false;
  // Trusted-authority barrier: null = backend never registered = ready.
  let authorityBarrier: Promise<void> | null = null;
  // Full-teardown barrier: null = backend never registered = clean.
  let cleanupBarrier: Promise<void> | null = null;
  const ctx: RunnerBackendContext = {
    runId,
    root: io.root,
    runDir,
    casDir,
    capsuleDir,
    manifest,
    config,
    env: io.env,
    capsuleDigest,
    optimizerDigest,
    replayed,
    signal: abort.signal,
    emit: (event) => (backendFenced ? RunEvent.parse(event) : emit(event)),
    registerChild: (child) => {
      children.add(child);
      return () => {
        children.delete(child);
      };
    },
    probeGate: (report) => (headless ? Promise.resolve(headlessProbeVerdict(report)) : promptProbe(report, io, abort.signal)),
    requestStop: () => onSignal(),
    registerAuthorityBarrier: (barrier) => {
      authorityBarrier = barrier;
      // A rejection may land before anything awaits it — keep it handled.
      void barrier.catch(() => {});
    },
    registerCleanupBarrier: (barrier) => {
      cleanupBarrier = barrier;
      void barrier.catch(() => {});
    },
  };

  let failure: Error | null = null;
  let authorityFailure: Error | null = null;
  try {
    try {
      const settled = backend
        .start(ctx)
        .then(() => undefined)
        .catch((e: unknown) => {
          failure = e instanceof Error ? e : new Error(String(e));
        });
      // If the backend ignores the abort, proceed after the kill grace anyway.
      const hardStop = deferred<void>();
      abort.signal.addEventListener("abort", () => armTimer(hardStop.resolve, graceMs + 1000), { once: true });
      await Promise.race([settled, hardStop.promise]);
    } finally {
      // A hard-stopped backend may STILL be recovering durable authority
      // (slow pre-reconcile docker setup): the fence must stay open until
      // the barrier settles, or the recovered incumbent emit is dropped and
      // the terminal best seals stale state.
      try {
        if (authorityBarrier !== null) await authorityBarrier;
      } catch (e) {
        authorityFailure = e instanceof Error ? e : new Error(String(e));
      }
      backendFenced = true;
    }

    // Termination is not only for aborts: a FAILED backend (or one whose
    // trusted authority could not be recovered) may have left process groups
    // behind — every registered child is TERM'd, KILL'd after grace, and
    // confirmed reaped before anything else happens. On the success path the
    // barrier still runs whenever an abort landed: a TERM-ignoring
    // descendant must never outlive delivery or the terminal event.
    if (abort.signal.aborted || failure !== null || authorityFailure !== null) await termThenKill();

    /**
     * Full-teardown gate: the supervisor never delivers, emits run.finished,
     * or returns while backend resources (optimizer/build containers,
     * broker, proxy, egress, temp snapshots) may still be open. A rejected
     * or timed-out barrier means cleanup is incomplete — the run is left
     * WITHOUT a terminal event, resumable after the operator intervenes.
     */
    const awaitCleanup = async (): Promise<Error | null> => {
      if (cleanupBarrier === null) return null;
      try {
        // The per-run lock remains held until teardown actually settles.
        // A local timeout would only release the lock while Docker work was
        // still mutating the same run, allowing a resumed supervisor to race.
        await cleanupBarrier;
        return null;
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    };

    if (authorityFailure !== null) {
      // Trusted authority could not be established: sealing the run now
      // would terminalize stale state. No delivery, no run.finished — the
      // run stays resumable.
      const cleanupFailure = await awaitCleanup();
      if (cleanupFailure !== null) io.err(`backend cleanup incomplete: ${cleanupFailure.message}`);
      io.err(`trusted authority recovery failed: ${authorityFailure.message} — run left unfinished (resume with \`hone run --resume\`)`);
      return 1;
    }

    const cleanupFailure = await awaitCleanup();
    if (cleanupFailure !== null) {
      io.err(`backend cleanup incomplete: ${cleanupFailure.message} — run left unfinished (resume with \`hone run --resume\`)`);
      return 1;
    }

    if (failure !== null) {
      const err: Error = failure;
      io.err(`backend failed: ${err.message}`);
    }

    const preFinish = replayRun(runDir);
    const best = preFinish.incumbent?.artifact ?? null;

    // Delivery policy is per-run and immutable once started (contract 5).
    // Delivery runs BEFORE run.finished so the terminal event is always the
    // log's final line. An explicit stop that already landed skips automatic
    // delivery (`stop --take-best` is the deliberate path); the SIGTERM/
    // SIGINT handlers are still installed here, so a stop arriving during
    // the synchronous delivery is queued and handled — never the OS default
    // that would kill the supervisor mid-delivery with no terminal event.
    if (!stopRequested && failure === null && config.apply !== "none" && best !== null) {
      // Automatic delivery ALWAYS targets io.root — per-run delivery has no
      // --repo escape; `hone apply/stop --repo` is the deliberate operator path.
      const repo = io.root;
      if (isGitRepo(repo)) {
        try {
          const result = deliver({
            mode: config.apply,
            repo,
            runId,
            artifact: best.hash,
            casDir,
            improverSeat: config.improverSeat,
            env: io.env,
          });
          emit({
            runId,
            at: new Date().toISOString(),
            type: "delivery.applied",
            mode: config.apply,
            ...(result.ref !== null ? { ref: result.ref } : {}),
          });
          for (const note of result.notes) io.err(note);
        } catch (e) {
          if (e instanceof LadderLockedError) io.err(e.message);
          else io.err(`delivery (${config.apply}) failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        io.err(`apply ${config.apply}: ${repo} is not a git repository — skipping delivery (use \`hone apply --repo <dir>\`)`);
      }
    }

    // Drain the signal queue: a SIGTERM raised during the synchronous
    // delivery is only DISPATCHED in a later poll phase — a single
    // setImmediate can land in the same iteration's check phase and miss it
    // (verified empirically). A timer forces at least one full iteration
    // through poll, so the handler runs before the terminal status is
    // chosen: delivery finishes atomically, the run still stops.
    await sleep(25);

    // A signal that landed during delivery (or between backend settle and
    // the drain) started the barrier but nothing awaited it yet — the same
    // idempotent barrier guarantees children are reaped before the terminal.
    if (abort.signal.aborted) await termThenKill();

    let status: "completed" | "stopped" | "failed" | "budget";
    if (stopRequested) status = "stopped";
    else if (budgetDimension !== null) status = "budget";
    else if (failure !== null) status = "failed";
    else status = "completed";

    if (budgetDimension !== null && !budgetEventLogged) {
      emit({ runId, at: new Date().toISOString(), type: "budget.exhausted", dimension: budgetDimension });
    }

    emit({
      runId,
      at: new Date().toISOString(),
      type: "run.finished",
      ...(best !== null ? { best } : {}),
      status,
    });

    const report = exitReport(runId, replayRun(runDir));
    if (headless) {
      io.out(JSON.stringify(report));
    } else {
      for (const line of formatHumanReport(report, liveBudget)) io.out(line);
    }
    return status === "failed" ? 1 : 0;
  } finally {
    // Handlers and timers live through delivery, the terminal event, and the
    // report — removed only once no further trusted append can happen.
    for (const t of timers) clearTimeout(t);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

export interface SupervisorSentinel {
  pid: number;
  /** Absent on legacy sentinels — such a PID can never be identity-confirmed. */
  nonce: string | undefined;
}

const SentinelSchema = z.object({ pid: z.number().int().positive(), nonce: z.string().min(1).optional() });

/** Durable last-supervisor metadata; a bare PID here is NEVER trusted without the lock-identity probe. */
export function readSupervisorSentinel(runDir: string): SupervisorSentinel | null {
  const path = join(runDir, SUPERVISOR_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = SentinelSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return { pid: parsed.pid, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

/** Shared by `stop` and tests for pid-level checks. */
export function readSupervisorPid(runDir: string): number | null {
  return readSupervisorSentinel(runDir)?.pid ?? null;
}

/** True when `pid` names a live process (signal-0 probe) — shared by the stop and resume guards. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
