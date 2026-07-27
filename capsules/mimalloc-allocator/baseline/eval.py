#!/usr/bin/env python3
"""Trusted evaluator for microsoft/mimalloc allocator throughput.

Exec-boundary design: the benchmark harness executables are compiled by THIS
trusted evaluator, as root, from the sealed TRUSTED_DIR sources only, and link
NO allocator code. The allocator under measurement (candidate or pristine
reference) is built as a shared library by a demoted worker, and the trusted
harness dlopens it only AFTER the parent-owned control channel authenticates,
so no candidate instruction can execute at benchmark process startup or ahead
of the trusted protocol. The parent owns the wall clock, a fresh per-sample
go-nonce delivered at clock-start, a per-sample paired plausibility floor
against the interleaved pristine reference, and kernel-owned cgroup memory
readings that reject timed windows lacking workload-scale allocation.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import resource
import select
import shutil
import subprocess
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path("/tmp/hone-mimalloc-build")
SOURCE = BUILD_ROOT / "source"
BUILD_DIR = BUILD_ROOT / "build"
# Trusted harness executables: compiled by the trusted evaluator from
# TRUSTED_DIR/hone only (root-owned, on the root-mounted tmpfs), shared by the
# candidate and reference legs so both run the byte-identical trusted image.
HARNESS_DIR = BUILD_ROOT / "harness"
# Pristine reference: the sealed baseline allocator built from TRUSTED_DIR with
# NO candidate overlay. Each workload is scored as a load-cancelling yardstick
# ratio of the reference vs the candidate measured back-to-back under the same
# host load, so a fully contended eval inflates both legs equally and leaves
# the ratio (hence the score) unchanged.
REF_ROOT = BUILD_ROOT / "reference"
REF_SOURCE = REF_ROOT / "source"
REF_BUILD_DIR = REF_ROOT / "build"
CGROUP_ROOT = Path("/tmp/hone-mimalloc-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10
SANDBOX_UID = 2000
# The pristine reference runs as a DISTINCT uid so its per-uid RLIMIT_NPROC
# thread cap is independent of the candidate's — the two run concurrently while
# interleaved and must not share a process budget.
REF_UID = 2001
PROCESS_TIMEOUT_SEC = 240
WORKLOAD_TIMEOUT_SEC = 30
MAX_ROUNDS = 1 << 20
WORKLOAD_IDS = ("single", "multithread", "small", "fragmentation")
HONE_SAMPLES = 7
# Fresh report fd handed to each benchmark child: it streams work-completion
# tokens here while the trusted evaluator keeps ownership of fd 1 and the clock.
HONE_REPORT_FD_ENV = "HONE_REPORT_FD"
# A benchmark that skips the allocation workload commits almost nothing (only
# the harness + libmimalloc code and thread stacks), so the trusted whole-tree
# cgroup peak must clear a floor as well as stay under the ceiling: it rejects a
# completion stream produced without running the allocation workload. The floor
# stays below the leanest LEGITIMATE allocator's whole-tree footprint — a
# minimal-overhead allocator commits little beyond the live data, which on the
# multithread/small workloads is already only ~0.38-0.42x the (segment-heavy)
# baseline tree peak. A single large malloc+memset reaches the same whole-tree
# peak as the real workload, so it cannot be excluded by a scalar cgroup floor;
# the skip-the-workload defenses are instead the trusted per-round
# disjointness + canary read-back fold (validated against the pristine
# reference) plus the per-sample MEMORY_WORK_FLOOR committed-memory backstop,
# which force the real per-allocation work into every TIMED window.
MIN_TREE_PEAK_FRACTION = 0.25
# Sealed plausibility band on the paired yardstick. The timed loop necessarily
# calls allocator code inside the harness process, so a candidate-controlled
# path that impersonates the report protocol after library load cannot be made
# impossible in-process; it IS bounded: every timed candidate sample must stay
# within MAX_PLAUSIBLE_SPEEDUP of the pristine reference leg it is paired
# with, and so must the final min-of-N ratio. No legitimate allocator rewrite
# plausibly serves these fixed canary-traffic workloads 4x faster than the
# tuned upstream baseline, so the band never binds on honest improvements
# while capping any unearned residual at 4x instead of unbounded.
MAX_PLAUSIBLE_SPEEDUP = 4.0
# Control-channel authentication fold, mirrored from hone/bench.c: the pure
# trusted harness image (no allocator byte mapped yet) must fold a fresh
# 64-bit token before it is allowed to dlopen the allocator library.
U64_MASK = (1 << 64) - 1
AUTH_INIT = 0xCBF29CE484222325
AUTH_TAG = 0x484F4E4541555448  # "HONEAUTH"
# Per-workload kernel committed-memory floor (bytes): the trusted parent polls
# the measurement leaf's memory.current across each timed window and requires
# the observed peak to reach this floor. Under the exec boundary the trusted
# workload (per-round disjointness, canary write/read-back, and the nonce-bound
# checksum validated against the pristine reference) already forces the
# candidate allocator to hand out real distinct writable memory for the whole
# live set every sample, so this kernel-owned reading is a defense-in-depth
# backstop confirming the timed window committed workload-scale memory rather
# than the sole per-sample work proof. Each floor sits well below the sealed
# baseline's observed committed live set (single ~8.4M, multithread ~6.3M,
# small ~1.1M, fragmentation ~67M) so no allocator that serves the live set can
# miss it, while a degenerate stream committing almost nothing is rejected.
MEMORY_WORK_FLOOR = {
    "single": 3 << 20,
    "multithread": 3 << 20,
    "small": 512 << 10,
    "fragmentation": 24 << 20,
}
MEMORY_POLL_SEC = 0.002
ALLOWED_MUTABLE_PREFIXES = ("src/", "include/mimalloc/")
# Files under the mutable prefixes whose contents are ALWAYS taken from the
# trusted baseline seed, never from the candidate workspace (and which the
# sanitized terminal artifact legitimately omits).
TRUSTED_ONLY_MUTABLE = frozenset({
    "src/alloc-override.c",
    "src/static.c",
    "src/stats.c",
    "include/mimalloc/types.h",
})
STAT_GUARD_TOKENS = ("MI_STAT", "mi_stat_", "_mi_stat_", "mi_heap_stat_", "mi_os_stat_")
# Kernel-enforced per-uid ceiling on the task count: a coarse anti-runaway
# bound (the workload's own threads plus fixed head-room), NOT a
# gaming-resistance primitive. Zero-slack caps false-fail legitimate threaded
# allocators (mimalloc itself may spin a transient purge/reclaim helper) and
# race the reaping of the just-exited same-uid build/test workers at setuid;
# the exec boundary, per-sample plausibility floor, and kernel memory signal
# are the real bounds on a resident helper.
MAIN_THREAD_ALLOWANCE = 4
# Runtime symbols the allocator shared library must never define: the library
# is mapped RTLD_LOCAL into the trusted harness, so these definitions could
# not rebind the harness's already-resolved libc calls, but allocator code has
# no legitimate reason to carry its own timing, formatting, or report-channel
# primitives — a definition here is treated as an interposition attempt and
# rejected outright (defense-in-depth around the exec boundary).
INTERPOSITION_SYMBOLS = frozenset({
    "clock_gettime", "__clock_gettime", "clock_gettime64", "__clock_gettime64",
    "gettimeofday", "__gettimeofday", "clock", "times",
    "syscall",
    "printf", "__printf_chk", "fprintf", "__fprintf_chk",
    "vprintf", "vfprintf", "__vfprintf_chk", "dprintf", "sprintf", "snprintf",
    "puts", "fputs", "fwrite", "putchar", "fputc",
    "write", "__write", "writev", "pwrite",
    "qsort", "qsort_r",
})


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
            "checksums_pass": False,
            "peak_committed_pass": False,
            "tree_peak_pass": False,
            "fragmentation_pass": False,
            "thread_count_pass": False,
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


def demote(uid: int = SANDBOX_UID) -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    # Virtual address-space cap: generous headroom for mimalloc's PROT_NONE
    # arena reservations (which scale with thread count and can far exceed
    # committed memory) so a legitimate multi-threaded allocator is not
    # spuriously starved of address space. This is a coarse anti-runaway cap,
    # NOT the memory-regression gate: committed memory is gated by the kernel
    # cgroup memory.peak and the mi_stats page-committed peak, both of which
    # measure real charged pages and are unaffected by the virtual reservation.
    resource.setrlimit(resource.RLIMIT_AS, (8 << 30, 8 << 30))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)


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
        ["mount", "-t", "tmpfs", "-o", "size=1g,mode=1777,exec,nosuid,nodev", "hone-mimalloc-build", str(BUILD_ROOT)],
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


def mount_measurement_cgroup() -> None:
    # Docker mounts the container's cgroup2 view read-only, but the trusted
    # evaluator holds mount authority: a fresh cgroup2 instance over the same
    # (namespaced) hierarchy is writable by root only.
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "cgroup2", "-o", "nosuid,nodev,noexec", "hone-mimalloc-cg", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        CGROUP_ROOT.rmdir()
        raise GateFailure("trusted measurement cgroup mount failed")
    try:
        # cgroup v2 no-internal-process rule: park the evaluator (and every
        # worker it forks) in a trusted leaf so the memory controller can be
        # delegated to the per-workload measurement leaves.
        CGROUP_TRUSTED.mkdir(mode=0o755)
        (CGROUP_TRUSTED / "cgroup.procs").write_text(str(os.getpid()))
        (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")
    except OSError as exc:
        raise GateFailure("trusted measurement cgroup setup failed") from exc


def unmount_measurement_cgroup() -> None:
    completed = subprocess.run(
        ["umount", "-l", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    if completed.returncode == 0:
        try:
            CGROUP_ROOT.rmdir()
        except OSError:
            pass


def drain_measurement_leaf(leaf: Path) -> None:
    # Kill every process still charged to the leaf (detached descendants in
    # new sessions included), wait for the kernel to release them, then
    # retire the leaf. Exit disassociates tasks from the cgroup before they
    # are reaped, so an empty cgroup.procs means the leaf can be removed.
    deadline = time.monotonic() + CGROUP_DRAIN_SEC
    try:
        (leaf / "cgroup.kill").write_text("1")
    except OSError:
        pass
    while True:
        try:
            populated = (leaf / "cgroup.procs").read_text().strip() != ""
        except OSError:
            populated = False
        if not populated:
            break
        if time.monotonic() > deadline:
            raise GateFailure("measurement cgroup could not be drained")
        time.sleep(0.05)
    try:
        leaf.rmdir()
    except OSError as exc:
        raise GateFailure("measurement cgroup could not be retired") from exc


def build_harness() -> None:
    # The benchmark harness is compiled by the TRUSTED evaluator, as root,
    # exclusively from the sealed TRUSTED_DIR sources (hone/ + protected
    # headers) — never from the candidate-overlaid tree — into a root-owned
    # directory on the build tmpfs (sticky-bit parent: uid-2000 workers can
    # neither replace the directory nor the binaries). It links NO allocator
    # code: the allocator reaches the process only through the
    # post-authentication dlopen inside hone_bench_main, so the candidate and
    # reference legs run the byte-identical trusted process image and no
    # candidate instruction can execute at benchmark process startup.
    HARNESS_DIR.mkdir(mode=0o755, exist_ok=False)
    for workload in WORKLOAD_IDS:
        command = [
            "cc", "-O2", "-DNDEBUG", "-std=c11", "-Wall", "-Wextra", "-Werror",
            f"-I{TRUSTED_DIR / 'include'}", f"-I{TRUSTED_DIR / 'hone'}",
            str(TRUSTED_DIR / "hone" / "bench.c"),
            str(TRUSTED_DIR / "hone" / f"bench-{workload}.c"),
            "-pthread", "-ldl", "-lm", "-o", str(HARNESS_DIR / f"hone-{workload}"),
        ]
        try:
            completed = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise GateFailure(f"trusted harness build failed: {exc}") from exc
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", "replace")[-500:]
            raise GateFailure(f"trusted harness build failed: {detail}")
        os.chmod(HARNESS_DIR / f"hone-{workload}", 0o755)


def resolve_shared_lib(build_dir: Path) -> Path:
    link = build_dir / "libmimalloc.so"
    try:
        real = link.resolve(strict=True)
    except OSError as exc:
        raise GateFailure("built allocator shared library is missing") from exc
    if not real.is_file() or build_dir.resolve() not in real.parents:
        raise GateFailure("built allocator shared library resolved outside its build tree")
    return real


def auth_fold(token: int) -> int:
    # Mirror of hone_checksum(hone_checksum(AUTH_INIT, token), AUTH_TAG).
    state = AUTH_INIT
    for value in (token, AUTH_TAG):
        state ^= (value + 0x9E3779B97F4A7C15 + (state << 6) + (state >> 2)) & U64_MASK
    return state & U64_MASK


def _run_binutil(argv: list[str]) -> str:
    try:
        completed = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateFailure(f"library audit failed: {exc}") from exc
    if completed.returncode != 0:
        raise GateFailure("library audit could not read the allocator library")
    return completed.stdout.decode("ascii", "replace")


def _initializer_profile(library: Path) -> dict:
    sections = _run_binutil(["readelf", "-S", "--wide", str(library)])
    profile = {"preinit": 0, "init_array": 0, "ctors": 0, "dt_init": False}
    for line in sections.splitlines():
        fields = line.split()
        for index, field in enumerate(fields):
            if field in (".preinit_array", ".init_array", ".ctors"):
                # readelf -S --wide row: [Nr] Name Type Address Off Size ...
                try:
                    size = int(fields[index + 4], 16)
                except (IndexError, ValueError) as exc:
                    raise GateFailure("library audit could not parse section sizes") from exc
                profile[field.lstrip(".")] = size
    dynamic = _run_binutil(["readelf", "-d", str(library)])
    profile["dt_init"] = "(INIT)" in dynamic
    return profile


def audit_initializers(candidate_so: Path, reference_so: Path) -> None:
    # Initializer audit across the exec boundary. Module initializers in the
    # allocator library run at dlopen — AFTER the control channel
    # authenticates and BEFORE any sample nonce exists — so they can no longer
    # front-run the trusted protocol; this audit additionally rejects a
    # candidate that ADDS initializers at all: its .preinit_array must be
    # empty and its (.init_array, .ctors, DT_INIT) profile must be IDENTICAL
    # to the pristine reference library's, built from the sealed baseline by
    # the same toolchain and flags.
    candidate = _initializer_profile(candidate_so)
    reference = _initializer_profile(reference_so)
    if candidate["preinit"] != 0:
        raise GateFailure("candidate allocator library declares pre-initializers")
    if candidate != reference:
        raise GateFailure("candidate allocator library initializer profile diverged from the pristine reference")


def assert_no_interposition(library: Path) -> None:
    completed_output = _run_binutil(["nm", "--defined-only", "--format=posix", "-D", str(library)])
    for line in completed_output.splitlines():
        fields = line.split()
        if len(fields) < 2:
            continue
        name, symbol_type = fields[0], fields[1]
        if symbol_type in ("U", "v", "w"):
            continue
        if name in INTERPOSITION_SYMBOLS:
            raise GateFailure(
                f"candidate defines interposable runtime symbol '{name}' in {library.name}"
            )

def check_source_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    trusted_paths = {
        path.relative_to(TRUSTED_DIR).as_posix()
        for path in TRUSTED_DIR.rglob("*")
        if path.is_file()
    }
    candidate_files: set[str] = set()
    for path in WORKSPACE.rglob("*"):
        if path.is_symlink():
            raise GateFailure("symbolic links are not allowed in the candidate source")
        if path.is_dir():
            continue
        relative = path.relative_to(WORKSPACE).as_posix()
        if not path.is_file():
            raise GateFailure(f"non-regular file in the candidate source: {relative}")
        candidate_files.add(relative)
        if relative in trusted_paths or relative.startswith(ALLOWED_MUTABLE_PREFIXES):
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")
    # The sanitized terminal artifact legitimately omits every protected
    # file, but the full mutable allocator inventory must be present: the
    # build tree is seeded from the trusted baseline and ONLY these files
    # are overlaid from the candidate workspace.
    required_mutable = {
        trusted for trusted in trusted_paths
        if trusted.startswith(ALLOWED_MUTABLE_PREFIXES) and trusted not in TRUSTED_ONLY_MUTABLE
    }
    missing = sorted(required_mutable - candidate_files)
    if missing:
        raise GateFailure(
            f"mutable allocator source inventory incomplete: {missing[0]} (+{len(missing) - 1} more missing)"
        )


    def guarded_lines(path: Path) -> tuple[str, ...]:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            return ()
        return tuple(line.strip() for line in lines if any(token in line for token in STAT_GUARD_TOKENS))

    for path in WORKSPACE.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(WORKSPACE)
        relative_posix = relative.as_posix()
        if not relative_posix.startswith(ALLOWED_MUTABLE_PREFIXES):
            continue
        trusted_path = TRUSTED_DIR / relative
        candidate_guard = guarded_lines(path)
        trusted_guard = guarded_lines(trusted_path) if trusted_path.is_file() else ()
        if candidate_guard != trusted_guard:
            raise GateFailure(f"allocator statistics instrumentation changed: {relative_posix}")

def copy_candidate() -> None:
    # Terminal artifacts carry only the mutable allocator files: seed the
    # whole build tree from the trusted baseline, then overlay ONLY the
    # candidate's mutable files. Protected content is never sourced from the
    # candidate workspace, in development or terminal mode.
    shutil.copytree(
        TRUSTED_DIR,
        SOURCE,
        symlinks=False,
        ignore=shutil.ignore_patterns(".gitdir", ".hone-compiler-tmp", "__pycache__"),
    )
    for path in sorted(WORKSPACE.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(WORKSPACE).as_posix()
        if not relative.startswith(ALLOWED_MUTABLE_PREFIXES) or relative in TRUSTED_ONLY_MUTABLE:
            continue
        destination = SOURCE / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    shutil.copytree(TRUSTED_DIR / "hone", SOURCE / "hone", dirs_exist_ok=True)
    shutil.copy2(TRUSTED_DIR / "src" / "stats.c", SOURCE / "src" / "stats.c")
    shutil.copy2(TRUSTED_DIR / "include" / "mimalloc-stats.h", SOURCE / "include" / "mimalloc-stats.h")
    shutil.copy2(TRUSTED_DIR / "include" / "mimalloc" / "types.h", SOURCE / "include" / "mimalloc" / "types.h")
    # The demoted worker compiles with TMPDIR inside the source tree.
    compiler_tmp = SOURCE / ".hone-compiler-tmp"
    compiler_tmp.mkdir(mode=0o700, exist_ok=True)
    os.chmod(compiler_tmp, 0o777)


def copy_reference() -> None:
    # The load-cancelling yardstick reference: the SEALED baseline allocator,
    # built from TRUSTED_DIR with NO candidate overlay. It is trusted code, so
    # it needs no correctness gate — only a clean build and matching sealed
    # checksums when it runs beside the candidate.
    shutil.copytree(
        TRUSTED_DIR,
        REF_SOURCE,
        symlinks=False,
        ignore=shutil.ignore_patterns(".gitdir", ".hone-compiler-tmp", "__pycache__"),
    )
    # worker.build compiles into REF_SOURCE.parent/build; the demoted uid-2000
    # worker must be able to create that build dir under the root-owned
    # reference root (unlike the candidate build, which lands directly under the
    # 1777 tmpfs mount).
    os.chmod(REF_ROOT, 0o777)
    compiler_tmp = REF_SOURCE / ".hone-compiler-tmp"
    compiler_tmp.mkdir(mode=0o700, exist_ok=True)
    os.chmod(compiler_tmp, 0o777)


def load_workloads() -> dict:
    metadata_files = sorted(ASSETS.rglob("workloads.json"))
    if len(metadata_files) != 1:
        raise GateFailure("selected asset split must contain exactly one workloads.json")
    try:
        metadata = json.loads(metadata_files[0].read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed workload metadata is malformed") from exc
    if not isinstance(metadata, dict) or set(metadata) != {"driverVersion", "schemaVersion", "split", "workloads"}:
        raise GateFailure("sealed workload metadata has invalid shape")
    if metadata["schemaVersion"] != 1 or metadata["driverVersion"] != "mimalloc-four-v1":
        raise GateFailure("sealed workload driver version mismatch")
    rows = metadata["workloads"]
    if not isinstance(rows, list) or len(rows) != 4:
        raise GateFailure("sealed workload set must contain exactly four workloads")
    if tuple(row.get("id") for row in rows if isinstance(row, dict)) != WORKLOAD_IDS:
        raise GateFailure("sealed workload order or identity mismatch")
    expected_fields = {
        "baselineFragmentationRatio", "baselinePeakPageCommittedBytes", "baselineTreePeakBytes",
        "expectedChecksum", "expectedOperations", "id", "rounds", "seed", "threads",
    }
    seeds: set[int] = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != expected_fields:
            raise GateFailure("sealed workload row has invalid fields")
        if not isinstance(row["seed"], int) or not 0 < row["seed"] < 2**64 or row["seed"] in seeds:
            raise GateFailure("sealed workload seed is invalid or duplicated")
        seeds.add(row["seed"])
        if not isinstance(row["rounds"], int) or not 0 < row["rounds"] <= MAX_ROUNDS:
            raise GateFailure("sealed round budget is invalid")
        if not isinstance(row["expectedOperations"], int) or row["expectedOperations"] <= 0:
            raise GateFailure("sealed operation count is invalid")
        required_threads = 4 if row["id"] == "multithread" else 1
        if row["threads"] != required_threads or row["threads"] > 4:
            raise GateFailure("sealed thread count exceeds the four-thread cap")
        if not isinstance(row["expectedChecksum"], str) or len(row["expectedChecksum"]) != 16:
            raise GateFailure("sealed workload checksum is invalid")
        if not isinstance(row["baselinePeakPageCommittedBytes"], int) or row["baselinePeakPageCommittedBytes"] <= 0:
            raise GateFailure("sealed peak committed baseline is invalid")
        if not isinstance(row["baselineTreePeakBytes"], int) or row["baselineTreePeakBytes"] <= 0:
            raise GateFailure("sealed process-tree peak baseline is invalid")
        fragmentation = row["baselineFragmentationRatio"]
        if not isinstance(fragmentation, (int, float)) or not math.isfinite(fragmentation) or not 0 < fragmentation <= 1:
            raise GateFailure("sealed fragmentation baseline is invalid")
    return metadata


def _read_report_line(report_fd: int, deadline: float) -> bytes:
    # Newline-delimited token reader over the child report pipe, bounded by a
    # trusted deadline: a benchmark that never speaks the protocol (e.g. a
    # constructor that skipped the workload and exited) closes the pipe or
    # stalls, and either is a gate failure rather than a hang.
    buffer = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GateFailure("benchmark report channel timed out")
        readable, _, _ = select.select([report_fd], [], [], remaining)
        if not readable:
            raise GateFailure("benchmark report channel timed out")
        chunk = os.read(report_fd, 1)
        if not chunk:
            raise GateFailure("benchmark closed the report channel early")
        if chunk == b"\n":
            return bytes(buffer)
        buffer += chunk
        if len(buffer) > 256:
            raise GateFailure("benchmark report line exceeded protocol bound")


class _Bench:
    # A launched benchmark process (candidate or reference) with its own
    # measurement cgroup leaf, report pipe, and control channel.
    def __init__(self, binary: Path, allocator_so: Path, row: dict, role: str, uid: int) -> None:
        self.row = row
        self.role = role
        self.rounds = int(row["rounds"])
        self.expected_ops = int(row["expectedOperations"])
        self.work_floor = int(MEMORY_WORK_FLOOR[row["id"]])
        task_cap = int(row["threads"]) + MAIN_THREAD_ALLOWANCE
        self.leaf = CGROUP_ROOT / f"bench-{role}-{row['id']}"
        self.leaf.mkdir(mode=0o755, exist_ok=False)
        leaf_procs = self.leaf / "cgroup.procs"
        self.current_path = self.leaf / "memory.current"
        self.report_read, report_write = os.pipe()

        def capped_demote() -> None:
            # Whole-tree memory accounting: the workload joins its measurement
            # leaf while still root, so every process it spawns is charged to a
            # cgroup whose control files the demoted code can never write.
            # memory.peak is kernel-owned and monotone.
            with open(leaf_procs, "w") as handle:
                handle.write("0")
            # Kernel-enforced per-uid ceiling on the task count, applied before
            # the privilege drop so the exec'd workload inherits the sealed
            # budget. The candidate and reference use distinct uids so their
            # budgets do not collide while they run interleaved.
            resource.setrlimit(resource.RLIMIT_NPROC, (task_cap, task_cap))
            demote(uid)

        child_env = {
            HONE_REPORT_FD_ENV: str(report_write),
            "LC_ALL": "C.UTF-8",
            "LANG": "C.UTF-8",
            # Reserve a generous glibc static-TLS surplus at harness startup so
            # the post-authentication dlopen of the initial-exec allocator
            # library maps cleanly even when the candidate adds its own
            # thread-locals (the default ~512B surplus overflows). Read by ld.so
            # at process start; identical for the candidate and reference legs.
            "GLIBC_TUNABLES": "glibc.rtld.optional_static_tls=1048576",
        }
        # A heavily-loaded shared host can transiently refuse a fork/exec with
        # EAGAIN (host task exhaustion). That is unrelated to the candidate, so
        # the spawn is retried a few times with a short backoff before it is
        # treated as a launch failure; the report pipe write-end is closed only
        # once, after the spawn settles.
        self.proc: subprocess.Popen | None = None
        spawn_exc: OSError | None = None
        try:
            for spawn_attempt in range(6):
                try:
                    self.proc = subprocess.Popen(
                        [str(binary), str(row["seed"]), str(self.rounds), str(allocator_so)],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        preexec_fn=capped_demote,
                        cwd=binary.parent,
                        pass_fds=(report_write,),
                        env=child_env,
                    )
                    break
                except OSError as exc:
                    spawn_exc = exc
                    time.sleep(0.5 * (spawn_attempt + 1))
        finally:
            os.close(report_write)
        if self.proc is None:
            raise GateFailure(f"{row['id']} {role} benchmark process could not be spawned: {spawn_exc}")
        if self.proc.stdin is None:
            raise GateFailure(f"{row['id']} {role} control channel unavailable")
        self.control = self.proc.stdin
        # Control-channel authentication BEFORE any allocator byte is mapped:
        # the harness executable links no allocator code and must fold a fresh
        # 64-bit token while its process image is still purely trusted. Only
        # after this parent verifies the fold does the harness dlopen the
        # allocator library and confirm with 'L' — so any library initializer
        # runs post-authentication, at a trusted-chosen instant, before any
        # sample nonce exists anywhere.
        try:
            deadline = time.monotonic() + WORKLOAD_TIMEOUT_SEC
            token = int.from_bytes(os.urandom(8), "big")
            self.control.write(f"A {token}\n".encode("ascii"))
            self.control.flush()
            expected = f"A {auth_fold(token):016x}".encode("ascii")
            if _read_report_line(self.report_read, deadline) != expected:
                raise GateFailure(f"{row['id']} {role} control channel failed authentication")
            if _read_report_line(self.report_read, deadline) != b"L":
                raise GateFailure(f"{row['id']} {role} failed to map the allocator library after authentication")
        except BaseException:
            self.close()
            raise

    def _memory_current(self) -> int:
        try:
            return int(self.current_path.read_text())
        except (OSError, ValueError) as exc:
            raise GateFailure(f"{self.row['id']} {self.role} measurement leaf lost its memory accounting") from exc

    def sample(self, nonce: bytes) -> tuple[int, str]:
        # One authenticated measured region. The trusted clock starts the instant
        # the fresh go token is released and stops the instant the child's
        # completion token becomes readable. The parent hands the SAME nonce to
        # the candidate and the pristine reference so their nonce-bound checksums
        # can be compared: the go token is folded into every allocation's canary
        # pattern and every workload folds the word it READS BACK from each live
        # block, so a matching checksum requires the per-block write/read-back
        # traffic after this nonce is released. The kernel-owned memory.current
        # peak read across the window is a defense-in-depth backstop that the
        # timed region committed workload-scale memory.
        deadline = time.monotonic() + WORKLOAD_TIMEOUT_SEC
        if _read_report_line(self.report_read, deadline) != b"R":
            raise GateFailure(f"{self.row['id']} {self.role} broke the ready handshake")
        start = time.monotonic_ns()
        self.control.write(nonce + b"\n")
        self.control.flush()
        window_peak = self._memory_current()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise GateFailure(f"{self.row['id']} {self.role} report channel timed out")
            readable, _, _ = select.select([self.report_read], [], [], min(MEMORY_POLL_SEC, remaining))
            if readable:
                break
            window_peak = max(window_peak, self._memory_current())
        stop = time.monotonic_ns()
        # Committed pages stay charged for the whole window, so one more kernel
        # reading immediately after the completion token still observes the
        # in-window commit even when the timed region is shorter than the grid.
        window_peak = max(window_peak, self._memory_current())
        first = os.read(self.report_read, 1)
        if not first:
            raise GateFailure(f"{self.row['id']} {self.role} closed the report channel early")
        response = b"" if first == b"\n" else first + _read_report_line(self.report_read, deadline)
        fields = response.split()
        if len(fields) != 4 or fields[0] != b"T" or fields[1] != nonce:
            raise GateFailure(f"{self.row['id']} {self.role} returned an unauthenticated sample")
        if int(fields[2]) != self.expected_ops:
            raise GateFailure(f"{self.row['id']} {self.role} operation count diverged from the sealed budget")
        if stop <= start:
            raise GateFailure(f"{self.row['id']} {self.role} produced a non-monotonic measurement")
        if window_peak < self.work_floor:
            raise GateFailure(f"{self.row['id']} {self.role} timed sample committed below the workload-scale kernel memory floor")
        return stop - start, fields[3].decode("ascii")

    def finalize(self) -> dict:
        # Read the completion record, drain the process, and read the trusted
        # whole-tree peak while the leaf still exists. Cleanup (kill + leaf
        # retire) is the caller's responsibility via close().
        dline = _read_report_line(self.report_read, time.monotonic() + WORKLOAD_TIMEOUT_SEC)
        self.control.close()
        assert self.proc is not None
        self.proc.wait(timeout=CGROUP_DRAIN_SEC)
        leftover = (self.leaf / "cgroup.procs").read_text().strip()
        tree_peak_text = (self.leaf / "memory.peak").read_text().strip()
        if self.proc.returncode != 0:
            raise GateFailure(f"{self.row['id']} {self.role} exited with status {self.proc.returncode}")
        if leftover:
            raise GateFailure(f"{self.row['id']} {self.role} left live descendant processes")
        try:
            fields = dline.decode("ascii").split()
            if len(fields) != 5 or fields[0] != "D":
                raise ValueError
            checksum = fields[1]
            reported_ops = int(fields[2])
            peak_committed = int(fields[3])
            fragmentation = float(fields[4])
            tree_peak = int(tree_peak_text)
        except (ValueError, UnicodeDecodeError) as exc:
            raise GateFailure(f"{self.row['id']} {self.role} returned malformed completion") from exc
        if reported_ops != self.expected_ops:
            raise GateFailure(f"{self.row['id']} {self.role} completion operation count diverged from the sealed budget")
        if checksum != self.row["expectedChecksum"]:
            raise GateFailure(f"{self.row['id']} {self.role} deterministic checksum gate failed")
        return {"peak_committed": peak_committed, "fragmentation": fragmentation, "tree_peak": tree_peak}

    def close(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
        try:
            os.close(self.report_read)
        except OSError:
            pass
        drain_measurement_leaf(self.leaf)


def run_benchmark(row: dict, candidate_so: Path, reference_so: Path) -> float:
    expected_ops = int(row["expectedOperations"])
    rounds = int(row["rounds"])
    if rounds <= 0 or expected_ops <= 0:
        raise GateFailure(f"{row['id']} workload has no sealed round budget")
    # Score = sealed operations * (min reference elapsed / min candidate
    # elapsed). Each sample times the pristine reference and the candidate
    # interleaved so both minima are drawn from the same host-load window: a
    # fully contended eval elevates both legs together and leaves the ratio
    # (hence the score) unchanged, while a genuinely faster allocator shortens
    # only the candidate leg. The reference is the sealed baseline built from
    # TRUSTED_DIR with no candidate overlay, so a baseline candidate scores
    # ~operations. Host or sibling contention can only lengthen a sample, so the
    # per-binary minimum rejects scheduler-noise outliers with no candidate-
    # controlled influence over the selection.
    harness = HARNESS_DIR / f"hone-{row['id']}"
    candidate = _Bench(harness, candidate_so, row, "cand", SANDBOX_UID)
    reference: _Bench | None = None
    try:
        reference = _Bench(harness, reference_so, row, "ref", REF_UID)
        ref_samples: list[int] = []
        cand_samples: list[int] = []
        for _ in range(HONE_SAMPLES):
            # One fresh unpredictable nonce per sample, delivered to BOTH legs at
            # clock-start and folded into every allocation's canary pattern. The
            # pristine reference is the trusted expectation for this nonce, so a
            # candidate can only match its checksum by running the timed
            # per-allocation write/read-back fold once the nonce arrives.
            nonce = str(int.from_bytes(os.urandom(8), "big")).encode("ascii")
            ref_ns, ref_checksum = reference.sample(nonce)
            cand_ns, cand_checksum = candidate.sample(nonce)
            if ref_ns <= 0 or cand_ns <= 0:
                raise GateFailure(f"{row['id']} workload produced an invalid elapsed time")
            if cand_checksum != ref_checksum:
                raise GateFailure(f"{row['id']} candidate sample checksum diverged from the pristine reference")
            # Paired per-sample plausibility floor: both legs of this pair ran
            # back-to-back under the same host load, so a candidate leg faster
            # than the sealed band allows is a measurement-integrity failure,
            # not an allocator improvement.
            if cand_ns * MAX_PLAUSIBLE_SPEEDUP < ref_ns:
                raise GateFailure(f"{row['id']} candidate sample beat the paired reference beyond the sealed plausibility band")
            ref_samples.append(ref_ns)
            cand_samples.append(cand_ns)
        candidate_fin = candidate.finalize()
        reference.finalize()
    finally:
        if reference is not None:
            reference.close()
        candidate.close()

    peak_committed = candidate_fin["peak_committed"]
    fragmentation = candidate_fin["fragmentation"]
    tree_peak = candidate_fin["tree_peak"]
    # The candidate writes the peak_committed field in its own D-line, so it is
    # not trusted on its own. The kernel cgroup memory.peak (tree_peak) is the
    # authoritative, candidate-unwritable memory signal: committed pages must be
    # backed by kernel-charged memory, so a reported committed figure grossly
    # exceeding the whole-tree kernel peak is fabricated (e.g. a stream that
    # committed almost nothing but claims a full baseline profile). The bound is
    # generous (1.5x) so it never false-fails a lean allocator whose committed
    # bytes legitimately approach its whole-tree peak, nor a run whose kernel
    # peak is depressed by host contention, while still catching a committed
    # figure that the kernel never charged.
    baseline_peak = row["baselinePeakPageCommittedBytes"]
    if peak_committed <= 0 or peak_committed > tree_peak * 1.5:
        raise GateFailure(f"{row['id']} reported committed memory is not backed by the kernel-charged whole-tree peak")
    # Precise memory-regression gate on the mi_stats page_committed.peak (from
    # trusted-only src/stats.c), now backstopped by the kernel cross-check above.
    if peak_committed * 100 > baseline_peak * 102:
        raise GateFailure(f"{row['id']} peak page-committed memory exceeds baseline by more than 2%")
    # Trusted whole-tree kernel gate: cgroup memory.peak over every process the
    # candidate ran. The ceiling stays loose (2x) because whole-process RSS peak
    # is noisy across a multi-sample run. The floor (see MIN_TREE_PEAK_FRACTION)
    # rejects a completion stream produced without running the allocation
    # workload, while staying below the leanest legitimate allocator's footprint.
    baseline_tree = row["baselineTreePeakBytes"]
    if tree_peak <= 0 or tree_peak * 100 > baseline_tree * 200:
        raise GateFailure(f"{row['id']} process-tree peak memory exceeds the sealed baseline allowance")
    if tree_peak < baseline_tree * MIN_TREE_PEAK_FRACTION:
        raise GateFailure(f"{row['id']} process-tree peak memory fell below the sealed workload floor")
    # Fragmentation is a small difference of large numbers (committed minus
    # live), so a fraction-of-a-percent committed jitter swings it by ~10-20%
    # relative on the low-fragmentation workloads. Gate with an absolute floor
    # plus a relative band so real regressions are caught without noise flaking.
    baseline_fragmentation = float(row["baselineFragmentationRatio"])
    if not math.isfinite(fragmentation) or fragmentation < 0 or fragmentation > baseline_fragmentation * 1.15 + 0.003:
        raise GateFailure(f"{row['id']} fragmentation exceeds baseline by more than the allowed band")

    # Min-of-N per binary: the least-contended reference over the least-
    # contended candidate, both drawn from the same interleaved window. The
    # final ratio must also stay inside the sealed plausibility band.
    ratio = min(ref_samples) / min(cand_samples)
    if ratio > MAX_PLAUSIBLE_SPEEDUP:
        raise GateFailure(f"{row['id']} workload throughput exceeded the sealed plausibility band")
    q = float(expected_ops) * ratio
    if not math.isfinite(q) or q <= 0:
        raise GateFailure(f"{row['id']} workload returned invalid throughput")
    return q


def geometric_mean(values: list[float]) -> float:
    if len(values) != 4 or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("cannot scalarize invalid workload throughput")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def main() -> None:
    mounted = False
    cgroup_mounted = False
    result_hash = ""
    started = time.monotonic()
    try:
        check_source_envelope()
        metadata = load_workloads()
        identity = {
            "driverVersion": metadata["driverVersion"],
            "workloads": [
                {"id": row["id"], "seed": row["seed"], "threads": row["threads"], "checksum": row["expectedChecksum"]}
                for row in metadata["workloads"]
            ],
        }
        result_hash = hashlib.sha256(canonical(identity).encode()).hexdigest()

        mount_build_tmpfs()
        mounted = True
        mount_measurement_cgroup()
        cgroup_mounted = True
        build_harness()
        copy_candidate()
        build_started = time.monotonic()
        run_worker("build")
        build_sec = time.monotonic() - build_started
        run_worker("test")
        copy_reference()
        run_worker("build", REF_SOURCE)
        candidate_so = resolve_shared_lib(BUILD_DIR)
        reference_so = resolve_shared_lib(REF_BUILD_DIR)
        assert_no_interposition(candidate_so)
        audit_initializers(candidate_so, reference_so)

        throughputs = [run_benchmark(row, candidate_so, reference_so) for row in metadata["workloads"]]
        score = geometric_mean(throughputs)
        elapsed_sec = time.monotonic() - started
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "checksums_pass": True,
                "peak_committed_pass": True,
                "tree_peak_pass": True,
                "fragmentation_pass": True,
                "thread_count_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": f"four deterministic allocator workloads passed correctness, stress, memory, fragmentation, and thread-count gates; q={score:.3f} ops/s",
                }
            },
            "diagnostics": {
                "summary": "upstream api/api-fill/stress tests passed; page-committed peaks, whole-tree peak memory, and live-page fragmentation stayed within the sealed baselines",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(build_sec, 6),
                "runtime_sec": round(elapsed_sec, 6),
                "workloads": 4,
                "threads_max": 4,
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except (GateFailure, OSError, subprocess.SubprocessError, ValueError) as exc:
        emit_failure(str(exc), result_hash)
    finally:
        if cgroup_mounted:
            unmount_measurement_cgroup()
        if mounted:
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
