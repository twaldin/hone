#!/usr/bin/env python3
"""Trusted exact-output evaluator for bounded M2 subsystem capsules.

Candidate code is imported only by an unprivileged worker subprocess. This
root-side parent owns hidden fixtures, timing, equality, gates, and output.
Each timed repetition gets fresh PID/IPC/NET/UTS namespaces and writable state.
"""
from __future__ import annotations

import ctypes
import errno
import gc
import importlib.util
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
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
CHALLENGE = json.loads((TRUSTED_DIR / "challenge.json").read_text())
FRAMES = int(CHALLENGE.get("frames", 100))
SAMPLES = int(CHALLENGE.get("samples", 4))
WARMUP_FRAMES = int(CHALLENGE.get("warmupFrames", 8))
DELTA_SPAN = int(CHALLENGE.get("frameDeltaSpan", 64))
REFERENCE_SCALE_MS = float(CHALLENGE.get("referenceP99ScaleMs", 0.5))
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
_LIBC = ctypes.CDLL(None, use_errno=True)
MS_NOSUID = 0x2
MS_NODEV = 0x4
MS_NOEXEC = 0x8
MS_REMOUNT = 0x20
_CGROUP_BASE: Path | None = None


def _load_reference_solve():
    """Import the SEALED seed solve from the read-only trusted baseline
    (/trusted/baseline, never the candidate /workspace overlay). This is the
    trusted authority that computes every frame's protected expected output;
    candidate code is never imported into this parent process."""
    path = TRUSTED_DIR / "solution.py"
    spec = importlib.util.spec_from_file_location("reference_solution", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load trusted reference solution.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    solve = getattr(module, "solve", None)
    if not callable(solve):
        raise RuntimeError("trusted reference solution.py must export solve")
    return solve


_REFERENCE_SOLVE = _load_reference_solve()


def _translate_scene(base: dict, delta: tuple[int, int, int]) -> dict:
    """Trusted mirror of worker._translate: shift every block coordinate by an
    integer delta. Integer arithmetic keeps coordinates exact, so the seed's
    sqrt-distance gate and the improved squared-distance gate agree bit-for-bit
    and the parent-computed expected matches a correct candidate exactly."""
    dx, dy, dz = delta
    return {
        "blocks": [
            {
                "id": b["id"],
                "x": b["x"] + dx,
                "y": b["y"] + dy,
                "z": b["z"] + dz,
                "selected": b["selected"],
            }
            for b in base["blocks"]
        ],
        "radius": base["radius"],
    }


def _distinct_deltas(count: int) -> list[tuple[int, int, int]]:
    """`count` distinct, nonzero integer shift vectors drawn from kernel
    entropy. Unpredictable per evaluation, so a candidate cannot anticipate the
    measured frames during untimed warmup even by reading the (protected)
    evaluator source."""
    seen: set[tuple[int, int, int]] = set()
    out: list[tuple[int, int, int]] = []
    while len(out) < count:
        d = (
            secrets.randbelow(2 * DELTA_SPAN + 1) - DELTA_SPAN,
            secrets.randbelow(2 * DELTA_SPAN + 1) - DELTA_SPAN,
            secrets.randbelow(2 * DELTA_SPAN + 1) - DELTA_SPAN,
        )
        if d == (0, 0, 0) or d in seen:
            continue
        seen.add(d)
        out.append(d)
    return out


def _build_scene_bank(base: dict) -> tuple[list, list]:
    """One fresh per-sample bank: DISJOINT warmup and measured deltas, each
    paired with its OWN protected expected output computed by the sealed
    reference solve. A memoized warmup command stream can therefore never
    satisfy a measured frame, and every measured frame is validated against a
    distinct, trusted target."""
    deltas = _distinct_deltas(WARMUP_FRAMES + FRAMES)
    warmup_pairs = [
        (d, canonical(_REFERENCE_SOLVE(_translate_scene(base, d)))) for d in deltas[:WARMUP_FRAMES]
    ]
    measured_pairs = [
        (d, canonical(_REFERENCE_SOLVE(_translate_scene(base, d)))) for d in deltas[WARMUP_FRAMES:]
    ]
    return warmup_pairs, measured_pairs


def _configure_candidate_subreaper() -> None:
    if not sys.platform.startswith("linux"):
        return
    if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f"cannot become candidate subreaper: {os.strerror(code)}")


