import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunCommand } from "@hone/broker";
import {
  OPTIMIZER_BUILD_CONTRACT,
  collectOptimizerSnapshot,
  optimizerOverridden,
  snapshotDigest,
  writeOptimizerStaging,
} from "../optimizer-digest.js";
import type { RunnerBackendContext } from "../types.js";

/**
 * Containerized optimizer execution (M1 boundary): the loop NEVER runs as a
 * host process. Backend setup recollects the allowlisted snapshot, proves it
 * still hashes to the digest sealed into run.started, writes the captured
 * bytes to a staging tree, and compiles them with `bun build` inside the
 * pinned manifest image — no network, read-only source mount, isolated
 * writable output, no repo mount, no host env. The resulting bundle then runs
 * in a separate --rm, labeled, read-only, uid/gid 2000 container with
 * resource caps and ONLY the bundle (plus, on Linux, the public broker
 * socket) mounted. It receives runId/seed/resume/maxEpisodes and the public
 * broker capability; never the host repo, runDir, CAS, capsule, holdout
 * ledger, proxy credentials, or the Docker socket.
 */

/** In-container mount points fixed by OPTIMIZER_BUILD_CONTRACT. */
const SRC_MOUNT = "/hone/src";
const OUT_MOUNT = "/hone/out";
const BUNDLE_MOUNT = "/hone/bundle";
/** Linux transport: the public broker socket's in-container path. */
export const CONTAINER_BROKER_SOCK = "/run/hone/broker.sock";
const MISSING_CONTAINER_RE = /no such container|is not running|no such object/i;

/** Shared hard caps for both optimizer containers (build + run). */
const RESOURCE_ARGS = [
  "--user", "2000:2000",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--pids-limit", "512",
  "--memory", "2147483648",
  "--cpus", "2",
] as const;

/** How the containerized optimizer reaches the broker. */
export type OptimizerTransport =
  | {
      /** macOS: authenticated public TCP listener; the container joins the already-internal egress network. */
      kind: "tcp";
      endpoint: string;
      token: string;
      network: string;
    }
  | {
      /** Linux: ONLY the public broker.sock bind-mounted; --network none. */
      kind: "unix";
      hostSocketPath: string;
    };

/** The slice of ChildProcess the optimizer launcher consumes (DI seam for tests). */
export interface OptimizerChildLike {
  pid?: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface OptimizerSpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  detached: boolean;
}

/** Spawn seam: production passes node:child_process spawn; tests intercept the docker argv. */
export type OptimizerSpawn = (cmd: string, args: string[], opts: OptimizerSpawnOptions) => OptimizerChildLike;

/** Everything runOptimizer needs to launch invocations of the sealed optimizer. */
export interface OptimizerRuntime {
  image: string;
  runId: string;
  /** Docker-name-safe run id (labels use the raw id). */
  safeRunId: string;
  transport: OptimizerTransport;
  /** Host dir holding the built bundle; null under an HONE_OPTIMIZER_CMD argv override. */
  bundleDir: string | null;
  /** Exact argv executed INSIDE the run container. */
  runArgv: string[];
  spawnImpl: OptimizerSpawn;
  run: RunCommand;
  /** Container names spawned so far — reaped by cleanup() and the stale-label sweep. */
  spawnedNames: string[];
  invocation: number;
  /** Reap containers and remove temp staging/output trees. Idempotent. */
  cleanup(): Promise<void>;
}

export function optimizerBuildName(safeRunId: string): string {
  return `hone-optbuild-${safeRunId}`;
}

export function optimizerRunName(safeRunId: string, invocation: number): string {
  return `hone-opt-${safeRunId}-${invocation}`;
}

/** Exact build-container argv (also part of the digest via OPTIMIZER_BUILD_CONTRACT.build). */
export function optimizerBuildArgs(opts: { runId: string; safeRunId: string; image: string; stagingDir: string; outDir: string }): string[] {
  return [
    "docker", "run", "--rm",
    "--log-driver", "none",
    "--name", optimizerBuildName(opts.safeRunId),
    "--label", `hone.runId=${opts.runId}`,
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=268435456",
    "-e", "HOME=/tmp",
    ...RESOURCE_ARGS,
    "-v", `${opts.stagingDir}:${SRC_MOUNT}:ro`,
    "-v", `${opts.outDir}:${OUT_MOUNT}`,
    opts.image,
    ...OPTIMIZER_BUILD_CONTRACT.build,
  ];
}

/**
 * Exact run-container argv. The TCP token is deliberately ABSENT: it travels
 * as a value-less `-e HONE_BROKER_TOKEN` resolved from the docker client's
 * process env, so it never appears in argv (host ps) or any log.
 */
