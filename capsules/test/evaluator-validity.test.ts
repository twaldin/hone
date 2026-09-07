import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EvaluatorOutput } from "@hone/schema";
import { afterEach, describe, expect, it } from "vitest";

const CAPSULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASK_DIR = join(CAPSULE_DIR, "seeded-astar");
const BASELINE_DIR = join(TASK_DIR, "baseline");
const EVALUATOR = join(BASELINE_DIR, "eval.py");
const TRAIN_ASSETS = join(TASK_DIR, "assets", "train");
const PROCESS_TIMEOUT_MS = 60_000;
const EVALUATOR_IMAGE =
  "hone-mutation@sha256:f680ddc7c1d5facfec0cce238784ab459bc4d54221e64a262101f20d575252f7";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeWorkspace(astarSource: { file: string } | { code: string }): string {
  const root = mkdtempSync(join(tmpdir(), "hone-evaluator-validity-"));
  temporaryRoots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  if ("file" in astarSource) copyFileSync(astarSource.file, join(workspace, "astar.py"));
  else writeFileSync(join(workspace, "astar.py"), astarSource.code);
  return workspace;
}

/** One tiny solvable maze (optimal length 3) for fast adversary regressions. */
function makeTinyAssets(): string {
  const root = mkdtempSync(join(tmpdir(), "hone-evaluator-validity-assets-"));
  temporaryRoots.push(root);
  writeFileSync(
    join(root, "tiny.json"),
    JSON.stringify({
      id: "tiny",
      grid: ["..", ".."],
      start: [0, 0],
      goal: [1, 1],
      optimal_length: 3,
    }),
  );
  return root;
}

