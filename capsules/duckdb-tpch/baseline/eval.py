#!/usr/bin/env python3
"""Trusted evaluator for the sealed DuckDB physical-filter microbenchmark."""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import resource
import select
import shutil
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path("/tmp/hone-duckdb-filter")
WORK = BUILD_ROOT / "work"
SOURCE = WORK / "source"
FIXTURE = BUILD_ROOT / "fixture"
OUTPUT = BUILD_ROOT / "output"
SEALED = BUILD_ROOT / "sealed"
UNSHARE_NEWIPC_NEWNET = 0x08000000 | 0x40000000
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 2700
SAMPLE_TIMEOUT_SEC = 45
WARMUP_RUNS = 2
TIMED_RUNS = 7
FASTEST_K = 5
QFAIL = 0.0
ALLOWED_MUTABLE_FILES = frozenset({
    "src/execution/operator/filter/physical_filter.cpp",
})


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def emit_failure(detail: str, result_hash: str = "") -> None:
    safe = detail.replace(str(ASSETS), "<sealed-assets>").replace(str(TRUSTED_DIR), "<trusted>")[:1200]
    output = {
        "valid": False,
        "objectives": {"score": QFAIL},
        "constraints": {
            "tests_pass": False,
            "exact_result_pass": False,
            "rss_pass": False,
            "asset_hash_pass": False,
        },
        "perExample": {"aggregate": {"score": QFAIL, "feedback": safe}},
        "diagnostics": {
            "summary": safe,
            "quality": 0.0,
            "result_hash": result_hash or hashlib.sha256(safe.encode()).hexdigest(),
        },
    }
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


def demote() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 << 30, 2 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (7 << 30, 7 << 30))
    if os.geteuid() == 0:
        # Fresh IPC + NET namespaces per demoted process: no SysV/loopback
        # state survives between repetitions or leaks across stages.
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.unshare(UNSHARE_NEWIPC_NEWNET) != 0:
            raise OSError(ctypes.get_errno(), "unshare(NEWIPC|NEWNET) failed")
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


def run_worker(action: str, *paths: Path) -> dict:
    arguments = paths or (SOURCE,)
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(WORKER), action, *(str(path) for path in arguments)],
            cwd=TRUSTED_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=PROCESS_TIMEOUT_SEC,
            check=False,
            preexec_fn=demote,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateFailure(f"{action} worker failed: {exc}") from exc
    try:
        payload = json.loads(completed.stdout)
    except (ValueError, UnicodeDecodeError) as exc:
        raise GateFailure(f"{action} worker returned malformed output") from exc
    if completed.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
        detail = payload.get("detail") if isinstance(payload, dict) else None
        raise GateFailure(f"{action} gate failed: {str(detail or 'worker failure')[:800]}")
    return payload


