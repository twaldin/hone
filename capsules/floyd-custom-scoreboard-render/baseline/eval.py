#!/usr/bin/env python3
"""Trusted frame-driven evaluator for the Floyd custom scoreboard capsule.

This root-side parent owns hidden fixtures, per-frame timing, allocation
accounting, equality, gates, and output. Frame repetitions are driven and
observed HERE, never inside candidate code: frame 0 of every repetition
seeds the frozen scene and is verified against the frozen expected render;
every measured frame applies deterministic trusted entry-value edits so its
exact draw stream is novel, and is verified against the sealed reference
renderer (shipped inside the holdout asset groups, staged under the
root-only /capsule tmpfs, hash-verified and loaded in memory by this root
process only — candidate-reachable code cannot read it). Timing is the
parent wall clock around each frame call; allocations are the trusted
cgroup-v2 memory.peak of a per-repetition candidate cgroup covering the
WHOLE candidate process tree, including exited descendants — candidate code
cannot write or reset it. Candidate code is imported only by an
unprivileged worker subprocess; each timed repetition gets fresh
PID/IPC/NET/UTS namespaces, a fresh cgroup, and fresh writable state.
"""
from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import math
import os
import resource
import secrets
import selectors
import shutil
import signal
import statistics
import subprocess
import sys
import time
import types
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
CHALLENGE = json.loads((TRUSTED_DIR / "challenge.json").read_text())
INNER_REPS = int(CHALLENGE.get("innerReps", 3))
SCORING = CHALLENGE["scoring"]
P99_WEIGHT = float(SCORING["p99Weight"])
ALLOC_WEIGHT = float(SCORING["allocWeight"])
P99_SCALE_MS = float(SCORING["p99ScaleMs"])
ALLOC_SCALE_MB = float(SCORING["allocScaleMb"])
FRAME_EDIT_COUNT = int(SCORING["frameEditCount"])
CALL_TIMEOUT_SEC = float(os.environ.get("CAPSULE_CALL_TIMEOUT_SEC", CHALLENGE.get("timeoutSec", 10)))
MAX_RESPONSE_BYTES = int(os.environ.get("CAPSULE_MAX_RESPONSE_BYTES", "8000000"))
WORKER_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
CANDIDATE_WRITABLE_ROOTS = (Path("/tmp"), Path("/dev/shm"), Path("/dev/mqueue"))
PR_SET_CHILD_SUBREAPER = 36
IPC_RMID = 0
CLONE_NEWIPC = 0x08000000
CLONE_NEWUTS = 0x04000000
CLONE_NEWPID = 0x20000000
CLONE_NEWNET = 0x40000000
STATE_RESET_TIMEOUT_SEC = 1.0
MS_REMOUNT = 32
CGROUP_ROOT = Path("/sys/fs/cgroup")
CGROUP_TRUSTED = CGROUP_ROOT / "hone-trusted"
REFERENCE_RENDERER_NAME = "renderer.py"
REFERENCE_RENDERER_SHA256 = "dfcb48a694ee39eb9f9fcb26b8ef6fe8c7dd3eb0221ab1ebec1dd21a783ebe12"
_LIBC = ctypes.CDLL(None, use_errno=True)


def _configure_candidate_subreaper() -> None:
    if not sys.platform.startswith("linux"):
        return
    if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f"cannot become candidate subreaper: {os.strerror(code)}")


_CGROUP_READY = False
_CGROUP_COUNTER = 0


