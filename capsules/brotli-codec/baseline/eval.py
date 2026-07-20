#!/usr/bin/env python3
"""Trusted evaluator for the current-head google/brotli throughput capsule."""
from __future__ import annotations

import hashlib
import json
import math
import os
import resource
import shutil
import stat
import subprocess
import tempfile
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path("/tmp/hone-brotli-build")
SOURCE = BUILD_ROOT / "source"
SANDBOX_UID = 2000
BENCH_TARGET_MS = 125
PROCESS_TIMEOUT_SEC = 240
ALLOWED_MUTABLE_PREFIXES = ("c/common/", "c/dec/", "c/enc/")
REQUIRED_KINDS = frozenset({"binary", "text", "web"})
QUALITIES = (4, 9)
DECODE_UID = 2001
# The container mounts /tmp noexec; the sealed harness and per-run working
# directories must live under the build tmpfs, which is mounted exec.
SEALED_DIR = BUILD_ROOT / "sealed"
SEALED_BIN = SEALED_DIR / "hone-brotli-bench"
RUN_ROOT = BUILD_ROOT / "runs"
# Standard upstream brotli streams used to cross-check the candidate decoder in
# isolation from the candidate encoder (independent-oracle gaming resistance).
DECODER_VECTORS = ("quickfox", "ukkonooa", "10x10y", "xyzzy")


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def emit_failure(detail: str, result_hash: str = "") -> None:
    safe_detail = detail.replace(str(ASSETS), "<sealed-assets>")[:1000]
    output = {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": {
            "tests_pass": False,
            "round_trip_pass": False,
            "compressed_size_pass": False,
        },
        "perExample": {"aggregate": {"score": 0.0, "feedback": safe_detail}},
        "diagnostics": {
            "summary": safe_detail,
            "quality": 0.0,
            "result_hash": result_hash or hashlib.sha256(safe_detail.encode()).hexdigest(),
        },
    }
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


def _apply_rlimits() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (1536 << 20, 1536 << 20))


def demote() -> None:
    _apply_rlimits()
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


def run_worker(action: str, *paths: Path) -> dict:
    arguments = paths or (SOURCE,)
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(WORKER), action, *(str(path) for path in arguments)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=PROCESS_TIMEOUT_SEC,
            check=False,
            preexec_fn=demote,
            cwd=TRUSTED_DIR,
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
        ["mount", "-t", "tmpfs", "-o", "size=768m,mode=1777,exec,nosuid,nodev", "hone-brotli-build", str(BUILD_ROOT)],
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


def is_mutable(relative: str) -> bool:
    return relative.startswith(ALLOWED_MUTABLE_PREFIXES)


def same_bytes(left: Path, right: Path) -> bool:
    try:
        if left.stat().st_size != right.stat().st_size:
            return False
        with left.open("rb") as left_file, right.open("rb") as right_file:
            while True:
                left_chunk = left_file.read(1 << 20)
                right_chunk = right_file.read(1 << 20)
                if left_chunk != right_chunk:
                    return False
                if not left_chunk:
                    return True
    except OSError:
        return False


def check_source_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    trusted_paths: dict[str, Path] = {}
    for path in TRUSTED_DIR.rglob("*"):
        try:
            mode = path.lstat().st_mode
        except OSError as exc:
            raise GateFailure("trusted baseline cannot be inspected") from exc
        if not stat.S_ISDIR(mode):
            trusted_paths[path.relative_to(TRUSTED_DIR).as_posix()] = path

    candidate_paths: dict[str, Path] = {}
    workspace_resolved = WORKSPACE.resolve()
    for path in WORKSPACE.rglob("*"):
        relative = path.relative_to(WORKSPACE).as_posix()
        try:
            mode = path.lstat().st_mode
        except OSError as exc:
            raise GateFailure(f"candidate path cannot be inspected: {relative}") from exc
        if stat.S_ISDIR(mode):
            continue
        candidate_paths[relative] = path
        if stat.S_ISLNK(mode):
            trusted_path = trusted_paths.get(relative)
            if trusted_path is None or not stat.S_ISLNK(trusted_path.lstat().st_mode):
                raise GateFailure(f"candidate symlink is forbidden: {relative}")
            if os.readlink(path) != os.readlink(trusted_path):
                raise GateFailure(f"protected symlink differs from baseline: {relative}")
            try:
                path.resolve(strict=True).relative_to(workspace_resolved)
            except (OSError, ValueError) as exc:
                raise GateFailure(f"candidate symlink escapes workspace: {relative}") from exc
            continue
        if not stat.S_ISREG(mode):
            raise GateFailure(f"non-regular candidate path is forbidden: {relative}")
        if relative not in trusted_paths and not is_mutable(relative):
            raise GateFailure(f"file outside mutable source envelope: {relative}")

    for relative, trusted_path in trusted_paths.items():
        if is_mutable(relative):
            continue
        candidate_path = candidate_paths.get(relative)
        if candidate_path is None:
            raise GateFailure(f"protected source differs from baseline: {relative}")
        trusted_mode = trusted_path.lstat().st_mode
        candidate_mode = candidate_path.lstat().st_mode
        if stat.S_ISLNK(trusted_mode):
            if not stat.S_ISLNK(candidate_mode) or os.readlink(candidate_path) != os.readlink(trusted_path):
                raise GateFailure(f"protected symlink differs from baseline: {relative}")
        elif not stat.S_ISREG(candidate_mode) or not same_bytes(candidate_path, trusted_path):
            raise GateFailure(f"protected source differs from baseline: {relative}")