export function optimizerRunArgs(opts: {
  name: string;
  runId: string;
  image: string;
  transport: OptimizerTransport;
  bundleDir: string | null;
  runArgv: string[];
  env: Record<string, string>;
}): string[] {
  const argv = [
    "docker", "run", "--rm",
    "--log-driver", "none",
    "--name", opts.name,
    "--label", `hone.runId=${opts.runId}`,
    "--network", opts.transport.kind === "tcp" ? opts.transport.network : "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=268435456",
    "-w", "/tmp",
    "-e", "HOME=/tmp",
    ...RESOURCE_ARGS,
  ];
  if (opts.bundleDir !== null) argv.push("-v", `${opts.bundleDir}:${BUNDLE_MOUNT}:ro`);
  if (opts.transport.kind === "unix") argv.push("-v", `${opts.transport.hostSocketPath}:${CONTAINER_BROKER_SOCK}`);
  for (const [k, v] of Object.entries(opts.env)) argv.push("-e", `${k}=${v}`);
  if (opts.transport.kind === "tcp") argv.push("-e", "HONE_BROKER_TOKEN");
  argv.push(opts.image, ...opts.runArgv);
  return argv;
}

/** The in-container broker endpoint env value for a transport. */
export function transportEndpoint(transport: OptimizerTransport): string {
  return transport.kind === "tcp" ? transport.endpoint : CONTAINER_BROKER_SOCK;
}

function mustSpawnedCommand(env: NodeJS.ProcessEnv): string[] {
  const override = env["HONE_OPTIMIZER_CMD"];
  if (override === undefined || override.trim().length === 0) return [...OPTIMIZER_BUILD_CONTRACT.run];
  return override.trim().split(/\s+/);
}

/**
 * One-time (per backend start) preparation shared by the probe invocation and
 * the full relaunch: digest re-proof, staging, and the container build. The
 * returned runtime is reused by every invocation of this run.
 */
export async function prepareOptimizerRuntime(
  ctx: Pick<RunnerBackendContext, "runId" | "env" | "optimizerDigest">,
  opts: { image: string; transport: OptimizerTransport; run: RunCommand; spawnImpl: OptimizerSpawn },
): Promise<OptimizerRuntime> {
  const safeRunId = ctx.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const tempDirs: string[] = [];
  const cleanupRuntime = async (): Promise<void> => {
    const failures: string[] = [];
    for (const name of [optimizerBuildName(safeRunId), ...runtime.spawnedNames]) {
      try {
        const result = await opts.run(["docker", "rm", "-f", name], { timeoutMs: 30_000 });
        if (result.exitCode !== 0 && !MISSING_CONTAINER_RE.test(result.stderr.toString("utf8"))) {
          failures.push(`container ${name}: ${result.stderr.toString("utf8").trim() || `exit ${result.exitCode}`}`);
        }
      } catch (err) {
        failures.push(`container ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        failures.push(`temporary directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) throw new Error(`optimizer cleanup incomplete: ${failures.join("; ")}`);
    runtime.spawnedNames.length = 0;
    tempDirs.length = 0;
  };

  const runtime: OptimizerRuntime = {
    image: opts.image,
    runId: ctx.runId,
    safeRunId,
    transport: opts.transport,
    bundleDir: null,
    runArgv: mustSpawnedCommand(ctx.env),
    spawnImpl: opts.spawnImpl,
    run: opts.run,
    spawnedNames: [],
    invocation: 0,
    cleanup: cleanupRuntime,
  };

  if (optimizerOverridden(ctx.env)) {
    // In-container argv override (dev/test seam): the sealed digest is the
    // operator's explicit pin (enforced at resolveOptimizerDigest); there is
    // no snapshot to rebuild — and no host execution, ever.
    return runtime;
  }

  // Exact-execution proof: what runs is what was sealed. Recollect the
  // allowlisted graph and require the digest to reproduce run.started's seal.
  const snapshot = collectOptimizerSnapshot();
  const digest = snapshotDigest(opts.image, snapshot);
  if (digest !== ctx.optimizerDigest) {
    throw new Error(
      `optimizer drift at launch: snapshot digest ${digest} != sealed ${ctx.optimizerDigest} — refusing to execute (resume re-seals only via a fresh run)`,
    );
  }

  const stagingDir = mkdtempSync(join(tmpdir(), "hone-optsrc-"));
  tempDirs.push(stagingDir);
  const outDir = mkdtempSync(join(tmpdir(), "hone-optout-"));
  tempDirs.push(outDir);
  try {
    // The captured bytes — not a re-read of the repo — become the build input.
    writeOptimizerStaging(snapshot, stagingDir);
    chmodSync(stagingDir, 0o755); // readable by the container's uid 2000
    chmodSync(outDir, 0o777); // writable by the container's uid 2000
    const built = await opts.run(optimizerBuildArgs({ runId: ctx.runId, safeRunId, image: opts.image, stagingDir, outDir }), {
      timeoutMs: 600_000,
    });
    if (built.exitCode !== 0) {
      throw new Error(`optimizer bundle build failed (exit ${built.exitCode}): ${built.stderr.toString("utf8").slice(0, 2000)}`);
    }
    const bundle = join(outDir, "optimizer.mjs");
    if (!existsSync(bundle)) throw new Error(`optimizer bundle build produced no ${bundle}`);
  } catch (err) {
    await runtime.cleanup();
    throw err;
  }
  runtime.bundleDir = outDir;
  return runtime;
}