def _configure_candidate_cgroups() -> None:
    """Trusted whole-tree allocation accounting (theme: non-resettable peaks).

    Root-only, cgroup v2: remount the cgroup2 filesystem read-write (the
    evaluator container grants CAP_SYS_ADMIN to the trusted root parent
    only; setuid(WORKER_UID) strips it from candidate code and
    no-new-privileges prevents reacquisition), move every container process
    into a trusted leaf, and enable the memory controller for child
    cgroups. Each candidate worker tree then runs in its own fresh cgroup
    whose memory.peak covers every descendant — including ones that already
    exited — and is written only by the kernel: candidate-uid code cannot
    write cgroup files (root-owned) and /proc/self/clear_refs does not
    touch cgroup accounting. Fails closed: a root evaluator without this
    authority refuses to run rather than fall back to gameable accounting.
    """
    global _CGROUP_READY
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        return
    controllers = CGROUP_ROOT / "cgroup.controllers"
    if not controllers.is_file():
        raise RuntimeError("cgroup v2 is required for trusted candidate allocation accounting")
    if "memory" not in controllers.read_text().split():
        raise RuntimeError("cgroup v2 memory controller is unavailable")
    if _LIBC.mount(b"cgroup2", bytes(CGROUP_ROOT), b"cgroup2", MS_REMOUNT, None) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f"cannot remount {CGROUP_ROOT} read-write: {os.strerror(code)}")
    CGROUP_TRUSTED.mkdir(exist_ok=True)
    deadline = time.monotonic() + 5.0
    while True:
        pids = [pid for pid in (CGROUP_ROOT / "cgroup.procs").read_text().split() if pid]
        if not pids:
            break
        for pid in pids:
            try:
                (CGROUP_TRUSTED / "cgroup.procs").write_text(pid)
            except OSError as exc:
                if exc.errno != errno.ESRCH:
                    raise RuntimeError(f"cannot move pid {pid} into the trusted cgroup: {exc}") from exc
        if time.monotonic() >= deadline:
            raise RuntimeError("container processes survived the trusted-cgroup migration")
    (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")
    _CGROUP_READY = True


def _create_candidate_cgroup() -> Path | None:
    """Fresh accounting cgroup for one candidate worker tree (None when the
    evaluator runs unprivileged and the wait4 rusage fallback applies)."""
    global _CGROUP_COUNTER
    if not _CGROUP_READY:
        return None
    cgroup = CGROUP_ROOT / f"hone-candidate-{_CGROUP_COUNTER}"
    _CGROUP_COUNTER += 1
    cgroup.mkdir()
    if not (cgroup / "memory.peak").is_file():
        raise RuntimeError("cgroup v2 memory.peak is unavailable")
    return cgroup


def _remove_candidate_cgroup(cgroup: Path | None) -> None:
    if cgroup is None or not cgroup.is_dir():
        return
    deadline = time.monotonic() + 5.0
    while True:
        try:
            (cgroup / "cgroup.kill").write_text("1")
        except OSError:
            pass
        try:
            cgroup.rmdir()
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"cannot remove candidate cgroup {cgroup}")
            time.sleep(0.005)


def _candidate_pids() -> list[int]:
    if not Path("/proc").is_dir() or os.geteuid() != 0:
        return []
    found: list[int] = []
    for entry in Path("/proc").iterdir():
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
    if not root.is_dir():
        return
    for entry in os.scandir(root):
        path = Path(entry.path)
        if entry.is_dir(follow_symlinks=False):
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)


def _remove_candidate_sysv_ipc() -> None:
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
                raise RuntimeError(f"cannot remove candidate SysV {table} {ident}: {os.strerror(code)}")


def reset_candidate_state() -> None:
    _reap_candidate_processes()
    if os.geteuid() != 0:
        return
    for root in CANDIDATE_WRITABLE_ROOTS:
        _remove_tree_contents(root)
    _remove_candidate_sysv_ipc()
    if _candidate_pids():
        raise RuntimeError("candidate state survived reset")


