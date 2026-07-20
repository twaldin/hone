#!/usr/bin/env python3
"""Trusted exact-output evaluator for the optimizer mode-canonicalization capsule.

Candidate code is imported only by an unprivileged worker subprocess. This
root-side parent owns hidden fixtures, timing, equality, gates, and output.
Each timed repetition gets fresh PID/IPC/NET/UTS namespaces and writable state.

Registered scalar: passed cross-host identity cases divided by declared cases.
Timing is reported as diagnostics only and never enters the objective. valid
is reserved for protocol/public failures; sealed-case misses lower the score
without invalidating the measurement.
"""
from __future__ import annotations

import ctypes
import errno
import json
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
INNER_REPS = int(CHALLENGE.get("innerReps", 3))
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

    def call(self, payload) -> CallOutcome:
        if not self.ensure():
            return CallOutcome(0.0, None, f"candidate import failed: {self.import_error}")
        assert self.proc is not None and self.proc.stdin is not None
        nonce = secrets.token_hex(16)
        request = (json.dumps({"id": nonce, "input": payload}, separators=(",", ":")) + "\n").encode()
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


def evaluate_case(workspace: Path, case: dict) -> tuple[float, bool, dict]:
    outcomes: list[CallOutcome] = []
    for _ in range(INNER_REPS):
        reset_candidate_state()
        worker = Worker(workspace)
        try:
            outcome = worker.call(case["input"])
        finally:
            try:
                worker.kill()
            finally:
                reset_candidate_state()
        outcomes.append(outcome)
        if outcome.error is not None:
            break
    slowest_ms = max((outcome.elapsed_ms for outcome in outcomes), default=0.0)
    error = next((outcome.error for outcome in outcomes if outcome.error is not None), None)
    correct = error is None and len(outcomes) == INNER_REPS and all(
        canonical(outcome.result) == canonical(case["expected"]) for outcome in outcomes
    )
    score = 1.0 if correct else 0.0
    feedback = (
        f"all {INNER_REPS} repetitions matched in slowest {slowest_ms:.3f} ms"
        if correct
        else f"incorrect or failed in slowest {slowest_ms:.3f} ms: {error or 'exact output mismatch'}"
    )
    return slowest_ms, correct, {"score": score, "feedback": feedback}


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
    protocol_ok = bool(cases)
    output = {
        "valid": tests_pass and protocol_ok,
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
