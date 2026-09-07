#!/usr/bin/env python3
"""Trusted evaluator for frozen offline uv dependency resolution."""
from __future__ import annotations

import ctypes
import hashlib
import itertools
import json
import math
import os
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKSPACE = Path("/workspace")
ASSETS = Path("/capsule/assets")
WORKER = TRUSTED_DIR / "worker.py"
BUILD_ROOT = Path("/tmp/hone-uv-build")
TARGET_BASE = Path("/opt/uv-target-base")
REFERENCE_BINARY_SOURCE = TARGET_BASE / "profiling" / "uv"
TARGET = BUILD_ROOT / "target"
SOURCE_BASE = Path("/opt/uv-resolver-src-base")
SOURCE = BUILD_ROOT / "resolver-src"
UPSTREAM_ROOT = Path("/opt/uv-root")
SEALED_ROOT = Path("/mnt")
BENCH_ROOT = Path("/srv")
CGROUP_ROOT = Path("/tmp/hone-uv-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10
SEALED_TMPFS_DATA = b"size=512m,mode=0755,nr_inodes=40000"
BENCH_TMPFS_DATA = b"size=512m,mode=0755,uid=2000,gid=2000,nr_inodes=120000"
BUILD_TMPFS_DATA = b"size=1600m,mode=0755,uid=2000,gid=2000,nr_inodes=300000"
SANDBOX_UID = 2000
BUILD_TIMEOUT_SEC = 555
PROCESS_TIMEOUT_SEC = 30
COLD_REPETITIONS = 41
WARM_REPETITIONS = 41
# Symmetric trim on the per-pair reference/candidate ratios: the 8 most extreme
# ratios at each end of the 41 interleaved pairs are dropped, keeping the middle
# 25 and rejecting single-repetition glitches in either binary.
PAIR_TRIM = 8
Q_FAIL = 0.0
# Frozen yardstick anchor. Each eval interleaves the pristine trusted-baseline
# reference binary with the candidate and divides out their shared per-eval
# ambient CPU speed, so a candidate identical to the baseline scores this value
# by construction, independent of host frequency/contention drift. Provisional
# local anchor; final GCE recalibration re-freezes it.
REFERENCE_NORMALIZATION = 25.0
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
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.unshare.argtypes = [ctypes.c_int]
LIBC.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p]
LIBC.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
CLONE_NEWNS = 0x00020000
CLONE_NEWIPC = 0x08000000
MS_RDONLY = 0x0001
MS_NOSUID = 0x0002
MS_NODEV = 0x0004
MS_NOEXEC = 0x0008
MS_REMOUNT = 0x0020
MS_REC = 0x4000
MS_PRIVATE = 0x40000
MNT_DETACH = 0x0002
FRESH_SCRATCH_OPTIONS = b"size=16m,mode=1777"
HIDDEN_OPT_OPTIONS = b"size=1m,mode=0555,nr_inodes=64"
# Set once measurement begins: True when the trusted evaluator holds an owned
# cgroup2 hierarchy (root on Linux) and each measured launch is charged in its
# own kernel-owned leaf; False on non-root dev, where fork_exec falls back to
# wait4 ru_maxrss.
CGROUP_ACTIVE = False
_LEAF_COUNTER = itertools.count()


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


def mount_tmpfs(point: Path, flags: int, data: bytes) -> None:
    # Direct mount(2) rather than a mount(8) fork: no per-repetition child
    # process churn to perturb the very timings being measured.
    if LIBC.mount(b"hone-uv-eval", str(point).encode(), b"tmpfs", flags, data) != 0:
        raise GateFailure(f"trusted tmpfs mount failed: {point} (errno {ctypes.get_errno()})")


def unmount_tmpfs(point: Path) -> bool:
    # umount2(2) directly; fall back to a lazy detach so a stray descendant
    # holding the mount can never strand candidate-writable state.
    target = str(point).encode()
    if LIBC.umount2(target, 0) == 0:
        return True
    return LIBC.umount2(target, MNT_DETACH) == 0


def mount_build_tmpfs() -> None:
    BUILD_ROOT.mkdir(mode=0o755, exist_ok=False)
    try:
        mount_tmpfs(BUILD_ROOT, 0, BUILD_TMPFS_DATA)
    except GateFailure:
        BUILD_ROOT.rmdir()
        raise