def _worker_preexec(cgroup: Path | None) -> None:
    for limit, value in ((resource.RLIMIT_CORE, 0), (resource.RLIMIT_AS, 4 << 30)):
        try:
            resource.setrlimit(limit, (value, value))
        except (OSError, ValueError):
            pass
    if cgroup is not None:
        # Root-only, before the namespace unshare and the uid drop: the exec'd
        # worker and every descendant it ever forks inherit this cgroup and
        # cannot leave it (cgroup.procs files are root-owned).
        (cgroup / "cgroup.procs").write_text("0")
    elif _CGROUP_READY:
        raise RuntimeError("candidate worker launched without an accounting cgroup")
    if os.geteuid() != 0:
        return
    if _LIBC.unshare(CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWPID | CLONE_NEWUTS) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f"cannot isolate candidate kernel namespaces: {os.strerror(code)}")
    init_pid = os.fork()
    if init_pid > 0:
        try:
            os.close_range(0, 2**30)
        except AttributeError:
            os.closerange(0, 1 << 16)
        _, status = os.waitpid(init_pid, 0)
        code = os.waitstatus_to_exitcode(status)
        os._exit(code if code >= 0 else 128 - code)
    os.setgroups([])
    os.setgid(WORKER_UID)
    os.setuid(WORKER_UID)


class CallOutcome:
    __slots__ = ("elapsed_ms", "result", "error")

    def __init__(self, elapsed_ms: float, result, error: str | None) -> None:
        self.elapsed_ms = elapsed_ms
        self.result = result
        self.error = error


class Worker:
    def __init__(self, workspace: Path, cgroup: Path | None = None) -> None:
        self.workspace = workspace
        self.cgroup = cgroup
        self.proc: subprocess.Popen | None = None
        self.buffer = b""
        self.import_error: str | None = None

    def ensure(self) -> bool:
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
                preexec_fn=lambda: _worker_preexec(self.cgroup),
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
            ready = None
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

    def call(self, fields: dict) -> CallOutcome:
        if not self.ensure():
            return CallOutcome(0.0, None, f"candidate import failed: {self.import_error}")
        assert self.proc is not None and self.proc.stdin is not None
        nonce = secrets.token_hex(16)
        request = (json.dumps({"id": nonce, **fields}, separators=(",", ":")) + "\n").encode()
        started = time.perf_counter()
        try:
            self.proc.stdin.write(request)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            self.kill()
            return CallOutcome(0.0, None, "worker died before call")
        line, violation = self._read_line(time.monotonic() + CALL_TIMEOUT_SEC)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        if violation is not None or line is None:
            self.kill()
            return CallOutcome(elapsed_ms, None, violation or "no response")
        if self.buffer:
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
        if "result" not in response:
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: no result field")
        return CallOutcome(elapsed_ms, response["result"], None)

    def close_and_measure(self) -> float | None:
        """Non-root fallback for allocation accounting: close stdin, then
        harvest the kernel wait4 rusage peak RSS (KiB) of the worker tree.
        A worker that does not exit promptly forfeits the measurement."""
        if self.proc is None:
            return None
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except OSError:
            pass
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                pid, status, rusage = os.wait4(self.proc.pid, os.WNOHANG)
            except ChildProcessError:
                self.proc = None
                self.buffer = b""
                return None
            if pid == self.proc.pid:
                self.proc.returncode = os.waitstatus_to_exitcode(status)
                self.proc = None
                self.buffer = b""
                if sys.platform == "darwin":
                    return rusage.ru_maxrss / 1024.0
                return float(rusage.ru_maxrss)
            time.sleep(0.005)
        self.kill()
        return None


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def load_cases(path: Path) -> list[dict]:
    cases: list[dict] = []
    for file in sorted(path.rglob("*.json")):
        decoded = json.loads(file.read_text())
        rows = decoded if isinstance(decoded, list) else [decoded]
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or "input" not in row or "expected" not in row:
                raise ValueError(f"malformed case in {file}")
            cases.append(row)
    return cases


