import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ApplyMode, BudgetEnvelope, ModelRouting, RunConfig } from "@hone/schema";
import type { CapsuleManifest, RunEvent } from "@hone/schema";
import { UsageError, boolFlag, parseFlags, strFlag } from "./args.js";
import { createBackend as createLocalBackend } from "./backends/local.js";
import { createBackend as createStubBackend } from "./backends/stub.js";
import { loadCapsule } from "./capsule.js";
import { contractHash, renderContract } from "./contract.js";
import { LadderLockedError, deliver, isGitRepo, ladderLocked, LADDER_REFUSAL } from "./deliver.js";
import { appendEvent, replayRun } from "./eventlog.js";
import type { RunState } from "./eventlog.js";
import type { CmdIo } from "./io.js";
import { deferred, sleep } from "./promise.js";
import { exitReport, formatDelta, formatHumanReport, formatSpend } from "./report.js";
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
import type { ChildLike, RunnerBackend, RunnerBackendContext } from "./types.js";

const RUN_USAGE =
  "usage: hone run <capsule-dir> [--headless] [--budget-usd N] [--apply none|branch|pr|auto] [--resume] [--backend stub|local|<module>] [--config <json>] [--repo <dir>]";

/** Optional per-run overrides (routing, seat, seed, budget dims) — the CLI flags cover the common ones. */
const ConfigOverrides = z
  .object({
    routing: ModelRouting.optional(),
    apply: ApplyMode.optional(),
    headless: z.boolean().optional(),
    improverSeat: z.boolean().optional(),
    seed: z.number().int().nonnegative().optional(),
    budget: BudgetEnvelope.partial().optional(),
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

function buildConfig(
  manifest: CapsuleManifest,
  overrides: ConfigOverrides,
  flags: { headless: boolean; apply: string | undefined; budgetUsd: number | undefined },
): RunConfig {
  return RunConfig.parse({
    version: 1,
    capsuleId: manifest.id,
    objective: manifest.objective,
    budget: {
      ...manifest.budget,
      ...(overrides.budget ?? {}),
      ...(flags.budgetUsd !== undefined ? { maxUsd: flags.budgetUsd } : {}),
    },
    routing: overrides.routing ?? {},
    apply: flags.apply ?? overrides.apply ?? "none",
    headless: flags.headless || overrides.headless === true,
    improverSeat: overrides.improverSeat ?? false,
    seed: overrides.seed ?? 0,
  });
}

async function promptApproval(contractPath: string, io: CmdIo): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      io.out("");
      io.out(readFileSync(contractPath, "utf8"));
      io.out(`(contract on disk: ${contractPath})`);
      const answer = (await rl.question("approve run contract? [Y]es / [E]dit / [N]o: ")).trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      if (answer === "e" || answer === "edit") {
        const editor = io.env["EDITOR"] ?? io.env["VISUAL"] ?? "vi";
        const before = readFileSync(contractPath, "utf8");
        spawnSync(editor, [contractPath], { stdio: "inherit" });
        if (readFileSync(contractPath, "utf8") !== before) io.out("contract revised — re-review before approving:");
      }
    }
  } finally {
    rl.close();
  }
}

export async function runCommand(args: string[], io: CmdIo): Promise<number> {
  const { positionals, flags } = parseFlags(args, {
    booleans: ["headless", "resume"],
    strings: ["budget-usd", "apply", "backend", "config", "repo"],
  });
  const capsuleArg = positionals[0];
  if (capsuleArg === undefined) throw new UsageError(RUN_USAGE);
  const capsuleDir = resolve(io.root, capsuleArg);
  const manifest = loadCapsule(capsuleDir);

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
  const backendSpec = strFlag(flags, "backend") ?? "local";
  if (!backendSpecAllowed(backendSpec, io.env)) {
    io.err(UNSAFE_BACKEND_REFUSAL);
    return 2;
  }

  let plan: RunPlan;
  if (boolFlag(flags, "resume")) {
    const found = findResumableRun(io.root, manifest.id);
    if (found === null) throw new UsageError(`nothing to resume: no unfinished run for capsule ${manifest.id} under ${runsRoot(io.root)}`);
    let config = loadRunConfigFile(found.runDir);
    if (boolFlag(flags, "headless") && !config.headless) config = { ...config, headless: true };
    plan = { runId: found.runId, runDir: found.runDir, config, resumed: true };
  } else {
    const config = buildConfig(manifest, overrides, {
      headless: boolFlag(flags, "headless"),
      apply: applyFlag,
      budgetUsd,
    });

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
    writeFileSync(join(runDir, CONTRACT_FILE), renderContract(runId, config, manifest));
    if (!config.headless) {
      const approved = await promptApproval(join(runDir, CONTRACT_FILE), io);
      if (!approved) {
        rmSync(runDir, { recursive: true, force: true });
        io.err("contract declined — no run started");
        return 1;
      }
    }
    writeRunConfigFile(runDir, config);
    plan = { runId, runDir, config, resumed: false };
  }

  return superviseRun(plan, { manifest, capsuleDir, flags: { backend: strFlag(flags, "backend"), repo: strFlag(flags, "repo") } }, io);
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

/** Probe: will anyone accept on this socket? Fails CLOSED (treated as live) on unexpected errors or a hung peer. */
function lockHolderAlive(sockPath: string): Promise<boolean> {
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
    settle(code !== "ECONNREFUSED" && code !== "ENOENT" && code !== "ENOTSOCK");
  });
  probe.setTimeout(1000, () => settle(true));
  return promise;
}