def copy_candidate() -> None:
    run_worker("prepare", WORKSPACE, SOURCE)
    shutil.copy2(TRUSTED_DIR / "bench.c", SOURCE / "bench.c")


def seal_binary() -> None:
    """Copy the freshly built candidate benchmark to a root-owned path so it
    cannot be swapped (e.g. via /proc/self/exe) between measured runs. The
    evaluator container grants no CAP_CHOWN, so ownership is left as the
    creating root identity (already the sealing identity we want)."""
    SEALED_DIR.mkdir(mode=0o755, parents=True, exist_ok=True)
    RUN_ROOT.mkdir(mode=0o755, exist_ok=True)
    os.chmod(SEALED_DIR, 0o755)
    os.chmod(RUN_ROOT, 0o755)
    built = SOURCE / "hone-brotli-bench"
    if not built.is_file():
        raise GateFailure("benchmark binary was not built")
    if SEALED_BIN.exists():
        SEALED_BIN.unlink()
    shutil.copy2(built, SEALED_BIN)
    os.chmod(SEALED_BIN, 0o755)


def run_bench(mode_args: list[str], stdin_bytes: bytes, uid: int, timeout: int = 90) -> tuple[int, bytes, str]:
    """Run the sealed benchmark as `uid` in a fresh private working directory.
    The result envelope arrives over a dedicated pipe the candidate cannot
    address, and stdout carries the raw codec bytes for out-of-process
    validation by the trusted parent."""
    cwd = Path(tempfile.mkdtemp(dir=str(RUN_ROOT)))
    read_fd, write_fd = os.pipe()
    os.set_inheritable(write_fd, True)

    def preexec() -> None:
        _apply_rlimits()
        if os.geteuid() == 0:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)

    try:
        # Root-owned, world-traversable but not world-writable: the dropped
        # candidate uid can enter and execute but cannot leave artifacts here.
        os.chmod(cwd, 0o755)
        argv = [str(SEALED_BIN), mode_args[0], str(write_fd), *mode_args[1:]]
        completed = subprocess.run(
            argv,
            input=stdin_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
            preexec_fn=preexec,
            cwd=str(cwd),
            pass_fds=(write_fd,),
        )
        os.close(write_fd)
        write_fd = -1
        report = b""
        while True:
            chunk = os.read(read_fd, 4096)
            if not chunk:
                break
            report += chunk
        return completed.returncode, completed.stdout, report.decode("ascii", "replace")
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateFailure(f"benchmark process failed: {exc}") from exc
    finally:
        if write_fd != -1:
            os.close(write_fd)
        os.close(read_fd)
        shutil.rmtree(cwd, ignore_errors=True)


def check_decoder_reference() -> None:
    """Cross-check the candidate decoder against sealed upstream brotli vectors
    in a process that never receives any source, so a decoder cannot fake a
    round trip by echoing a colluding encoder's saved input."""
    vector_dir = TRUSTED_DIR / "tests" / "testdata"
    for name in DECODER_VECTORS:
        try:
            plaintext = (vector_dir / name).read_bytes()
            compressed = (vector_dir / f"{name}.compressed").read_bytes()
        except OSError as exc:
            raise GateFailure("trusted decoder vectors are missing") from exc
        returncode, decoded, _ = run_bench(
            ["d", str(len(plaintext)), str(len(compressed)), "4", "20"],
            compressed,
            DECODE_UID,
            timeout=60,
        )
        if returncode != 0 or decoded != plaintext:
            raise GateFailure(f"candidate decoder failed standard vector: {name}")


