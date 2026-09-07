#!/usr/bin/env python3
"""Trusted evaluator for the expanded Agentelo scoring-policy capsule.

The evaluator owns every case id, expected answer, hard gate, and scalarization.
Candidate JavaScript runs only in a uid-dropped subprocess behind worker.mjs;
it never imports into this process and cannot traverse /capsule/assets in broker
runs.  The sole objective is passed/declared sealed cases.
"""

from __future__ import annotations

import ctypes
import json
import math
import os
import resource
import selectors
import shutil
import signal
import subprocess
import time
from collections import Counter
from pathlib import Path
from typing import Any

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.mjs"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
WORKER_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
CALL_TIMEOUT_SEC = float(os.environ.get("CAPSULE_CALL_TIMEOUT_SEC", "3"))
MAX_RESPONSE_BYTES = int(os.environ.get("CAPSULE_MAX_RESPONSE_BYTES", "65536"))
GROUPS = ("no-diff", "infra", "precedence", "dedup")
OPERATIONS = ("analyze", "score", "dedup")
PR_SET_CHILD_SUBREAPER = 36
CANDIDATE_WRITABLE_ROOTS = (Path("/tmp"), Path("/var/tmp"), Path("/dev/shm"))


def _become_subreaper() -> None:
    """Adopt orphaned candidate descendants so they can be reaped.

    Detached/new-session children reparent to the nearest subreaper instead of
    pid 1, which lets _reap_candidate_processes wait() on them.
    """
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass


def _candidate_pids() -> dict[int, bool]:
    """Map of candidate-uid pid -> is_zombie from a full /proc scan."""
    pids: dict[int, bool] = {}
    proc = Path("/proc")
    if not proc.exists():
        return pids
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
        except OSError:
            continue
        uid: int | None = None
        zombie = False
        for line in status.splitlines():
            if line.startswith("Uid:"):
                try:
                    uid = int(line.split()[1])
                except (IndexError, ValueError):
                    uid = None
            elif line.startswith("State:"):
                zombie = line.split()[1:2] == ["Z"]
        if uid == WORKER_UID:
            pids[int(entry.name)] = zombie
    return pids


def _reap_candidate_processes() -> None:
    """Kill and reap every candidate-uid process until none remain.

    killpg alone misses detached/new-session descendants, and a plain SIGKILL
    sweep leaves zombies pinned by dead parents.  As subreaper this process
    inherits those orphans, so we loop: SIGKILL every live candidate pid,
    drain waitpid(-1, WNOHANG), and stop only when a full /proc scan finds no
    candidate-uid process at all (bounded by a hard deadline).
    """
    if os.geteuid() != 0:
        return
    deadline = time.monotonic() + 5.0
    while True:
        pids = _candidate_pids()
        if not pids:
            return
        for pid, zombie in pids.items():
            if zombie:
                continue
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        while True:
            try:
                reaped, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if reaped == 0:
                break
        if time.monotonic() >= deadline:
            return
        time.sleep(0.01)


def _clear_candidate_writable() -> None:
    """Purge candidate residue from every candidate-writable root.

    The worker drops to WORKER_UID before candidate code runs, so anything the
    candidate persisted (including its own agentelo-case-* transcript dirs) is
    owned by that uid; sweep /tmp, /var/tmp, and /dev/shm rather than only the
    trusted transcript prefix.
    """
    for root in CANDIDATE_WRITABLE_ROOTS:
        try:
            entries = list(root.iterdir())
        except OSError:
            continue
        for path in entries:
            try:
                owned = path.lstat().st_uid == WORKER_UID
            except OSError:
                continue
            if not owned and not path.name.startswith("agentelo-case-"):
                continue
            try:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
            except OSError:
                pass


def _worker_preexec() -> None:
    for limit, value in (
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_FSIZE, 1 << 20),
        (resource.RLIMIT_NOFILE, 64),
        (resource.RLIMIT_AS, 512 << 20),
        (resource.RLIMIT_CPU, max(1, math.ceil(CALL_TIMEOUT_SEC))),
    ):
        resource.setrlimit(limit, (value, value))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(WORKER_UID)
        os.setuid(WORKER_UID)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
            os._exit(126)


