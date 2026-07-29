#!/usr/bin/env python3
"""Trusted evaluator for OSS-H06 full and incremental Tree-sitter parsing."""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import resource
import secrets
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import NamedTuple

TRUSTED_DIR = Path(__file__).resolve().parent
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path(f"/tmp/hone-tree-sitter-build-{os.getpid()}")
SOURCE = BUILD_ROOT / "source"
OBJECTS = BUILD_ROOT / "objects"
BINARY = OBJECTS / "hone-ts-harness"
REF_SOURCE = BUILD_ROOT / "ref-source"
REF_OBJECTS = BUILD_ROOT / "ref-objects"
REF_BINARY = REF_OBJECTS / "hone-ts-ref-harness"
# Frozen provisional yardstick scale (provisional local qBase; final GCE
# recalibration re-freezes it): a candidate identical to the trusted baseline
# scores this value by construction, independent of host drift.
REFERENCE_NORMALIZATION = 50661657.83045164
SANDBOX_UID = 2000
PROCESS_MEMORY_BYTES = 1792 << 20
BUILD_TIMEOUT_SEC = 180
VERIFY_TIMEOUT_SEC = 60
BENCH_TIMEOUT_SEC = 90
BENCH_TIMED_REPS = 9
# Per-iteration timing plausibility floor: every candidate timed iteration must
# take at least the reference leg's fastest same-phase iteration divided by
# this divisor. Contention only ever adds time, so the floor cannot trip
# legitimately; a measured window collapsed toward a pipe round-trip is orders
# of magnitude below any real parse of the token-seeded content.
ITERATION_FLOOR_DIVISOR = 10
# Per-leg out-of-process CPU floor: each bench leg's total CPU time is read by
# the trusted parent from the kernel's reaped-child accounting (the wait4
# rusage channel bracketing exactly that leg's process tree) -- never from
# anything candidate-reported. Reference and candidate legs run the identical
# warmup plus token-seeded timed iteration schedule, so their CPU per
# operation is directly comparable; a candidate leg whose CPU falls below this
# fraction of the SAME repetition's pristine reference leg is rejected as
# implausible (producing receipts without parse-proportional work while
# sitting inside the wall-clock plausibility band). Genuine parser
# improvements reduce CPU per operation only modestly (the sealed improved
# control measures a few percent), so 0.4 leaves wide legitimate headroom
# while bounding any residual work-skipping channel to 1/0.4x.
MIN_CPU_FRAC = 0.4
OUTPUT_LIMIT = 1 << 20
# Order-sensitive FNV-1a 64-bit fold matching harness.c (DIGEST_BASIS /
# 0x100000001B3). The parent folds each timed iteration's receipt into a
# per-phase accumulator; the candidate accumulator must equal the pristine
# reference accumulator, so the receipt-bound tree signatures agree.
DIGEST_BASIS = 0xCBF29CE484222325
FNV_PRIME = 0x00000100000001B3
MASK64 = (1 << 64) - 1
TREE_SITTER_REVISION = "1ffd612be56259938c47507bbe953af739c7f640"
LANGUAGES = ("javascript", "rust", "python")
EXPECTED_GRAMMAR_REVISIONS = {
    "javascript": "44c892e0be055ac465d5eeddae6d3e194424e7de",
    "rust": "18b0515fca567f5a10aee9978c6d2640e878671a",
    "python": "bffb65a8cfe4e46290331dfef0dbf0ef3679de11",
}

