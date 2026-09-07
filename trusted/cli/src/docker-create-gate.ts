import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { CmdOptions, CmdResult, RunCommand } from "@hone/broker";
import { deferred } from "./promise.js";

/**
 * Docker create gate (P1: late daemon-side creates vs. terminalization).
 *
 * Docker's client timeout kills only the LOCAL docker CLI; an accepted
 * daemon-side create keeps running and can register ("publish") a container,
 * volume, or network AFTER a one-shot label sweep and after the supervisor
 * has terminalized the run. The old donor-removal fence closed only part of
 * the window: a request that resolved the donor BEFORE the fence could still
 * register after the final sweep.
 *
 * The gate is ONE uncertainty protocol with three durable record kinds and a
 * daemon-side proof for every crash window:
 *
 *   intent      appended + fsynced BEFORE anything else (write-ahead).
 *   dispatched  appended + fsynced immediately BEFORE the Docker invocation
 *               (the wrapped RunCommand call, the detached helper spawn, or
 *               the optimizer client spawn). The invocation strictly
 *               happens-after this fsync returns, so an intent WITHOUT a
 *               dispatched record provably never contacted the daemon and is
 *               auto-proven dead ("undispatched") at the next open.
 *   settled     the daemon's definitive outcome. exit 0 = created. A nonzero
 *               exit settles "failed" ONLY on conclusive Engine evidence
 *               (CONCLUSIVE_ENGINE_REJECTION_RE): an externally signaled
 *               client or transport loss after POST acceptance is AMBIGUOUS
 *               and the intent stays open.
 *
 * 1. JOIN every live create. Resource-creating docker commands
 *    (`docker create`, `docker run`, `docker volume create`,
 *    `docker network create`) are dispatched WITHOUT a client timeout, so a
 *    surviving client always returns the daemon's definitive response (per
 *    @hone/broker command.ts, `timeoutMs: undefined` never arms the killer).
 *    In moby, `POST /containers/create` responds only after `daemon.Register`
 *    (daemon/create.go: Register is the last step before returning the ID) —
 *    registration happens-before the client response happens-before any
 *    later sweep. `docker run` is rewritten two-phase — `docker create`
 *    (joined) then a BOUNDED `docker start [-a] <id>` — preserving wall-clock
 *    enforcement on EXECUTION while creation is never raced. A start-phase
 *    client timeout does NOT stop the daemon-side container: the gate
 *    synchronously reaps the registered ID (`docker rm -f`, joined) before
 *    returning to the caller.
 *
 * 2. UNCLAIMABLE creates (the per-epoch donor, volumes, networks — no
 *    `--volumes-from` dependency exists for them) are executed by a DETACHED
 *    helper process (spawned `node -e`, own process group) that outlives a
 *    killed supervisor. The helper performs a durable Dekker handshake in
 *    the per-intent sidecar dir: it publishes `<seq>.started` (fsync) BEFORE
 *    checking `<seq>.abort` and only then invokes docker (joined spawnSync,
 *    no timeout), finally publishing `<seq>.outcome` (fsync tmp -> rename ->
 *    fsync dir). Resume resolution first fsyncs `<seq>.abort`, THEN reads:
 *      - outcome present  -> settle from the recorded client result;
 *      - started absent   -> any helper that starts later must first publish
 *                            `started` and then observe the durable abort, so
 *                            it exits BEFORE contacting docker: causally
 *                            proven undispatched;
 *      - started present  -> the helper is (or was) live; under kill+resume
 *                            it always reaches its outcome — the attempt
 *                            refuses transiently and the NEXT resume settles
 *                            from the durable outcome. Eventual progress,
 *                            no polling.
 *
 * 3. Inherited DISPATCHED intents that stay ambiguous are resolved by
 *    daemon-side causal proof: observation+reap (sound only for names whose
 *    WAL history shows a single possible registrar), and for donor-fenced
 *    container intents the name-claim — claim success proves (moby reserves
 *    a name BEFORE resolving `--volumes-from`, BEFORE Register) that every
 *    still-pending request is pre-reservation, hence dead behind its
 *    never-re-minted donor epoch; claim conflict proves the request still
 *    holds the daemon's reservation and startup refuses transiently.
 *
 * Journal durability: appends go through a short-write-safe writeAll loop;
 * ANY append/fsync failure poisons the gate and fails the operation BEFORE
 * dispatch, so a torn journal line can only be a crash artifact whose
 * dispatch provably never happened. On open, a torn tail is physically
 * truncated to the last durable LF (ftruncate + fsync) BEFORE any append —
 * O_APPEND would otherwise fuse the next record onto the fragment and
 * permanently corrupt replay. A TERMINATED corrupt line is real corruption
 * and fails closed.
 */

export const DOCKER_CREATE_WAL = "docker-creates.ndjson";
/** Per-intent sidecar dir for the detached helper's Dekker handshake files. */
export const DOCKER_CREATE_SIDECAR = "docker-creates.d";

export type DockerCreateKind = "container" | "volume" | "network";

/**
 * Conclusive Engine evidence that a create was REJECTED (or provably never
 * sent): only these settle a nonzero client exit as "failed". Everything
 * else nonzero — an externally signaled client, transport loss after POST
 * acceptance ("unexpected EOF", "context canceled", exit -1/137 with no
 * daemon response) — is ambiguous and MUST stay open.
 */
export const CONCLUSIVE_ENGINE_REJECTION_RE =
  /error response from daemon|already in use|conflict|cannot connect to the docker daemon|invalid reference format/i;

