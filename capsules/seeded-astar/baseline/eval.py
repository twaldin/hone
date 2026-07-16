#!/usr/bin/env python3
"""Trusted evaluator for the seeded-astar capsule.

Runs from the FROZEN baseline (`/trusted/baseline`, this file's directory)
under isolated Python (`python3 -I -B eval.py`). Candidate code is NEVER
imported into this process: every candidate call happens in a narrow worker
subprocess (worker.py) that imports astar.py from $CAPSULE_WORKSPACE
(default /workspace) and exchanges newline-delimited JSON over pipes.

Authority split (the point of the design):
  * parent (this process) alone loads fixtures, measures wall-clock time
    around each pipe round-trip, validates paths, computes objectives /
    constraints / feedback, and serializes the single EvaluatorOutput line on
    stdout;
  * the worker child returns only raw answer cells — a compromised child can
    at worst return wrong/instant answers, which the parent scores on its own
    clock against its own fixtures.

Fail-closed protocol handling: per-request random nonce must be echoed;
timeouts, worker death, oversized responses, extra bytes, or id mismatches
kill the worker's process group, score that call 0, and respawn for the next.

Correctness constraint: the former candidate-side pytest run is replaced by a
trusted mechanical suite (embedded mazes + BFS reference) driven through the
same worker boundary — candidate conftest.py / pytest.ini / plugins / shadow
modules have no authority here.

Scoring (per example):
  correctness = 0                       crash, timeout, protocol violation,
                                        no path, or invalid path
              = (optimal / actual)**4   valid path
  score       = correctness / (1 + slowest_of_5_ms)

Timing isolation: each of the 5 timed repetitions runs in a FRESH worker
process (spawned and handshaken before the clock starts), with a fresh Linux
network and SysV/POSIX IPC namespace. Before and after each repetition the
trusted parent kills every candidate-uid process and clears candidate-writable
files. A hard one-process uid limit blocks fork/thread daemons. The slowest
repetition has scoring authority, so shared host page-cache residency cannot
turn one real computation plus four cache hits into an artificial win. The
per-request nonce authenticates each response.

Objectives (higher is better — the trusted scalarization is the mean of
objective values): score = mean per-example score.
Diagnostics (informational): runtime_ms (median of per-example slowest
repetitions), quality (mean correctness).

Hard optimality gate: `valid` is true ONLY when mazes were loaded, the
trusted suite passed, AND every selected asset response is a valid path of
exactly optimal_length (constraint `paths_optimal`). A fast candidate that
aces the fixed suite but returns even one suboptimal asset path is
promotion-ineligible regardless of its raw score; the per-example scores and
feedback above are still reported in full as diagnostics for such outputs.

Environment (all trusted-runtime supplied):
  CAPSULE_ASSETS               fixture dir            (default /capsule/assets)
  CAPSULE_WORKSPACE            candidate artifact dir (default /workspace)
  CAPSULE_CALL_TIMEOUT_SEC     per-call wall limit    (default 10)
  CAPSULE_MAX_RESPONSE_BYTES   per-response cap       (default 8000000)
  CAPSULE_WORKER_UID           uid for the worker when running as root
                               (default 2000, the image's `sandbox` user)

stdlib only. Runs the candidate only via worker.py.
"""

from __future__ import annotations

import ctypes
import errno
import json
import os
import random
import resource
import secrets
import selectors
import shutil
import signal
import statistics
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
INNER_REPS = 5

CALL_TIMEOUT_SEC = float(os.environ.get("CAPSULE_CALL_TIMEOUT_SEC", "10"))
MAX_RESPONSE_BYTES = int(os.environ.get("CAPSULE_MAX_RESPONSE_BYTES", "8000000"))
WORKER_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))

# The production evaluator is an isolated Linux container. These are its only
# candidate-writable persistent namespaces: the workspace/baseline/rootfs are
# read-only and the network is disabled. Host-side unit tests run non-root and
# deliberately skip global namespace cleanup; the real-container regression
# exercises this production list.
CANDIDATE_WRITABLE_ROOTS = (Path("/tmp"), Path("/dev/shm"), Path("/dev/mqueue"))
PR_SET_CHILD_SUBREAPER = 36
IPC_RMID = 0
CLONE_NEWIPC = 0x08000000
CLONE_NEWNET = 0x40000000
STATE_RESET_TIMEOUT_SEC = 1.0
_LIBC = ctypes.CDLL(None, use_errno=True)


