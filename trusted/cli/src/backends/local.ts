import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ArtifactRef, BudgetState, CapsuleManifest, RunEvent } from "@hone/schema";
import { CasStore, packDirAsArtifact, runCommand, startBroker } from "@hone/broker";
import type { CallContext, RunCommand, RunningBroker, SandboxNetworkMode } from "@hone/broker";
import { createProxy, DEFAULT_UPSTREAM } from "@hone/proxy";
import type { BudgetDecision, ProxyHandle } from "@hone/proxy";
import { readEvents, replayRun } from "../eventlog.js";
import { deferred } from "../promise.js";
import type { ChildLike, RunnerBackend, RunnerBackendContext } from "../types.js";

/**
 * The real runner backend (WP7): composes broker + metering proxy + the
 * optimizer child process behind the same seam the stub implements.
 *
 * Egress topology (mutation sandboxes -> LLM):
 *   linux   proxy binds runDir/proxy.sock; the broker mounts it at
 *           /run/hone/proxy.sock and the in-sandbox worker bridges
 *           loopback -> unix itself. Sandboxes stay --network none.
 *   darwin  VirtioFS-mounted host unix sockets cannot accept container
 *           connections, so the proxy binds 127.0.0.1:<random> TCP and a
 *           relay container (hone-task image, node one-liner) joins BOTH a
 *           per-run `--internal` docker network (the sandboxes' only
 *           endpoint) AND the default bridge, piping :8080 to
 *           host.docker.internal:<port>. Chain:
 *           sandbox -> relay:8080 -> host proxy -> vibeproxy upstream.
 *   Override with HONE_EGRESS=socket|network.
 *
 * The optimizer runs as an unprivileged host child (node + tsx, override via
 * HONE_OPTIMIZER_CMD) with a minimal explicit env and NO event authority:
 * its stdout/stderr go verbatim to runDir/optimizer.log as opaque
 * diagnostics. Every RunEvent is derived trusted-side — runner lifecycle
 * here/in the supervisor, everything else by the broker from the method
 * calls it serves (see trusted/broker recordEvaluation/reportIncumbent).
 */

/** Entries never packed into the baseline artifact (mirrors capsules/tools/ordering-check.ts). */
const BASELINE_SKIP: Record<string, true> = { ".git": true, ".gitdir": true, __pycache__: true, ".pytest_cache": true };

const RELAY_PORT = 8080;
/** TCP relay run inside the hone-task image: 0.0.0.0:8080 -> host.docker.internal:$HONE_RELAY_PORT. */
const RELAY_JS = [
  "const net=require('net');",
  "const port=Number(process.env.HONE_RELAY_PORT);",
  "net.createServer(c=>{",
  "const u=net.connect(port,'host.docker.internal');",
  "c.pipe(u);u.pipe(c);",
  "const drop=()=>{c.destroy();u.destroy();};",
  "c.on('error',drop);u.on('error',drop);",
  `}).listen(${RELAY_PORT},'0.0.0.0');`,
].join("");

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/**
 * Trusted pre-flight: the manifest on disk must still describe the tree.
 * Asset hashes + baseline git HEAD are recomputed; a drifted capsule refuses
 * to run (re-scaffold with capsules/tools/scaffold.ts).
 */
