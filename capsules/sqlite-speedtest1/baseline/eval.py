#!/usr/bin/env python3
"""Trusted evaluator for the terminal sqlite/sqlite speedtest1 capsule."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import resource
import shutil
import subprocess
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path("/tmp/hone-sqlite-build")
SOURCE = BUILD_ROOT / "source"
FROZEN_DIR = BUILD_ROOT / "frozen"
DATABASE_COPY = FROZEN_DIR / "speedtest.db"
SEALED_DIR = BUILD_ROOT / "sealed"
SEALED_BINARY = SEALED_DIR / "hone-sqlite-bench"
STATE_ROOT = BUILD_ROOT / "state"
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 300
ALLOWED_MUTABLE_FILES = frozenset({
    "src/btree.c", "src/expr.c", "src/main.c", "src/pager.c",
    "src/select.c", "src/sqliteInt.h", "src/vdbe.c", "src/vdbeapi.c",
    "src/vdbesort.c", "src/where.c", "src/wherecode.c",
})
REQUIRED_TESTS = ("select1.test", "index.test", "join.test", "where.test")
WORKLOADS = ("sort",)
SAMPLE_REPS = 7
SCORED_FASTEST_REPS = 3
BENCH_PATTERN = re.compile(
    r"ok workload=(sort) result=([0-9a-f]{64}) result_bytes=(\d+)"
)


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def emit_failure(detail: str, result_hash: str = "") -> None:
    safe_detail = detail.replace(str(ASSETS), "<sealed-assets>")[:1000]
    constraints = {
        "tests_pass": False,
        "result_hash_pass": False,
        "database_hash_pass": False,
        "binary_size_pass": False,
        "rss_pass": False,
    }
    output = {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": constraints,
        "perExample": {"aggregate": {"score": 0.0, "feedback": safe_detail}},
        "diagnostics": {
            "summary": safe_detail,
            "quality": 0.0,
            "result_hash": result_hash or hashlib.sha256(safe_detail.encode()).hexdigest(),
        },
    }
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


def demote() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (1792 << 20, 1792 << 20))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


def run_worker(action: str, *items: object) -> dict:
    arguments = items or (SOURCE,)
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
        raise GateFailure(f"{action} gate failed: {str(detail or 'worker failure')[:500]}")
    return payload


def mount_build_tmpfs() -> None:
    BUILD_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "tmpfs", "-o", "size=768m,mode=1777,exec,nosuid,nodev", "hone-sqlite-build", str(BUILD_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        BUILD_ROOT.rmdir()
        raise GateFailure("trusted build tmpfs mount failed")


def unmount_build_tmpfs() -> None:
    completed = subprocess.run(
        ["umount", str(BUILD_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    if completed.returncode == 0:
        BUILD_ROOT.rmdir()


def check_source_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    trusted_paths = {
        path.relative_to(TRUSTED_DIR).as_posix()
        for path in TRUSTED_DIR.rglob("*")
        if path.is_file()
    }
    for path in WORKSPACE.rglob("*"):
        if path.is_symlink():
            raise GateFailure("candidate workspace contains a symbolic link")
        if not path.is_file():
            continue
        relative = path.relative_to(WORKSPACE).as_posix()
        if relative == ".git" or relative.startswith((".git/", ".gitdir/")):
            raise GateFailure("candidate workspace contains repository history")
        if relative in trusted_paths:
            if relative.startswith("src/") and relative not in ALLOWED_MUTABLE_FILES:
                if sha256_file(path) != sha256_file(TRUSTED_DIR / relative):
                    raise GateFailure(f"protected SQLite source changed: {relative}")
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")


def copy_candidate() -> None:
    run_worker("prepare", WORKSPACE, SOURCE)
    shutil.copy2(TRUSTED_DIR / "bench.c", SOURCE / "bench.c")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def load_workload() -> tuple[dict, Path]:
    metadata_files = sorted(ASSETS.rglob("workloads.json"))
    database_files = sorted(ASSETS.rglob("speedtest.db"))
    if len(metadata_files) != 1 or len(database_files) != 1:
        raise GateFailure("selected asset split must contain one workload manifest and one database")
    try:
        metadata = json.loads(metadata_files[0].read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed workload metadata is malformed") from exc
    required = {
        "schemaVersion", "split", "sourceRevision", "fossilManifestUuid",
        "speedtest1", "database", "expected",
    }
    if not isinstance(metadata, dict) or set(metadata) != required or metadata.get("schemaVersion") != 1:
        raise GateFailure("sealed workload metadata has invalid shape")
    database = metadata.get("database")
    expected = metadata.get("expected")
    if not isinstance(database, dict) or set(database) != {"bytes", "path", "sha256"}:
        raise GateFailure("sealed database identity is invalid")
    if database.get("path") != "speedtest.db" or not isinstance(expected, dict):
        raise GateFailure("sealed workload expectation is invalid")
    if set(expected) != {"binaryMaxBytes", "peakRssMaxKiB", "resultBytes", "resultHashes"}:
        raise GateFailure("sealed expected gates are incomplete")
    path = database_files[0]
    if path.stat().st_size != database.get("bytes") or sha256_file(path) != database.get("sha256"):
        raise GateFailure("sealed database hash mismatch")
    return metadata, path


def parse_benchmark(output: object, expected_workload: str) -> tuple[str, int]:
    if not isinstance(output, str):
        raise GateFailure("benchmark output is missing")
    match = BENCH_PATTERN.fullmatch(output)
    if match is None or match.group(1) != expected_workload:
        raise GateFailure("benchmark output is malformed")
    result_bytes = int(match.group(3))
    if result_bytes <= 0:
        raise GateFailure("benchmark returned an invalid result length")
    return match.group(2), result_bytes


def reciprocal_geometric_mean_ns(values: list[int]) -> float:
    # Score the fastest repetitions: shared-host contention only ever adds
    # time, and the trusted parent supplies every sample, so a trimmed
    # fastest-subset geometric mean is robust to interference spikes while
    # staying impossible for candidate-controlled code to deflate.
    fastest = sorted(values)[:SCORED_FASTEST_REPS]
    seconds = [value / 1_000_000_000.0 for value in fastest]
    mean_seconds = math.exp(math.fsum(math.log(value) for value in seconds) / len(seconds))
    score = 1.0 / mean_seconds
    if not math.isfinite(score) or score <= 0:
        raise GateFailure("scalarizer produced a non-finite score")
    return score


def main() -> None:
    mounted = False
    result_hash = ""
    started = time.monotonic()
    try:
        check_source_envelope()
        metadata, sealed_database = load_workload()
        expected = metadata["expected"]
        database_hash = metadata["database"]["sha256"]
        identity = {
            "databaseSha256": database_hash,
            "fossilManifestUuid": metadata["fossilManifestUuid"],
            "sourceRevision": metadata["sourceRevision"],
            "split": metadata["split"],
            "speedtest1": metadata["speedtest1"],
        }
        result_hash = hashlib.sha256(canonical(identity).encode()).hexdigest()

        mount_build_tmpfs()
        mounted = True
        copy_candidate()
        build_started = time.monotonic()
        build_payload = run_worker("build")
        build_sec = time.monotonic() - build_started
        binary_bytes = build_payload.get("binaryBytes")
        if not isinstance(binary_bytes, int) or binary_bytes > expected["binaryMaxBytes"]:
            raise GateFailure("benchmark binary size exceeds the frozen baseline")
        test_payload = run_worker("test")
        commands = test_payload.get("commands")
        if not isinstance(commands, list) or len(commands) != len(REQUIRED_TESTS):
            raise GateFailure("relevant upstream test receipt is incomplete")

        FROZEN_DIR.mkdir(mode=0o755)
        shutil.copyfile(sealed_database, DATABASE_COPY)
        DATABASE_COPY.chmod(0o444)
        FROZEN_DIR.chmod(0o555)
        copied_hash = sha256_file(DATABASE_COPY)
        if copied_hash != database_hash:
            raise GateFailure("database copy hash mismatch")
        SEALED_DIR.mkdir(mode=0o755)
        shutil.copyfile(SOURCE / "hone-sqlite-bench", SEALED_BINARY)
        SEALED_BINARY.chmod(0o555)
        SEALED_DIR.chmod(0o555)
        sealed_binary_hash = sha256_file(SEALED_BINARY)
        if SEALED_BINARY.stat().st_size != binary_bytes:
            raise GateFailure("sealed benchmark binary size mismatch")

        # Let build/test load drain before the timed repetitions begin.
        time.sleep(1.0)
        STATE_ROOT.mkdir(mode=0o755)
        times_ns: list[int] = []
        observed_results: dict[str, str] = {}
        result_bytes: dict[str, int] = {}
        peak_rss_kib = 0
        for rep in range(SAMPLE_REPS):
            state_dir = STATE_ROOT / f"rep-{rep}"
            state_dir.mkdir(mode=0o777)
            state_dir.chmod(0o777)
            try:
                workload_started = time.monotonic_ns()
                benchmark_payload = run_worker(
                    "benchmark", SOURCE, SEALED_BINARY, DATABASE_COPY, state_dir
                )
                elapsed_ns = time.monotonic_ns() - workload_started
                if elapsed_ns <= 0 or elapsed_ns > 120_000_000_000:
                    raise GateFailure("trusted external timer returned an invalid duration")
                observed_result, observed_bytes = parse_benchmark(
                    benchmark_payload.get("output"), "sort"
                )
                times_ns.append(elapsed_ns)
                observed_results["sort"] = observed_result
                result_bytes["sort"] = observed_bytes
                observed_rss = benchmark_payload.get("peakRssKiB")
                if not isinstance(observed_rss, int):
                    raise GateFailure("benchmark RSS receipt is malformed")
                peak_rss_kib = max(peak_rss_kib, observed_rss)
            finally:
                shutil.rmtree(state_dir, ignore_errors=True)
        if observed_results != expected["resultHashes"] or result_bytes != expected["resultBytes"]:
            raise GateFailure("exact benchmark result hash gate failed")
        if sha256_file(DATABASE_COPY) != database_hash:
            raise GateFailure("benchmark modified the frozen database")
        if sha256_file(SEALED_BINARY) != sealed_binary_hash:
            raise GateFailure("benchmark modified the sealed binary")
        if peak_rss_kib > expected["peakRssMaxKiB"]:
            raise GateFailure("peak RSS exceeds the frozen baseline cap")

        score = reciprocal_geometric_mean_ns(times_ns)
        deterministic = {
            "binaryBytes": binary_bytes,
            "databaseSha256": database_hash,
            "resultBytes": result_bytes,
            "resultHashes": observed_results,
            "tests": list(REQUIRED_TESTS),
        }
        result_hash = hashlib.sha256(canonical(deterministic).encode()).hexdigest()
        elapsed_sec = time.monotonic() - started
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "result_hash_pass": True,
                "database_hash_pass": True,
                "binary_size_pass": True,
                "rss_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": "all exact-result, frozen-database, relevant-test, binary-size, and RSS gates passed",
                }
            },
            "diagnostics": {
                "summary": "valid selected speedtest1 workload evaluation",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(build_sec, 6),
                "eval_sec": round(elapsed_sec, 6),
                "binary_bytes": binary_bytes,
                "peak_rss_kib": peak_rss_kib,
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except (GateFailure, OSError, ValueError, TypeError) as exc:
        emit_failure(str(exc), result_hash)
    finally:
        if mounted:
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