function runEvaluator(workspace: string, assets: string): EvaluatorOutput {
  const result = spawnSync("python3", ["-I", "-B", EVALUATOR], {
    cwd: BASELINE_DIR,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    env: {
      ...process.env,
      CAPSULE_WORKSPACE: workspace,
      CAPSULE_ASSETS: assets,
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  const lines = result.stdout.slice(0, -1).split("\n");
  expect(lines).toHaveLength(1);
  return EvaluatorOutput.parse(JSON.parse(lines[0] ?? ""));
}

function containerArgsFor(candidate: string): string[] {
  const workspace = makeWorkspace({ code: candidate });
  const assets = makeTinyAssets();
  chmodSync(workspace, 0o755);
  chmodSync(join(workspace, "astar.py"), 0o644);
  chmodSync(assets, 0o755);
  chmodSync(join(assets, "tiny.json"), 0o644);
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--network",
    "none",
    "--pids-limit",
    "64",
    "--memory",
    "512m",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "KILL",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "IPC_OWNER",
    "--cap-add",
    "SYS_ADMIN",
    "--read-only",
    "--tmpfs",
    "/tmp:size=16m,nosuid,nodev,noexec",
    "--shm-size",
    "16m",
    "--tmpfs",
    "/capsule:mode=0700,size=1m",
    "--user",
    "0:0",
    "-w",
    "/trusted/baseline",
    "-v",
    `${workspace}:/workspace:ro`,
    "-v",
    `${BASELINE_DIR}:/trusted/baseline:ro`,
    "-v",
    `${assets}:/capsule/assets:ro`,
    EVALUATOR_IMAGE,
    "/bin/sh",
    "-c",
    "cat /usr/lib/python3.11/os.py >/dev/null && exec python3 -I -B eval.py",
  ];
}

function parseEvaluatorOutput(stdout: string): EvaluatorOutput {
  const lines = stdout.slice(0, -1).split("\n");
  expect(lines).toHaveLength(1);
  return EvaluatorOutput.parse(JSON.parse(lines[0] ?? ""));
}

function runContainerEvaluator(candidate: string): EvaluatorOutput {
  const result = spawnSync("docker", containerArgsFor(candidate), {
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return parseEvaluatorOutput(result.stdout);
}

/** Same container contract as runContainerEvaluator, awaitable so two evaluator containers can genuinely overlap. */
async function runContainerEvaluatorAsync(candidate: string): Promise<EvaluatorOutput> {
  const child = spawn("docker", containerArgsFor(candidate), {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 150_000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [status, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  expect(signal).toBeNull();
  expect(status, stderr).toBe(0);
  return parseEvaluatorOutput(stdout);
}

describe("seeded-astar evaluator hard optimality gate", () => {
  it(
    "keeps the baseline eligible and refuses a fast suite-acing suboptimal probe",
    { timeout: 180_000 },
    () => {
      const baseline = runEvaluator(
        makeWorkspace({ file: join(BASELINE_DIR, "astar.py") }),
        TRAIN_ASSETS,
      );
      expect(baseline.valid).toBe(true);
      expect(baseline.constraints["tests_pass"]).toBe(true);
      expect(baseline.constraints["paths_optimal"]).toBe(true);
      expect(baseline.diagnostics?.["quality"]).toBe(1);
      expect(baseline.objectives["score"]).toBeGreaterThan(0);

      // The probe passes the fixed trusted suite (its detour only fires on
      // asset-scale grids) and is FASTER than the baseline — raw score
      // potential above the baseline's — yet every asset response is
      // optimal+2, so the hard constraint makes the whole output
      // promotion-ineligible (`valid:false` fails the broker's
      // eligibleAggregate gate regardless of objectives).
      const probe = runEvaluator(
        makeWorkspace({ file: join(TASK_DIR, "diagnostics", "suboptimal", "astar.py") }),
        TRAIN_ASSETS,
      );
      expect(probe.constraints["tests_pass"]).toBe(true);
      expect(probe.constraints["paths_optimal"]).toBe(false);
      expect(probe.valid).toBe(false);
      expect(probe.objectives["score"]).toBeGreaterThan(baseline.objectives["score"] ?? 0);
      for (const entry of Object.values(probe.perExample)) {
        expect(entry.score).toBeGreaterThan(0);
        expect(String(entry.feedback)).toContain("suboptimal path");
      }
    },
  );

  it(
    "denies a caching adversary an artificial median win (fresh worker per timed rep)",
    { timeout: 120_000 },
    () => {
      // Computes real optimal paths, but sleeps 50ms on the FIRST call for a
      // maze and answers repeats instantly from a module-level cache. With a
      // persistent worker the 5-rep median would be ~0ms; with per-rep worker
      // processes every rep pays the real cost.
      const adversary = `import time
from collections import deque

_CACHE = {}


def _solve(grid, start, goal):
    h, w = len(grid), len(grid[0])
    if grid[start[0]][start[1]] == "#" or grid[goal[0]][goal[1]] == "#":
        return None
    prev = {start: None}
    q = deque([start])
    while q:
        cur = q.popleft()
        if cur == goal:
            path = []
            while cur is not None:
                path.append(list(cur))
                cur = prev[cur]
            path.reverse()
            return path
        r, c = cur
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < h and 0 <= nc < w and grid[nr][nc] != "#" and (nr, nc) not in prev:
                prev[(nr, nc)] = cur
                q.append((nr, nc))
    return None


def find_path(grid, start, goal):
    key = (tuple(grid), tuple(start), tuple(goal))
    if key not in _CACHE:
        time.sleep(0.05)
        _CACHE[key] = _solve(grid, tuple(start), tuple(goal))
    return _CACHE[key]
`;
      const output = runEvaluator(makeWorkspace({ code: adversary }), makeTinyAssets());
      // Paths are genuinely optimal, so the output stays eligible...
      expect(output.valid).toBe(true);
      expect(output.constraints["tests_pass"]).toBe(true);
      expect(output.constraints["paths_optimal"]).toBe(true);
      // ...but the median reflects the true ~50ms cost on EVERY rep: the
      // cross-rep cache never gets a hit, so no artificial timing win.
      expect(output.diagnostics?.["runtime_ms"]).toBeGreaterThanOrEqual(40);
      expect(output.perExample["tiny"]?.score).toBeLessThanOrEqual(1 / (1 + 40));
    },
  );
});

describe("seeded-astar evaluator per-repetition kernel-state isolation", () => {
  const optimalSolver = `from collections import deque

def solve(grid, start, goal):
    start, goal = tuple(start), tuple(goal)
    if grid[start[0]][start[1]] == "#" or grid[goal[0]][goal[1]] == "#":
        return None
    prev = {start: None}
    queue = deque([start])
    while queue:
        current = queue.popleft()
        if current == goal:
            path = []
            while current is not None:
                path.append(list(current))
                current = prev[current]
            return list(reversed(path))
        row, col = current
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nxt = (row + dr, col + dc)
            if (0 <= nxt[0] < len(grid) and 0 <= nxt[1] < len(grid[0])
                    and grid[nxt[0]][nxt[1]] != "#" and nxt not in prev):
                prev[nxt] = current
                queue.append(nxt)
    return None
`;

  it(
    "clears /tmp and /dev/shm caches between fresh worker processes",
    { timeout: 180_000 },
    () => {
      const output = runContainerEvaluator(`${optimalSolver}
import json
import time

STATE_FILES = ("/tmp/hone-rep-cache.json", "/dev/shm/hone-rep-cache.json")

def find_path(grid, start, goal):
    key = json.dumps([grid, start, goal], separators=(",", ":"))
    for state_file in STATE_FILES:
        try:
            with open(state_file) as handle:
                cache = json.load(handle)
            if key in cache:
                return cache[key]
        except (FileNotFoundError, ValueError):
            pass
    time.sleep(0.05)
    result = solve(grid, start, goal)
    for state_file in STATE_FILES:
        with open(state_file, "w") as handle:
            json.dump({key: result}, handle)
    return result
`);

      expect(output.valid, JSON.stringify(output)).toBe(true);
      expect(output.constraints["paths_optimal"]).toBe(true);
      expect(output.diagnostics?.["runtime_ms"]).toBeGreaterThanOrEqual(40);
      expect(output.perExample["tiny"]?.score).toBeLessThanOrEqual(1 / (1 + 40));
    },
  );

  it(
    "charges the slowest repetition when page-cache residency carries a result",
    { timeout: 180_000 },
    () => {
      const output = runContainerEvaluator(`${optimalSolver}
import ctypes
import mmap
import os
import time

_CARRIER = "/usr/lib/python3.11/os.py"
_PAGE = os.sysconf("SC_PAGE_SIZE")
_LIBC = ctypes.CDLL(None, use_errno=True)
_LIBC.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_ubyte)]
_LIBC.mincore.restype = ctypes.c_int
_LIBC.posix_fadvise.argtypes = [ctypes.c_int, ctypes.c_longlong, ctypes.c_longlong, ctypes.c_int]
_LIBC.posix_fadvise.restype = ctypes.c_int

def marker_is_evicted():
    fd = os.open(_CARRIER, os.O_RDONLY)
    try:
        size = os.fstat(fd).st_size
        length = size
        pages = (size + _PAGE - 1) // _PAGE
        view = mmap.mmap(fd, length, access=mmap.ACCESS_COPY)
        try:
            backing = (ctypes.c_char * length).from_buffer(view)
            residency = (ctypes.c_ubyte * pages)()
            if _LIBC.mincore(ctypes.addressof(backing), length, residency) != 0:
                raise OSError(ctypes.get_errno(), "mincore")
            return residency[-1] & 1 == 0
        finally:
            del backing
            view.close()
    finally:
        os.close(fd)

def evict_marker():
    fd = os.open(_CARRIER, os.O_RDONLY)
    try:
        size = os.fstat(fd).st_size
        offset = ((size - 1) // _PAGE) * _PAGE
        if _LIBC.posix_fadvise(fd, offset, _PAGE, 4) != 0:
            raise OSError("posix_fadvise")
    finally:
        os.close(fd)

def find_path(grid, start, goal):
    if len(grid) == 2 and marker_is_evicted():
        return solve(grid, start, goal)
    if len(grid) == 2:
        time.sleep(0.05)
        result = solve(grid, start, goal)
        evict_marker()
        return result
    return solve(grid, start, goal)
`);

      expect(output.valid, JSON.stringify(output)).toBe(true);
      expect(output.constraints["paths_optimal"]).toBe(true);
      expect(output.diagnostics?.["runtime_ms"]).toBeGreaterThanOrEqual(40);
      expect(output.perExample["tiny"]?.score).toBeLessThanOrEqual(1 / (1 + 40));
    },
  );

  it(
    "isolates loopback TCP state between timed repetitions",
    { timeout: 180_000 },
    () => {
      const output = runContainerEvaluator(`${optimalSolver}
import errno
import socket
import time

MARKER_PORT = 45321

def marker_exists():
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", MARKER_PORT))
    except OSError as exc:
        probe.close()
        return exc.errno == errno.EADDRINUSE
    probe.close()
    return False

def leave_time_wait_marker():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    accepted = None
    try:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        client.bind(("127.0.0.1", MARKER_PORT))
        client.connect(listener.getsockname())
        accepted, _ = listener.accept()
        client.shutdown(socket.SHUT_WR)
        accepted.recv(1)
    except OSError:
        pass
    finally:
        if accepted is not None:
            accepted.close()
        client.close()
        listener.close()

def find_path(grid, start, goal):
    if len(grid) == 2:
        if marker_exists():
            return solve(grid, start, goal)
        time.sleep(0.05)
        leave_time_wait_marker()
    return solve(grid, start, goal)
`);

      expect(output.valid, JSON.stringify(output)).toBe(true);
      expect(output.constraints["paths_optimal"]).toBe(true);
      expect(output.diagnostics?.["runtime_ms"]).toBeGreaterThanOrEqual(40);
      expect(output.perExample["tiny"]?.score).toBeLessThanOrEqual(1 / (1 + 40));
    },
  );

  it(
    "lets a candidate fork setsid daemons but no descendant survives a repetition or taints the next",
    { timeout: 180_000 },
    () => {
      // There is deliberately NO per-uid process quota (RLIMIT_NPROC is
      // accounted per real uid kernel-wide, so it would couple unrelated
      // concurrent evaluator containers). Containment is structural: the
      // worker is pid-namespace init, so killing it at the repetition
      // boundary kernel-kills every descendant, and cleanup clears /tmp.
      // The candidate proves the fork+setsid SUCCEEDED (a daemon heartbeat
      // appears), then a later repetition proves no daemon (nor its
      // heartbeat) survived — any leak returns None and flips valid:false.
      const output = runContainerEvaluator(`${optimalSolver}
import os
import subprocess
import sys
import time

MARKER = "/tmp/hone-daemon-heartbeat"
DAEMON = "import time\\nwhile True: open('/tmp/hone-daemon-heartbeat', 'w').write('x'); time.sleep(0.002)"

def find_path(grid, start, goal):
    if len(grid) != 2:
        return solve(grid, start, goal)
    time.sleep(0.03)  # a survivor from an earlier repetition rewrites every 2ms
    if os.path.exists(MARKER):
        return None  # descendant (or its residue) leaked across the boundary
    try:
        subprocess.Popen([sys.executable, "-c", DAEMON], start_new_session=True)
    except OSError:
        return None  # fork denied: the removed per-uid quota behavior
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and not os.path.exists(MARKER):
        time.sleep(0.005)
    if not os.path.exists(MARKER):
        return None  # daemon never ran, so nothing was actually contained
    return solve(grid, start, goal)
`);

      expect(output.valid, JSON.stringify(output)).toBe(true);
      expect(output.constraints["tests_pass"]).toBe(true);
      expect(output.constraints["paths_optimal"]).toBe(true);
    },
  );

  it(
    "runs two evaluator containers concurrently without cross-container process-quota interference",
    { timeout: 300_000 },
    async () => {
      // Regression for the removed RLIMIT_NPROC: that quota is accounted per
      // REAL uid across every container sharing the kernel, so a cap on the
      // fixed candidate uid 2000 coupled unrelated concurrent evaluator
      // containers (EAGAIN on fork/setuid while a sibling's worker was
      // alive; the old one-process cap denied the fork below outright).
      // Each timed call forks a real child and sleeps 100ms so both
      // containers hold live candidate-uid processes through overlapping
      // windows; both runs must stay fully valid with every repetition
      // answered — process headroom comes from each container's own Docker
      // --pids-limit, never from a shared per-uid quota.
      const candidate = `${optimalSolver}
import subprocess
import time

def find_path(grid, start, goal):
    if len(grid) == 2:
        subprocess.run(["/bin/true"], check=True)  # a real fork+exec under concurrent load
        time.sleep(0.1)
    return solve(grid, start, goal)
`;
      const [first, second] = await Promise.all([
        runContainerEvaluatorAsync(candidate),
        runContainerEvaluatorAsync(candidate),
      ]);
      for (const output of [first, second]) {
        expect(output.valid, JSON.stringify(output)).toBe(true);
        expect(output.constraints["tests_pass"]).toBe(true);
        expect(output.constraints["paths_optimal"]).toBe(true);
        expect(String(output.perExample["tiny"]?.feedback)).toContain("all 5 reps");
        expect(output.diagnostics?.["runtime_ms"]).toBeGreaterThanOrEqual(80);
      }
    },
  );

  it(
    "rejects ordinal-dependent answers even when the final timed response is optimal",
    { timeout: 120_000 },
    () => {
      // Host-side run (non-root: no kernel namespace isolation or cleanup)
      // hands the adversary a perfect cross-repetition channel — a counter
      // file next to astar.py — so it knows exactly which repetition it is
      // in. Inside the hardened container that channel no longer exists;
      // the contract exercised here is the evaluator's: EVERY timed
      // response has scoring authority, so one instant wrong answer in a
      // middle repetition must invalidate the output even though the final
      // response is optimal and the slowest repetition is honest.
      const adversary = `${optimalSolver}
import os
import time

_COUNTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rep-counter")

def find_path(grid, start, goal):
    if len(grid) != 2:
        return solve(grid, start, goal)
    count = int(open(_COUNTER).read()) if os.path.exists(_COUNTER) else 0
    count += 1
    with open(_COUNTER, "w") as handle:
        handle.write(str(count))
    if count == 3:
        return None  # instant wrong answer in a middle repetition
    time.sleep(0.05)
    return solve(grid, start, goal)
`;
      const output = runEvaluator(makeWorkspace({ code: adversary }), makeTinyAssets());

      expect(output.valid).toBe(false);
      expect(output.constraints["tests_pass"]).toBe(true);
      expect(output.constraints["paths_optimal"]).toBe(false);
      expect(output.diagnostics?.["runtime_ms"]).toBeGreaterThanOrEqual(40);
      expect(String(output.perExample["tiny"]?.feedback)).toContain("no path found");
    },
  );
});
