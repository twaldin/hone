import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RunEvent, type ArtifactRef, type BudgetState, type CapsuleManifest } from "@hone/schema";
import { CasStore, isBrokerAuthoredEvent, packDirAsArtifact, readBrokerJournalEvents, runCommand, startBroker } from "@hone/broker";
import type { CallContext, RunCommand, RunningBroker, SandboxNetworkMode } from "@hone/broker";
import { createProxy, DEFAULT_UPSTREAM } from "@hone/proxy";
import type { BudgetDecision, ProxyHandle } from "@hone/proxy";
import { admitCapsule } from "../admission.js";
import { readEvents, replayRun } from "../eventlog.js";
import { deferred } from "../promise.js";
import { materializeGitCommit } from "../git-baseline.js";
import type { ChildLike, ProbeReport, RunnerBackend, RunnerBackendContext } from "../types.js";
import {
  optimizerRunArgs,
  optimizerRunName,
  prepareOptimizerRuntime,
  transportEndpoint,
} from "./optimizer-container.js";
import type { OptimizerChildLike, OptimizerRuntime, OptimizerSpawn, OptimizerTransport } from "./optimizer-container.js";

/**
 * The real runner backend (WP7): composes broker + metering proxy + the
 * containerized optimizer behind the same seam the stub implements.
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
 * Optimizer topology (see backends/optimizer-container.ts): the loop executes
 * ONLY as a bundle compiled from the digest-sealed snapshot, inside an
 * unprivileged uid/gid-2000 container with no host repo/runDir/CAS/capsule/
 * holdout/credential/Docker-socket exposure. Broker transport follows the
 * egress topology:
 *   network (darwin default)  the broker opens its authenticated public TCP
 *           listener on 127.0.0.1:0 with a fresh ≥256-bit token; a second
 *           dual-network relay exposes that listener only inside the
 *           per-run internal network. The optimizer dials the relay and
 *           presents the token on every request. The token travels via the
 *           docker client's env (value-less -e), never argv or logs.
 *   socket (linux default)    ONLY the public broker.sock is bind-mounted
 *           read/write at /run/hone/broker.sock; --network none; no admin
 *           socket, no token.
 * The child has NO event authority: its stdout/stderr go verbatim to
 * runDir/optimizer.log as opaque diagnostics. Every RunEvent is derived
 * trusted-side — runner lifecycle here/in the supervisor, everything else by
 * the broker from the method calls it serves.
 */

/** Entries never packed into a NON-git (cas) baseline artifact (mirrors capsules/tools/ordering-check.ts). */
const BASELINE_SKIP: Record<string, true> = { ".git": true, ".gitdir": true, __pycache__: true, ".pytest_cache": true };

const RELAY_PORT = 8080;
const RELAY_RESOURCE_ARGS = [
  "--read-only",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--pids-limit", "32",
  "--memory", "64m",
  "--memory-swap", "64m",
  "--cpus", "0.25",
  "--ulimit", "nofile=128:128",
  "--user", "1000:1000",
  "--log-driver", "none",
] as const;
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

/**
 * Trusted pre-flight drift gate (defense in depth behind runCommand's frozen
 * admission): the capsule must RE-ADMIT — id recompute, exact asset-hash set,
 * hashed ordering report, clean baseline worktree — and reproduce the exact
 * digest the supervisor sealed for this run.
 */
export function validateCapsule(capsuleDir: string, expectedDigest: string): void {
  const admitted = admitCapsule(capsuleDir);
  if (admitted.digest !== expectedDigest) {
    throw new Error(`capsule drift: digest ${admitted.digest} != sealed ${expectedDigest} — start a fresh run (or re-run capsules/tools/scaffold.ts)`);
  }
}


/**
 * Anti-sandbagging: the baseline artifact is measured (packed) by the trusted
 * runner, never taken from capsule metadata. A git baseline is EXACT: the
 * declared commit's tree is materialized through a temporary detached
 * worktree, so ignored/untracked worktree content (an injected module, a
 * stray __pycache__) can never enter the canonical artifact. A cas baseline
 * has no commit to materialize; its directory is packed minus worktree noise.
 */