PR_SET_CHILD_SUBREAPER = 36
CLONE_NEWNS = 0x00020000
CLONE_NEWIPC = 0x08000000
MS_NOSUID = 0x2
MS_NODEV = 0x4
MS_NOEXEC = 0x8
MS_REC = 0x4000
MS_PRIVATE = 0x40000
CANDIDATE_WRITABLE_ROOTS = (Path("/tmp"), Path("/var/tmp"), Path("/dev/shm"))
FRESH_TMPFS_OPTIONS = b"size=256m,mode=1777"
SHM_TMPFS_OPTIONS = b"size=64m,mode=1777"
REAP_TIMEOUT_SEC = 5.0
_LIBC = ctypes.CDLL(None, use_errno=True)
_LIBC.unshare.argtypes = [ctypes.c_int]
_LIBC.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
_LIBC.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def emit_failure(detail: str, result_hash: str = "") -> None:
    safe = detail.replace(str(ASSETS), "<sealed-assets>").replace(str(BUILD_ROOT), "<build>")[:1000]
    output = {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": {
            "tests_pass": False,
            "exact_trees_pass": False,
            "edit_results_pass": False,
            "rss_pass": False,
        },
        "perExample": {"aggregate": {"score": 0.0, "feedback": safe}},
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
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (PROCESS_MEMORY_BYTES, PROCESS_MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


def _become_subreaper() -> None:
    """Adopt orphaned candidate descendants so every leg can be fully reaped.

    A new-session helper spawned by candidate-linked code reparents to the
    nearest subreaper instead of pid 1; without this it would survive the
    leg's killpg and could burn CPU only while the reference (or candidate)
    leg is timed, inflating both ratios.
    """
    if os.geteuid() != 0:
        return
    try:
        _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass


def _candidate_pids() -> list[int]:
    pids: list[int] = []
    try:
        entries = os.listdir("/proc")
    except OSError:
        return pids
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/status", "rb") as handle:
                for line in handle:
                    if line.startswith(b"Uid:"):
                        if int(line.split()[1]) == SANDBOX_UID:
                            pids.append(int(entry))
                        break
        except (OSError, ValueError, IndexError):
            continue
    return pids


def _reap_candidate_tree() -> None:
    """As subreaper, SIGKILL and wait every candidate-uid process until a full
    /proc scan finds none. Run after EVERY reference and candidate leg so no
    survivor can steal CPU during the next leg's measurement or carry state
    across legs; killpg alone misses detached/new-session descendants."""
    if os.geteuid() != 0:
        return
    deadline = time.monotonic() + REAP_TIMEOUT_SEC
    while True:
        while True:
            try:
                waited, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if waited == 0:
                break
        pids = _candidate_pids()
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        if time.monotonic() >= deadline:
            raise GateFailure("candidate process tree could not be reaped")
        time.sleep(0.02)


def _purge_candidate_owned(root: Path) -> None:
    """Recursively remove every candidate-uid-owned file (and candidate-owned
    subdirectory) under a root-owned tree, leaving the trusted root-owned
    build artifacts untouched. The sealed source trees and the compiled
    objects/binaries are pruned from the walk so they are never removed even
    though the objects were compiled under the sandbox uid; OBJECTS/
    REF_OBJECTS stay 0o555. Everything else the walk reaches -- notably the
    0o777 per-workload output directory where a demoted leg's /usr/bin/time
    writes its peak-RSS file (and where a candidate could otherwise drop a
    cache that survives across timed repetitions because BUILD_ROOT itself is
    root-owned) -- is candidate-writable and swept."""
    keep = {SOURCE, REF_SOURCE, OBJECTS, REF_OBJECTS}
    try:
        walker = os.walk(root, topdown=True, followlinks=False)
    except OSError:
        return
    for current, directories, files in walker:
        current_path = Path(current)
        kept: list[str] = []
        for name in directories:
            path = current_path / name
            if path in keep:
                continue  # prune trusted build tree, never descend or remove
            try:
                st = path.lstat()
            except OSError:
                continue
            if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_uid == SANDBOX_UID:
                shutil.rmtree(path, ignore_errors=True)
                continue  # candidate-owned dir removed; do not descend
            kept.append(name)
        directories[:] = kept
        for name in files:
            path = current_path / name
            try:
                if path.lstat().st_uid != SANDBOX_UID:
                    continue
            except OSError:
                continue
            try:
                path.unlink()
            except OSError:
                pass


def _clear_candidate_writable() -> None:
    """Purge candidate-owned residue from the shared writable roots between
    legs. /var/tmp and /dev/shm are per-leg private tmpfs mounts that die with
    the leg's namespace, so among the top-level shared roots only /tmp can
    carry a byte across legs; sweep every top-level entry the candidate uid
    owns there. Then sweep candidate-uid-owned files nested under the
    root-owned BUILD_ROOT tree (the per-workload 0o777 output directory is the
    one candidate-writable spot inside it): those survive the top-level /tmp
    sweep because BUILD_ROOT itself is root-owned, so a cache file dropped
    there would otherwise persist across timed repetitions and outside the
    per-leg ru_maxrss the +2% RSS gate sees."""
    if os.geteuid() != 0:
        return
    for root in CANDIDATE_WRITABLE_ROOTS:
        try:
            entries = list(root.iterdir())
        except OSError:
            continue
        for path in entries:
            try:
                if path.lstat().st_uid != SANDBOX_UID:
                    continue
            except OSError:
                continue
            try:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
            except OSError:
                pass
    _purge_candidate_owned(BUILD_ROOT)


def _leg_isolation() -> None:
    """Preexec for every candidate-linked leg: a fresh IPC namespace plus a
    fresh mount namespace whose /var/tmp and /dev/shm are brand-new tmpfs, so
    no SysV/POSIX IPC segment and no /var/tmp or /dev/shm byte survives between
    launches; the shared /tmp build tree (sealed binary, read-only workload,
    the trusted parent's output directory) stays visible. Then drop to the
    sandbox uid. Fail-closed under root/linux; the non-root dev path demotes."""
    if os.geteuid() == 0:
        if _LIBC.unshare(CLONE_NEWNS | CLONE_NEWIPC) != 0:
            os._exit(126)
        if _LIBC.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
            os._exit(126)
        for target, options in ((b"/var/tmp", FRESH_TMPFS_OPTIONS), (b"/dev/shm", SHM_TMPFS_OPTIONS)):
            if _LIBC.mount(b"hone-ts-fresh", target, b"tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, options) != 0:
                os._exit(126)
    demote()


def regular_files(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in list(directories):
            path = current_path / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise GateFailure(f"non-directory entry in candidate: {path.relative_to(root).as_posix()}")
        for name in files:
            path = current_path / name
            mode = path.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise GateFailure(f"non-regular candidate file: {path.relative_to(root).as_posix()}")
            result[path.relative_to(root).as_posix()] = path
    return result


def check_source_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    trusted = regular_files(TRUSTED_DIR)
    candidate = regular_files(WORKSPACE)
    required_mutable = {path for path in trusted if path.startswith("lib/src/")}
    for relative in candidate:
        if relative in trusted or relative.startswith("lib/src/"):
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")
    missing = sorted(required_mutable - set(candidate))
    if missing:
        raise GateFailure(f"required runtime source missing: {missing[0]}")
    protected = {
        relative: path
        for relative, path in trusted.items()
        if not relative.startswith("lib/src/") and not relative.startswith(".gitdir/")
    }
    for relative, trusted_path in protected.items():
        candidate_path = candidate.get(relative)
        if candidate_path is None:
            # Sanitized terminal artifacts strip protected files from the
            # candidate workspace; prepare_source reconstructs every one of
            # them from TRUSTED_DIR, so absence is tolerated. A protected
            # file that IS present must still match the trusted bytes.
            continue
        if sha256(candidate_path) != sha256(trusted_path):
            raise GateFailure(f"protected source changed: {relative}")


def load_metadata() -> tuple[dict[str, object], Path]:
    metadata_paths = sorted(ASSETS.rglob("workloads.json"))
    if len(metadata_paths) != 1:
        raise GateFailure("selected asset split must contain exactly one workloads.json")
    metadata_path = metadata_paths[0]
    try:
        metadata = json.loads(metadata_path.read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed workload metadata is malformed") from exc
    if not isinstance(metadata, dict) or metadata.get("schemaVersion") != 1:
        raise GateFailure("sealed workload metadata has invalid schema")
    if metadata.get("treeSitterRevision") != TREE_SITTER_REVISION:
        raise GateFailure("sealed Tree-sitter revision mismatch")
    grammars = metadata.get("grammars")
    if not isinstance(grammars, dict) or set(grammars) != set(LANGUAGES):
        raise GateFailure("sealed grammar set is incomplete")
    for language, revision in EXPECTED_GRAMMAR_REVISIONS.items():
        entry = grammars.get(language)
        if not isinstance(entry, dict) or entry.get("revision") != revision:
            raise GateFailure(f"sealed {language} grammar revision mismatch")
    rows = metadata.get("workloads")
    if not isinstance(rows, list) or len(rows) != 6:
        raise GateFailure("sealed workload matrix must contain six rows")
    identities = {(row.get("language"), row.get("id")) for row in rows if isinstance(row, dict)}
    expected_identities = {(language, f"{language}-{variant}") for language in LANGUAGES for variant in (1, 2)}
    if identities != expected_identities:
        raise GateFailure("sealed workload language matrix is incomplete")
    return metadata, metadata_path.parent


def verify_assets(metadata: dict[str, object], split_dir: Path) -> None:
    grammar_hashes = metadata.get("grammarFileHashes")
    if not isinstance(grammar_hashes, dict) or not grammar_hashes:
        raise GateFailure("sealed grammar hashes are missing")
    actual_grammar_files = {
        path.relative_to(split_dir).as_posix(): path
        for path in (split_dir / "grammars").rglob("*")
        if path.is_file()
    }
    if set(actual_grammar_files) != set(grammar_hashes):
        raise GateFailure("sealed grammar file set mismatch")
    for relative, path in actual_grammar_files.items():
        expected = grammar_hashes.get(relative)
        if not isinstance(expected, str) or sha256(path) != expected:
            raise GateFailure(f"sealed grammar hash mismatch: {relative}")

    for row in metadata["workloads"]:
        if not isinstance(row, dict):
            raise GateFailure("sealed workload row is malformed")
        required = {
            "baselinePeakRssKiB",
            "baselinePeakRssSamplesKiB",
            "benchmark",
            "bytes",
            "edit",
            "expected",
            "id",
            "language",
            "path",
            "sha256",
        }
        if set(row) != required:
            raise GateFailure(f"sealed workload fields are invalid: {row.get('id')}")
        path = split_dir / str(row["path"])
        if not path.is_file() or path.stat().st_size != row["bytes"] or sha256(path) != row["sha256"]:
            raise GateFailure(f"sealed workload hash mismatch: {row.get('id')}")
        edit = row["edit"]
        benchmark = row["benchmark"]
        expected = row["expected"]
        if not isinstance(edit, dict) or set(edit) != {"startByte", "oldEndByte", "replacement"}:
            raise GateFailure(f"sealed edit is malformed: {row.get('id')}")
        if not isinstance(benchmark, dict) or set(benchmark) != {"fullIterations", "incrementalIterations"}:
            raise GateFailure(f"sealed benchmark is malformed: {row.get('id')}")
        if not isinstance(expected, dict) or set(expected) != {
            "originalTreeSha256",
            "incrementalTreeSha256",
            "editedFullTreeSha256",
            "changedRangesSha256",
        }:
            raise GateFailure(f"sealed exact-tree oracle is missing: {row.get('id')}")
        if not isinstance(row["baselinePeakRssKiB"], int) or row["baselinePeakRssKiB"] <= 0:
            raise GateFailure(f"sealed RSS baseline is missing: {row.get('id')}")
        if not isinstance(row["baselinePeakRssSamplesKiB"], list) or len(row["baselinePeakRssSamplesKiB"]) != 40:
            raise GateFailure(f"sealed RSS calibration samples are missing: {row.get('id')}")


def run_command(arguments: list[str], timeout: int) -> None:
    identity: dict[str, object] = {}
    if os.geteuid() == 0:
        identity = {"user": SANDBOX_UID, "group": SANDBOX_UID, "extra_groups": ()}
    try:
        with tempfile.TemporaryFile(mode="w+t") as errors:
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=errors,
                cwd=SOURCE,
                text=True,
                start_new_session=True,
                **identity,
            )
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                raise GateFailure("candidate runtime compilation timed out") from exc
            if process.returncode != 0:
                errors.seek(0)
                detail = errors.read(1000).replace(str(BUILD_ROOT), "<build>")
                raise GateFailure(f"candidate runtime failed to compile: {detail}")
    except OSError as exc:
        raise GateFailure(f"build command failed: {exc}") from exc


def mount_build_tmpfs() -> None:
    BUILD_ROOT.mkdir(mode=0o755)
    completed = subprocess.run(
        ["mount", "-t", "tmpfs", "-o", "size=512m,mode=755,exec,nosuid,nodev", "hone-tree-sitter-build", str(BUILD_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
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


def prepare_source(split_dir: Path) -> None:
    shutil.copytree(TRUSTED_DIR, SOURCE)
    shutil.rmtree(SOURCE / ".gitdir", ignore_errors=True)
    shutil.rmtree(SOURCE / "lib" / "src")
    shutil.copytree(WORKSPACE / "lib" / "src", SOURCE / "lib" / "src")
    shutil.copytree(split_dir / "grammars", SOURCE / "grammars")
    # Reference yardstick: a pristine copy of the trusted baseline runtime,
    # built and benchmarked inside the SAME evaluation so host frequency and
    # contention drift between evaluations cancels out of the reported score.
    # The candidate workspace never touches this tree.
    shutil.copytree(TRUSTED_DIR, REF_SOURCE)
    shutil.rmtree(REF_SOURCE / ".gitdir", ignore_errors=True)
    shutil.copytree(split_dir / "grammars", REF_SOURCE / "grammars")
    OBJECTS.mkdir(mode=0o777)
    os.chmod(OBJECTS, 0o777)
    REF_OBJECTS.mkdir(mode=0o777)
    os.chmod(REF_OBJECTS, 0o777)
    for root in (SOURCE, REF_SOURCE):
        os.chmod(root, 0o755)
        for path in root.rglob("*"):
            if path.is_dir():
                os.chmod(path, 0o755)
            elif path.is_file():
                os.chmod(path, 0o644)


def compile_source(root: Path, source: Path, output: Path, *extra_flags: str) -> None:
    flags = [
        "cc",
        "-O3",
        "-DNDEBUG",
        "-std=c11",
        "-D_DEFAULT_SOURCE",
        "-D_BSD_SOURCE",
        "-fvisibility=hidden",
        *extra_flags,
        f"-I{root / 'lib/src'}",
        f"-I{root / 'lib/src/wasm'}",
        f"-I{root / 'lib/include'}",
        "-c",
        str(source),
        "-o",
        str(output),
    ]
    run_command(flags, BUILD_TIMEOUT_SEC)


def build_harness() -> float:
    started = time.monotonic()
    for root, objects, binary in ((SOURCE, OBJECTS, BINARY), (REF_SOURCE, REF_OBJECTS, REF_BINARY)):
        compile_source(root, root / "lib/src/lib.c", objects / "runtime.o")
        compile_source(root, root / "harness.c", objects / "harness.o")
        for language in LANGUAGES:
            grammar = root / "grammars" / language / "src"
            compile_source(root, grammar / "parser.c", objects / f"{language}-parser.o")
            compile_source(root, grammar / "scanner.c", objects / f"{language}-scanner.o")
        run_command(["cc", *[str(path) for path in sorted(objects.glob("*.o"))], "-o", str(binary)], BUILD_TIMEOUT_SEC)
    os.chmod(OBJECTS, 0o555)
    os.chmod(REF_OBJECTS, 0o555)
    return time.monotonic() - started


def run_sandbox(arguments: list[str], timeout: int) -> tuple[bytes, resource.struct_rusage]:
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_fd)
            os.dup2(write_fd, 1)
            with open(os.devnull, "wb") as devnull:
                os.dup2(devnull.fileno(), 0)
                os.dup2(devnull.fileno(), 2)
                os.chdir(BUILD_ROOT)
                os.setsid()
                _leg_isolation()
                os.execv(arguments[0], arguments)
        finally:
            os._exit(127)

    os.close(write_fd)
    os.set_blocking(read_fd, False)
    output = bytearray()
    deadline = time.monotonic() + timeout
    status: int | None = None
    usage: resource.struct_rusage | None = None
    while status is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status, usage = os.wait4(pid, 0)
            os.close(read_fd)
            raise GateFailure("candidate parser process timed out")
        ready, _, _ = select.select([read_fd], [], [], min(0.1, remaining))
        if ready:
            try:
                chunk = os.read(read_fd, 65536)
            except BlockingIOError:
                chunk = b""
            if chunk:
                output.extend(chunk)
                if len(output) > OUTPUT_LIMIT:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.wait4(pid, 0)
                    os.close(read_fd)
                    raise GateFailure("candidate parser emitted excessive output")
        waited, child_status, child_usage = os.wait4(pid, os.WNOHANG)
        if waited == pid:
            status = child_status
            usage = child_usage
    while True:
        try:
            chunk = os.read(read_fd, 65536)
        except BlockingIOError:
            break
        if not chunk:
            break
        output.extend(chunk)
    os.close(read_fd)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0 or usage is None:
        raise GateFailure("candidate parser process failed")
    return bytes(output), usage


class WorkloadResult(NamedTuple):
    full_ratio: float
    incremental_ratio: float
    full_speed: float
    incremental_speed: float
    reference_full_speed: float
    reference_incremental_speed: float
    peak_rss_kib: int
    observed: dict[str, str]


def draw_token_stream(full_iterations: int, incremental_iterations: int) -> dict[str, list[bytes]]:
    """One unpredictable eight-byte parse-go token per timed iteration, drawn
    from the trusted parent's CSPRNG (secrets.token_bytes) at repetition start
    and stored once; the identical stored stream is replayed to BOTH the
    reference and candidate legs of the repetition, so their timed content --
    and therefore their trees and receipts -- match. No token is derived from
    enumerable fields (identifier/rep/phase/index), so no candidate-visible
    computation can enumerate a small precompute set in any untimed window:
    with 64 fresh random bits per iteration, the token-seeded mutation, parse,
    and digest are forced inside the timed window where the token is first
    revealed at clock-start."""
    return {
        "full": [secrets.token_bytes(8) for _ in range(full_iterations)],
        "incremental": [secrets.token_bytes(8) for _ in range(incremental_iterations)],
    }


def enforce_iteration_floor(identifier: str, phase: str, reference_ns: list[int], candidate_ns: list[int]) -> None:
    """Reject implausibly fast timed windows: every candidate iteration must
    take at least the trusted reference leg's fastest same-phase iteration
    divided by ITERATION_FLOOR_DIVISOR. Host noise only ever adds time, so a
    genuine candidate cannot trip the floor, while a window that collapsed to
    a control-channel round-trip sits far below it."""
    floor_ns = min(reference_ns) // ITERATION_FLOOR_DIVISOR
    if floor_ns <= 0:
        raise GateFailure(f"reference iteration clock resolution failure: {identifier} {phase}")
    for elapsed in candidate_ns:
        if elapsed < floor_ns:
            raise GateFailure(f"timed iteration implausibly fast versus trusted reference: {identifier} {phase}")


def run_workload(row: dict[str, object], split_dir: Path) -> WorkloadResult:
    identifier = str(row["id"])
    replacement = BUILD_ROOT / f"replacement-{identifier}.txt"
    replacement.write_text(str(row["edit"]["replacement"]))
    os.chmod(replacement, 0o444)
    source = BUILD_ROOT / f"workload-{identifier}.txt"
    shutil.copy2(split_dir / str(row["path"]), source)
    os.chmod(source, 0o444)
    output_dir = BUILD_ROOT / f"verify-{identifier}"
    output_dir.mkdir(mode=0o777)
    os.chmod(output_dir, 0o777)
    base = [
        str(row["language"]),
        str(source),
        str(row["edit"]["startByte"]),
        str(row["edit"]["oldEndByte"]),
        str(replacement),
    ]
    verify_output, _ = run_sandbox(
        ["/usr/bin/prlimit", "--nproc=1", "--", str(BINARY), "verify", *base, str(output_dir)],
        VERIFY_TIMEOUT_SEC,
    )
    try:
        verify_payload = json.loads(verify_output)
    except (ValueError, UnicodeDecodeError) as exc:
        raise GateFailure(f"parser test output malformed: {identifier}") from exc
    if verify_payload != {"ok": True, "parserTests": True, "incrementalEqualsFull": True}:
        raise GateFailure(f"parser tests failed: {identifier}")
    observed = {
        "originalTreeSha256": sha256(output_dir / "original.tree"),
        "incrementalTreeSha256": sha256(output_dir / "incremental.tree"),
        "editedFullTreeSha256": sha256(output_dir / "edited-full.tree"),
        "changedRangesSha256": sha256(output_dir / "changed-ranges.txt"),
    }
    if observed != row["expected"]:
        raise GateFailure(f"exact tree/edit oracle mismatch: {identifier}")
    if observed["incrementalTreeSha256"] != observed["editedFullTreeSha256"]:
        raise GateFailure(f"incremental tree differs from full edited parse: {identifier}")
    _reap_candidate_tree()
    _clear_candidate_writable()

    benchmark = row["benchmark"]
    edit = row["edit"]
    source_bytes = int(row["bytes"])
    edited_bytes = source_bytes - (int(edit["oldEndByte"]) - int(edit["startByte"])) + len(str(edit["replacement"]).encode())
    expected_full_bytes = source_bytes * int(benchmark["fullIterations"])
    expected_incremental_bytes = edited_bytes * int(benchmark["incrementalIterations"])

    # Robustness: host contention and frequency drift only ever add time and
    # neither is candidate-controlled (the host carries permanent ambient load
    # from unrelated VM containers plus the tree-scanning git poller). Candidate
    # and pristine in-eval reference legs are interleaved on the SAME stored
    # per-iteration token stream in per-repetition alternating order (so
    # time-monotone load decay within a repetition biases neither leg's
    # minimum), one warm repetition settles the machine, and
    # each phase is scored from summed per-iteration minima: every timed
    # iteration index keeps its fastest window across the nine timed
    # repetitions (timing noise is strictly additive and lands on
    # iterations, so each iteration gets nine independent chances at a calm
    # window; A-A probes on this host measured ~4% spread for min-of-summed
    # phases and ~4% for median-of-per-pair-ratios -- per-leg multiplicative
    # placement/frequency lotteries cancel in neither -- while summed
    # per-iteration minima average residuals across the 24-120 iterations of
    # a phase for candidate and reference alike). The trusted
    # parent owns the clock and times each iteration's go-token-seeded mutation
    # and parse; every timed phase's receipt fold must match the trusted
    # reference run on the identical stored token stream, every token is a
    # fresh CSPRNG draw revealed only at clock-start (never derived from
    # enumerable fields), every candidate iteration must clear the
    # per-iteration plausibility floor against the reference leg's fastest
    # same-phase iteration, and every candidate leg's out-of-process
    # wait4-accounted CPU must clear MIN_CPU_FRAC of the same repetition's
    # reference leg. The receipt-bound tree signature is content-inclusive
    # (structure plus every leaf's source bytes), so even a schedule mutation
    # that lands in a token interior and leaves the structure byte-identical
    # changes the receipt. Beyond content-binding, every timed iteration
    # applies guaranteed token-boundary-ALTERING edits (schedule-selected
    # identifier heads overwritten with delimiter bytes -- EVERY
    # incremental-phase edit is one, so no schedule edit is lexically neutral
    # and none can be proven skippable and under-registered), so the parsed
    # tree's node layout itself differs from any cached or replayed structure
    # and the receipt cannot be produced without a genuine re-lex at every
    # edited site inside the timed window; and every timed FULL iteration
    # parses a schedule-driven permutation of the workload's top-level
    # line-aligned blocks (item-granular, length-preserving, same token
    # multiset) with a boundary-altering delimiter substitution inside nearly
    # EVERY permuted block AND two class-preserving swaps at INTERIOR bytes of
    # EVERY named content leaf (identifier/string/number/comment/...; never a
    # token boundary, so structure-safe with no added error-recovery cost).
    # Nearly every token's offset moves each iteration, and each top-level
    # item's byte CONTENT is high-entropy per iteration (per item, the product
    # over its named leaves of (25*(len-1))^2), so no item's bytes recur
    # across the whole timed schedule: an evolving, current-bytes-keyed
    # per-item memoizer that splices cached parses into a live parse finds
    # ~zero reusable items (a throwaway probe measured zero reusable items
    # >= 64 bytes in the mutable region on all six workloads), and
    # any cache-reassembly substitute for the full parse folds stale leaf
    # bytes or boundaries and diverges from the trusted reference leg,
    # leaving full-parse-shaped re-lex work. The incremental phase adds one
    # interior class swap within +/-64 bytes of every edit to refresh the
    # local re-lex context per iteration. Cross-repetition persistence is
    # closed too: after every leg the trusted parent reaps the candidate
    # process tree and sweeps candidate-uid residue from the shared /tmp roots
    # AND from the per-workload output directory nested under the root-owned
    # BUILD_ROOT (the leg's peak-RSS file is read out first), so no cache
    # file dropped by one leg survives into the next.
    candidate_iterations: dict[str, list[list[int]]] = {"full": [], "incremental": []}
    reference_iterations: dict[str, list[list[int]]] = {"full": [], "incremental": []}
    peak_rss_kib = 0
    for rep in range(1 + BENCH_TIMED_REPS):
        tokens = draw_token_stream(int(benchmark["fullIterations"]), int(benchmark["incrementalIterations"]))
        # Leg order alternates per repetition (reference first on even reps,
        # candidate first on odd reps). Host load inside a repetition is not
        # stationary -- container spin-up, build cooldown, and thermal ramp
        # decay monotonically over seconds -- so a FIXED order would
        # systematically favor whichever leg always runs second; the
        # interleaved ratio cancels drift shared by both legs of a pair, not
        # a bias applied to only one side of every pair. Alternation gives
        # both binaries the same distribution of within-pair positions, so
        # the per-phase minima being compared are equally treated. The order
        # is a fixed function of the repetition index, never of anything
        # candidate-controlled, and both legs still replay the identical
        # stored token stream.
        def _ref_leg() -> tuple[int, int, int, tuple[int, int], dict[str, list[int]], float]:
            return run_timed_bench(REF_BINARY, f"ref-{rep}", base, tokens, output_dir, identifier)

        def _candidate_leg() -> tuple[int, int, int, tuple[int, int], dict[str, list[int]], float]:
            return run_timed_bench(BINARY, f"candidate-{rep}", base, tokens, output_dir, identifier)

        if rep % 2 == 0:
            ref_full, ref_incremental, _, ref_digests, ref_iteration_ns, ref_cpu_sec = _ref_leg()
            full_ns, incremental_ns, rep_rss_kib, digests, candidate_iteration_ns, candidate_cpu_sec = _candidate_leg()
        else:
            full_ns, incremental_ns, rep_rss_kib, digests, candidate_iteration_ns, candidate_cpu_sec = _candidate_leg()
            ref_full, ref_incremental, _, ref_digests, ref_iteration_ns, ref_cpu_sec = _ref_leg()
        if digests != ref_digests:
            raise GateFailure(f"timed-iteration parse signature disagrees with trusted reference: {identifier}")
        for phase in ("full", "incremental"):
            enforce_iteration_floor(identifier, phase, ref_iteration_ns[phase], candidate_iteration_ns[phase])
        # Out-of-process CPU floor: the candidate leg's kernel-accounted CPU
        # (wait4 rusage, read by the trusted parent) must be plausible against
        # the pristine reference leg of the SAME repetition on the identical
        # stored token stream.
        if candidate_cpu_sec < ref_cpu_sec * MIN_CPU_FRAC:
            raise GateFailure(f"benchmark leg CPU work implausibly below trusted reference: {identifier}")
        peak_rss_kib = max(peak_rss_kib, rep_rss_kib)
        if rep > 0:
            for phase in ("full", "incremental"):
                reference_iterations[phase].append(ref_iteration_ns[phase])
                candidate_iterations[phase].append(candidate_iteration_ns[phase])
    # Per-iteration fastest-of-nine: each timed iteration index keeps its
    # fastest window across the nine timed repetitions, and the phase estimate
    # sums those minima. Timing noise is strictly additive and lands on
    # iterations, not phases, so excising it iteration-wise gives every
    # iteration nine independent chances at a calm window instead of
    # requiring one whole repetition to stay calm end to end (min-of-summed
    # phases measured ~4% A-A spread on this host; summed per-iteration
    # minima average the residuals across 24-120 iterations). Reference and
    # candidate legs share the identical stored token per (repetition,
    # iteration) slot, so the same content feeds both sides of every compared
    # minimum and the estimator is applied identically to both binaries;
    # nothing about it is candidate-controlled.
    def phase_floor_sum(per_rep: list[list[int]]) -> int:
        return sum(min(samples) for samples in zip(*per_rep, strict=True))

    reference_full_est = phase_floor_sum(reference_iterations["full"])
    candidate_full_est = phase_floor_sum(candidate_iterations["full"])
    reference_incremental_est = phase_floor_sum(reference_iterations["incremental"])
    candidate_incremental_est = phase_floor_sum(candidate_iterations["incremental"])
    full_ratio = reference_full_est / candidate_full_est
    incremental_ratio = reference_incremental_est / candidate_incremental_est
    full_speed = expected_full_bytes * 1_000_000_000.0 / candidate_full_est
    incremental_speed = expected_incremental_bytes * 1_000_000_000.0 / candidate_incremental_est
    reference_full_speed = expected_full_bytes * 1_000_000_000.0 / reference_full_est
    reference_incremental_speed = expected_incremental_bytes * 1_000_000_000.0 / reference_incremental_est
    values = (full_ratio, incremental_ratio, full_speed, incremental_speed, reference_full_speed, reference_incremental_speed)
    if not all(math.isfinite(value) and value > 0 for value in values):
        raise GateFailure(f"benchmark throughput non-finite: {identifier}")
    baseline_rss_kib = int(row["baselinePeakRssKiB"])
    if peak_rss_kib * 100 > baseline_rss_kib * 102:
        raise GateFailure(f"peak RSS gate failed: {identifier} {peak_rss_kib} KiB > baseline+2%")
    return WorkloadResult(
        full_ratio,
        incremental_ratio,
        full_speed,
        incremental_speed,
        reference_full_speed,
        reference_incremental_speed,
        peak_rss_kib,
        observed,
    )


def _kill_leg(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _read_exact(fd: int, count: int, deadline: float, pid: int) -> bytes:
    buffer = bytearray()
    while len(buffer) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _kill_leg(pid)
            raise GateFailure("benchmark leg timed out")
        ready, _, _ = select.select([fd], [], [], min(0.5, remaining))
        if not ready:
            continue
        try:
            chunk = os.read(fd, count - len(buffer))
        except BlockingIOError:
            continue
        except OSError as exc:
            _kill_leg(pid)
            raise GateFailure("benchmark leg control channel failed") from exc
        if not chunk:
            _kill_leg(pid)
            raise GateFailure("benchmark leg closed control channel early")
        buffer.extend(chunk)
    return bytes(buffer)


def _drive_phase(
    ctrl_r: int, go_w: int, identifier: str, tokens: list[bytes], deadline: float, pid: int
) -> tuple[int, list[int]]:
    """Stream one timed phase and return (receipt fold, per-iteration parse
    nanoseconds). The parent waits for the harness's ready marker, starts the
    clock as it releases this iteration's stored unpredictable parse-go token,
    and stops the clock on the harness's receipt. The receipt folds the
    go-token together with the completed parse's tree signature, so a
    candidate cannot produce it without doing the parse inside the timed
    window, and cannot precompute it before the token is first revealed at
    clock-start. The parent folds the receipt stream into a per-phase
    accumulator it later checks against the pristine reference leg on the
    identical stored token stream."""
    iteration_ns: list[int] = []
    fold = DIGEST_BASIS
    for token in tokens:
        if _read_exact(ctrl_r, 1, deadline, pid) != b"R":
            _kill_leg(pid)
            raise GateFailure(f"benchmark leg desynchronized (ready): {identifier}")
        started = time.monotonic_ns()
        os.write(go_w, token)
        receipt = _read_exact(ctrl_r, 8, deadline, pid)
        iteration_ns.append(time.monotonic_ns() - started)
        fold = ((fold ^ int.from_bytes(receipt, "little")) * FNV_PRIME) & MASK64
    return fold, iteration_ns


def _wait_leg(pid: int, deadline: float) -> tuple[int, resource.struct_rusage | None]:
    """Reap one bench leg and return (status, rusage). The rusage comes from
    the kernel's reaped-child accounting (os.wait4 on exactly this leg's
    process-group leader, whose own accounting accumulates every descendant it
    waited for), so the leg's CPU time is measured OUT OF PROCESS by the
    trusted parent and nothing candidate-emitted contributes to it."""
    while True:
        try:
            waited, status, usage = os.wait4(pid, os.WNOHANG)
        except ChildProcessError:
            return 0, None
        if waited == pid:
            return status, usage
        if time.monotonic() >= deadline:
            _kill_leg(pid)
            try:
                _, status, usage = os.wait4(pid, 0)
            except ChildProcessError:
                return 0, None
            return status, usage
        time.sleep(0.005)


def run_timed_bench(
    binary: Path,
    label: str,
    base: list[str],
    tokens: dict[str, list[bytes]],
    output_dir: Path,
    identifier: str,
) -> tuple[int, int, int, tuple[int, int], dict[str, list[int]], float]:
    """Run one bench leg. The trusted parent forks the sealed harness (under
    /usr/bin/time for peak RSS and prlimit --nproc=1), streams one stored
    unpredictable CSPRNG parse-go token per timed iteration over inherited
    pipes at clock-start, and times each iteration from the go-token send to
    the harness's receipt. The receipt binds the go-token to the completed
    parse's content-inclusive tree signature (structure plus leaf source
    bytes), so the measured window necessarily contains the mutation and
    parse the token seeds; the harness holds no clock of its own to rewrite.
    Returns the summed full and incremental parse nanoseconds, peak RSS KiB,
    the two per-phase receipt folds, the per-phase per-iteration nanoseconds
    for the plausibility floor, and the leg's total CPU seconds read out of
    process from the kernel's reaped-child wait4 accounting (never
    candidate-reported). Reaps the full candidate-uid tree after the leg."""
    full_iterations = len(tokens["full"])
    incremental_iterations = len(tokens["incremental"])
    rss_path = output_dir / f"peak-rss-kib-{label}.txt"
    go_r, go_w = os.pipe()
    ctrl_r, ctrl_w = os.pipe()
    arguments = [
        "/usr/bin/time", "-f", "%M", "-o", str(rss_path), "--",
        "/usr/bin/prlimit", "--nproc=1", "--",
        str(binary), "bench", *base,
        str(full_iterations), str(incremental_iterations),
        str(go_r), str(ctrl_w),
    ]
    pid = os.fork()
    if pid == 0:
        try:
            os.close(go_w)
            os.close(ctrl_r)
            os.set_inheritable(go_r, True)
            os.set_inheritable(ctrl_w, True)
            with open(os.devnull, "wb") as devnull:
                os.dup2(devnull.fileno(), 0)
                os.dup2(devnull.fileno(), 1)
                os.dup2(devnull.fileno(), 2)
                os.chdir(BUILD_ROOT)
                os.setsid()
                _leg_isolation()
                os.execv(arguments[0], arguments)
        finally:
            os._exit(127)
    os.close(go_r)
    os.close(ctrl_w)
    deadline = time.monotonic() + BENCH_TIMEOUT_SEC
    try:
        full_fold, full_iteration_ns = _drive_phase(ctrl_r, go_w, identifier, tokens["full"], deadline, pid)
        incremental_fold, incremental_iteration_ns = _drive_phase(
            ctrl_r, go_w, identifier, tokens["incremental"], deadline, pid
        )
        status, leg_usage = _wait_leg(pid, deadline)
        # Read the demoted leg's peak-RSS output (written by /usr/bin/time into
        # the candidate-writable output_dir) BEFORE the writable sweep: the
        # sweep now recursively removes candidate-uid files nested under
        # BUILD_ROOT to close cross-repetition persistence, so it would
        # otherwise delete this file before it is read.
        try:
            peak_rss_text = rss_path.read_text().strip()
        except OSError as exc:
            raise GateFailure(f"benchmark RSS output malformed: {identifier}") from exc
    finally:
        os.close(go_w)
        os.close(ctrl_r)
        _reap_candidate_tree()
        _clear_candidate_writable()
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise GateFailure(f"benchmark leg failed: {identifier}")
    if leg_usage is None:
        raise GateFailure(f"benchmark leg CPU accounting unavailable: {identifier}")
    leg_cpu_sec = leg_usage.ru_utime + leg_usage.ru_stime
    if not math.isfinite(leg_cpu_sec) or leg_cpu_sec <= 0:
        raise GateFailure(f"benchmark leg CPU accounting invalid: {identifier}")
    full_ns = sum(full_iteration_ns)
    incremental_ns = sum(incremental_iteration_ns)
    if full_ns <= 0 or incremental_ns <= 0:
        raise GateFailure(f"benchmark clock resolution failure: {identifier}")
    try:
        peak_rss_kib = int(peak_rss_text)
    except ValueError as exc:
        raise GateFailure(f"benchmark RSS output malformed: {identifier}") from exc
    return (
        full_ns,
        incremental_ns,
        peak_rss_kib,
        (full_fold, incremental_fold),
        {"full": full_iteration_ns, "incremental": incremental_iteration_ns},
        leg_cpu_sec,
    )


def geometric_mean(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("cannot scalarize invalid throughput")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def main() -> None:
    result_hash = ""
    started = time.monotonic()
    try:
        _become_subreaper()
        check_source_envelope()
        metadata, split_dir = load_metadata()
        verify_assets(metadata, split_dir)
        mount_build_tmpfs()
        prepare_source(split_dir)
        build_sec = build_harness()
        ratios: list[float] = []
        speeds: list[float] = []
        reference_speeds: list[float] = []
        rss: dict[str, int] = {}
        exact: dict[str, dict[str, str]] = {}
        for row in metadata["workloads"]:
            result = run_workload(row, split_dir)
            ratios.extend((result.full_ratio, result.incremental_ratio))
            speeds.extend((result.full_speed, result.incremental_speed))
            reference_speeds.extend((result.reference_full_speed, result.reference_incremental_speed))
            rss[str(row["id"])] = result.peak_rss_kib
            exact[str(row["id"])] = result.observed
        raw_q = geometric_mean(speeds)
        reference_q = geometric_mean(reference_speeds)
        # Drift compensation: every cell is the ratio of summed
        # per-iteration-fastest-of-nine phase times between the candidate and
        # the trusted in-eval baseline yardstick run interleaved in the same
        # evaluation, so host frequency/contention state shared by the paired
        # measurements divides out of the reported bytes/sec-scale score.
        score = REFERENCE_NORMALIZATION * geometric_mean(ratios)
        deterministic = {
            "treeSitterRevision": TREE_SITTER_REVISION,
            "grammarRevisions": EXPECTED_GRAMMAR_REVISIONS,
            "splitGenerator": metadata["generator"],
            "exact": exact,
            "parserTests": "full-incremental-equivalence-v1",
        }
        result_hash = hashlib.sha256(canonical(deterministic).encode()).hexdigest()
        elapsed = time.monotonic() - started
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "exact_trees_pass": True,
                "edit_results_pass": True,
                "rss_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": f"12 full/incremental throughput cells passed exact tree, parser-test, edit, digest, and RSS gates; q={score:.3f} bytes/s (per-iteration fastest-of-nine reference-normalized; raw {raw_q:.3f}, in-eval trusted baseline {reference_q:.3f})",
                }
            },
            "diagnostics": {
                "summary": "six full/incremental parser-test pairs passed exact tree/edit equivalence and baseline+2% RSS",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(build_sec, 6),
                "eval_sec": round(elapsed, 6),
                "peak_rss_kib": rss,
                "raw_q": raw_q,
                "reference_q": reference_q,
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except GateFailure as exc:
        emit_failure(str(exc), result_hash)
    except Exception as exc:
        emit_failure(f"trusted evaluator error: {type(exc).__name__}", result_hash)
    finally:
        try:
            _reap_candidate_tree()
        except GateFailure:
            pass
        _clear_candidate_writable()
        if BUILD_ROOT.exists():
            shutil.rmtree(BUILD_ROOT, ignore_errors=True)
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
