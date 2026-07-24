#!/usr/bin/env python3
"""Trusted evaluator for the terminal sqlite/sqlite speedtest1 capsule."""
from __future__ import annotations

import ctypes
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
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path("/tmp/hone-sqlite-build")
SOURCE = BUILD_ROOT / "source"
FROZEN_DIR = BUILD_ROOT / "frozen"
DATABASE_COPY = FROZEN_DIR / "speedtest.db"
SEALED_DIR = BUILD_ROOT / "sealed"
SEALED_BINARY = SEALED_DIR / "hone-sqlite-bench"
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
PR_SET_CHILD_SUBREAPER = 36
CLONE_NEWNS = 0x00020000
CLONE_NEWIPC = 0x08000000
CLONE_NEWNET = 0x40000000
MS_NOSUID = 0x2
MS_NODEV = 0x4
MS_NOEXEC = 0x8
MS_BIND = 0x1000
MS_REC = 0x4000
MS_PRIVATE = 0x40000
MS_MOVE = 0x2000
FRESH_SCRATCH_OPTIONS = b"size=192m,mode=1777"
SHM_SCRATCH_OPTIONS = b"size=16m,mode=1777"
REAP_TIMEOUT_SEC = 10.0
# Staging mount point on the always-writable /dev tmpfs (the container rootfs
# is read-only). Each timed repetition mounts a FRESH private tmpfs here,
# binds the sealed binary and frozen database into it, then MS_MOVEs the
# whole staged view over /tmp inside the repetition's private mount
# namespace: the shared /tmp (and the build tree under it) disappears from
# the candidate's view, and every scratch byte dies with the namespace.
REP_STAGE = Path("/dev/hone-sqlite-stage")
REP_BINARY = Path("/tmp/sealed/hone-sqlite-bench")
REP_DATABASE = Path("/tmp/frozen/speedtest.db")
REP_STATE = Path("/tmp/state")
# Trusted whole-tree memory accounting. Docker mounts the container cgroup2
# view read-only, but the evaluator holds mount authority: a fresh cgroup2
# instance is root-writable. Each timed repetition joins a fresh leaf while
# still root (in preexec, BEFORE unshare/setuid), so the ENTIRE candidate
# process tree — detached helpers in new sessions included — is charged to a
# leaf whose control files the demoted uid can never write. memory.peak is a
# kernel-owned monotone high-water mark for the leaf's lifetime; unlike
# RUSAGE_CHILDREN ru_maxrss (which only accounts a worker's direct, reaped
# children and so hides a double-forked sorter helper) it cannot be reset or
# under-reported by candidate-controlled code.
CGROUP_ROOT = Path("/tmp/hone-sqlite-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10.0
_LIBC = ctypes.CDLL(None, use_errno=True)
_LIBC.unshare.argtypes = [ctypes.c_int]
_LIBC.mount.argtypes = [
    ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p,
]
_LIBC.prctl.argtypes = [
    ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
]


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


def isolated_benchmark_preexec(leaf_procs: Path) -> None:
    """Give each timed repetition a private kernel view: fresh mount, IPC,
    and network namespaces whose /tmp is a brand-new tmpfs containing ONLY
    the sealed binary, the frozen database, and an empty scratch directory,
    plus a fresh /dev/shm. Nothing candidate-linked code writes during one
    repetition is visible to any other repetition, and no SysV/shm or
    abstract-socket channel survives between launches.

    The very first action joins this repetition's trusted measurement leaf,
    while still root and BEFORE the mount namespace is unshared: the leaf path
    lives under the shared /tmp that the MS_MOVE below hides, so the join must
    happen against the parent's still-visible mount view. cgroup membership is
    independent of the mount namespace and is inherited by every descendant
    (detached helpers included), so the whole tree is accounted regardless of
    what the candidate forks."""
    with open(leaf_procs, "w") as handle:
        handle.write("0")
    if _LIBC.unshare(CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWNET) != 0:
        raise OSError(ctypes.get_errno(), "benchmark namespace isolation failed")
    if _LIBC.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        raise OSError(ctypes.get_errno(), "private mount propagation failed")
    stage = os.fsencode(str(REP_STAGE))
    if _LIBC.mount(
        b"hone-fresh-scratch", stage, b"tmpfs",
        MS_NOSUID | MS_NODEV | MS_NOEXEC, FRESH_SCRATCH_OPTIONS,
    ) != 0:
        raise OSError(ctypes.get_errno(), "fresh scratch tmpfs mount failed")
    os.mkdir(REP_STAGE / "sealed", 0o555)
    os.mkdir(REP_STAGE / "frozen", 0o555)
    os.mkdir(REP_STAGE / "state", 0o777)
    os.chmod(REP_STAGE / "state", 0o777)
    binds = (
        (os.fsencode(str(SEALED_DIR)), os.fsencode(str(REP_STAGE / "sealed"))),
        (os.fsencode(str(FROZEN_DIR)), os.fsencode(str(REP_STAGE / "frozen"))),
    )
    for bind_source, bind_target in binds:
        if _LIBC.mount(bind_source, bind_target, None, MS_BIND, None) != 0:
            raise OSError(ctypes.get_errno(), "benchmark input bind failed")
    if _LIBC.mount(stage, b"/tmp", None, MS_MOVE, None) != 0:
        raise OSError(ctypes.get_errno(), "staged benchmark view move failed")
    if _LIBC.mount(
        b"hone-fresh-shm", b"/dev/shm", b"tmpfs",
        MS_NOSUID | MS_NODEV | MS_NOEXEC, SHM_SCRATCH_OPTIONS,
    ) != 0:
        raise OSError(ctypes.get_errno(), "fresh shm tmpfs mount failed")
    demote()


def candidate_pids() -> list[int]:
    pids: list[int] = []
    for entry in os.listdir("/proc"):
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


def reap_candidate_tree() -> None:
    """As subreaper, kill and reap EVERY candidate-uid process until none
    remain: killpg alone misses descendants that detached into new sessions,
    and any survivor could carry state between timed repetitions."""
    deadline = time.monotonic() + REAP_TIMEOUT_SEC
    while True:
        pids = candidate_pids()
        while True:
            try:
                waited, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if waited == 0:
                break
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        if time.monotonic() > deadline:
            raise GateFailure("candidate process tree could not be reaped")
        time.sleep(0.02)


def run_worker(action: str, *items: object, preexec=demote) -> dict:
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
            preexec_fn=preexec,
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


def mount_measurement_cgroup() -> None:
    # A fresh cgroup2 instance over the (namespaced) hierarchy, root-writable
    # even though Docker mounts the container's own cgroup view read-only.
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "cgroup2", "-o", "nosuid,nodev,noexec", "hone-sqlite-cg", str(CGROUP_ROOT)],
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
        # worker it forks for build/test) in a trusted leaf so the memory
        # controller can be delegated to the per-repetition measurement leaves.
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
    # Kill every task still charged to the leaf (detached descendants in new
    # sessions included), wait for the kernel to release them, then retire the
    # leaf. Exit disassociates tasks from the cgroup before they are reaped, so
    # an empty cgroup.procs means the leaf can be removed.
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
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    trusted_paths = {
        path.relative_to(TRUSTED_DIR).as_posix()
        for path in TRUSTED_DIR.rglob("*")
        if path.is_file()
    }
    seen_mutable: set[str] = set()
    for path in WORKSPACE.rglob("*"):
        if path.is_symlink():
            raise GateFailure("candidate workspace contains a symbolic link")
        if not path.is_file():
            continue
        relative = path.relative_to(WORKSPACE).as_posix()
        if relative == ".git" or relative.startswith((".git/", ".gitdir/")):
            raise GateFailure("candidate workspace contains repository history")
        if relative in trusted_paths:
            if relative in ALLOWED_MUTABLE_FILES:
                seen_mutable.add(relative)
            elif relative.startswith("src/"):
                if sha256_file(path) != sha256_file(TRUSTED_DIR / relative):
                    raise GateFailure(f"protected SQLite source changed: {relative}")
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")
    # The sanitized terminal artifact legitimately omits protected files (the
    # trusted seed reconstructs them during prepare), but the full mutable
    # inventory must always be present.
    missing = sorted(set(ALLOWED_MUTABLE_FILES) - seen_mutable)
    if missing:
        raise GateFailure(f"mutable source file missing from workspace: {missing[0]}")


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
    cgroup_mounted = False
    result_hash = ""
    started = time.monotonic()
    try:
        if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            raise GateFailure("trusted subreaper setup failed")
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
        mount_measurement_cgroup()
        cgroup_mounted = True
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

        # Let build/test load drain before the timed repetitions begin, and
        # make sure no candidate-uid process from build/test survives into
        # the timed window.
        reap_candidate_tree()
        time.sleep(1.0)
        REP_STAGE.mkdir(mode=0o755, exist_ok=True)
        times_ns: list[int] = []
        observed_results: dict[str, str] = {}
        result_bytes: dict[str, int] = {}
        peak_rss_kib = 0
        for rep in range(SAMPLE_REPS):
            leaf = CGROUP_ROOT / f"bench-{rep}"
            leaf.mkdir(mode=0o755, exist_ok=False)
            leaf_procs = leaf / "cgroup.procs"

            def rep_preexec(_procs: Path = leaf_procs) -> None:
                isolated_benchmark_preexec(_procs)

            try:
                workload_started = time.monotonic_ns()
                benchmark_payload = run_worker(
                    "benchmark", REP_BINARY, REP_DATABASE, REP_STATE,
                    preexec=rep_preexec,
                )
                elapsed_ns = time.monotonic_ns() - workload_started
                if elapsed_ns <= 0 or elapsed_ns > 120_000_000_000:
                    raise GateFailure("trusted external timer returned an invalid duration")
                observed_result, observed_bytes = parse_benchmark(
                    benchmark_payload.get("output"), "sort"
                )
                # Validate EVERY repetition against the frozen expectation so
                # no fast-but-wrong repetition can enter the scored set.
                if (
                    {"sort": observed_result} != expected["resultHashes"]
                    or {"sort": observed_bytes} != expected["resultBytes"]
                ):
                    raise GateFailure("exact benchmark result hash gate failed")
                times_ns.append(elapsed_ns)
                observed_results["sort"] = observed_result
                result_bytes["sort"] = observed_bytes
                # Reap the whole candidate-uid tree, THEN read the leaf's
                # kernel-owned peak: memory.peak is the monotone high-water
                # mark charged to every process the repetition ran — a
                # double-forked detached sorter helper cannot escape it, and
                # the demoted uid can never write the root-owned control file.
                reap_candidate_tree()
                try:
                    leftover = leaf_procs.read_text().strip()
                    tree_peak_bytes = int((leaf / "memory.peak").read_text().strip())
                except (OSError, ValueError) as exc:
                    raise GateFailure("benchmark cgroup peak receipt is malformed") from exc
                if leftover:
                    raise GateFailure("benchmark left live candidate processes in the accounting cgroup")
                if tree_peak_bytes <= 0:
                    raise GateFailure("benchmark cgroup peak receipt is malformed")
                peak_rss_kib = max(peak_rss_kib, (tree_peak_bytes + 1023) // 1024)
            finally:
                reap_candidate_tree()
                drain_measurement_leaf(leaf)
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
        if cgroup_mounted:
            unmount_measurement_cgroup()
        if mounted:
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