# ---------------------------------------------------------------------------
# Sealed reference renderer: the frozen specification of one scoreboard
# frame. Measured frames apply trusted entry-value edits, so their expected
# draw streams cannot ship with the fixtures. The renderer itself is NOT in
# this (candidate-readable) file: it ships inside the holdout asset groups,
# is staged under the root-only /capsule tmpfs (mode 0700) that the dropped
# candidate uid cannot traverse, and is hash-verified and exec'd in memory
# by this trusted root process only.
# ---------------------------------------------------------------------------

_REF_RENDER = None


def load_reference_renderer(assets_dir: Path) -> Path:
    """Locate, hash-verify, and load the sealed reference renderer module
    from the staged assets (each holdout split carries a byte-identical,
    digest-pinned copy; a broker eval stages exactly one split). In-memory
    exec: no candidate-readable copy is ever created, and the pinned digest
    binds the oracle's identity to this protected evaluator."""
    global _REF_RENDER
    matches = sorted(path for path in assets_dir.rglob(REFERENCE_RENDERER_NAME) if path.is_file())
    if not matches:
        raise RuntimeError(f"sealed {REFERENCE_RENDERER_NAME} is missing from {assets_dir}")
    for match in matches:
        digest = hashlib.sha256(match.read_bytes()).hexdigest()
        if digest != REFERENCE_RENDERER_SHA256:
            raise RuntimeError(f"sealed reference renderer digest mismatch at {match}: {digest}")
    source = matches[0].read_bytes()
    module = types.ModuleType("hone_sealed_reference_renderer")
    exec(compile(source, "<sealed reference renderer>", "exec"), module.__dict__)
    render = getattr(module, "render", None)
    if not callable(render):
        raise RuntimeError("sealed reference renderer must export callable render(value)")
    _REF_RENDER = render
    return matches[0]


def verify_reference_sealed(path: Path) -> None:
    """Candidate-uid probe: fork, drop to WORKER_UID, and require that
    opening the sealed renderer fails. Runs wherever the evaluator holds
    root (every broker container); a readable oracle refuses evaluation."""
    if os.geteuid() != 0 or not sys.platform.startswith("linux"):
        return
    pid = os.fork()
    if pid == 0:
        code = 2
        try:
            os.setgroups([])
            os.setgid(WORKER_UID)
            os.setuid(WORKER_UID)
            try:
                fd = os.open(path, os.O_RDONLY)
            except OSError:
                code = 0
            else:
                os.close(fd)
                code = 1
        finally:
            os._exit(code)
    _, status = os.waitpid(pid, 0)
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError(f"sealed reference renderer is reachable from the candidate uid: {path}")


def _ref_render(value):
    if _REF_RENDER is None:
        raise RuntimeError("sealed reference renderer is not loaded")
    return _REF_RENDER(value)


def _frame_scene(base: dict, edits) -> dict:
    """Mirror of the worker-side frame construction: fresh entries list,
    edited entries replaced by copies."""
    entries = list(base["entries"])
    for index, value in edits:
        entry = dict(entries[index])
        entry["value"] = value
        entries[index] = entry
    scene = dict(base)
    scene["entries"] = entries
    return scene


def _edit_stream(case_id: str, frame: int):
    """Deterministic, interpreter-version-independent integer stream for the
    preregistered per-frame edits."""
    counter = 0
    while True:
        digest = hashlib.sha256(f"floyd-scoreboard|{case_id}|{frame}|{counter}".encode()).digest()
        for offset in range(0, len(digest), 8):
            yield int.from_bytes(digest[offset:offset + 8], "big")
        counter += 1