def _configure_candidate_subreaper() -> None:
    """Make orphaned candidate descendants observable by the trusted scorer."""
    if not sys.platform.startswith("linux"):
        return
    if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f"cannot become candidate subreaper: {os.strerror(code)}")


def _candidate_pids() -> list[int]:
    """Return every live process running under the dedicated candidate uid."""
    proc = Path("/proc")
    if not proc.is_dir() or os.geteuid() != 0:
        return []
    found: list[int] = []
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        for line in status.splitlines():
            if line.startswith("Uid:"):
                fields = line.split()
                if len(fields) >= 2 and int(fields[1]) == WORKER_UID:
                    found.append(int(entry.name))
                break
    return found


def _reap_candidate_processes() -> None:
    """Atomically enough for the bounded uid namespace: kill, reap, prove empty."""
    if os.geteuid() != 0:
        return
    deadline = time.monotonic() + STATE_RESET_TIMEOUT_SEC
    while True:
        pids = _candidate_pids()
        if not pids:
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == 0:
                    break
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                break
        if time.monotonic() >= deadline:
            raise RuntimeError(f"candidate processes survived reset: {pids}")
        time.sleep(0.005)


def _remove_tree_contents(root: Path) -> None:
    """Clear one writable namespace without following candidate symlinks."""
    if not root.is_dir():
        return
    for entry in os.scandir(root):
        path = Path(entry.path)
        if entry.is_dir(follow_symlinks=False):
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)


def _remove_candidate_sysv_ipc() -> None:
    """Remove uid-owned SysV objects that otherwise outlive worker processes."""
    if os.geteuid() != 0:
        return
    specs = (
        ("shm", "shmid", lambda ident: _LIBC.shmctl(ident, IPC_RMID, None)),
        ("msg", "msqid", lambda ident: _LIBC.msgctl(ident, IPC_RMID, None)),
        ("sem", "semid", lambda ident: _LIBC.semctl(ident, 0, IPC_RMID)),
    )
    for table, id_column, remove in specs:
        source = Path("/proc/sysvipc") / table
        try:
            rows = source.read_text().splitlines()
        except FileNotFoundError:
            continue
        if not rows:
            continue
        columns = rows[0].split()
        try:
            id_index = columns.index(id_column)
            uid_index = columns.index("uid")
        except ValueError as exc:
            raise RuntimeError(f"unrecognized {source} header") from exc
        for row in rows[1:]:
            fields = row.split()
            if len(fields) <= max(id_index, uid_index) or int(fields[uid_index]) != WORKER_UID:
                continue
            ident = int(fields[id_index])
            ctypes.set_errno(0)
            if remove(ident) == 0:
                continue
            code = ctypes.get_errno()
            if code not in (errno.EINVAL, errno.EIDRM):
                raise RuntimeError(
                    f"cannot remove candidate SysV {table} {ident}: {os.strerror(code)}"
                )


def reset_candidate_state() -> None:
    """Prove no process or writable namespace survives into another repetition."""
    _reap_candidate_processes()
    if os.geteuid() != 0:
        return
    for root in CANDIDATE_WRITABLE_ROOTS:
        _remove_tree_contents(root)
    _remove_candidate_sysv_ipc()


# --------------------------------------------------------------------------
# Trusted references
# --------------------------------------------------------------------------

def bfs_shortest(grid: list[str], start: tuple[int, int], goal: tuple[int, int]) -> int | None:
    """Shortest 4-connected path cell count (endpoints inclusive), or None."""
    h, w = len(grid), len(grid[0])
    dist = {start: 1}
    q = deque([start])
    while q:
        r, c = q.popleft()
        if (r, c) == goal:
            return dist[(r, c)]
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < h and 0 <= nc < w and grid[nr][nc] != "#" and (nr, nc) not in dist:
                dist[(nr, nc)] = dist[(r, c)] + 1
                q.append((nr, nc))
    return None


def path_is_valid(grid: list[str], start: list[int], goal: list[int], path) -> bool:
    if not isinstance(path, list) or len(path) == 0:
        return False
    h, w = len(grid), len(grid[0])
    try:
        cells = [(int(r), int(c)) for r, c in path]
    except (TypeError, ValueError):
        return False
    if cells[0] != tuple(start) or cells[-1] != tuple(goal):
        return False
    for r, c in cells:
        if not (0 <= r < h and 0 <= c < w) or grid[r][c] == "#":
            return False
    for (r1, c1), (r2, c2) in zip(cells, cells[1:]):
        if abs(r1 - r2) + abs(c1 - c2) != 1:
            return False
    return True