def reap_candidate_processes() -> None:
    """Kill and collect every sandbox-uid process before writable state is torn down."""
    deadline = time.monotonic() + 5.0
    while True:
        while True:
            try:
                waited, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if waited == 0:
                break
        alive: list[int] = []
        for entry in os.scandir("/proc"):
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid == SANDBOX_UID:
                    alive.append(int(entry.name))
            except OSError:
                continue
        if not alive:
            return
        for candidate_pid in alive:
            try:
                os.kill(candidate_pid, signal.SIGKILL)
            except OSError:
                pass
        if time.monotonic() > deadline:
            raise GateFailure("candidate process tree could not be reaped")
        time.sleep(0.005)


def mount_measurement_cgroup() -> bool:
    """Mount a fresh writable cgroup2 hierarchy the trusted evaluator owns and
    delegate the memory controller, so every measured launch can be charged in
    its own kernel-owned leaf. The container's own /sys/fs/cgroup view is
    read-only, but the trusted evaluator holds mount authority (CAP_SYS_ADMIN):
    a fresh cgroup2 instance over the same namespaced hierarchy is writable by
    root only. Returns False on non-root dev, where fork_exec falls back to
    wait4 ru_maxrss."""
    if os.geteuid() != 0 or not sys.platform.startswith("linux"):
        return False
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=False)
    if LIBC.mount(b"hone-uv-cg", str(CGROUP_ROOT).encode(), b"cgroup2",
                  MS_NOSUID | MS_NODEV | MS_NOEXEC, None) != 0:
        CGROUP_ROOT.rmdir()
        raise GateFailure("trusted measurement cgroup mount failed")
    try:
        # cgroup v2 no-internal-process rule: park the evaluator (and every
        # process it forks) in a trusted leaf so the memory controller can be
        # delegated to the per-launch measurement leaves.
        CGROUP_TRUSTED.mkdir(mode=0o755)
        (CGROUP_TRUSTED / "cgroup.procs").write_text(str(os.getpid()))
        (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")
    except OSError as exc:
        raise GateFailure("trusted measurement cgroup setup failed") from exc
    return True


def unmount_measurement_cgroup() -> None:
    if unmount_tmpfs(CGROUP_ROOT):
        try:
            CGROUP_ROOT.rmdir()
        except OSError:
            pass


def new_measurement_leaf() -> Path:
    leaf = CGROUP_ROOT / f"m{os.getpid()}-{next(_LEAF_COUNTER)}"
    leaf.mkdir(mode=0o755, exist_ok=False)
    return leaf


def read_leaf_peak_kb(leaf: Path) -> int:
    # memory.peak is the kernel-owned, monotone whole-tree high-water mark for
    # the leaf's lifetime (every process the launch ran, exited children and
    # detached descendants included). Unlike wait4 ru_maxrss — which reports
    # only the directly-waited pid and misses memory a candidate offloads to a
    # detached helper — this cannot be reset or under-reported by uid-2000 code.
    try:
        peak_bytes = int((leaf / "memory.peak").read_text().strip())
    except (OSError, ValueError) as exc:
        raise GateFailure("measurement cgroup peak unreadable") from exc
    return (peak_bytes + 1023) // 1024


def drain_measurement_leaf(leaf: Path) -> None:
    # Kill every process still charged to the leaf, wait for the kernel to
    # release them, then retire the leaf.
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
        time.sleep(0.01)
    try:
        leaf.rmdir()
    except OSError as exc:
        raise GateFailure("measurement cgroup could not be retired") from exc


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


def isolate_measurement_namespace() -> None:
    """Give the measured process a private mount + System V IPC view: brand-new
    /tmp, /dev/shm, and /var/tmp tmpfs mounts (no scratch state written by any
    earlier repetition is visible and nothing written here outlives this
    process), the persistent candidate-owned build trees under /opt hidden
    behind an empty read-only tmpfs, and a fresh SysV IPC namespace so no
    shared-memory segment, semaphore, or message queue can carry a saved
    lock/counter from one repetition into the next."""
    if LIBC.unshare(CLONE_NEWNS | CLONE_NEWIPC) != 0:
        raise OSError(ctypes.get_errno(), "mount/ipc namespace unshare failed")
    if LIBC.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        raise OSError(ctypes.get_errno(), "private mount propagation failed")
    scratch_flags = MS_NOSUID | MS_NODEV | MS_NOEXEC
    for target in (b"/tmp", b"/dev/shm", b"/var/tmp"):
        if LIBC.mount(b"hone-fresh-scratch", target, b"tmpfs", scratch_flags, FRESH_SCRATCH_OPTIONS) != 0:
            raise OSError(ctypes.get_errno(), "fresh scratch tmpfs mount failed")
    # Hide every persistent candidate-writable tree under /opt (/opt/uv-root,
    # /opt/uv-target-base, /opt/uv-resolver-src-base) behind an empty read-only
    # tmpfs. The measured binary runs entirely from the sealed read-only /mnt
    # inputs and its fresh per-repetition /srv cache, so no state a candidate
    # stashed under /opt during the build or an earlier repetition can be
    # replayed by a later one.
    hide_flags = MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC
    if LIBC.mount(b"hone-hidden-opt", b"/opt", b"tmpfs", hide_flags, HIDDEN_OPT_OPTIONS) != 0:
        raise OSError(ctypes.get_errno(), "persistent candidate tree hide mount failed")


def fork_exec(argv: list[str], environment: dict[str, str], timeout: int) -> tuple[int, float, int]:
    # A readiness pipe lets the parent start the clock only AFTER the child has
    # finished its (variable-latency) cgroup join, namespace unshare, fresh
    # /tmp+/dev/shm+/var/tmp mounts, /opt hide, and privilege drop — so the
    # measured interval is the resolver's own execution, not setup jitter that
    # would swamp a short run.
    leaf = new_measurement_leaf() if CGROUP_ACTIVE else None
    try:
        ready_r, ready_w = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                os.close(ready_r)
                os.setsid()
                if leaf is not None:
                    # Join the per-launch measurement cgroup leaf while still
                    # root and BEFORE the fresh /tmp shadows the cgroup mount:
                    # the whole candidate process tree is then charged to a
                    # kernel-owned leaf the demoted uid can never write.
                    with open(leaf / "cgroup.procs", "w") as handle:
                        handle.write("0")
                isolate_measurement_namespace()
                devnull = os.open(os.devnull, os.O_RDWR)
                os.dup2(devnull, 0)
                os.dup2(devnull, 1)
                os.dup2(devnull, 2)
                if devnull > 2:
                    os.close(devnull)
                demote()
                os.write(ready_w, b"\x01")
                os.close(ready_w)
                os.execve(argv[0], argv, environment)
            except BaseException:
                os._exit(127)
        os.close(ready_w)
        try:
            os.read(ready_r, 1)
        finally:
            os.close(ready_r)
        started = time.monotonic_ns()
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
            os.wait4(pid, 0)
            raise GateFailure("resolver process timed out")
        elapsed_ms = (time.monotonic_ns() - started) / 1_000_000
        exit_code = os.waitstatus_to_exitcode(status)
        if leaf is not None:
            peak_rss_kb = read_leaf_peak_kb(leaf)
        else:
            peak_rss_kb = int(usage.ru_maxrss) if usage is not None else 0
        return exit_code, elapsed_ms, peak_rss_kb
    finally:
        if leaf is not None:
            drain_measurement_leaf(leaf)


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


def paired_ratio(reference_ms: list[float], candidate_ms: list[float]) -> float:
    """Drift-cancelling per-pair speed ratio (reference_ms / candidate_ms).

    Reference and candidate are interleaved rep-by-rep, so each pair shares the
    same instant of the host's permanent repo-watcher load; the per-pair ratio
    therefore cancels that shared ambient contention (which the candidate cannot
    control), and the geometric mean over many trimmed pairs drives the residual
    per-repetition jitter down as 1/sqrt(pairs). For these sub-100ms resolutions
    this paired cancellation is far tighter than a min-of-N-per-binary estimator,
    whose two independent minima are sampled at different (differently-loaded)
    instants and so do not cancel. The PAIR_TRIM most extreme ratios at each end
    are dropped to reject single-repetition glitches. A ratio > 1 means the
    candidate resolved faster than the trusted baseline; because every timed
    repetition does full resolution from fresh per-repetition state (no earlier
    repetition's cache/scratch survives), the candidate can only add work."""
    if len(reference_ms) != len(candidate_ms) or not reference_ms:
        raise GateFailure("reference/candidate repetitions are unpaired")
    ratios = sorted(r / c for r, c in zip(reference_ms, candidate_ms))
    kept = ratios[PAIR_TRIM: len(ratios) - PAIR_TRIM]
    if not kept:
        raise GateFailure("insufficient paired repetitions for ratio")
    return geometric_mean(kept)


def seal_measurement_inputs(binary: Path, metadata: dict, split_root: Path, index_root: Path) -> None:
    """Copy the built binary, package index, and requirement inputs into a
    dedicated root-owned tmpfs and remount it read-only: measured processes
    can read but never modify or replace any measurement input."""
    mount_tmpfs(SEALED_ROOT, MS_NOSUID | MS_NODEV, SEALED_TMPFS_DATA)
    sealed_binary = SEALED_ROOT / "uv"
    shutil.copyfile(binary, sealed_binary)
    os.chmod(sealed_binary, 0o755)
    # The pristine prebuilt trusted-baseline binary is sealed alongside the
    # candidate to serve as the interleaved per-eval reference yardstick.
    reference_binary = SEALED_ROOT / "uv-ref"
    shutil.copyfile(REFERENCE_BINARY_SOURCE, reference_binary)
    os.chmod(reference_binary, 0o755)
    local_index = SEALED_ROOT / "index"
    shutil.copytree(index_root, local_index)
    for directory, _, files in os.walk(local_index):
        base = Path(directory)
        os.chmod(base, 0o755)
        for filename in files:
            os.chmod(base / filename, 0o644)
    requirements = SEALED_ROOT / "requirements"
    requirements.mkdir(mode=0o755)
    for row in metadata["workloads"]:
        # The requirement path deliberately keeps the "<id>/requirements.in"
        # tail: split-boundary integrity diagnostics identify the workload by
        # this path, so the sealed layout must preserve it byte-for-byte.
        workload_dir = requirements / row["id"]
        workload_dir.mkdir(mode=0o755)
        destination = workload_dir / "requirements.in"
        shutil.copyfile(split_root / row["requirements"], destination)
        os.chmod(destination, 0o644)
    if LIBC.mount(None, str(SEALED_ROOT).encode(), None,
                  MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, None) != 0:
        raise GateFailure("sealed measurement tmpfs could not be made read-only")


def fresh_bench() -> None:
    """Mount a brand-new candidate-writable tmpfs for one measurement phase."""
    mount_tmpfs(BENCH_ROOT, MS_NOSUID | MS_NODEV | MS_NOEXEC, BENCH_TMPFS_DATA)
    for name in ("home", "cache"):
        directory = BENCH_ROOT / name
        directory.mkdir(mode=0o777)
        os.chmod(directory, 0o777)


def teardown_bench() -> None:
    reap_candidate_processes()
    if not unmount_tmpfs(BENCH_ROOT):
        raise GateFailure("bench tmpfs teardown failed")


def seed_warm_cache(template: Path, destination: Path) -> None:
    """Materialize one timed repetition's private copy of a primed cache onto
    the freshly mounted bench tmpfs. The template lives in a root-owned 0700
    directory outside every sandbox-visible mount, so its bytes are exactly
    the post-prime snapshot; the copy is opened up with chmod (the eval
    container deliberately has no chown capability) so the sandbox uid can
    read and write it like a cache it primed itself."""
    shutil.copytree(template, destination, symlinks=True)
    os.chmod(destination, 0o777)
    for directory, dirnames, filenames in os.walk(destination):
        base = Path(directory)
        for name in dirnames:
            os.chmod(base / name, 0o777)
        for name in filenames:
            path = base / name
            if not path.is_symlink():
                os.chmod(path, 0o666)


def run_workloads(metadata: dict, split_root: Path) -> tuple[dict, dict, int, float, float]:
    candidate = SEALED_ROOT / "uv"
    reference = SEALED_ROOT / "uv-ref"
    local_index = SEALED_ROOT / "index"
    environment = {
        "HOME": str(BENCH_ROOT / "home"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "UV_NO_PROGRESS": "1",
        "UV_PYTHON_DOWNLOADS": "never",
    }
    # The reference is the pristine trusted baseline and is never gated on
    # memory: only the candidate's peak RSS is held to the baseline+2% ceiling.
    NO_RSS_GATE = 1 << 30
    scores: dict[str, float] = {}
    measurements: dict[str, dict] = {}
    maximum_rss = 0

    def timed(binary: Path, requirement: Path, output: Path, expected: bytes,
              mode: str, wid: str, rss_limit: int, cache_dir: Path) -> tuple[float, int]:
        if output.exists():
            output.unlink()
        command = resolution_command(binary, requirement, output, cache_dir, local_index)
        code, elapsed_ms, peak_rss = fork_exec(command, environment, PROCESS_TIMEOUT_SEC)
        if code != 0 or not output.is_file() or output.read_bytes() != expected:
            raise GateFailure(f"exact lockfile gate failed: {wid}:{mode}")
        if peak_rss <= 0 or peak_rss > rss_limit:
            raise GateFailure(f"peak RSS gate failed: {wid}:{mode} {peak_rss}KiB > {rss_limit}KiB")
        return elapsed_ms, peak_rss

    for row in metadata["workloads"]:
        wid = str(row["id"])
        requirement = SEALED_ROOT / "requirements" / wid / "requirements.in"
        expected = (split_root / row["expectedLock"]).read_bytes()
        rss_limit = math.floor(row["baselinePeakRssKb"] * 1.02)
        cand_out = BENCH_ROOT / "candidate.lock"
        ref_out = BENCH_ROOT / "reference.lock"
        for mode, repetitions in (
            ("cold", COLD_REPETITIONS),
            ("warm", WARM_REPETITIONS),
        ):
            cand_ms: list[float] = []
            ref_ms: list[float] = []
            peaks: list[int] = []
            if mode == "cold":
                # Reference and candidate cold repetitions are interleaved and
                # each starts from a freshly mounted writable tree torn down
                # immediately after: no cache/lock/scratch byte survives to the
                # next repetition, and the two binaries share the same per-pair
                # ambient CPU speed so cross-eval drift divides out.
                def cold_reference() -> float:
                    fresh_bench()
                    try:
                        return timed(reference, requirement, ref_out, expected, mode, wid, NO_RSS_GATE, BENCH_ROOT / "cache")[0]
                    finally:
                        teardown_bench()

                def cold_candidate() -> tuple[float, int]:
                    fresh_bench()
                    try:
                        return timed(candidate, requirement, cand_out, expected, mode, wid, rss_limit, BENCH_ROOT / "cache")
                    finally:
                        teardown_bench()

                for rep in range(repetitions):
                    # Alternate which binary runs first in each pair so any
                    # systematic first-vs-second-slot bias cancels across pairs.
                    if rep % 2 == 0:
                        r_ms = cold_reference()
                        c_ms, c_rss = cold_candidate()
                    else:
                        c_ms, c_rss = cold_candidate()
                        r_ms = cold_reference()
                    ref_ms.append(r_ms)
                    cand_ms.append(c_ms)
                    peaks.append(c_rss)
            else:
                # Warm phase with per-repetition fresh writable state: each
                # binary primes its OWN cache once on a throwaway mount, both
                # primed caches are snapshotted into a root-held 0700 template
                # directory no sandbox-uid process can see (measured children
                # get a private /tmp) or touch, and every timed repetition then
                # runs on a brand-new bench mount seeded from that immutable
                # template. Shared state flows prime -> repetition only: no
                # byte written by one timed repetition survives into the next,
                # so later repetitions cannot replay state cached by earlier
                # ones, while every repetition still resolves against a fully
                # primed cache (workload magnitude and metric semantics are
                # unchanged). Timed reference and candidate repetitions stay
                # interleaved rep-by-rep so the two binaries share the same
                # ambient CPU speed within each pair and cross-eval drift
                # divides out exactly as for cold.
                template = Path(tempfile.mkdtemp(prefix="hone-uv-warm-", dir="/tmp"))
                try:
                    fresh_bench()
                    try:
                        for binary, out, name, who in (
                            (reference, ref_out, "ref", "reference"),
                            (candidate, cand_out, "cand", wid),
                        ):
                            cache_dir = BENCH_ROOT / f"cache-{name}"
                            cache_dir.mkdir(mode=0o777)
                            os.chmod(cache_dir, 0o777)
                            prime = resolution_command(binary, requirement, out, cache_dir, local_index)
                            code, _, _ = fork_exec(prime, environment, PROCESS_TIMEOUT_SEC)
                            if code != 0 or not out.is_file() or out.read_bytes() != expected:
                                raise GateFailure(f"warm-prime lockfile gate failed: {wid}:{who}")
                        # Reap stragglers BEFORE snapshotting so no sandbox-uid
                        # process can keep mutating a cache while it is copied.
                        reap_candidate_processes()
                        shutil.copytree(BENCH_ROOT / "cache-ref", template / "ref", symlinks=True)
                        shutil.copytree(BENCH_ROOT / "cache-cand", template / "cand", symlinks=True)
                    finally:
                        teardown_bench()
                    for rep in range(repetitions):
                        fresh_bench()
                        try:
                            ref_cache = BENCH_ROOT / "cache-ref"
                            cand_cache = BENCH_ROOT / "cache-cand"
                            # Each binary's cache copy is materialized only
                            # immediately before its own timed run, with all
                            # sandbox-uid processes reaped between the two runs
                            # of a pair, so the pair's earlier run can never
                            # touch the later run's freshly seeded cache.
                            if rep % 2 == 0:
                                seed_warm_cache(template / "ref", ref_cache)
                                r_ms, _ = timed(reference, requirement, ref_out, expected, mode, wid, NO_RSS_GATE, ref_cache)
                                reap_candidate_processes()
                                seed_warm_cache(template / "cand", cand_cache)
                                c_ms, c_rss = timed(candidate, requirement, cand_out, expected, mode, wid, rss_limit, cand_cache)
                            else:
                                seed_warm_cache(template / "cand", cand_cache)
                                c_ms, c_rss = timed(candidate, requirement, cand_out, expected, mode, wid, rss_limit, cand_cache)
                                reap_candidate_processes()
                                seed_warm_cache(template / "ref", ref_cache)
                                r_ms, _ = timed(reference, requirement, ref_out, expected, mode, wid, NO_RSS_GATE, ref_cache)
                            ref_ms.append(r_ms)
                            cand_ms.append(c_ms)
                            peaks.append(c_rss)
                        finally:
                            teardown_bench()
                finally:
                    shutil.rmtree(template, ignore_errors=True)
            cell_ratio = paired_ratio(ref_ms, cand_ms)
            score = REFERENCE_NORMALIZATION * cell_ratio
            candidate_q = 1000.0 / geometric_mean(cand_ms)
            reference_q = 1000.0 / geometric_mean(ref_ms)
            if not math.isfinite(score) or score <= 0:
                raise GateFailure("resolver scalar is non-finite")
            key = f"{wid}:{mode}"
            scores[key] = score
            measurements[key] = {
                "allMilliseconds": cand_ms,
                "allReferenceMilliseconds": ref_ms,
                "peakRssKb": peaks,
                "candidateQ": candidate_q,
                "referenceQ": reference_q,
                "pairRatio": cell_ratio,
                "score": score,
            }
            maximum_rss = max(maximum_rss, *peaks)
    raw_q = geometric_mean([m["candidateQ"] for m in measurements.values()])
    reference_q = geometric_mean([m["referenceQ"] for m in measurements.values()])
    return scores, measurements, maximum_rss, raw_q, reference_q


def main() -> None:
    global CGROUP_ACTIVE
    build_mounted = False
    cgroup_mounted = False
    sealed = False
    result_hash = ""
    try:
        metadata, split_root, index, index_root = load_assets()
        verify_index(index, index_root)
        result_hash = verify_workloads(metadata, split_root, index)
        mount_build_tmpfs()
        build_mounted = True
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
        reap_candidate_processes()
        seal_measurement_inputs(binary, metadata, split_root, index_root)
        sealed = True
        # The candidate-writable build tmpfs is destroyed before the first
        # measured repetition: no build-time state survives into measurement.
        if not unmount_tmpfs(BUILD_ROOT):
            raise GateFailure("build tmpfs teardown failed")
        BUILD_ROOT.rmdir()
        build_mounted = False
        # Own a fresh cgroup2 hierarchy for whole-tree memory.peak accounting
        # of every measured launch; on non-root dev this is skipped and
        # fork_exec falls back to wait4 ru_maxrss.
        CGROUP_ACTIVE = mount_measurement_cgroup()
        cgroup_mounted = CGROUP_ACTIVE
        scores, measurements, peak_rss, raw_q, reference_q = run_workloads(metadata, split_root)
        # The reported per-cell scores are already reference-normalized; the
        # scalar objective is their geometric mean.
        scalar = geometric_mean(list(scores.values()))
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
                key: {"score": value, "feedback": f"offline {key} resolution passed exact gates (reference-normalized)"}
                for key, value in scores.items()
            },
            "diagnostics": {
                "quality": 1.0,
                "result_hash": result_hash,
                "summary": "offline locks, selected wheel hashes, resolver tests, and RSS gate passed",
                "build_sec": build_sec,
                "peak_rss_kb": peak_rss,
                "raw_q": raw_q,
                "reference_q": reference_q,
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
        if build_mounted and unmount_tmpfs(BUILD_ROOT):
            BUILD_ROOT.rmdir()
        if sealed:
            unmount_tmpfs(SEALED_ROOT)
        if cgroup_mounted:
            unmount_measurement_cgroup()


if __name__ == "__main__":
    main()