def build_frame_edits(case_id: str, base: dict, frame: int) -> list[list[int]]:
    """Trusted entry-value edits for one measured frame: distinct visible
    entries receive distinct values above the scene ceiling, so every frame
    has a novel top-15 selection and draw stream."""
    entries = base["entries"]
    visible = [index for index, entry in enumerate(entries) if not entry["hidden"]]
    if not visible:
        return []
    stream = _edit_stream(case_id, frame)
    count = min(FRAME_EDIT_COUNT, len(visible))
    chosen: list[int] = []
    seen: set[int] = set()
    while len(chosen) < count:
        index = visible[next(stream) % len(visible)]
        if index not in seen:
            seen.add(index)
            chosen.append(index)
    ceiling = max(entry["value"] for entry in entries) + 1
    values: set[int] = set()
    edits: list[list[int]] = []
    for index in chosen:
        while True:
            value = ceiling + next(stream) % 1_000_000
            if value not in values:
                break
        values.add(value)
        edits.append([index, value])
    return edits


class FramePlan:
    __slots__ = ("case_id", "base", "frame0_expected", "frames")

    def __init__(self, case_id: str, base: dict, frame0_expected, frames) -> None:
        self.case_id = case_id
        self.base = base
        self.frame0_expected = frame0_expected
        self.frames = frames


def build_frame_plan(case_id: str, scene: dict, expected) -> FramePlan:
    frame_reps = int(scene.get("frameReps", 1))
    if frame_reps < 1:
        raise ValueError(f"{case_id}: frameReps must be >= 1")
    base = {key: value for key, value in scene.items() if key != "frameReps"}
    if canonical(_ref_render(base)) != canonical(expected):
        raise RuntimeError(f"{case_id}: frozen expected output disagrees with the trusted reference renderer")
    frames = []
    for frame in range(1, frame_reps):
        edits = build_frame_edits(case_id, base, frame)
        frames.append((edits, _ref_render(_frame_scene(base, edits))))
    return FramePlan(case_id, base, expected, frames)


def drive_frames(worker: Worker, plan: FramePlan) -> tuple[list[float], str | None]:
    """Frame 0 seeds the scene (verified scene-transfer frame, untimed);
    frames 1..frameReps-1 are the measured novel frames, each timed on the
    parent wall clock and verified against the trusted reference render."""
    outcome = worker.call({"scene": plan.base})
    if outcome.error is not None:
        return [], outcome.error
    if canonical(outcome.result) != canonical(plan.frame0_expected):
        return [], "exact output mismatch on scene frame"
    times: list[float] = []
    for number, (edits, expected) in enumerate(plan.frames, start=1):
        outcome = worker.call({"edits": edits})
        if outcome.error is not None:
            return times, f"frame {number}: {outcome.error}"
        if canonical(outcome.result) != canonical(expected):
            return times, f"frame {number}: exact output mismatch"
        times.append(outcome.elapsed_ms)
    return times, None


def _candidate_peak_rss_kb(cgroup: Path | None) -> float | None:
    """Trusted allocation accounting: cgroup-v2 memory.peak (bytes -> KiB)
    of the per-repetition candidate cgroup — the kernel's non-resettable
    high-water mark over the WHOLE candidate process tree, including
    descendants that already exited. Candidate code cannot write cgroup
    files, and /proc/self/clear_refs does not touch cgroup accounting."""
    if cgroup is None:
        return None
    return int((cgroup / "memory.peak").read_text()) / 1024.0


def nearest_rank_p99(times: list[float]) -> float:
    if not times:
        return 0.0
    ordered = sorted(times)
    rank = min(len(ordered), max(1, math.ceil(0.99 * len(ordered))))
    return ordered[rank - 1]


