#!/usr/bin/env python3
"""Trusted evaluator for microsoft/mimalloc allocator throughput."""
from __future__ import annotations

import hashlib
import json
import math
import os
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
BUILD_ROOT = Path("/tmp/hone-mimalloc-build")
SOURCE = BUILD_ROOT / "source"
BUILD_DIR = BUILD_ROOT / "build"
CGROUP_ROOT = Path("/tmp/hone-mimalloc-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 240
WORKLOAD_TIMEOUT_SEC = 30
TARGET_MS = 250
WORKLOAD_IDS = ("single", "multithread", "small", "fragmentation")
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
MAIN_THREAD_ALLOWANCE = 1
# Runtime symbols a candidate allocator translation unit must never define:
# they are linked into the same executable as the trusted harness, so a strong
# definition here would be resolved by the static linker in place of libc,
# letting candidate code fabricate elapsed time or the reported result line.
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


def assert_no_interposition() -> None:
    binaries = sorted(BUILD_DIR.glob("hone-*"))
    if len(binaries) != len(WORKLOAD_IDS):
        raise GateFailure("benchmark binaries missing after build")
    for binary in binaries:
        try:
            completed = subprocess.run(
                ["nm", "--defined-only", "--format=posix", str(binary)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise GateFailure(f"symbol audit failed: {exc}") from exc
        if completed.returncode != 0:
            raise GateFailure("symbol audit could not read benchmark binary")
        for line in completed.stdout.decode("ascii", "replace").splitlines():
            fields = line.split()
            if len(fields) < 2:
                continue
            name, symbol_type = fields[0], fields[1]
            if symbol_type in ("U", "v", "w"):
                continue
            if name in INTERPOSITION_SYMBOLS:
                raise GateFailure(
                    f"candidate defines interposable runtime symbol '{name}' in {binary.name}"
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
        "expectedChecksum", "id", "seed", "targetMs", "threads",
    }
    seeds: set[int] = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != expected_fields:
            raise GateFailure("sealed workload row has invalid fields")
        if not isinstance(row["seed"], int) or not 0 < row["seed"] < 2**64 or row["seed"] in seeds:
            raise GateFailure("sealed workload seed is invalid or duplicated")
        seeds.add(row["seed"])
        if row["targetMs"] != TARGET_MS:
            raise GateFailure("sealed benchmark duration mismatch")
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


def run_benchmark(row: dict) -> float:
    binary = BUILD_DIR / f"hone-{row['id']}"
    task_cap = int(row["threads"]) + MAIN_THREAD_ALLOWANCE
    leaf = CGROUP_ROOT / f"bench-{row['id']}"
    leaf.mkdir(mode=0o755, exist_ok=False)
    leaf_procs = leaf / "cgroup.procs"

    def capped_demote() -> None:
        # Trusted memory accounting: the workload joins its measurement leaf
        # while still root, so the WHOLE candidate process tree (exited
        # children included) is charged to a cgroup whose control files the
        # demoted uid-2000 code can never write. memory.peak is kernel-owned
        # and monotone for the leaf's lifetime — unlike VmHWM or any
        # /proc-self-reported value, candidate code cannot reset or
        # under-report it.
        with open(leaf_procs, "w") as handle:
            handle.write("0")
        # Kernel-enforced ceiling on the uid-2000 task count: an allowed
        # allocator translation unit cannot spawn more concurrent threads than
        # the sealed per-workload thread budget plus the coordinating main
        # thread. Applied before the privilege drop so the exec'd workload
        # inherits the limit; a candidate exceeding it fails clone() and the
        # workload aborts rather than silently passing the thread-count gate.
        resource.setrlimit(resource.RLIMIT_NPROC, (task_cap, task_cap))
        demote()

    try:
        try:
            completed = subprocess.run(
                [str(binary), str(row["seed"]), str(row["targetMs"])],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=WORKLOAD_TIMEOUT_SEC,
                check=False,
                preexec_fn=capped_demote,
                cwd=BUILD_DIR,
            )
            leftover = (leaf / "cgroup.procs").read_text().strip()
            tree_peak_text = (leaf / "memory.peak").read_text().strip()
        except (OSError, subprocess.SubprocessError) as exc:
            raise GateFailure(f"{row['id']} workload failed: {exc}") from exc
    finally:
        drain_measurement_leaf(leaf)
    if leftover:
        raise GateFailure(f"{row['id']} workload left live descendant processes")
    try:
        fields = completed.stdout.decode("ascii").strip().split()
        if completed.returncode != 0 or len(fields) != 8 or fields[0] != "ok" or fields[1] != row["id"]:
            raise ValueError
        ops_per_sec = float(fields[2])
        checksum = fields[3]
        peak_committed = int(fields[4])
        fragmentation = float(fields[5])
        rounds = int(fields[6])
        int(fields[7])
        tree_peak = int(tree_peak_text)
    except (ValueError, UnicodeDecodeError) as exc:
        raise GateFailure(f"{row['id']} workload returned malformed output") from exc
    if not math.isfinite(ops_per_sec) or ops_per_sec <= 0 or rounds <= 0:
        raise GateFailure(f"{row['id']} workload returned invalid throughput")
    if checksum != row["expectedChecksum"]:
        raise GateFailure(f"{row['id']} deterministic checksum gate failed")
    baseline_peak = row["baselinePeakPageCommittedBytes"]
    if peak_committed * 100 > baseline_peak * 101:
        raise GateFailure(f"{row['id']} peak page-committed memory exceeds baseline by more than 1%")
    # Trusted whole-tree memory gate: kernel cgroup accounting over every
    # process the workload ran, independent of allocator-reported statistics.
    baseline_tree = row["baselineTreePeakBytes"]
    if tree_peak <= 0 or tree_peak * 100 > baseline_tree * 120:
        raise GateFailure(f"{row['id']} process-tree peak memory exceeds the sealed baseline allowance")
    baseline_fragmentation = float(row["baselineFragmentationRatio"])
    if not math.isfinite(fragmentation) or fragmentation < 0 or fragmentation > baseline_fragmentation * 1.01:
        raise GateFailure(f"{row['id']} fragmentation exceeds baseline by more than 1%")
    return ops_per_sec


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
        copy_candidate()
        build_started = time.monotonic()
        run_worker("build")
        build_sec = time.monotonic() - build_started
        run_worker("test")
        assert_no_interposition()

        throughputs = [run_benchmark(row) for row in metadata["workloads"]]
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