def _setup_worker_cgroup_authority() -> None:
    """Prepare a trusted cgroup-v2 measurement root for per-worker memory
    accounting. Root-owned files under /sys/fs/cgroup are the measurement
    authority: candidate code (uid 2000, no capabilities, no-new-privileges)
    cannot create, join, leave, or reset them."""
    global _CGROUP_BASE
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        return
    base = Path("/sys/fs/cgroup")
    controllers_file = base / "cgroup.controllers"
    if not controllers_file.is_file():
        raise RuntimeError("cgroup v2 is not mounted; no trusted memory authority")
    supervisor = base / "hone-eval-supervisor"
    try:
        supervisor.mkdir(exist_ok=True)
    except OSError:
        # The eval container mounts /sys/fs/cgroup read-only; CAP_SYS_ADMIN
        # (already granted for per-rep namespace isolation) permits remounting
        # it writable here in the trusted parent. The candidate worker drops to
        # uid 2000 under no-new-privileges, so it can never repeat this.
        if _LIBC.mount(b"none", b"/sys/fs/cgroup", b"cgroup2", MS_REMOUNT | MS_NOSUID | MS_NODEV | MS_NOEXEC, None) != 0:
            code = ctypes.get_errno()
            raise RuntimeError(f"cannot remount cgroup2 writable: {os.strerror(code)}")
        supervisor.mkdir(exist_ok=True)
    if "memory" not in controllers_file.read_text().split():
        raise RuntimeError("cgroup v2 memory controller unavailable")
    # cgroup v2 forbids enabling child controllers while the parent still
    # hosts processes: park every process (this evaluator) in a supervisor
    # leaf, then delegate the memory controller to the per-worker siblings.
    deadline = time.monotonic() + STATE_RESET_TIMEOUT_SEC
    while True:
        procs = [pid for pid in (base / "cgroup.procs").read_text().split() if pid]
        if not procs:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError(f"cannot park processes for cgroup delegation: {procs}")
        for pid in procs:
            try:
                (supervisor / "cgroup.procs").write_text(pid)
            except ProcessLookupError:
                pass
    (base / "cgroup.subtree_control").write_text("+memory")
    _CGROUP_BASE = base


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
    if cgroup is not None:
        # Enroll this child in its trusted per-worker cgroup BEFORE any
        # candidate-reachable code runs; membership is inherited by every
        # descendant, so the whole process tree is accounted.
        (cgroup / "cgroup.procs").write_text(str(os.getpid()))
    for limit, value in ((resource.RLIMIT_CORE, 0), (resource.RLIMIT_AS, 4 << 30)):
        try:
            resource.setrlimit(limit, (value, value))
        except (OSError, ValueError):
            pass
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
    __slots__ = ("elapsed_ms", "result", "error", "matched")

    def __init__(
        self,
        elapsed_ms: float,
        result,
        error: str | None,
        matched: bool = True,
    ) -> None:
        self.elapsed_ms = elapsed_ms
        self.result = result
        self.error = error
        self.matched = matched