/**
 * OS-enforced exclusive per-run lock (FinalSecurityGate finding 2): a bound
 * unix-domain socket. Liveness is the kernel accepting a connection — the
 * pid file is display metadata only (pids recycle). Bind is the atomic
 * arbiter; a stale leftover may be unlinked ONLY while holding an O_EXCL
 * claim file and ONLY after a re-probe under that claim. A socket can become
 * live only by binding an ABSENT path, and absence is only ever created by a
 * claim holder, so no contender can ever unlink a live lock — concurrent
 * stale contenders yield exactly one winner. Returned closure releases and
 * unlinks.
 */
export async function acquireRunLock(runDir: string, runId: string): Promise<() => Promise<void>> {
  const sockPath = runLockPath(runDir);
  const claimPath = `${sockPath}.claim`;
  const alreadySupervised = (): UsageError =>
    new UsageError(`run ${runId} is already being supervised by a live process — \`hone stop\` it first`);
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = net.createServer();
    server.unref(); // the lock must never keep a finished supervisor alive
    const bound = deferred<boolean>();
    server.once("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") bound.resolve(false);
      else bound.reject(err);
    });
    server.listen(sockPath, () => bound.resolve(true));
    if (await bound.promise) {
      return () => {
        const closed = deferred<void>();
        server.close(() => {
          rmSync(sockPath, { force: true });
          closed.resolve();
        });
        return closed.promise;
      };
    }
    if (await lockHolderAlive(sockPath)) throw alreadySupervised();

    // Stale leftover. Claim the exclusive right to clear it.
    let claimFd: number;
    try {
      claimFd = openSync(claimPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A sibling holds the claim; expire a claim orphaned by a crash.
      try {
        if (Date.now() - statSync(claimPath).mtimeMs > 10_000) rmSync(claimPath, { force: true });
      } catch {
        // claim vanished — sibling finished; just retry
      }
      await sleep(25);
      continue;
    }
    try {
      // Re-probe UNDER the claim: the leftover may have gone live since ours.
      if (await lockHolderAlive(sockPath)) throw alreadySupervised();
      rmSync(sockPath, { force: true });
    } finally {
      closeSync(claimFd);
      rmSync(claimPath, { force: true });
    }
    // Loop: the next bind is kernel-arbitrated among contenders.
  }
  throw new Error(`run lock ${sockPath}: could not acquire after repeated stale-rebind attempts`);
}

async function superviseRun(
  plan: RunPlan,
  extra: { manifest: CapsuleManifest; capsuleDir: string; flags: { backend: string | undefined; repo: string | undefined } },
  io: CmdIo,
): Promise<number> {
  // The lock precedes ANY event append or docker sweep: a competing resume
  // must fail before it can touch the log or rm -f live containers.
  const releaseLock = await acquireRunLock(plan.runDir, plan.runId);
  try {
    return await superviseLocked(plan, extra, io);
  } finally {
    await releaseLock();
  }
}

