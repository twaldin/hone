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
BATCH = int(CHALLENGE.get("batch", 10))
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


def _configure_candidate_subreaper() -> None:
    if not sys.platform.startswith("linux"):
        return
    if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f"cannot become candidate subreaper: {os.strerror(code)}")


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


def _worker_preexec() -> None:
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
    __slots__ = ("elapsed_ms", "result", "error")

    def __init__(self, elapsed_ms: float, result, error: str | None) -> None:
        self.elapsed_ms = elapsed_ms
        self.result = result
        self.error = error


class Worker:
    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace
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

    def call(self, payload=None, *, load: bool = True, reps: int = 1) -> CallOutcome:
        if not self.ensure():
            return CallOutcome(0.0, None, f"candidate import failed: {self.import_error}")
        assert self.proc is not None and self.proc.stdin is not None
        nonce = secrets.token_hex(16)
        # `load` sends the frozen scene; a repeat request (load=False) re-renders
        # the already-loaded scene `reps` times inside the trusted worker loop so
        # the trusted timing isolates render cost from pipe round-trips.
        message: dict = {"id": nonce}
        if load:
            message["input"] = payload
        if reps != 1:
            message["reps"] = reps
        request = (json.dumps(message, separators=(",", ":")) + "\n").encode()
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
    """Peak resident set (VmHWM, KB) of the live candidate worker, read by the
    trusted parent from /proc. Kernel-maintained and root-read, so candidate
    code cannot forge or suppress it (allocation is never self-reported)."""
    pid: int | None = None
    candidates = _candidate_pids()
    if candidates:
        pid = max(candidates)
    elif worker.proc is not None:
        pid = worker.proc.pid
    if pid is None:
        return None
    try:
        status = Path(f"/proc/{pid}/status").read_text()
    except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
        return None
    for line in status.splitlines():
        if line.startswith("VmHWM:"):
            fields = line.split()
            if len(fields) >= 2:
                try:
                    return float(fields[1])
                except ValueError:
                    return None
    return None


def evaluate_case(workspace: Path, case: dict) -> tuple[float, bool, dict]:
    """Registered scalar: bounded reciprocal 1/(1+g) of the geometric mean g
    of the p99 frame time (ms) and the peak-allocation footprint (MB), under a
    per-frame exact-output hard gate.

    Frame repetitions are driven HERE (trusted parent), never by candidate
    code. The frozen scene is loaded once per fresh worker; the evaluator then
    drives WARMUP_FRAMES + FRAMES repeated renders in trusted code, timed by
    the trusted parent in batches of BATCH renders per request so the pipe
    round-trip floor amortizes to noise, and validates the command stream it
    returns. A candidate cannot delete or short-circuit the loop -- the
    evaluator owns it -- and is scored on its own per-frame render cost, not
    on scene transport."""
    expected = canonical(case["expected"])
    sample_p99: list[float] = []
    total_frames = 0
    alloc_kb: list[float] = []
    error: str | None = None
    correct = True
    for _sample in range(SAMPLES):
        # Fresh writable state + fresh worker process per sample, so no sample
        # can carry writable state into the next.
        reset_candidate_state()
        worker = Worker(workspace)
        frame_ms: list[float] = []
        try:
            first = worker.call(case["input"], load=True)
            if first.error is not None:
                error = first.error
                correct = False
            elif canonical(first.result) != expected:
                correct = False
            if error is None:
                warm = worker.call(load=False, reps=WARMUP_FRAMES - 1)
                if warm.error is not None:
                    error = warm.error
                    correct = False
                elif canonical(warm.result) != expected:
                    correct = False
            if error is None:
                for _ in range(FRAMES // BATCH):
                    outcome = worker.call(load=False, reps=BATCH)
                    frame_ms.append(outcome.elapsed_ms / BATCH)
                    if outcome.error is not None:
                        error = outcome.error
                        correct = False
                        break
                    if canonical(outcome.result) != expected:
                        correct = False
                peak_kb = _worker_alloc_kb(worker)
                if peak_kb is not None:
                    alloc_kb.append(peak_kb)
        finally:
            try:
                worker.kill()
            finally:
                reset_candidate_state()
        total_frames += len(frame_ms) * BATCH
        if len(frame_ms) == FRAMES // BATCH:
            sample_p99.append(_percentile(frame_ms, 0.99))
        if error is not None:
            break
    # Per-sample p99 then median across samples: a true p99 frame-time estimate
    # that rejects outlier samples (a single scheduler preemption cannot set the
    # reported latency).
    p99_ms = statistics.median(sample_p99) if sample_p99 else 0.0
    alloc_mb = (statistics.fmean(alloc_kb) / 1024.0) if alloc_kb else 1.0
    correct = correct and error is None and total_frames == SAMPLES * FRAMES
    if correct:
        # Bounded reciprocal of the geometric mean (corpus-standard 1/(1+g)
        # form): monotone-decreasing in cost, q in (0, 1], so no single case
        # can dominate the cross-case mean and micro-second jitter on
        # IPC-floor scenes cannot destabilize aggregates.
        cost = math.sqrt(max(p99_ms, 1e-6) * max(alloc_mb, 1e-6))
        score = 1.0 / (1.0 + cost)
        feedback = (
            f"{SAMPLES}x{FRAMES} frames matched; p99 {p99_ms:.3f} ms, "
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
        reset_candidate_state()
        worker = Worker(workspace)
        try:
            outcome = worker.call(case["input"])
        finally:
            try:
                worker.kill()
            finally:
                reset_candidate_state()
        if outcome.error is not None:
            return False, f"{case['id']}: {outcome.error}"
        if canonical(outcome.result) != canonical(case["expected"]):
            return False, f"{case['id']}: exact output mismatch"
    return True, f"{len(cases)} public cases passed"


def main() -> None:
    # Parent-side timing is nondeterministic under cyclic GC; refcounting keeps
    # this short-lived process bounded, so disable it for stable frame timing.
    gc.disable()
    _configure_candidate_subreaper()
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