def _read_bounded(proc: subprocess.Popen[bytes]) -> tuple[bytes | None, str | None]:
    assert proc.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + CALL_TIMEOUT_SEC
    data = bytearray()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, "worker timeout"
            events = selector.select(remaining)
            if not events:
                return None, "worker timeout"
            chunk = os.read(proc.stdout.fileno(), 8192)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_RESPONSE_BYTES:
                return None, "worker response exceeded byte limit"
        try:
            proc.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            return None, "worker did not exit"
        if proc.returncode != 0:
            return None, f"worker exited {proc.returncode}"
        return bytes(data), None
    finally:
        selector.close()


def _kill_worker(proc: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass


def _call_candidate(case: dict[str, Any]) -> tuple[Any | None, str | None]:
    _reap_candidate_processes()
    _clear_candidate_writable()
    request = json.dumps(
        {"operation": case["operation"], "input": case["input"]},
        separators=(",", ":"),
        allow_nan=False,
    ).encode() + b"\n"
    proc: subprocess.Popen[bytes] | None = None
    try:
        proc = subprocess.Popen(
            ["/usr/bin/node", str(WORKER), str(WORKSPACE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=TRUSTED_DIR,
            start_new_session=True,
            preexec_fn=_worker_preexec,
        )
        assert proc.stdin is not None
        proc.stdin.write(request)
        proc.stdin.close()
        raw, violation = _read_bounded(proc)
        if violation is not None or raw is None:
            _kill_worker(proc)
            return None, violation or "missing worker response"
        lines = raw.splitlines()
        if len(lines) != 1 or not lines[0]:
            return None, "worker emitted extra or empty output"
        try:
            response = json.loads(lines[0])
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, "worker emitted malformed JSON"
        if not isinstance(response, dict) or response.get("ok") is not True or set(response) != {"ok", "value"}:
            detail = response.get("error") if isinstance(response, dict) else None
            return None, f"worker protocol violation{': ' + detail if isinstance(detail, str) else ''}"
        return response["value"], None
    except (OSError, BrokenPipeError, subprocess.SubprocessError) as exc:
        if proc is not None:
            _kill_worker(proc)
        return None, f"worker spawn/protocol failure: {type(exc).__name__}"
    finally:
        _reap_candidate_processes()
        _clear_candidate_writable()


def _validate_case(case: Any, seen: set[str]) -> dict[str, Any]:
    if not isinstance(case, dict) or set(case) != {"id", "group", "operation", "input", "expected", "hardGate"}:
        raise ValueError("case has invalid fields")
    case_id = case["id"]
    if not isinstance(case_id, str) or not case_id or case_id in seen:
        raise ValueError("case id is empty or duplicated")
    seen.add(case_id)
    if case["group"] not in GROUPS or case["operation"] not in OPERATIONS:
        raise ValueError(f"case {case_id} has invalid group/operation")
    if not isinstance(case["input"], dict) or not isinstance(case["hardGate"], bool):
        raise ValueError(f"case {case_id} has invalid input/hardGate")
    return case


def _load_cases() -> list[dict[str, Any]]:
    files = sorted(ASSETS.rglob("cases.json"))
    if len(files) != 1:
        raise ValueError(f"expected exactly one sealed cases.json, found {len(files)}")
    document = json.loads(files[0].read_text())
    if not isinstance(document, dict) or set(document) != {"schemaVersion", "partition", "cases"}:
        raise ValueError("invalid case-bank envelope")
    if document["schemaVersion"] != 1 or not isinstance(document["partition"], str):
        raise ValueError("invalid case-bank version/partition")
    raw_cases = document["cases"]
    if not isinstance(raw_cases, list) or len(raw_cases) <= 12:
        raise ValueError("sealed case bank must contain more than 12 cases")
    seen: set[str] = set()
    cases = [_validate_case(case, seen) for case in raw_cases]
    counts = Counter(case["group"] for case in cases)
    if set(counts) != set(GROUPS) or min(counts.values()) < 3:
        raise ValueError("sealed case bank lacks required behavior-group coverage")
    return cases


def _finite_score_value(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _matches(case: dict[str, Any], actual: Any) -> tuple[bool, str | None]:
    operation = case["operation"]
    expected = case["expected"]
    if operation == "score":
        if not _finite_score_value(actual):
            return False, "nonfinite or nonnumeric score"
        if float(actual) not in (0.0, 0.5, 1.0):
            return False, "score outside declared domain"
        return float(actual) == float(expected), None
    if operation == "analyze":
        fields = {"excluded", "reason", "hasAttemptEvidence", "hasInfraEvidence"}
        if not isinstance(actual, dict) or set(actual) != fields:
            return False, "malformed classification"
        if not isinstance(actual["excluded"], bool) or not isinstance(actual["hasAttemptEvidence"], bool) or not isinstance(actual["hasInfraEvidence"], bool):
            return False, "classification flags must be booleans"
        if actual["reason"] not in ("diff-producing", "infra-junk", "real-attempt", "no-attempt-evidence"):
            return False, "classification reason outside declared domain"
        return actual == expected, None
    if operation == "dedup":
        if actual not in ("current", "candidate"):
            return False, "dedup returned foreign submission"
        return actual == expected, None
    return False, "unknown operation"


def _emit_failure(summary: str) -> None:
    output = {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": {"tests_pass": False, "finite_scores": False, "reward_hacking_safe": False},
        "perExample": {"_evaluator": {"score": 0.0, "feedback": {"passed": False, "detail": summary}}},
        "diagnostics": {"summary": summary, "quality": 0.0, "passed": 0, "declared": 1},
    }
    print(json.dumps(output, separators=(",", ":"), allow_nan=False))


def main() -> None:
    _become_subreaper()
    try:
        cases = _load_cases()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        _emit_failure(f"trusted asset error: {type(exc).__name__}")
        return

    raw_results: list[tuple[dict[str, Any], bool, str | None]] = []
    protocol_ok = True
    hard_gate_ok = True
    for case in cases:
        actual, violation = _call_candidate(case)
        if violation is not None:
            passed = False
            protocol_ok = False
            detail = violation
        else:
            passed, domain_error = _matches(case, actual)
            detail = domain_error if domain_error is not None else (None if passed else "answer mismatch")
            if domain_error is not None:
                protocol_ok = False
        if case["hardGate"] and not passed:
            hard_gate_ok = False
        raw_results.append((case, passed, detail))

    admitted = protocol_ok and hard_gate_ok
    per_example: dict[str, dict[str, Any]] = {}
    passed_count = 0
    group_passed = Counter()
    group_declared = Counter()
    for case, passed, detail in raw_results:
        effective_pass = admitted and passed
        passed_count += int(effective_pass)
        group_declared[case["group"]] += 1
        group_passed[case["group"]] += int(effective_pass)
        feedback: dict[str, Any] = {"group": case["group"], "passed": effective_pass}
        if detail is not None:
            feedback["detail"] = detail
        per_example[case["id"]] = {"score": float(effective_pass), "feedback": feedback}

    declared = len(cases)
    score = passed_count / declared if admitted else 0.0
    hard_count = sum(1 for case in cases if case["hardGate"])
    diagnostics = {
        "summary": f"passed {passed_count}/{declared} sealed cases across {len(GROUPS)} groups",
        "quality": 1.0 if admitted else 0.0,
        "passed": passed_count,
        "declared": declared,
        "hard_gate_cases": hard_count,
        "hard_gate_passed": hard_gate_ok,
        "protocol_valid": protocol_ok,
        "groups": {
            group: {"passed": group_passed[group], "declared": group_declared[group]}
            for group in GROUPS
        },
    }
    output = {
        "valid": admitted,
        "objectives": {"score": score},
        "constraints": {
            "tests_pass": admitted,
            "finite_scores": protocol_ok,
            "reward_hacking_safe": hard_gate_ok,
        },
        "perExample": per_example,
        "diagnostics": diagnostics,
    }
    print(json.dumps(output, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
