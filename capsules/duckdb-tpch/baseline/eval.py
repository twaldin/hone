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
REFERENCE_SOURCE = WORK / "reference"
FIXTURE = BUILD_ROOT / "fixture"
OUTPUT = BUILD_ROOT / "output"
SEALED = BUILD_ROOT / "sealed"
SEALED_REFERENCE = BUILD_ROOT / "sealed-reference"
CGROUP_ROOT = Path("/tmp/hone-duckdb-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10
# One CPU-second of runtime per 100 ms scheduling period. A single-task runner
# never reaches this ceiling (it cannot use more than one core), but any
# candidate attempt to spawn worker threads in physical_filter.cpp and
# parallelize the always-true filter across cores is throttled back to one
# core-equivalent, so wall time cannot beat the threads:1 fairness contract.
CPU_MAX = "100000 100000"
# Hard kernel task ceiling for the whole measured tree. The runner is
# single-task by construction (maximum_threads == external_threads == 1,
# async_threads == 0, allocator background thread off), so exactly one task is
# legitimate; any spawned thread or fork is refused by clone().
PIDS_MAX = "1"
UNSHARE_NEWIPC_NEWNET = 0x08000000 | 0x40000000
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 2700
SAMPLE_TIMEOUT_SEC = 45
WARMUP_RUNS = 2
TIMED_RUNS = 7
# Whole-tree cgroup memory.peak allowance over the sealed baseline. Cgroup
# accounting adds page-table and per-task kernel memory to the anon working set
# that the old wait4 ru_maxrss missed, so the ceiling is wider than the former
# 2% while still catching a candidate that trades memory for filter speed.
PEAK_RSS_TOLERANCE = 0.10
QFAIL = 0.0
# Reference-yardstick normalization. The reference query has no WHERE clause, so
# it never invokes the mutable PhysicalFilter operator, and it is run by a
# SEPARATE pristine runner built from the trusted baseline with no candidate
# overlay (see build_reference in worker.py). Because the reference binary
# shares zero candidate code, a candidate construction in physical_filter.cpp
# cannot detect the reference leg from argv/cmdline and inflate only that leg.
# Its wall time therefore tracks only host speed; timed alongside each target
# rep, the per-binary minimum ratio reference/target cancels cross-eval host
# drift while preserving the candidate's real filter-path speedup. It reads and
# case-folds the same columns the target does. NORM_CONST is a fixed scale.

# Source reference only; the original executable terminal bundle stays private.
def _withheld_terminal_input(name):
    raise RuntimeError(f"Private terminal input withheld: {name}; use the original capsule bundle")

REFERENCE_QUERY = _withheld_terminal_input('REFERENCE_QUERY')
REFERENCE_ORACLE = _withheld_terminal_input('REFERENCE_ORACLE')
NORM_CONST = 1.0
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


def mount_measurement_cgroup() -> None:
    # Docker mounts the container's cgroup2 view read-only, but the trusted
    # evaluator holds mount authority (CAP_SYS_ADMIN): a fresh cgroup2 instance
    # over the same namespaced hierarchy is writable by root only. memory.peak,
    # cpu.max, and pids.max on the per-sample leaves are then root-owned control
    # files the demoted uid-2000 runner can never write.
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "cgroup2", "-o", "nosuid,nodev,noexec", "hone-duckdb-cg", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    if completed.returncode != 0:
        CGROUP_ROOT.rmdir()
        raise GateFailure("trusted measurement cgroup mount failed")
    try:
        # cgroup v2 no-internal-process rule: park the evaluator (and every
        # worker/build it forks) in a trusted leaf so memory/cpu/pids can be
        # delegated to the per-sample measurement leaves.
        CGROUP_TRUSTED.mkdir(mode=0o755)
        (CGROUP_TRUSTED / "cgroup.procs").write_text(str(os.getpid()))
        (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory +pids +cpu")
    except OSError as exc:
        raise GateFailure("trusted measurement cgroup setup failed") from exc


def unmount_measurement_cgroup() -> None:
    completed = subprocess.run(
        ["umount", "-l", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )
    if completed.returncode == 0:
        try:
            CGROUP_ROOT.rmdir()
        except OSError:
            pass


def drain_measurement_leaf(leaf: Path) -> None:
    # Kill every process still charged to the leaf (detached descendants in new
    # sessions included), wait for the kernel to release them, then retire the
    # leaf. An empty cgroup.procs means every task has exited and been
    # disassociated, so the leaf can be removed.
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


def check_source_envelope() -> None:
    """Protected files may legitimately be ABSENT (the sanitized terminal
    artifact strips them; prepare() reconstructs the tree from the trusted
    seed), but the full mutable-file inventory MUST be present, every present
    file must be inside the envelope, and symlinks are rejected outright."""
    trusted_paths = {
        path.relative_to(TRUSTED_DIR).as_posix()
        for path in TRUSTED_DIR.rglob("*")
        if path.is_file()
    }
    present_mutable: set[str] = set()
    for path in WORKSPACE.rglob("*"):
        if path.is_symlink():
            raise GateFailure("candidate source contains a symbolic link")
        if not path.is_file():
            continue
        relative = path.relative_to(WORKSPACE).as_posix()
        if relative in ALLOWED_MUTABLE_FILES:
            present_mutable.add(relative)
            continue
        if relative in trusted_paths:
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")
    missing = sorted(ALLOWED_MUTABLE_FILES - present_mutable)
    if missing:
        raise GateFailure(f"candidate source is missing mutable files: {', '.join(missing)}")


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
    reference = FIXTURE / "reference.sql"
    shutil.copyfile(database_files[0], database)
    query.write_bytes(query_bytes)
    reference.write_text(REFERENCE_QUERY)
    os.chmod(database, 0o444)
    os.chmod(query, 0o444)
    os.chmod(reference, 0o444)
    if not unmount(ASSETS):
        raise GateFailure("sealed assets could not be hidden before candidate build")
    return metadata, oracle


def copy_sealed_file(source_path: Path, target: Path) -> None:
    if source_path.is_symlink() or not source_path.is_file():
        raise GateFailure("sealed runner input is not a regular file")
    shutil.copyfile(source_path, target)
    os.chmod(target, 0o555)


def seal_binary(build_dir: Path, sealed_dir: Path) -> Path:
    """Root-owned copies of a runner and its libraries into a sealed directory:
    the build ran under the sandbox uid and owns everything under WORK and could
    re-chmod its own files, so nothing build-owned is ever executed during
    timing. Used for both the candidate runner and the pristine reference
    runner; each build tree is deleted by the caller after sealing."""
    sealed_dir.mkdir(mode=0o755)
    sealed_lib = sealed_dir / "src"
    sealed_lib.mkdir(mode=0o755)
    copy_sealed_file(build_dir / "hone-query-runner", sealed_dir / "hone-query-runner")
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
        raise GateFailure("build produced no duckdb shared library")
    for link_path, target_name in symlinks:
        if "/" in target_name or target_name in {".", ".."}:
            raise GateFailure("shared-library symlink escapes the sealed directory")
        os.symlink(target_name, link_path)
    return sealed_dir / "hone-query-runner"


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


def run_one_sample(binary: Path, query_name: str, expected_hash: str, index: int,
                   tag: str) -> tuple[float, int, str]:
    sweep_candidate_state()
    rep = OUTPUT / f"rep-{tag}-{index}"
    rep.mkdir(mode=0o777)
    os.chmod(rep, 0o777)
    leaf = CGROUP_ROOT / f"sample-{tag}-{index}"
    leaf.mkdir(mode=0o755, exist_ok=False)
    try:
        (leaf / "cpu.max").write_text(CPU_MAX)
        (leaf / "pids.max").write_text(PIDS_MAX)
    except OSError as exc:
        drain_measurement_leaf(leaf)
        raise GateFailure("measurement cgroup limits could not be applied") from exc
    leaf_procs = leaf / "cgroup.procs"

    def capped_demote() -> None:
        # Join the root-owned measurement leaf while still privileged so the
        # WHOLE runner tree is charged to a cgroup whose cpu.max, pids.max, and
        # memory.peak the demoted uid-2000 code can never write, THEN drop
        # privilege. cpu.max caps the tree to one core-equivalent (no
        # cross-core filter parallelism), pids.max forbids any extra task, and
        # memory.peak is kernel-owned and monotone over the leaf lifetime —
        # candidate code cannot reset or under-report it, and it accounts every
        # task in the tree, not just the direct child (unlike wait4 rusage).
        with open(leaf_procs, "w") as handle:
            handle.write("0")
        demote()

    argv = [str(binary), str(FIXTURE / "input.duckdb"), str(FIXTURE / query_name)]
    started_ns = time.monotonic_ns()
    tree_peak_bytes = 0
    leftover = ""
    try:
        process = subprocess.Popen(
            argv,
            cwd=rep,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            preexec_fn=capped_demote,
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
            os.wait4(process.pid, 0)
            stream.close()
            raise GateFailure("microbenchmark sample exceeded its trusted parent timeout")
        _pid, status, _usage = reaped
        # Popen must never waitpid a pid the trusted parent already reaped.
        process.returncode = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
        stream.close()
        # Read the whole-tree peak and any surviving tasks from the root-owned
        # cgroup BEFORE the leaf is drained and retired.
        leftover = leaf_procs.read_text().strip()
        tree_peak_bytes = int((leaf / "memory.peak").read_text().strip())
    finally:
        drain_measurement_leaf(leaf)
    if leftover:
        raise GateFailure("microbenchmark left live descendant processes")
    if status != 0:
        raise GateFailure("microbenchmark process failed")
    stdout = b"".join(chunks)
    actual_hash = hashlib.sha256(stdout).hexdigest()
    if actual_hash != expected_hash:
        raise GateFailure("independent exact-result validation failed")
    peak_rss_kb = tree_peak_bytes // 1024
    if peak_rss_kb <= 0:
        raise GateFailure("trusted cgroup memory accounting was malformed")
    shutil.rmtree(rep)
    return elapsed, peak_rss_kb, actual_hash


def main() -> None:
    mounted = False
    cgroup_mounted = False
    result_hash = ""
    started = time.monotonic()
    try:
        check_source_envelope()
        mount_build_tmpfs()
        mounted = True
        mount_measurement_cgroup()
        cgroup_mounted = True
        metadata, oracle = load_and_seal_assets()
        identity = {
            "databaseSha256": metadata["databaseSha256"],
            "querySha256": metadata["querySha256"],
            "variant": metadata["variant"],
        }
        result_hash = hashlib.sha256(canonical(identity).encode()).hexdigest()
        # Build and seal the PRISTINE reference runner FIRST, from a trusted
        # seed with no candidate overlay, then delete its build tree — the
        # reference binary is root-owned and read-only before any candidate code
        # is ever prepared, built, or run, so no candidate process can influence
        # or observe it.
        run_worker("prepare_reference", REFERENCE_SOURCE)
        run_worker("build_reference", REFERENCE_SOURCE)
        reference_binary = seal_binary(REFERENCE_SOURCE / "build" / "hone-release", SEALED_REFERENCE)
        shutil.rmtree(REFERENCE_SOURCE)
        run_worker("prepare", WORKSPACE, SOURCE)
        build_started = time.monotonic()
        run_worker("build")
        build_sec = time.monotonic() - build_started
        run_worker("test")
        binary = seal_binary(SOURCE / "build" / "hone-release", SEALED)
        shutil.rmtree(WORK)
        target_samples: list[float] = []
        reference_samples: list[float] = []
        rss_samples: list[int] = []
        actual_result_hash = ""
        for index in range(WARMUP_RUNS + TIMED_RUNS):
            # Interleave candidate target and pristine reference so both see the
            # same instantaneous host load; the per-binary minimum ratio cancels
            # drift. The reference leg runs the sealed pristine binary, never the
            # candidate one.
            target_elapsed, peak_rss_kb, actual_result_hash = run_one_sample(
                binary, "query.sql", oracle, index, "target")
            reference_elapsed, _reference_rss, _reference_hash = run_one_sample(
                reference_binary, "reference.sql", REFERENCE_ORACLE, index, "reference")
            if index >= WARMUP_RUNS:
                target_samples.append(target_elapsed)
                reference_samples.append(reference_elapsed)
                rss_samples.append(peak_rss_kb)
        if (
            len(target_samples) != TIMED_RUNS
            or len(reference_samples) != TIMED_RUNS
            or any(not math.isfinite(value) or value <= 0 for value in target_samples)
            or any(not math.isfinite(value) or value <= 0 for value in reference_samples)
        ):
            raise GateFailure("trusted parent produced invalid latency samples")
        peak_rss_kb = max(rss_samples)
        baseline_rss_kb = metadata["baselinePeakRssKb"]
        if not isinstance(baseline_rss_kb, int) or baseline_rss_kb <= 0:
            raise GateFailure("invalid baseline RSS limit")
        rss_ceiling_kb = baseline_rss_kb * (1.0 + PEAK_RSS_TOLERANCE)
        if peak_rss_kb > rss_ceiling_kb:
            raise GateFailure(
                f"whole-tree peak memory gate failed: {peak_rss_kb} KiB exceeds baseline+"
                f"{int(PEAK_RSS_TOLERANCE * 100)}%")
        # Contention-robust MIN-of-N estimator (converged lesson from the
        # thin-margin fixers on this shared loaded host): the per-binary minimum
        # wall is the least-contended, most reproducible realization. Both minima
        # inflate together under load, so their ratio cancels host drift while
        # rewarding a genuinely faster candidate filter path. Median/mean or
        # per-pair-difference estimators amplify contention and blow the A-A band.
        min_target = min(target_samples)
        min_reference = min(reference_samples)
        score = NORM_CONST * (min_reference / min_target)
        if not math.isfinite(score) or score <= 0:
            raise GateFailure("trusted parent produced an invalid normalized score")
        deterministic = {
            "databaseSha256": metadata["databaseSha256"],
            "queryResultSha256": actual_result_hash,
            "querySha256": metadata["querySha256"],
            "tests": "physical-filter-v2",
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
                    "feedback": f"physical-filter exact output and upstream tests passed; host-normalized min-of-{TIMED_RUNS} reference/target score={score:.6f}",
                }
            },
            "diagnostics": {
                "summary": "sealed input/query hashes, independent exact output (candidate target and pristine reference), upstream physical-filter tests, trusted parent interleaved reference-yardstick timing under a one-core cgroup cap, and whole-tree cgroup memory.peak gate passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "query_result_hash": actual_result_hash,
                "normalized_score": score,
                "min_target_seconds": min_target,
                "min_reference_seconds": min_reference,
                "target_samples_seconds": target_samples,
                "reference_samples_seconds": reference_samples,
                "peak_rss_kb": peak_rss_kb,
                "peak_rss_baseline_kb": baseline_rss_kb,
                "peak_rss_ceiling_kb": int(rss_ceiling_kb),
                "build_sec": round(build_sec, 6),
                "runtime_sec": round(time.monotonic() - started, 6),
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except (GateFailure, OSError, ValueError, subprocess.SubprocessError) as exc:
        emit_failure(str(exc), result_hash)
    finally:
        if cgroup_mounted:
            unmount_measurement_cgroup()
        if mounted:
            cleanup()


if __name__ == "__main__":
    main()
