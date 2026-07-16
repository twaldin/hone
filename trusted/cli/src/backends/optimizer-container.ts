import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunCommand } from "@hone/broker";
import type { DockerCreateGate } from "../docker-create-gate.js";
import {
  OPTIMIZER_BUILD_CONTRACT,
  OPTIMIZER_BUNDLE_FILES,
  collectOptimizerSnapshot,
  optimizerOverridden,
  snapshotDigest,
  writeOptimizerStaging,
} from "../optimizer-digest.js";
import type { RunnerBackendContext } from "../types.js";

/**
 * Containerized optimizer execution (trusted boundary): the loop NEVER runs as a
 * host process. Backend setup recollects the allowlisted snapshot, proves it
 * still hashes to the digest sealed into run.started, writes the captured
 * bytes to a staging tree, and compiles them with `bun build` inside the
 * pinned manifest image — no network, read-only source mount, isolated
 * writable output, no repo mount, no host env. The build container runs as
 * the invoking NUMERIC host uid/gid and writes into a host-created,
 * 0700-rooted output tree: no other host UID can traverse, list, unlink, or
 * replace the bundle (never a world-writable handoff dir). Trusted code then
 * SEALS the output — lstats each required file (regular, single-link,
 * owner-owned), captures its exact bytes and SHA-256, freezes all write
 * permission — and re-verifies that seal immediately before EVERY run
 * container create: path existence alone grants no authority. The bundle
 * runs in a separate labeled, read-only, uid/gid 2000 container with
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

/** Shared hard caps for both optimizer containers; each argv pins its own --user (build: numeric host uid/gid; run: 2000:2000). */
const HARDENING_ARGS = [
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
      /** Linux: ONLY the public broker.sock bind-mounted; --network none. The 0666 socket is world-connectable, so it demands the same bearer as TCP. */
      kind: "unix";
      hostSocketPath: string;
      token: string;
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

/** Sealed identity of one built bundle file: the exact bytes trusted code captured after the successful build. */
export interface SealedBundleFile {
  /** Bundle filename inside the output dir (an OPTIMIZER_BUNDLE_FILES member). */
  name: string;
  /** SHA-256 (hex) of the captured bytes — the run mounts ONLY content that still hashes to this. */
  sha256: string;
  size: number;
  /** Inode identity at capture: a swapped-in file refuses even when its bytes happen to match. */
  ino: number;
  dev: number;
}

/** Trusted capture of the build output: taken once after a successful build, re-verified immediately before EVERY run-container create. */
export interface OptimizerBundleSeal {
  /** 0700 owner-only umbrella dir — no other host UID can traverse to (list/unlink/replace) anything below it. */
  root: string;
  /** The mounted output dir (`root`/out); all write permission removed after sealing (0555, files 0444). */
  dir: string;
  /** Owning numeric host uid — the build container ran as exactly this user. */
  uid: number;
  dirIno: number;
  dirDev: number;
  files: SealedBundleFile[];
}

/** Everything runOptimizer needs to launch invocations of the sealed optimizer. */
export interface OptimizerRuntime {
  image: string;
  runId: string;
  /** Docker-name-safe run id (labels use the raw id). */
  safeRunId: string;
  transport: OptimizerTransport;
  /** Host dir holding the built bundle; null under an HONE_OPTIMIZER_CMD argv override. When non-null, bundleSeal MUST verify before every create. */
  bundleDir: string | null;
  /** Sealed bundle identities (bytes' hashes, inodes, owner) captured by trusted code after the build; null only under an argv override. */
  bundleSeal: OptimizerBundleSeal | null;
  /** Exact argv executed INSIDE the run container. */
  runArgv: string[];
  spawnImpl: OptimizerSpawn;
  run: RunCommand;
  /** Container names spawned so far — reaped by cleanup() and the stale-label sweep. */
  spawnedNames: string[];
  invocation: number;
  /** Docker-run lease (stopped per-epoch donor) name — every per-run container attaches `--volumes-from <lease>:ro` (crash-window causal fence). REQUIRED: the production omission of the lease on run containers was a P1. */
  containerLease: string;
  /** Write-ahead docker-create latch: every create joins a definitive daemon response or leaves a durable open intent. */
  gate: DockerCreateGate;
  /** Frozen docker client env — the endpoint resolution pinned at backend start; used by BOTH client spawns. */
  clientEnv: NodeJS.ProcessEnv;
  /** Reap containers and remove temp staging/output trees. Idempotent. */
  cleanup(): Promise<void>;
}

export function optimizerBuildName(safeRunId: string): string {
  return `hone-optbuild-${safeRunId}`;
}

export function optimizerRunName(safeRunId: string, invocation: number): string {
  return `hone-opt-${safeRunId}-${invocation}`;
}

/** Exact build-container argv (in-container command sealed via OPTIMIZER_BUILD_CONTRACT.build). Runs as the NUMERIC host uid/gid so it can write into the host-created 0700-rooted output dir — never a world-writable handoff. The gated RunCommand rewrites this `docker run` two-phase (joined create, bounded start). */
export function optimizerBuildArgs(opts: {
  runId: string;
  safeRunId: string;
  image: string;
  stagingDir: string;
  outDir: string;
  /** Docker-run lease (stopped per-epoch donor) name; attaches `--volumes-from <lease>:ro` before the image. */
  containerLease: string;
  /** Numeric invoking host uid/gid: the ONLY identity that may write the output dir. */
  hostUid: number;
  hostGid: number;
}): string[] {
  return [
    "docker", "run", "--rm",
    // Digest-pinned manifest image MUST already be present: never let a
    // daemon-side create linger through an image pull.
    "--pull=never",
    "--log-driver", "none",
    "--name", optimizerBuildName(opts.safeRunId),
    "--label", `hone.runId=${opts.runId}`,
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=268435456",
    "-e", "HOME=/tmp",
    "--user", `${opts.hostUid}:${opts.hostGid}`,
    ...HARDENING_ARGS,
    "-v", `${opts.stagingDir}:${SRC_MOUNT}:ro`,
    "-v", `${opts.outDir}:${OUT_MOUNT}`,
    "--volumes-from", `${opts.containerLease}:ro`,
    opts.image,
    ...OPTIMIZER_BUILD_CONTRACT.build,
  ];
}

/**
 * Exact run-container CREATE argv (phase one of two: the caller joins this
 * `docker create` to a definitive daemon response, then runs a separately
 * bounded `docker start -a`, see optimizerStartArgs). No `--rm`: the awaited
 * post-exit reap removes the container by name deterministically, and start
 * exit codes never race the daemon's auto-remove. The broker token is
 * deliberately ABSENT for BOTH transports (the 0666 unix socket demands the
 * same bearer as TCP): it travels as a value-less `-e HONE_BROKER_TOKEN`
 * resolved from the docker CREATE client's process env (container env is
 * baked at create time), so it never appears in argv (host ps) or any log.
 */
export function optimizerCreateArgs(opts: {
  name: string;
  runId: string;
  image: string;
  transport: OptimizerTransport;
  bundleDir: string | null;
  runArgv: string[];
  env: Record<string, string>;
  /** Docker-run lease (stopped per-epoch donor) name; attaches `--volumes-from <lease>:ro` before the image. */
  containerLease: string;
}): string[] {
  const argv = [
    "docker", "create",
    // Digest-pinned manifest image MUST already be present: never let a
    // daemon-side create linger through an image pull.
    "--pull=never",
    "--log-driver", "none",
    "--name", opts.name,
    "--label", `hone.runId=${opts.runId}`,
    "--network", opts.transport.kind === "tcp" ? opts.transport.network : "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=268435456",
    "-w", "/tmp",
    "-e", "HOME=/tmp",
    "--user", "2000:2000",
    ...HARDENING_ARGS,
  ];
  if (opts.bundleDir !== null) argv.push("-v", `${opts.bundleDir}:${BUNDLE_MOUNT}:ro`);
  if (opts.transport.kind === "unix") argv.push("-v", `${opts.transport.hostSocketPath}:${CONTAINER_BROKER_SOCK}`);
  for (const [k, v] of Object.entries(opts.env)) argv.push("-e", `${k}=${v}`);
  argv.push("-e", "HONE_BROKER_TOKEN"); // value-less on EVERY transport: resolved from the CREATE client env, never argv
  argv.push("--volumes-from", `${opts.containerLease}:ro`);
  argv.push(opts.image, ...opts.runArgv);
  return argv;
}

/** Phase two: bounded, killable attach-start of the already-registered container. */
export function optimizerStartArgs(name: string): string[] {
  return ["docker", "start", "-a", name];
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


/** Numeric invoking host uid/gid: the build container runs as exactly this user so it can write into the 0700-rooted output tree (never a world-writable dir). */
function mustHostIds(): { uid: number; gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("optimizer build requires POSIX numeric uid/gid (process.getuid/getgid) — unsupported platform");
  }
  return { uid, gid };
}

function mustLstat(abs: string, what: string): Stats {
  try {
    return lstatSync(abs);
  } catch {
    throw new Error(`${what} missing or unreadable: ${abs} — refusing`);
  }
}

/**
 * Trusted capture of the build output, taken ONCE right after a successful
 * build and BEFORE any run container may mount the dir: lstat each required
 * file (regular — a symlink/special refuses; single hard link; owned by the
 * invoking uid), read and hash its exact bytes, freeze it read-only (0444),
 * then remove the directory's write permission (0555: the run container's
 * uid 2000 keeps r-x through the bind mount; nothing below can be created,
 * unlinked, or renamed). The 0700 `root` umbrella already denies every other
 * host UID traversal, so listing/unlinking/replacing is impossible for them
 * outright; the seal additionally pins inode identities and hashes so even a
 * same-uid path swap refuses at verify time.
 */
function sealBundleDir(root: string, dir: string, uid: number): OptimizerBundleSeal {
  const files: SealedBundleFile[] = [];
  for (const name of OPTIMIZER_BUNDLE_FILES) {
    const abs = join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(abs);
    } catch {
      throw new Error(`optimizer bundle build produced no ${abs}`);
    }
    if (!st.isFile()) throw new Error(`optimizer bundle output is not a regular file (symlink/special refused): ${abs}`);
    if (st.nlink !== 1) throw new Error(`optimizer bundle output has ${st.nlink} hard links — refusing aliased ${abs}`);
    if (st.uid !== uid) throw new Error(`optimizer bundle output ${abs} is owned by uid ${st.uid}, not the invoking uid ${uid} — refusing`);
    const bytes = readFileSync(abs);
    chmodSync(abs, 0o444);
    files.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, ino: st.ino, dev: st.dev });
  }
  chmodSync(dir, 0o555);
  const dirSt = lstatSync(dir);
  return { root, dir, uid, dirIno: dirSt.ino, dirDev: dirSt.dev, files };
}

