#!/usr/bin/env python3
"""Protected FLT TextInput evaluator.

The trusted root process reads the selected sealed case bank, then executes one
fresh uid-2000 Node worker per case.  Candidate code can read only /workspace
and receives case inputs but never oracle expectations or the protected asset
file.  The sole scalar is passed declared cases / declared cases.
"""

from __future__ import annotations

import ctypes
import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.mjs"
WORKSPACE = Path("/workspace")
ASSET_ROOT = Path("/capsule/assets")
WORKER_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
CALL_TIMEOUT_SEC = float(os.environ.get("CAPSULE_CALL_TIMEOUT_SEC", "3"))
MAX_OUTPUT_BYTES = int(os.environ.get("CAPSULE_MAX_OUTPUT_BYTES", "1048576"))
MAX_EMITS_PER_OP = 32
PR_SET_CHILD_SUBREAPER = 36
PR_SET_NO_NEW_PRIVS = 38
_LIBC = ctypes.CDLL(None, use_errno=True)


def _candidate_pids() -> list[int]:
    found: list[int] = []
    proc = Path("/proc")
    if not proc.is_dir():
        return found
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            for line in (entry / "status").read_text(errors="replace").splitlines():
                if line.startswith("Uid:") and int(line.split()[1]) == WORKER_UID:
                    found.append(int(entry.name))
                    break
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            continue
    return found


def _kill_candidate_processes() -> None:
    deadline = time.monotonic() + 1.0
    while True:
        pids = _candidate_pids()
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
        if time.monotonic() >= deadline:
            raise RuntimeError("candidate processes survived reset")
        time.sleep(0.01)


def _remove_uid_owned(root: Path) -> None:
    if not root.is_dir():
        return
    for child in root.iterdir():
        try:
            st = child.lstat()
        except FileNotFoundError:
            continue
        if st.st_uid != WORKER_UID:
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


def _reset_candidate_state() -> None:
    _kill_candidate_processes()
    _remove_uid_owned(Path("/tmp"))
    _remove_uid_owned(Path("/dev/shm"))


def _worker_preexec() -> None:
    os.setsid()
    for limit, value in (
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_CPU, 2),
        (resource.RLIMIT_FSIZE, MAX_OUTPUT_BYTES),
        (resource.RLIMIT_NOFILE, 64),
        (resource.RLIMIT_NPROC, 32),
        (resource.RLIMIT_AS, 1024 * 1024 * 1024),
    ):
        resource.setrlimit(limit, (value, value))
    if _LIBC.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    os.setgroups([])
    os.setgid(WORKER_UID)
    os.setuid(WORKER_UID)


def _load_case_bank() -> dict[str, Any]:
    files = sorted(ASSET_ROOT.rglob("*.json"))
    if len(files) != 1:
        raise RuntimeError(f"expected exactly one selected case bank, found {len(files)}")
    bank = json.loads(files[0].read_text())
    cases = bank.get("cases")
    declared = bank.get("declared")
    if not isinstance(cases, list) or not isinstance(declared, int) or declared != len(cases) or declared <= 0:
        raise RuntimeError("invalid case bank declaration")
    ids = [case.get("id") for case in cases if isinstance(case, dict)]
    if len(ids) != declared or any(not isinstance(case_id, str) or not case_id for case_id in ids):
        raise RuntimeError("invalid case id")
    if len(set(ids)) != declared:
        raise RuntimeError("duplicate case id")
    return bank


def _case_input(case: dict[str, Any]) -> dict[str, Any]:
    allowed = {"kind", "setup", "ops"}
    return {key: case[key] for key in allowed if key in case}


def _run_case(case: dict[str, Any], log_dir: Path) -> tuple[bool, str]:
    nonce = uuid.uuid4().hex
    request = json.dumps({"id": nonce, "case": _case_input(case)}, ensure_ascii=False) + "\n"
    output_path = log_dir / f"{nonce}.log"
    env = {
        "HOME": "/tmp",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NODE_NO_WARNINGS": "1",
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TMPDIR": "/tmp",
    }
    _reset_candidate_state()
    try:
        with output_path.open("w+b") as output:
            proc = subprocess.Popen(
                ["node", "--no-addons", str(WORKER), str(WORKSPACE)],
                stdin=subprocess.PIPE,
                stdout=output,
                stderr=output,
                cwd=WORKSPACE,
                env=env,
                preexec_fn=_worker_preexec,
            )
            try:
                proc.communicate(request.encode("utf-8"), timeout=CALL_TIMEOUT_SEC)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=1)
                return False, "worker timeout"
            output.flush()
            size = output.tell()
            if size > MAX_OUTPUT_BYTES:
                return False, "worker output exceeded limit"
            output.seek(0)
            text = output.read(MAX_OUTPUT_BYTES + 1).decode("utf-8", errors="replace")
        if proc.returncode != 0:
            return False, f"worker exited {proc.returncode}"
        lines = [line for line in text.splitlines() if line.strip()]
        if len(lines) != 2:
            return False, "worker protocol line count mismatch"
        try:
            ready = json.loads(lines[0])
            response = json.loads(lines[1])
        except json.JSONDecodeError:
            return False, "worker emitted invalid JSON"
        required = {"TextInput", "parseRawKey", "wrapForDisplay", "wordBoundaryLeft", "wordBoundaryRight", "lineStart", "lineEnd"}
        contract = ready.get("contract") if isinstance(ready, dict) else None
        if ready.get("ready") is not True or not isinstance(contract, dict) or any(contract.get(name) is not True for name in required):
            return False, "candidate contract mismatch"
        if response.get("id") != nonce or "error" in response:
            return False, "worker case error"
        observed = response.get("checkpoints")
        if observed != case.get("expected"):
            return False, "observed state differed from sealed oracle"
        if isinstance(observed, list):
            for checkpoint in observed:
                if isinstance(checkpoint, dict) and checkpoint.get("emits", 0) > MAX_EMITS_PER_OP:
                    return False, "update emission bound exceeded"
        return True, "passed sealed oracle"
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"worker launch failure: {type(exc).__name__}"
    finally:
        _reset_candidate_state()


def main() -> None:
    if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    bank = _load_case_bank()
    cases: list[dict[str, Any]] = bank["cases"]
    per_example: dict[str, Any] = {}
    passed = 0
    harness_valid = True
    with tempfile.TemporaryDirectory(prefix="text-input-eval-") as tmp:
        log_dir = Path(tmp)
        os.chmod(log_dir, 0o700)
        for case in cases:
            ok, feedback = _run_case(case, log_dir)
            if ok:
                passed += 1
            elif "oracle" not in feedback:
                harness_valid = False
            per_example[case["id"]] = {
                "score": 1.0 if ok else 0.0,
                "feedback": {
                    "group": case.get("group", "unknown"),
                    "result": feedback,
                },
            }
    declared = bank["declared"]
    score = passed / declared
    output = {
        "valid": harness_valid,
        "objectives": {"score": score},
        "constraints": {
            "tests_pass": harness_valid,
            "contract_shape": harness_valid,
            "bounded_updates": harness_valid,
        },
        "perExample": per_example,
        "diagnostics": {
            "summary": f"{passed}/{declared} sealed cases passed",
            "passed": passed,
            "declared": declared,
            "quality": 1.0 if harness_valid else 0.0,
            "scalar": "passed/declared",
            "behaviorGroups": bank.get("behaviorGroups", []),
            "maxEmitsPerOperation": MAX_EMITS_PER_OP,
        },
    }
    sys.stdout.write(json.dumps(output, sort_keys=True, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