# --------------------------------------------------------------------------
# Worker supervision
# --------------------------------------------------------------------------

class CallOutcome:
    __slots__ = ("elapsed_ms", "path", "error")

    def __init__(self, elapsed_ms: float, path, error: str | None) -> None:
        self.elapsed_ms = elapsed_ms
        self.path = path
        self.error = error


def _worker_preexec() -> None:
    for limit, value in (
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_AS, 4 << 30),
    ):
        try:
            resource.setrlimit(limit, (value, value))
        except (OSError, ValueError):
            pass  # best-effort (e.g. RLIMIT_AS is unsupported on macOS)
    if os.geteuid() == 0:
        # Each timed repetition owns fresh kernel communication namespaces.
        # Otherwise a worker can encode a result in loopback TCP TIME_WAIT or
        # abstract Unix sockets and make four later repetitions look cached.
        # This is mandatory: the evaluator container grants SYS_ADMIN only to
        # this trusted root parent, before the candidate uid/capability drop.
        if _LIBC.unshare(CLONE_NEWNET | CLONE_NEWIPC) != 0:
            code = ctypes.get_errno()
            raise RuntimeError(
                f"cannot isolate candidate network/IPC namespaces: {os.strerror(code)}"
            )
        # One candidate process, no threads/forks. This is mandatory in the
        # production root-side evaluator; cleanup is defense in depth rather
        # than a race against a daemon that can keep reproducing.
        resource.setrlimit(resource.RLIMIT_NPROC, (1, 1))
        # Privilege separation: scorer stays root-side, candidate drops to an
        # unprivileged uid that cannot signal/ptrace the parent. MUST succeed
        # when we are root — a failure aborts the spawn (fail closed).
        os.setgroups([])
        os.setgid(WORKER_UID)
        os.setuid(WORKER_UID)