interface IntentState {
  seq: number;
  kind: DockerCreateKind;
  name: string | null;
  /** `--volumes-from` target (":ro"/":rw" suffix stripped) — the donor whose absence fences the request. */
  fence: string | null;
  /** Host boot incarnation the intent was minted under (null on legacy records: treated as same-boot, ambiguous). */
  boot: string | null;
  /** True once the pre-invocation marker was durably appended. */
  dispatched: boolean;
  settled: boolean;
  /** Definitive daemon outcome once settled; a "failed" create never registered anything. */
  outcome: "created" | "failed" | null;
  proven: boolean;
  /** "undispatched" = provably never contacted the daemon; "reaped" = observed registration removed; "fenced" = proven dead pre-registration; "rebooted" = pre-restart request with the sealed engine's resource absent after a host boot change. */
  how: "undispatched" | "reaped" | "fenced" | "rebooted" | null;
}

export interface OpenCreateIntent {
  seq: number;
  kind: DockerCreateKind;
  name: string | null;
  fence: string | null;
  boot: string | null;
  dispatched: boolean;
}

export interface CreateIntent {
  seq: number;
  /** Durable pre-invocation marker — MUST be called (and complete) before any Docker invocation for this intent. */
  dispatched(): void;
  settle(outcome: "created" | "failed"): void;
}

/** Task handed to the detached create helper (paths are absolute). */
export interface DockerCreateHelperTask {
  argv: string[];
  startedPath: string;
  abortPath: string;
  outcomePath: string;
}

/** Runs one helper task to completion (the helper itself is never killed/timed out). DI seam for tests. */
export type DockerCreateHelper = (task: DockerCreateHelperTask) => Promise<void>;

/** Durable client outcome the helper publishes (stdout/stderr base64). */
interface HelperOutcome {
  aborted?: boolean;
  /** Set when the helper's spawnSync of the docker client reported an error. */
  spawnError?: string;
  /** errno code of that error (ENOENT, ENOBUFS, ETIMEDOUT, …). */
  spawnErrorCode?: string;
  /**
   * Explicit spawn witness recorded WITH the error: TRUE when the client
   * process actually started (pid > 0) before failing — e.g. ENOBUFS kills a
   * client whose POST may already be in the daemon. Absent = unknown = the
   * client may have run (fail closed).
   */
  spawned?: boolean;
  /** Client pid (0 when the spawn itself failed). */
  pid?: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** TEST-ONLY fault injection for the journal (short writes, fsync failures). Production leaves this unset. */
export interface DockerCreateJournalIo {
  write?: (fd: number, buf: Buffer, offset: number, length: number) => number;
  fsync?: (fd: number) => void;
}

/** Canonical hyphenated RFC-4122 UUID (lowercase) — the ONLY accepted boot-witness shape. */
const BOOT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Strict boot-incarnation witness parser: exactly one canonical hyphenated
 * UUID token (surrounding whitespace tolerated), normalized to lowercase.
 * Everything else — empty output, multi-line output, embedded text, or any
 * calendar rendering of the boot instant (`{ sec = …, usec = … } …`) — is
 * rejected: wall-clock text is adjustable WITHIN one boot (NTP, manual
 * clock set) and therefore carries no incarnation identity.
 */
export function parseBootUuid(value: string, source: string): string {
  const token = value.trim().toLowerCase();
  if (token.length === 0) throw new Error(`host boot identity unavailable: empty ${source}`);
  if (!BOOT_UUID_RE.test(token)) {
    throw new Error(`host boot identity unavailable: malformed ${source} (expected one canonical UUID)`);
  }
  return token;
}

/**
 * Exact host boot incarnation: a value that changes on every host restart
 * and NEVER within one. Linux: the kernel's random boot_id. Darwin:
 * kern.bootsessionuuid (a per-boot random session UUID — unlike
 * kern.boottime, which follows calendar-clock adjustments and so can change
 * mid-boot). Fail closed elsewhere — the reboot death-proof below must
 * never run on a guessed identity.
 */
export function currentHostBootId(): string {
  if (process.platform === "linux") {
    return parseBootUuid(readFileSync("/proc/sys/kernel/random/boot_id", "utf8"), "kernel boot_id");
  }
  if (process.platform === "darwin") {
    const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 15_000 });
    if (r.error !== undefined || r.status !== 0 || r.signal !== null) {
      const detail = r.error?.message ?? r.stderr?.trim() ?? "";
      throw new Error(
        `host boot identity unavailable: sysctl kern.bootsessionuuid ${detail.length > 0 ? detail : `exit ${r.status ?? r.signal}`}`,
      );
    }
    return parseBootUuid(r.stdout ?? "", "sysctl kern.bootsessionuuid");
  }
  throw new Error(`host boot identity unsupported on ${process.platform}; refusing an unverifiable reboot fence`);
}

export interface DockerCreateGate {
  /** Monotonic per-attempt epoch — embed in the donor name so old fences are never re-minted. */
  readonly epoch: number;
  /** Wrap the injected RunCommand: joins + journals every docker resource create; rewrites `docker run` two-phase; routes unclaimable creates through the detached helper. */
  wrap(run: RunCommand): RunCommand;
  /** Explicit write-ahead intent for creates dispatched outside the wrapped RunCommand (optimizer spawn path). */
  begin(kind: DockerCreateKind, name: string | null, fence: string | null): CreateIntent;
  /** Join every create the wrapper still has in flight (never kills a client). */
  drain(): Promise<void>;
  /** Open (unsettled, unproven) intents, inherited and current. */
  openIntents(): OpenCreateIntent[];
  /**
   * Resolution phase 1 for intents inherited from crashed attempts. Resolves
   * helper handshakes (settle from durable outcomes; abort-fence and prove
   * never-started dispatches undispatched), then observes/reaps registered
   * resources by name — an observation proves an intent only when the WAL
   * shows a single possible registrar. MUST run BEFORE the strict startup
   * sweep, which would destroy the evidence.
   */
  reapInheritedCreates(run: RunCommand): Promise<void>;
  /**
   * Resolution phase 2: the name-claim for remaining donor-fenced container
   * intents (see moby ordering fact above). MUST run after the strict sweep
   * (old donors gone forever) and after this attempt's donor exists (claims
   * attach it). Throws (refusing startup transiently) while a pending create
   * still holds the daemon's name reservation. Remaining ambiguous intents
   * stay latched: the run may resume; terminal completion keeps refusing
   * until a later resume observes the registration or the helper outcome.
   */
  proveInheritedIntents(run: RunCommand, opts: { runId: string; image: string; donorName: string }): Promise<void>;
  /** Terminal gate: throws while ANY intent is open — cleanup must not complete. */
  assertTerminal(): void;
}