/**
 * Refuse-to-launch gate, called immediately before EVERY run-container
 * `docker create`: path existence grants no authority. The 0700 umbrella,
 * the mounted dir, and both bundle files must still be the exact inodes
 * trusted code sealed — regular, owned by the invoking uid, stripped of all
 * write permission — and the file bytes must re-hash to the captured
 * SHA-256s. Any symlink, inode replacement, owner, mode, or content swap
 * throws before the daemon ever sees the create.
 */
export function verifyOptimizerBundleSeal(runtime: Pick<OptimizerRuntime, "bundleDir" | "bundleSeal">): void {
  if (runtime.bundleDir === null) return; // argv override: no bundle is mounted
  const seal = runtime.bundleSeal;
  if (seal === null) throw new Error("optimizer bundle was never sealed — refusing to create the run container");
  if (seal.dir !== runtime.bundleDir) {
    throw new Error(`optimizer bundle dir drifted from its seal: ${runtime.bundleDir} != ${seal.dir} — refusing`);
  }
  const rootSt = mustLstat(seal.root, "sealed bundle root");
  if (!rootSt.isDirectory()) throw new Error(`sealed bundle root is not a directory: ${seal.root} — refusing`);
  if (rootSt.uid !== seal.uid) throw new Error(`sealed bundle root ${seal.root} is owned by uid ${rootSt.uid}, not ${seal.uid} — refusing`);
  if ((rootSt.mode & 0o077) !== 0) {
    throw new Error(`sealed bundle root ${seal.root} is group/other-accessible (mode ${(rootSt.mode & 0o777).toString(8)}) — refusing`);
  }
  const dirSt = mustLstat(seal.dir, "sealed bundle dir");
  if (!dirSt.isDirectory()) throw new Error(`sealed bundle dir is not a directory: ${seal.dir} — refusing`);
  if (dirSt.ino !== seal.dirIno || dirSt.dev !== seal.dirDev) throw new Error(`sealed bundle dir was replaced: ${seal.dir} — refusing`);
  if (dirSt.uid !== seal.uid) throw new Error(`sealed bundle dir ${seal.dir} is owned by uid ${dirSt.uid}, not ${seal.uid} — refusing`);
  if ((dirSt.mode & 0o222) !== 0) {
    throw new Error(`sealed bundle dir ${seal.dir} regained write permission (mode ${(dirSt.mode & 0o777).toString(8)}) — refusing`);
  }
  for (const f of seal.files) {
    const abs = join(seal.dir, f.name);
    const st = mustLstat(abs, "sealed bundle file");
    if (!st.isFile()) throw new Error(`sealed bundle file is not a regular file (symlink/special refused): ${abs}`);
    if (st.ino !== f.ino || st.dev !== f.dev) throw new Error(`sealed bundle file was replaced (inode changed): ${abs} — refusing`);
    if (st.nlink !== 1) throw new Error(`sealed bundle file has ${st.nlink} hard links — refusing aliased ${abs}`);
    if (st.uid !== seal.uid) throw new Error(`sealed bundle file ${abs} is owned by uid ${st.uid}, not ${seal.uid} — refusing`);
    if ((st.mode & 0o222) !== 0) {
      throw new Error(`sealed bundle file ${abs} regained write permission (mode ${(st.mode & 0o777).toString(8)}) — refusing`);
    }
    const digest = createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (digest !== f.sha256) {
      throw new Error(`sealed bundle bytes drifted: ${abs} hashes ${digest} != sealed ${f.sha256} — refusing to execute`);
    }
  }
}

