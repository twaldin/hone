#!/usr/bin/env python3
"""Trusted Linux evaluator for the sealed trade-up skin-data latency holdout.

Every candidate and sealed-reference timing is a fresh one-shot process over a
fresh read-only bind of the immutable database.  Its pages are evicted with
POSIX_FADV_DONTNEED and verified nonresident with mincore before the timed
process starts.  Before every sample the evaluator reaps worker-uid processes,
removes all worker-uid persistent state (tmp trees, shared-memory files, and
System V IPC objects), and each worker starts in fresh IPC+NET namespaces
before its privilege drop (the broker mounts the candidate workspace
read-only), so no repetition can observe state left behind by an earlier
one.  Nine candidate/reference pairs are interleaved in alternating
order.  Only an exact registered response+quality hash receives the continuous
negative log latency objective.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import mmap
import os
import resource
import selectors
import shutil
import signal
import stat
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSET_STAGE = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
CANDIDATE_QUERY = WORKSPACE / "query.py"
SAMPLES = 9
WORKER_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
WORKER_GID = int(os.environ.get("CAPSULE_WORKER_GID", str(WORKER_UID)))
TIMEOUT_SEC = float(os.environ.get("CAPSULE_CALL_TIMEOUT_SEC", "12"))
MAX_RESPONSE_BYTES = int(os.environ.get("CAPSULE_MAX_RESPONSE_BYTES", "2000000"))
FAIL_SCORE = -1000.0
P50_WEIGHT = 0.70
P95_WEIGHT = 0.30
MAX_RESIDENT_FRACTION = 0.01
_LIBC = ctypes.CDLL(None, use_errno=True)
MS_RDONLY = 1
MS_NOSUID = 2
MS_NODEV = 4
MS_NOEXEC = 8
MS_REMOUNT = 32
MS_BIND = 4096
MNT_DETACH = 2
IPC_RMID = 0
CLONE_NEWIPC = 0x08000000
CLONE_NEWNET = 0x40000000
# World-writable persistence surfaces a worker-uid process could reach inside
# the eval container; swept before every timed sample for robustness.
PURGE_ROOTS = ("/tmp", "/var/tmp", "/dev/shm", "/dev/mqueue")


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    position = quantile * (len(ordered) - 1)
    low = int(math.floor(position))
    high = int(math.ceil(position))
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _stats(values: list[float]) -> dict[str, float]:
    median = statistics.median(values)
    mad = statistics.median(abs(value - median) for value in values)
    return {
        "p50Ms": median,
        "p95Ms": _percentile(values, 0.95),
        "madMs": mad,
        "madOverMedian": mad / median if median > 0 else math.inf,
    }


def _cpu_quota() -> tuple[bool, float | None, str]:
    v2 = Path("/sys/fs/cgroup/cpu.max")
    if v2.is_file():
        quota, period = v2.read_text().strip().split()
        if quota == "max":
            return False, None, "cgroup-v2:max"
        cpus = int(quota) / int(period)
        return 0 < cpus <= 2.0, cpus, "cgroup-v2"
    quota_path = Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
    period_path = Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
    if quota_path.is_file() and period_path.is_file():
        quota = int(quota_path.read_text())
        period = int(period_path.read_text())
        if quota <= 0:
            return False, None, "cgroup-v1:unlimited"
        cpus = quota / period
        return 0 < cpus <= 2.0, cpus, "cgroup-v1"
    return False, None, "missing"


def _candidate_pids() -> list[int]:
    if os.geteuid() != 0:
        return []
    found: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            lines = (entry / "status").read_text().splitlines()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        for line in lines:
            if line.startswith("Uid:"):
                fields = line.split()
                if len(fields) >= 2 and int(fields[1]) == WORKER_UID:
                    found.append(int(entry.name))
                break
    return found


def _reap_candidate_processes() -> None:
    if os.geteuid() != 0:
        return
    deadline = time.monotonic() + 1.0
    while True:
        pids = _candidate_pids()
        if not pids:
            while True:
                try:
                    pid, _status = os.waitpid(-1, os.WNOHANG)
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
        if time.monotonic() >= deadline:
            raise RuntimeError(f"worker uid processes survived cleanup: {pids}")
        time.sleep(0.005)


def _purge_owned_entries(root: Path) -> int:
    """Delete every filesystem entry under root owned by the worker uid."""
    removed = 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        base = Path(dirpath)
        kept: list[str] = []
        for name in dirnames:
            child = base / name
            try:
                info = child.lstat()
            except OSError:
                continue
            if info.st_uid != WORKER_UID:
                kept.append(name)
                continue
            removed += 1
            if stat.S_ISDIR(info.st_mode):
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
        dirnames[:] = kept
        for name in filenames:
            child = base / name
            try:
                if child.lstat().st_uid == WORKER_UID:
                    child.unlink(missing_ok=True)
                    removed += 1
            except OSError:
                continue
    return removed


def _purge_sysv_ipc() -> int:
    """Remove worker-uid System V IPC objects, which outlive their creators."""
    removed = 0
    for table, remove in (
        ("shm", lambda ipc_id: _LIBC.shmctl(ipc_id, IPC_RMID, None)),
        ("msg", lambda ipc_id: _LIBC.msgctl(ipc_id, IPC_RMID, None)),
        ("sem", lambda ipc_id: _LIBC.semctl(ipc_id, 0, IPC_RMID, 0)),
    ):
        path = Path("/proc/sysvipc") / table
        try:
            lines = path.read_text().splitlines()
        except OSError:
            continue
        if not lines:
            continue
        header = lines[0].split()
        try:
            uid_column = header.index("uid")
        except ValueError:
            continue
        for line in lines[1:]:
            fields = line.split()
            if len(fields) <= uid_column:
                continue
            try:
                if int(fields[uid_column]) != WORKER_UID:
                    continue
                remove(int(fields[1]))
            except ValueError:
                continue
            removed += 1
    return removed


def _purge_candidate_state() -> int:
    """Reset worker-uid writable state so every sample starts from scratch.

    A repetition may use scratch space while it runs, but nothing it creates
    (tmp files, shared-memory segments, SysV IPC) may survive into the next
    timed sample.  Returns the number of entries removed.
    """
    if os.geteuid() != 0:
        return 0
    removed = 0
    for root in PURGE_ROOTS:
        root_path = Path(root)
        if root_path.is_dir():
            removed += _purge_owned_entries(root_path)
    removed += _purge_sysv_ipc()
    return removed


def _preexec() -> None:
    os.setsid()
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024 * 1024, 2 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.geteuid() == 0:
        # Fresh IPC + NET namespaces per repetition BEFORE the uid drop (the
        # eval container grants SYS_ADMIN to the trusted scorer for exactly
        # this), so SysV IPC objects and loopback state can never carry
        # between samples.  The setuid drop then strips the capability from
        # the worker and no-new-privileges prevents reacquisition.
        if _LIBC.unshare(CLONE_NEWIPC | CLONE_NEWNET) != 0:
            code = ctypes.get_errno()
            raise OSError(code, f"namespace unshare failed: {os.strerror(code)}")
        os.setgroups([])
        os.setgid(WORKER_GID)
        os.setuid(WORKER_UID)


def _resident_fraction(fd: int, length: int) -> float:
    if length == 0:
        return 0.0
    page_size = os.sysconf("SC_PAGE_SIZE")
    pages = (length + page_size - 1) // page_size
    mapping = mmap.mmap(
        fd,
        length,
        flags=mmap.MAP_PRIVATE,
        prot=mmap.PROT_READ | mmap.PROT_WRITE,
    )
    try:
        anchor = (ctypes.c_char * 1).from_buffer(mapping)
        vector = (ctypes.c_ubyte * pages)()
        rc = _LIBC.mincore(ctypes.c_void_p(ctypes.addressof(anchor)), ctypes.c_size_t(length), vector)
        del anchor
        if rc != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        return sum(1 for value in vector if value & 1) / pages
    finally:
        mapping.close()


def _bind_readonly(source_fd: int, target: Path) -> None:
    target.touch(mode=0o444)
    source = f"/proc/self/fd/{source_fd}".encode()
    encoded_target = os.fsencode(target)
    if _LIBC.mount(source, encoded_target, None, MS_BIND, None) != 0:
        code = ctypes.get_errno()
        raise OSError(code, f"bind mount failed: {os.strerror(code)}")
    flags = MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC
    if _LIBC.mount(None, encoded_target, None, flags, None) != 0:
        code = ctypes.get_errno()
        _LIBC.umount2(encoded_target, MNT_DETACH)
        raise OSError(code, f"read-only remount failed: {os.strerror(code)}")


def _unbind(target: Path) -> None:
    encoded_target = os.fsencode(target)
    if _LIBC.umount2(encoded_target, MNT_DETACH) != 0:
        code = ctypes.get_errno()
        if code not in (2, 22):
            raise OSError(code, f"unmount failed: {os.strerror(code)}")


def _prepare_run(root: Path, source_db: Path, source_workload: Path, query_path: Path, copy_query: bool) -> tuple[Path, Path, Path, Path, float]:
    run_dir = Path(tempfile.mkdtemp(prefix="sample-", dir=root))
    workload_path = run_dir / "workload.json"
    local_query = run_dir / "query.py" if copy_query else query_path
    shutil.copyfile(source_workload, workload_path)
    if copy_query:
        shutil.copyfile(query_path, local_query)
    # The real broker gives evaluators a 16 MiB tmpfs, smaller than the scaled
    # immutable database.  Evict the root-only asset inode, then bind only that
    # file read-only into the one-shot worker directory.  The uid-2000 worker
    # never receives a traversable asset-group path.
    db_fd = os.open(source_db, os.O_RDONLY)
    try:
        os.posix_fadvise(db_fd, 0, 0, os.POSIX_FADV_DONTNEED)
        resident = _resident_fraction(db_fd, os.fstat(db_fd).st_size)
        if resident > MAX_RESIDENT_FRACTION:
            os.posix_fadvise(db_fd, 0, 0, os.POSIX_FADV_DONTNEED)
            resident = _resident_fraction(db_fd, os.fstat(db_fd).st_size)
        db_path = run_dir / "market.sqlite3"
        _bind_readonly(db_fd, db_path)
    finally:
        os.close(db_fd)
    os.chmod(run_dir, 0o555)
    os.chmod(workload_path, 0o444)
    if copy_query:
        os.chmod(local_query, 0o444)
    return run_dir, db_path, workload_path, local_query, resident


def _read_process(process: subprocess.Popen[bytes]) -> tuple[bytes, str | None]:
    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    chunks: list[bytes] = []
    total = 0
    deadline = time.monotonic() + TIMEOUT_SEC
    problem: str | None = None
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                problem = "timeout"
                break
            events = selector.select(min(remaining, 0.1))
            if events:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    problem = "response-too-large"
                    break
                chunks.append(chunk)
            elif process.poll() is not None:
                chunk = os.read(process.stdout.fileno(), 65536)
                if chunk:
                    total += len(chunk)
                    chunks.append(chunk)
                break
        if problem is not None or process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        problem = problem or "cleanup-timeout"
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
    finally:
        selector.close()
    if process.returncode != 0 and problem is None:
        problem = f"exit-{process.returncode}"
    return b"".join(chunks), problem


def _run_once(root: Path, db: Path, workload: Path, query: Path, copy_query: bool) -> dict[str, Any]:
    _reap_candidate_processes()
    purged = _purge_candidate_state()
    run_dir, db_copy, workload_copy, local_query, resident = _prepare_run(root, db, workload, query, copy_query)
    if resident > MAX_RESIDENT_FRACTION:
        _unbind(db_copy)
        shutil.rmtree(run_dir, ignore_errors=True)
        return {"ms": TIMEOUT_SEC * 1000.0, "hash": None, "error": f"cache-resident:{resident:.6f}", "resident": resident, "purged": purged}
    env = {
        "HOME": str(run_dir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PYTHONHASHSEED": "0",
        "TMPDIR": str(run_dir),
    }
    started = time.perf_counter_ns()
    try:
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", str(WORKER), str(local_query), str(db_copy), str(workload_copy)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=run_dir,
            env=env,
            preexec_fn=_preexec,
        )
    except BaseException:
        _unbind(db_copy)
        shutil.rmtree(run_dir, ignore_errors=True)
        raise
    payload, problem = _read_process(process)
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
    try:
        _reap_candidate_processes()
        response_hash: str | None = None
        result: object | None = None
        if problem is None:
            if not payload.endswith(b"\n") or payload.count(b"\n") != 1:
                problem = "protocol-lines"
            else:
                decoded = json.loads(payload)
                if not isinstance(decoded, dict) or set(decoded) != {"result"}:
                    problem = "protocol-shape"
                else:
                    result = decoded["result"]
                    response_hash = hashlib.sha256(_canonical(result)).hexdigest()
        return {"ms": elapsed_ms, "hash": response_hash, "result": result, "error": problem, "resident": resident, "purged": purged}
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        return {"ms": elapsed_ms, "hash": None, "result": None, "error": type(error).__name__, "resident": resident, "purged": purged}
    finally:
        _unbind(db_copy)
        shutil.rmtree(run_dir, ignore_errors=True)


def _quality_hash(result: object, workload: dict[str, Any]) -> str:
    envelope = {"response": result, "quality": workload["quality"]}
    return hashlib.sha256(_canonical(envelope)).hexdigest()


def _emit_failure(reason: str, constraints: dict[str, bool] | None = None) -> None:
    base_constraints = {
        "tests_pass": False,
        "response_identity": False,
        "quality_identity": False,
        "fresh_processes": False,
        "cache_off": False,
        "cpu_quota": False,
        "linux": sys.platform.startswith("linux"),
        "fixed_fixture": False,
    }
    if constraints:
        base_constraints.update(constraints)
    output = {
        "valid": False,
        "objectives": {"q_latency": FAIL_SCORE},
        "constraints": base_constraints,
        "perExample": {"latency": {"score": 0.0, "feedback": {"reason": reason}}},
        "diagnostics": {"quality": 0.0, "summary": reason},
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))


def _asset_root() -> Path:
    if (ASSET_STAGE / "market.sqlite3").is_file():
        return ASSET_STAGE
    candidates = sorted(ASSET_STAGE.rglob("market.sqlite3"))
    if len(candidates) != 1:
        raise RuntimeError(f"expected one staged database, found {len(candidates)}")
    return candidates[0].parent


def main() -> None:
    cpu_ok, cpu_count, cpu_source = _cpu_quota()
    platform_ok = sys.platform.startswith("linux") and Path("/proc").is_dir()
    cold_api_ok = hasattr(os, "posix_fadvise") and hasattr(os, "POSIX_FADV_DONTNEED")
    try:
        assets = _asset_root()
    except (OSError, RuntimeError) as error:
        _emit_failure(f"fixture-root:{type(error).__name__}")
        return
    required = {
        "db": assets / "market.sqlite3",
        "workload": assets / "workload.json",
        "oracle": assets / "oracle.json",
        "reference": assets / "reference.py",
        "provenance": assets / "provenance.json",
    }
    try:
        if not all(path.is_file() for path in required.values()):
            raise RuntimeError("sealed asset group incomplete")
        if CANDIDATE_QUERY.is_symlink() or not CANDIDATE_QUERY.is_file():
            raise RuntimeError("candidate query.py must be a regular file")
        oracle = json.loads(required["oracle"].read_text())
        workload = json.loads(required["workload"].read_text())
        hashes_ok = (
            _sha256(required["db"]) == oracle["databaseSha256"]
            and _sha256(required["workload"]) == oracle["workloadSha256"]
            and _sha256(required["reference"]) == oracle["referenceSha256"]
            and _sha256(required["provenance"]) == oracle["provenanceSha256"]
        )
        fixed_fixture = hashes_ok and oracle["fixture"] == workload["fixture"] and len(workload["queries"]) == 7
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        _emit_failure(f"fixture-preflight:{type(error).__name__}")
        return
    if not platform_ok or not cpu_ok or not cold_api_ok or not fixed_fixture:
        _emit_failure(
            "platform-preflight",
            {"linux": platform_ok, "cpu_quota": cpu_ok, "cache_off": cold_api_ok, "fixed_fixture": fixed_fixture},
        )
        return

    candidate_runs: list[dict[str, Any]] = []
    reference_runs: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="tradeup-latency-") as temp:
        root = Path(temp)
        os.chmod(root, 0o711)
        for index in range(SAMPLES):
            order = ("reference", "candidate") if index % 2 == 0 else ("candidate", "reference")
            for variant in order:
                if variant == "reference":
                    reference_runs.append(
                        _run_once(root, required["db"], required["workload"], required["reference"], True)
                    )
                else:
                    candidate_runs.append(
                        _run_once(root, required["db"], required["workload"], CANDIDATE_QUERY, False)
                    )

    expected_quality_hash = oracle["responseQualityHash"]
    reference_quality_hashes = [
        _quality_hash(run["result"], workload) if run["result"] is not None else None
        for run in reference_runs
    ]
    candidate_quality_hashes = [
        _quality_hash(run["result"], workload) if run["result"] is not None else None
        for run in candidate_runs
    ]
    reference_identity = all(value == expected_quality_hash for value in reference_quality_hashes)
    candidate_identity = all(value == expected_quality_hash for value in candidate_quality_hashes)
    processes_ok = len(candidate_runs) == SAMPLES and len(reference_runs) == SAMPLES
    cache_off = all(run["resident"] <= MAX_RESIDENT_FRACTION for run in [*candidate_runs, *reference_runs])
    candidate_error_free = all(run["error"] is None for run in candidate_runs)
    reference_error_free = all(run["error"] is None for run in reference_runs)
    reference_ok = reference_identity and reference_error_free

    candidate_times = [float(run["ms"]) for run in candidate_runs]
    reference_times = [float(run["ms"]) for run in reference_runs]
    candidate_stats = _stats(candidate_times)
    reference_stats = _stats(reference_times)
    q_latency_log = -(
        P50_WEIGHT * math.log(max(candidate_stats["p50Ms"], 0.001))
        + P95_WEIGHT * math.log(max(candidate_stats["p95Ms"], 0.001))
    )
    valid = candidate_identity and candidate_error_free and reference_ok and processes_ok and cache_off and cpu_ok and platform_ok
    objective_score = math.exp(q_latency_log) if valid else FAIL_SCORE
    ordering_score = objective_score if valid else 0.0
    constraints = {
        "tests_pass": valid,
        "response_identity": candidate_identity,
        "quality_identity": candidate_identity,
        "fresh_processes": processes_ok,
        "cache_off": cache_off,
        "cpu_quota": cpu_ok,
        "linux": platform_ok,
        "fixed_fixture": fixed_fixture and reference_ok,
    }
    feedback = {
        "p50Ms": candidate_stats["p50Ms"],
        "p95Ms": candidate_stats["p95Ms"],
        "madOverMedian": candidate_stats["madOverMedian"],
        "qLatency": objective_score,
        "qLatencyLog": q_latency_log,
        "responseQualityHash": candidate_quality_hashes[0] if candidate_identity else "mismatch",
        "samples": SAMPLES,
    }
    diagnostics = {
        "summary": "exact response+quality identity" if valid else "correctness/platform gate failed",
        "quality": 1.0 if candidate_identity else 0.0,
        "qFormula": "exp(-(0.70*ln(p50_ms)+0.30*ln(p95_ms)))",
        "qLatency": objective_score,
        "qLatencyLog": q_latency_log,
        "candidate": {**candidate_stats, "samplesMs": candidate_times},
        "reference": {**reference_stats, "samplesMs": reference_times},
        "responseQualityHash": candidate_quality_hashes[0] if candidate_identity else "mismatch",
        "referenceResponseQualityHash": reference_quality_hashes[0] if reference_identity else "mismatch",
        "cpuQuota": {"cpus": cpu_count, "source": cpu_source},
        "freshProcesses": len(candidate_runs) + len(reference_runs),
        "interleave": "R,C,C,R,R,C,C,R,R,C,C,R,R,C,C,R,R,C",
        "statePurgedEntries": sum(int(run.get("purged", 0)) for run in [*candidate_runs, *reference_runs]),
        "maxColdResidentFraction": max(run["resident"] for run in [*candidate_runs, *reference_runs]),
        "errors": [run["error"] for run in candidate_runs if run["error"] is not None],
    }
    output = {
        "valid": valid,
        "objectives": {"q_latency": objective_score},
        "constraints": constraints,
        "perExample": {"latency": {"score": ordering_score, "feedback": feedback}},
        "diagnostics": diagnostics,
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