class Worker:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
        self.proc: subprocess.Popen | None = None
        self.buffer = b""
        self.import_error: str | None = None
        self.cgroup: Path | None = None

    def ensure(self) -> bool:
        if self.proc is not None and self.proc.poll() is None:
            return self.import_error is None
        self.buffer = b""
        self._ensure_cgroup()
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

    def _ensure_cgroup(self) -> None:
        if _CGROUP_BASE is None or self.cgroup is not None:
            return
        path = _CGROUP_BASE / f"hone-worker-{secrets.token_hex(8)}"
        path.mkdir()
        self.cgroup = path

    def release(self) -> None:
        """Kill the worker and retire its trusted measurement cgroup."""
        self.kill()
        cgroup = self.cgroup
        if cgroup is None:
            return
        self.cgroup = None
        try:
            (cgroup / "cgroup.kill").write_text("1")
        except OSError:
            pass
        deadline = time.monotonic() + STATE_RESET_TIMEOUT_SEC
        while True:
            try:
                os.rmdir(cgroup)
                return
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"worker cgroup {cgroup} survived release")
                time.sleep(0.005)

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

    def render(self, *, scene: dict | None = None, delta: tuple[int, int, int] | None = None, expected: str | None = None) -> CallOutcome:
        """Drive exactly ONE render across the pipe and time the full
        synchronous round trip on the trusted parent's own clock. A scene
        establishes the pristine base in the worker; a delta shifts that base
        by a trusted integer vector for one distinct frame. The next request is
        written only AFTER this response arrives, so a candidate can never read
        a future frame's delta ahead of time. The worker emits exactly one
        response line, exact-output validated here against the frame's own
        protected expected."""
        if not self.ensure():
            return CallOutcome(0.0, None, f"candidate import failed: {self.import_error}", matched=False)
        assert self.proc is not None and self.proc.stdin is not None
        nonce = secrets.token_hex(16)
        message: dict = {"id": nonce}
        if scene is not None:
            message["input"] = scene
        elif delta is not None:
            message["delta"] = list(delta)
        else:
            return CallOutcome(0.0, None, "render requires scene or delta", matched=False)
        request = (json.dumps(message, separators=(",", ":")) + "\n").encode()
        started = time.perf_counter()
        try:
            self.proc.stdin.write(request)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            self.kill()
            return CallOutcome(0.0, None, "worker died before call", matched=False)
        deadline = time.monotonic() + CALL_TIMEOUT_SEC
        line, violation = self._read_line(deadline)
        arrived = time.perf_counter()
        elapsed_ms = (arrived - started) * 1000.0
        if violation is not None or line is None:
            self.kill()
            return CallOutcome(elapsed_ms, None, violation or "no response", matched=False)
        try:
            response = json.loads(line)
        except ValueError:
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: unparseable response", matched=False)
        if not isinstance(response, dict) or response.get("id") != nonce:
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: response id mismatch", matched=False)
        if "error" in response:
            return CallOutcome(elapsed_ms, None, str(response["error"]), matched=False)
        if "result" not in response:
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: missing result", matched=False)
        if self.buffer:
            self.kill()
            return CallOutcome(elapsed_ms, None, "protocol violation: extra data after response", matched=False)
        result = response["result"]
        matched = expected is None or canonical(result) == expected
        return CallOutcome(elapsed_ms, result, None, matched)


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


def _percentile(values: list[float], q: float) -> float:
    """Nearest-rank percentile over trusted parent-measured frame times."""
    ordered = sorted(values)
    if not ordered:
        return 0.0
    rank = math.ceil(q * len(ordered))
    index = min(max(rank - 1, 0), len(ordered) - 1)
    return ordered[index]


def _worker_alloc_kb(worker: "Worker") -> float | None:
    """Whole-tree peak memory footprint (KB) from the trusted per-worker
    cgroup's memory.peak: kernel-maintained and monotone over the entire
    process tree, so it still counts children that already exited and a
    candidate cannot mask the peak by parking one small live child. The
    cgroup files are root-owned and the candidate holds no capabilities, so
    the reading is non-resettable (VmHWM, by contrast, resets via
    /proc/self/clear_refs and misses exited children)."""
    if worker.cgroup is None:
        return None
    peak = int((worker.cgroup / "memory.peak").read_text().strip())
    return peak / 1024.0


