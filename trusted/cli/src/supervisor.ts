import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ApplyMode, BudgetEnvelope, ModelRouting, RunConfig } from "@hone/schema";
import type { CapsuleManifest, RunEvent } from "@hone/schema";
import { UsageError, boolFlag, parseFlags, strFlag } from "./args.js";
import { createBackend as createStubBackend } from "./backends/stub.js";
import { loadCapsule } from "./capsule.js";
import { contractHash, renderContract } from "./contract.js";
import { LadderLockedError, deliver, isGitRepo, ladderLocked, LADDER_REFUSAL } from "./deliver.js";
import { appendEvent, replayRun } from "./eventlog.js";
import type { RunState } from "./eventlog.js";
import type { CmdIo } from "./io.js";
import { deferred } from "./promise.js";
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
  "usage: hone run <capsule-dir> [--headless] [--budget-usd N] [--apply none|branch|pr|auto] [--resume] [--backend stub|<module>] [--config <json>] [--repo <dir>]";

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

async function loadBackend(spec: string, root: string): Promise<RunnerBackend> {
  if (spec === "stub") return createStubBackend();
  const url = pathToFileURL(resolve(root, spec)).href;
  // Plugin boundary: the backend module is runtime-selected via --backend (WP7 injects the real runner).
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

async function superviseRun(
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
  const backend = await loadBackend(extra.flags.backend ?? "stub", io.root);

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
