#!/usr/bin/env python3
"""Trusted evaluator for the frozen Bun module-loader capsule.

Only src/resolver is candidate-mutable, so the evaluator aligns its timed
metric with that surface. It seals the pristine image baseline binary as an
interleaved reference yardstick, builds the candidate source with image-baked
native objects and offline dependency caches, copies the freshly built binary
to a root-owned sealed path before any execution of it, and runs the focused
upstream resolver tests. Each frozen graph then runs two phases as fresh Bun
processes: an untimed CORRECTNESS phase that loads the full module graph and
gates exact export/side-effect hashes and peak RSS against the frozen oracle,
and a timed RESOLUTION phase where a driver script resolves every import edge
of the graph through Bun.resolveSync for the spec'd repetition count (the
resolver dominates this phase, so genuine resolver improvements move the
score). Timed runs interleave candidate/reference pairs under the same host
state and are scored as the median of per-pair time ratios, so host frequency
drift, contention spikes, and scheduler mode luck divide out. Every loader
launch runs against completely fresh candidate-writable state — a per-launch
transpiler cache and TMPDIR under a root-owned measurement root, a fresh IPC
namespace — and is followed by a candidate-uid process sweep plus a purge of
the shared tmp roots, so no launch can persist resolution state for a later
repetition to replay.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import resource
import shutil
import signal
import statistics
import subprocess
import stat as stat_module
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from workload import load_spec, materialize

WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
SOURCE_ROOT = Path("/opt/bun")
BUILD_ROOT = SOURCE_ROOT / "build" / "release"
WORK_ROOT = BUILD_ROOT / "hone-eval"
BUN = BUILD_ROOT / "bun-profile"
SEALED_ROOT = BUILD_ROOT / "hone-sealed"
SEALED_BUN = SEALED_ROOT / "bun-profile"
REF_ROOT = BUILD_ROOT / "hone-ref"
REF_BUN = REF_ROOT / "bun-profile"
MEASURE_ROOT = BUILD_ROOT / "hone-measure"
# Whole-tree memory accounting authority (mimalloc-allocator exemplar): a
# fresh root-only cgroup2 hierarchy the trusted evaluator mounts (CAP_SYS_ADMIN
# is granted for exactly this). Each loader launch joins a per-launch leaf
# BEFORE the setpriv privilege drop, so the WHOLE candidate process tree
# (exited children included) is charged to a cgroup whose control files the
# demoted uid can never write; memory.peak is kernel-owned and monotone, so
# candidate code cannot reset or under-report it the way /proc-self VmHWM or a
# GNU-time %M ru_maxrss reading of a single pid can be dodged.
CGROUP_ROOT = Path("/tmp/hone-bun-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10
# Set by _prepare_measurement once the accounting cgroup is mounted. When
# false (non-root / non-linux developer runs), the launch falls back to a
# GNU-time wait4 ru_maxrss reading in a separate trusted process.
_CGROUP_ACTIVE = False
PR_SET_CHILD_SUBREAPER = 36
CLONE_NEWIPC = 0x08000000
CANDIDATE_WRITABLE_ROOTS = (Path("/tmp"), Path("/var/tmp"), Path("/dev/shm"))
# Frozen provisional yardstick scale: a candidate identical to the trusted
# baseline resolver scores this value by construction (raw_q == reference_q),
# independent of host frequency/contention drift. Final GCE recalibration
# re-freezes it. Equal to the provisional local qBase.
REFERENCE_NORMALIZATION = 14.034003452816037
# Sub-200ms driver runs under a 2-cpu container are multi-modal (a stable
# plateau, a rare shallow fast mode of varying depth, and occasional
# contention spikes), so fastest-of-N estimates the rare mode's own variance
# and leaves noise that swamps genuine candidate margins. Instead the timed
# phase runs WARM_SAMPLE_ROUNDS x warmRepetitions interleaved
# candidate/reference pairs scored by the median per-pair ratio; adjacent
# pair members share host state, so spike tails and mode-occupancy luck
# cancel. The yardstick construction keeps the frozen calibration valid under
# any ratio estimator because baseline == reference scores
# REFERENCE_NORMALIZATION by construction.
WARM_SAMPLE_ROUNDS = 6
CANDIDATE_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
CANDIDATE_GID = int(os.environ.get("CAPSULE_WORKER_GID", "2000"))
BUILD_TIMEOUT_SEC = 390
TEST_TIMEOUT_SEC = 150
RUN_TIMEOUT_SEC = 45
MAX_CAPTURE_BYTES = 8_000_000
Q_FAIL = 0.0
# Peak-memory hard gate tolerance over the frozen baseline. The metric is the
# whole-tree cgroup memory.peak (page cache included), which is inherently
# noisier than a single-pid ru_maxrss reading, so the multiplier is looser
# than the historical +2% while still bounding a memory-for-speed trade well
# below any candidate that would double the resident tree.
RSS_TOLERANCE = 1.10
TEST_FILES = (
    "./js/bun/resolve/resolve.test.ts",
    "./js/bun/resolve/resolve-ts.test.ts",
    "./js/bun/resolve/import-meta-resolve.test.mjs",
)
PROTECTED_TOP_LEVEL = {"eval.py", "workload.py", "LICENSE.md", "revision.txt"}


class EvaluationFailure(RuntimeError):
    pass


def _sha256_json(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _candidate_preexec() -> None:
    os.setgroups([])
    os.setgid(CANDIDATE_GID)
    os.setuid(CANDIDATE_UID)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))


def _become_subreaper() -> None:
    """Adopt orphaned candidate descendants so they can be reaped.

    Detached/new-session children reparent to the nearest subreaper instead
    of pid 1, which lets _reap_candidate_processes wait() on them.
    """
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass


def _ipc_isolated_preexec() -> None:
    """Give the launch a fresh IPC namespace so SysV segments cannot carry
    resolution state between repetitions (runs before the setpriv exec that
    drops the whole subtree to the candidate uid inside it)."""
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(CLONE_NEWIPC) != 0:
        os._exit(126)


def _cgroup_available() -> bool:
    """Whole-tree cgroup accounting is only reachable as root on Linux."""
    return sys.platform == "linux" and os.geteuid() == 0


def _mount_measurement_cgroup() -> None:
    """Mount a fresh root-only cgroup2 hierarchy and park the evaluator in a
    trusted leaf so the memory controller can be delegated to per-launch
    measurement leaves (mimalloc-allocator exemplar). Docker mounts the
    container cgroup2 view read-only, but the trusted evaluator holds mount
    authority via CAP_SYS_ADMIN. Fail-closed under root+linux; a no-op for
    developer runs where the wait4 ru_maxrss fallback applies."""
    global _CGROUP_ACTIVE
    _CGROUP_ACTIVE = False
    if not _cgroup_available():
        return
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "cgroup2", "-o", "nosuid,nodev,noexec", "hone-bun-cg", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        CGROUP_ROOT.rmdir()
        raise EvaluationFailure("trusted measurement cgroup mount failed")
    try:
        # cgroup v2 no-internal-process rule: park the evaluator (and every
        # process it forks) in a trusted leaf so the memory controller can be
        # delegated to the per-launch measurement leaves.
        CGROUP_TRUSTED.mkdir(mode=0o755)
        (CGROUP_TRUSTED / "cgroup.procs").write_text(str(os.getpid()))
        (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")
    except OSError as exc:
        raise EvaluationFailure("trusted measurement cgroup setup failed") from exc
    _CGROUP_ACTIVE = True


def _unmount_measurement_cgroup() -> None:
    if not _CGROUP_ACTIVE:
        return
    subprocess.run(
        ["umount", "-l", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    try:
        CGROUP_ROOT.rmdir()
    except OSError:
        pass


def _drain_measurement_leaf(leaf: Path) -> None:
    """Kill anything still charged to the leaf, wait for the kernel to release
    it, then retire the leaf (mimalloc-allocator exemplar). memory.peak has
    already been read by the caller; this only reclaims the leaf."""
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
            raise EvaluationFailure("measurement cgroup could not be drained")
        time.sleep(0.05)
    try:
        leaf.rmdir()
    except OSError as exc:
        raise EvaluationFailure("measurement cgroup could not be retired") from exc


def _make_loader_preexec(cgroup_leaf: "Path | None", fresh_ipc: bool):
    """Build the child-side setup for a loader launch: join the per-launch
    measurement leaf while still root (so the whole setpriv-demoted subtree is
    charged to it), then optionally enter a fresh IPC namespace. Both run
    before the setpriv exec drops privilege."""
    leaf_procs = None if cgroup_leaf is None else str(cgroup_leaf / "cgroup.procs")

    def _preexec() -> None:
        if leaf_procs is not None:
            fd = os.open(leaf_procs, os.O_WRONLY)
            try:
                os.write(fd, b"0")
            finally:
                os.close(fd)
        if fresh_ipc:
            _ipc_isolated_preexec()

    return _preexec


def _candidate_pids() -> dict[int, bool]:
    """Map of candidate-uid pid -> is_zombie from a full /proc scan."""
    pids: dict[int, bool] = {}
    proc = Path("/proc")
    if not proc.exists():
        return pids
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
        except OSError:
            continue
        uid: int | None = None
        zombie = False
        for line in status.splitlines():
            if line.startswith("Uid:"):
                try:
                    uid = int(line.split()[1])
                except (IndexError, ValueError):
                    uid = None
            elif line.startswith("State:"):
                zombie = line.split()[1:2] == ["Z"]
        if uid == CANDIDATE_UID:
            pids[int(entry.name)] = zombie
    return pids


def _reap_candidate_processes() -> None:
    """Kill and reap every candidate-uid process until none remain.

    killpg alone misses detached/new-session descendants, and a plain SIGKILL
    sweep leaves zombies pinned by dead parents.  As subreaper this process
    inherits those orphans, so we loop: SIGKILL every live candidate pid,
    drain waitpid(-1, WNOHANG), and stop only when a full /proc scan finds no
    candidate-uid process at all (bounded by a hard deadline).
    """
    if os.geteuid() != 0:
        return
    deadline = time.monotonic() + 5.0
    while True:
        pids = _candidate_pids()
        if not any(not zombie for zombie in pids.values()):
            return
        for pid, zombie in pids.items():
            if zombie:
                continue
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        while True:
            try:
                reaped, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if reaped == 0:
                break
        if time.monotonic() >= deadline:
            return
        time.sleep(0.01)


def _clear_candidate_writable() -> None:
    """Purge candidate-owned residue from the shared tmp roots so nothing a
    launch stashed under /tmp, /var/tmp, or /dev/shm survives into the next
    repetition (TMPDIR points at per-launch scratch, but hardcoded paths and
    POSIX shm land here)."""
    for root in CANDIDATE_WRITABLE_ROOTS:
        try:
            entries = list(root.iterdir())
        except OSError:
            continue
        for path in entries:
            try:
                if path.lstat().st_uid != CANDIDATE_UID:
                    continue
            except OSError:
                continue
            try:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
            except OSError:
                pass


def _candidate_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {
        **os.environ,
        "HOME": "/root",
        "CARGO_HOME": "/root/.cargo",
        "RUSTUP_HOME": "/opt/rust",
        "RUSTUP_TOOLCHAIN": "nightly-2026-05-06-aarch64-unknown-linux-gnu",
        "RUSTC": "/root/.cargo/bin/rustc",
        "PATH": (
            "/root/.cargo/bin:/opt/rust/bin:"
            "/usr/local/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        ),
        "CARGO_NET_OFFLINE": "true",
        "CARGO_BUILD_JOBS": "1",
        "CARGO_PROFILE_RELEASE_LTO": "off",
        "CARGO_PROFILE_RELEASE_CODEGEN_UNITS": "16",
        "BUN_INSTALL_CACHE_DIR": "/root/.bun/install/cache",
        "TMPDIR": str(WORK_ROOT),
        "BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD": "1",
        "NO_COLOR": "1",
    }
    if extra:
        env.update(extra)
    return env


def _run(
    argv: list[str],
    *,
    cwd: Path,
    timeout: int,
    candidate: bool = False,
    fresh_ipc: bool = False,
    cgroup_leaf: "Path | None" = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    if candidate:
        preexec_fn = _candidate_preexec
    elif fresh_ipc or cgroup_leaf is not None:
        preexec_fn = _make_loader_preexec(cgroup_leaf, fresh_ipc)
    else:
        preexec_fn = None
    try:
        process = subprocess.Popen(
            argv,
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=preexec_fn,
            env=env or _candidate_env(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise EvaluationFailure(f"cannot start command: {argv[0]}: {exc}") from exc
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise EvaluationFailure(f"command timed out: {argv[0]}") from exc
    if len(stdout) > MAX_CAPTURE_BYTES or len(stderr) > MAX_CAPTURE_BYTES:
        raise EvaluationFailure(f"command output exceeded cap: {argv[0]}")
    completed = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    if completed.returncode != 0:
        output = (stdout + b"\n" + stderr).decode("utf-8", "replace")
        signal_lines = [
            line
            for line in output.splitlines()
            if any(marker in line.lower() for marker in ("error", "failed", "denied", "killed", "offline", "no space", "signal", "caused by", "didn't exit"))
        ]
        detail = "\n".join(line[-1200:] for line in signal_lines[-20:]) + "\n" + output[-1000:]
        raise EvaluationFailure(f"command failed ({completed.returncode}): {argv[0]}: {detail}")
    return completed


def _validate_candidate_tree() -> None:
    resolver = WORKSPACE / "src" / "resolver"
    if not resolver.is_dir() or resolver.is_symlink():
        raise EvaluationFailure("candidate src/resolver must be a real directory")
    for path in WORKSPACE.rglob("*"):
        relative = path.relative_to(WORKSPACE)
        if path.is_symlink():
            raise EvaluationFailure(f"candidate symlink is forbidden: {relative}")
        if relative.parts[0] == "src":
            if relative == Path("src") or relative.parts[:2] == ("src", "resolver"):
                continue
            raise EvaluationFailure(f"path is outside mutable envelope: {relative}")
        if len(relative.parts) == 1 and relative.name in PROTECTED_TOP_LEVEL:
            continue
        raise EvaluationFailure(f"path is outside mutable envelope: {relative}")
    files = [path for path in resolver.rglob("*") if path.is_file()]
    if not files or len(files) > 128:
        raise EvaluationFailure("candidate resolver file count is invalid")
    total = sum(path.stat().st_size for path in files)
    if total > 4_000_000:
        raise EvaluationFailure("candidate resolver source exceeds size cap")
    if not (resolver / "Cargo.toml").is_file() or not (resolver / "resolver.rs").is_file():
        raise EvaluationFailure("candidate resolver omits required sources")


def _make_volume_dirs_writable(root: Path) -> None:
    for directory, names, _files in os.walk(root):
        os.chmod(directory, 0o777)
        for name in names:
            path = Path(directory) / name
            if not path.is_symlink():
                os.chmod(path, 0o777)


def _prepare_candidate() -> None:
    _validate_candidate_tree()
    image_resolver = SOURCE_ROOT / "src" / "resolver"
    for child in image_resolver.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    for child in (WORKSPACE / "src" / "resolver").iterdir():
        destination = image_resolver / child.name
        if child.is_dir():
            shutil.copytree(child, destination)
        else:
            shutil.copy2(child, destination)
    for source in image_resolver.rglob("*"):
        if source.is_file():
            os.utime(source, None)
    _make_volume_dirs_writable(image_resolver)
    _make_volume_dirs_writable(BUILD_ROOT)
    rustup = Path("/root/.cargo/bin/rustup")
    rustup.unlink(missing_ok=True)
    rustup.write_text(
        '#!/bin/sh\ncase "$1 $2" in "toolchain install"|"component add"|"target add") exit 0;; esac\n'
        'exec /opt/rust/bin/rustup "$@"\n',
        encoding="utf-8",
    )
    rustup.chmod(0o755)
    direct_bin = Path("/opt/rust/toolchains/nightly-2026-05-06-aarch64-unknown-linux-gnu/bin")
    for name in ("cargo", "rustdoc"):
        proxy = Path("/root/.cargo/bin") / name
        proxy.unlink(missing_ok=True)
        os.symlink(direct_bin / name, proxy)
    rustc = Path("/root/.cargo/bin/rustc")
    rustc.unlink(missing_ok=True)
    rustc.write_text(
        "#!/usr/bin/python3\n"
        "import os,sys\n"
        "args=['-Zthreads=1' if arg == '-Zthreads=8' else arg for arg in sys.argv[1:]]\n"
        "os.execv('/opt/rust/toolchains/nightly-2026-05-06-aarch64-unknown-linux-gnu/bin/rustc',['rustc',*args])\n",
        encoding="utf-8",
    )
    rustc.chmod(0o755)
    for name in ("hone-home", "hone-bun-cache"):
        path = BUILD_ROOT / name
        path.mkdir(mode=0o777, exist_ok=True)
        os.chmod(path, 0o777)
    shutil.rmtree(WORK_ROOT, ignore_errors=True)
    WORK_ROOT.mkdir(mode=0o777)
    os.chmod(WORK_ROOT, 0o777)


def _build_candidate() -> float:
    _seal_reference_binary()
    started = time.perf_counter()
    _run(
        ["/usr/local/bun/bin/bun", "scripts/build.ts", "--profile=release", "-j1"],
        cwd=SOURCE_ROOT,
        timeout=BUILD_TIMEOUT_SEC,
        candidate=True,
    )
    elapsed = time.perf_counter() - started
    if not BUN.is_file() or not os.access(BUN, os.X_OK):
        raise EvaluationFailure("incremental build did not produce bun-profile")
    _seal_binary(BUN, SEALED_ROOT, SEALED_BUN)
    os.chmod(BUILD_ROOT, 0o755)
    revision = _run([str(SEALED_BUN), "--revision"], cwd=SOURCE_ROOT, timeout=20, candidate=True).stdout.decode().strip()
    if not revision.endswith("1.4.0-canary.1+5187e2766"):
        raise EvaluationFailure(f"built binary revision mismatch: {revision[-80:]}")
    return elapsed


def _seal_binary(src: Path, root: Path, dest: Path) -> None:
    """Copy a binary to a root-owned, candidate-immutable sealed path so the
    measured bytes cannot be swapped (for example via a /proc/self/exe copy)
    between repetitions. The 0o755 sealed directory is un-renameable by the
    demoted worker while the 0o777 work subdirectories stay writable."""
    if root.is_symlink() or root.is_file():
        root.unlink()
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(mode=0o755)
    os.chmod(root, 0o755)
    with open(src, "rb") as source, open(dest, "wb") as sealed:
        shutil.copyfileobj(source, sealed, 1024 * 1024)
    os.chmod(dest, 0o755)


def _seal_reference_binary() -> None:
    """Seal the PRISTINE image baseline binary before the candidate rebuild
    overwrites build/release/bun-profile. This binary is benchmarked alongside
    the candidate in every eval as an interleaved yardstick, so cross-eval host
    frequency and contention drift (which only ever adds time and is never
    candidate-controlled) divides out of the reported drift-normalized score."""
    if not BUN.is_file() or not os.access(BUN, os.X_OK):
        raise EvaluationFailure("image did not ship a pristine bun-profile reference")
    _seal_binary(BUN, REF_ROOT, REF_BUN)


def _run_upstream_tests() -> None:
    image_tests = SOURCE_ROOT / "test"
    test_root = WORK_ROOT / "source-tests"
    test_root.mkdir()
    for relative in ("harness.ts", "tsconfig.json", "package.json", "bun.lock"):
        shutil.copy2(image_tests / relative, test_root / relative)
    for relative in (
        "_util",
        "js/bun/resolve",
        "node_modules/reflect-metadata",
        "node_modules/tsyringe",
        "node_modules/tslib",
    ):
        shutil.copytree(
            image_tests / relative,
            test_root / relative,
            symlinks=True,
            ignore_dangling_symlinks=True,
        )
    for path in test_root.rglob("*"):
        if path.is_symlink():
            continue
        if path.is_dir():
            path.chmod(0o777)
        elif path.is_file():
            path.chmod(path.stat().st_mode | 0o666)
    completed = _run(
        [
            str(SEALED_BUN),
            "test",
            "--test-name-pattern",
            "^(?!auto-install init failure from an unreadable cwd is a catchable error$).*",
            *TEST_FILES,
        ],
        cwd=test_root,
        timeout=TEST_TIMEOUT_SEC,
        candidate=True,
    )
    output = completed.stdout.decode("utf-8", "replace") + completed.stderr.decode("utf-8", "replace")
    if "fail" in output.lower() and "0 fail" not in output.lower():
        raise EvaluationFailure("focused resolver suite reported failures")


def _load_assets() -> tuple[dict, dict]:
    specs = sorted(ASSETS.rglob("spec.json"))
    oracles = sorted(ASSETS.rglob("oracle.json"))
    if len(specs) != 1 or len(oracles) != 1:
        raise EvaluationFailure("selected asset group must contain exactly one spec and oracle")
    spec = load_spec(specs[0])
    oracle = json.loads(oracles[0].read_text(encoding="utf-8"))
    if not isinstance(oracle, dict) or oracle.get("version") != 1 or not isinstance(oracle.get("jobs"), dict):
        raise EvaluationFailure("malformed frozen oracle")
    return spec, oracle


def _parse_observation(stdout: bytes, expected_tag: str) -> dict:
    lines = [line for line in stdout.decode("utf-8", "strict").splitlines() if line]
    if len(lines) != 1:
        raise EvaluationFailure("loader emitted unexpected stdout")
    value = json.loads(lines[0])
    if not isinstance(value, dict) or set(value) != {"exports", "sideEffects"}:
        raise EvaluationFailure("loader observation has invalid shape")
    exports = value["exports"]
    side_effects = value["sideEffects"]
    if not isinstance(exports, dict) or set(exports) != {"tag", "value"}:
        raise EvaluationFailure("export observation has invalid shape")
    if not isinstance(side_effects, dict) or set(side_effects) != {"checksum", "count"}:
        raise EvaluationFailure("side-effect observation has invalid shape")
    for field in (exports["value"], side_effects["checksum"], side_effects["count"]):
        if not isinstance(field, int) or not 0 <= field <= 0xFFFFFFFF:
            raise EvaluationFailure("loader observation contains invalid integer")
    if exports["tag"] != expected_tag:
        raise EvaluationFailure("loader observation tag mismatch")
    return value


def _run_loader(
    binary: Path,
    entry: str,
    job: dict,
    sample: str,
    expected_tag: str,
) -> dict:
    """Run one loader launch against completely fresh candidate-writable
    state.  The transpiler cache and TMPDIR are per-launch directories under
    the root-owned measurement root (created here, destroyed below), the
    launch joins a fresh per-launch cgroup leaf (before the setpriv drop) and
    gets a fresh IPC namespace, and after it exits every candidate-uid process
    is killed and reaped — so no launch can persist resolution state for a
    later repetition to replay.  Peak memory is the leaf's whole-tree
    kernel-owned memory.peak, read AFTER the full-tree reap; a demoted
    candidate cannot write the leaf control files or reset the counter.  When
    the accounting cgroup is unavailable (developer runs) the launch falls
    back to a GNU-time wait4 ru_maxrss reading in a separate trusted process."""
    state_root = MEASURE_ROOT / f"state-{job['id']}-{sample}"
    shutil.rmtree(state_root, ignore_errors=True)
    state_root.mkdir(mode=0o755)
    cache = state_root / "cache"
    tmp = state_root / "tmp"
    for scratch in (cache, tmp):
        scratch.mkdir(mode=0o777)
        os.chmod(scratch, 0o777)
    env = _candidate_env(
        {
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH": str(cache),
            "TMPDIR": str(tmp),
        }
    )
    demote = [
        "/usr/bin/setpriv",
        f"--reuid={CANDIDATE_UID}",
        f"--regid={CANDIDATE_GID}",
        "--clear-groups",
        "--no-new-privs",
    ]
    leaf: Path | None = None
    rss_path: Path | None = None
    if _CGROUP_ACTIVE:
        leaf = CGROUP_ROOT / f"leaf-{job['id']}-{sample}"
        leaf.mkdir(mode=0o755, exist_ok=False)
        argv = [*demote, str(binary), entry]
    else:
        rss_path = MEASURE_ROOT / f"rss-{job['id']}-{sample}.txt"
        rss_path.unlink(missing_ok=True)
        argv = ["/usr/bin/time", "--format=%M", f"--output={rss_path}", "--", *demote, str(binary), entry]
    peak_from_cgroup: int | None = None
    try:
        started = time.perf_counter()
        completed = _run(
            argv,
            cwd=Path(entry).parent,
            timeout=RUN_TIMEOUT_SEC,
            fresh_ipc=True,
            cgroup_leaf=leaf,
            env=env,
        )
        elapsed = time.perf_counter() - started
    finally:
        _reap_candidate_processes()
        if leaf is not None:
            # Whole-tree peak is monotone for the leaf's lifetime, so reading
            # it after the full-tree reap still captures the true maximum.
            try:
                peak_from_cgroup = int((leaf / "memory.peak").read_text(encoding="ascii").strip())
            except (OSError, ValueError):
                peak_from_cgroup = None
            finally:
                _drain_measurement_leaf(leaf)
        _clear_candidate_writable()
        shutil.rmtree(state_root, ignore_errors=True)
    if leaf is not None:
        if peak_from_cgroup is None or peak_from_cgroup <= 0:
            raise EvaluationFailure("cgroup did not report a positive whole-tree memory peak")
        # Bytes -> KiB, rounded up, so the oracle stays in the historical unit.
        peak_rss_kib = -(-peak_from_cgroup // 1024)
    else:
        try:
            peak_rss_kib = int(rss_path.read_text(encoding="ascii").strip())
        except (OSError, ValueError) as exc:
            raise EvaluationFailure("GNU time did not report peak RSS") from exc
        if peak_rss_kib <= 0:
            raise EvaluationFailure("invalid peak RSS")
    observation = _parse_observation(completed.stdout, expected_tag)
    return {
        "elapsedSec": elapsed,
        "peakRssKiB": peak_rss_kib,
        "exportHash": _sha256_json(observation["exports"]),
        "sideEffectHash": _sha256_json(observation["sideEffects"]),
    }


def _strip_shared_write(root: Path) -> None:
    """Remove group/other write bits from every root-owned path in the tree.

    Candidate-owned build outputs cannot be relocked without CAP_CHOWN (their
    owner can always chmod them back); cross-repetition persistence through
    those is handled by the per-launch process sweep and per-launch fresh
    scratch instead."""
    for directory, _names, files in os.walk(root):
        for path in (Path(directory), *(Path(directory) / name for name in files)):
            try:
                st = path.lstat()
            except OSError:
                continue
            if st.st_uid != 0 or stat_module.S_ISLNK(st.st_mode):
                continue
            if st.st_mode & 0o022:
                os.chmod(path, st.st_mode & ~0o022)


def _prepare_measurement() -> None:
    """Transition from the candidate-writable build/test phase to the
    measurement phase.  Kills and reaps every candidate-uid process, purges
    the shared tmp roots, rebuilds the 0o777 build/test scratch directories
    as root-owned non-writable stubs, strips group/other write from every
    root-owned path under the build tree and the staged resolver source, and
    creates the root-owned measurement root, and mounts the whole-tree
    accounting cgroup.  After this point the only candidate-writable
    filesystem state is the per-launch scratch created (and destroyed) around
    each loader run."""
    _reap_candidate_processes()
    _clear_candidate_writable()
    for name in ("hone-home", "hone-bun-cache", WORK_ROOT.name):
        path = BUILD_ROOT / name
        shutil.rmtree(path, ignore_errors=True)
        path.mkdir(mode=0o755)
        os.chmod(path, 0o755)
    _strip_shared_write(SOURCE_ROOT / "src" / "resolver")
    _strip_shared_write(BUILD_ROOT)
    shutil.rmtree(MEASURE_ROOT, ignore_errors=True)
    MEASURE_ROOT.mkdir(mode=0o755)
    os.chmod(MEASURE_ROOT, 0o755)
    _mount_measurement_cgroup()


def _measure_jobs(spec: dict, jobs: list[dict]) -> dict[str, dict]:
    warm_reps = spec.get("warmRepetitions")
    if not isinstance(warm_reps, int) or not 2 <= warm_reps <= 7:
        raise EvaluationFailure("invalid warm repetition count")
    pair_samples = WARM_SAMPLE_ROUNDS * warm_reps
    measured: dict[str, dict] = {}
    for job in jobs:
        # Correctness phase (untimed): load the full module graph once per
        # binary; exports/side-effect hashes and peak RSS gate against the
        # frozen oracle exactly as before. Every launch (here and in the
        # timed phase) gets its own fresh transpiler cache and TMPDIR and is
        # followed by a candidate-uid process sweep, so no repetition can
        # observe state persisted by an earlier one.
        cand_load = _run_loader(SEALED_BUN, job["entry"], job, "cand-load", "graph")
        ref_load = _run_loader(REF_BUN, job["entry"], job, "ref-load", "graph")
        if (cand_load["exportHash"], cand_load["sideEffectHash"]) != (
            ref_load["exportHash"],
            ref_load["sideEffectHash"],
        ):
            raise EvaluationFailure(f"{job['id']}: candidate and reference load observations diverged")
        # Timed phase: the resolution-heavy driver resolves every import edge
        # of the frozen graph for the spec'd repetition count. Both binaries
        # run interleaved seconds apart under the SAME host state; the score
        # is the median of per-pair time ratios. Driver runs are multi-modal
        # (a stable plateau, a rare shallow fast mode of varying depth, and
        # occasional contention spikes), so a fastest-sample estimator would
        # measure the rare mode's own variance; the per-pair ratio median
        # rejects both spike tails and mode-occupancy luck, and
        # baseline == reference scores exactly REFERENCE_NORMALIZATION by
        # construction.
        driver = job["resolveEntry"]
        cand_obs: list[dict] = [
            _run_loader(SEALED_BUN, driver, job, "cand-resolve-warmup", "resolve")
        ]
        ref_obs: list[dict] = [
            _run_loader(REF_BUN, driver, job, "ref-resolve-warmup", "resolve")
        ]
        cand_times: list[float] = []
        ref_times: list[float] = []
        for index in range(pair_samples):
            c = _run_loader(SEALED_BUN, driver, job, f"cand-resolve-{index}", "resolve")
            r = _run_loader(REF_BUN, driver, job, f"ref-resolve-{index}", "resolve")
            cand_obs.append(c)
            ref_obs.append(r)
            cand_times.append(c["elapsedSec"])
            ref_times.append(r["elapsedSec"])
        cand_hashes = {(o["exportHash"], o["sideEffectHash"]) for o in cand_obs}
        ref_hashes = {(o["exportHash"], o["sideEffectHash"]) for o in ref_obs}
        if len(cand_hashes) != 1:
            raise EvaluationFailure(f"{job['id']}: candidate observations diverged across repetitions")
        if len(ref_hashes) != 1:
            raise EvaluationFailure(f"{job['id']}: reference observations diverged across repetitions")
        if cand_hashes != ref_hashes:
            raise EvaluationFailure(f"{job['id']}: candidate and reference resolve observations diverged")
        if min(min(cand_times), min(ref_times)) <= 0:
            raise EvaluationFailure(f"{job['id']}: non-positive timing sample")
        pair_ratio = statistics.median(c / r for c, r in zip(cand_times, ref_times))
        resolve_export_hash, resolve_side_effect_hash = next(iter(cand_hashes))
        measured[job["id"]] = {
            "kind": job["kind"],
            "loadSec": cand_load["elapsedSec"],
            "referenceLoadSec": ref_load["elapsedSec"],
            "driverSec": statistics.median(cand_times),
            "referenceDriverSec": statistics.median(ref_times),
            "pairRatio": pair_ratio,
            "normalizedScore": REFERENCE_NORMALIZATION / pair_ratio,
            "peakRssKiB": cand_load["peakRssKiB"],
            "exportHash": cand_load["exportHash"],
            "sideEffectHash": cand_load["sideEffectHash"],
            "resolveExportHash": resolve_export_hash,
            "resolveSideEffectHash": resolve_side_effect_hash,
        }
    return measured


def _result(
    *,
    valid: bool,
    tests_pass: bool,
    q: float,
    job_ids: list[str],
    measured: dict[str, dict],
    failures: list[str],
    build_sec: float | None,
    captured_oracle: dict | None = None,
) -> dict:
    score = q if valid and math.isfinite(q) and q > Q_FAIL else Q_FAIL
    per_example = {
        job_id: {
            "score": (measured[job_id]["normalizedScore"] if valid else Q_FAIL),
            "feedback": (
                "all hard gates passed; "
                f"resolveDriver={measured[job_id]['driverSec']:.6f}s "
                f"(reference driver={measured[job_id]['referenceDriverSec']:.6f}s, "
                f"median pair ratio={measured[job_id]['pairRatio']:.6f}, "
                f"reference-normalized score={measured[job_id]['normalizedScore']:.4f}; "
                f"graph load={measured[job_id]['loadSec']:.6f}s)"
                if valid
                else "hard gate failed"
            ),
        }
        for job_id in job_ids
    }
    if not per_example:
        per_example = {"capsule": {"score": Q_FAIL, "feedback": "hard gate failed"}}
    diagnostics: dict[str, object] = {
        "quality": 1.0 if valid else 0.0,
        "q": score,
        "qFail": Q_FAIL,
        "failures": failures,
        "buildSec": build_sec,
        "measurements": measured if valid else {},
    }
    if captured_oracle is not None:
        diagnostics["capturedOracle"] = captured_oracle
    return {
        "valid": valid,
        "objectives": {"score": score},
        "constraints": {
            "tests_pass": tests_pass,
            "export_hashes": valid,
            "side_effect_hashes": valid,
            "peak_rss": valid,
        },
        "perExample": per_example,
        "diagnostics": diagnostics,
    }


def evaluate() -> dict:
    job_ids: list[str] = []
    measured: dict[str, dict] = {}
    build_sec: float | None = None
    tests_pass = False
    try:
        _become_subreaper()
        _prepare_candidate()
        build_sec = _build_candidate()
        _run_upstream_tests()
        tests_pass = True
        _prepare_measurement()
        spec, oracle = _load_assets()
        graph_root = MEASURE_ROOT / "graphs"
        graph_root.mkdir(mode=0o755)
        jobs = materialize(spec, graph_root)
        job_ids = [job["id"] for job in jobs]
        measured = _measure_jobs(spec, jobs)
        captured = {
            "version": 1,
            "jobs": {
                job_id: {
                    "exportHash": measured[job_id]["exportHash"],
                    "sideEffectHash": measured[job_id]["sideEffectHash"],
                    "resolveExportHash": measured[job_id]["resolveExportHash"],
                    "resolveSideEffectHash": measured[job_id]["resolveSideEffectHash"],
                    "baselinePeakRssKiB": measured[job_id]["peakRssKiB"],
                }
                for job_id in job_ids
            },
        }
        failures: list[str] = []
        if set(oracle["jobs"]) != set(job_ids):
            failures.append("oracle job set mismatch")
        for job_id in job_ids:
            actual = measured[job_id]
            expected = oracle["jobs"].get(job_id)
            if not isinstance(expected, dict):
                failures.append(f"{job_id}: missing oracle")
                continue
            if actual["exportHash"] != expected.get("exportHash"):
                failures.append(f"{job_id}: export hash mismatch")
            if actual["sideEffectHash"] != expected.get("sideEffectHash"):
                failures.append(f"{job_id}: side-effect hash mismatch")
            if actual["resolveExportHash"] != expected.get("resolveExportHash"):
                failures.append(f"{job_id}: resolve export hash mismatch")
            if actual["resolveSideEffectHash"] != expected.get("resolveSideEffectHash"):
                failures.append(f"{job_id}: resolve side-effect hash mismatch")
            baseline_rss = expected.get("baselinePeakRssKiB")
            if not isinstance(baseline_rss, int) or actual["peakRssKiB"] > math.floor(baseline_rss * RSS_TOLERANCE):
                failures.append(f"{job_id}: peak RSS exceeds baseline allowance")
        capture = os.environ.get("HONE_CAPTURE_ORACLE") == "1"
        if failures and not capture:
            return _result(valid=False, tests_pass=True, q=Q_FAIL, job_ids=job_ids, measured=measured, failures=failures, build_sec=build_sec)
        q = math.exp(
            statistics.fmean(
                math.log(measured[job_id]["normalizedScore"]) for job_id in job_ids
            )
        )
        if not math.isfinite(q):
            raise EvaluationFailure("non-finite scalar")
        return _result(
            valid=True,
            tests_pass=True,
            q=q,
            job_ids=job_ids,
            measured=measured,
            failures=[],
            build_sec=build_sec,
            captured_oracle=captured if capture else None,
        )
    except BaseException as exc:
        return _result(
            valid=False,
            tests_pass=tests_pass,
            q=Q_FAIL,
            job_ids=job_ids,
            measured=measured,
            failures=[f"{type(exc).__name__}: {exc}"],
            build_sec=build_sec,
        )
    finally:
        _unmount_measurement_cgroup()


def main() -> None:
    json.dump(evaluate(), sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