def _collect_sample(
    workspace: Path, base_scene: dict, base_expected: str, bank: tuple[list, list]
) -> tuple[list[float], float | None, str | None, bool]:
    """One fresh-worker sample: load the pristine base, render WARMUP_FRAMES
    disjoint warmup frames (untimed), then FRAMES measured frames each timed on
    the trusted parent's clock. Every frame is exact-output validated against
    its OWN protected expected. Returns (frame_ms, peak_alloc_kb, error,
    all_frames_matched). Fresh writable state before and after, so no sample
    can leak state into the next (in particular, candidate leftovers can never
    touch the trusted reference sample that follows)."""
    warmup_pairs, measured_pairs = bank
    reset_candidate_state()
    worker = Worker(workspace)
    frame_ms: list[float] = []
    matched = True
    try:
        first = worker.render(scene=base_scene, expected=base_expected)
        if first.error is not None:
            return frame_ms, None, first.error, False
        matched = matched and first.matched
        for delta, exp in warmup_pairs:
            warm = worker.render(delta=delta, expected=exp)
            if warm.error is not None:
                return frame_ms, None, warm.error, False
            matched = matched and warm.matched
        for delta, exp in measured_pairs:
            outcome = worker.render(delta=delta, expected=exp)
            if outcome.error is not None:
                return frame_ms, None, outcome.error, False
            matched = matched and outcome.matched
            frame_ms.append(outcome.elapsed_ms)
        return frame_ms, _worker_alloc_kb(worker), None, matched
    finally:
        try:
            worker.release()
        finally:
            reset_candidate_state()


def evaluate_case(workspace: Path, case: dict) -> tuple[float, bool, dict]:
    """Registered scalar: bounded reciprocal 1/(1+g) of the geometric mean g
    of the reference-normalized p99 frame time (ms) and the peak-allocation
    footprint (MB), under a per-frame exact-output hard gate.

    Frame repetitions are driven HERE (trusted parent), never by candidate
    code. Each fresh worker loads the pristine base scene once; the evaluator
    then drives WARMUP_FRAMES + FRAMES renders, EACH carrying its own trusted
    integer shift so the worker hands solve a distinct scene per frame. Warmup
    and measured frames use DISJOINT shift vectors and every frame is timed
    (parent-clock round trip) and exact-output validated by this trusted parent
    against its own protected expected — so a candidate can neither replay one
    cached command stream across frames nor precompute the measured frames
    during untimed warmup. Peak allocation comes from the per-worker cgroup,
    never from candidate-influenced self-reporting.

    Robustness of thin margins: each candidate sample is immediately followed
    by an in-eval trusted reference sample (the sealed seed solution from the
    read-only TRUSTED_DIR, run through the identical worker protocol over the
    SAME per-sample shift bank), so host frequency/contention drift shared by
    the adjacent pair divides out of the per-sample p99 ratio. The reported
    render cost is the median of those per-pair ratios times a frozen scale
    while candidate state is fully reset around every sample, so candidate code
    can never touch a reference measurement."""
    base_scene = case["input"]
    base_expected = canonical(case["expected"])
    # Bind the sealed reference to the frozen asset ground truth: the seed must
    # reproduce the case's frozen expected on the untranslated base, else the
    # trusted reference authority disagrees with the corpus (an infra fault).
    if canonical(_REFERENCE_SOLVE(_translate_scene(base_scene, (0, 0, 0)))) != base_expected:
        raise RuntimeError("trusted reference solve disagrees with frozen expected")
    sample_p99: list[float] = []
    reference_p99: list[float] = []
    ratios: list[float] = []
    total_frames = 0
    alloc_kb: list[float] = []
    error: str | None = None
    correct = True
    for _sample in range(SAMPLES):
        # Fresh per-sample shift bank (kernel entropy): identical work for the
        # candidate sample and the reference sample it is paired with, but
        # unpredictable across samples so no cross-sample replay is possible.
        bank = _build_scene_bank(base_scene)
        frame_ms, peak_kb, sample_error, matched = _collect_sample(workspace, base_scene, base_expected, bank)
        if sample_error is not None:
            error = sample_error
            correct = False
        elif not matched:
            correct = False
        total_frames += len(frame_ms)
        if peak_kb is not None:
            alloc_kb.append(peak_kb)
        if error is not None:
            break
        # Interleaved trusted reference yardstick, adjacent in time to the
        # candidate sample it normalizes, over the SAME shift bank. A failing
        # reference is a trusted infrastructure fault, never a candidate outcome.
        ref_frames, _ref_peak, ref_error, ref_matched = _collect_sample(TRUSTED_DIR, base_scene, base_expected, bank)
        if ref_error is not None or not ref_matched or len(ref_frames) != FRAMES:
            raise RuntimeError(f"trusted reference sample failed: {ref_error or 'exact output mismatch'}")
        if len(frame_ms) == FRAMES:
            candidate_p99 = _percentile(frame_ms, 0.99)
            ref_p99 = _percentile(ref_frames, 0.99)
            sample_p99.append(candidate_p99)
            reference_p99.append(ref_p99)
            ratios.append(candidate_p99 / max(ref_p99, 1e-6))
    # Per-sample p99, then median across samples; scoring uses the median of
    # per-pair candidate/reference ratios so shared host drift cancels and a
    # single scheduler preemption cannot set the reported latency.
    p99_ms = statistics.median(sample_p99) if sample_p99 else 0.0
    ratio = statistics.median(ratios) if ratios else 0.0
    normalized_p99_ms = ratio * REFERENCE_SCALE_MS
    alloc_mb = (statistics.fmean(alloc_kb) / 1024.0) if alloc_kb else 1.0
    correct = correct and error is None and total_frames == SAMPLES * FRAMES
    if correct:
        # Bounded reciprocal of the geometric mean (corpus-standard 1/(1+g)
        # form): monotone-decreasing in cost, q in (0, 1], so no single case
        # can dominate the cross-case mean and micro-second jitter on
        # IPC-floor scenes cannot destabilize aggregates.
        cost = math.sqrt(max(normalized_p99_ms, 1e-6) * max(alloc_mb, 1e-6))
        score = 1.0 / (1.0 + cost)
        feedback = (
            f"{SAMPLES}x{FRAMES} frames matched; p99 {p99_ms:.3f} ms "
            f"(in-eval reference {statistics.median(reference_p99):.3f} ms, ratio {ratio:.3f}), "
            f"peak alloc {alloc_mb:.2f} MB, q {score:.4f}"
        )
    else:
        score = 0.0
        feedback = (
            f"incorrect or failed at p99 {p99_ms:.3f} ms: "
            f"{error or 'exact output mismatch'}"
        )
    return p99_ms, correct, {"score": score, "feedback": feedback}