/**
 * WAL reader for paths that must refuse terminalization without opening a
 * gate (dead-run finalization). Intents without a dispatched marker provably
 * never contacted the daemon and do not latch.
 */
export function readOpenDockerCreateIntents(runDir: string): OpenCreateIntent[] {
  return loadWal(join(runDir, DOCKER_CREATE_WAL)).open.filter((i) => i.dispatched);
}

const CONFLICT_RE = /already in use|conflict/i;
const MISSING_RE = /no such (container|volume|network|object)|not found|removal .*in progress/i;

/** Flags of `docker create` / `docker run` that consume the FOLLOWING token as a value. */
const CONTAINER_VALUE_FLAGS: Record<string, true> = Object.fromEntries([
  "-e", "--env", "--env-file", "-v", "--volume", "--volumes-from", "--mount", "--tmpfs",
  "-w", "--workdir", "--name", "--label", "--label-file", "--network", "--net", "--pull",
  "-u", "--user", "--add-host", "--cap-add", "--cap-drop", "--security-opt", "--pids-limit",
  "-m", "--memory", "--memory-swap", "--memory-reservation", "--cpus", "--cpu-shares",
  "--cpuset-cpus", "--log-driver", "--log-opt", "--entrypoint", "--hostname", "-h",
  "--device", "--dns", "--ipc", "--pid", "--shm-size", "--stop-signal", "--stop-timeout",
  "--restart", "--platform", "--cidfile", "--gpus", "--runtime", "--isolation",
  "--health-cmd", "--health-interval", "--health-retries", "--health-timeout", "--health-start-period",
  "-p", "--publish", "--expose", "--sysctl", "--ulimit", "--group-add", "--storage-opt",
].map((flag) => [flag, true]));

const VOLUME_VALUE_FLAGS: Record<string, true> = { "-d": true, "--driver": true, "-o": true, "--opt": true, "--label": true };
const NETWORK_VALUE_FLAGS: Record<string, true> = {
  ...VOLUME_VALUE_FLAGS,
  "--subnet": true, "--gateway": true, "--ip-range": true,
  "--aux-address": true, "--ipam-driver": true, "--ipam-opt": true, "--scope": true,
};

interface ContainerArgvInfo {
  name: string | null;
  fence: string | null;
  detach: boolean;
  /** argv with `docker run` → `docker create` and detach flags removed; null when argv[1] is already "create". */
  createArgv: string[] | null;
}

/** Parse the flag region of a `docker create|run` argv (flags precede the image, as docker requires). */
function parseContainerArgv(argv: readonly string[]): ContainerArgvInfo {
  const rewrite = argv[1] === "run";
  const out: string[] = ["docker", "create"];
  let name: string | null = null;
  let fence: string | null = null;
  let detach = false;
  let flagsDone = false;
  for (let i = 2; i < argv.length; i += 1) {
    const tok = argv[i] as string;
    if (!flagsDone && tok.startsWith("-")) {
      if (tok === "-d" || tok === "--detach") {
        detach = true;
        continue; // dropped from the create argv
      }
      const eq = tok.indexOf("=");
      const flag = eq >= 0 ? tok.slice(0, eq) : tok;
      const inlineValue = eq >= 0 ? tok.slice(eq + 1) : null;
      if (flag === "--name") name = inlineValue ?? (argv[i + 1] as string | undefined) ?? null;
      if (flag === "--volumes-from") {
        const raw = inlineValue ?? (argv[i + 1] as string | undefined);
        if (raw !== undefined) fence = raw.replace(/:(ro|rw)$/, "");
      }
      out.push(tok);
      if (inlineValue === null && CONTAINER_VALUE_FLAGS[flag] === true && i + 1 < argv.length) {
        out.push(argv[i + 1] as string);
        i += 1;
      }
      continue;
    }
    flagsDone = true; // image + command
    out.push(tok);
  }
  return { name, fence, detach, createArgv: rewrite ? out : null };
}

/** Last positional token of a `docker volume|network create` argv (the deterministic resource name). */
function parsePositionalName(argv: readonly string[], valueFlags: Record<string, true>): string | null {
  let name: string | null = null;
  for (let i = 3; i < argv.length; i += 1) {
    const tok = argv[i] as string;
    if (tok.startsWith("-")) {
      if (!tok.includes("=") && valueFlags[tok] === true) i += 1;
      continue;
    }
    name = tok;
  }
  return name;
}

interface Wal {
  epoch: number;
  states: Map<number, IntentState>;
  open: OpenCreateIntent[];
  nextSeq: number;
  /** Byte length of the durable (LF-terminated) prefix. */
  durableBytes: number;
  /** Total file length — greater than durableBytes iff a torn tail exists. */
  totalBytes: number;
}

