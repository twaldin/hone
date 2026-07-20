#!/usr/bin/env python3
"""Trusted evaluator for frozen offline uv dependency resolution."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import resource
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKSPACE = Path("/workspace")
ASSETS = Path("/capsule/assets")
WORKER = TRUSTED_DIR / "worker.py"
BUILD_ROOT = Path("/tmp/hone-uv-build")
TARGET_BASE = Path("/opt/uv-target-base")
TARGET = BUILD_ROOT / "target"
SOURCE_BASE = Path("/opt/uv-resolver-src-base")
SOURCE = BUILD_ROOT / "resolver-src"
UPSTREAM_ROOT = Path("/opt/uv-root")
SANDBOX_UID = 2000
BUILD_TIMEOUT_SEC = 555
PROCESS_TIMEOUT_SEC = 30
COLD_REPETITIONS = 5
WARM_REPETITIONS = 6
Q_FAIL = 0.0
ALLOWED_PROTECTED = {
    "LICENSE-APACHE",
    "LICENSE-MIT",
    "UPSTREAM_REVISION",
    "challenge.json",
    "eval.py",
    "worker.py",
    "toolchain.lock.json",
    ".gitignore",
}
MUTABLE_PREFIX = "crates/uv-resolver/src/"


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def emit_failure(detail: str, result_hash: str = "") -> None:
    safe = detail.replace(str(ASSETS), "<sealed-assets>")[:1200]
    output = {
        "valid": False,
        "objectives": {"score": Q_FAIL},
        "constraints": {
            "tests_pass": False,
            "lockfile_pass": False,
            "distributions_pass": False,
            "rss_pass": False,
        },
        "perExample": {"aggregate": {"score": Q_FAIL, "feedback": safe}},
        "diagnostics": {
            "quality": 0.0,
            "summary": safe,
            "result_hash": result_hash or hashlib.sha256(safe.encode()).hexdigest(),
        },
    }
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


def demote() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (512 << 20, 512 << 20))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


def run_worker(action: str, *arguments: str, timeout: int) -> dict:
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(WORKER), action, *arguments],
            cwd=TRUSTED_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
            preexec_fn=demote,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateFailure(f"{action} worker failed: {exc}") from exc
    try:
        payload = json.loads(completed.stdout)
    except (UnicodeDecodeError, ValueError) as exc:
        raise GateFailure(f"{action} worker returned malformed output") from exc
    if completed.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
        detail = payload.get("detail") if isinstance(payload, dict) else "worker failure"
        raise GateFailure(f"{action} gate failed: {str(detail)[:900]}")
    return payload


def mount_build_tmpfs() -> None:
    BUILD_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        [
            "mount",
            "-t",
            "tmpfs",
            "-o",
            "size=1600m,mode=0755,uid=2000,gid=2000,nr_inodes=300000",
            "hone-uv-build",
            str(BUILD_ROOT),
        ],
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
        timeout=15,
        check=False,
    )
    if completed.returncode == 0:
        BUILD_ROOT.rmdir()


def regular_files(root: Path) -> dict[str, Path]:
    output: dict[str, Path] = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        base = Path(directory)
        for name in directories:
            path = base / name
            if path.is_symlink():
                raise GateFailure(f"candidate symlink rejected: {path.relative_to(root)}")
        for name in files:
            path = base / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink() or not path.is_file():
                raise GateFailure(f"candidate non-regular file rejected: {relative}")
            output[relative] = path
    return output


def apply_candidate() -> bool:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    files = regular_files(WORKSPACE)
    for relative in files:
        if relative in ALLOWED_PROTECTED or relative.startswith(MUTABLE_PREFIX):
            continue
        raise GateFailure(f"file outside mutable resolver envelope: {relative}")
    trusted = {
        path.relative_to(SOURCE_BASE).as_posix(): path
        for path in SOURCE_BASE.rglob("*")
        if path.is_file()
    }
    candidate = {
        relative.removeprefix(MUTABLE_PREFIX): path
        for relative, path in files.items()
        if relative.startswith(MUTABLE_PREFIX)
    }
    missing = sorted(set(trusted) - set(candidate))
    if missing:
        raise GateFailure(f"mutable resolver source is incomplete: {missing[0]}")
    changed = False
    for relative, candidate_path in candidate.items():
        destination = SOURCE / relative
        if relative in trusted and candidate_path.read_bytes() == trusted[relative].read_bytes():
            continue
        changed = True
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            destination.unlink()
        destination.write_bytes(candidate_path.read_bytes())
    return changed


def load_assets() -> tuple[dict, Path, dict, Path]:
    workload_files = sorted(ASSETS.rglob("workloads.json"))
    index_files = sorted(ASSETS.rglob("index-manifest.json"))
    if len(workload_files) != 1 or len(index_files) != 1:
        raise GateFailure("selected asset group is incomplete")
    try:
        workloads = json.loads(workload_files[0].read_text())
        index = json.loads(index_files[0].read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed resolver metadata is malformed") from exc
    if workloads.get("format") != "uv-resolver-workloads-v1" or len(workloads.get("workloads", [])) != 2:
        raise GateFailure("sealed resolver workload shape is invalid")
    if index.get("format") != "pep503-frozen-wheel-index-v1":
        raise GateFailure("sealed package index manifest is invalid")
    return workloads, workload_files[0].parent, index, index_files[0].parent


def verify_index(index: dict, index_root: Path) -> None:
    expected: set[str] = set()
    for project, rows in index.get("projects", {}).items():
        if not isinstance(project, str) or not isinstance(rows, list):
            raise GateFailure("sealed index project entry is malformed")
        for row in rows:
            filename = row.get("filename")
            expected_hash = row.get("sha256")
            if not isinstance(filename, str) or not isinstance(expected_hash, str):
                raise GateFailure("sealed index distribution entry is malformed")
            path = index_root / "files" / filename
            if not path.is_file() or sha256(path) != expected_hash or path.stat().st_size != row.get("bytes"):
                raise GateFailure(f"sealed index distribution hash mismatch: {filename}")
            expected.add(filename)
    actual = {path.name for path in (index_root / "files").iterdir() if path.is_file()}
    if actual != expected:
        raise GateFailure("sealed index distribution set mismatch")


def verify_workloads(metadata: dict, split_root: Path, index: dict) -> str:
    index_rows = {
        row["filename"]: row["sha256"]
        for rows in index["projects"].values()
        for row in rows
    }
    identity: list[dict] = []
    for row in metadata["workloads"]:
        required = {
            "id",
            "requirements",
            "expectedLock",
            "expectedLockSha256",
            "selectedDistributions",
            "baselinePeakRssKb",
        }
        if not required.issubset(row) or not isinstance(row["baselinePeakRssKb"], int):
            raise GateFailure("sealed workload entry is malformed")
        requirement = split_root / row["requirements"]
        expected_lock = split_root / row["expectedLock"]
        if not requirement.is_file() or not expected_lock.is_file():
            raise GateFailure("sealed workload bytes are missing")
        if sha256(expected_lock) != row["expectedLockSha256"]:
            raise GateFailure(f"sealed expected lock hash mismatch: {row['id']}")
        for distribution in row["selectedDistributions"]:
            if index_rows.get(distribution.get("filename")) != distribution.get("sha256"):
                raise GateFailure(f"sealed selected distribution mismatch: {row['id']}")
        identity.append(
            {
                "id": row["id"],
                "requirementsSha256": sha256(requirement),
                "lockSha256": row["expectedLockSha256"],
                "selected": row["selectedDistributions"],
            }
        )
    return hashlib.sha256(canonical(identity).encode()).hexdigest()


def fork_exec(argv: list[str], environment: dict[str, str], timeout: int) -> tuple[int, float, int]:
    started = time.monotonic_ns()
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            devnull = os.open(os.devnull, os.O_RDWR)
            os.dup2(devnull, 0)
            os.dup2(devnull, 1)
            os.dup2(devnull, 2)
            if devnull > 2:
                os.close(devnull)
            demote()
            os.execve(argv[0], argv, environment)
        except BaseException:
            os._exit(127)
    deadline = time.monotonic() + timeout
    status: int | None = None
    usage = None
    while time.monotonic() < deadline:
        waited, current_status, current_usage = os.wait4(pid, os.WNOHANG)
        if waited == pid:
            status, usage = current_status, current_usage
            break
        time.sleep(0.001)
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _, status, usage = os.wait4(pid, 0)
        raise GateFailure("resolver process timed out")
    elapsed_ms = (time.monotonic_ns() - started) / 1_000_000
    exit_code = os.waitstatus_to_exitcode(status)
    peak_rss_kb = int(usage.ru_maxrss) if usage is not None else 0
    return exit_code, elapsed_ms, peak_rss_kb


def resolution_command(binary: Path, requirement: Path, output: Path, cache: Path, index_root: Path) -> list[str]:
    return [
        str(binary),
        "pip",
        "compile",
        str(requirement),
        "--default-index",
        (index_root / "simple").as_uri(),
        "--offline",
        "--only-binary",
        ":all:",
        "--python-version",
        "3.12",
        "--python-platform",
        "linux",
        "--cache-dir",
        str(cache),
        "--output-file",
        str(output),
        "--no-header",
        "--no-annotate",
        "--generate-hashes",
        "--no-python-downloads",
        "--quiet",
    ]


def geometric_mean(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("resolver timing sample is invalid")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def run_workloads(binary: Path, metadata: dict, split_root: Path, index_root: Path) -> tuple[dict, dict, int]:
    bench_root = BUILD_ROOT / "bench"
    local_index = bench_root / "index"
    shutil.copytree(index_root, local_index)
    os.chmod(bench_root, 0o777)
    for directory, _, files in os.walk(local_index):
        os.chmod(directory, 0o755)
        for filename in files:
            os.chmod(Path(directory) / filename, 0o644)
    environment = {
        "HOME": str(bench_root / "home"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "UV_NO_PROGRESS": "1",
        "UV_PYTHON_DOWNLOADS": "never",
    }
    Path(environment["HOME"]).mkdir(mode=0o777)
    os.chmod(environment["HOME"], 0o777)
    scores: dict[str, float] = {}
    measurements: dict[str, dict] = {}
    maximum_rss = 0
    for row in metadata["workloads"]:
        work = bench_root / row["id"]
        work.mkdir(mode=0o777)
        os.chmod(work, 0o777)
        requirement = work / "requirements.in"
        shutil.copy2(split_root / row["requirements"], requirement)
        os.chmod(requirement, 0o644)
        expected = (split_root / row["expectedLock"]).read_bytes()
        rss_limit = math.floor(row["baselinePeakRssKb"] * 1.02)
        for mode, repetitions in (("cold", COLD_REPETITIONS), ("warm", WARM_REPETITIONS)):
            cache = work / f"cache-{mode}"
            output = work / f"{mode}.lock"
            if mode == "warm":
                cache.mkdir(mode=0o755)
                os.chmod(cache, 0o777)
                command = resolution_command(binary, requirement, output, cache, local_index)
                code, _, _ = fork_exec(command, environment, PROCESS_TIMEOUT_SEC)
                if code != 0 or output.read_bytes() != expected:
                    raise GateFailure(f"warm-prime lockfile gate failed: {row['id']}")
            times: list[float] = []
            peaks: list[int] = []
            for _ in range(repetitions):
                if mode == "cold":
                    shutil.rmtree(cache, ignore_errors=True)
                    cache.mkdir(mode=0o755)
                    os.chmod(cache, 0o777)
                if output.exists():
                    output.unlink()
                command = resolution_command(binary, requirement, output, cache, local_index)
                code, elapsed_ms, peak_rss = fork_exec(command, environment, PROCESS_TIMEOUT_SEC)
                if code != 0 or not output.is_file() or output.read_bytes() != expected:
                    raise GateFailure(f"exact lockfile gate failed: {row['id']}:{mode}")
                if peak_rss <= 0 or peak_rss > rss_limit:
                    raise GateFailure(
                        f"peak RSS gate failed: {row['id']}:{mode} {peak_rss}KiB > {rss_limit}KiB"
                    )
                times.append(elapsed_ms)
                peaks.append(peak_rss)
            score = 1000.0 / geometric_mean(times)
            if not math.isfinite(score) or score <= 0:
                raise GateFailure("resolver scalar is non-finite")
            key = f"{row['id']}:{mode}"
            scores[key] = score
            measurements[key] = {"milliseconds": times, "peakRssKb": peaks}
            maximum_rss = max(maximum_rss, *peaks)
    return scores, measurements, maximum_rss


def main() -> None:
    mounted = False
    result_hash = ""
    try:
        metadata, split_root, index, index_root = load_assets()
        verify_index(index, index_root)
        result_hash = verify_workloads(metadata, split_root, index)
        mount_build_tmpfs()
        mounted = True
        run_worker(
            "prepare",
            str(TARGET_BASE),
            str(TARGET),
            str(SOURCE_BASE),
            str(SOURCE),
            timeout=45,
        )
        changed = apply_candidate()
        build_started = time.monotonic()
        built = run_worker(
            "build",
            str(UPSTREAM_ROOT),
            str(TARGET),
            "1" if changed else "0",
            timeout=BUILD_TIMEOUT_SEC,
        )
        build_sec = time.monotonic() - build_started
        binary = Path(built["binary"])
        scores, measurements, peak_rss = run_workloads(binary, metadata, split_root, index_root)
        scalar = 1000.0 / geometric_mean(
            [sample for value in measurements.values() for sample in value["milliseconds"]]
        )
        if not math.isfinite(scalar) or scalar <= Q_FAIL:
            raise GateFailure("oriented resolver scalar is invalid")
        output = {
            "valid": True,
            "objectives": {"score": scalar},
            "constraints": {
                "tests_pass": True,
                "lockfile_pass": True,
                "distributions_pass": True,
                "rss_pass": True,
            },
            "perExample": {
                key: {"score": value, "feedback": f"offline {key} resolution passed exact gates"}
                for key, value in scores.items()
            },
            "diagnostics": {
                "quality": 1.0,
                "result_hash": result_hash,
                "summary": "offline locks, selected wheel hashes, resolver tests, and RSS gate passed",
                "build_sec": build_sec,
                "peak_rss_kb": peak_rss,
                "measurements": measurements,
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except GateFailure as exc:
        emit_failure(str(exc), result_hash)
    except BaseException as exc:
        emit_failure(f"evaluator internal failure: {type(exc).__name__}", result_hash)
    finally:
        if mounted:
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