export async function measureBaseline(capsuleDir: string, manifest: CapsuleManifest, cas: CasStore): Promise<string> {
  const baselineDir = join(capsuleDir, "baseline");
  if (!existsSync(baselineDir)) throw new Error(`capsule has no baseline/ directory: ${capsuleDir}`);
  const staging = mkdtempSync(join(tmpdir(), "hone-baseline-"));
  try {
    if (manifest.baseline.kind === "git") {
      materializeGitCommit(baselineDir, manifest.baseline.commit, staging);
      return await packDirAsArtifact(staging, cas);
    }
    for (const entry of readdirSync(baselineDir)) {
      if (BASELINE_SKIP[entry] === true) continue;
      cpSync(join(baselineDir, entry), join(staging, entry), { recursive: true });
    }
    const packed = await packDirAsArtifact(staging, cas);
    if (packed !== manifest.baseline.hash) {
      throw new Error(`measured CAS baseline ${packed} != manifest baseline ${manifest.baseline.hash}`);
    }
    return packed;
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
function dockerNames(runId: string): {
  network: string;
  relay: string;
  brokerRelay: string;
  scratchVolume: string;
  scratchKeeper: string;
} {
  const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return {
    network: `hone-${safe}`,
    relay: `hone-proxy-${safe}`,
    brokerRelay: `hone-broker-${safe}`,
    scratchVolume: `hone-scratch-${safe}`,
    scratchKeeper: `hone-scratch-keeper-${safe}`,
  };
}

const MISSING_DOCKER_RESOURCE = /no such container|no such network|no such volume|no such object|not found/i;
const SCRATCH_SNAPSHOT_SCRIPT =
  "set -eu; total=$(find /scratch -type f -exec stat -c %s {} + | awk '{s+=$1} END{print s+0}'); " +
  "[ \"$total\" -le \"${HONE_SCRATCH_QUOTA_BYTES:?}\" ] || { echo 'scratch apparent size exceeds quota' >&2; exit 1; }; " +
  "tar -cf /snapshot/scratch.tar.tmp -C /scratch .; mv -f /snapshot/scratch.tar.tmp /snapshot/scratch.tar";

async function dockerRemovalFailure(run: RunCommand, argv: string[], what: string): Promise<string | undefined> {
  try {
    const res = await run(argv, { timeoutMs: 120_000 });
    if (res.exitCode === 0 || MISSING_DOCKER_RESOURCE.test(res.stderr.toString("utf8"))) return undefined;
    return `${what}: ${res.stderr.toString("utf8").slice(0, 2000) || `exit ${res.exitCode}`}`;
  } catch (err) {
    return `${what}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Crash-recovery sweep: remove every labeled/deterministically named
 * per-run Docker resource plus stale sockets. Default mode remains
 * best-effort for diagnostics; startup and dead-run finalization pass
 * `strict=true` and refuse to proceed while any resource may remain.
 */
export async function sweepStaleRunResources(
  runId: string,
  runDir: string,
  run: RunCommand = runCommand,
  strict = false,
): Promise<void> {
  const { network, relay, brokerRelay, scratchVolume, scratchKeeper } = dockerNames(runId);
  const failures: string[] = [];
  // A killed supervisor leaves the keeper mounted, so the tmpfs still has its
  // last mutable state. Snapshot it before removing ANY labeled container.
  const keeper = await run(["docker", "inspect", "-f", "{{.State.Running}}", scratchKeeper], { timeoutMs: 30_000 });
  if (keeper.exitCode === 0 && keeper.stdout.toString("utf8").trim() === "true") {
    mkdirSync(join(runDir, "scratch-snapshot"), { recursive: true });
    const snapshot = await run(
      ["docker", "exec", "-u", "root", scratchKeeper, "/bin/sh", "-c", SCRATCH_SNAPSHOT_SCRIPT],
      { timeoutMs: 300_000 },
    );
    if (snapshot.exitCode !== 0 || snapshot.timedOut) {
      const failure = `scratch snapshot: ${snapshot.stderr.toString("utf8").slice(0, 2000) || `exit ${snapshot.exitCode}`}`;
      if (strict) throw new Error(`stale run cleanup incomplete: ${failure}`);
      return;
    }
  } else if (
    keeper.exitCode !== 0 &&
    strict &&
    !MISSING_DOCKER_RESOURCE.test(keeper.stderr.toString("utf8"))
  ) {
    throw new Error(
      `stale run cleanup incomplete: scratch keeper discovery: ${
        keeper.stderr.toString("utf8").slice(0, 2000) || `exit ${keeper.exitCode}`
      }`,
    );
  }

  const containers = await run(["docker", "ps", "-aq", "--filter", `label=hone.runId=${runId}`], { timeoutMs: 30_000 });
  if (containers.exitCode === 0) {
    const ids = containers.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (ids.length > 0) {
      const failure = await dockerRemovalFailure(run, ["docker", "rm", "-f", ...ids], "labeled containers");
      if (failure !== undefined) failures.push(failure);
    }
  } else if (strict) {
    failures.push(`container discovery: ${containers.stderr.toString("utf8").slice(0, 2000) || `exit ${containers.exitCode}`}`);
  }

  for (const name of [relay, brokerRelay]) {
    const failure = await dockerRemovalFailure(run, ["docker", "rm", "-f", name], `container ${name}`);
    if (failure !== undefined) failures.push(failure);
  }

  const volumes = await run(["docker", "volume", "ls", "-q", "--filter", `label=hone.runId=${runId}`], { timeoutMs: 30_000 });
  const volumeNames = new Set([scratchVolume]);
  if (volumes.exitCode === 0) {
    for (const name of volumes.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0)) {
      volumeNames.add(name);
    }
  } else if (strict) {
    failures.push(`volume discovery: ${volumes.stderr.toString("utf8").slice(0, 2000) || `exit ${volumes.exitCode}`}`);
  }
  for (const name of volumeNames) {
    const failure = await dockerRemovalFailure(run, ["docker", "volume", "rm", "-f", name], `volume ${name}`);
    if (failure !== undefined) failures.push(failure);
  }

  const networkFailure = await dockerRemovalFailure(run, ["docker", "network", "rm", network], `network ${network}`);
  if (networkFailure !== undefined) failures.push(networkFailure);
  for (const sock of ["proxy.sock", "broker.sock", "broker-admin.sock"]) {
    rmSync(join(runDir, sock), { force: true });
  }
  if (strict && failures.length > 0) {
    throw new Error(`stale run cleanup incomplete: ${failures.join("; ")}`);
  }
}

interface Egress {
  sandboxNetwork: SandboxNetworkMode;
  /** HONE_PROXY_BASE_URL for sandboxes; null on the unix-socket path (the worker bridges the mounted socket). */
  proxyBaseUrl: string | null;
  /** Expose a host-loopback broker listener through a token-authenticated relay on the internal network. */
  exposeBroker(hostPort: number): Promise<string>;
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
    return {
      sandboxNetwork: { mode: "none" },
      proxyBaseUrl: null,
      exposeBroker: async () => {
        throw new Error("broker TCP relay is unavailable on socket egress");
      },
      cleanup: async () => {},
    };
  }
  if (mode !== "network") throw new Error(`HONE_EGRESS must be "socket" or "network", got "${mode}"`);

  const { network, relay, brokerRelay } = dockerNames(ctx.runId);
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
  let brokerRelayStarted = false;
  const cleanup = async (): Promise<void> => {
    const failures: string[] = [];
    for (const [argv, what] of [
      [["docker", "rm", "-f", brokerRelay], `container ${brokerRelay}`],
      [["docker", "rm", "-f", relay], `container ${relay}`],
      [["docker", "network", "rm", network], `network ${network}`],
    ] as const) {
      const failure = await dockerRemovalFailure(run, [...argv], what);
      if (failure !== undefined) failures.push(failure);
    }
    if (failures.length > 0) throw new Error(`egress cleanup incomplete: ${failures.join("; ")}`);
  };
  try {
    await mustRun(run,
      [
        "docker", "run", "-d",
        ...RELAY_RESOURCE_ARGS,
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
  const exposeBroker = async (hostPort: number): Promise<string> => {
    if (!Number.isInteger(hostPort) || hostPort <= 0 || hostPort > 65_535) {
      throw new Error(`invalid broker relay target port: ${hostPort}`);
    }
    if (brokerRelayStarted) throw new Error("broker relay already started");
    try {
      await mustRun(
        run,
        [
          "docker", "run", "-d",
          ...RELAY_RESOURCE_ARGS,
          "--name", brokerRelay,
          "--network", network,
          "--label", `hone.runId=${ctx.runId}`,
          "--add-host", "host.docker.internal:host-gateway",
          "-e", `HONE_RELAY_PORT=${hostPort}`,
          image,
          "node", "-e", RELAY_JS,
        ],
        "docker run (broker relay)",
      );
      await mustRun(run, ["docker", "network", "connect", "bridge", brokerRelay], "docker network connect broker relay");
      brokerRelayStarted = true;
      return `tcp://${brokerRelay}:${RELAY_PORT}`;
    } catch (err) {
      const cleanupFailure = await dockerRemovalFailure(run, ["docker", "rm", "-f", brokerRelay], `container ${brokerRelay}`);
      if (cleanupFailure !== undefined) {
        throw new Error(`${err instanceof Error ? err.message : String(err)}; ${cleanupFailure}`);
      }
      throw err;
    }
  };
  return {
    sandboxNetwork: { mode: "internal", network },
    proxyBaseUrl: `http://${relay}:${RELAY_PORT}/v1`,
    exposeBroker,
    cleanup,
  };
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
 * Kill handle covering the optimizer container AND its docker client. The
 * foreground `docker run` proxies SIGTERM into the container (sig-proxy), but
 * SIGKILLing the client alone would ORPHAN the container — so the handle also
 * drives the daemon directly: TERM -> `docker kill -s TERM`, KILL ->
 * `docker rm -f`. Fire-and-forget: the supervisor's barrier polls the client
 * PID, which exits when the container dies.
 */
function containerKillHandle(child: OptimizerChildLike, name: string, run: RunCommand): ChildLike {
  return {
    pid: child.pid,
    kill(signal?: NodeJS.Signals): boolean {
      const sig = signal ?? "SIGTERM";
      void run(sig === "SIGKILL" ? ["docker", "rm", "-f", name] : ["docker", "kill", "-s", "TERM", name], { timeoutMs: 30_000 }).catch(() => {});
      if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, sig);
          return true;
        } catch {
          // client group already reaped — fall through to the direct handle
        }
      }
      try {
        return child.kill(sig);
      } catch {
        return false;
      }
    },
  };
}

