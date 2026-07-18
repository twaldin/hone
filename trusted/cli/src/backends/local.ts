import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { RunEvent, type ArtifactRef, type BudgetState, type CapsuleManifest } from "@hone/schema";
import {
  CasStore,
  SCRATCH_SNAPSHOT_SCRIPT,
  finalizeScratchSnapshot,
  newScratchSnapshotAttemptName,
  isBrokerAuthoredEvent,
  diffProtectedPaths,
  packDirAsArtifact,
  unpackArtifact,
  readBrokerJournalEvents,
  runCommand,
  startBroker,
} from "@hone/broker";
import type { CallContext, RunCommand, RunningBroker, SandboxNetworkMode } from "@hone/broker";
import { createProxy, DEFAULT_UPSTREAM } from "@hone/proxy";
import type { BudgetDecision, BudgetDimension, ProxyHandle } from "@hone/proxy";
import { admitCapsule, authenticateFrozenCapsuleAssets } from "../admission.js";
import { readEvents, replayRun } from "../eventlog.js";
import { makeDockerRunLease, type DockerRunLease } from "../docker-lease.js";
import {
  CONCLUSIVE_ENGINE_REJECTION_RE,
  openDockerCreateGate,
  type DockerCreateGate,
  type DockerCreateHelper,
} from "../docker-create-gate.js";
import { deferred } from "../promise.js";
import { freezeDockerClientEnv, dockerEngineSealError, sealDockerEngine } from "../docker-engine-seal.js";
import { materializeGitCommit } from "../git-baseline.js";
import type { ChildLike, ProbeReport, RunnerBackend, RunnerBackendContext } from "../types.js";
import {
  optimizerCreateArgs,
  optimizerRunName,
  optimizerStartArgs,
  prepareOptimizerRuntime,
  transportEndpoint,
  verifyOptimizerBundleSeal,
} from "./optimizer-container.js";
import type { OptimizerChildLike, OptimizerRuntime, OptimizerSpawn, OptimizerTransport } from "./optimizer-container.js";

/**
 * The real runner backend (WP7): composes broker + metering proxy + the
 * containerized optimizer behind the same seam the stub implements.
 *
 * Egress topology (mutation sandboxes -> LLM):
 *   linux   proxy binds a deterministic short /tmp socket; the broker mounts
 *           that exact path at /run/hone/proxy.sock and the in-sandbox worker
 *           bridges loopback -> unix itself. Sandboxes stay --network none.
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
 *           listener on 127.0.0.1:0; a second dual-network relay exposes
 *           that listener only inside the per-run internal network. The
 *           optimizer dials the relay.
 *   socket (linux default)    ONLY the public broker.sock is bind-mounted
 *           read/write at /run/hone/broker.sock; --network none; no admin
 *           socket.
 * EITHER way the broker mints ONE fresh ≥256-bit capability per start and the
 * optimizer presents it on every request — the 0666 unix socket is reachable
 * by any host UID, so connectivity is never authority. The token travels via
 * the docker CREATE client's env (value-less -e), never argv or logs.
 * The child has NO event authority: its stdout/stderr go verbatim to
 * runDir/optimizer.log as opaque diagnostics. Every RunEvent is derived
 * trusted-side — runner lifecycle here/in the supervisor, everything else by
 * the broker from the method calls it serves.
 */

/** Entries never packed into a NON-git (cas) baseline artifact (mirrors capsules/tools/ordering-check.ts). */
const BASELINE_SKIP: Record<string, true> = { ".git": true, ".gitdir": true, __pycache__: true, ".pytest_cache": true };

