import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { hostname, machine, release } from "node:os";
import { IMAGE_DIGEST_REF } from "@hone/schema";
import { UsageError } from "./args.js";
import { CALIBRATION_SANDBOX, type CalibrationHostBinding } from "./calibration-types.js";
import { currentHostBootId, parseSandboxCgroupParent } from "./docker-create-gate.js";

/**
 * Calibration host preflight (TWA-91 P2): the approved 2 GiB / 2 CPU
 * sandbox ceiling is an AGGREGATE per cell, not a per-container limit. The
 * only thing that bounds a cell's coordinator plus every forwarded Docker
 * child as one unit is a native cgroup-v2 parent whose own limits enclose
 * all of them. This module OBSERVES that parent and refuses to certify
 * anything it cannot prove; it never provisions, moves the process, edits
 * Docker configuration, or creates host resources.
 *
 * What a returned binding proves, at the instant of inspection:
 *  - native Linux with the unified (v2) hierarchy mounted at /sys/fs/cgroup;
 *  - the nominated parent exists in the kernel tree at a canonical path (no
 *    symlink or dot-segment escape), carries a finite memory.max within the
 *    approved ceiling, memory.swap.max = 0, and a finite cpu.max whose
 *    quota/period ratio is within the approved CPU ceiling;
 *  - THIS process (the calibration supervisor) is a descendant of that
 *    parent, so its own consumption is inside the aggregate — every Docker
 *    child created through the create gate with --cgroup-parent lands in the
 *    same subtree;
 *  - the selected Docker engine is a same-host unix-socket daemon (no remote
 *    context, no TLS, no Docker Desktop VM, no rootless daemon), on cgroup
 *    v2 with a systemd or cgroupfs driver whose --cgroup-parent form matches
 *    the nominated value;
 *  - the exact pinned image reference resolves locally to a Linux image of
 *    the host's native architecture.
 * The kernel boot id, engine id and image id are pinned so the caller can
 * require canonical equality before admitted planning and again immediately
 * before every dispatch (TOCTOU: the facts are rechecked, not remembered).
 *
 * Deliberately NOT established here: Gate-2 task admission, and any
 * performance/stability measurement of the target — those stay separate.
 */

const CGROUP_ROOT = "/sys/fs/cgroup";
const DOCKER_TIMEOUT_MS = 30_000;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
/** uname machine -> OCI image architecture; anything else is refused. */
const OCI_ARCHITECTURE: Readonly<Record<string, string>> = { x86_64: "amd64", aarch64: "arm64" };

/** One synchronous docker CLI invocation as the inspector sees it. */
export interface CalibrationHostDockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure (binary missing, timeout) — distinct from a non-zero exit. */
  error: string | null;
}

/**
 * Trusted probe seam: every host fact the inspector consumes. Production
 * uses NATIVE_CALIBRATION_HOST_PROBES; tests substitute a fixture to exercise
 * the acceptance path on a non-Linux development host. Nothing here can
 * turn a refusal into an acceptance without faking the observed facts.
 */
export interface CalibrationHostProbes {
  platform: NodeJS.Platform;
  /** uname machine (os.machine()): compared against `docker info` Architecture. */
  machine: string;
  /** uname release (os.release()): compared against `docker info` KernelVersion. */
  kernelRelease: string;
  /** os.hostname(): compared against `docker info` Name (a VM/container daemon reports its own). */
  hostname: string;
  pid: number;
  readText(path: string): string;
  realpath(path: string): string;
  isDirectory(path: string): boolean;
  isSocket(path: string): boolean;
  bootId(): string;
  docker(args: string[], env: NodeJS.ProcessEnv): CalibrationHostDockerResult;
}

export const NATIVE_CALIBRATION_HOST_PROBES: CalibrationHostProbes = {
  platform: process.platform,
  machine: machine(),
  kernelRelease: release(),
  hostname: hostname(),
  pid: process.pid,
  readText: (path) => readFileSync(path, "utf8"),
  realpath: (path) => realpathSync(path),
  isDirectory: (path) => statSync(path).isDirectory(),
  isSocket: (path) => lstatSync(path).isSocket(),
  bootId: currentHostBootId,
  docker: (args, env) => {
    const r = spawnSync("docker", args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DOCKER_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      error: r.error !== undefined ? r.error.message : r.signal !== null ? `killed by ${r.signal}` : null,
    };
  },
};