/**
 * One-time (per backend start) preparation shared by the probe invocation and
 * the full relaunch: digest re-proof, staging, and the container build. The
 * returned runtime is reused by every invocation of this run.
 */
export async function prepareOptimizerRuntime(
  ctx: Pick<RunnerBackendContext, "runId" | "env" | "optimizerDigest">,
  opts: { image: string; transport: OptimizerTransport; run: RunCommand; spawnImpl: OptimizerSpawn; containerLease: string; gate: DockerCreateGate; clientEnv: NodeJS.ProcessEnv },
): Promise<OptimizerRuntime> {
  const safeRunId = ctx.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const tempDirs: string[] = [];
  /** Sealed (write-permission-stripped) output dir; cleanup restores OWNER mode only so removal can proceed. */
  let frozenOutDir: string | null = null;
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
    if (frozenOutDir !== null) {
      // Trusted-only restore: put owner access back (0700, never wider) so
      // the recursive removal below can unlink the frozen bundle.
      try {
        chmodSync(frozenOutDir, 0o700);
      } catch {
        // rmSync below surfaces the real failure if any
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
    bundleSeal: null,
    runArgv: mustSpawnedCommand(ctx.env),
    spawnImpl: opts.spawnImpl,
    run: opts.run,
    spawnedNames: [],
    invocation: 0,
    containerLease: opts.containerLease,
    gate: opts.gate,
    clientEnv: opts.clientEnv,
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

  const { uid, gid } = mustHostIds();
  // Staging: 0700 (mkdtemp default) — the build container runs as the owner
  // uid, so nothing needs to be opened to other users.
  const stagingDir = mkdtempSync(join(tmpdir(), "hone-optsrc-"));
  tempDirs.push(stagingDir);
  // Output: a 0700 owner-only umbrella (mkdtemp default) with the actual
  // mount dir nested below it. No other host UID can traverse the umbrella —
  // list, unlink, or replace anything — while the nested dir itself can drop
  // to r-x after sealing so the run container's uid 2000 still reads the
  // bundle through the bind mount (the daemon resolves the mount path as
  // root; traversal of the 0700 umbrella never involves uid 2000).
  const outRoot = mkdtempSync(join(tmpdir(), "hone-optout-"));
  tempDirs.push(outRoot);
  const outDir = join(outRoot, "out");
  mkdirSync(outDir, { mode: 0o700 });
  frozenOutDir = outDir;
  try {
    // The captured bytes — not a re-read of the repo — become the build input.
    writeOptimizerStaging(snapshot, stagingDir);
    const built = await opts.run(
      optimizerBuildArgs({
        runId: ctx.runId,
        safeRunId,
        image: opts.image,
        stagingDir,
        outDir,
        containerLease: opts.containerLease,
        hostUid: uid,
        hostGid: gid,
      }),
      { timeoutMs: 600_000 },
    );
    if (built.exitCode !== 0) {
      throw new Error(`optimizer bundle build failed (exit ${built.exitCode}): ${built.stderr.toString("utf8").slice(0, 2000)}`);
    }
    // Seal the handoff: capture exact bytes + hashes, pin inode identities,
    // and strip all write permission before anything may mount the dir.
    runtime.bundleSeal = sealBundleDir(outRoot, outDir, uid);
  } catch (err) {
    await runtime.cleanup();
    throw err;
  }
  runtime.bundleDir = outDir;
  return runtime;
}