def mount_build_tmpfs() -> None:
    BUILD_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "tmpfs", "-o", "size=2g,mode=755,exec,nosuid,nodev", "hone-duckdb-filter", str(BUILD_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    if completed.returncode != 0:
        BUILD_ROOT.rmdir()
        raise GateFailure("trusted build tmpfs mount failed")
    WORK.mkdir(mode=0o777)
    os.chmod(WORK, 0o777)


def unmount(path: Path) -> bool:
    completed = subprocess.run(
        ["umount", str(path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    return completed.returncode == 0


def cleanup() -> None:
    if BUILD_ROOT.is_mount():
        unmount(BUILD_ROOT)
    if BUILD_ROOT.exists():
        BUILD_ROOT.rmdir()


def check_source_envelope() -> None:
    trusted_paths = {
        path.relative_to(TRUSTED_DIR).as_posix()
        for path in TRUSTED_DIR.rglob("*")
        if path.is_file()
    }
    for path in WORKSPACE.rglob("*"):
        if path.is_symlink():
            raise GateFailure("candidate source contains a symbolic link")
        if not path.is_file():
            continue
        relative = path.relative_to(WORKSPACE).as_posix()
        if relative in trusted_paths or relative in ALLOWED_MUTABLE_FILES:
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")


def load_and_seal_assets() -> tuple[dict, str]:
    metadata_files = sorted(ASSETS.rglob("workload.json"))
    database_files = sorted(ASSETS.rglob("sf1.duckdb"))
    query_files = sorted(ASSETS.rglob("query.sql"))
    oracle_files = sorted(ASSETS.rglob("oracle.sha256"))
    if not all(len(files) == 1 for files in (metadata_files, database_files, query_files, oracle_files)):
        raise GateFailure("selected holdout group has an invalid sealed asset set")
    try:
        metadata = json.loads(metadata_files[0].read_text())
        oracle = oracle_files[0].read_text().strip()
        database_size = database_files[0].stat().st_size
        database_hash = hashlib.sha256(database_files[0].read_bytes()).hexdigest()
        query_bytes = query_files[0].read_bytes()
        query_hash = hashlib.sha256(query_bytes).hexdigest()
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed microbenchmark assets are unreadable") from exc
    required = {
        "baselinePeakRssKb", "database", "databaseBytes", "databaseSha256", "kernel",
        "query", "querySha256", "revision", "threads", "variant",
    }
    if not isinstance(metadata, dict) or set(metadata) != required:
        raise GateFailure("sealed workload metadata has invalid fields")
    if (
        metadata["revision"] != "117e1a46be1c903c5a36ee3c881c125597f93c60"
        or metadata["kernel"] != "physical-filter"
        or metadata["threads"] != 1
        or metadata["variant"] not in {"filter-train", "filter-validation"}
        or database_size != metadata["databaseBytes"]
        or database_hash != metadata["databaseSha256"]
        or query_hash != metadata["querySha256"]
        or len(oracle) != 64
        or any(character not in "0123456789abcdef" for character in oracle)
    ):
        raise GateFailure("sealed workload identity mismatch")
    FIXTURE.mkdir(mode=0o755)
    OUTPUT.mkdir(mode=0o755)
    database = FIXTURE / "input.duckdb"
    query = FIXTURE / "query.sql"
    shutil.copyfile(database_files[0], database)
    query.write_bytes(query_bytes)
    os.chmod(database, 0o444)
    os.chmod(query, 0o444)
    if not unmount(ASSETS):
        raise GateFailure("sealed assets could not be hidden before candidate build")
    return metadata, oracle


def copy_sealed_file(source_path: Path, target: Path) -> None:
    if source_path.is_symlink() or not source_path.is_file():
        raise GateFailure("sealed runner input is not a regular file")
    shutil.copyfile(source_path, target)
    os.chmod(target, 0o555)


def seal_runner() -> Path:
    """Root-owned copies of the runner and its libraries: the demoted
    candidate owns everything under WORK and could re-chmod its own files,
    so nothing candidate-owned is ever executed during timing. WORK is then
    deleted outright — no candidate-writable state survives the build."""
    build_dir = SOURCE / "build" / "hone-release"
    SEALED.mkdir(mode=0o755)
    sealed_lib = SEALED / "src"
    sealed_lib.mkdir(mode=0o755)
    copy_sealed_file(build_dir / "hone-query-runner", SEALED / "hone-query-runner")
    library_dir = build_dir / "src"
    symlinks: list[tuple[Path, str]] = []
    copied = 0
    for entry in sorted(library_dir.iterdir()):
        if not entry.name.startswith("libduckdb.so"):
            continue
        if entry.is_symlink():
            symlinks.append((sealed_lib / entry.name, os.readlink(entry)))
            continue
        copy_sealed_file(entry, sealed_lib / entry.name)
        copied += 1
    if copied == 0:
        raise GateFailure("built candidate produced no duckdb shared library")
    for link_path, target_name in symlinks:
        if "/" in target_name or target_name in {".", ".."}:
            raise GateFailure("candidate shared-library symlink escapes the sealed directory")
        os.symlink(target_name, link_path)
    shutil.rmtree(WORK)
    return SEALED / "hone-query-runner"


def sweep_candidate_state() -> None:
    """Fresh state before every sample: kill demoted stragglers (a double
    fork escapes the per-sample process group), reap orphans adopted by this
    pid-1 evaluator, and clear every candidate-writable surface outside the
    trusted build root."""
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
        except OSError:
            continue
        for line in status.splitlines():
            if not line.startswith("Uid:"):
                continue
            if str(SANDBOX_UID) in line.split()[1:5]:
                try:
                    os.kill(int(entry.name), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            break
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == 0:
            break
    for base in (Path("/tmp"), Path("/dev/shm")):
        try:
            entries = list(base.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry == BUILD_ROOT:
                continue
            try:
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    entry.unlink(missing_ok=True)
            except OSError:
                pass


def run_one_sample(binary: Path, expected_hash: str, index: int) -> tuple[float, int, str]:
    sweep_candidate_state()
    rep = OUTPUT / f"rep-{index}"
    rep.mkdir(mode=0o777)
    os.chmod(rep, 0o777)
    argv = [str(binary), str(FIXTURE / "input.duckdb"), str(FIXTURE / "query.sql")]
    started_ns = time.monotonic_ns()
    process = subprocess.Popen(
        argv,
        cwd=rep,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        preexec_fn=demote,
    )
    deadline = started_ns / 1_000_000_000 + SAMPLE_TIMEOUT_SEC
    stream = process.stdout
    assert stream is not None
    os.set_blocking(stream.fileno(), False)
    chunks: list[bytes] = []
    timed_out = False
    while True:
        remaining = deadline - time.monotonic_ns() / 1_000_000_000
        if remaining <= 0:
            timed_out = True
            break
        ready, _, _ = select.select([stream], [], [], remaining)
        if not ready:
            continue
        data = stream.read()
        if data is None:
            continue
        if data == b"":
            break
        chunks.append(data)
    # Reap the direct child with kernel-reported rusage: peak RSS never
    # transits any candidate-writable file. wait4 also folds in descendants
    # the child reaped itself.
    reaped = (0, 0, None)
    while not timed_out:
        reaped = os.wait4(process.pid, os.WNOHANG)
        if reaped[0] == process.pid:
            break
        if time.monotonic_ns() / 1_000_000_000 > deadline:
            timed_out = True
            break
        time.sleep(0.002)
    elapsed = (time.monotonic_ns() - started_ns) / 1_000_000_000
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if timed_out:
        pid, status, _usage = os.wait4(process.pid, 0)
        process.returncode = status
        stream.close()
        raise GateFailure("microbenchmark sample exceeded its trusted parent timeout")
    _pid, status, usage = reaped
    # Popen must never waitpid a pid the trusted parent already reaped.
    process.returncode = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
    stream.close()
    if status != 0:
        raise GateFailure("microbenchmark process failed")
    stdout = b"".join(chunks)
    actual_hash = hashlib.sha256(stdout).hexdigest()
    if actual_hash != expected_hash:
        raise GateFailure("independent exact-result validation failed")
    peak_rss_kb = int(getattr(usage, "ru_maxrss", 0))
    if peak_rss_kb <= 0:
        raise GateFailure("trusted RSS capture was malformed")
    shutil.rmtree(rep)
    return elapsed, peak_rss_kb, actual_hash


def main() -> None:
    mounted = False
    result_hash = ""
    started = time.monotonic()
    try:
        check_source_envelope()
        mount_build_tmpfs()
        mounted = True
        metadata, oracle = load_and_seal_assets()
        identity = {
            "databaseSha256": metadata["databaseSha256"],
            "querySha256": metadata["querySha256"],
            "variant": metadata["variant"],
        }
        result_hash = hashlib.sha256(canonical(identity).encode()).hexdigest()
        run_worker("prepare", WORKSPACE, SOURCE)
        build_started = time.monotonic()
        run_worker("build")
        build_sec = time.monotonic() - build_started
        run_worker("test")
        binary = seal_runner()
        samples: list[float] = []
        rss_samples: list[int] = []
        actual_result_hash = ""
        for index in range(WARMUP_RUNS + TIMED_RUNS):
            elapsed, peak_rss_kb, actual_result_hash = run_one_sample(binary, oracle, index)
            if index >= WARMUP_RUNS:
                samples.append(elapsed)
                rss_samples.append(peak_rss_kb)
        if len(samples) != TIMED_RUNS or any(not math.isfinite(value) or value <= 0 for value in samples):
            raise GateFailure("trusted parent produced invalid latency samples")
        peak_rss_kb = max(rss_samples)
        baseline_rss_kb = metadata["baselinePeakRssKb"]
        if not isinstance(baseline_rss_kb, int) or baseline_rss_kb <= 0:
            raise GateFailure("invalid baseline RSS limit")
        if peak_rss_kb * 100 > baseline_rss_kb * 102:
            raise GateFailure(f"peak RSS gate failed: {peak_rss_kb} KiB exceeds baseline+2%")
        trimmed = sorted(samples)[:FASTEST_K]
        median_latency = statistics.median(trimmed)
        score = 1.0 / median_latency
        deterministic = {
            "databaseSha256": metadata["databaseSha256"],
            "queryResultSha256": actual_result_hash,
            "querySha256": metadata["querySha256"],
            "tests": "physical-filter-v1",
        }
        result_hash = hashlib.sha256(canonical(deterministic).encode()).hexdigest()
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "exact_result_pass": True,
                "rss_pass": True,
                "asset_hash_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": f"physical-filter exact output and upstream tests passed; reciprocal fastest-{FASTEST_K}-of-{TIMED_RUNS} median latency={score:.6f} 1/s",
                }
            },
            "diagnostics": {
                "summary": "sealed input/query hashes, independent exact output, upstream physical-filter tests, trusted parent timing, and RSS gate passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "query_result_hash": actual_result_hash,
                "median_latency_seconds": median_latency,
                "trimmed_samples_seconds": trimmed,
                "latency_samples_seconds": samples,
                "peak_rss_kb": peak_rss_kb,
                "build_sec": round(build_sec, 6),
                "runtime_sec": round(time.monotonic() - started, 6),
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except (GateFailure, OSError, ValueError, subprocess.SubprocessError) as exc:
        emit_failure(str(exc), result_hash)
    finally:
        if mounted:
            cleanup()


if __name__ == "__main__":
    main()