const DEFAULT_OPTIMIZER_LOG_LIMIT_BYTES = 4 * 1024 * 1024;

function optimizerLogLimit(env: NodeJS.ProcessEnv): number {
  const raw = env["HONE_OPTIMIZER_LOG_LIMIT_BYTES"];
  const value = raw === undefined ? DEFAULT_OPTIMIZER_LOG_LIMIT_BYTES : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("HONE_OPTIMIZER_LOG_LIMIT_BYTES must be a positive safe integer");
  }
  return value;
}

function cappedDiagnosticAppender(
  stream: NodeJS.WritableStream,
  limit: number,
  existingBytes: number,
): (chunk: unknown) => void {
  let remaining = Math.max(0, limit - existingBytes);
  let sealed = remaining === 0;
  const marker = Buffer.from(`\n[optimizer.log truncated at ${limit} bytes]\n`, "utf8");
  return (chunk: unknown): void => {
    if (sealed) return;
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return;
    const bytes = Buffer.from(chunk);
    const markerBytes = Math.min(marker.length, remaining);
    const contentCapacity = Math.max(0, remaining - markerBytes);
    if (bytes.length <= contentCapacity) {
      stream.write(bytes);
      remaining -= bytes.length;
      return;
    }
    if (contentCapacity > 0) stream.write(bytes.subarray(0, contentCapacity));
    if (markerBytes > 0) stream.write(marker.subarray(0, markerBytes));
    remaining = 0;
    sealed = true;
  };
}