function loadWal(path: string): Wal {
  const states = new Map<number, IntentState>();
  let epoch = 0;
  let nextSeq = 1;
  let durableBytes = 0;
  let totalBytes = 0;
  if (existsSync(path)) {
    const raw = readFileSync(path);
    totalBytes = raw.length;
    // A torn (unterminated) tail is an interrupted append: its writeAll/fsync
    // never returned, so the dispatch ordered AFTER it never happened —
    // logically dropped here, physically truncated by openDockerCreateGate.
    const lastLf = raw.lastIndexOf(0x0a);
    durableBytes = lastLf === -1 ? 0 : lastLf + 1;
    const lines = raw.subarray(0, durableBytes).toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (line === "") continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        // Every parsed line is LF-terminated (fully appended): corruption
        // here is NOT a torn tail. Unknown history = fail closed.
        throw new Error(`docker create journal is corrupt at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const t = record["t"];
      if (t === "epoch") {
        const e = record["epoch"];
        if (typeof e === "number" && e > epoch) epoch = e;
      } else if (t === "intent") {
        const seq = record["seq"];
        if (typeof seq !== "number") throw new Error(`docker create journal intent without seq at line ${i + 1}`);
        states.set(seq, {
          seq,
          kind: record["kind"] as DockerCreateKind,
          name: typeof record["name"] === "string" ? (record["name"] as string) : null,
          fence: typeof record["fence"] === "string" ? (record["fence"] as string) : null,
          boot: typeof record["boot"] === "string" ? (record["boot"] as string) : null,
          dispatched: false,
          settled: false,
          outcome: null,
          proven: false,
          how: null,
        });
        if (seq >= nextSeq) nextSeq = seq + 1;
      } else if (t === "dispatched" || t === "settled" || t === "proven") {
        const seq = record["seq"];
        const state = typeof seq === "number" ? states.get(seq) : undefined;
        if (state !== undefined) {
          if (t === "dispatched") {
            state.dispatched = true;
          } else if (t === "settled") {
            state.settled = true;
            state.outcome = record["outcome"] === "created" ? "created" : "failed";
          } else {
            state.proven = true;
            const how = record["how"];
            state.how = how === "reaped" || how === "undispatched" || how === "fenced" || how === "rebooted" ? how : null;
          }
        }
      }
    }
  }
  const open = [...states.values()]
    .filter((s) => !s.settled && !s.proven)
    .map((s) => ({ seq: s.seq, kind: s.kind, name: s.name, fence: s.fence, boot: s.boot, dispatched: s.dispatched }));
  return { epoch, states, open, nextSeq, durableBytes, totalBytes };
}

function noTimeout(opts: CmdOptions | undefined): CmdOptions {
  return { ...opts, timeoutMs: undefined };
}

/** fsync a path (file or directory) via a read handle. */
function fsyncPathSync(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Durable small-file publication: write tmp, fsync, rename, fsync dir. */
function publishFileSync(path: string, text: string, dir: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  fsyncPathSync(tmp);
  renameSync(tmp, path);
  fsyncPathSync(dir);
}

/**
 * Detached create helper source (run as `node -e`). Own process group, no
 * stdio ties: it survives a SIGKILL'd supervisor and ALWAYS reaches a
 * durable outcome. Protocol order is load-bearing (Dekker with the resumer):
 * publish `started` durably, THEN check `abort`, THEN invoke docker joined.
 */
const DOCKER_CREATE_HELPER_JS = `
const fs = require("node:fs");
const cp = require("node:child_process");
const path = require("node:path");
const task = JSON.parse(process.env.HONE_CREATE_TASK);
const fsyncPath = (f) => { const d = fs.openSync(f, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } };
const publish = (file, text) => {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fsyncPath(tmp);
  fs.renameSync(tmp, file);
  fsyncPath(path.dirname(file));
};
publish(task.startedPath, "");
let out;
if (fs.existsSync(task.abortPath)) {
  out = { aborted: true, exitCode: -1, stdout: "", stderr: "" };
} else {
  const r = cp.spawnSync(task.argv[0], task.argv.slice(1), { maxBuffer: 8 * 1024 * 1024 });
  const pid = typeof r.pid === "number" ? r.pid : 0;
  out = {
    exitCode: r.status === null ? -1 : r.status,
    pid,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("base64"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("base64"),
  };
  if (r.error) {
    out.spawnError = String(r.error);
    out.spawnErrorCode = r.error.code === undefined ? "" : String(r.error.code);
    // pid > 0 = the client process existed: an ENOBUFS/ETIMEDOUT kill happens
    // AFTER spawn, when the create may already be in the daemon.
    out.spawned = pid > 0;
  }
}
publish(task.outcomePath, JSON.stringify(out));
`;

function runHelperDetached(task: DockerCreateHelperTask, clientEnv: NodeJS.ProcessEnv): Promise<void> {
  const done = deferred<void>();
  const child = spawn(process.execPath, ["-e", DOCKER_CREATE_HELPER_JS], {
    // ONE docker client env snapshot for every channel: the helper's docker
    // spawn inherits exactly the run's env (plus the task), never a divergent
    // ambient context.
    env: { ...clientEnv, HONE_CREATE_TASK: JSON.stringify(task) },
    stdio: "ignore",
    // Own process group: a killed supervisor never takes the helper with it.
    detached: process.platform !== "win32",
  });
  child.on("error", (err) => done.reject(err));
  child.on("close", () => done.resolve());
  return done.promise;
}

function readHelperOutcome(outcomePath: string): HelperOutcome | null {
  if (!existsSync(outcomePath)) return null;
  const raw = JSON.parse(readFileSync(outcomePath, "utf8")) as Record<string, unknown>;
  return {
    aborted: raw["aborted"] === true,
    ...(typeof raw["spawnError"] === "string" ? { spawnError: raw["spawnError"] } : {}),
    ...(typeof raw["spawnErrorCode"] === "string" ? { spawnErrorCode: raw["spawnErrorCode"] } : {}),
    ...(typeof raw["spawned"] === "boolean" ? { spawned: raw["spawned"] } : {}),
    ...(typeof raw["pid"] === "number" ? { pid: raw["pid"] } : {}),
    exitCode: typeof raw["exitCode"] === "number" ? raw["exitCode"] : -1,
    stdout: typeof raw["stdout"] === "string" ? raw["stdout"] : "",
    stderr: typeof raw["stderr"] === "string" ? raw["stderr"] : "",
  };
}

export function openDockerCreateGate(
  runDir: string,
  runId: string,
  deps: { io?: DockerCreateJournalIo; helper?: DockerCreateHelper; bootId?: string; clientEnv?: NodeJS.ProcessEnv; endpointIsLocal?: boolean } = {},
): DockerCreateGate {
  const path = join(runDir, DOCKER_CREATE_WAL);
  const sidecar = join(runDir, DOCKER_CREATE_SIDECAR);
  const helper = deps.helper ?? ((task: DockerCreateHelperTask) => runHelperDetached(task, deps.clientEnv ?? process.env));
  const ioWrite = deps.io?.write ?? ((fd: number, buf: Buffer, offset: number, length: number) => writeSync(fd, buf, offset, length));
  const ioFsync = deps.io?.fsync ?? ((fd: number) => fsyncSync(fd));

  const existed = existsSync(path);
  const wal = loadWal(path);
  if (wal.totalBytes > wal.durableBytes) {
    // Physically truncate the torn tail BEFORE any append: O_APPEND would
    // fuse the next record onto the fragment, and the fused line would be a
    // TERMINATED corrupt record — permanent fail-closed on every later open.
    const tfd = openSync(path, "r+");
    try {
      ftruncateSync(tfd, wal.durableBytes);
      fsyncSync(tfd);
    } finally {
      closeSync(tfd);
    }
  }
  const fd = openSync(path, "a");
  mkdirSync(sidecar, { recursive: true });
  if (!existed) {
    // The journal file's (and sidecar dir's) DIRENTS must be durable before
    // the first intent can claim write-ahead semantics.
    fsyncPathSync(runDir);
  }

  // Fail closed: after ANY journal append/fsync failure nothing may dispatch.
  let poisoned: Error | null = null;
  const append = (record: Record<string, unknown>): void => {
    if (poisoned !== null) throw poisoned;
    try {
      const buf = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      let offset = 0;
      while (offset < buf.length) {
        const wrote = ioWrite(fd, buf, offset, buf.length - offset);
        if (!Number.isInteger(wrote) || wrote <= 0) throw new Error("short write to the docker create journal");
        offset += wrote;
      }
      ioFsync(fd);
    } catch (err) {
      poisoned = new Error(
        `docker create journal append failed (gate poisoned; nothing may dispatch): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw poisoned;
    }
  };

  const epoch = wal.epoch + 1;
  append({ v: 1, t: "epoch", epoch, at: new Date().toISOString() });
  const states = wal.states;
  let nextSeq = wal.nextSeq;
  const inflight = new Set<Promise<unknown>>();

  const prove = (seq: number, how: "undispatched" | "reaped" | "fenced" | "rebooted"): void => {
    const state = states.get(seq);
    if (state === undefined || state.proven || state.settled) return;
    state.proven = true;
    state.how = how;
    append({ v: 1, t: "proven", seq, how, at: new Date().toISOString() });
  };

  const settleInherited = (seq: number, outcome: "created" | "failed"): void => {
    const state = states.get(seq);
    if (state === undefined || state.settled || state.proven) return;
    state.settled = true;
    state.outcome = outcome;
    append({ v: 1, t: "settled", seq, outcome, at: new Date().toISOString() });
  };

  /**
   * An intent whose dispatched marker never became durable provably never
   * contacted the daemon: every invocation path strictly happens-after that
   * fsync returns (a detached helper cannot exist without it either).
   */
  const inherited = wal.open.filter((i) => {
    if (i.dispatched) return true;
    prove(i.seq, "undispatched");
    return false;
  });

  // Host boot witness (TEST-ONLY injectable): stamped into every intent so a
  // resume can prove a pre-restart request dead once the host rebooted. The
  // injected seam passes the SAME strict parser — the gate never runs on a
  // non-canonical incarnation identity.
  const bootId = deps.bootId === undefined ? currentHostBootId() : parseBootUuid(deps.bootId, "injected boot witness");

  const begin = (kind: DockerCreateKind, name: string | null, fence: string | null): CreateIntent => {
    const seq = nextSeq;
    nextSeq += 1;
    const state: IntentState = { seq, kind, name, fence, boot: bootId, dispatched: false, settled: false, outcome: null, proven: false, how: null };
    states.set(seq, state);
    append({ v: 1, t: "intent", seq, kind, name, fence, boot: bootId, at: new Date().toISOString() });
    return {
      seq,
      dispatched(): void {
        if (state.dispatched) return;
        append({ v: 1, t: "dispatched", seq, at: new Date().toISOString() });
        state.dispatched = true;
      },
      settle(outcome: "created" | "failed"): void {
        if (state.settled) return;
        state.settled = true;
        state.outcome = outcome;
        append({ v: 1, t: "settled", seq, outcome, at: new Date().toISOString() });
      },
    };
  };

  /**
   * P1(3): the daemon's verdict, not the client's death. exit 0 = created.
   * Nonzero settles "failed" only on conclusive Engine evidence; anything
   * else (external signal, transport loss after POST acceptance) stays open.
   */
  const settleFromResult = (intent: CreateIntent, result: Pick<CmdResult, "exitCode" | "timedOut"> & { stderrText: string }): void => {
    if (result.timedOut) return; // a client timeout is NOT a daemon response
    if (result.exitCode === 0) {
      intent.settle("created");
      return;
    }
    if (CONCLUSIVE_ENGINE_REJECTION_RE.test(result.stderrText)) intent.settle("failed");
  };

  /** Joined daemon-side reap of a registered container — the client's death never stops a container. */
  const reap = async (run: RunCommand, ref: string): Promise<void> => {
    try {
      await run(["docker", "rm", "-f", ref], {});
    } catch {
      // The container is REGISTERED (visible to the strict sweeps); a failed
      // reap here surfaces at the final sweep, never as silent success.
    }
  };

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    return p.finally(() => inflight.delete(p)) as Promise<T>;
  };

  const sidecarPaths = (seq: number): DockerCreateHelperTask & { argv: string[] } => ({
    argv: [],
    startedPath: join(sidecar, `${seq}.started`),
    abortPath: join(sidecar, `${seq}.abort`),
    outcomePath: join(sidecar, `${seq}.outcome`),
  });

  /** Dispatch an unclaimable create through the detached helper; returns the client result (or null when no outcome became durable). */
  const dispatchViaHelper = async (intent: CreateIntent, argv: readonly string[]): Promise<CmdResult | null> => {
    const paths = sidecarPaths(intent.seq);
    const task: DockerCreateHelperTask = { ...paths, argv: [...argv] };
    intent.dispatched(); // marker strictly precedes the helper spawn
    await helper(task);
    const outcome = readHelperOutcome(task.outcomePath);
    if (outcome === null) return null; // helper died without a durable outcome: stays open
    const result: CmdResult = {
      exitCode: outcome.exitCode,
      stdout: Buffer.from(outcome.stdout, "base64"),
      stderr: Buffer.from(outcome.stderr, "base64"),
      truncated: false,
      timedOut: false,
    };
    if (outcome.spawnError !== undefined) {
      if (outcome.spawned === false) {
        // GENUINE pre-spawn failure (pid 0 recorded WITH the error): the
        // docker client never existed, so the daemon was provably never
        // contacted — a conclusive verdict.
        intent.settle("failed");
        return { ...result, exitCode: result.exitCode === 0 ? 127 : result.exitCode, stderr: Buffer.from(outcome.spawnError) };
      }
      // POST-spawn client error (ENOBUFS output overflow, ETIMEDOUT kill) or
      // an outcome without the spawn witness: the client RAN and its create
      // may already be registered in the daemon — a late registration must
      // not escape. NOT a verdict: stays open/latched until inherited
      // reaping observes the engine.
      return { ...result, exitCode: result.exitCode === 0 ? -1 : result.exitCode, stderr: Buffer.from(outcome.spawnError) };
    }
    settleFromResult(intent, { exitCode: result.exitCode, timedOut: false, stderrText: result.stderr.toString("utf8") });
    return result;
  };

  const wrap = (run: RunCommand): RunCommand => {
    const wrapped: RunCommand = (argv, opts) => track(dispatch(argv, opts));
    const dispatch = async (argv: readonly string[], opts?: CmdOptions): Promise<CmdResult> => {
      if (argv[0] !== "docker") return run(argv, opts);
      if (argv[1] === "create" || argv[1] === "run") {
        const info = parseContainerArgv(argv);
        const intent = begin("container", info.name, info.fence);
        if (info.createArgv === null && info.fence === null) {
          // UNCLAIMABLE (donor-style) create: no fence exists to prove a
          // crashed request dead, so the detached helper guarantees a
          // durable outcome under kill+resume.
          const result = await dispatchViaHelper(intent, argv);
          return result ?? { exitCode: -1, stdout: Buffer.alloc(0), stderr: Buffer.from("docker create helper produced no durable outcome"), truncated: false, timedOut: false };
        }
        if (info.createArgv === null) {
          // Plain fenced `docker create`: join the daemon's definitive response.
          intent.dispatched();
          const result = await run(argv, noTimeout(opts));
          settleFromResult(intent, { exitCode: result.exitCode, timedOut: result.timedOut, stderrText: result.stderr.toString("utf8") });
          return result;
        }
        // `docker run` → two-phase: joined create, bounded (killable) start.
        intent.dispatched();
        const created = await run(info.createArgv, noTimeout({ ...opts, stdin: undefined, stdinFile: undefined }));
        settleFromResult(intent, { exitCode: created.exitCode, timedOut: created.timedOut, stderrText: created.stderr.toString("utf8") });
        if (created.timedOut || created.exitCode !== 0) return created;
        const id = created.stdout.toString("utf8").trim().split("\n").pop() ?? "";
        const ref = id !== "" ? id : info.name;
        if (ref === null || ref === "") {
          // Created but unaddressable (no id, no name): the label sweep owns
          // it; report failure to the caller.
          return { ...created, exitCode: 125, stderr: Buffer.from("docker create returned no container id") };
        }
        const startArgv = info.detach ? ["docker", "start", ref] : ["docker", "start", "-a", ref];
        let started: CmdResult;
        try {
          started = await run(startArgv, opts);
        } catch (err) {
          await reap(run, ref);
          throw err;
        }
        if (started.timedOut || (info.detach && started.exitCode !== 0)) {
          // The start CLIENT died or failed — the registered container did
          // not. Reap it daemon-side BEFORE returning (joined).
          await reap(run, ref);
          return info.detach ? { ...started, stdout: Buffer.alloc(0) } : started;
        }
        if (info.detach) {
          // Mimic `docker run -d`: stdout is the container id.
          return { exitCode: 0, stdout: Buffer.from(`${ref}\n`), stderr: started.stderr, truncated: false, timedOut: false };
        }
        return started;
      }
      if ((argv[1] === "volume" || argv[1] === "network") && argv[2] === "create") {
        const kind = argv[1] as DockerCreateKind;
        const name = parsePositionalName(argv, kind === "volume" ? VOLUME_VALUE_FLAGS : NETWORK_VALUE_FLAGS);
        // Volumes/networks have no fence dependency: unclaimable → helper.
        const intent = begin(kind, name, null);
        const result = await dispatchViaHelper(intent, argv);
        return result ?? { exitCode: -1, stdout: Buffer.alloc(0), stderr: Buffer.from("docker create helper produced no durable outcome"), truncated: false, timedOut: false };
      }
      return run(argv, opts);
    };
    return wrapped;
  };

  const openInherited = (): OpenCreateIntent[] =>
    inherited.filter((i) => {
      const s = states.get(i.seq);
      return s !== undefined && !s.settled && !s.proven;
    });

  /** Group open inherited intents by (non-null) name; null-named DISPATCHED intents can never be proven and stay latched. */
  const groupInherited = (intents: OpenCreateIntent[]): Map<string, OpenCreateIntent[]> => {
    const byName = new Map<string, OpenCreateIntent[]>();
    for (const intent of intents) {
      if (intent.name === null) continue;
      const group = byName.get(intent.name) ?? [];
      group.push(intent);
      byName.set(intent.name, group);
    }
    return byName;
  };

  const helperKind = (i: OpenCreateIntent): boolean => i.kind !== "container" || i.fence === null;

  /**
   * Dekker resolution for inherited helper-dispatched intents: settle from a
   * durable outcome; otherwise fsync the abort marker FIRST, then judge —
   * `started` absent means any later helper must observe the abort before
   * contacting docker (proven undispatched); `started` present means the
   * helper is/was live and its outcome settles a later resume.
   */
  const resolveHelperHandshakes = (): void => {
    for (const intent of openInherited()) {
      if (!helperKind(intent)) continue;
      const paths = sidecarPaths(intent.seq);
      const outcome = readHelperOutcome(paths.outcomePath);
      if (outcome !== null) {
        if (outcome.aborted === true || (outcome.spawnError !== undefined && outcome.spawned === false)) {
          // Helper never contacted docker (aborted pre-call, or its client
          // PROVABLY never spawned — pid-0 witness recorded with the error):
          // causally dead.
          prove(intent.seq, "undispatched");
        } else if (outcome.spawnError === undefined) {
          if (outcome.exitCode === 0) {
            settleInherited(intent.seq, "created");
          } else if (CONCLUSIVE_ENGINE_REJECTION_RE.test(Buffer.from(outcome.stderr, "base64").toString("utf8"))) {
            settleInherited(intent.seq, "failed");
          }
        }
        // Post-spawn client errors (ENOBUFS after dispatch, witness absent)
        // and other ambiguous recorded outcomes stay open for the
        // observation phase — the engine, not the client's death, decides.
        continue;
      }
      if (!existsSync(paths.abortPath)) publishFileSync(paths.abortPath, "", sidecar);
      if (!existsSync(paths.startedPath)) {
        // Abort is durable and no helper ever started: a helper that starts
        // later publishes `started` and THEN sees the abort — it exits
        // before contacting docker. Proven undispatched.
        prove(intent.seq, "undispatched");
      }
      // started present, no outcome: the helper is (or was) mid-flight. It
      // always reaches a durable outcome under kill+resume — the NEXT resume
      // settles from it. Latched transiently, not permanently.
    }
  };

  const reapInheritedCreates = async (run: RunCommand): Promise<void> => {
    resolveHelperHandshakes();
    for (const [name, group] of groupInherited(openInherited())) {
      const kinds = new Set(group.map((i) => i.kind));
      if (kinds.size > 1) throw new Error(`docker create intents for "${name}" span kinds ${[...kinds].join(",")}; refusing to proceed`);
      const kind = group[0]?.kind as DockerCreateKind;
      // Observation must be unambiguous: `rm -f` exit codes differ per kind
      // for a missing resource, so inspect first, then remove strictly.
      const inspectArgv =
        kind === "container"
          ? ["docker", "container", "inspect", name]
          : kind === "volume"
            ? ["docker", "volume", "inspect", name]
            : ["docker", "network", "inspect", name];
      const inspected = await run(inspectArgv, { timeoutMs: 30_000 });
      const inspectStderr = inspected.stderr.toString("utf8");
      if (inspected.exitCode !== 0 || inspected.timedOut) {
        if (!inspected.timedOut && MISSING_RE.test(inspectStderr)) {
          // Reboot death-proof — ONLY for a demonstrably LOCAL engine (the
          // sealed endpoint kind is a host unix socket, so the daemon and
          // every in-flight request died with the host): the resource is
          // ABSENT on the SEALED engine, and an intent minted under a
          // PREVIOUS host boot has no surviving helper, client, or in-daemon
          // request — pre-registration requests are not persisted. A remote
          // (tcp/ssh/npipe/context) engine survives a local reboot: those
          // stay ambiguous and fail closed. Same-boot absence stays
          // ambiguous and latched (a live helper/daemon may still deliver).
          if (deps.endpointIsLocal === true) {
            for (const intent of group) {
              // BOTH sides must be canonical boot UUIDs: an inherited WAL
              // stamped under the retired calendar boot-time identity (or any
              // malformed boot) stays ambiguous — mere inequality with the
              // current witness proves nothing about a reboot.
              if (intent.boot !== null && BOOT_UUID_RE.test(intent.boot) && intent.boot !== bootId) prove(intent.seq, "rebooted");
            }
          }
          continue;
        }
        throw new Error(`docker ${kind} discovery for crashed create "${name}" failed: ${inspectStderr.slice(0, 2000) || `exit ${inspected.exitCode}`}`);
      }
      const rmArgv =
        kind === "container"
          ? ["docker", "rm", "-f", name]
          : kind === "volume"
            ? ["docker", "volume", "rm", "-f", name]
            : ["docker", "network", "rm", name];
      const removed = await run(rmArgv, {});
      if ((removed.exitCode !== 0 && !MISSING_RE.test(removed.stderr.toString("utf8"))) || removed.timedOut) {
        throw new Error(`removing crashed create "${name}" failed: ${removed.stderr.toString("utf8").slice(0, 2000) || `exit ${removed.exitCode}`}`);
      }
      // Attribution: the observed registration proves THE intent only when
      // exactly one request ever REGISTERED under this name — one open intent
      // and no later same-named create that actually created a container
      // (settled-created or reaped) whose leftover could masquerade. Failed
      // and fence-proven creates never registered anything and cannot alias.
      const openSeq = group[0]?.seq ?? 0;
      const laterSameName = [...states.values()].some(
        (s) => s.name === name && s.seq > openSeq && (s.outcome === "created" || s.how === "reaped"),
      );
      if (group.length === 1 && !laterSameName) prove(openSeq, "reaped");
    }
  };

  const proveInheritedIntents = async (
    run: RunCommand,
    opts: { runId: string; image: string; donorName: string },
  ): Promise<void> => {
    const unresolved = openInherited();
    if (unresolved.length === 0) return;
    const fenceNames = new Set(unresolved.map((i) => i.fence).filter((f): f is string => f !== null));

    for (const [name, group] of groupInherited(unresolved)) {
      const kind = group[0]?.kind as DockerCreateKind;
      const fenced = group.every((i) => i.fence !== null);
      if (kind !== "container" || !fenced) {
        // Unclaimable (donor/volume/network): the helper handshake or a later
        // observation resolves these; a claim here could rematerialize a
        // fence and unsound previously issued fenced verdicts.
        continue;
      }
      if (fenceNames.has(name)) {
        // Defense in depth: never claim a name that fences other intents.
        throw new Error(`docker create intent name "${name}" is also a fence; refusing to claim it`);
      }
      // Reap any registration that landed since the observation phase
      // (cleanup, not proof), then claim.
      const reReap = await run(["docker", "rm", "-f", name], {});
      if (reReap.exitCode !== 0 && !MISSING_RE.test(reReap.stderr.toString("utf8"))) {
        throw new Error(`removing crashed create "${name}" failed: ${reReap.stderr.toString("utf8").slice(0, 2000)}`);
      }
      const claim = await run(
        [
          "docker", "create",
          "--name", name,
          "--label", `hone.runId=${opts.runId}`,
          "--network", "none",
          "--pull=never",
          "--read-only",
          "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges",
          "--pids-limit", "8",
          "--memory", "16777216",
          "--memory-swap", "16777216",
          "--cpus", "0.1",
          "--log-driver", "none",
          "--volumes-from", `${opts.donorName}:ro`,
          opts.image,
          "true",
        ],
        {},
      );
      const claimStderr = claim.stderr.toString("utf8");
      if (claim.timedOut) throw new Error(`docker create claim for "${name}" returned a client timeout; refusing to proceed`);
      if (claim.exitCode !== 0) {
        if (CONFLICT_RE.test(claimStderr)) {
          throw new Error(
            `a docker create for "${name}" from a crashed attempt is still in flight in the daemon (name reservation held); refusing to proceed — retry once the daemon quiesces`,
          );
        }
        throw new Error(`docker create claim for "${name}" failed: ${claimStderr.slice(0, 2000) || `exit ${claim.exitCode}`}`);
      }
      // Claim registered: every pending request for this name is
      // pre-reservation (moby reserves the name before resolving
      // --volumes-from and before Register), hence dead once its old donor
      // epoch is gone — which the strict sweep guaranteed and epoch
      // monotonicity keeps true forever.
      for (const intent of group) prove(intent.seq, "fenced");
      const unclaim = await run(["docker", "rm", "-f", name], {});
      if (unclaim.exitCode !== 0 && !MISSING_RE.test(unclaim.stderr.toString("utf8"))) {
        throw new Error(`removing docker create claim "${name}" failed: ${unclaim.stderr.toString("utf8").slice(0, 2000)}`);
      }
    }
  };

  return {
    epoch,
    wrap,
    begin,
    drain: async (): Promise<void> => {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
    openIntents: (): OpenCreateIntent[] =>
      [...states.values()]
        .filter((s) => !s.settled && !s.proven)
        .map((s) => ({ seq: s.seq, kind: s.kind, name: s.name, fence: s.fence, boot: s.boot, dispatched: s.dispatched })),
    reapInheritedCreates,
    proveInheritedIntents,
    assertTerminal: (): void => {
      if (poisoned !== null) throw poisoned;
      const open = [...states.values()].filter((s) => !s.settled && !s.proven);
      if (open.length > 0) {
        const detail = open.map((s) => `#${s.seq} ${s.kind} ${s.name ?? "<unnamed>"}`).join(", ");
        throw new Error(
          `docker create outcomes are unresolved (${detail}) — the daemon may still publish them; refusing terminal completion until a causal proof clears the latch`,
        );
      }
    },
  };
}
