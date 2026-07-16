import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { RunCommand } from "@hone/broker";
import { DOCKER_CREATE_WAL } from "./docker-create-gate.js";

/**
 * Docker Engine identity seal (P1: a run is not otherwise bound to a daemon).
 *
 * Every create-gate proof, sweep, and latch judgment is only meaningful
 * against THE Engine that executed the run's creates. Without a seal, a
 * SIGKILL'd run can be resumed or stop-finalized under a different
 * DOCKER_HOST/context: all proofs and strict sweeps observe Engine B and
 * terminalize while the resources (and pending create requests) live on
 * Engine A.
 *
 * The seal records the stable Engine ID (`docker info --format {{.ID}}`,
 * daemon identity — NOT the endpoint: a context/endpoint change to the SAME
 * engine is legitimate) and is written durably (write-all + fsync + rename +
 * dir fsync) BEFORE the create-gate journal exists and before any resource
 * operation. Ordering is load-bearing: an absent seal therefore proves the
 * run never contacted Docker — an absent seal WITH a present create journal
 * is corruption/tampering and fails closed. The seal is no-clobber: once
 * written it is only ever verified, never replaced.
 */

export const DOCKER_ENGINE_SEAL = "docker-engine.json";

/** The current daemon's stable identity; throws when the daemon is unreachable or reports none. */
export async function currentDockerEngineId(run: RunCommand): Promise<string> {
  const info = await run(["docker", "info", "--format", "{{.ID}}"], { timeoutMs: 30_000 });
  const id = info.stdout.toString("utf8").trim();
  if (info.exitCode !== 0 || info.timedOut || id.length === 0) {
    throw new Error(
      `docker engine identity is unavailable: ${info.stderr.toString("utf8").slice(0, 2000) || `exit ${info.exitCode}`} — refusing to touch resources on an unidentified daemon`,
    );
  }
  return id;
}

/** Endpoint locality classes bound into the seal: only "local-unix" permits the reboot death-proof. */
export type DockerEndpointKind = "local-unix" | "unverified";

export interface DockerEngineSealRecord {
  engineId: string;
  endpointKind: DockerEndpointKind;
}

function readSeal(runDir: string): DockerEngineSealRecord | null {
  const path = join(runDir, DOCKER_ENGINE_SEAL);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const id = raw["engineId"];
  if (typeof id !== "string" || id.length === 0) throw new Error(`docker engine seal at ${path} is malformed; refusing to proceed`);
  // Legacy/absent kind fails CLOSED for locality-dependent proofs.
  const kind = raw["endpointKind"] === "local-unix" ? "local-unix" : "unverified";
  return { engineId: id, endpointKind: kind };
}