class Worker:
    """One candidate worker process behind the narrow JSON-line protocol."""

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.proc: subprocess.Popen | None = None
        self.buffer = b""
        self.import_error: str | None = None

    def ensure(self) -> bool:
        """Worker alive and handshaken. False = candidate import failed."""
        if self.proc is not None and self.proc.poll() is None:
            return self.import_error is None
        self.buffer = b""
        try:
            self.proc = subprocess.Popen(
                [sys.executable, "-I", "-B", str(WORKER), str(self.workspace)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                preexec_fn=_worker_preexec,
                cwd=str(TRUSTED_DIR),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            self.proc = None
            self.import_error = f"worker spawn failed: {exc}"
            return False
        line, violation = self._read_line(time.monotonic() + CALL_TIMEOUT_SEC)
        if violation is not None or line is None:
            self.import_error = violation or "worker produced no handshake"
            self.kill()
            return False
        try:
            ready = json.loads(line)
        except ValueError:
            self.import_error = "malformed handshake"
            self.kill()
            return False
        if not (isinstance(ready, dict) and ready.get("ready") is True):
            err = ready.get("error") if isinstance(ready, dict) else None
            self.import_error = str(err or "candidate import failed")
            self.kill()
            return False
        self.import_error = None
        return True

    def kill(self) -> None:
        if self.proc is None:
            return
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        self.proc.wait()
        self.proc = None
        self.buffer = b""

    def _read_line(self, deadline: float) -> tuple[bytes | None, str | None]:
        """One protocol line by `deadline`. Returns (line, violation)."""
        assert self.proc is not None and self.proc.stdout is not None
        fd = self.proc.stdout.fileno()
        os.set_blocking(fd, False)
        sel = selectors.DefaultSelector()
        sel.register(fd, selectors.EVENT_READ)
        try:
            while b"\n" not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None, f"timeout after {CALL_TIMEOUT_SEC:g}s"
                if not sel.select(remaining):
                    continue
                chunk = os.read(fd, 65536)
                if chunk == b"":
                    return None, "worker died mid-call"
                self.buffer += chunk
                if len(self.buffer) > MAX_RESPONSE_BYTES:
                    return None, f"response exceeded {MAX_RESPONSE_BYTES} bytes"
            line, _, rest = self.buffer.partition(b"\n")
            self.buffer = rest
            return line, None
        finally:
            sel.close()

    def call(self, grid: list[str], start: list[int], goal: list[int]) -> CallOutcome:
        """One timed candidate invocation; fail-closed on protocol anomalies."""
        if not self.ensure():
            return CallOutcome(0.0, None, f"candidate import failed: {self.import_error}")
        assert self.proc is not None and self.proc.stdin is not None
        nonce = secrets.token_hex(8)
        request = (
            json.dumps(
                {"id": nonce, "grid": grid, "start": start, "goal": goal},
                separators=(",", ":"),
            )
            + "\n"
        ).encode()

        t0 = time.perf_counter()
        try:
            self.proc.stdin.write(request)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            self.kill()
            return CallOutcome(0.0, None, "worker died before call")
        line, violation = self._read_line(time.monotonic() + CALL_TIMEOUT_SEC)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0

        if violation is not None or line is None:
            self.kill()
            return CallOutcome(elapsed_ms, None, violation or "no response")
        if self.buffer:
            # Extra unsolicited bytes after the response line: forged/sprayed
            # protocol traffic. Fail the call, not just the leftovers.
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: extra data after response")
        try:
            response = json.loads(line)
        except ValueError:
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: unparseable response")
        if not isinstance(response, dict) or response.get("id") != nonce:
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: response id mismatch")
        if "error" in response:
            return CallOutcome(elapsed_ms, None, str(response["error"]))
        if "path" not in response:
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: no path field")
        return CallOutcome(elapsed_ms, response["path"], None)


# --------------------------------------------------------------------------
# Trusted mechanical correctness suite (replaces candidate-side pytest)
# --------------------------------------------------------------------------

def _random_maze(seed: int, size: int, density: float = 0.25):
    rng = random.Random(seed)
    while True:
        grid = [
            "".join("#" if rng.random() < density else "." for _ in range(size))
            for _ in range(size)
        ]
        rows = [list(row) for row in grid]
        rows[0][0] = "."
        rows[-1][-1] = "."
        grid = ["".join(r) for r in rows]
        if bfs_shortest(grid, (0, 0), (size - 1, size - 1)) is not None:
            return grid, [0, 0], [size - 1, size - 1]


def _suite_cases() -> list[tuple[str, list[str], list[int], list[int], bool]]:
    """(label, grid, start, goal, solvable) — mirrors the dev pytest suite."""
    cases: list[tuple[str, list[str], list[int], list[int], bool]] = [
        ("open3", ["...", "...", "..."], [0, 0], [2, 2], True),
        ("ring4", ["....", ".##.", ".##.", "...."], [0, 0], [3, 3], True),
        ("hook3", [".#.", ".#.", "..."], [0, 0], [0, 2], True),
        ("snake6", ["......", "#####.", "......", ".#####", "......"], [0, 0], [4, 5], True),
        ("blocked", ["...", "###", "..."], [0, 0], [2, 2], False),
        ("walled-start", ["#..", "...", "..#"], [0, 0], [1, 1], False),
        ("walled-goal", ["#..", "...", "..#"], [1, 1], [2, 2], False),
    ]
    for seed, size in ((1, 12), (2, 16), (3, 20), (4, 28), (5, 34), (6, 40)):
        grid, start, goal = _random_maze(seed, size)
        cases.append((f"rand{size}", grid, start, goal, True))
    return cases


def run_trusted_suite(worker: Worker) -> tuple[bool, str]:
    """All-or-nothing mechanical checks through the worker boundary."""
    for label, grid, start, goal, solvable in _suite_cases():
        outcome = worker.call(grid, start, goal)
        if outcome.error is not None:
            return False, f"{label}: {outcome.error}"
        if not solvable:
            if outcome.path is not None:
                return False, f"{label}: expected no path"
            continue
        if not path_is_valid(grid, start, goal, outcome.path):
            return False, f"{label}: invalid path"
        optimal = bfs_shortest(grid, tuple(start), tuple(goal))
        if len(outcome.path) != optimal:
            return False, f"{label}: path len {len(outcome.path)} != optimal {optimal}"
    return True, "all checks passed"


# --------------------------------------------------------------------------
# Example scoring
# --------------------------------------------------------------------------

def evaluate_example(workspace: Path, maze: dict) -> tuple[float, float, bool, dict]:
    """Returns (slowest_ms, correctness, optimal_ok, perExample entry).

    Every repetition gets its own worker process and a clean writable/IPC
    namespace. Worker.call() completes the spawn + import handshake BEFORE
    starting the request clock, so process startup never pollutes the
    measurement. The slowest repetition defeats cross-process page-cache
    channels that can accelerate only calls after the first real computation.
    """
    reps: list[float] = []
    outcomes: list[CallOutcome] = []
    for _ in range(INNER_REPS):
        reset_candidate_state()
        worker = Worker(workspace)
        try:
            outcome = worker.call(maze["grid"], maze["start"], maze["goal"])
        finally:
            try:
                worker.kill()
            finally:
                reset_candidate_state()
        outcomes.append(outcome)
        reps.append(outcome.elapsed_ms)
        if outcome.error is not None:
            break  # a failing call is not re-run
    assert outcomes
    slowest_ms = max(reps)
    optimal = maze["optimal_length"]

    # Every timed response has scoring authority. Inspecting only the final
    # response lets an ordinal-aware candidate answer the middle repetitions
    # incorrectly and retain their near-zero timings in the median.
    error_rep = next(
        ((index, item) for index, item in enumerate(outcomes, 1) if item.error is not None),
        None,
    )
    missing_rep = next(
        ((index, item) for index, item in enumerate(outcomes, 1) if item.path is None),
        None,
    )
    invalid_rep = next(
        (
            (index, item)
            for index, item in enumerate(outcomes, 1)
            if item.path is not None
            and not path_is_valid(maze["grid"], maze["start"], maze["goal"], item.path)
        ),
        None,
    )
    suboptimal_rep = next(
        (
            (index, item)
            for index, item in enumerate(outcomes, 1)
            if item.path is not None
            and path_is_valid(maze["grid"], maze["start"], maze["goal"], item.path)
            and len(item.path) != optimal
        ),
        None,
    )

    optimal_ok = False
    if error_rep is not None:
        index, item = error_rep
        correctness = 0.0
        feedback = f"rep {index}: error: {item.error} in slowest {slowest_ms:.2f} ms"
    elif missing_rep is not None:
        index, _ = missing_rep
        correctness = 0.0
        feedback = f"rep {index}: no path found (optimal {optimal}) in slowest {slowest_ms:.2f} ms"
    elif invalid_rep is not None:
        index, _ = invalid_rep
        correctness = 0.0
        feedback = f"rep {index}: invalid path (optimal {optimal}) in slowest {slowest_ms:.2f} ms"
    elif suboptimal_rep is not None:
        index, item = suboptimal_rep
        correctness = (optimal / len(item.path)) ** 4
        feedback = (
            f"rep {index}: suboptimal path (len {len(item.path)} vs optimal {optimal})"
            f" in slowest {slowest_ms:.2f} ms — hard optimality constraint failed"
        )
    else:
        correctness = 1.0
        feedback = f"all {len(outcomes)} reps returned optimal len {optimal} in slowest {slowest_ms:.2f} ms"
        optimal_ok = len(outcomes) == INNER_REPS

    score = correctness / (1.0 + slowest_ms)
    return slowest_ms, correctness, optimal_ok, {"score": score, "feedback": feedback}


def main() -> None:
    _configure_candidate_subreaper()
    reset_candidate_state()
    assets_dir = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
    workspace = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
    mazes = [json.loads(p.read_text()) for p in sorted(assets_dir.rglob("*.json"))]

    per_example: dict[str, dict] = {}
    runtimes: list[float] = []
    correctnesses: list[float] = []
    optimal_flags: list[bool] = []
    for maze in mazes:
        slowest_ms, correctness, optimal_ok, entry = evaluate_example(workspace, maze)
        per_example[maze["id"]] = entry
        runtimes.append(slowest_ms)
        correctnesses.append(correctness)
        optimal_flags.append(optimal_ok)

    reset_candidate_state()
    suite_worker = Worker(workspace)
    try:
        tests_pass, suite_detail = run_trusted_suite(suite_worker)
    finally:
        try:
            suite_worker.kill()
        finally:
            reset_candidate_state()
    paths_optimal = len(mazes) > 0 and all(optimal_flags)

    output = {
        "valid": len(mazes) > 0 and tests_pass and paths_optimal,
        "objectives": {
            "score": statistics.fmean(
                [entry["score"] for entry in per_example.values()]
            )
            if per_example
            else 0.0,
        },
        "constraints": {"tests_pass": tests_pass, "paths_optimal": paths_optimal},
        "perExample": per_example,
        "diagnostics": {
            "summary": (
                f"{len(mazes)} mazes from {assets_dir}; candidate {workspace};"
                f" trusted suite: {suite_detail}"
            ),
            "runtime_ms": statistics.median(runtimes) if runtimes else 0.0,
            "quality": statistics.fmean(correctnesses) if correctnesses else 0.0,
        },
    }
    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