/**
 * Launch ONE invocation of the sealed optimizer container. Exported for the
 * trusted-boundary tests: optimizer stdout must never become events.
 * `opts.maxEpisodes` bounds the invocation (probe gate); otherwise an
 * operator HONE_MAX_EPISODES passes through and the optimizer fails closed
 * on invalid values.
 */
export function runOptimizer(ctx: RunnerBackendContext, runtime: OptimizerRuntime, opts: { maxEpisodes?: number } = {}): Promise<void> {
  const name = optimizerRunName(runtime.safeRunId, ++runtime.invocation);
  runtime.spawnedNames.push(name);

  // Opaque diagnostics sink — NEVER parsed, NEVER an event source. Both
  // streams and every invocation/resume share one hard byte ceiling.
  const optLogPath = join(ctx.runDir, "optimizer.log");
  const logLimit = optimizerLogLimit(ctx.env);
  if (existsSync(optLogPath) && statSync(optLogPath).size > logLimit) truncateSync(optLogPath, logLimit);
  const existingLogBytes = existsSync(optLogPath) ? statSync(optLogPath).size : 0;
  const optLog = createWriteStream(optLogPath, { flags: "a" });
  const appendDiagnostic = cappedDiagnosticAppender(optLog, logLimit, existingLogBytes);
  const argv = optimizerRunArgs({
    name,
    runId: ctx.runId,
    image: runtime.image,
    transport: runtime.transport,
    bundleDir: runtime.bundleDir,
    runArgv: runtime.runArgv,
    env: {
      HONE_BROKER_SOCK: transportEndpoint(runtime.transport),
      HONE_RUN_ID: ctx.runId,
      HONE_SEED: String(ctx.config.seed),
      // Episode bound: the probe pins 1; a full launch inherits any operator
      // cap (count of episodes attempted THIS invocation, optimizer-enforced).
      ...(opts.maxEpisodes !== undefined
        ? { HONE_MAX_EPISODES: String(opts.maxEpisodes) }
        : ctx.env["HONE_MAX_EPISODES"] !== undefined
          ? { HONE_MAX_EPISODES: ctx.env["HONE_MAX_EPISODES"] }
          : {}),
      // Events.ndjson is the store of record and reconciliation may have just
      // appended recovered incumbents — replay from disk, not the supervisor's
      // pre-backend snapshot, so the resume hint sees the durable authority.
      HONE_RESUME: JSON.stringify(resumeHint(ctx.runDir)),
    },
  });
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error("empty optimizer container argv");
  // The docker CLIENT env is minimal and explicit: PATH/HOME so the client
  // itself works, plus the TCP capability resolved by the value-less -e —
  // the token never enters argv and is never logged.
  const child = runtime.spawnImpl(cmd, args, {
    env: {
      ...(ctx.env["PATH"] !== undefined ? { PATH: ctx.env["PATH"] } : {}),
      ...(ctx.env["HOME"] !== undefined ? { HOME: ctx.env["HOME"] } : {}),
      ...(ctx.env["DOCKER_HOST"] !== undefined ? { DOCKER_HOST: ctx.env["DOCKER_HOST"] } : {}),
      ...(runtime.transport.kind === "tcp" ? { HONE_BROKER_TOKEN: runtime.transport.token } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so signals reach the docker client and any fakes.
    detached: process.platform !== "win32",
  });
  const handle = containerKillHandle(child, name, runtime.run);
  const unregister = ctx.registerChild(handle);
  child.stdout?.on("data", appendDiagnostic);
  child.stderr?.on("data", appendDiagnostic);

  const done = deferred<void>();
  let childSettled = false;
  const settleAfterLog = (settle: () => void): void => {
    if (childSettled) return;
    childSettled = true;
    optLog.end(settle);
  };
  const reap = (): void => {
    // --rm removes the container on exit; force the name free for the next
    // invocation even when the daemon's async removal lags or wedges.
    void runtime.run(["docker", "rm", "-f", name], { timeoutMs: 30_000 }).catch(() => {});
  };
  child.on("error", (err) => {
    // A spawn error has no live child to reap. Drop the supervisor handle
    // before the daemon-name cleanup; never retain a nonexistent PID.
    unregister();
    reap();
    settleAfterLog(() => done.reject(err));
  });
  child.on("close", (code, signal) => {
    // `close` means Node has reaped the process. Its PID/PGID is now reusable:
    // unregister BEFORE any await/callback, and only clean Docker by name.
    unregister();
    reap();
    settleAfterLog(() => {
      if (ctx.signal.aborted) return done.resolve();
      if (code === 0) return done.resolve();
      done.reject(new Error(`optimizer exited ${code ?? `signal ${signal ?? "?"}`} — see ${join(ctx.runDir, "optimizer.log")}`));
    });
  });
  return done.promise;
}

/** The slice of the broker's runner API that resume reconciliation needs (DI seam for the recovery tests). */
export interface AuthorityRecoverySource {
  replayJournalEvents?(alreadyLogged: readonly RunEvent[]): number;
  replayIncumbentEvents(alreadyLogged: number): number;
  getBudget(ctx: CallContext): BudgetState;
}

/**
 * Current journals fsync each broker-authored event with the authority fact
 * that produced it, then recover an exact missing suffix before optimizer
 * resume. Legacy journals fall back to incumbent count alignment and one
 * current budget snapshot. A non-prefix gap fails closed in the broker.
 */
export function reconcileBrokerAuthority(
  runDir: string,
  broker: AuthorityRecoverySource,
  emit: (event: RunEvent) => RunEvent,
  runId: string,
): number {
  const logged = readEvents(runDir);
  const journalRecovered = broker.replayJournalEvents?.(logged) ?? 0;
  const afterJournal = journalRecovered > 0 ? readEvents(runDir) : logged;
  const alreadyLogged = afterJournal.filter((event) => event.type === "incumbent.new").length;
  const legacyRecovered = broker.replayIncumbentEvents(alreadyLogged);
  if (legacyRecovered > 0) {
    emit({
      runId,
      at: new Date().toISOString(),
      type: "budget.snapshot",
      budget: broker.getBudget({ privileged: true }),
    });
  }
  // Legacy journals have no complete event transactions. Replayed incumbents
  // remain visible for manual recovery, but strict terminal sealing rejects
  // them until a fresh broker-authored journal exists.
  return journalRecovered + legacyRecovered;
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

/** Complete, schema-validated broker-authored event history for dead-run sealing. */
export function readJournalEvents(runDir: string): RunEvent[] | null {
  return readBrokerJournalEvents(runDir);
}

/** Exclusive broker types align exactly; all journal records occur in full order. */
export function journalEventsAligned(journal: readonly RunEvent[], events: readonly RunEvent[]): boolean {
  const publicExclusive = events.filter(isBrokerAuthoredEvent);
  const journalExclusive = journal.filter(isBrokerAuthoredEvent);
  if (
    publicExclusive.length !== journalExclusive.length
    || !journalExclusive.every((event, index) => JSON.stringify(event) === JSON.stringify(publicExclusive[index]))
  ) return false;
  const publicLines = events.map((event) => JSON.stringify(event));
  let cursor = 0;
  for (const event of journal) {
    const found = publicLines.indexOf(JSON.stringify(event), cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
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

/**
 * Trusted paired probe measurement, derived ONLY from broker-authored events
 * in the run log. Uses the newest episode that produced a completed
 * evaluation; a probe attempt that measured nothing fails closed (the run
 * stays resumable — an incomplete episode is never a successful probe).
 */
export function deriveProbeReport(events: readonly RunEvent[], budget: BudgetState): ProbeReport {
  let episode = -1;
  for (const e of events) {
    if (e.type === "eval.completed" && e.episode !== undefined && e.episode > episode) episode = e.episode;
  }
  if (episode < 0) throw new Error("probe produced no completed evaluation — cannot derive a paired report (see optimizer.log)");
  let parent: ArtifactRef | null = null;
  let candidate: ArtifactRef | null = null;
  let parentScore: number | null = null;
  let childScore: number | null = null;
  const evals = new Map<string, { aggregate: number; assetGroupId: string; seed: number }>();
  for (const e of events) {
    if (e.type === "episode.started" && e.episode === episode) parent = e.parent;
    else if (e.type === "episode.candidate" && e.episode === episode) candidate = e.candidate;
    else if (e.type === "gate.paired" && e.episode === episode) {
      parentScore = e.parentScore;
      childScore = e.childScore;
    } else if (e.type === "eval.completed" && e.episode === episode) {
      evals.set(e.artifact.hash, { aggregate: e.aggregate, assetGroupId: e.assetGroupId, seed: e.seed });
    }
  }
  if (parent === null) throw new Error(`probe episode ${episode} has no episode.started — the log is not a complete probe`);
  const parentEval = evals.get(parent.hash);
  const baselineAggregate = parentEval?.aggregate ?? parentScore;
  if (baselineAggregate === null) throw new Error(`probe episode ${episode} has no baseline measurement — cannot derive a paired report`);
  const candidateEval = candidate !== null ? evals.get(candidate.hash) : undefined;
  const candidateAggregate = candidateEval?.aggregate ?? childScore;
  const coordinate = candidateEval ?? parentEval ?? [...evals.values()][0];
  if (coordinate === undefined) throw new Error(`probe episode ${episode} has no evaluations`);
  return {
    baseline: { artifact: parent, aggregate: baselineAggregate },
    candidate:
      candidate !== null && candidateAggregate !== null
        ? { artifact: candidate, aggregate: candidateAggregate, delta: candidateAggregate - baselineAggregate }
        : null,
    assetGroupId: coordinate.assetGroupId,
    seed: coordinate.seed,
    budget,
  };
}

export function createBackend(deps: { run?: RunCommand; spawnOptimizer?: OptimizerSpawn } = {}): RunnerBackend {
  const run = deps.run ?? runCommand;
  const spawnImpl: OptimizerSpawn = deps.spawnOptimizer ?? ((cmd, args, opts) => spawn(cmd, args, opts));
  const startWithAuthority = async (
    ctx: RunnerBackendContext,
    authority: { resolve(): void; reject(err: Error): void },
    cleanup: { resolve(): void; reject(err: Error): void },
  ): Promise<void> => {
    // NO abort check anywhere in setup: even a stop landing at startup
    // must reach the broker journal + reconciliation below, or the
    // supervisor would terminalize a STALE event-log best while the
    // journal holds a newer durable incumbent (permanently, since a
    // finished run never resumes). Abort is honored only after reconcile.
    validateCapsule(ctx.capsuleDir, ctx.capsuleDigest);

      const route = ctx.config.routing["mutation"];
      if (route === undefined) {
        throw new Error('run config has no "mutation" model route — pass --config with {"routing":{"mutation":{"model":"…"}}}');
      }

      const cas = new CasStore(ctx.casDir);
      const baselineArtifactHash = await measureBaseline(ctx.capsuleDir, ctx.manifest, cas);

      // Broker + proxy are mutually referential (proxy meters INTO the broker,
      // broker env points sandboxes AT the proxy); the late-bound ref breaks the cycle.
      let running: RunningBroker | null = null;
      const checkBudget = (): BudgetDecision => {
        if (running === null) return { allowed: false, dimension: "wallClockSec", message: "broker not started" };
        const latched = running.broker.getBudgetExhaustion({ privileged: true });
        if (latched !== undefined) return { allowed: false, dimension: latched };
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
        recordBudgetExhaustion: (dimension) => {
          running?.broker.recordBudgetExhaustion(dimension, { privileged: true });
        },
      });

      // The frozen manifest's immutable image is THE image — mutation
      // sandboxes, eval sandboxes, the macOS relay, AND both optimizer
      // containers (build + run) all run it. There is deliberately no
      // environment override.
      const image = ctx.manifest.image;
      let egress: Egress | null = null;
      let optimizer: OptimizerRuntime | null = null;
      try {
        // Finding 10: a crashed prior supervisor's labeled containers (incl.
        // optimizer build/run), the deterministic relay/network, and dead
        // sockets must be gone before this run mints the same names again.
        await sweepStaleRunResources(ctx.runId, ctx.runDir, run, true);
        egress = await setupEgress(ctx, proxy, image, run);

        // Broker transport for the containerized optimizer follows the
        // egress topology: internal-network egress (darwin default) gets the
        // authenticated public TCP listener with a fresh ≥256-bit capability;
        // unix egress (linux default) bind-mounts ONLY public broker.sock.
        const tcpToken = egress.sandboxNetwork.mode === "internal" ? randomBytes(32).toString("hex") : null;

        const rawMaxEpisodes = ctx.env["HONE_MAX_EPISODES"];
        const maxMutationEpisodes = rawMaxEpisodes === undefined ? 64 : Number(rawMaxEpisodes);
        if (!Number.isSafeInteger(maxMutationEpisodes) || maxMutationEpisodes <= 0) {
          throw new Error(`HONE_MAX_EPISODES must be a positive integer, got ${JSON.stringify(rawMaxEpisodes)}`);
        }

        const brokerConfig = {
          runId: ctx.runId,
          // The RUN config is what the broker enforces: its envelope may
          // tighten the capsule's, and an approved contract edit may have
          // revised the objective the optimizer pursues (broker/getTask
          // serves manifest.objective). The frozen snapshot keeps the
          // capsule's original identity; the contract hash seals this run's
          // overrides.
          manifest: { ...ctx.manifest, objective: ctx.config.objective, budget: ctx.config.budget },
          capsuleRootDir: ctx.capsuleDir,
          baselineArtifactHash,
          image,
          capsuleDigest: ctx.capsuleDigest,
          optimizerDigest: ctx.optimizerDigest,
          // Repo-lifetime holdout ledger, keyed by capsule digest so every
          // run of this exact capsule draws from ONE budget. Lives under the
          // CAS root (broker creates the file and parents).
          holdoutLedgerPath: join(ctx.casDir, "ledgers", `${ctx.capsuleDigest.replace(/^sha256:/, "")}.ndjson`),
          // The lifetime ledger budget is pinned to the FROZEN capsule
          // envelope, never the editable per-run budget — the shared ledger
          // header must stay identical across every run of this capsule.
          holdoutBudget: ctx.manifest.budget.maxEvaluatorInvocations,
          runDir: ctx.runDir,
          casDir: ctx.casDir,
          runCommand: run,
          // Quota-enforcing docker tmpfs volume for /scratch (landed broker API).
          scratchVolume: true,
          onEvent: (event: RunEvent) => ctx.emit(event),
          sandboxNetwork: egress.sandboxNetwork,
          mutationEnv: {
            ...(egress.proxyBaseUrl !== null ? { HONE_PROXY_BASE_URL: egress.proxyBaseUrl } : {}),
            HONE_PROXY_TOKEN: proxy.tokenFor("mutation"),
            HONE_MODEL_ID: route.model,
          },
          episodeOrigin: ctx.replayed.nextEpisode,
          maxMutationEpisodes,
          maxCandidateArtifacts: Math.min(Number.MAX_SAFE_INTEGER, maxMutationEpisodes * 2),
        };
        running =
          tcpToken !== null
            ? await startBroker(brokerConfig, { publicTcp: { host: "127.0.0.1", port: 0, token: tcpToken } })
            : await startBroker(brokerConfig);

        // Finding 11: replay journaled-but-unlogged promotions into
        // events.ndjson BEFORE anything can terminalize the run, so
        // best/status/delivery and the resume hint all see the durable
        // incumbent exactly once — even when a stop aborted mid-startup.
        reconcileBrokerAuthority(ctx.runDir, running.broker, ctx.emit, ctx.runId);

        // Only AFTER durable authority is reconciled may a stop short-circuit:
        // the optimizer never launches; the finally unwinds proxy/broker/egress.
        if (ctx.signal.aborted) return;

        let transport: OptimizerTransport;
        if (tcpToken !== null && egress.sandboxNetwork.mode === "internal") {
          const addr = running.publicTcpAddress;
          if (addr === undefined) throw new Error("broker did not open the requested public TCP listener");
          transport = {
            kind: "tcp",
            endpoint: await egress.exposeBroker(addr.port),
            token: tcpToken,
            network: egress.sandboxNetwork.network,
          };
        } else {
          transport = { kind: "unix", hostSocketPath: running.socketPath };
        }

        // One-time exact-snapshot proof + container build, reused by BOTH the
        // probe invocation and the full relaunch.
        optimizer = await prepareOptimizerRuntime(ctx, { image, transport, run, spawnImpl });
        if (ctx.signal.aborted) return;

        // VI.4 probe gate: a fresh run gets one optimizer episode; a resume
        // that crashed while the owner was answering reuses the already
        // completed broker-authored pair instead of buying another episode.
        // The verdict is sealed as probe.completed. A durable approval skips
        // this gate forever; a durable decline requests a trusted stop.
        const probe = replayRun(ctx.runDir).probe;
        if (probe !== null && !probe.approved) {
          // Durable decline that never terminalized (crash window): honor it.
          ctx.requestStop();
          return;
        }
        if (probe === null) {
          let report: ProbeReport | undefined;
          try {
            const recovered = deriveProbeReport(readEvents(ctx.runDir), running.broker.getBudget({ privileged: true }));
            // A lone parent measurement is startup state, not a completed
            // candidate pair. Only recover evidence that can support approval.
            if (recovered.candidate !== null) report = recovered;
          } catch {
            // No complete pair exists yet: run the one-episode probe now.
          }
          if (report === undefined) {
            await runOptimizer(ctx, optimizer, { maxEpisodes: 1 });
            if (ctx.signal.aborted) return;
            report = deriveProbeReport(readEvents(ctx.runDir), running.broker.getBudget({ privileged: true }));
          }
          const approved = await ctx.probeGate(report);
          // An abort that landed DURING the gate must not seal a durable
          // verdict — the owner never answered; the run stays resumable and
          // the probe re-gates on the next resume.
          if (ctx.signal.aborted) return;
          ctx.emit({
            runId: ctx.runId,
            at: new Date().toISOString(),
            type: "probe.completed",
            approved,
            baseline: report.baseline,
            candidate: report.candidate,
            assetGroupId: report.assetGroupId,
            seed: report.seed,
            budget: report.budget,
          });
          if (!approved) {
            ctx.requestStop();
            return;
          }
          if (ctx.signal.aborted) return;
        }

        await runOptimizer(ctx, optimizer);

        // Final budget is authority too: journal before public delivery so a
        // transient append failure is repaired by the final reconcile below.
        running.broker.snapshotBudget({ privileged: true });
      } finally {
        // Full-teardown barrier: every failure is COLLECTED — a half-closed
        // proxy must not skip broker/egress/container teardown. Any failure
        // rejects the cleanup barrier (run stays unterminalized) WITHOUT
        // masking the body's own error; full success resolves it.
        const failures: string[] = [];
        const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
        await proxy.close().catch((e: unknown) => failures.push(`proxy: ${message(e)}`));
        if (running !== null) {
          // Close first: close() rejects new RPCs, reaps containers, and waits
          // every already-admitted handler. A killed optimizer may have left
          // a request in flight; reconciling before this drain would let that
          // handler journal after the authority fence and lose its public
          // event. Broker.close collects teardown errors but always drains
          // operations and closes the journal before returning.
          await running.close().catch((e: unknown) => failures.push(`broker: ${message(e)}`));
          try {
            // No broker fact can be appended after close has drained. Repair
            // the exact journal suffix, then and only then release the
            // supervisor's authority fence.
            reconcileBrokerAuthority(ctx.runDir, running.broker, ctx.emit, ctx.runId);
            authority.resolve();
          } catch (e) {
            const failure = e instanceof Error ? e : new Error(String(e));
            authority.reject(failure);
            failures.push(`authority reconciliation: ${failure.message}`);
          }
        }
        if (optimizer !== null) await optimizer.cleanup().catch((e: unknown) => failures.push(`optimizer containers: ${message(e)}`));
        if (egress !== null) await egress.cleanup().catch((e: unknown) => failures.push(`egress: ${message(e)}`));
        if (failures.length > 0) cleanup.reject(new Error(`backend teardown incomplete: ${failures.join("; ")}`));
        else cleanup.resolve();
      }
  };

  return {
    async start(ctx: RunnerBackendContext): Promise<void> {
      // Both barriers are registered SYNCHRONOUSLY, before the first await.
      // Authority: the supervisor's hard-stop may fence events while the
      // (slow, docker-bound) setup above is still running — the fence and any
      // terminal event must wait for this barrier so the reconciled incumbent
      // is never dropped. Cleanup: the supervisor never delivers, emits
      // run.finished, or returns until optimizer/build containers, broker,
      // proxy, egress, and temp snapshots have fully closed; a cleanup
      // failure rejects the barrier and leaves the run unterminalized.
      const authority = deferred<void>();
      ctx.registerAuthorityBarrier(authority.promise);
      const cleanup = deferred<void>();
      ctx.registerCleanupBarrier(cleanup.promise);
      try {
        await startWithAuthority(ctx, authority, cleanup);
      } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        // Settle-once: a no-op when authority was already established; a
        // pre-reconcile failure marks the run non-terminalizable.
        authority.reject(failure);
        throw failure;
      } finally {
        // Backstop for throws BEFORE the teardown try (capsule validation,
        // baseline measurement, proxy construction): nothing was opened, so
        // cleanup is trivially complete. No-op when already settled.
        cleanup.resolve();
      }
    },
  };
}
