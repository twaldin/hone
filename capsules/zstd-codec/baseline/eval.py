#!/usr/bin/env python3
"""Trusted evaluator for the current-head facebook/zstd throughput capsule."""
from __future__ import annotations

import hashlib
import json
import math
import os
import resource
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path("/tmp/hone-zstd-build")
SOURCE = BUILD_ROOT / "source"
REFERENCE = BUILD_ROOT / "reference"
TRUSTED_BIN_DIR = BUILD_ROOT / "trusted-bin"
TRUSTED_BENCH = TRUSTED_BIN_DIR / "hone-zstd-bench"
CANDIDATE_BIN_DIR = BUILD_ROOT / "candidate-bin"
CANDIDATE_BENCH = CANDIDATE_BIN_DIR / "hone-zstd-bench"
SCRATCH_ROOT = BUILD_ROOT / "scratch"
SANDBOX_UID = 2000
BENCH_TARGET_MS = 200
SAMPLE_COUNT = 3
MAX_REPS = 1 << 24
SAMPLE_TIMEOUT_SEC = 45
PROCESS_TIMEOUT_SEC = 240
ALLOWED_MUTABLE_PREFIXES = ("lib/common/", "lib/compress/", "lib/decompress/")
REQUIRED_KINDS = frozenset({"binary", "json", "repetitive", "text"})
LEVELS = (1, 3)

_SCRATCH_SEQUENCE = 0


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


def demote() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (1536 << 20, 1536 << 20))
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
        ["mount", "-t", "tmpfs", "-o", "size=768m,mode=1777,exec,nosuid,nodev", "hone-zstd-build", str(BUILD_ROOT)],
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


def copy_candidate() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    run_worker("prepare", WORKSPACE, SOURCE)
    # The harness is always sourced from the trusted baseline, independent of
    # the candidate artifact even though the broker also diff-protects it.
    shutil.copy2(TRUSTED_DIR / "bench.c", SOURCE / "bench.c")


def check_source_envelope() -> None:
    trusted_paths = {
        path.relative_to(TRUSTED_DIR).as_posix()
        for path in TRUSTED_DIR.rglob("*")
        if path.is_file()
    }
    for path in WORKSPACE.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(WORKSPACE).as_posix()
        if relative in trusted_paths or relative.startswith(ALLOWED_MUTABLE_PREFIXES):
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")