function refuse(why: string): never {
  throw new UsageError(`calibration host refused: ${why}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readText(probes: CalibrationHostProbes, path: string, what: string): string {
  try {
    return probes.readText(path);
  } catch (error) {
    refuse(`${what} is unreadable at ${path} (${errorMessage(error)})`);
  }
}

// ---------------------------------------------------------------------------
// Kernel cgroup facts
// ---------------------------------------------------------------------------

/**
 * The unified hierarchy must be THE cgroup filesystem at /sys/fs/cgroup:
 * fstype cgroup2 with mount root "/" (a bind mount of a subtree, or a
 * legacy/hybrid v1 mount, would make every path below mean something else
 * to the kernel than to the Docker daemon).
 */
function assertUnifiedHierarchy(probes: CalibrationHostProbes): void {
  const mountinfo = readText(probes, "/proc/self/mountinfo", "mount table");
  let found: { root: string } | null = null;
  for (const line of mountinfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator === -1) continue;
    const head = line.slice(0, separator).split(" ");
    const tail = line.slice(separator + 3).split(" ");
    // head: id parent maj:min root mountpoint options [optional fields...]; tail: fstype source superopts
    if (head[4] === CGROUP_ROOT && tail[0] === "cgroup2") found = { root: head[3] ?? "" };
  }
  if (found === null) refuse(`no cgroup2 filesystem is mounted at ${CGROUP_ROOT} — only the native unified cgroup-v2 hierarchy is supported (hybrid/v1 hosts are not)`);
  if (found.root !== "/") {
    refuse(`${CGROUP_ROOT} exposes cgroup subtree ${found.root}, not the hierarchy root — the supervisor is not running in the host's root cgroup view`);
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = probes.realpath(CGROUP_ROOT);
  } catch (error) {
    refuse(`${CGROUP_ROOT} cannot be canonicalized (${errorMessage(error)})`);
  }
  if (canonicalRoot !== CGROUP_ROOT) refuse(`${CGROUP_ROOT} resolves to ${canonicalRoot}; refusing a redirected cgroup root`);
}

/** The supervisor's own unified cgroup path from /proc/self/cgroup (exactly one `0::` line). */
function currentCgroupPath(probes: CalibrationHostProbes): string {
  const lines = readText(probes, "/proc/self/cgroup", "process cgroup membership").split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1 || !lines[0]!.startsWith("0::")) {
    refuse("the process is not on a pure unified cgroup-v2 hierarchy (expected exactly one `0::` line in /proc/self/cgroup)");
  }
  const path = lines[0]!.slice(3);
  if (path.endsWith(" (deleted)")) refuse("the process's cgroup has been deleted; it is no longer inside any accountable parent");
  if (!path.startsWith("/")) refuse(`the process cgroup path ${JSON.stringify(path)} is not absolute`);
  return path;
}

/**
 * Map a systemd slice name onto its kernel path exactly the way systemd and
 * runc expand it: hyphens nest, each prefix is a `.slice` ancestor
 * (`foo-bar.slice` -> `/foo.slice/foo-bar.slice`). Root `-.slice`, empty
 * components and path separators were already rejected by the shared parser.
 */
function systemdSlicePath(slice: string): string {
  const components = slice.slice(0, -".slice".length).split("-");
  let path = "";
  let prefix = "";
  for (const component of components) {
    path += `/${prefix}${component}.slice`;
    prefix += `${component}-`;
  }
  return path;
}

interface ParentLimits {
  memoryBytes: number;
  cpuQuota: number;
  cpuPeriod: number;
}

function parseCount(value: string, what: string, path: string): number | "max" {
  const token = value.trim();
  if (token === "max") return "max";
  if (!/^[0-9]+$/.test(token)) refuse(`${what} at ${path} is malformed (${JSON.stringify(token)})`);
  const parsed = Number(token);
  if (!Number.isSafeInteger(parsed)) refuse(`${what} at ${path} is not safely representable (${token})`);
  return parsed;
}