def run_public_suite(workspace: Path) -> tuple[bool, str]:
    cases = CHALLENGE.get("publicCases", [])
    if not isinstance(cases, list) or not cases:
        return False, "challenge has no public cases"
    for case in cases:
        expected = canonical(case["expected"])
        reset_candidate_state()
        worker = Worker(workspace)
        try:
            outcome = worker.render(scene=case["input"], expected=expected)
        finally:
            try:
                worker.release()
            finally:
                reset_candidate_state()
        if outcome.error is not None:
            return False, f"{case['id']}: {outcome.error}"
        if not outcome.matched:
            return False, f"{case['id']}: exact output mismatch"
    return True, f"{len(cases)} public cases passed"


def main() -> None:
    # Parent-side timing is nondeterministic under cyclic GC; refcounting keeps
    # this short-lived process bounded, so disable it for stable frame timing.
    gc.disable()
    _configure_candidate_subreaper()
    _setup_worker_cgroup_authority()
    reset_candidate_state()
    assets_dir = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
    workspace = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
    cases = load_cases(assets_dir)
    per_example: dict[str, dict] = {}
    runtimes: list[float] = []
    correct: list[bool] = []
    for case in cases:
        elapsed, ok, entry = evaluate_case(workspace, case)
        per_example[case["id"]] = entry
        runtimes.append(elapsed)
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
            "runtime_ms": statistics.median(runtimes) if runtimes else 0.0,
            "quality": quality,
        },
    }
    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