async function superviseLocked(
  plan: RunPlan,
  extra: { manifest: CapsuleManifest; capsuleDir: string; flags: { backend: string | undefined; repo: string | undefined } },
  io: CmdIo,
): Promise<number> {
  const { runId, runDir, config } = plan;
  const { manifest, capsuleDir } = extra;
  const headless = config.headless;
  const casDir = casRoot(io.root);
  mkdirSync(casDir, { recursive: true });
  writeFileSync(join(runDir, SUPERVISOR_FILE), `${JSON.stringify({ pid: process.pid, runId })}\n`);

  let liveBudget = replayRun(runDir).lastBudget;
  const emit = (event: RunEvent): RunEvent => {
    const parsed = appendEvent(runDir, event);
    if (parsed.type === "budget.snapshot") liveBudget = parsed.budget;
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
    const cursor = replayRun(runDir).cursor;
    emit({ runId, at: new Date().toISOString(), type: "run.resumed", fromCursor: cursor });
  } else {
    emit({
      runId,
      at: new Date().toISOString(),
      type: "run.started",
      capsuleId: manifest.id,
      contractHash: contractHash(readFileSync(join(runDir, CONTRACT_FILE), "utf8")),
      optimizerDigest: io.env["HONE_OPTIMIZER_DIGEST"] ?? "unpinned",
    });
  }

  const replayed = replayRun(runDir);
  const backend = await loadBackend(extra.flags.backend ?? "local", io.root, io.env);

  const abort = new AbortController();
  const children: ChildLike[] = [];
  const timers: NodeJS.Timeout[] = [];
  const graceMs = Number(io.env["HONE_KILL_GRACE_MS"] ?? 5000);
  let budgetDimension: string | null = null;
  let stopRequested = false;

  // Watchdog timers stay referenced (they must keep a headless process alive
  // while a listener-only backend waits); every one is cleared in the finally.
  const armTimer = (fn: () => void, ms: number): void => {
    timers.push(setTimeout(fn, ms));
  };
  const termThenKill = (): void => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    armTimer(() => {
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, graceMs);
  };

  // Wall-clock budget: remaining = envelope minus what the log says was already spent.
  const spentWallSec = replayed.lastBudget?.spent.wallClockSec ?? 0;
  const remainMs = Math.max(0, (config.budget.maxWallClockSec - spentWallSec) * 1000);
  armTimer(() => {
    budgetDimension = "wallClockSec";
    abort.abort(new Error("wall-clock budget exhausted"));
    termThenKill();
  }, remainMs);

  const onSignal = (): void => {
    stopRequested = true;
    abort.abort(new Error("stop requested"));
    termThenKill();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const ctx: RunnerBackendContext = {
    runId,
    root: io.root,
    runDir,
    casDir,
    capsuleDir,
    manifest,
    config,
    env: io.env,
    replayed,
    signal: abort.signal,
    emit,
    registerChild: (child) => children.push(child),
  };

  let failure: Error | null = null;
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
    for (const t of timers) clearTimeout(t);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }

  let status: "completed" | "stopped" | "failed" | "budget";
  if (stopRequested) status = "stopped";
  else if (budgetDimension !== null) status = "budget";
  else if (failure !== null) status = "failed";
  else status = "completed";

  if (budgetDimension !== null) {
    emit({ runId, at: new Date().toISOString(), type: "budget.exhausted", dimension: budgetDimension });
  }
  if (failure !== null) {
    const err: Error = failure;
    io.err(`backend failed: ${err.message}`);
  }

  const preFinish = replayRun(runDir);
  const best = preFinish.incumbent?.artifact ?? null;
  emit({
    runId,
    at: new Date().toISOString(),
    type: "run.finished",
    ...(best !== null ? { best } : {}),
    status,
  });

  // Delivery policy is per-run and immutable once started (contract 5).
  if (status !== "failed" && config.apply !== "none" && best !== null) {
    const repo = extra.flags.repo !== undefined ? resolve(io.root, extra.flags.repo) : io.root;
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
      io.err(`apply ${config.apply}: ${repo} is not a git repository — skipping delivery (pass --repo <dir>)`);
    }
  }

  try {
    unlinkSync(join(runDir, SUPERVISOR_FILE));
  } catch {
    // best-effort
  }

  const report = exitReport(runId, replayRun(runDir));
  if (headless) {
    io.out(JSON.stringify(report));
  } else {
    for (const line of formatHumanReport(report, liveBudget)) io.out(line);
  }
  return status === "failed" ? 1 : 0;
}

/** Shared by `stop` for liveness checks. */
export function readSupervisorPid(runDir: string): number | null {
  const path = join(runDir, SUPERVISOR_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.pid;
  } catch {
    return null;
  }
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