/** memory.max / memory.swap.max / cpu.max of the nominated parent, each fail-closed. */
function readParentLimits(probes: CalibrationHostProbes, dir: string, cgroupPath: string): ParentLimits {
  const memoryPath = `${dir}/memory.max`;
  const memory = parseCount(readText(probes, memoryPath, `memory.max of ${cgroupPath} (memory controller must be enabled on it)`), "memory.max", memoryPath);
  if (memory === "max") refuse(`${cgroupPath} has no memory ceiling (memory.max = max); the aggregate must be capped at ${CALIBRATION_SANDBOX.memoryBytes} bytes`);
  if (memory <= 0 || memory > CALIBRATION_SANDBOX.memoryBytes) {
    refuse(`${cgroupPath} memory.max ${memory} is outside the approved aggregate ceiling (0, ${CALIBRATION_SANDBOX.memoryBytes}]`);
  }
  const swapPath = `${dir}/memory.swap.max`;
  const swap = parseCount(readText(probes, swapPath, `memory.swap.max of ${cgroupPath} (kernel swap accounting must be enabled)`), "memory.swap.max", swapPath);
  if (swap !== 0) refuse(`${cgroupPath} memory.swap.max is ${swap}, not 0 — swap would let the cell exceed its memory ceiling`);
  const cpuPath = `${dir}/cpu.max`;
  const cpuRaw = readText(probes, cpuPath, `cpu.max of ${cgroupPath} (cpu controller must be enabled on it)`).trim();
  const cpuMatch = /^(max|[0-9]+) ([0-9]+)$/.exec(cpuRaw);
  if (cpuMatch === null) refuse(`cpu.max at ${cpuPath} is malformed (${JSON.stringify(cpuRaw)})`);
  const quota = parseCount(cpuMatch[1]!, "cpu.max quota", cpuPath);
  const period = parseCount(cpuMatch[2]!, "cpu.max period", cpuPath);
  if (quota === "max") refuse(`${cgroupPath} has no CPU ceiling (cpu.max quota = max); the aggregate must be capped at ${CALIBRATION_SANDBOX.cpus} CPUs`);
  if (period === "max" || period <= 0 || quota <= 0) refuse(`${cgroupPath} cpu.max ${cpuRaw} is not a finite positive quota/period`);
  if (quota / period > CALIBRATION_SANDBOX.cpus) {
    refuse(`${cgroupPath} cpu.max ${cpuRaw} allows ${quota / period} CPUs, above the approved aggregate ceiling of ${CALIBRATION_SANDBOX.cpus}`);
  }
  return { memoryBytes: memory, cpuQuota: quota, cpuPeriod: period };
}

/**
 * Resolve the nominated parent to its kernel path under the selected Docker
 * driver, prove it exists canonically, carries the required limits, and
 * encloses THIS process (membership also cross-checked through
 * `cgroup.procs`, so /proc/self/cgroup and /sys/fs/cgroup speak the same
 * coordinates).
 */
function inspectParent(probes: CalibrationHostProbes, cgroupParent: string, driver: CalibrationHostBinding["cgroupDriver"]): { cgroupPath: string } & ParentLimits {
  // Shape was validated by the entry before any Docker contact; here the
  // form must agree with the driver that will interpret --cgroup-parent.
  const isSlice = cgroupParent.endsWith(".slice");
  if (driver === "systemd" && !isSlice) {
    refuse(`Docker uses the systemd cgroup driver; --cgroup-parent must be a hyphen-nested xxx.slice name, not the cgroupfs path ${cgroupParent}`);
  }
  if (driver === "cgroupfs" && isSlice) {
    refuse(`Docker uses the cgroupfs cgroup driver; --cgroup-parent must be an absolute kernel cgroup path, not the systemd slice ${cgroupParent}`);
  }
  const cgroupPath = isSlice ? systemdSlicePath(cgroupParent) : cgroupParent;
  const dir = `${CGROUP_ROOT}${cgroupPath}`;
  let isDirectory: boolean;
  try {
    isDirectory = probes.isDirectory(dir);
  } catch (error) {
    refuse(`cgroup parent ${cgroupPath} does not exist in the kernel tree (${errorMessage(error)}); the aggregate cgroup must already exist with this process inside it`);
  }
  if (!isDirectory) refuse(`${dir} is not a cgroup directory`);
  let canonical: string;
  try {
    canonical = probes.realpath(dir);
  } catch (error) {
    refuse(`cgroup parent ${dir} cannot be canonicalized (${errorMessage(error)})`);
  }
  if (canonical !== dir) refuse(`cgroup parent ${dir} resolves to ${canonical}; refusing a non-canonical (symlinked) parent`);

  const current = currentCgroupPath(probes);
  if (current !== cgroupPath && !current.startsWith(`${cgroupPath}/`)) {
    refuse(
      `this supervisor runs in cgroup ${current}, which is not inside the nominated parent ${cgroupPath} — its own usage would escape the ${CALIBRATION_SANDBOX.memoryBytes}-byte / ${CALIBRATION_SANDBOX.cpus}-CPU aggregate; start it inside that cgroup`,
    );
  }
  const procsPath = `${CGROUP_ROOT}${current}/cgroup.procs`;
  const members = readText(probes, procsPath, "cgroup.procs of the process's own cgroup").split("\n");
  if (!members.includes(String(probes.pid))) {
    refuse(`pid ${probes.pid} is not listed in ${procsPath} — /proc/self/cgroup and ${CGROUP_ROOT} disagree (cgroup namespace or foreign mount); refusing`);
  }
  return { cgroupPath, ...readParentLimits(probes, dir, cgroupPath) };
}