export function validateCapsule(capsuleDir: string, manifest: CapsuleManifest): void {
  for (const [rel, expected] of Object.entries(manifest.contentHashes)) {
    const abs = resolve(capsuleDir, rel);
    if (!existsSync(abs)) throw new Error(`capsule drift: asset missing on disk: ${rel}`);
    const actual = sha256File(abs);
    if (actual !== expected) throw new Error(`capsule drift: ${rel} hash ${actual} != manifest ${expected} — re-run capsules/tools/scaffold.ts`);
  }
  if (manifest.baseline.kind === "git") {
    const baselineDir = join(capsuleDir, "baseline");
    const gitDir = existsSync(join(baselineDir, ".gitdir")) ? join(baselineDir, ".gitdir") : join(baselineDir, ".git");
    const head = execFileSync("git", ["--git-dir", gitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== manifest.baseline.commit) {
      throw new Error(`capsule drift: baseline HEAD ${head} != manifest commit ${manifest.baseline.commit} — re-run capsules/tools/scaffold.ts`);
    }
  }
}

/** Anti-sandbagging: the baseline artifact is measured (packed) by the trusted runner, never taken from capsule metadata. */
async function measureBaseline(capsuleDir: string, cas: CasStore): Promise<string> {
  const baselineDir = join(capsuleDir, "baseline");
  if (!existsSync(baselineDir)) throw new Error(`capsule has no baseline/ directory: ${capsuleDir}`);
  const staging = mkdtempSync(join(tmpdir(), "hone-baseline-"));
  try {
    for (const entry of readdirSync(baselineDir)) {
      if (BASELINE_SKIP[entry] === true) continue;
      cpSync(join(baselineDir, entry), join(staging, entry), { recursive: true });
    }
    return await packDirAsArtifact(staging, cas);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function mustRun(run: RunCommand, argv: string[], what: string): Promise<string> {
  const res = await run(argv, { timeoutMs: 120_000 });
  if (res.exitCode !== 0) throw new Error(`${what} failed: ${res.stderr.toString("utf8").slice(0, 2000)}`);
  return res.stdout.toString("utf8").trim();
}

/** Docker's name alphabet is narrower than a run id's; label filters use the RAW id, names the sanitized one. */
function dockerNames(runId: string): { network: string; relay: string } {
  const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return { network: `hone-${safe}`, relay: `hone-proxy-${safe}` };
}

/**
 * Crash-recovery sweep (review finding 10): a SIGKILLed supervisor leaves the
 * run's labeled sandbox/eval/relay containers and the deterministic
 * --internal network behind, and the next `--resume` would die at
 * `docker network create` before any cleanup handler exists. Best-effort
 * teardown of every per-run docker resource plus stale socket files; durable
 * run data (events.ndjson, broker-state.ndjson, CAS, the labeled scratch
 * VOLUME) is deliberately untouched.
 */
export async function sweepStaleRunResources(runId: string, runDir: string, run: RunCommand = runCommand): Promise<void> {
  const { network, relay } = dockerNames(runId);
  // Every container this run ever labeled (mutation/eval sandboxes + relay).
  const ls = await run(["docker", "ps", "-aq", "--filter", `label=hone.runId=${runId}`], { timeoutMs: 30_000 });
  if (ls.exitCode === 0) {
    const ids = ls.stdout.toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (ids.length > 0) await run(["docker", "rm", "-f", ...ids], { timeoutMs: 120_000 });
  }
  // Deterministic names, in case the label listing failed or was incomplete.
  await run(["docker", "rm", "-f", relay], { timeoutMs: 30_000 });
  await run(["docker", "network", "rm", network], { timeoutMs: 30_000 });
  // Half-dead endpoints: every listener also unlinks defensively, but a swept
  // run dir must not present a crashed process's sockets to other tooling.
  for (const sock of ["proxy.sock", "broker.sock", "broker-admin.sock"]) {
    rmSync(join(runDir, sock), { force: true });
  }
}

interface Egress {
  sandboxNetwork: SandboxNetworkMode;
  /** HONE_PROXY_BASE_URL for sandboxes; null on the unix-socket path (the worker bridges the mounted socket). */
  proxyBaseUrl: string | null;
  cleanup(): Promise<void>;
}

/** Exported for the recovery tests: network create must be idempotent (and isolation-verified) after a crash sweep. */
export async function setupEgress(
  ctx: Pick<RunnerBackendContext, "runId" | "runDir" | "env">,
  proxy: ProxyHandle,
  image: string,
  run: RunCommand,
): Promise<Egress> {
  const mode = ctx.env["HONE_EGRESS"] ?? (process.platform === "darwin" ? "network" : "socket");
  if (mode === "socket") {
    await proxy.listenUnix(join(ctx.runDir, "proxy.sock"));
    return { sandboxNetwork: { mode: "none" }, proxyBaseUrl: null, cleanup: async () => {} };
  }
  if (mode !== "network") throw new Error(`HONE_EGRESS must be "socket" or "network", got "${mode}"`);

  const { network, relay } = dockerNames(ctx.runId);
  const port = await proxy.listenTcp(0);
  const created = await run(["docker", "network", "create", "--internal", network], { timeoutMs: 120_000 });
  if (created.exitCode !== 0) {
    const stderr = created.stderr.toString("utf8");
    if (!/already exists/i.test(stderr)) throw new Error(`docker network create ${network} failed: ${stderr.slice(0, 2000)}`);
    // Idempotent reuse after the crash sweep is safe ONLY for a network with
    // our exact isolation config — a same-named NON-internal network would
    // silently grant every sandbox real egress.
    const inspect = await run(["docker", "network", "inspect", "--format", "{{.Internal}}", network], { timeoutMs: 30_000 });
    if (inspect.exitCode !== 0 || inspect.stdout.toString("utf8").trim() !== "true") {
      throw new Error(`docker network ${network} already exists but is not --internal — refusing to attach sandboxes`);
    }
  }
  const cleanup = async (): Promise<void> => {
    await run(["docker", "rm", "-f", relay]);
    await run(["docker", "network", "rm", network]);
  };
  try {
    await mustRun(run,
      [
        "docker", "run", "-d",
        "--name", relay,
        "--network", network,
        "--label", `hone.runId=${ctx.runId}`,
        "--add-host", "host.docker.internal:host-gateway",
        "-e", `HONE_RELAY_PORT=${port}`,
        image,
        "node", "-e", RELAY_JS,
      ],
      "docker run (proxy relay)",
    );
    // Second leg: bridge gives the relay (and ONLY the relay) a route to the host proxy.
    await mustRun(run, ["docker", "network", "connect", "bridge", relay], "docker network connect bridge");
  } catch (err) {
    await cleanup();
    throw err;
  }
  return {
    sandboxNetwork: { mode: "internal", network },
    proxyBaseUrl: `http://${relay}:${RELAY_PORT}/v1`,
    cleanup,
  };
}

/** Spawn command for the optimizer child: HONE_OPTIMIZER_CMD override, else host node + the cli's own tsx. */
function optimizerCommand(env: NodeJS.ProcessEnv): string[] {
  const override = env["HONE_OPTIMIZER_CMD"];
  if (override !== undefined && override.trim().length > 0) return override.trim().split(/\s+/);
  const require = createRequire(import.meta.url);
  const tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
  return [process.execPath, tsxCli];
}

/** Optimizer resume payload, always from the on-disk log (post-reconciliation truth). */
function resumeHint(runDir: string): { nextEpisode: number; incumbent: { artifact: ArtifactRef; aggregate: number } | null } {
  const replayed = replayRun(runDir);
  return {
    nextEpisode: replayed.nextEpisode,
    incumbent: replayed.incumbent === null ? null : { artifact: replayed.incumbent.artifact, aggregate: replayed.incumbent.aggregate },
  };
}

/**
 * Kill handle covering the optimizer's whole POSIX process group — the tsx
 * launcher nests a node child, and a stop that only signals the immediate
 * child leaves descendants emitting broker calls after run.finished. Falls
 * back to the direct child handle on Windows or when the group is gone.
 */
function groupKillHandle(child: ChildLike): ChildLike {
  return {
    pid: child.pid,
    kill(signal?: NodeJS.Signals): boolean {
      if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, signal ?? "SIGTERM");
          return true;
        } catch {
          // group already reaped — fall through to the direct handle
        }
      }
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
  };
}

/** Exported for the trusted-boundary test: optimizer stdout must never become events. */
export function runOptimizer(ctx: RunnerBackendContext, brokerSocket: string): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const entry = ctx.env["HONE_OPTIMIZER_ENTRY"] ?? join(repoRoot, "optimizer", "src", "main.ts");
  if (!existsSync(entry)) throw new Error(`optimizer entry not found: ${entry} (set HONE_OPTIMIZER_ENTRY)`);
  const [cmd, ...args] = optimizerCommand(ctx.env);
  if (cmd === undefined) throw new Error("empty HONE_OPTIMIZER_CMD");

  // Opaque diagnostics sink — NEVER parsed, NEVER an event source.
  const optLog = createWriteStream(join(ctx.runDir, "optimizer.log"), { flags: "a" });
  const scratch = join(ctx.runDir, "opt-scratch");
  mkdirSync(scratch, { recursive: true });

  // ACCEPTED RISK (M0 boundary ruling): this is a same-UID host process, so
  // OS-level containment (Docker socket, CAS, admin socket) is not enforced —
  // acceptable only because at M0 the loop binary is session-authored seed
  // code, never mutated output. M1 (first mutated optimizer) requires the
  // loop in a container + broker TCP relay (VirtioFS blocks unix-socket
  // mounts on macOS). Mitigations here: minimal explicit env (no inherited
  // shell env / credentials), cwd outside the repo, no event channel.
  const child = spawn(cmd, [...args, entry], {
    cwd: scratch,
    env: {
      ...(ctx.env["PATH"] !== undefined ? { PATH: ctx.env["PATH"] } : {}),
      HONE_BROKER_SOCK: brokerSocket,
      HONE_RUN_ID: ctx.runId,
      HONE_SEED: String(ctx.config.seed),
      // Events.ndjson is the store of record and reconciliation may have just
      // appended recovered incumbents — replay from disk, not the supervisor's
      // pre-backend snapshot, so the resume hint sees the durable authority.
      HONE_RESUME: JSON.stringify(resumeHint(ctx.runDir)),
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so SIGTERM/SIGKILL reaches every descendant.
    detached: process.platform !== "win32",
  });
  ctx.registerChild(groupKillHandle(child));
  child.stdout.pipe(optLog, { end: false });
  child.stderr.pipe(optLog, { end: false });

  const done = deferred<void>();
  child.on("error", (err) => done.reject(err));
  child.on("close", (code, signal) => {
    optLog.end();
    if (ctx.signal.aborted) return done.resolve(); // supervisor-initiated wind-down
    if (code === 0) return done.resolve();
    done.reject(new Error(`optimizer exited ${code ?? `signal ${signal ?? "?"}`} — see ${join(ctx.runDir, "optimizer.log")}`));
  });
  return done.promise;
}

/** The slice of the broker's runner API that resume reconciliation needs (DI seam for the recovery tests). */
export interface AuthorityRecoverySource {
  replayIncumbentEvents(alreadyLogged: number): number;
  getBudget(ctx: CallContext): BudgetState;
}

/**
 * Review finding 11: promotions are fsynced into broker-state.ndjson BEFORE
 * their incumbent.new event reaches events.ndjson, so a crash in that window
 * leaves the event log behind the journal — replay would then finish or
 * deliver an older/null "best" while the broker idempotently swallows the
 * re-report. Count alignment over the two append-only ordered logs re-emits
 * exactly the missing promotions through the normal event sink, then one
 * budget snapshot so budget authority reconverges too. Idempotent across
 * repeated resumes; throws (fail closed) when the event log claims MORE
 * promotions than the durable journal.
 */
export function reconcileBrokerAuthority(
  runDir: string,
  broker: AuthorityRecoverySource,
  emit: (event: RunEvent) => RunEvent,
  runId: string,
): number {
  const alreadyLogged = readEvents(runDir).filter((e) => e.type === "incumbent.new").length;
  const recovered = broker.replayIncumbentEvents(alreadyLogged);
  if (recovered > 0) {
    emit({ runId, at: new Date().toISOString(), type: "budget.snapshot", budget: broker.getBudget({ privileged: true }) });
  }
  return recovered;
}

/** Journal filename — mirrors the broker's internal STATE_FILE (not exported; format owned by @hone/broker RunStateLog). */
const BROKER_STATE_FILE = "broker-state.ndjson";

/** The journal's promotion line — the authority a dead-supervisor seal must not strand. */
const JournalIncumbentLine = z.object({
  t: z.literal("incumbent"),
  hash: z.string(),
  aggregate: z.number(),
  deltaVsBaseline: z.number(),
  episode: z.number().int().nonnegative(),
});
export type JournalIncumbent = z.infer<typeof JournalIncumbentLine>;

const JournalLinePeek = z.object({ t: z.string() }).passthrough();

/**
 * Dead-supervisor seal guard (final-gate finding): the broker journal's full
 * ordered promotion history. Returns null when the run never had a journal
 * (stub/legacy backends — nothing to reconcile). Throws on an unreadable or
 * corrupt journal — fail CLOSED: an explicit resume beats sealing stale
 * state. Torn-tail semantics mirror the broker's RunStateLog: only
 * newline-terminated lines exist; a trailing partial was never acknowledged.
 */
export function readJournalIncumbents(runDir: string): JournalIncumbent[] | null {
  const p = join(runDir, BROKER_STATE_FILE);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split("\n");
  lines.pop(); // torn or empty tail
  const incumbents: JournalIncumbent[] = [];
  for (let i = 0; i < lines.length; i++) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i] ?? "");
    } catch {
      throw new Error(`broker journal corrupt at line ${i + 1}: ${p}`);
    }
    const peek = JournalLinePeek.safeParse(raw);
    if (!peek.success) throw new Error(`broker journal corrupt at line ${i + 1}: ${p}`);
    if (peek.data["t"] !== "incumbent") continue;
    const inc = JournalIncumbentLine.safeParse(raw);
    if (!inc.success) throw new Error(`broker journal incumbent line ${i + 1} malformed: ${p}`);
    incumbents.push(inc.data);
  }
  return incumbents;
}