function fsyncPathSync(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Bind this run to the current Engine (and the frozen endpoint's locality
 * class), or verify the existing binding. MUST run before the create-gate
 * journal is opened and before any Docker resource operation. The endpoint
 * kind is DURABLE with the engine id: the reboot death-proof consults the
 * SEALED kind, never a later attempt's claim.
 */
export async function sealDockerEngine(
  runDir: string,
  runId: string,
  run: RunCommand,
  endpointKind: DockerEndpointKind = "unverified",
): Promise<DockerEngineSealRecord> {
  const sealed = readSeal(runDir);
  const current = await currentDockerEngineId(run);
  if (sealed !== null) {
    if (sealed.engineId !== current) {
      throw new Error(
        `run ${runId} is sealed to Docker engine ${sealed.engineId} but the current daemon is ${current} — its resources and any pending creates live on the sealed engine; refusing (point DOCKER_HOST/context back at it)`,
      );
    }
    if (sealed.endpointKind !== endpointKind) {
      throw new Error(
        `run ${runId} is sealed to a ${sealed.endpointKind} Docker endpoint but this attempt resolved ${endpointKind} — locality-dependent proofs would be unsound; refusing`,
      );
    }
    return sealed;
  }
  // Ordering fail-closed: the seal is written BEFORE the journal ever exists,
  // so a journal without a seal means the seal was deleted — proofs against
  // an unverifiable engine are void.
  if (existsSync(join(runDir, DOCKER_CREATE_WAL))) {
    throw new Error(`run ${runId} has a docker create journal but no engine seal — the seal was removed; refusing to proceed`);
  }
  const path = join(runDir, DOCKER_ENGINE_SEAL);
  const tmp = `${path}.tmp`;
  const payload = Buffer.from(`${JSON.stringify({ v: 1, engineId: current, endpointKind, at: new Date().toISOString() })}\n`, "utf8");
  const fd = openSync(tmp, "w");
  try {
    let offset = 0;
    while (offset < payload.length) {
      const wrote = writeSync(fd, payload, offset, payload.length - offset);
      if (!Number.isInteger(wrote) || wrote <= 0) throw new Error("short write to the docker engine seal");
      offset += wrote;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncPathSync(runDir);
  // No-clobber: re-read and require OUR identity — a racing writer with a
  // different engine would surface here rather than silently winning.
  const persisted = readSeal(runDir);
  if (persisted === null || persisted.engineId !== current || persisted.endpointKind !== endpointKind) {
    throw new Error(`docker engine seal raced to a different identity (${persisted?.engineId ?? "<absent>"} != ${current}); refusing to proceed`);
  }
  return persisted;
}

/**
 * Verification for terminalization paths that do not open a backend (stop,
 * dead-run finalization). Returns the exact refusal reason, or null when the
 * current daemon is provably the sealed one (or the run provably never
 * contacted Docker).
 */
export async function dockerEngineSealError(runDir: string, runId: string, run: RunCommand): Promise<string | null> {
  let sealed: DockerEngineSealRecord | null;
  try {
    sealed = readSeal(runDir);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (sealed === null) {
    if (existsSync(join(runDir, DOCKER_CREATE_WAL))) {
      return `run ${runId} has a docker create journal but no engine seal — proofs against an unverifiable engine are void; refusing`;
    }
    return null; // the run provably never contacted Docker
  }
  try {
    const current = await currentDockerEngineId(run);
    if (current !== sealed.engineId) {
      return `run ${runId} is sealed to Docker engine ${sealed.engineId} but the current daemon is ${current} — its resources and any pending creates live on the sealed engine; refusing (point DOCKER_HOST/context back at it)`;
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

/** Every environment key that steers WHICH daemon a docker CLI invocation reaches. */
export const DOCKER_CLIENT_ENV_KEYS = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  // ~/.docker/config.json currentContext resolves through HOME.
  "HOME",
] as const;

/**
 * Endpoint coherence (P1): the Engine seal is only meaningful when EVERY
 * docker client this run spawns resolves the SAME endpoint. Returns the
 * steering keys whose values differ between the run's injected env (used by
 * the optimizer create/start clients and the detached create helper) and the
 * ambient process env (inherited by the default RunCommand that executes the
 * seal query, broker calls, relays, and sweeps). Any divergence means the
 * sealed identity does not cover all channels — the caller must refuse
 * BEFORE the first docker contact.
 */
export function dockerClientEnvDivergence(ctxEnv: NodeJS.ProcessEnv, ambientEnv: NodeJS.ProcessEnv): string[] {
  const divergent: string[] = [];
  for (const key of DOCKER_CLIENT_ENV_KEYS) {
    if ((ctxEnv[key] ?? null) !== (ambientEnv[key] ?? null)) divergent.push(key);
  }
  return divergent;
}

/**
 * The run attempt's frozen Docker client: ONE canonical local unix-socket
 * filesystem object for every channel, pinned by inode identity.
 */
export interface FrozenDockerClient {
  /**
   * Minimal immutable client env (canonical `unix://` DOCKER_HOST + trusted
   * empty DOCKER_CONFIG) handed to the detached create helper and every
   * optimizer client — the same resolution the default RunCommand carries.
   */
  env: NodeJS.ProcessEnv;
  endpointKind: DockerEndpointKind;
  /**
   * Production: the base RunCommand rewritten so EVERY `docker` argv carries
   * the frozen canonical endpoint explicitly (`--host unix://<canonical>` +
   * trusted `--config`) — ambient env/context/config mutations after the
   * single resolution steer nothing. Scripted: null — the injected seam IS
   * the only channel and there is no endpoint authority to pin.
   */
  run: RunCommand | null;
  /**
   * Refusal reason when the pinned socket no longer has the frozen identity
   * (still a socket — not a re-planted symlink — same dev:ino); null when
   * identical, or when nothing was pinned (scripted). MUST be consulted at
   * terminal handoff, in addition to the sealed Engine ID: a matching Engine
   * answer through a retargeted/replaced socket proves nothing about the
   * object the run's creates went to.
   */
  socketError(): string | null;
}

/**
 * Freeze the Docker client environment ONCE, before any create (P1: a
 * `~/.docker/config.json` currentContext or context-metadata mutation
 * mid-run must never re-steer later calls to a different daemon).
 *
 * Production (`production` non-null): verifies the injected env and the
 * ambient env agree on every steering key (the default RunCommand inherits
 * the ambient env), resolves the active endpoint exactly once (explicit
 * DOCKER_HOST wins; otherwise the current context's endpoint), refuses
 * non-local/TLS forms (M0 pins an exact `unix://` socket), canonicalizes
 * the socket path (realpath — an endpoint string alone still follows a
 * retargeted symlink), proves the canonical object IS a socket (lstat) and
 * pins its dev:ino for the whole attempt. Every channel then uses ONLY
 * `unix://<canonical>`: the returned env (detached create helper, optimizer
 * clients) carries it as DOCKER_HOST with an EMPTY 0700 trusted
 * DOCKER_CONFIG (no credential-bearing config is ever copied; images are
 * pinned local — nothing pulls), the returned RunCommand rewrites every
 * docker argv to carry it explicitly per-invocation, and the ambient
 * process env is bound to the same resolution as belt-and-suspenders.
 *
 * Fails closed (throws) on divergent steering env, TLS forms, non-unix
 * endpoints, uncanonicalizable paths, and canonical objects that are not
 * sockets — all BEFORE the first resource operation.
 *
 * With an injected (scripted) RunCommand there is no ambient channel: the
 * injected env is returned as-is, locality stays "unverified", and nothing
 * is pinned.
 */
export async function freezeDockerClientEnv(
  runDir: string,
  runId: string,
  ctxEnv: NodeJS.ProcessEnv,
  production: { run: RunCommand } | null,
): Promise<FrozenDockerClient> {
  // Scripted RunCommand: the injected seam is the endpoint authority, and
  // its locality is UNVERIFIED — locality-dependent proofs stay fail-closed.
  if (production === null) return { env: { ...ctxEnv }, endpointKind: "unverified", run: null, socketError: () => null };
  const divergent = dockerClientEnvDivergence(ctxEnv, process.env);
  if (divergent.length > 0) {
    throw new Error(
      `run ${runId}: docker client environment diverges between the run env and this process (${divergent.join(", ")}) — the engine seal, sweeps, and container clients would not provably reach one endpoint; refusing before any Docker contact`,
    );
  }
  if (ctxEnv["DOCKER_TLS_VERIFY"] !== undefined || ctxEnv["DOCKER_CERT_PATH"] !== undefined) {
    throw new Error(`run ${runId}: docker TLS client configuration cannot be safely snapshotted — M0 supports local unix:// engines only; refusing`);
  }
  let endpoint = ctxEnv["DOCKER_HOST"];
  if (endpoint === undefined) {
    const inspected = await production.run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeoutMs: 30_000 });
    endpoint = inspected.stdout.toString("utf8").trim();
    if (inspected.exitCode !== 0 || inspected.timedOut || endpoint.length === 0) {
      throw new Error(
        `run ${runId}: docker endpoint resolution failed: ${inspected.stderr.toString("utf8").slice(0, 2000) || `exit ${inspected.exitCode}`}`,
      );
    }
  }
  if (!endpoint.startsWith("unix://")) {
    throw new Error(`run ${runId}: docker endpoint ${endpoint} is not a local unix socket — M0 refuses non-local endpoints (no safe snapshot exists)`);
  }
  // Canonicalize + inode-pin: the endpoint STRING is not the daemon. A
  // symlink retargeted (A→B→A) or a socket replaced under the same path
  // mid-run would let later clients and the terminal recheck observe a
  // different engine while the string compares equal.
  const raw = endpoint.slice("unix://".length);
  let socket: PinnedUnixSocket;
  try {
    const canonical = realpathSync(raw);
    // lstat the fully-resolved path: the endpoint object itself must BE a
    // socket — a symlink re-planted at the canonical path later is drift.
    const st = lstatSync(canonical);
    if (!st.isSocket()) {
      throw new Error(`run ${runId}: docker endpoint ${canonical} is not a unix socket — refusing to run against an unverifiable endpoint`);
    }
    socket = { path: canonical, dev: st.dev, ino: st.ino };
  } catch (err) {
    if (err instanceof Error && err.message.includes("not a unix socket")) throw err;
    throw new Error(
      `run ${runId}: docker endpoint socket ${raw} cannot be canonicalized (${err instanceof Error ? err.message : String(err)}) — refusing to run against an unverifiable endpoint`,
    );
  }
  const canonicalEndpoint = `unix://${socket.path}`;
  // EMPTY trusted config dir: context/credential mutations under HOME can no
  // longer steer any later client; nothing credential-bearing enters runDir.
  const configDir = join(runDir, "docker-config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const frozen: NodeJS.ProcessEnv = {
    ...(ctxEnv["PATH"] !== undefined ? { PATH: ctxEnv["PATH"] } : {}),
    ...(ctxEnv["HOME"] !== undefined ? { HOME: ctxEnv["HOME"] } : {}),
    ...(ctxEnv["TMPDIR"] !== undefined ? { TMPDIR: ctxEnv["TMPDIR"] } : {}),
    DOCKER_HOST: canonicalEndpoint,
    DOCKER_CONFIG: configDir,
  };
  // Bind the ambient process env (inherited by the default RunCommand) to
  // the SAME canonical resolution — belt-and-suspenders under the explicit
  // per-invocation pinning below.
  process.env["DOCKER_HOST"] = canonicalEndpoint;
  process.env["DOCKER_CONFIG"] = configDir;
  delete process.env["DOCKER_CONTEXT"];
  delete process.env["DOCKER_TLS_VERIFY"];
  delete process.env["DOCKER_CERT_PATH"];
  // Explicit per-invocation pinning (the primary defense): every docker argv
  // carries the canonical endpoint + trusted config, so no ambient env or
  // context/config mutation after this line can steer a production call.
  const base = production.run;
  const pinnedArgs = ["--host", canonicalEndpoint, "--config", configDir];
  const run: RunCommand = (argv, opts) => (argv[0] === "docker" ? base(["docker", ...pinnedArgs, ...argv.slice(1)], opts) : base(argv, opts));
  const socketError = (): string | null => {
    try {
      const st = lstatSync(socket.path);
      if (!st.isSocket() || st.dev !== socket.dev || st.ino !== socket.ino) {
        return `run ${runId}: the frozen docker endpoint socket ${socket.path} changed identity mid-run (endpoint retargeted or daemon socket replaced) — terminal proofs against it are void; refusing`;
      }
    } catch (err) {
      return `run ${runId}: the frozen docker endpoint socket ${socket.path} disappeared mid-run (${err instanceof Error ? err.message : String(err)}) — terminal proofs against it are void; refusing`;
    }
    return null;
  };
  return { env: frozen, endpointKind: "local-unix", run, socketError };
}

/**
 * A stop attempt's frozen Docker client (P1 TOCTOU: preflight on Engine A,
 * ambient context switched to Engine B, sweep observes an empty B and
 * terminalizes while A keeps every resource).
 *
 * `run` is the ONLY channel a stop attempt may reach Docker through: in
 * production every `docker` argv is rewritten to carry the frozen endpoint
 * explicitly (`--host` + a trusted `--config` dir), so `~/.docker` context/
 * config mutations after the single resolution below steer NOTHING. With an
 * injected (scripted) RunCommand there is no endpoint authority to freeze —
 * the seam itself is the endpoint and identity drift fails closed instead.
 */
export interface StopDockerClient {
  /** Every Docker call in this stop attempt goes through THIS RunCommand. */
  run: RunCommand;
  /**
   * True when the run has no engine seal AND no create journal: the seal is
   * durably written BEFORE the journal and before any resource operation,
   * so this run provably never contacted Docker. Stop must not demand a
   * resolvable endpoint or a live daemon to finalize it — there is nothing
   * to sweep or verify. (Pre-release invariant: no runs predate the seal.)
   */
  neverContactedDocker: boolean;
  /**
   * Refusal reason unless the frozen endpoint — same unix-socket incarnation
   * (dev:ino), same daemon — still reports the run's sealed Engine identity
   * RIGHT NOW; null when it provably does, or when the run provably never
   * contacted Docker (no seal, no create journal).
   */
  verifyEngine(): Promise<string | null>;
}

/** The canonicalized unix socket a production stop is pinned to; a retarget/replacement mid-attempt is detected by inode identity. */
interface PinnedUnixSocket {
  path: string;
  dev: number;
  ino: number;
}

/**
 * Freeze the Docker client for a WHOLE stop attempt, before any resource
 * observation. Resolution happens exactly once: an explicit DOCKER_HOST
 * wins; otherwise the current context's endpoint is read (the one and only
 * ambient read — there is deliberately no hardcoded default socket). Only
 * `unix://` endpoints are accepted in production (mirroring the run path's
 * M0 freeze): a DNS/TCP name pins a STRING, not a daemon — an A→B→A
 * resolution flip between preflight, sweep, and recheck would let the sweep
 * observe the wrong engine while both identity checks pass. The unix
 * endpoint is canonicalized (realpath — an explicit DOCKER_HOST string
 * alone still follows a retargeted symlink) and its socket inode is pinned.
 * Every later docker argv carries the frozen endpoint explicitly plus a
 * `--config` pointing at the run's trusted empty dir, so env vars and
 * context/config files steer nothing after this line.
 *
 * Fails closed (throws) on: a malformed seal, a create journal without a
 * seal, unresolvable endpoints, non-unix endpoints, and non-socket/
 * unstattable unix paths — all BEFORE the first resource observation.
 */
export async function openStopDockerClient(
  runDir: string,
  runId: string,
  base: RunCommand,
  production: boolean,
): Promise<StopDockerClient> {
  const sealed = readSeal(runDir);
  if (sealed === null) {
    if (existsSync(join(runDir, DOCKER_CREATE_WAL))) {
      throw new Error(`run ${runId} has a docker create journal but no engine seal — proofs against an unverifiable engine are void; refusing`);
    }
    // Provably never contacted Docker: NO endpoint resolution, NO pinning,
    // NO daemon requirement — an unavailable daemon must not block the
    // finalization of a run that cannot own any resource.
    return { run: base, neverContactedDocker: true, verifyEngine: () => Promise.resolve(null) };
  }
  let run = base;
  let socket: PinnedUnixSocket | null = null;
  if (production) {
    let endpoint = process.env["DOCKER_HOST"];
    if (endpoint === undefined || endpoint.length === 0) {
      const inspected = await base(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeoutMs: 30_000 });
      endpoint = inspected.stdout.toString("utf8").trim();
      if (inspected.exitCode !== 0 || inspected.timedOut || endpoint.length === 0) {
        throw new Error(
          `run ${runId}: docker endpoint resolution failed: ${inspected.stderr.toString("utf8").slice(0, 2000) || `exit ${inspected.exitCode}`} — stop cannot freeze an endpoint (no default socket is ever assumed)`,
        );
      }
    }
    if (!endpoint.startsWith("unix://")) {
      throw new Error(
        `run ${runId}: docker endpoint ${endpoint} is not a local unix socket — a stop cannot pin ONE daemon behind a DNS/TCP name (an A→B→A resolution flip would let the sweep observe the wrong engine); M0 stops local unix:// engines only`,
      );
    }
    const raw = endpoint.slice("unix://".length);
    let canonical: string;
    try {
      canonical = realpathSync(raw);
      const st = statSync(canonical);
      if (!st.isSocket()) {
        throw new Error(`run ${runId}: docker endpoint ${canonical} is not a unix socket — refusing to sweep through an unverifiable endpoint`);
      }
      socket = { path: canonical, dev: st.dev, ino: st.ino };
    } catch (err) {
      if (err instanceof Error && err.message.includes("not a unix socket")) throw err;
      throw new Error(
        `run ${runId}: docker endpoint socket ${raw} cannot be canonicalized (${err instanceof Error ? err.message : String(err)}) — refusing to sweep through an unverifiable endpoint`,
      );
    }
    endpoint = `unix://${canonical}`;
    // Explicit per-invocation pinning: env vars and context files stop
    // mattering the moment this argv rewrite exists — there is no ambient
    // channel left for a mid-attempt context switch to steer.
    const configDir = join(runDir, "docker-config");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const pinnedArgs = ["--host", endpoint, "--config", configDir];
    run = (argv, opts) => (argv[0] === "docker" ? base(["docker", ...pinnedArgs, ...argv.slice(1)], opts) : base(argv, opts));
  }
  const verifyEngine = async (): Promise<string | null> => {
    if (socket !== null) {
      try {
        const st = statSync(socket.path);
        if (!st.isSocket() || st.dev !== socket.dev || st.ino !== socket.ino) {
          return `run ${runId}: the frozen docker endpoint socket ${socket.path} changed identity mid-stop (endpoint retargeted or daemon replaced) — refusing`;
        }
      } catch (err) {
        return `run ${runId}: the frozen docker endpoint socket ${socket.path} disappeared mid-stop (${err instanceof Error ? err.message : String(err)}) — refusing`;
      }
    }
    let current: string;
    try {
      current = await currentDockerEngineId(run);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (current !== sealed.engineId) {
      return `run ${runId} is sealed to Docker engine ${sealed.engineId} but the current daemon is ${current} — its resources and any pending creates live on the sealed engine; refusing (point DOCKER_HOST/context back at it)`;
    }
    return null;
  };
  return { run, neverContactedDocker: false, verifyEngine };
}