// ---------------------------------------------------------------------------
// Docker facts
// ---------------------------------------------------------------------------

function pick(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

function docker(probes: CalibrationHostProbes, args: string[], env: NodeJS.ProcessEnv, what: string): string {
  const r = probes.docker(args, env);
  if (r.error !== null) refuse(`${what} failed to run: ${r.error}`);
  if (r.status !== 0) refuse(`${what} failed (exit ${r.status}): ${r.stderr.trim().slice(0, 2000) || "<no stderr>"}`);
  return r.stdout;
}

/**
 * Same resolution as the run path freezes: explicit DOCKER_HOST wins,
 * otherwise the current context's endpoint; TLS forms and anything but a
 * local `unix://` socket refuse; the socket path is canonicalized and must
 * BE a socket. Returns the canonical `unix://` endpoint.
 */
function resolveLocalEndpoint(probes: CalibrationHostProbes, env: NodeJS.ProcessEnv): string {
  if (env["DOCKER_TLS_VERIFY"] !== undefined || env["DOCKER_CERT_PATH"] !== undefined) {
    refuse("docker TLS client configuration is set — only a same-host unix:// engine can enclose the aggregate cgroup");
  }
  let endpoint = env["DOCKER_HOST"];
  if (endpoint === undefined || endpoint.length === 0) {
    endpoint = docker(
      probes,
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      pick(env, ["PATH", "HOME", "TMPDIR", "DOCKER_CONFIG", "DOCKER_CONTEXT"]),
      "docker endpoint resolution (docker context inspect)",
    ).trim();
    if (endpoint.length === 0) refuse("docker context inspect reported no endpoint");
  }
  if (!endpoint.startsWith("unix://")) {
    refuse(`docker endpoint ${endpoint} is not a local unix socket — a remote engine cannot place containers in this host's cgroup`);
  }
  const raw = endpoint.slice("unix://".length);
  let canonical: string;
  try {
    canonical = probes.realpath(raw);
  } catch (error) {
    refuse(`docker endpoint socket ${raw} cannot be canonicalized (${errorMessage(error)})`);
  }
  let socket: boolean;
  try {
    socket = probes.isSocket(canonical);
  } catch (error) {
    refuse(`docker endpoint ${canonical} is not inspectable (${errorMessage(error)})`);
  }
  if (!socket) refuse(`docker endpoint ${canonical} is not a unix socket`);
  return `unix://${canonical}`;
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    refuse(`${what} did not return JSON (${errorMessage(error)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) refuse(`${what} did not return a JSON object`);
  return parsed as Record<string, unknown>;
}

function stringField(object: Record<string, unknown>, key: string, what: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) refuse(`${what} reports no ${key}`);
  return value;
}

function stringList(object: Record<string, unknown>, key: string): string[] {
  const value = object[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) refuse(`docker info ${key} is malformed`);
  return value as string[];
}

interface EngineFacts {
  dockerId: string;
  cgroupDriver: CalibrationHostBinding["cgroupDriver"];
  ociArchitecture: string;
}

/** `docker info` against the pinned endpoint: same-host native Linux daemon on cgroup v2. */
function inspectEngine(probes: CalibrationHostProbes, env: NodeJS.ProcessEnv, endpoint: string): EngineFacts {
  const info = parseJsonObject(docker(probes, ["--host", endpoint, "info", "--format", "{{json .}}"], env, "docker info"), "docker info");
  const serverErrors = stringList(info, "ServerErrors");
  if (serverErrors.length > 0) refuse(`docker daemon at ${endpoint} is unreachable: ${serverErrors.join("; ").slice(0, 2000)}`);
  const dockerId = stringField(info, "ID", "docker info");
  const osType = stringField(info, "OSType", "docker info");
  if (osType !== "linux") refuse(`docker daemon runs ${osType} containers, not linux`);
  const operatingSystem = stringField(info, "OperatingSystem", "docker info");
  if (/docker desktop/i.test(operatingSystem)) {
    refuse(`docker daemon is ${operatingSystem} (a VM) — containers there cannot share this host's cgroup tree`);
  }
  if (stringList(info, "SecurityOptions").some((option) => option.split(",").includes("name=rootless"))) {
    refuse("docker daemon is rootless — its cgroup paths live under a user manager and do not match the nominated system parent");
  }
  const architecture = stringField(info, "Architecture", "docker info");
  if (architecture !== probes.machine) refuse(`docker daemon architecture ${architecture} differs from this host's ${probes.machine}; not the same machine`);
  const kernel = stringField(info, "KernelVersion", "docker info");
  if (kernel !== probes.kernelRelease) refuse(`docker daemon kernel ${kernel} differs from this host's ${probes.kernelRelease}; not the same kernel`);
  const name = stringField(info, "Name", "docker info");
  if (name !== probes.hostname) refuse(`docker daemon hostname ${name} differs from this host's ${probes.hostname}; the daemon is not native to this host`);
  const cgroupVersion = stringField(info, "CgroupVersion", "docker info");
  if (cgroupVersion !== "2") refuse(`docker daemon uses cgroup v${cgroupVersion}; only cgroup v2 aggregates are supported`);
  const driver = stringField(info, "CgroupDriver", "docker info");
  if (driver !== "systemd" && driver !== "cgroupfs") refuse(`docker cgroup driver ${driver} is not systemd or cgroupfs`);
  const ociArchitecture = OCI_ARCHITECTURE[probes.machine];
  if (ociArchitecture === undefined) refuse(`host architecture ${probes.machine} has no supported image architecture mapping`);
  return { dockerId, cgroupDriver: driver, ociArchitecture };
}

/** `docker image inspect` of the exact pinned reference: local, linux, native architecture. */
function inspectImage(probes: CalibrationHostProbes, env: NodeJS.ProcessEnv, endpoint: string, image: string, ociArchitecture: string): string {
  const inspected = parseJsonObject(
    docker(probes, ["--host", endpoint, "image", "inspect", "--format", "{{json .}}", image], env, `docker image inspect ${image}`),
    "docker image inspect",
  );
  const imageId = stringField(inspected, "Id", "docker image inspect");
  if (!IMAGE_ID_RE.test(imageId)) refuse(`docker image inspect Id ${imageId} is not a sha256 image id`);
  const os = stringField(inspected, "Os", "docker image inspect");
  if (os !== "linux") refuse(`image ${image} is a ${os} image, not linux`);
  const architecture = stringField(inspected, "Architecture", "docker image inspect");
  if (architecture !== ociArchitecture) {
    refuse(`image ${image} is built for ${architecture}, not this host's native ${ociArchitecture}; emulated execution is not a calibration host`);
  }
  if (!stringList(inspected, "RepoDigests").includes(image)) {
    refuse(`local image ${imageId} does not carry the pinned digest reference ${image} in RepoDigests`);
  }
  return imageId;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Observe the current native host and prove the nominated cgroup parent
 * bounds this supervisor and every Docker child it will create under the
 * pinned image. Throws UsageError with the first refusal; never falls back.
 * Callers hold the returned binding in the plan and require canonical
 * equality with a fresh inspection before each dispatch.
 */
export function inspectCalibrationHost(
  image: string,
  cgroupParent: string,
  env: NodeJS.ProcessEnv,
  probes: CalibrationHostProbes = NATIVE_CALIBRATION_HOST_PROBES,
): CalibrationHostBinding {
  if (probes.platform !== "linux") {
    refuse(`platform ${probes.platform} has no native cgroup-v2 hierarchy; calibration requires a native Linux host (no VM, no Docker Desktop)`);
  }
  if (!IMAGE_DIGEST_REF.test(image)) refuse(`image ${JSON.stringify(image)} is not an exact name@sha256 digest reference`);
  try {
    parseSandboxCgroupParent(cgroupParent, "calibration host");
  } catch (error) {
    refuse(errorMessage(error));
  }
  assertUnifiedHierarchy(probes);
  let bootId: string;
  try {
    bootId = probes.bootId();
  } catch (error) {
    refuse(errorMessage(error));
  }
  const endpoint = resolveLocalEndpoint(probes, env);
  const dockerEnv: NodeJS.ProcessEnv = { ...pick(env, ["PATH", "HOME", "TMPDIR"]), DOCKER_HOST: endpoint };
  const engine = inspectEngine(probes, dockerEnv, endpoint);
  const parent = inspectParent(probes, cgroupParent, engine.cgroupDriver);
  const imageId = inspectImage(probes, dockerEnv, endpoint, image, engine.ociArchitecture);
  return {
    cgroupParent,
    cgroupPath: parent.cgroupPath,
    cgroupDriver: engine.cgroupDriver,
    bootId,
    dockerId: engine.dockerId,
    imageId,
    architecture: engine.ociArchitecture,
    memoryBytes: parent.memoryBytes,
    cpuQuota: parent.cpuQuota,
    cpuPeriod: parent.cpuPeriod,
  };
}