/**
 * Exact sequence alignment between the journal's promotion history and the
 * public incumbent.new events — count, order, hash, aggregate, delta, and
 * episode all match. Anything less means the event log is missing durable
 * authority and MUST NOT be sealed or applied.
 */
export function incumbentsAligned(journal: readonly JournalIncumbent[], events: readonly RunEvent[]): boolean {
  const publicSeq = events.flatMap((e) => (e.type === "incumbent.new" ? [e] : []));
  if (publicSeq.length !== journal.length) return false;
  return journal.every((j, i) => {
    const e = publicSeq[i];
    return (
      e !== undefined &&
      e.artifact.hash === j.hash &&
      e.aggregate === j.aggregate &&
      e.deltaVsBaseline === j.deltaVsBaseline &&
      e.episode === j.episode
    );
  });
}

export function createBackend(deps: { run?: RunCommand } = {}): RunnerBackend {
  const run = deps.run ?? runCommand;
  const startWithAuthority = async (ctx: RunnerBackendContext, authority: { resolve(): void }): Promise<void> => {
    // NO abort check anywhere in setup: even a stop landing at startup
    // must reach the broker journal + reconciliation below, or the
    // supervisor would terminalize a STALE event-log best while the
    // journal holds a newer durable incumbent (permanently, since a
    // finished run never resumes). Abort is honored only after reconcile.
    validateCapsule(ctx.capsuleDir, ctx.manifest);

      const route = ctx.config.routing["mutation"];
      if (route === undefined) {
        throw new Error('run config has no "mutation" model route — pass --config with {"routing":{"mutation":{"model":"…"}}}');
      }

      const cas = new CasStore(ctx.casDir);
      const baselineArtifactHash = await measureBaseline(ctx.capsuleDir, cas);

      // Broker + proxy are mutually referential (proxy meters INTO the broker,
      // broker env points sandboxes AT the proxy); the late-bound ref breaks the cycle.
      let running: RunningBroker | null = null;
      const checkBudget = (): BudgetDecision => {
        if (running === null) return { allowed: false, dimension: "wallClockSec", message: "broker not started" };
        const { envelope, spent } = running.broker.getBudget({ privileged: true });
        if (spent.tokens >= envelope.maxTokens) return { allowed: false, dimension: "tokens" };
        if (spent.usd >= envelope.maxUsd) return { allowed: false, dimension: "usd" };
        if (spent.wallClockSec >= envelope.maxWallClockSec) return { allowed: false, dimension: "wallClockSec" };
        if (spent.evaluatorInvocations >= envelope.maxEvaluatorInvocations) return { allowed: false, dimension: "evaluatorInvocations" };
        // Raw remaining = envelope - recorded spend; the proxy layers its own
        // in-flight reservations on top (do not pre-subtract proxy activity).
        return {
          allowed: true,
          remaining: { tokens: envelope.maxTokens - spent.tokens, usd: envelope.maxUsd - spent.usd },
        };
      };

      const proxy = createProxy({
        runId: ctx.runId,
        routing: ctx.config.routing,
        runDir: ctx.runDir,
        casDir: ctx.casDir,
        upstreamBaseUrl: ctx.env["HONE_UPSTREAM_BASE_URL"] ?? DEFAULT_UPSTREAM,
        ...(ctx.env["HONE_UPSTREAM_API_KEY"] !== undefined ? { upstreamApiKey: ctx.env["HONE_UPSTREAM_API_KEY"] } : {}),
        checkBudget,
        recordSpend: (spend) => {
          running?.broker.recordSpend({ tokens: spend.tokens, usd: spend.usd }, { privileged: true });
        },
      });

      const image = ctx.env["HONE_MUTATION_IMAGE"] ?? "hone-mutation:latest";
      let egress: Egress | null = null;
      try {
        // Finding 10: a crashed prior supervisor's labeled containers, the
        // deterministic relay/network, and dead sockets must be gone before
        // this run mints the same names again.
        await sweepStaleRunResources(ctx.runId, ctx.runDir, run);
        egress = await setupEgress(ctx, proxy, image, run);

        running = await startBroker({
          runId: ctx.runId,
          // The RUN envelope (config) is what the broker meters — it may tighten the capsule's.
          manifest: { ...ctx.manifest, budget: ctx.config.budget },
          capsuleRootDir: ctx.capsuleDir,
          baselineArtifactHash,
          image,
          runDir: ctx.runDir,
          casDir: ctx.casDir,
          runCommand: run,
          // Quota-enforcing docker tmpfs volume for /scratch (landed broker API).
          scratchVolume: true,
          onEvent: (event) => ctx.emit(event),
          sandboxNetwork: egress.sandboxNetwork,
          mutationEnv: {
            ...(egress.proxyBaseUrl !== null ? { HONE_PROXY_BASE_URL: egress.proxyBaseUrl } : {}),
            HONE_PROXY_TOKEN: proxy.tokenFor("mutation"),
            HONE_MODEL_ID: route.model,
          },
          episodeOrigin: ctx.replayed.nextEpisode,
        });

        // Finding 11: replay journaled-but-unlogged promotions into
        // events.ndjson BEFORE anything can terminalize the run, so
        // best/status/delivery and the resume hint all see the durable
        // incumbent exactly once — even when a stop aborted mid-startup.
        reconcileBrokerAuthority(ctx.runDir, running.broker, ctx.emit, ctx.runId);
        authority.resolve();

        // Only AFTER durable authority is reconciled may a stop short-circuit:
        // the optimizer never launches; the finally unwinds proxy/broker/egress.
        if (ctx.signal.aborted) return;

        await runOptimizer(ctx, running.socketPath);

        // Final trusted budget line so the exit report reflects total spend.
        ctx.emit({
          runId: ctx.runId,
          at: new Date().toISOString(),
          type: "budget.snapshot",
          budget: running.broker.getBudget({ privileged: true }),
        });
      } finally {
        await proxy.close().catch(() => {});
        if (running !== null) await running.close().catch(() => {});
        if (egress !== null) await egress.cleanup().catch(() => {});
      }
  };

  return {
    async start(ctx: RunnerBackendContext): Promise<void> {
      // Registered SYNCHRONOUSLY, before the first await: the supervisor's
      // hard-stop may fence events while the (slow, docker-bound) setup
      // above is still running — the fence and any terminal event must wait
      // for this barrier so the reconciled incumbent is never dropped.
      const authority = deferred<void>();
      ctx.registerAuthorityBarrier(authority.promise);
      try {
        await startWithAuthority(ctx, authority);
      } catch (err) {
        // Settle-once: a no-op when authority was already established; a
        // pre-reconcile failure marks the run non-terminalizable.
        authority.reject(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
  };
}