def load_workloads() -> tuple[dict, Path]:
    metadata_files = sorted(ASSETS.rglob("workloads.json"))
    if len(metadata_files) != 1:
        raise GateFailure("selected asset split must contain exactly one workloads.json")
    metadata_path = metadata_files[0]
    try:
        metadata = json.loads(metadata_path.read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed workload metadata is malformed") from exc
    if not isinstance(metadata, dict) or set(metadata) != {"generator", "seed", "workloads"}:
        raise GateFailure("sealed workload metadata has invalid shape")
    rows = metadata["workloads"]
    if not isinstance(rows, list) or len(rows) != 3:
        raise GateFailure("sealed workload categories are incomplete")
    if {row.get("id") for row in rows if isinstance(row, dict)} != REQUIRED_KINDS:
        raise GateFailure("sealed workload identities are incomplete")
    return metadata, metadata_path.parent


def verify_workload(row: dict, split_dir: Path) -> bytes:
    if set(row) != {"bytes", "expectedCompressedBytes", "id", "path", "sha256"}:
        raise GateFailure("sealed workload entry has invalid fields")
    if row["id"] not in REQUIRED_KINDS or not isinstance(row["path"], str):
        raise GateFailure("sealed workload identity is invalid")
    path = split_dir / row["path"]
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise GateFailure("sealed workload bytes are missing") from exc
    if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
        raise GateFailure("sealed workload hash mismatch")
    sizes = row["expectedCompressedBytes"]
    if not isinstance(sizes, dict) or set(sizes) != {"4", "9"}:
        raise GateFailure("sealed baseline sizes are missing")
    if any(not isinstance(sizes[str(quality)], int) or sizes[str(quality)] <= 0 for quality in QUALITIES):
        raise GateFailure("sealed baseline size is invalid")
    return data


def run_benchmark(data: bytes, quality: int) -> tuple[int, float, float]:
    encode_rc, compressed, encode_report = run_bench(
        ["c", str(len(data)), str(quality), str(BENCH_TARGET_MS)],
        data,
        SANDBOX_UID,
    )
    if encode_rc != 0:
        raise GateFailure(f"compression benchmark failed at quality {quality}")
    encode_fields = encode_report.split()
    if len(encode_fields) != 2:
        raise GateFailure(f"compression report malformed at quality {quality}")
    try:
        reported_size = int(encode_fields[0])
        compression_mib_s = float(encode_fields[1]) / 1000000.0
    except ValueError as exc:
        raise GateFailure(f"compression report malformed at quality {quality}") from exc
    compressed_size = len(compressed)
    if compressed_size <= 0 or reported_size != compressed_size:
        raise GateFailure(f"reported compressed size is inconsistent at quality {quality}")

    decode_rc, decoded, decode_report = run_bench(
        ["d", str(len(data)), str(compressed_size), str(quality), str(BENCH_TARGET_MS)],
        compressed,
        DECODE_UID,
    )
    if decode_rc != 0:
        raise GateFailure(f"decompression benchmark failed at quality {quality}")
    decode_fields = decode_report.split()
    if len(decode_fields) != 1:
        raise GateFailure(f"decompression report malformed at quality {quality}")
    try:
        decompression_mib_s = float(decode_fields[0]) / 1000000.0
    except ValueError as exc:
        raise GateFailure(f"decompression report malformed at quality {quality}") from exc
    if decoded != data:
        raise GateFailure(f"independent round-trip mismatch at quality {quality}")
    if not all(math.isfinite(value) and value > 0 for value in (compression_mib_s, decompression_mib_s)):
        raise GateFailure(f"benchmark returned non-finite throughput at quality {quality}")
    return compressed_size, compression_mib_s, decompression_mib_s


def geometric_mean(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("cannot scalarize invalid throughput")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def main() -> None:
    mounted = False
    result_hash = ""
    started = time.monotonic()
    try:
        check_source_envelope()
        metadata, split_dir = load_workloads()
        workload_bytes = [(row, verify_workload(row, split_dir)) for row in metadata["workloads"]]
        identity = {
            "generator": metadata["generator"],
            "seed": metadata["seed"],
            "workloads": [
                {"id": row["id"], "sha256": row["sha256"], "bytes": row["bytes"]}
                for row, _ in workload_bytes
            ],
        }
        result_hash = hashlib.sha256(canonical(identity).encode()).hexdigest()

        mount_build_tmpfs()
        mounted = True
        copy_candidate()
        build_started = time.monotonic()
        run_worker("build")
        build_sec = time.monotonic() - build_started
        run_worker("test")
        seal_binary()
        check_decoder_reference()

        throughputs: list[float] = []
        compressed_sizes: dict[str, int] = {}
        for row, data in workload_bytes:
            for quality in QUALITIES:
                compressed_size, compression_mib_s, decompression_mib_s = run_benchmark(data, quality)
                baseline_size = row["expectedCompressedBytes"][str(quality)]
                if compressed_size * 400 > baseline_size * 401:
                    raise GateFailure(
                        f"compressed-size gate failed for {row['id']} quality {quality}: "
                        f"{compressed_size} > baseline+0.25%"
                    )
                compressed_sizes[f"{row['id']}:Q{quality}"] = compressed_size
                throughputs.extend((compression_mib_s, decompression_mib_s))

        score = geometric_mean(throughputs)
        deterministic = {"identity": identity, "compressedSizes": compressed_sizes, "tests": "ctest-28-v1"}
        result_hash = hashlib.sha256(canonical(deterministic).encode()).hexdigest()
        elapsed_sec = time.monotonic() - started
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "round_trip_pass": True,
                "compressed_size_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": f"12 compression/decompression throughput cells passed all hard gates; q={score:.3f} MiB/s",
                }
            },
            "diagnostics": {
                "summary": "28 upstream CTest cases passed; exact round trips and size limits passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(build_sec, 6),
                "runtime_sec": round(elapsed_sec, 6),
                "throughput_cells": 12,
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except (GateFailure, OSError, subprocess.SubprocessError, ValueError) as exc:
        emit_failure(str(exc), result_hash)
    finally:
        if mounted:
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
