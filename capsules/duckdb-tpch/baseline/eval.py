#!/usr/bin/env python3
"""Trusted evaluator for the sealed duckdb TPC-H Q1/Q6/Q12 capsule."""
from __future__ import annotations

import hashlib
import json
import math
import os
import resource
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path("/tmp/hone-duckdb-build")
SOURCE = BUILD_ROOT / "source"
FIXTURE = BUILD_ROOT / "fixture"
OUTPUT = BUILD_ROOT / "output"
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 3000
TIMED_RUNS = 9
QFAIL = 0.0
ALLOWED_MUTABLE_PREFIXES = (
    "src/execution/operator/aggregate/",
    "src/execution/operator/filter/",
    "src/execution/operator/join/",
    "src/execution/operator/scan/",
    "src/include/duckdb/execution/operator/aggregate/",
    "src/include/duckdb/execution/operator/filter/",
    "src/include/duckdb/execution/operator/join/",
    "src/include/duckdb/execution/operator/scan/",
)
QUERY_FILES = ("q01.sql", "q06.sql", "q12.sql")
ANSWER_FILES = ("q01.csv", "q06.csv", "q12.csv")


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
            "exact_results_pass": False,
            "rss_pass": False,
            "database_hash_pass": False,
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
        ["mount", "-t", "tmpfs", "-o", "size=2g,mode=1777,exec,nosuid,nodev", "hone-duckdb-build", str(BUILD_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=15,
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
        timeout=15,
        check=False,
    )
    if completed.returncode == 0:
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
        if relative in trusted_paths or relative.startswith(ALLOWED_MUTABLE_PREFIXES):
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")


def load_assets() -> tuple[dict, Path]:
    metadata_files = sorted(ASSETS.rglob("workload.json"))
    database_files = sorted(ASSETS.rglob("sf1.duckdb"))
    if len(metadata_files) != 1 or len(database_files) != 1:
        raise GateFailure("selected holdout group has an invalid frozen SF1 asset set")
    try:
        metadata = json.loads(metadata_files[0].read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed workload metadata is malformed") from exc
    required = {
        "baselinePeakRssKb", "database", "databaseBytes", "databaseSha256",
        "expectedResultSha256", "generator", "queries", "revision", "scaleFactor", "threads", "variant",
    }
    if not isinstance(metadata, dict) or set(metadata) != required:
        raise GateFailure("sealed workload metadata has invalid fields")
    if (
        metadata["revision"] != "117e1a46be1c903c5a36ee3c881c125597f93c60"
        or metadata["queries"] != [1, 6, 12]
        or metadata["variant"] not in {"semantic-train", "semantic-holdout"}
    ):
        raise GateFailure("sealed workload identity mismatch")
    database = database_files[0]
    try:
        size = database.stat().st_size
        digest = hashlib.sha256(database.read_bytes()).hexdigest()
    except OSError as exc:
        raise GateFailure("frozen SF1 database is unreadable") from exc
    if size != metadata["databaseBytes"] or digest != metadata["databaseSha256"]:
        raise GateFailure("frozen SF1 database hash mismatch")
    return metadata, database


def selected_query_dir(variant: str) -> Path:
    if variant == "semantic-train":
        return SOURCE / "train_queries"
    return SOURCE / "validation_queries"


def make_fixture(database: Path, variant: str) -> None:
    FIXTURE.mkdir(mode=0o755)
    OUTPUT.mkdir(mode=0o777)
    os.chmod(OUTPUT, 0o777)
    benchmark_dir = FIXTURE / "benchmark" / "sealed"
    benchmark_dir.mkdir(parents=True, mode=0o755)
    (FIXTURE / "duckdb_benchmark_data").mkdir(mode=0o755)
    frozen = FIXTURE / "sf1.duckdb"
    shutil.copyfile(database, frozen)
    os.chmod(frozen, 0o444)
    query_dir = selected_query_dir(variant)
    answer_dir = TRUSTED_DIR / "extension" / "tpch" / "dbgen" / "answers" / "sf1"
    for query_name, answer_name in zip(QUERY_FILES, ANSWER_FILES, strict=True):
        query = query_dir / query_name
        answer = FIXTURE / answer_name
        shutil.copyfile(answer_dir / answer_name, answer)
        os.chmod(answer, 0o444)
        spec = benchmark_dir / f"{query_name}.benchmark"
        spec.write_text(
            "# name: benchmark/sealed/" + query_name + ".benchmark\n"
            "# description: frozen SF1 TPC-H query\n"
            "# group: [tpch]\n\n"
            "require tpch\n\n"
            "load\n"
            f"ATTACH '{frozen}' AS frozen (READ_ONLY);\n"
            "USE frozen;\n\n"
            f"run {query}\n\n"
            f"result {answer}\n"
        )
        os.chmod(spec, 0o444)


def make_source_readonly() -> None:
    for path in SOURCE.rglob("*"):
        try:
            mode = path.stat().st_mode
            os.chmod(path, mode & ~0o222)
        except OSError as exc:
            raise GateFailure("failed to seal built candidate tree") from exc
    os.chmod(SOURCE, SOURCE.stat().st_mode & ~0o222)


def run_candidate(argv: list[str], timeout: int, capture_stdout: bool = True) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            argv,
            cwd=SOURCE,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            preexec_fn=demote,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateFailure(f"candidate process failed: {exc}") from exc


def verify_result_hash(expected: str, variant: str) -> str:
    binary = SOURCE / "build" / "hone-release" / "hone-result-hash"
    query_dir = selected_query_dir(variant)
    completed = run_candidate(
        [str(binary), str(FIXTURE / "sf1.duckdb"), *(str(query_dir / name) for name in QUERY_FILES)],
        timeout=120,
    )
    if completed.returncode != 0:
        raise GateFailure("exact result hash helper failed")
    digest = hashlib.sha256(completed.stdout).hexdigest()
    if digest != expected:
        raise GateFailure("exact TPC-H result hash mismatch")
    return digest


def run_benchmarks() -> tuple[list[float], dict[str, int]]:
    binary = SOURCE / "build" / "hone-release" / "benchmark" / "benchmark_runner"
    medians: list[float] = []
    rss: dict[str, int] = {}
    for query_name in QUERY_FILES:
        output_path = OUTPUT / f"{query_name}.timings"
        rss_path = OUTPUT / f"{query_name}.rss"
        spec = f"benchmark/sealed/{query_name}.benchmark"
        completed = run_candidate([
            "/usr/bin/time", "-f", "%M", "-o", str(rss_path),
            str(binary), spec, "--root-dir", str(FIXTURE),
            "--threads=1", "--timed-runs", str(TIMED_RUNS), f"--out={output_path}",
        ], timeout=180, capture_stdout=False)
        if completed.returncode != 0:
            raise GateFailure(f"benchmark or exact-result comparison failed for {query_name}")
        try:
            samples = [float(value) for value in output_path.read_text().splitlines() if value.strip()]
            peak_rss = int(rss_path.read_text().strip())
        except (OSError, ValueError) as exc:
            raise GateFailure(f"malformed benchmark output for {query_name}") from exc
        if len(samples) != TIMED_RUNS or any(not math.isfinite(value) or value <= 0 for value in samples):
            raise GateFailure(f"invalid latency samples for {query_name}")
        medians.append(statistics.median(samples))
        rss[query_name] = peak_rss
    return medians, rss


def reciprocal_geomean(latencies: list[float]) -> float:
    if len(latencies) != 3 or any(not math.isfinite(value) or value <= 0 for value in latencies):
        raise GateFailure("cannot scalarize invalid latency measurements")
    return math.exp(-math.fsum(math.log(value) for value in latencies) / len(latencies))


def main() -> None:
    mounted = False
    result_hash = ""
    started = time.monotonic()
    try:
        check_source_envelope()
        metadata, database = load_assets()
        asset_identity = {
            "databaseSha256": metadata["databaseSha256"],
            "queries": metadata["queries"],
            "variant": metadata["variant"],
        }
        result_hash = hashlib.sha256(canonical(asset_identity).encode()).hexdigest()
        mount_build_tmpfs()
        mounted = True
        run_worker("prepare", WORKSPACE, SOURCE)
        make_fixture(database, metadata["variant"])
        build_started = time.monotonic()
        run_worker("build")
        build_sec = time.monotonic() - build_started
        run_worker("test")
        make_source_readonly()
        actual_result_hash = verify_result_hash(metadata["expectedResultSha256"], metadata["variant"])
        latencies, rss_by_query = run_benchmarks()
        peak_rss_kb = max(rss_by_query.values())
        baseline_rss_kb = metadata["baselinePeakRssKb"]
        if not isinstance(baseline_rss_kb, int) or baseline_rss_kb <= 0:
            raise GateFailure("invalid baseline RSS limit")
        if peak_rss_kb * 100 > baseline_rss_kb * 102:
            raise GateFailure(f"peak RSS gate failed: {peak_rss_kb} KiB exceeds baseline+2%")
        score = reciprocal_geomean(latencies)
        deterministic = {
            "databaseSha256": metadata["databaseSha256"],
            "queryResultSha256": actual_result_hash,
            "tests": "tpch-planner-executor-v1",
        }
        result_hash = hashlib.sha256(canonical(deterministic).encode()).hexdigest()
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "exact_results_pass": True,
                "rss_pass": True,
                "database_hash_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": f"Q1/Q6/Q12 exact results and planner/executor tests passed; reciprocal geometric-mean latency={score:.6f} 1/s",
                }
            },
            "diagnostics": {
                "summary": "frozen SF1 hash, exact query results, upstream planner/executor subset, and RSS gate passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "query_result_hash": actual_result_hash,
                "latency_seconds": dict(zip(("q01", "q06", "q12"), latencies, strict=True)),
                "peak_rss_kb": peak_rss_kb,
                "rss_by_query_kb": rss_by_query,
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
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
