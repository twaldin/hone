#!/usr/bin/env python3
"""Trusted evaluator for the current-head google/brotli throughput capsule.

Measurement-integrity design (the broker gives per-eval container isolation
only; every guarantee below lives in this trusted process):

- TIMING: throughput is the wall-clock lifetime of each sealed codec process,
  measured HERE, in the trusted root evaluator. The candidate never holds a
  report channel, never contributes a timestamp, and has no envelope to
  write; the only thing a codec process emits is the raw codec byte stream,
  which is independently validated out of process.

- IDENTITY-DISTINCT WORK: every timed iteration processes a fresh
  rotation+sparse-perturbation of the sealed corpus (offsets and perturbed
  bytes drawn from the system CSPRNG), so repeated timed work cannot be
  memoized or replayed within a process, across processes, or across reps.

- INDEPENDENT VALIDATION: every candidate-encoder stream is decoded by a
  protected reference decoder compiled from the PRISTINE baseline c/common +
  c/dec sources and byte-compared against the exact expected plaintext; the
  candidate decoder is additionally cross-checked against sealed upstream
  vectors and its outputs byte-compared by this process. A colluding
  encoder/decoder pair cannot agree on a non-Brotli format.

- PROCESS HYGIENE: this evaluator is a child subreaper; after every codec
  process it reaps ALL descendants and fails the evaluation if any
  candidate-uid process or persistent candidate-owned file (/tmp, /var/tmp,
  /dev/shm) survives. Codec processes run under fresh IPC namespaces so SysV
  state cannot carry between launches. The build tree is destroyed and the
  build tmpfs made root-only before the first measurement.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import random
import resource
import shutil
import signal
import stat
import statistics
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
DECODE_UID = 2001
REF_UID = 2002
CANDIDATE_UIDS = (SANDBOX_UID, DECODE_UID, REF_UID)
BENCH_TARGET_MS = 125
TARGET_NS = BENCH_TARGET_MS * 1_000_000
SAMPLES_PER_CELL = 3
MAX_BATCH = 32
PROCESS_TIMEOUT_SEC = 240
ALLOWED_MUTABLE_PREFIXES = ("c/common/", "c/dec/", "c/enc/")
REQUIRED_KINDS = frozenset({"binary", "text", "web"})
QUALITIES = (4, 9)
# The container mounts /tmp noexec; the sealed harness and per-run working
# directories must live under the build tmpfs, which is mounted exec.
SEALED_DIR = BUILD_ROOT / "sealed"
SEALED_BIN = SEALED_DIR / "hone-brotli-bench"
REF_BIN = SEALED_DIR / "hone-ref-decode"
RUN_ROOT = BUILD_ROOT / "runs"
# Shared world-writable locations a candidate process could use to carry
# state between launches; swept and gated after every codec process.
SHARED_TMP_DIRS = (Path("/tmp"), Path("/var/tmp"), Path("/dev/shm"))
# Standard upstream brotli streams used to cross-check the candidate decoder in
# isolation from the candidate encoder (independent-oracle gaming resistance).
DECODER_VECTORS = ("quickfox", "ukkonooa", "10x10y", "xyzzy")

PR_SET_CHILD_SUBREAPER = 36
CLONE_NEWIPC = 0x08000000
CLONE_NEWNET = 0x40000000

try:
    LIBC = ctypes.CDLL("libc.so.6", use_errno=True)
except OSError:
    LIBC = None


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


def become_subreaper() -> None:
    """Adopt every orphaned descendant so no candidate process can detach
    from supervision by double-forking."""
    if LIBC is None or LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise GateFailure("trusted process supervision unavailable")


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


def make_preexec(uid: int):
    """Codec-process pre-exec: fresh IPC+NET namespaces (no SysV or loopback
    state carryover between launches), rlimits, then drop to the per-role
    candidate uid."""

    def preexec() -> None:
        if os.geteuid() == 0:
            if LIBC is None or LIBC.unshare(CLONE_NEWIPC | CLONE_NEWNET) != 0:
                os._exit(97)
        _apply_rlimits()
        if os.geteuid() == 0:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)

    return preexec


def candidate_pids() -> list[int]:
    pids: list[int] = []
    try:
        entries = os.listdir("/proc")
    except OSError:
        return pids
    for name in entries:
        if not name.isdigit():
            continue
        try:
            st = os.stat(f"/proc/{name}")
        except OSError:
            continue
        if st.st_uid in CANDIDATE_UIDS:
            pids.append(int(name))
    return pids


def sweep_candidate_residue(strict: bool) -> None:
    """Kill and reap every candidate-uid process (we are the subreaper, so
    detached descendants reparent here) and remove candidate-owned entries in
    the shared world-writable directories. In strict mode any such residue is
    a measurement-integrity failure: an honest codec process leaves nothing
    behind."""
    pids = candidate_pids()
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    deadline = time.monotonic() + 5
    while True:
        try:
            reaped, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if reaped == 0:
            if time.monotonic() > deadline:
                break
            time.sleep(0.005)
            continue

    residue: list[str] = []
    for base in SHARED_TMP_DIRS:
        try:
            entries = list(os.scandir(base))
        except OSError:
            continue
        for entry in entries:
            if Path(entry.path) == BUILD_ROOT:
                continue
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if st.st_uid not in CANDIDATE_UIDS:
                continue
            residue.append(entry.path)
            if stat.S_ISDIR(st.st_mode):
                shutil.rmtree(entry.path, ignore_errors=True)
            else:
                try:
                    os.unlink(entry.path)
                except OSError:
                    pass
    if strict and (pids or residue):
        raise GateFailure(
            "candidate process left background children or persistent state"
        )


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
    """Admit the candidate workspace. Protected files MAY be absent (the
    sanitized terminal artifact strips them; the build reconstructs them from
    the trusted seed) but when present must match the baseline byte-for-byte.
    The FULL mutable-file inventory must be present, and nothing outside the
    mutable envelope may be added."""
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
            if relative not in candidate_paths:
                raise GateFailure(f"mutable source inventory incomplete: {relative}")
            continue
        candidate_path = candidate_paths.get(relative)
        if candidate_path is None:
            # Sanitized terminal artifacts omit protected files; the build
            # seeds them from the trusted baseline.
            continue
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


def build_reference_decoder() -> None:
    """Compile the protected reference decoder from the PRISTINE baseline
    c/common + c/dec sources. Candidate code never reaches this build."""
    SEALED_DIR.mkdir(mode=0o755, parents=True, exist_ok=True)
    cc_tmp = BUILD_ROOT / "cc-tmp"
    cc_tmp.mkdir(mode=0o700, exist_ok=True)
    sources = sorted((TRUSTED_DIR / "c" / "common").glob("*.c")) + sorted(
        (TRUSTED_DIR / "c" / "dec").glob("*.c")
    )
    if not sources:
        raise GateFailure("trusted reference decoder sources are missing")
    environment = os.environ.copy()
    environment["TMPDIR"] = str(cc_tmp)
    completed = subprocess.run(
        [
            "cc", "-O2", "-DNDEBUG", "-std=c99",
            "-I", str(TRUSTED_DIR / "c" / "include"),
            str(TRUSTED_DIR / "refdecode.c"),
            *(str(source) for source in sources),
            "-lm", "-o", str(REF_BIN),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=PROCESS_TIMEOUT_SEC,
        check=False,
        env=environment,
        cwd=str(BUILD_ROOT),
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace")[-500:]
        raise GateFailure(f"trusted reference decoder build failed: {detail}")
    os.chmod(REF_BIN, 0o755)


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


def seal_measurement_state() -> None:
    """Destroy every candidate-writable path before the first measurement:
    the uid-2000-owned build tree is removed, the build tmpfs root becomes
    root-only (no more 1777 sticky top level), and stale candidate-owned
    entries in the shared tmp directories are cleared."""
    shutil.rmtree(SOURCE, ignore_errors=True)
    os.chmod(BUILD_ROOT, 0o755)
    sweep_candidate_residue(strict=False)


def run_bench(
    binary: Path,
    args: list[str],
    stdin_bytes: bytes,
    uid: int,
    output_cap: int,
    timeout: int = 90,
) -> tuple[int, bytes, int]:
    """Run a sealed binary as `uid` in a fresh root-owned working directory
    and measure its WHOLE wall-clock lifetime here in the trusted parent.
    I/O is file-backed on the private tmpfs; the child holds no channel other
    than its validated stdout bytes. After exit, all descendants are reaped
    and any candidate residue fails the evaluation."""
    cwd = Path(tempfile.mkdtemp(dir=str(RUN_ROOT)))
    try:
        # Root-owned, world-traversable but not world-writable: the dropped
        # candidate uid can enter and execute but cannot leave artifacts here.
        os.chmod(cwd, 0o755)
        in_path = cwd / "stdin.bin"
        out_path = cwd / "stdout.bin"
        in_path.write_bytes(stdin_bytes)
        os.chmod(in_path, 0o644)
        with in_path.open("rb") as stdin_file, out_path.open("wb") as stdout_file:
            started = time.monotonic_ns()
            completed = subprocess.run(
                [str(binary), *args],
                stdin=stdin_file,
                stdout=stdout_file,
                stderr=subprocess.DEVNULL,
                timeout=timeout,
                check=False,
                preexec_fn=make_preexec(uid),
                cwd=str(cwd),
            )
            elapsed_ns = time.monotonic_ns() - started
        sweep_candidate_residue(strict=True)
        if out_path.stat().st_size > output_cap:
            raise GateFailure("benchmark produced oversized output")
        return completed.returncode, out_path.read_bytes(), elapsed_ns
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateFailure(f"benchmark process failed: {exc}") from exc
    finally:
        shutil.rmtree(cwd, ignore_errors=True)


def parse_frames(blob: bytes, count: int, max_each: int) -> list[bytes]:
    frames: list[bytes] = []
    offset = 0
    for _ in range(count):
        if offset + 8 > len(blob):
            raise GateFailure("benchmark emitted a malformed stream envelope")
        size = int.from_bytes(blob[offset : offset + 8], "little")
        offset += 8
        if size <= 0 or size > max_each or offset + size > len(blob):
            raise GateFailure("benchmark emitted a malformed stream envelope")
        frames.append(blob[offset : offset + size])
        offset += size
    if offset != len(blob):
        raise GateFailure("benchmark emitted a malformed stream envelope")
    return frames


def frame_streams(streams: list[bytes]) -> bytes:
    return b"".join(len(stream).to_bytes(8, "little") + stream for stream in streams)


def reference_decode_check(stream: bytes, expected: bytes) -> None:
    """Decode a candidate-encoder stream with the protected reference decoder
    and require the exact expected plaintext."""
    returncode, decoded, _ = run_bench(
        REF_BIN,
        [str(len(stream)), str(len(expected))],
        stream,
        REF_UID,
        output_cap=len(expected) + 16,
        timeout=60,
    )
    if returncode != 0 or decoded != expected:
        raise GateFailure("candidate stream failed reference decoding")


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
            SEALED_BIN,
            ["d", "1", str(len(plaintext))],
            frame_streams([compressed]),
            DECODE_UID,
            output_cap=len(plaintext) + 16,
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


def throughput_mib_s(byte_count: int, elapsed_ns: int) -> float:
    if elapsed_ns <= 0:
        raise GateFailure("benchmark returned an invalid elapsed time")
    return (byte_count * 1_000_000_000.0) / (elapsed_ns * 1048576.0)


def measure_cell(
    workload_id: str, data: bytes, quality: int, baseline_size: int
) -> tuple[int, float, float]:
    """Measure one (workload, quality) cell: canonical encode with the strict
    compressed-size gate, then trusted-parent wall-clock throughput over
    identity-distinct rotated/perturbed inputs for encode and decode, with
    every emitted stream reference-decoded and every decoded output
    byte-compared out of process."""
    n = len(data)
    rng = random.SystemRandom()
    used_offsets: set[int] = set()
    perturb_count = max(16, n // 65536)

    def variant() -> bytes:
        while True:
            offset = rng.randrange(1, n)
            if offset not in used_offsets:
                used_offsets.add(offset)
                break
        rotated = bytearray(data[offset:] + data[:offset])
        for _ in range(perturb_count):
            rotated[rng.randrange(n)] = rng.randrange(256)
        return bytes(rotated)

    frame_cap = n + n // 2 + 4096

    def encode_batch(inputs: list[bytes]) -> tuple[list[bytes], int]:
        returncode, out, elapsed_ns = run_bench(
            SEALED_BIN,
            ["c", str(len(inputs)), str(n), str(quality)],
            b"".join(inputs),
            SANDBOX_UID,
            output_cap=len(inputs) * (frame_cap + 8),
        )
        if returncode != 0:
            raise GateFailure(f"compression benchmark failed at quality {quality}")
        return parse_frames(out, len(inputs), frame_cap), elapsed_ns

    def decode_batch(streams: list[bytes], expected: bytes) -> int:
        returncode, out, elapsed_ns = run_bench(
            SEALED_BIN,
            ["d", str(len(streams)), str(n)],
            frame_streams(streams),
            DECODE_UID,
            output_cap=len(streams) * n + 16,
        )
        if returncode != 0:
            raise GateFailure(f"decompression benchmark failed at quality {quality}")
        if out != expected:
            raise GateFailure(f"independent round-trip mismatch at quality {quality}")
        return elapsed_ns

    def pick_batch_size(per_call_ns: int) -> int:
        per_call_ns = max(per_call_ns, 1_000_000)
        return min(MAX_BATCH, max(1, round(TARGET_NS / per_call_ns)))

    # Canonical encode: probe + strict compressed-size gate against the
    # sealed baseline, validated by the protected reference decoder.
    canonical_frames, encode_probe_ns = encode_batch([data])
    canonical_stream = canonical_frames[0]
    reference_decode_check(canonical_stream, data)
    canonical_size = len(canonical_stream)
    if canonical_size * 400 > baseline_size * 401:
        raise GateFailure(
            f"compressed-size gate failed for {workload_id} quality {quality}: "
            f"{canonical_size} > baseline+0.25%"
        )
    rotated_cap = canonical_size + canonical_size * 3 // 100 + 64

    def validate_rotated(stream: bytes, source: bytes) -> None:
        if len(stream) > rotated_cap:
            raise GateFailure(
                f"rotated compressed-size gate failed for {workload_id} quality {quality}"
            )
        reference_decode_check(stream, source)

    # Pool of (identity-distinct input, validated candidate stream).
    pool: list[tuple[bytes, bytes]] = []

    def grow_pool(batch: list[bytes]) -> int:
        frames, elapsed_ns = encode_batch(batch)
        for source, stream in zip(batch, frames):
            validate_rotated(stream, source)
            pool.append((source, stream))
        return elapsed_ns

    # Two-point probe: per-call encode cost without the constant process
    # overhead, to size the timed batches near the target window.
    pair_probe_ns = grow_pool([variant(), variant()])
    per_encode_ns = pair_probe_ns - encode_probe_ns
    if per_encode_ns <= 0:
        per_encode_ns = max(encode_probe_ns, 1)
    encode_batch_size = pick_batch_size(per_encode_ns)

    encode_samples: list[float] = []
    for _ in range(SAMPLES_PER_CELL):
        batch = [variant() for _ in range(encode_batch_size)]
        elapsed_ns = grow_pool(batch)
        encode_samples.append(throughput_mib_s(encode_batch_size * n, elapsed_ns))
    compression_mib_s = statistics.median(encode_samples)

    # Decode probes: canonical round trip through the candidate decoder, then
    # a three-stream batch for the per-call estimate.
    decode_probe_ns = decode_batch([canonical_stream], data)
    trio = pool[:3]
    trio_ns = decode_batch([s for _, s in trio], b"".join(src for src, _ in trio))
    per_decode_ns = (trio_ns - decode_probe_ns) // 2
    if per_decode_ns <= 0:
        per_decode_ns = max(decode_probe_ns, 1)
    decode_batch_size = pick_batch_size(per_decode_ns)

    while len(pool) < decode_batch_size:
        batch = [variant() for _ in range(min(decode_batch_size - len(pool), MAX_BATCH))]
        grow_pool(batch)
    selection = pool[:decode_batch_size]
    selection_streams = [stream for _, stream in selection]
    selection_expected = b"".join(source for source, _ in selection)

    decode_samples: list[float] = []
    for _ in range(SAMPLES_PER_CELL):
        elapsed_ns = decode_batch(selection_streams, selection_expected)
        decode_samples.append(throughput_mib_s(decode_batch_size * n, elapsed_ns))
    decompression_mib_s = statistics.median(decode_samples)

    if not all(
        math.isfinite(value) and value > 0
        for value in (compression_mib_s, decompression_mib_s)
    ):
        raise GateFailure(f"benchmark returned non-finite throughput at quality {quality}")
    return canonical_size, compression_mib_s, decompression_mib_s


def geometric_mean(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("cannot scalarize invalid throughput")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def main() -> None:
    mounted = False
    result_hash = ""
    started = time.monotonic()
    try:
        become_subreaper()
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
        build_reference_decoder()
        copy_candidate()
        build_started = time.monotonic()
        run_worker("build")
        build_sec = time.monotonic() - build_started
        run_worker("test")
        seal_binary()
        seal_measurement_state()
        check_decoder_reference()

        throughputs: list[float] = []
        compressed_sizes: dict[str, int] = {}
        for row, data in workload_bytes:
            for quality in QUALITIES:
                canonical_size, compression_mib_s, decompression_mib_s = measure_cell(
                    row["id"], data, quality, row["expectedCompressedBytes"][str(quality)]
                )
                compressed_sizes[f"{row['id']}:Q{quality}"] = canonical_size
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
                "summary": "28 upstream CTest cases passed; reference-decoded round trips and size limits passed",
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