def load_workloads() -> tuple[dict, Path]:
    metadata_files = sorted(ASSETS.rglob("workloads.json"))
    if len(metadata_files) != 1:
        raise GateFailure("selected asset split must contain exactly one workloads.json")
    metadata_path = metadata_files[0]
    try:
        metadata = json.loads(metadata_path.read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed workload metadata is malformed") from exc
    if not isinstance(metadata, dict) or not isinstance(metadata.get("workloads"), list):
        raise GateFailure("sealed workload metadata has invalid shape")
    rows = metadata["workloads"]
    if len(rows) != 4 or {row.get("id") for row in rows if isinstance(row, dict)} != REQUIRED_KINDS:
        raise GateFailure("sealed workload categories are incomplete")
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
    if not isinstance(sizes, dict) or set(sizes) != {"1", "3"}:
        raise GateFailure("sealed baseline sizes are missing")
    if any(not isinstance(sizes[str(level)], int) or sizes[str(level)] <= 0 for level in LEVELS):
        raise GateFailure("sealed baseline size is invalid")
    return data


def fresh_scratch() -> Path:
    """Fresh writable directory per runner invocation so no sample can
    inherit state left behind by an earlier one."""
    global _SCRATCH_SEQUENCE
    _SCRATCH_SEQUENCE += 1
    directory = SCRATCH_ROOT / f"run-{_SCRATCH_SEQUENCE}"
    directory.mkdir(mode=0o700)
    # The eval container has no CAP_CHOWN; a plain owner chmod makes the
    # fresh directory writable for the demoted runner.
    os.chmod(directory, 0o777)
    return directory


def reap_sandbox_processes() -> None:
    """Kill every process still running under the sandbox uid so nothing a
    build or test phase left behind can touch later phases."""
    if os.geteuid() != 0:
        return
    script = (
        "import os\n"
        "os.setgroups([])\n"
        f"os.setgid({SANDBOX_UID})\n"
        f"os.setuid({SANDBOX_UID})\n"
        "try:\n"
        "    os.kill(-1, 9)\n"
        "except ProcessLookupError:\n"
        "    pass\n"
    )
    subprocess.run(
        [sys.executable, "-I", "-B", "-c", script],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )


def seal_binary(built: Path, sealed_dir: Path) -> Path:
    """Copy a built runner into an evaluator-owned directory. The sealed copy
    cannot be replaced or modified by the sandbox uid between samples."""
    if not built.is_file() or built.stat().st_size == 0:
        raise GateFailure("benchmark binary missing after build")
    sealed_dir.mkdir(mode=0o755)
    sealed = sealed_dir / "hone-zstd-bench"
    sealed.write_bytes(built.read_bytes())
    os.chmod(sealed, 0o555)
    return sealed


def run_runner(binary: Path, arguments: list[str], payload: bytes, expected_size: int | None) -> tuple[int, bytes]:
    """Run one sealed runner invocation and measure its whole lifetime on the
    trusted evaluator clock. The runner is candidate-linked and contains no
    clock reads; nothing it prints or does can alter this measurement."""
    scratch = fresh_scratch()
    environment = {"PATH": "/usr/bin:/bin", "TMPDIR": str(scratch)}
    started = time.perf_counter_ns()
    try:
        process = subprocess.Popen(
            [str(binary), *arguments],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            preexec_fn=demote,
            start_new_session=True,
            cwd=scratch,
            env=environment,
        )
    except OSError as exc:
        raise GateFailure(f"benchmark runner failed to start: {exc}") from exc
    try:
        stdout, _ = process.communicate(payload, timeout=SAMPLE_TIMEOUT_SEC)
    except subprocess.TimeoutExpired as exc:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            process.kill()
        process.communicate()
        raise GateFailure("benchmark sample exceeded its wall-clock limit") from exc
    elapsed_ns = time.perf_counter_ns() - started
    if process.returncode != 0:
        raise GateFailure(f"benchmark runner exited {process.returncode}")
    if not stdout:
        raise GateFailure("benchmark runner emitted no output")
    if expected_size is not None and len(stdout) != expected_size:
        raise GateFailure("benchmark runner emitted an unexpected byte count")
    return max(elapsed_ns, 1), stdout


def trusted_compress(data: bytes, level: int, expected_size: int) -> bytes:
    frame = run_runner(TRUSTED_BENCH, ["compress", str(len(data)), str(level), "1"], data, None)[1]
    if len(frame) != expected_size:
        raise GateFailure("trusted reference frame size mismatched the sealed baseline size")
    return frame


def trusted_decode(frame: bytes, decoded_size: int) -> bytes:
    return run_runner(TRUSTED_BENCH, ["decompress", str(len(frame)), str(decoded_size), "1"], frame, decoded_size)[1]


def trusted_round_trip(frame: bytes, data: bytes) -> None:
    if trusted_decode(frame, len(data)) != data:
        raise GateFailure("compressed output failed the trusted reference round trip")


def trusted_stamped_frame(data: bytes, level: int, phase: int) -> bytes:
    """Trusted-encoder frame over the stamped content of iteration `phase`.

    The sealed trusted runner applies the identical stamp_iteration rotation
    (one repetition starting at `phase`), so this reconstructs — through the
    single stamp implementation shared with the candidate-linked runner's
    trusted source — the exact bytes the candidate compressed on that timed
    iteration."""
    return run_runner(TRUSTED_BENCH, ["compress", str(len(data)), str(level), "1", str(phase)], data, None)[1]


def throughput_mib(work_bytes: int, repetitions: int, elapsed_ns: int) -> float:
    return (work_bytes * repetitions * 1_000_000_000) / (elapsed_ns * 1048576)


def measure_cell(mode: str, payload: bytes, parameter: int, work_bytes: int, expected_size: int | None) -> tuple[float, bytes, int]:
    """Median throughput for one benchmark cell, timed entirely in this
    trusted process. Repetition count is calibrated by re-running the sealed
    candidate runner until one invocation spans the target wall window.
    Compression cells run with identity rotation (phase 0): every timed
    iteration compresses distinct stamped content, so a content-keyed cache
    of earlier results can never replay a timed iteration. The calibrated
    repetition count is returned so the caller can reconstruct the final
    iteration's content for the trusted output gates."""
    target_ns = BENCH_TARGET_MS * 1_000_000
    rotation = ["0"] if mode == "compress" else []

    def sample(repetitions: int) -> tuple[int, bytes]:
        return run_runner(
            CANDIDATE_BENCH,
            [mode, str(len(payload)), str(parameter), str(repetitions), *rotation],
            payload,
            expected_size,
        )

    repetitions = 1
    elapsed_ns, reference = sample(repetitions)
    while elapsed_ns < target_ns and repetitions < MAX_REPS:
        scale = min(32.0, (target_ns / elapsed_ns) * 1.25)
        repetitions = min(MAX_REPS, max(repetitions + 1, int(repetitions * scale)))
        elapsed_ns, reference = sample(repetitions)
    samples: list[float] = []
    for _ in range(SAMPLE_COUNT):
        elapsed_ns, observed = sample(repetitions)
        if observed != reference:
            raise GateFailure("benchmark output drifted across repeated samples")
        samples.append(throughput_mib(work_bytes, repetitions, elapsed_ns))
    samples.sort()
    return samples[SAMPLE_COUNT // 2], reference, repetitions


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
            "generator": metadata.get("generator"),
            "seed": metadata.get("seed"),
            "workloads": [
                {"id": row["id"], "sha256": row["sha256"], "bytes": row["bytes"]}
                for row, _ in workload_bytes
            ],
        }
        result_hash = hashlib.sha256(canonical(identity).encode()).hexdigest()

        mount_build_tmpfs()
        mounted = True
        SCRATCH_ROOT.mkdir(mode=0o755)

        # Trusted reference runner: pristine baseline sources, sealed before
        # any candidate code runs. It validates candidate round trips and
        # produces the fixed decompression inputs for every candidate.
        run_worker("prepare", TRUSTED_DIR, REFERENCE)
        run_worker("refbuild", REFERENCE)
        reap_sandbox_processes()
        seal_binary(REFERENCE / "hone-zstd-bench", TRUSTED_BIN_DIR)
        trusted_frames: dict[tuple[str, int], bytes] = {}
        for row, data in workload_bytes:
            for level in LEVELS:
                trusted_frames[(row["id"], level)] = trusted_compress(
                    data, level, row["expectedCompressedBytes"][str(level)]
                )

        copy_candidate()
        build_started = time.monotonic()
        run_worker("build")
        build_sec = time.monotonic() - build_started
        run_worker("test")
        reap_sandbox_processes()
        seal_binary(SOURCE / "hone-zstd-bench", CANDIDATE_BIN_DIR)

        throughputs: list[float] = []
        compressed_sizes: dict[str, int] = {}
        for row, data in workload_bytes:
            for level in LEVELS:
                compression_mib_s, candidate_frame, compress_reps = measure_cell(
                    "compress", data, level, len(data), None
                )
                # Identity-rotated compression: reconstruct the exact content
                # of the first and final timed iterations with the sealed
                # trusted runner and anchor every output gate to that content.
                trusted_first = trusted_stamped_frame(data, level, 0)
                first_content = trusted_decode(trusted_first, len(data))
                if compress_reps > 1:
                    trusted_final = trusted_stamped_frame(data, level, compress_reps - 1)
                    final_content = trusted_decode(trusted_final, len(data))
                else:
                    trusted_final, final_content = trusted_first, first_content
                # The timed reference frame is the final iteration's output: it
                # must be at most 0.25% larger than the trusted encoder's frame
                # over the SAME stamped content, and it must round trip through
                # the trusted decoder back to that content.
                if len(candidate_frame) * 400 > len(trusted_final) * 401:
                    raise GateFailure(
                        f"compressed-size gate failed for {row['id']} level {level}: {len(candidate_frame)} > trusted+0.25%"
                    )
                trusted_round_trip(candidate_frame, final_content)
                # Canonical single-repetition phase-0 frame: independent of the
                # calibrated repetition count, so the recorded size (and the
                # result hash derived from it) stays deterministic across runs.
                canonical_frame = run_runner(
                    CANDIDATE_BENCH, ["compress", str(len(data)), str(level), "1", "0"], data, None
                )[1]
                compressed_size = len(canonical_frame)
                if compressed_size * 400 > len(trusted_first) * 401:
                    raise GateFailure(
                        f"canonical compressed-size gate failed for {row['id']} level {level}: {compressed_size} > trusted+0.25%"
                    )
                trusted_round_trip(canonical_frame, first_content)
                decompression_mib_s, decoded, _ = measure_cell(
                    "decompress", trusted_frames[(row["id"], level)], len(data), len(data), len(data)
                )
                if decoded != data:
                    raise GateFailure(
                        f"decompression output mismatched the sealed workload for {row['id']} level {level}"
                    )
                compressed_sizes[f"{row['id']}:L{level}"] = compressed_size
                throughputs.extend((compression_mib_s, decompression_mib_s))

        score = geometric_mean(throughputs)
        deterministic = {"identity": identity, "compressedSizes": compressed_sizes, "tests": "lib-fuzzer-v1"}
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
                    "feedback": f"16 compression/decompression throughput cells passed all hard gates; q={score:.3f} MiB/s",
                }
            },
            "diagnostics": {
                "summary": "upstream fuzzer subset passed; trusted-reference round trips and size limits passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(build_sec, 6),
                "runtime_sec": round(elapsed_sec, 6),
                "throughput_cells": 16,
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