def evaluate_case(workspace: Path, plan: FramePlan) -> tuple[float, bool, dict]:
    rep_times: list[list[float]] = []
    peak_rss_kb = 0.0
    error: str | None = None
    for _ in range(INNER_REPS):
        reset_candidate_state()
        cgroup = _create_candidate_cgroup()
        worker = Worker(workspace, cgroup)
        try:
            frame_times, rep_error = drive_frames(worker, plan)
            rep_times.append(frame_times)
            if rep_error is None:
                rss_kb = _candidate_peak_rss_kb(cgroup)
                if rss_kb is None:
                    rss_kb = worker.close_and_measure()
                if rss_kb is None:
                    rep_error = "candidate allocation accounting unavailable"
                else:
                    peak_rss_kb = max(peak_rss_kb, rss_kb)
        finally:
            try:
                worker.kill()
            finally:
                try:
                    reset_candidate_state()
                finally:
                    _remove_candidate_cgroup(cgroup)
        if rep_error is not None:
            error = rep_error
            break
    correct = (
        error is None
        and len(rep_times) == INNER_REPS
        and all(len(times) == len(plan.frames) for times in rep_times)
    )
    if correct:
        # Preregistered frame cost: the per-frame minimum across the
        # fresh-process repetitions (every repetition of every frame is
        # verified novel work timed on the parent clock, so the minimum is
        # the frame's reproducible cost), then nearest-rank p99 across frames.
        frame_costs = [min(times[index] for times in rep_times) for index in range(len(plan.frames))]
        p99_ms = nearest_rank_p99(frame_costs)
        alloc_mb = peak_rss_kb / 1024.0
        score = P99_WEIGHT / (1.0 + p99_ms / P99_SCALE_MS) + ALLOC_WEIGHT / (1.0 + alloc_mb / ALLOC_SCALE_MB)
        feedback = (
            f"all {INNER_REPS} repetitions x {len(plan.frames)} measured frames matched; "
            f"p99 {p99_ms:.3f} ms, peak RSS {alloc_mb:.1f} MiB"
        )
    else:
        p99_ms = 0.0
        score = 0.0
        feedback = f"incorrect or failed: {error or 'exact output mismatch'}"
    return p99_ms, correct, {"score": score, "feedback": feedback}


def run_public_suite(workspace: Path) -> tuple[bool, str]:
    cases = CHALLENGE.get("publicCases", [])
    if not isinstance(cases, list) or not cases:
        return False, "challenge has no public cases"
    for case in cases:
        plan = build_frame_plan(case["id"], case["input"], case["expected"])
        reset_candidate_state()
        cgroup = _create_candidate_cgroup()
        worker = Worker(workspace, cgroup)
        try:
            _times, error = drive_frames(worker, plan)
        finally:
            try:
                worker.kill()
            finally:
                try:
                    reset_candidate_state()
                finally:
                    _remove_candidate_cgroup(cgroup)
        if error is not None:
            return False, f"{case['id']}: {error}"
    return True, f"{len(cases)} public cases passed"


def main() -> None:
    _configure_candidate_subreaper()
    _configure_candidate_cgroups()
    reset_candidate_state()
    assets_dir = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
    workspace = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
    renderer_path = load_reference_renderer(assets_dir)
    verify_reference_sealed(renderer_path)
    cases = load_cases(assets_dir)
    plans = [build_frame_plan(case["id"], case["input"], case["expected"]) for case in cases]
    per_example: dict[str, dict] = {}
    p99s: list[float] = []
    correct: list[bool] = []
    for plan in plans:
        p99_ms, ok, entry = evaluate_case(workspace, plan)
        per_example[plan.case_id] = entry
        p99s.append(p99_ms)
        correct.append(ok)
    tests_pass, suite_detail = run_public_suite(workspace)
    quality = statistics.fmean([1.0 if ok else 0.0 for ok in correct]) if correct else 0.0
    hidden_cases_pass = bool(correct) and all(correct)
    output = {
        "valid": tests_pass and hidden_cases_pass,
        "objectives": {
            "score": statistics.fmean([entry["score"] for entry in per_example.values()]) if per_example else 0.0,
        },
        "constraints": {"tests_pass": tests_pass, "hidden_cases_pass": hidden_cases_pass},
        "perExample": per_example,
        "diagnostics": {
            "summary": f"{len(cases)} sealed cases; {suite_detail}",
            "runtime_ms": statistics.median(p99s) if p99s else 0.0,
            "quality": quality,
        },
    }
    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