const RELAY_PORT = 8080;
const RELAY_RESOURCE_ARGS = [
  "--pull=never",
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

export interface TerminalHoldoutBaseline {
  /** Sanitized lineage root visible to mutation sandboxes and the optimizer. */
  mutationArtifactHash: string;
  /** Full declared baseline used only for the trusted evaluator mount. */
  evaluatorArtifactHash: string;
}

/**
 * Terminal holdout uses two baseline identities: the optimizer receives a
 * copy with every protected namespace removed, while the trusted evaluator
 * executes from the full declared commit. The latter hash stays host-only.
 */
export async function measureTerminalHoldoutBaseline(
  capsuleDir: string,
  manifest: CapsuleManifest,
  cas: CasStore,
): Promise<TerminalHoldoutBaseline> {
  if (manifest.protectedPaths.length === 0) {
    throw new Error("terminal holdout requires protected evaluator paths");
  }
  const evaluatorArtifactHash = await measureBaseline(capsuleDir, manifest, cas);
  const staging = mkdtempSync(join(tmpdir(), "hone-holdout-baseline-"));
  try {
    const workspace = await unpackArtifact(cas, evaluatorArtifactHash, join(staging, "full"));
    const empty = join(staging, "empty");
    mkdirSync(empty, { mode: 0o700 });
    const hidden = await diffProtectedPaths(empty, workspace, manifest.protectedPaths);
    if (hidden.length === 0) {
      throw new Error("terminal holdout protected paths matched no evaluator source");
    }
    for (const rel of [...hidden].sort((a, b) => b.split("/").length - a.split("/").length)) {
      rmSync(join(workspace, rel), { recursive: true, force: true });
    }
    const leaked = await diffProtectedPaths(empty, workspace, manifest.protectedPaths);
    if (leaked.length > 0) {
      throw new Error(`terminal holdout evaluator source remained visible: ${leaked.join(", ")}`);
    }
    const mutationArtifactHash = await packDirAsArtifact(workspace, cas);
    if (mutationArtifactHash === evaluatorArtifactHash) {
      throw new Error("terminal holdout baseline sanitization removed no bytes");
    }
    return { mutationArtifactHash, evaluatorArtifactHash };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function mustRun(run: RunCommand, argv: string[], what: string): Promise<string> {
  const res = await run(argv, { timeoutMs: 120_000 });
  if (res.exitCode !== 0) throw new Error(`${what} failed: ${res.stderr.toString("utf8").slice(0, 2000)}`);
  return res.stdout.toString("utf8").trim();
}

/** Docker DNS labels are capped at 63 bytes; keep every derived name below that. */
function dockerNames(runId: string): {
  network: string;
  relay: string;
  brokerRelay: string;
  scratchVolume: string;
  scratchKeeper: string;
} {
  const normalized = runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const safe = normalized.length <= 40
    ? normalized
    : `${normalized.slice(0, 23)}-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
  return {
    network: `hone-${safe}`,
    relay: `hone-proxy-${safe}`,
    brokerRelay: `hone-broker-${safe}`,
    scratchVolume: `hone-scratch-${safe}`,
    scratchKeeper: `hone-scratch-keeper-${safe}`,
  };
}

const MISSING_DOCKER_RESOURCE = /no such container|no such network|no such volume|no such object|not found/i;

async function dockerRemovalFailure(run: RunCommand, argv: string[], what: string): Promise<string | undefined> {
  try {
    const res = await run(argv, { timeoutMs: 120_000 });
    if (res.exitCode === 0 || MISSING_DOCKER_RESOURCE.test(res.stderr.toString("utf8"))) return undefined;
    return `${what}: ${res.stderr.toString("utf8").slice(0, 2000) || `exit ${res.exitCode}`}`;
  } catch (err) {
    return `${what}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Best-effort sweep of every unpublished snapshot output (per-attempt files, in-container pid temps, legacy shared temps) — cleanup, never authority. */
function sweepScratchSnapshotTemps(snapshotDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(snapshotDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "scratch.tar" || !entry.startsWith("scratch.tar.tmp")) continue;
    try {
      rmSync(join(snapshotDir, entry), { force: true });
    } catch {
      // A stale unpublished temp is inert (it can never be finalized); the next attempt sweeps again.
    }
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
  const listLabeledContainers = async (): Promise<string[] | null> => {
    const listed = await run(
      ["docker", "ps", "-aq", "--no-trunc", "--filter", `label=hone.runId=${runId}`],
      { timeoutMs: 30_000 },
    );
    if (listed.exitCode === 0) {
      return listed.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    }
    const failure = `container discovery: ${listed.stderr.toString("utf8").slice(0, 2000) || `exit ${listed.exitCode}`}`;
    if (strict) throw new Error(`stale run cleanup incomplete: ${failure}`);
    return null;
  };
  const removeWriters = async (ids: readonly string[]): Promise<boolean> => {
    if (ids.length === 0) return true;
    const failure = await dockerRemovalFailure(run, ["docker", "rm", "-f", ...ids], "labeled containers");
    if (failure === undefined) return true;
    if (strict) throw new Error(`stale run cleanup incomplete: ${failure}`);
    return false;
  };

  // A killed supervisor leaves mutation containers and the keeper mounted on
  // the same tmpfs. Kill every writer BEFORE tar, then re-scan after tar. A
  // daemon-side create that completed during the snapshot forces another
  // remove+snapshot pass. A still-later create keeps the volume referenced,
  // so the strict volume-rm fence below refuses resume rather than accepting
  // a stale snapshot.
  const keeper = await run(
    ["docker", "inspect", "-f", "{{.Id}} {{.State.Running}}", scratchKeeper],
    { timeoutMs: 30_000 },
  );
  const keeperInfo = keeper.stdout.toString("utf8").trim().split(/\s+/);
  const keeperRunning = keeper.exitCode === 0 && keeperInfo.at(-1) === "true";
  const keeperId = keeperInfo.length >= 2 ? keeperInfo[0] : undefined;
  if (keeperRunning) {
    mkdirSync(join(runDir, "scratch-snapshot"), { recursive: true });
    let quiet = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await listLabeledContainers();
      if (before === null) return;
      const writers = before.filter((id) => id !== keeperId);
      if (!(await removeWriters(writers))) return;

      // The keeper env (baked at creation by the broker) carries the same
      // HONE_SCRATCH_* bounds the live snapshot path uses: kernel-enforced
      // archive byte cap and an in-container tar deadline below this host
      // timeout, so a killed sweep can never leave tar running.
      // Per-attempt unguessable output (mirrors the broker): an orphaned exec
      // from an older attempt only knows ITS OWN basename — it can neither
      // overwrite this attempt's output nor be published by it.
      const attemptName = newScratchSnapshotAttemptName();
      let snapshotFailure: string | undefined;
      try {
        const snapshot = await run(
          [
            "docker", "exec", "-u", "root",
            "-e", `HONE_SCRATCH_SNAPSHOT_OUT=${attemptName}`,
            scratchKeeper, "/bin/sh", "-c", SCRATCH_SNAPSHOT_SCRIPT,
          ],
          { timeoutMs: 300_000 },
        );
        if (snapshot.exitCode !== 0 || snapshot.timedOut) {
          snapshotFailure = `scratch snapshot: ${snapshot.stderr.toString("utf8").slice(0, 2000) || `exit ${snapshot.exitCode}`}`;
        } else {
          // Durable publication mirrors the broker: fsync tmp → rename → fsync
          // parent on the trusted HOST (BusyBox images may lack `sync -f`).
          // Only THIS attempt's exact output is ever published.
          try {
            await finalizeScratchSnapshot(join(runDir, "scratch-snapshot"), attemptName);
          } catch (err) {
            snapshotFailure = `scratch snapshot finalize: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      } finally {
        // EVERY outcome sweeps unpublished outputs (this attempt's residue and
        // any orphan's late write) — a stale archive never survives to satisfy
        // or confuse a later attempt.
        sweepScratchSnapshotTemps(join(runDir, "scratch-snapshot"));
      }
      if (snapshotFailure !== undefined) {
        if (strict) throw new Error(`stale run cleanup incomplete: ${snapshotFailure}`);
        return;
      }
      const after = await listLabeledContainers();
      if (after === null) return;
      if (after.every((id) => id === keeperId)) {
        quiet = true;
        break;
      }
    }
    if (!quiet) {
      const failure = "scratch snapshot never reached a quiescent container set";
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
  } else {
    const ids = await listLabeledContainers();
    if (ids !== null && !(await removeWriters(ids))) return;
  }

  for (const name of [scratchKeeper, relay, brokerRelay]) {
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
  removeRunHostSockets(runDir);
  if (strict && failures.length > 0) {
    throw new Error(`stale run cleanup incomplete: ${failures.join("; ")}`);
  }
}

/** Remove the run's host-side unix socket FILES (fs-only; no Docker). Shared by the sweep tail and stop's provably-never-contacted finalization. */
export function removeRunHostSockets(runDir: string): void {
  for (const sock of ["proxy.sock", "broker.sock", "broker-admin.sock"]) {
    rmSync(join(runDir, sock), { force: true });
  }
}

/**
 * Terminalization proof (stop / dead-run finalization): everything the sweep
 * above targets, re-listed. Returns a description of every per-run Docker
 * resource that STILL exists on the daemon `run` reaches — the label set
 * (containers + volumes) plus every deterministic name (keeper, relays,
 * scratch volume, network). Removal exit codes are never trusted alone: a
 * create landing daemon-side after the sweep's listing, or a sweep that ran
 * against the wrong engine, surfaces here. Discovery failures throw —
 * absence must be proven, never assumed.
 */
export async function residualRunDockerResources(runId: string, run: RunCommand): Promise<string[]> {
  const { network, relay, brokerRelay, scratchVolume, scratchKeeper } = dockerNames(runId);
  const residual: string[] = [];
  const parseLines = (stdout: Buffer): string[] =>
    stdout.toString("utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const labeled: Array<{ kind: string; argv: string[] }> = [
    { kind: "container", argv: ["docker", "ps", "-aq", "--no-trunc", "--filter", `label=hone.runId=${runId}`] },
    { kind: "volume", argv: ["docker", "volume", "ls", "-q", "--filter", `label=hone.runId=${runId}`] },
  ];
  for (const { kind, argv } of labeled) {
    const listed = await run(argv, { timeoutMs: 30_000 });
    if (listed.exitCode !== 0 || listed.timedOut) {
      throw new Error(`labeled ${kind} discovery failed: ${listed.stderr.toString("utf8").slice(0, 2000) || `exit ${listed.exitCode}`}`);
    }
    for (const id of parseLines(listed.stdout)) residual.push(`${kind} ${id}`);
  }
  // Deterministic names are proven absent individually: inspect exits
  // non-zero when ANY name is missing while still listing the ones it found,
  // so presence comes from stdout and "all gone" from the missing-pattern.
  const named: Array<{ kind: string; argv: string[] }> = [
    { kind: "container", argv: ["docker", "container", "inspect", "--format", "{{.Id}}", scratchKeeper, relay, brokerRelay] },
    { kind: "volume", argv: ["docker", "volume", "inspect", "--format", "{{.Name}}", scratchVolume] },
    { kind: "network", argv: ["docker", "network", "inspect", "--format", "{{.Name}}", network] },
  ];
  for (const { kind, argv } of named) {
    const inspected = await run(argv, { timeoutMs: 30_000 });
    const found = parseLines(inspected.stdout);
    for (const id of found) residual.push(`${kind} ${id}`);
    if (inspected.exitCode !== 0 && found.length === 0 && (inspected.timedOut || !MISSING_DOCKER_RESOURCE.test(inspected.stderr.toString("utf8")))) {
      throw new Error(`named ${kind} discovery failed: ${inspected.stderr.toString("utf8").slice(0, 2000) || `exit ${inspected.exitCode}`}`);
    }
  }
  return residual;
}

interface Egress {
  sandboxNetwork: SandboxNetworkMode;
  /** HONE_PROXY_BASE_URL for sandboxes; null on the unix-socket path (the worker bridges the mounted socket). */
  proxyBaseUrl: string | null;
  /** Host Unix socket mounted at /run/hone/proxy.sock; null on the TCP relay path. */
  proxySocketHostPath: string | null;
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
  /** Docker-run lease (stopped donor) name — relays attach `--volumes-from <lease>:ro` so removing it fences daemon-side creates. */
  containerLease?: string,
): Promise<Egress> {
  const mode = ctx.env["HONE_EGRESS"] ?? (process.platform === "darwin" ? "network" : "socket");
  if (mode === "socket") {
    // sockaddr_un is at most 108 bytes on Linux. Meta-run directories include
    // a 64-hex campaign digest and cannot safely host the listener themselves.
    // The deterministic short path is also crash-resumable: listenUnix removes
    // a stale prior inode before binding, and cleanup removes the terminal one.
    const proxySocketHostPath = join(
      tmpdir(),
      `hone-proxy-${createHash("sha256").update(ctx.runId).digest("hex").slice(0, 24)}.sock`,
    );
    await proxy.listenUnix(proxySocketHostPath);
    return {
      sandboxNetwork: { mode: "none" },
      proxyBaseUrl: null,
      proxySocketHostPath,
      exposeBroker: async () => {
        throw new Error("broker TCP relay is unavailable on socket egress");
      },
      cleanup: async () => {
        rmSync(proxySocketHostPath, { force: true });
      },
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
        ...(containerLease !== undefined ? ["--volumes-from", `${containerLease}:ro`] : []),
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
          ...(containerLease !== undefined ? ["--volumes-from", `${containerLease}:ro`] : []),
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
    proxySocketHostPath: null,
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
 * Kill handle covering the optimizer container AND its docker start client.
 * The DAEMON is the container authority: TERM -> `docker kill -s TERM`,
 * KILL -> `docker rm -f`, always by NAME. The local client (and any host
 * descendants it leads) is signaled through its process GROUP only while
 * the leader is provably UNREAPED — 'close'/'error' have not fired, so the
 * kernel still pins the pgid to our child and the number cannot have been
 * recycled. After reap, NO numeric pid/pgid is ever signaled: a recycled
 * number would belong to a stranger; the daemon call above owns the
 * container from then on.
 */
function containerKillHandle(child: OptimizerChildLike, name: string, run: RunCommand): ChildLike {
  let clientAlive = true;
  child.on("close", () => {
    clientAlive = false;
  });
  child.on("error", () => {
    clientAlive = false;
  });
  return {
    pid: child.pid,
    kill(signal?: NodeJS.Signals): boolean {
      const sig = signal ?? "SIGTERM";
      void run(sig === "SIGKILL" ? ["docker", "rm", "-f", name] : ["docker", "kill", "-s", "TERM", name], { timeoutMs: 30_000 }).catch(() => {});
      // A reaped client needs no signal — its number may already belong to
      // someone else.
      if (!clientAlive) return true;
      if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
          // Group signal covers host descendants (the leader is alive, so
          // the pgid is pinned to it and cannot be a stranger's).
          process.kill(-child.pid, sig);
          return true;
        } catch {
          // Group already gone — fall through to the direct handle.
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
 *
 * Two-phase execution (P1 create fence): phase one is a `docker create`
 * JOINED to the daemon's definitive response — spawned through the raw
 * client seam (the value-less `-e HONE_BROKER_TOKEN` is resolved from the
 * CREATE client's env), never killed, and write-ahead latched via the gate;
 * a client-side failure with an unknown daemon outcome leaves the intent
 * open and the run unterminalizable. Phase two is a bounded, killable
 * `docker start -a` of the already-registered name; the daemon-side reap of
 * that name is AWAITED before this invocation resolves — killing the start
 * client never orphans a running container past the invocation boundary.
 */
export async function runOptimizer(ctx: RunnerBackendContext, runtime: OptimizerRuntime, opts: { maxEpisodes?: number } = {}): Promise<void> {
  const name = optimizerRunName(runtime.safeRunId, ++runtime.invocation);
  runtime.spawnedNames.push(name);
  const createArgv = optimizerCreateArgs({
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
      // The M0 probe is the entire one-candidate campaign. The mutable loop
      // gets both advisory values; broker-side caps remain authoritative.
      ...(opts.maxEpisodes !== undefined
        ? { HONE_MAX_EPISODES: String(opts.maxEpisodes), HONE_ONE_SHOT_CANDIDATE: "1" }
        : {}),
      // Events.ndjson is the store of record and reconciliation may have just
      // appended recovered incumbents — replay from disk, not the supervisor's
      // pre-backend snapshot, so the resume hint sees the durable authority.
      HONE_RESUME: JSON.stringify(resumeHint(ctx.runDir)),
    },
    containerLease: runtime.containerLease,
  });
  // ONE frozen docker client env for every channel (endpoint pinned at
  // startup), plus the broker capability (BOTH transports) resolved by the
  // value-less -e — the token never enters argv and is never logged. It must
  // be present on the CREATE client: container env is baked at create time.
  const clientEnv = {
    ...runtime.clientEnv,
    HONE_BROKER_TOKEN: runtime.transport.token,
  };
  /** Joined daemon-side reap by name, AWAITED before the invocation settles; strict sweeps + cleanup() backstop failures. */
  const reap = async (): Promise<void> => {
    try {
      await runtime.run(["docker", "rm", "-f", name], { timeoutMs: 30_000 });
    } catch {
      // cleanup() and the strict final sweep re-attempt and surface failures.
    }
  };

  // Sealed-bundle re-proof, BEFORE the WAL dispatch marker: the mounted dir
  // and both bundle files must still be the exact inodes/bytes trusted code
  // captured after the build — a tamper refusal never consumes a create
  // intent and the daemon never sees the argv.
  verifyOptimizerBundleSeal(runtime);
  // ---- Phase 1: joined create (write-ahead latched; never killed). ----
  const intent = runtime.gate.begin("container", name, runtime.containerLease);
  const [cmd, ...args] = createArgv;
  if (cmd === undefined) throw new Error("empty optimizer container argv");
  // Durable pre-invocation marker: the spawn strictly happens-after this
  // fsync, so a crash before it is provably undispatched.
  intent.dispatched();
  // A spawn 'error' rejects with the daemon outcome UNKNOWN: the intent
  // stays open, so cleanup refuses terminal completion until a causal proof.
  const createDone = deferred<{ code: number | null; stderr: string }>();
  const client = runtime.spawnImpl(cmd, args, {
    env: clientEnv,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group so stray helpers never inherit the supervisor's.
    detached: process.platform !== "win32",
  });
  let createStderr = "";
  client.stderr?.on("data", (chunk: unknown) => {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) createStderr += Buffer.from(chunk).toString("utf8");
  });
  client.on("error", (err) => createDone.reject(err));
  client.on("close", (code) => createDone.resolve({ code, stderr: createStderr }));
  const created = await createDone.promise;
  if (created.code !== 0) {
    // The daemon's verdict, not the client's death: a nonzero/signaled exit
    // settles "failed" ONLY on conclusive Engine evidence. An externally
    // killed client or transport loss after POST acceptance stays OPEN —
    // the run cannot terminalize until a resume proves the outcome.
    if (CONCLUSIVE_ENGINE_REJECTION_RE.test(created.stderr)) intent.settle("failed");
    throw new Error(`optimizer container create failed (exit ${created.code}): ${created.stderr.slice(0, 2000)}`);
  }
  intent.settle("created");
  if (ctx.signal.aborted) {
    // Stop landed between create and start: the container is registered but
    // never started — reap it (joined) and wind down.
    await reap();
    return;
  }

  // ---- Phase 2: bounded attach-start of the registered container. ----
  // Opaque diagnostics sink — NEVER parsed, NEVER an event source. Both
  // streams and every invocation/resume share one hard byte ceiling.
  const optLogPath = join(ctx.runDir, "optimizer.log");
  const logLimit = optimizerLogLimit(ctx.env);
  if (existsSync(optLogPath) && statSync(optLogPath).size > logLimit) truncateSync(optLogPath, logLimit);
  const existingLogBytes = existsSync(optLogPath) ? statSync(optLogPath).size : 0;
  const optLog = createWriteStream(optLogPath, { flags: "a" });
  const appendDiagnostic = cappedDiagnosticAppender(optLog, logLimit, existingLogBytes);
  const startArgv = optimizerStartArgs(name);
  const child = runtime.spawnImpl(startArgv[0] as string, startArgv.slice(1), {
    // The same frozen client env — WITHOUT the broker capability: the
    // bounded start client never needs it (container env baked at create).
    env: { ...runtime.clientEnv },
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
  child.on("error", (err) => {
    // A spawn error has no live child to reap. Drop the supervisor handle
    // before the daemon-name cleanup; never retain a nonexistent PID.
    unregister();
    void reap().then(() => settleAfterLog(() => done.reject(err)));
  });
  child.on("close", (code, signal) => {
    // `close` means Node has reaped the process. Its PID/PGID is now reusable:
    // unregister BEFORE any await/callback, and only clean Docker by name.
    // The daemon-side reap is JOINED before this invocation settles: a
    // killed/timed-out start client never releases control while the
    // container may still be running.
    unregister();
    void reap().then(() =>
      settleAfterLog(() => {
        if (ctx.signal.aborted) return done.resolve();
        if (code === 0) return done.resolve();
        done.reject(new Error(`optimizer exited ${code ?? `signal ${signal ?? "?"}`} — see ${join(ctx.runDir, "optimizer.log")}`));
      }),
    );
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
 *
 * Unchanged-workspace probes are the one exception: when the episode's only
 * trusted measurement was served from the broker memo, its eval.completed
 * carries NO episode tag, so the newest started episode holds no tagged
 * eval at all. The baseline is then derived from the untagged trusted eval
 * inside that episode's window that measures the episode's parent artifact,
 * and the report carries candidate:null (headless declines, interactive
 * shows "none") — startup state, never a hard failure.
 *
 * The candidate is NEVER the episode's last saved artifact. It is derived
 * solely from the unique eval/gate binding: the one saved artifact whose own
 * episode-tagged trusted eval the gate measured (childScore identical).
 * Promotion cardinality follows the gate verdict: a passed gate requires
 * exactly one episode-tagged incumbent.new naming the candidate's exact
 * hash and aggregate; a failed gate requires exactly zero while keeping the
 * losing candidate visible with its negative delta; no bound candidate
 * means nothing may be promoted. A save that the trusted evaluator never
 * measured (e.g. a failed-exec repair re-saved after a byte-identical
 * reopen) can never become the reported candidate, and a gate score is
 * never transferred to a different hash. Ambiguous, missing, or mismatched
 * bindings fail closed: the derivation throws, no report is produced, and
 * no durable approval can be sealed over it.
 */
export function deriveProbeReport(events: readonly RunEvent[], budget: BudgetState): ProbeReport {
  let episode = -1;
  for (const e of events) {
    if (e.type === "eval.completed" && e.episode !== undefined && e.episode > episode) episode = e.episode;
  }
  let started: { episode: number; parent: ArtifactRef; index: number } | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e !== undefined && e.type === "episode.started" && (started === null || e.episode > started.episode)) {
      started = { episode: e.episode, parent: e.parent, index: i };
    }
  }
  if (episode < 0 || (started !== null && started.episode > episode)) {
    if (started === null) throw new Error("probe produced no completed evaluation — cannot derive a paired report (see optimizer.log)");
    // Memo-hit window: the newest episode has no episode-tagged eval. The
    // parent's trusted measurement, if any, is an untagged eval.completed
    // logged after episode.started for the exact parent artifact.
    let memo: { aggregate: number; assetGroupId: string; seed: number } | null = null;
    for (let i = started.index + 1; i < events.length; i++) {
      const e = events[i];
      if (e !== undefined && e.type === "eval.completed" && e.episode === undefined && e.artifact.hash === started.parent.hash) {
        memo = { aggregate: e.aggregate, assetGroupId: e.assetGroupId, seed: e.seed };
      }
    }
    if (memo === null) {
      throw new Error(`probe episode ${started.episode} produced no completed evaluation — cannot derive a paired report (see optimizer.log)`);
    }
    return {
      baseline: { artifact: started.parent, aggregate: memo.aggregate },
      candidate: null,
      promoted: false,
      assetGroupId: memo.assetGroupId,
      seed: memo.seed,
      budget,
    };
  }
  let parent: ArtifactRef | null = null;
  const saves: ArtifactRef[] = [];
  const gates: { parentScore: number; childScore: number; passed: boolean }[] = [];
  const evals = new Map<string, { aggregate: number; assetGroupId: string; seed: number }>();
  const incumbents: { hash: string; aggregate: number }[] = [];
  for (const e of events) {
    if (e.type === "episode.started" && e.episode === episode) {
      if (parent !== null && parent.hash !== e.parent.hash) {
        throw new Error(`probe episode ${episode} names two different parents — ambiguous, cannot derive a paired report`);
      }
      parent = e.parent;
    } else if (e.type === "episode.candidate" && e.episode === episode) {
      saves.push(e.candidate);
    } else if (e.type === "gate.paired" && e.episode === episode) {
      gates.push({ parentScore: e.parentScore, childScore: e.childScore, passed: e.passed });
    } else if (e.type === "eval.completed" && e.episode === episode) {
      const prior = evals.get(e.artifact.hash);
      if (prior !== undefined && (prior.aggregate !== e.aggregate || prior.assetGroupId !== e.assetGroupId || prior.seed !== e.seed)) {
        throw new Error(`probe episode ${episode} holds conflicting trusted evaluations of ${e.artifact.hash} — ambiguous, cannot derive a paired report`);
      }
      evals.set(e.artifact.hash, { aggregate: e.aggregate, assetGroupId: e.assetGroupId, seed: e.seed });
    } else if (e.type === "incumbent.new" && e.episode === episode) {
      incumbents.push({ hash: e.artifact.hash, aggregate: e.aggregate });
    }
  }
  if (parent === null) throw new Error(`probe episode ${episode} has no episode.started — the log is not a complete probe`);
  const savedHashes = new Set(saves.map((s) => s.hash));
  for (const hash of evals.keys()) {
    if (hash !== parent.hash && !savedHashes.has(hash)) {
      throw new Error(`probe episode ${episode} evaluated ${hash}, which is neither the parent nor a saved candidate — cannot derive a paired report`);
    }
  }
  if (gates.length > 1) {
    throw new Error(`probe episode ${episode} holds ${gates.length} paired gate measurements — ambiguous, cannot derive a paired report`);
  }
  const gate = gates[0];
  // Unique eval/gate binding: the ONE saved non-parent artifact whose own
  // episode-tagged eval the gate measured. Save order is irrelevant — a
  // later re-save of an unevaluated artifact never becomes the candidate.
  const measured = [...new Map(saves.map((s) => [s.hash, s])).values()].filter((s) => s.hash !== parent.hash && evals.has(s.hash));
  let candidate: { artifact: ArtifactRef; aggregate: number } | null = null;
  if (gate !== undefined) {
    const bound = measured.filter((s) => evals.get(s.hash)?.aggregate === gate.childScore);
    const sole = bound[0];
    if (bound.length !== 1 || sole === undefined) {
      throw new Error(
        `probe episode ${episode} gate childScore binds ${bound.length} evaluated saved candidates (need exactly 1) — cannot derive a paired report`,
      );
    }
    candidate = { artifact: sole, aggregate: gate.childScore };
  } else if (measured.length > 0) {
    throw new Error(`probe episode ${episode} evaluated a candidate without a paired gate measurement — cannot derive a paired report`);
  }
  // The one-shot run finalizes the episode's promoted incumbent. Promotion
  // cardinality is gate-dependent: a PASSED gate's bound candidate must be
  // the exact promoted incumbent (exactly one, exact hash + aggregate — an
  // optimizer that wins the gate but withholds reportIncumbent gets no
  // approvable report); a FAILED gate keeps its losing candidate visible
  // (negative delta, owner declines, recovery never re-buys) and must have
  // promoted NOTHING. No bound candidate: nothing may be promoted at all.
  if (candidate !== null && gate !== undefined && gate.passed) {
    const inc = incumbents[0];
    if (incumbents.length !== 1 || inc === undefined) {
      throw new Error(
        `probe episode ${episode} passed its gate but recorded ${incumbents.length} promoted incumbents (need exactly 1) — cannot derive a paired report`,
      );
    }
    if (inc.hash !== candidate.artifact.hash || inc.aggregate !== candidate.aggregate) {
      throw new Error(`probe episode ${episode} promoted incumbent ${inc.hash} which is not the gate-bound candidate — cannot derive a paired report`);
    }
  } else if (incumbents.length > 0) {
    throw new Error(
      `probe episode ${episode} promoted ${incumbents.length} incumbents without a gate-passing bound candidate — cannot derive a paired report`,
    );
  }
  const parentEval = evals.get(parent.hash);
  const baselineAggregate = parentEval?.aggregate ?? gate?.parentScore;
  if (baselineAggregate === undefined) throw new Error(`probe episode ${episode} has no baseline measurement — cannot derive a paired report`);
  const coordinate = (candidate !== null ? evals.get(candidate.artifact.hash) : undefined) ?? parentEval;
  if (coordinate === undefined) throw new Error(`probe episode ${episode} has no evaluations`);
  return {
    baseline: { artifact: parent, aggregate: baselineAggregate },
    candidate:
      candidate !== null
        ? { artifact: candidate.artifact, aggregate: candidate.aggregate, delta: candidate.aggregate - baselineAggregate }
        : null,
    promoted: candidate !== null && gate?.passed === true,
    assetGroupId: coordinate.assetGroupId,
    seed: coordinate.seed,
    budget,
  };
}

export function createBackend(
  deps: { run?: RunCommand; spawnOptimizer?: OptimizerSpawn; createHelper?: DockerCreateHelper } = {},
): RunnerBackend {
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
      let baselineArtifactHash: string;
      let evaluatorBaselineArtifactHash: string | undefined;
      if (ctx.terminalHoldoutAssetGroupIds === undefined) {
        baselineArtifactHash = await measureBaseline(ctx.capsuleDir, ctx.manifest, cas);
      } else {
        if (ctx.config.apply !== "none") {
          throw new Error("terminal holdout evaluator isolation requires apply:none");
        }
        const measured = await measureTerminalHoldoutBaseline(ctx.capsuleDir, ctx.manifest, cas);
        baselineArtifactHash = measured.mutationArtifactHash;
        evaluatorBaselineArtifactHash = measured.evaluatorArtifactHash;
      }
      const frozenAssetRoot = authenticateFrozenCapsuleAssets(ctx.runDir, ctx.manifest);
      // Broker + proxy are mutually referential (proxy meters INTO the broker,
      // broker env points sandboxes AT the proxy); the late-bound ref breaks the cycle.
      let running: RunningBroker | null = null;
      // The proxy's dispatch-journal recovery starts AT CONSTRUCTION and may
      // deliver recovered ceiling charges before the broker exists — and a
      // durable recovered fact whose callback a prior crash swallowed will
      // NEVER be re-delivered. Queue every spend/exhaustion callback until
      // the broker is up AND the journal's cumulative charge level has been
      // reconciled into it; only then flip to the direct sink. Admission
      // stays denied (checkBudget below) for that whole window.
      let spendDirect = false;
      const queuedSpend: { tokens: number; usd: number }[] = [];
      const queuedExhaustion: BudgetDimension[] = [];
      const checkBudget = (): BudgetDecision => {
        if (running === null || !spendDirect) return { allowed: false, dimension: "wallClockSec", message: "broker not started" };
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
          if (!spendDirect || running === null) {
            queuedSpend.push({ tokens: spend.tokens, usd: spend.usd });
            return;
          }
          running.broker.recordSpend({ tokens: spend.tokens, usd: spend.usd }, { privileged: true });
        },
        recordBudgetExhaustion: (dimension) => {
          if (!spendDirect || running === null) {
            queuedExhaustion.push(dimension);
            return;
          }
          running.broker.recordBudgetExhaustion(dimension, { privileged: true });
        },
      });

      // The frozen manifest's immutable image is THE image — mutation
      // sandboxes, eval sandboxes, the macOS relay, AND both optimizer
      // containers (build + run) all run it. There is deliberately no
      // environment override.
      const image = ctx.manifest.image;
      let egress: Egress | null = null;
      let optimizer: OptimizerRuntime | null = null;
      let containerLease: DockerRunLease | null = null;
      let gate: DockerCreateGate | null = null;
      let grun: RunCommand = run;
      let frozenSocketError: (() => string | null) | null = null;
      try {
        // Endpoint freeze (P1): resolve the active daemon endpoint EXACTLY
        // once under the original env and pin every later client (default
        // RunCommand via the ambient env, detached create helper, optimizer
        // create/start) to that immutable resolution — a config/context
        // mutation mid-run can never re-steer a call. M0 accepts only local
        // unix:// endpoints; the locality class is sealed durably below and
        // gates the reboot death-proof.
        const frozen = await freezeDockerClientEnv(ctx.runDir, ctx.runId, ctx.env, deps.run === undefined ? { run } : null);
        frozenSocketError = frozen.socketError;
        // In production every docker argv from here on carries the frozen
        // canonical `unix://` endpoint explicitly (--host + trusted --config)
        // — ambient env/context mutations steer nothing. Scripted runs keep
        // the injected seam as the only channel.
        const prun = frozen.run ?? run;
        // Engine identity seal (P1): bind the run to THE daemon that executes
        // its creates BEFORE the create journal exists and before any
        // resource operation. Every proof, sweep, and latch judgment below is
        // only meaningful against the sealed Engine — a resume under a
        // different DOCKER_HOST/context refuses here, nonterminal.
        const seal = await sealDockerEngine(ctx.runDir, ctx.runId, prun, frozen.endpointKind);
        // P1 create fence: every docker resource create from here on (donor,
        // relays, broker keeper/sandboxes/evals, optimizer build) flows
        // through the gate — write-ahead latched, joined to a definitive
        // daemon response, `docker run` rewritten two-phase.
        gate = openDockerCreateGate(ctx.runDir, ctx.runId, {
          ...(deps.createHelper !== undefined ? { helper: deps.createHelper } : {}),
          clientEnv: frozen.env,
          endpointIsLocal: seal.endpointKind === "local-unix",
        });
        grun = gate.wrap(prun);
        // Open intents inherited from a crashed attempt: observe/reap them
        // BEFORE the sweep destroys the evidence of a late registration.
        await gate.reapInheritedCreates(grun);
        // Finding 10: a crashed prior supervisor's labeled containers (incl.
        // optimizer build/run), the deterministic relay/network, and dead
        // sockets must be gone before this run mints the same names again.
        await sweepStaleRunResources(ctx.runId, ctx.runDir, grun, true);
        // Per-epoch stopped donor: EVERY per-run container attaches
        // `--volumes-from <donor>:ro`. The epoch is never re-minted, so a
        // crash-window create from THIS attempt is provably dead once a
        // later claim shows its name unreserved (moby resolves volumes-from
        // after name reservation, before Register).
        containerLease = makeDockerRunLease(ctx.runId, image, grun, gate.epoch);
        await containerLease.start();
        // Claim-prove the remaining inherited intents BEFORE any same-named
        // resource (keeper/relay names are deterministic) can be re-minted.
        // A name still reserved daemon-side refuses startup; an unprovable
        // latch (donor/volume/network) stays open and blocks terminal only.
        await gate.proveInheritedIntents(grun, { runId: ctx.runId, image, donorName: containerLease.name });
        egress = await setupEgress(ctx, proxy, image, grun, containerLease.name);

        // Both transports need a short public Unix socket. sockaddr_un cannot
        // represent deep campaign run paths on either Darwin or Linux; Linux
        // bind-mounts this socket into the optimizer container, while Darwin
        // also exposes the authenticated TCP listener through its relay.
        const wantPublicTcp = egress.sandboxNetwork.mode === "internal";
        const publicSocketPath = join(
          tmpdir(),
          `hone-broker-${createHash("sha256").update(ctx.runId).digest("hex").slice(0, 24)}.sock`,
        );


        const brokerConfig = {
          runId: ctx.runId,
          // The RUN config is what the broker enforces: its envelope may
          // tighten the capsule's, and an approved contract edit may have
          // revised the objective the optimizer pursues (broker/getTask
          // serves manifest.objective). The frozen snapshot keeps the
          // capsule's original identity; the contract hash seals this run's
          // overrides.
          manifest: { ...ctx.manifest, objective: ctx.config.objective, budget: ctx.config.budget },
          capsuleRootDir: frozenAssetRoot,
          baselineArtifactHash,
          image,
          ...(evaluatorBaselineArtifactHash === undefined ? {} : { evaluatorBaselineArtifactHash }),
          capsuleDigest: ctx.capsuleDigest,
          optimizerDigest: ctx.optimizerDigest,
          ...(ctx.measurementEpoch !== undefined ? { measurementEpoch: ctx.measurementEpoch } : {}),
          ...(ctx.evaluationStrategy !== undefined ? { evaluationStrategy: ctx.evaluationStrategy } : {}),
          ...(ctx.terminalHoldoutAssetGroupIds !== undefined
            ? { terminalHoldoutAssetGroupIds: ctx.terminalHoldoutAssetGroupIds }
            : {}),
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
          runCommand: grun,
          // Quota-enforcing docker tmpfs volume for /scratch (landed broker API).
          scratchVolume: true,
          containerLease: containerLease.name,
          onEvent: (event: RunEvent) => ctx.emit(event),
          sandboxNetwork: egress.sandboxNetwork,
          mutationEnv: {
            ...(egress.proxyBaseUrl !== null ? { HONE_PROXY_BASE_URL: egress.proxyBaseUrl } : {}),
            HONE_PROXY_TOKEN: proxy.tokenFor("mutation"),
            HONE_MODEL_ID: route.model,
          },
          ...(egress.proxySocketHostPath !== null ? { proxySocketHostPath: egress.proxySocketHostPath } : {}),
          episodeOrigin: ctx.replayed.nextEpisode,
          // M0's evaluator cache domain is shared across containers. One
          // probe candidate is therefore the whole campaign; M1 must provide
          // fresh cache domains before this trusted cap can rise.
          ...(ctx.optimizerEpisodesMax !== undefined
            ? {
                maxMutationEpisodes: ctx.optimizerEpisodesMax,
                maxCandidateArtifacts: Math.max(2, ctx.optimizerEpisodesMax + 1),
                maxPublicCandidateEvaluations:
                  ctx.maxPublicCandidateEvaluations ?? ctx.optimizerEpisodesMax,
              }
            : {}),
          ...(ctx.trustedValidPublicCandidateTarget !== undefined
            ? { trustedValidPublicCandidateTarget: ctx.trustedValidPublicCandidateTarget }
            : {}),
          ...(ctx.optimizerEpisodesMax === undefined
            ? {
                // M0's evaluator cache domain is shared across containers.
                // One probe candidate is therefore the whole campaign.
                maxMutationEpisodes: 1,
                maxCandidateArtifacts: 2,
              }
            : {}),
        };
        running = wantPublicTcp
          ? await startBroker(brokerConfig, {
              publicTcp: { host: "127.0.0.1", port: 0 },
              socketPath: publicSocketPath,
            })
          : await startBroker(brokerConfig, { socketPath: publicSocketPath });

        // Finding 11: replay journaled-but-unlogged promotions into
        // events.ndjson BEFORE anything can terminalize the run, so
        // best/status/delivery and the resume hint all see the durable
        // incumbent exactly once — even when a stop aborted mid-startup.
        reconcileBrokerAuthority(ctx.runDir, running.broker, ctx.emit, ctx.runId);

        // Dispatch-charge reconciliation (P1): the proxy journal's cumulative
        // charge LEVEL is an absolute lower bound on token/usd spend — a
        // recovered fact made durable by a prior attempt is never re-delivered
        // through recordSpend. Flush the pre-broker queue first, then charge
        // exactly the positive deficit (never reduce a broker overcount), make
        // the reconciled floor durable, and only then open the direct sink —
        // proxy admission stays denied until this point.
        await proxy.dispatchRecovery().then((report) => {
          const broker = (running as RunningBroker).broker;
          for (const spend of queuedSpend.splice(0)) broker.recordSpend(spend, { privileged: true });
          for (const dimension of queuedExhaustion.splice(0)) broker.recordBudgetExhaustion(dimension, { privileged: true });
          const { spent } = broker.getBudget({ privileged: true });
          const deficit = {
            tokens: Math.max(0, report.chargedTotals.tokens - spent.tokens),
            usd: Math.max(0, report.chargedTotals.usd - spent.usd),
          };
          if (deficit.tokens > 0 || deficit.usd > 0) broker.recordSpend(deficit, { privileged: true });
          broker.snapshotBudget({ privileged: true });
          spendDirect = true;
          // A poisoned dispatch journal is handled at teardown: proxy.close()
          // rejects, the cleanup barrier rejects, the run stays non-terminal.
        });

        // Only AFTER durable authority is reconciled may a stop short-circuit:
        // the optimizer never launches; the finally unwinds proxy/broker/egress.
        if (ctx.signal.aborted) return;

        let transport: OptimizerTransport;
        if (wantPublicTcp && egress.sandboxNetwork.mode === "internal") {
          const addr = running.publicTcpAddress;
          if (addr === undefined) throw new Error("broker did not open the requested public TCP listener");
          transport = {
            kind: "tcp",
            endpoint: await egress.exposeBroker(addr.port),
            // The broker mints ONE fresh >=256-bit capability per start;
            // it travels only via trusted memory into the create client env.
            token: running.publicToken,
            network: egress.sandboxNetwork.network,
          };
        } else {
          // The 0666 public socket accepts any host UID's connect — the same
          // per-broker capability gates every request there too.
          transport = { kind: "unix", hostSocketPath: running.socketPath, token: running.publicToken };
        }

        // One-time exact-snapshot proof + container build for the single M0
        // probe invocation.
        optimizer = await prepareOptimizerRuntime(ctx, {
          image,
          transport,
          run: grun,
          spawnImpl,
          containerLease: containerLease.name,
          gate,
          clientEnv: frozen.env,
        });
        if (ctx.signal.aborted) return;

        if (ctx.optimizerEpisodesMax !== undefined) {
          // Trusted M1 children are fixed-work full runs, not M0 owner probes.
          // Resume continues from the durable episode cursor under the same
          // child receipt and measurement epoch.
          const nextEpisode = replayRun(ctx.runDir).nextEpisode;
          const remaining = ctx.optimizerEpisodesMax - nextEpisode;
          if (remaining > 0) {
            await runOptimizer(ctx, optimizer, { maxEpisodes: remaining });
            if (ctx.signal.aborted) return;
          }

          // Measure the terminal trusted artifact explicitly. This also makes
          // a runnable negative control that proposes no candidate a valid
          // baseline-scored child rather than an infrastructure failure.
          const finalGroup =
            ctx.manifest.assetGroups.find((group) => group.visibility !== "holdout" && group.id === "train")
            ?? ctx.manifest.assetGroups.find((group) => group.visibility !== "holdout");
          if (finalGroup === undefined) throw new Error("M1 child has no registered non-holdout evaluation coordinate");
          const finalArtifact = {
            hash: running.broker.trustedIncumbent?.hash ?? baselineArtifactHash,
          };
          await running.broker.evaluate(
            { artifact: finalArtifact, assetGroupId: finalGroup.id, seed: ctx.config.seed },
            { privileged: true },
          );
        } else {
          // VI.4 probe gate: a fresh M0 run gets one optimizer episode; a
          // resume reuses the durable broker-authored pair.
          const probe = replayRun(ctx.runDir).probe;
          if (probe !== null && !probe.approved) {
            ctx.requestStop();
            return;
          }
          if (probe === null) {
            let report: ProbeReport | undefined;
            try {
              const recovered = deriveProbeReport(readEvents(ctx.runDir), running.broker.getBudget({ privileged: true }));
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
        }


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
        // Join every create still in flight (never kill a docker client mid-
        // create) BEFORE the donor is removed and the final sweep runs.
        if (gate !== null) await gate.drain().catch((e: unknown) => failures.push(`docker create drain: ${message(e)}`));
        if (containerLease !== null) {
          await containerLease.close().catch((e: unknown) => failures.push(`docker create lease: ${message(e)}`));
          // Strict post-fence sweep — CLEANUP, not proof. The proof that no
          // late create can register after a successful terminal is the gate:
          // every create either joined a definitive daemon response
          // (registration happened-before its client response, which
          // happened-before this sweep) or holds an open write-ahead intent
          // that fails the terminal assertion below.
          await sweepStaleRunResources(ctx.runId, ctx.runDir, grun, true).catch((e: unknown) =>
            failures.push(`post-lease sweep: ${message(e)}`),
          );
        }
        if (gate !== null) {
          try {
            gate.assertTerminal();
          } catch (e) {
            failures.push(`docker create gate: ${message(e)}`);
          }
          // Terminal endpoint recheck through the SAME frozen resolution: the
          // pinned socket must still be the frozen filesystem object (dev:ino
          // — a symlink retarget or socket replacement mid-run voids every
          // proof above even when an Engine answers with the sealed ID) and
          // the daemon answering NOW must still be the sealed Engine — a
          // context/config mutation mid-run must never let the final sweep
          // pass against a different daemon.
          {
            const socketDrift = frozenSocketError !== null ? frozenSocketError() : null;
            if (socketDrift !== null) failures.push(`docker endpoint terminal recheck: ${socketDrift}`);
            const finalSeal = await dockerEngineSealError(ctx.runDir, ctx.runId, grun);
            if (finalSeal !== null) failures.push(`docker engine terminal recheck: ${finalSeal}`);
          }
        }
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
