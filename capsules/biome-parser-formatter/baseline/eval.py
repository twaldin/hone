#!/usr/bin/env python3
"""Trusted offline evaluator for Biome parser/formatter throughput.

The image contains the pinned upstream tree, cargo-vendored dependencies, the
protected benchmark runner, and a prebuilt target seed. Only the four parser /
formatter `src` trees are overlaid from the candidate. Cargo, tests, and the
runner execute as uid 2000, which cannot traverse the root-only asset mount.

Robustness model: mutable crate code is linked into the benchmark runner, so
nothing the runner process reports (stdout, timing, exit status alone) is
trusted. This parent process measures wall time itself, seals the built runner
at a root-owned path so it cannot be swapped mid-evaluation, and gates
correctness over the same frozen corpus the benchmark times: every workload —
valid JS/TS/CSS, deliberately malformed recovery JS AND CSS, and formatter
edge constructs — must reproduce the frozen byte-exact formatted output,
diagnostic hashes, and idempotence, and then runs under the timed benchmark
path. There is no separate gate-only runner mode: the runner's argv shapes are
exactly `verify` (oracle check) and `parse|format INPUT REPS NONCE` (timed
legs), so a candidate cannot detect a regression gate and route to a special
correct path, and no fixed gate-only input strings ship in the harness.

Completion binding: iteration selection and per-iteration validation live in
this trusted parent, never in a candidate-authored completion file or receipt.
The parent draws a fresh per-sample nonce and drives both the candidate runner
and the pristine reference runner with it; each folds every timed iteration's
protected probe observations into a nonce-keyed proof returned over the
parent-owned stdout pipe. A sample counts only when the candidate's proof
equals the reference's proof for that nonce — possible only if the candidate
actually executed every timed iteration over the pinned parser/formatter
output. Because each iteration's input is a nonce/iteration-keyed rotation of
the frozen source, a candidate special-casing exact input bytes (including the
recovery constructs) diverges at the rotated iterations and cannot match.

Isolation model: every timed leg runs in a fresh cgroup2 measurement leaf
(joined while root, before privilege drop) whose kernel memory.peak is the
whole-tree RSS accounting, and in a fresh mount+IPC namespace with a brand-new
/tmp, /dev/shm, and /var/tmp, so no scratch, POSIX/SysV shm, or on-disk residue
carries parser/formatter state between legs. Between legs the evaluator (a
subreaper) kills and reaps every candidate-uid process so no candidate residue
runs while the reference leg is timed.

Scoring model: per workload/mode the candidate and reference alternate over
BENCH_BATCHES fresh-process legs with per-file repetitions frozen at ~0.6s of
work per leg; the score is a frozen anchor scaled by the geometric mean over
workloads of the per-workload MEDIAN per-pair reference/candidate wall-time
ratio (candidate and reference in one batch run back-to-back against the same
instantaneous host load, so the ratio cancels common-mode contention within
the pair, and the median rejects pairs where a short burst hit only one leg),
so thin true margins survive noisy shared hosts.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import secrets
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time

TRUSTED = Path(__file__).resolve().parent
CHALLENGE = json.loads((TRUSTED / "challenge.json").read_text(encoding="utf-8"))
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
UPSTREAM = Path("/opt/biome")
TARGET = Path("/tmp/target")
BUILT_RUNNER = TARGET / "release/hone_biome_bench"
SEALED_DIR = Path("/tmp/hone-sealed")
RUNNER = SEALED_DIR / "hone_biome_bench"
# Pristine reference runner baked into the image at build time from the
# frozen baseline sources and the same benchmark harness. Root-owned and
# read-only inside the eval container, so candidate-linked code can never
# influence it. It is the in-container yardstick every candidate sample is
# ratioed against.
REFERENCE_RUNNER = Path("/opt/target-seed/release/hone_biome_bench")
# Frozen scale anchor for the ratio-normalized score: the locked A-A
# calibration qBase from the capsule manifest. A candidate exactly as fast as
# the pristine reference scores this value; relative speedups scale it by the
# measured ratio. The anchor is a constant, so it carries no host state.
REFERENCE_ANCHOR_Q = 0.0769000486784732
# Timed batches per binary per workload/mode. Each binary runs this many
# times, strictly alternating with the other; each batch contributes one
# back-to-back candidate/reference pair to the median-of-pair-ratios
# estimator. More batches tighten the median and raise the fraction of pairs
# untouched by contention bursts on a loaded host.
BENCH_BATCHES = 30
# --- Trusted whole-tree memory accounting (CG) and per-leg kernel isolation
# (NS). Docker mounts the container cgroup2 view read-only, but the evaluator
# holds mount authority (CAP_SYS_ADMIN): a fresh cgroup2 instance over the
# (namespaced) hierarchy is writable by root only. Each timed leg joins a
# fresh measurement leaf while STILL ROOT in preexec, BEFORE unshare/setuid,
# so the ENTIRE candidate process tree — detached helpers in new sessions
# included — is charged to a leaf whose control files the demoted uid can
# never write. memory.peak is a kernel-owned monotone high-water mark for the
# leaf's lifetime; unlike /usr/bin/time %M (max-RSS of the direct child only)
# candidate code cannot reset or under-report it.
CGROUP_ROOT = Path("/tmp/hone-biome-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10.0
CLONE_NEWNS = 0x00020000
CLONE_NEWIPC = 0x08000000
MS_NOSUID = 0x2
MS_NODEV = 0x4
MS_NOEXEC = 0x8
MS_BIND = 0x1000
MS_REC = 0x4000
MS_PRIVATE = 0x40000
MS_MOVE = 0x2000
# Staging mount point on the always-writable /dev tmpfs (the container rootfs
# is read-only). Each timed leg mounts a FRESH private tmpfs here, binds the
# sealed runner and the frozen input into it, then MS_MOVEs the whole staged
# view over /tmp inside the leg's private mount namespace: the shared /tmp
# (build tree, cgroup control files, prior scratch) disappears from the
# candidate's view, and every scratch byte dies with the namespace. A fresh
# /dev/shm and /var/tmp plus a fresh IPC namespace ensure no POSIX shm, SysV
# segment, or on-disk residue carries parser/formatter state between legs.
REP_STAGE = Path("/dev/hone-biome-stage")
STAGE_OPTIONS = b"size=64m,mode=0755"
SHM_OPTIONS = b"size=16m,mode=1777"
VARTMP_OPTIONS = b"size=16m,mode=1777"
STAGED_RUNNER = Path("/tmp/bin/runner")
# Input is staged under a fixed dir but KEEPS its original filename so the
# runner's extension check (.css vs JS) still classifies it correctly.
STAGED_INPUT_DIR = Path("/tmp/input")
_LIBC = ctypes.CDLL(None, use_errno=True)
_LIBC.unshare.argtypes = [ctypes.c_int]
_LIBC.mount.argtypes = [
    ctypes.c_char_p,
    ctypes.c_char_p,
    ctypes.c_char_p,
    ctypes.c_ulong,
    ctypes.c_char_p,
]
UID = 2000
GID = 2000
MUTABLE_CRATES = (
    "biome_js_parser",
    "biome_js_formatter",
    "biome_css_parser",
    "biome_css_formatter",
)
Q_FAIL = float(CHALLENGE["qFail"])


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fail(reason: str, *, tests_pass: bool = False, quality: float = 0.0) -> dict:
    return {
        "valid": False,
        "objectives": {"score": Q_FAIL},
        "constraints": {
            "tests_pass": tests_pass,
            "byte_exact": False,
            "diagnostic_hashes": False,
            "idempotent": False,
            "rss_within_limit": False,
        },
        "perExample": {"aggregate": {"score": Q_FAIL, "feedback": reason[:500]}},
        "diagnostics": {"quality": quality, "summary": reason[:1000]},
    }


def drop_privileges() -> None:
    os.setgroups([])
    os.setgid(GID)
    os.setuid(UID)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))


def become_subreaper() -> None:
    """Best-effort PR_SET_CHILD_SUBREAPER so orphaned candidate descendants
    reparent to this evaluator (already the case when it runs as container
    PID 1) and can be reaped by the sweep below."""
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(36, 1, 0, 0, 0)
    except Exception:
        pass


def reap_candidate_processes() -> None:
    """Kill and reap every process still running as the candidate uid.

    killpg alone misses descendants that started their own session. Under
    reference-ratio scoring a surviving candidate process could burn CPU
    selectively while the pristine reference leg runs and inflate the
    candidate's ratio, so after every timed leg the evaluator sweeps the
    whole container for candidate-uid processes until none remain.
    """
    for _ in range(50):
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                break
        live: list[int] = []
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                status = Path(f"/proc/{entry}/status").read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            uid_fields: list[str] = []
            state_fields: list[str] = []
            for line in status.splitlines():
                if line.startswith("Uid:"):
                    uid_fields = line.split()
                elif line.startswith("State:"):
                    state_fields = line.split()
            if len(uid_fields) < 2 or uid_fields[1] != str(UID):
                continue
            if len(state_fields) >= 2 and state_fields[1] == "Z":
                continue
            live.append(int(entry))
        if not live:
            return
        for pid in live:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(0.02)
    raise RuntimeError("candidate processes survived the reaping sweep")


def mount_measurement_cgroup() -> None:
    """Mount a fresh root-writable cgroup2 instance and delegate the memory
    controller to per-leg leaves. The evaluator (and every child it forks) is
    parked in a trusted leaf so the cgroup2 no-internal-process rule permits
    delegating +memory to the measurement leaves."""
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "cgroup2", "-o", "nosuid,nodev,noexec", "hone-biome-cg", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        CGROUP_ROOT.rmdir()
        raise RuntimeError("trusted measurement cgroup mount failed")
    try:
        CGROUP_TRUSTED.mkdir(mode=0o755)
        (CGROUP_TRUSTED / "cgroup.procs").write_text(str(os.getpid()))
        (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")
    except OSError as exc:
        raise RuntimeError("trusted measurement cgroup setup failed") from exc


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
    """Kill every task still charged to the leaf (detached descendants in new
    sessions included), wait for the kernel to release them, then retire the
    leaf so its memory.peak accounting can never bleed into a later leg."""
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
            raise RuntimeError("measurement cgroup could not be drained")
        time.sleep(0.05)
    try:
        leaf.rmdir()
    except OSError as exc:
        raise RuntimeError("measurement cgroup could not be retired") from exc


def _join_leaf(leaf_procs: Path) -> None:
    with open(leaf_procs, "w") as handle:
        handle.write("0")


def verify_leg_preexec(leaf_procs: Path) -> None:
    """Correctness/verify child: charge the whole tree to a fresh measurement
    leaf (joined while still root), give it a private IPC namespace, then drop
    to the candidate uid. No mount-namespace isolation, because the trusted
    parent reads the verify output files back from the shared /tmp work tree."""
    _join_leaf(leaf_procs)
    if _LIBC.unshare(CLONE_NEWIPC) != 0:
        raise OSError(ctypes.get_errno(), "verify IPC isolation failed")
    drop_privileges()


def isolated_benchmark_preexec(
    leaf_procs: Path, runner_src: Path, input_src: Path, input_name: str
) -> None:
    """Give each timed benchmark leg a private kernel view: fresh mount and IPC
    namespaces whose /tmp is a brand-new tmpfs holding ONLY the sealed runner
    and the frozen input, plus a fresh /dev/shm and /var/tmp. Nothing a leg
    writes is visible to any other leg, and no POSIX/SysV shm channel survives.

    The first action joins this leg's measurement leaf, while still root and
    BEFORE the mount namespace is unshared: the leaf path lives under the
    shared /tmp the MS_MOVE below hides, so the join must run against the
    parent's still-visible mount view. cgroup membership is independent of the
    mount namespace and is inherited by every descendant, so the whole tree is
    accounted regardless of what the candidate forks."""
    _join_leaf(leaf_procs)
    if _LIBC.unshare(CLONE_NEWNS | CLONE_NEWIPC) != 0:
        raise OSError(ctypes.get_errno(), "benchmark namespace isolation failed")
    if _LIBC.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        raise OSError(ctypes.get_errno(), "private mount propagation failed")
    stage = os.fsencode(str(REP_STAGE))
    if _LIBC.mount(b"hone-biome-stage", stage, b"tmpfs", MS_NOSUID | MS_NODEV, STAGE_OPTIONS) != 0:
        raise OSError(ctypes.get_errno(), "fresh stage tmpfs mount failed")
    os.mkdir(REP_STAGE / "bin", 0o755)
    os.mkdir(REP_STAGE / "input", 0o755)
    bin_target = REP_STAGE / "bin" / "runner"
    input_target = REP_STAGE / "input" / input_name
    os.close(os.open(bin_target, os.O_CREAT | os.O_WRONLY, 0o644))
    os.close(os.open(input_target, os.O_CREAT | os.O_WRONLY, 0o644))
    if _LIBC.mount(os.fsencode(str(runner_src)), os.fsencode(str(bin_target)), None, MS_BIND, None) != 0:
        raise OSError(ctypes.get_errno(), "sealed runner bind failed")
    if _LIBC.mount(os.fsencode(str(input_src)), os.fsencode(str(input_target)), None, MS_BIND, None) != 0:
        raise OSError(ctypes.get_errno(), "frozen input bind failed")
    if _LIBC.mount(stage, b"/tmp", None, MS_MOVE, None) != 0:
        raise OSError(ctypes.get_errno(), "staged benchmark view move failed")
    if _LIBC.mount(b"hone-biome-shm", b"/dev/shm", b"tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, SHM_OPTIONS) != 0:
        raise OSError(ctypes.get_errno(), "fresh shm tmpfs mount failed")
    if _LIBC.mount(b"hone-biome-vartmp", b"/var/tmp", b"tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, VARTMP_OPTIONS) != 0:
        raise OSError(ctypes.get_errno(), "fresh var-tmp tmpfs mount failed")
    drop_privileges()


def _spawn_measured(argv: list[str], *, timeout: float, preexec_fn) -> tuple[int, bytes, bytes]:
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        preexec_fn=preexec_fn,
    )
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise RuntimeError(f"candidate process timed out after {timeout:.0f}s: {argv[0]}")
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return proc.returncode, out, err


PROOF_PREFIX = "PROOF "


def parse_proof(out: bytes) -> str:
    lines = [line for line in out.decode(errors="replace").splitlines() if line.startswith(PROOF_PREFIX)]
    if len(lines) != 1:
        raise RuntimeError("benchmark runner did not emit exactly one proof line")
    token = lines[0][len(PROOF_PREFIX):].strip()
    if len(token) != 16 or any(char not in "0123456789abcdef" for char in token):
        raise RuntimeError("benchmark runner emitted a malformed proof")
    return token


def run_bench_leg(
    runner: Path,
    mode: str,
    source: Path,
    repetitions: int,
    nonce: int,
    leaf_id: int,
) -> tuple[float, int, str]:
    """One timed runner invocation inside a fresh measurement leaf and a
    per-leg private mount/IPC namespace. Returns (elapsed_ms, rss_kib, proof).
    Wall time is the trusted parent's; the proof (folded from every timed
    iteration's protected observations) crosses back over the parent-owned
    stdout pipe and is cross-checked against the pristine reference; RSS is the
    kernel cgroup memory.peak over the whole leg process tree."""
    leaf = CGROUP_ROOT / f"leaf-{leaf_id}"
    leaf.mkdir(mode=0o755, exist_ok=False)
    leaf_procs = leaf / "cgroup.procs"
    staged_input = STAGED_INPUT_DIR / source.name
    argv = [str(STAGED_RUNNER), mode, str(staged_input), str(repetitions), str(nonce)]

    def preexec() -> None:
        isolated_benchmark_preexec(leaf_procs, runner, source, source.name)

    try:
        started = time.perf_counter_ns()
        returncode, out, err = _spawn_measured(
            argv, timeout=float(CHALLENGE["benchmarkTimeoutSec"]), preexec_fn=preexec
        )
        elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
        try:
            peak_bytes = int((leaf / "memory.peak").read_text(encoding="utf-8").strip())
        except OSError as exc:
            raise RuntimeError("measurement leaf memory.peak unreadable") from exc
    finally:
        drain_measurement_leaf(leaf)
    reap_candidate_processes()
    if returncode != 0:
        raise RuntimeError(f"runner failed: {err.decode(errors='replace')[-500:]}")
    proof = parse_proof(out)
    return elapsed_ms, peak_bytes // 1024, proof


def run_untrusted(
    argv: list[str],
    *,
    cwd: Path | None = None,
    timeout: float,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Run candidate-linked code in its own session and reap the full tree.

    A per-sample timeout kills the whole process group, so no candidate
    descendant can outlive the measurement window or stall the evaluator on
    an inherited pipe.
    """
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        start_new_session=True,
        preexec_fn=drop_privileges,
    )
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise RuntimeError(f"candidate process timed out after {timeout:.0f}s: {argv[0]}")
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return subprocess.CompletedProcess(argv, proc.returncode, out, err)


def validate_envelope() -> None:
    mutable_root = WORKSPACE / "mutable"
    if not mutable_root.is_dir() or mutable_root.is_symlink():
        raise RuntimeError("candidate mutable envelope is missing or not a real directory")
    actual = {entry.name for entry in mutable_root.iterdir()}
    if actual != set(MUTABLE_CRATES):
        raise RuntimeError("candidate mutable envelope has missing or unexpected crates")
    total_files = 0
    total_bytes = 0
    for crate in MUTABLE_CRATES:
        root = mutable_root / crate / "src"
        if not root.is_dir() or root.is_symlink():
            raise RuntimeError(f"{crate}/src is missing or not a real directory")
        for path in root.rglob("*"):
            if path.is_symlink():
                raise RuntimeError(f"symlink rejected in {crate}/src")
            if path.is_file():
                total_files += 1
                total_bytes += path.stat().st_size
            elif not path.is_dir():
                raise RuntimeError(f"non-regular entry rejected in {crate}/src")
    if total_files == 0 or total_files > 20000 or total_bytes > 64 * 1024 * 1024:
        raise RuntimeError("candidate mutable envelope exceeds source bounds")


def candidate_matches_baseline() -> bool:
    for crate in MUTABLE_CRATES:
        candidate = WORKSPACE / "mutable" / crate / "src"
        frozen = UPSTREAM / "crates" / crate / "src"
        candidate_files = sorted(
            path.relative_to(candidate) for path in candidate.rglob("*") if path.is_file()
        )
        frozen_files = sorted(
            path.relative_to(frozen) for path in frozen.rglob("*") if path.is_file()
        )
        if candidate_files != frozen_files:
            return False
        for relative in candidate_files:
            if (candidate / relative).read_bytes() != (frozen / relative).read_bytes():
                return False
    return True


def mount_candidate_sources() -> None:
    validate_envelope()
    for crate in MUTABLE_CRATES:
        source = WORKSPACE / "mutable" / crate / "src"
        target = UPSTREAM / "crates" / crate / "src"
        subprocess.run(["mount", "--bind", str(source), str(target)], check=True)


def remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def prepare_build_tree(needs_build: bool) -> dict[str, str]:
    subprocess.run(
        ["mount", "-o", f"remount,size={CHALLENGE['tmpfsSize']},exec", "/tmp"],
        check=True,
    )
    created = run_untrusted(["mkdir", "-p", str(TARGET)], timeout=10)
    if created.returncode != 0:
        raise RuntimeError(f"target directory setup failed: {created.stderr.decode(errors='replace')[:500]}")
    cloned = run_untrusted(
        ["cp", "-as", "/opt/target-seed/.", str(TARGET)],
        timeout=60,
    )
    if cloned.returncode != 0:
        raise RuntimeError(f"target seed clone failed: {cloned.stderr.decode(errors='replace')[:500]}")
    if not needs_build:
        return {
            "PATH": os.environ.get("PATH", ""),
            "HOME": "/tmp",
            "RUSTUP_HOME": "/usr/local/rustup",
            "RUST_BACKTRACE": "0",
        }

    release = TARGET / "release"
    for lock in release.glob(".cargo*lock"):
        remove_path(lock)
    fingerprint = release / ".fingerprint"
    remove_path(fingerprint)
    fingerprint_copy = run_untrusted(
        ["cp", "-a", "/opt/target-seed/release/.fingerprint", str(fingerprint)],
        timeout=60,
    )
    if fingerprint_copy.returncode != 0:
        raise RuntimeError(f"fingerprint cache setup failed: {fingerprint_copy.stderr.decode(errors='replace')[:500]}")
    build_cache_metadata = run_untrusted(
        [
            "sh",
            "-c",
            "for name in invoked.timestamp output root-output stderr '*.d'; do "
            "find /tmp/target/release/build -type l -name \"$name\" "
            "-exec sh -c 'for link do src=$(readlink -f \"$link\") || exit; "
            "rm \"$link\" && cp \"$src\" \"$link\" || exit; done' sh {} + || exit; done; "
            "find /tmp/target/release/build -type l -path '*/out/*' "
            "-exec sh -c 'for link do src=$(readlink -f \"$link\") || exit; "
            "rm \"$link\" && cp \"$src\" \"$link\" || exit; done' sh {} +",
        ],
        timeout=60,
    )
    if build_cache_metadata.returncode != 0:
        raise RuntimeError(f"build-script cache setup failed: {build_cache_metadata.stderr.decode(errors='replace')[:500]}")
    depfile_copy = run_untrusted(
        [
            "sh",
            "-c",
            "for link in /tmp/target/release/deps/*.d; do "
            "if [ -L \"$link\" ]; then src=$(readlink -f \"$link\") || exit; "
            "rm \"$link\" && cp \"$src\" \"$link\" || exit; fi; done",
        ],
        timeout=60,
    )
    if depfile_copy.returncode != 0:
        raise RuntimeError(f"dependency cache setup failed: {depfile_copy.stderr.decode(errors='replace')[:500]}")
    rustc_info = TARGET / ".rustc_info.json"
    remove_path(rustc_info)
    rustc_info_copy = run_untrusted(
        ["cp", "-a", "/opt/target-seed/.rustc_info.json", str(rustc_info)],
        timeout=10,
    )
    if rustc_info_copy.returncode != 0:
        raise RuntimeError(f"rustc cache setup failed: {rustc_info_copy.stderr.decode(errors='replace')[:500]}")
    prefixes = (*MUTABLE_CRATES, "hone_biome_bench")
    fingerprint = release / ".fingerprint"
    for prefix in prefixes:
        for path in fingerprint.glob(f"{prefix}-*"):
            remove_path(path)
        for path in (release / "deps").glob(f"{prefix}-*"):
            remove_path(path)
        for path in (release / "deps").glob(f"lib{prefix}-*"):
            remove_path(path)
    for path in release.glob("hone_biome_bench*"):
        remove_path(path)

    cargo_home = Path("/tmp/cargo-home")
    cargo_setup = run_untrusted(
        ["sh", "-c", "mkdir -p /tmp/cargo-home && cp /usr/local/cargo/config.toml /tmp/cargo-home/config.toml"],
        timeout=10,
    )
    if cargo_setup.returncode != 0:
        raise RuntimeError(f"Cargo home setup failed: {cargo_setup.stderr.decode(errors='replace')[:500]}")
    return {
        "PATH": os.environ.get("PATH", ""),
        "HOME": "/tmp",
        "RUSTUP_HOME": "/usr/local/rustup",
        "CARGO_HOME": str(cargo_home),
        "CARGO_TARGET_DIR": str(TARGET),
        "CARGO_NET_OFFLINE": "true",
        "CARGO_INCREMENTAL": "0",
        "CARGO_PROFILE_RELEASE_LTO": "false",
        "RUST_BACKTRACE": "0",
    }


def cargo_failure(stderr: bytes) -> str:
    text = stderr.decode(errors="replace")
    important = []
    for line in text.splitlines():
        lowered = line.strip().lower()
        if lowered.startswith(("error", "fatal")) or any(
            token in lowered for token in ("failed to write", "no space left", "read-only file system", "signal:")
        ):
            important.append(line)
    return "\n".join(important[-20:])[-3000:] or text[-3000:]


def build_candidate(env: dict[str, str], needs_build: bool) -> tuple[bool, str, float]:
    started = time.monotonic()
    if needs_build:
        build = run_untrusted(
            ["cargo", "build", "--locked", "--offline", "--release", "-p", "hone_biome_bench"],
            cwd=UPSTREAM,
            timeout=float(CHALLENGE["buildTimeoutSec"]),
            env=env,
        )
        if build.returncode != 0:
            return False, f"candidate build failed (exit {build.returncode}): {cargo_failure(build.stderr)}", time.monotonic() - started
    return True, "", time.monotonic() - started


def seal_runner() -> None:
    """Copy the built runner to a root-owned path before any measurement.

    The build tree under /tmp/target stays writable by uid 2000, so the binary
    there could be replaced between invocations. All regression, verification,
    and benchmark children execute the sealed root-owned copy instead.
    """
    if SEALED_DIR.exists():
        raise RuntimeError("sealed runner directory already exists")
    SEALED_DIR.mkdir(mode=0o755)
    SEALED_DIR.chmod(0o755)
    if not BUILT_RUNNER.exists():
        raise RuntimeError("benchmark runner binary is missing after build")
    shutil.copyfile(BUILT_RUNNER, RUNNER)
    RUNNER.chmod(0o755)


def run_measured_rss(argv: list[str], *, timeout: float, leaf_id: int) -> int:
    """Run a correctness/verify child and return its whole-tree peak RSS in
    KiB from the kernel cgroup memory.peak — not /usr/bin/time %M, which only
    accounts the direct child's max-RSS and which candidate-linked code can
    duck by detaching a helper."""
    leaf = CGROUP_ROOT / f"verify-{leaf_id}"
    leaf.mkdir(mode=0o755, exist_ok=False)
    leaf_procs = leaf / "cgroup.procs"

    def preexec() -> None:
        verify_leg_preexec(leaf_procs)

    try:
        returncode, _out, err = _spawn_measured(argv, timeout=timeout, preexec_fn=preexec)
        try:
            peak_bytes = int((leaf / "memory.peak").read_text(encoding="utf-8").strip())
        except OSError as exc:
            raise RuntimeError("verify leaf memory.peak unreadable") from exc
    finally:
        drain_measurement_leaf(leaf)
    reap_candidate_processes()
    if returncode != 0:
        raise RuntimeError(f"runner failed: {err.decode(errors='replace')[-500:]}")
    return peak_bytes // 1024


def verify_cases(expected: dict, source_dir: Path, work: Path) -> tuple[list[Path], int]:
    verified: list[Path] = []
    peak_rss = 0
    for index, (name, oracle) in enumerate(sorted(expected["files"].items())):
        source = source_dir / name
        if not source.is_file() or sha256(source) != oracle["inputSha256"]:
            raise RuntimeError(f"frozen input hash mismatch: {name}")
        case = work / name.replace("/", "_")
        case.mkdir(mode=0o777)
        case.chmod(0o777)
        input_copy = case / name
        shutil.copyfile(source, input_copy)
        input_copy.chmod(0o444)
        output = case / "formatted"
        second = case / "second"
        diagnostics = case / "diagnostics"
        rss = run_measured_rss(
            [str(RUNNER), "verify", str(input_copy), str(output), str(second), str(diagnostics)],
            timeout=float(CHALLENGE["benchmarkTimeoutSec"]),
            leaf_id=index,
        )
        peak_rss = max(peak_rss, rss)
        if output.read_bytes() != second.read_bytes():
            raise RuntimeError(f"idempotence gate failed: {name}")
        if sha256(output) != oracle["formattedSha256"] or output.stat().st_size != oracle["formattedBytes"]:
            raise RuntimeError(f"byte-exact formatting gate failed: {name}")
        if sha256(diagnostics) != oracle["diagnosticSha256"]:
            raise RuntimeError(f"diagnostic hash gate failed: {name}")
        # The verified artifacts double as answer keys for the frozen output,
        # so they must not stay readable in the candidate-writable work tree.
        for artifact in (output, second, diagnostics):
            remove_path(artifact)
        for leftover in case.iterdir():
            if leftover != input_copy:
                remove_path(leftover)
        case.chmod(0o755)
        verified.append(input_copy)
    return verified, peak_rss


def benchmark(
    expected: dict, cases: list[Path], work: Path, initial_peak_rss: int
) -> tuple[float, int, dict[str, float], dict[str, float]]:
    """Benchmark every frozen workload against the pristine in-container
    reference. Per workload/mode the candidate and the reference each run
    BENCH_BATCHES times in fresh measurement leaves and fresh per-leg mount/IPC
    namespaces, strictly alternating so both binaries sample the same
    wall-clock window; the estimator is the median of per-pair ratios:
    each batch's candidate and reference legs run back-to-back against the
    same instantaneous host load, so their per-rep ratio cancels common-mode
    contention within the pair, and the per-workload ratio is
        ratio = median(reference per-rep / candidate per-rep, per batch)
    The median (unlike a mean/geomean of pairs) also rejects the pairs where
    a contention burst shorter than the two-leg window hit only one leg —
    the dominant residual noise on a shared host under sustained load.
    Repetitions come from a frozen per-file table (challenge.json)
    calibrated so every timed leg is ~0.6s of work regardless of file size,
    equalizing each workload's exposure to load. The score is the frozen
    anchor scaled by the geometric mean of the per-workload/mode ratios:
        q = REFERENCE_ANCHOR_Q * geomean(ratio per workload/mode)
    (the reported per-workload measurement keeps min(candidate per-rep) as a
    diagnostic only).

    Completion binding (ADAPTER/ITER): iteration selection and per-iteration
    validation live in the trusted parent, never in a candidate-authored file.
    The parent draws a fresh per-sample nonce and drives BOTH the candidate and
    the reference with it; each runner folds every timed iteration's protected
    probe observations into a nonce-keyed proof returned over the parent-owned
    stdout pipe. A sample counts only when the candidate's proof equals the
    pristine reference's proof for that nonce, which is possible only if the
    candidate actually executed every timed iteration over the pinned parser /
    formatter output. A process that computed the base once and exited, or that
    skipped rotations/probes, produces no matching proof. The warmup uses a
    distinct nonce, so nothing precomputed during warmup can satisfy a scored
    leg. RSS is the kernel cgroup memory.peak from candidate legs only.
    """
    if REFERENCE_RUNNER.is_symlink() or not REFERENCE_RUNNER.is_file():
        raise RuntimeError("pristine reference runner is missing from the image")
    REP_STAGE.mkdir(mode=0o755, exist_ok=True)
    reap_candidate_processes()
    measurements: dict[str, float] = {}
    ratios: dict[str, float] = {}
    peak_rss = initial_peak_rss
    leaf_id = 1000
    for source in cases:
        for mode in ("parse", "format"):
            # Frozen per-file repetition table (challenge.json), calibrated so
            # every timed leg is ~0.6s of work regardless of file size: this
            # equalizes each workload's exposure to host load (short legs are
            # disproportionately noisy) and keeps each candidate/reference
            # pair inside one narrow load window. Identical reps drive the
            # candidate and the pristine reference, so the table adds no seam.
            repetitions = int(CHALLENGE["repetitions"][source.name][mode])
            measured_nonce = secrets.randbits(63)
            warmup_nonce = secrets.randbits(63)
            candidate_ms: list[float] = []
            reference_ms: list[float] = []
            candidate_proofs: set[str] = set()
            reference_proofs: set[str] = set()
            # Untimed warmup per binary with a DISTINCT nonce equalizes
            # cold-start (page cache, allocator arenas) without ever producing
            # a proof that a scored leg could reuse.
            for runner in (RUNNER, REFERENCE_RUNNER):
                run_bench_leg(runner, mode, source, repetitions, warmup_nonce, leaf_id)
                leaf_id += 1
            for batch in range(BENCH_BATCHES):
                legs = [("candidate", RUNNER), ("reference", REFERENCE_RUNNER)]
                if batch % 2 == 1:
                    legs.reverse()
                for leg_name, runner in legs:
                    elapsed_ms, rss, proof = run_bench_leg(
                        runner, mode, source, repetitions, measured_nonce, leaf_id
                    )
                    leaf_id += 1
                    per_rep = elapsed_ms / repetitions
                    if leg_name == "candidate":
                        candidate_ms.append(per_rep)
                        candidate_proofs.add(proof)
                        peak_rss = max(peak_rss, rss)
                    else:
                        reference_ms.append(per_rep)
                        reference_proofs.add(proof)
            if len(reference_proofs) != 1:
                raise RuntimeError("pristine reference proof was unstable across timed legs")
            if len(candidate_proofs) != 1:
                raise RuntimeError("candidate benchmark proof varied across timed iterations")
            if candidate_proofs != reference_proofs:
                raise RuntimeError(
                    "candidate benchmark proof does not match the pristine reference: "
                    "the candidate did not execute every timed iteration over the pinned output"
                )
            # Median of per-pair ratios: candidate and reference legs in the
            # same batch run back-to-back against the same instantaneous host
            # load, so their ratio cancels common-mode contention within each
            # pair; the median rejects pairs where a short burst hit only one
            # leg, which mean/geomean estimators absorb.
            paired = [ref / cand for cand, ref in zip(candidate_ms, reference_ms)]
            measurements[f"{source.name}:{mode}"] = min(candidate_ms)
            ratios[f"{source.name}:{mode}"] = statistics.median(paired)
    if not ratios or any(
        not math.isfinite(value) or value <= 0
        for value in list(ratios.values()) + list(measurements.values())
    ):
        raise RuntimeError("non-finite benchmark measurement")
    q = REFERENCE_ANCHOR_Q * math.exp(
        statistics.fmean(math.log(value) for value in ratios.values())
    )
    return q, peak_rss, measurements, ratios


def log(message: str) -> None:
    print(f"hone-biome-eval: {message}", file=sys.stderr, flush=True)


def evaluate() -> dict:
    become_subreaper()
    validate_envelope()
    needs_build = not candidate_matches_baseline()
    log("mounting candidate source envelope")
    mount_candidate_sources()
    log("preparing offline build cache")
    env = prepare_build_tree(needs_build)
    log("building candidate")
    built, build_detail, build_sec = build_candidate(env, needs_build)
    if not built:
        return fail(build_detail)
    seal_runner()
    expected_paths = list(ASSETS.rglob("expected.json"))
    if len(expected_paths) != 1:
        return fail("selected asset group must contain exactly one expected.json")
    expected_path = expected_paths[0]
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if expected.get("schema") != "hone-biome-expected-v2" or expected.get("sourceRevision") != CHALLENGE["sourceRevision"]:
        return fail("expected-output oracle identity mismatch")
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="hone-work-") as tmp_raw:
        work = Path(tmp_raw)
        work.chmod(0o755)
        log("mounting trusted measurement cgroup")
        try:
            mount_measurement_cgroup()
        except Exception as exc:
            return fail(f"measurement cgroup unavailable: {exc}")
        log("gating correctness: byte-exact output, diagnostics, and idempotence over the frozen corpus (incl. malformed-recovery JS/CSS and formatter edge constructs)")
        test_started = time.monotonic()
        try:
            try:
                cases, peak_rss = verify_cases(expected, expected_path.parent, work)
            except Exception as exc:
                return fail(f"correctness gate failed: {exc}")
            test_detail = (
                f"correctness gate passed: {len(cases)} frozen workloads (valid JS/TS/CSS, "
                f"malformed-recovery JS and CSS, formatter edge constructs) byte-exact, "
                f"diagnostic-hash-exact, and idempotent vs the frozen oracle; benchmark "
                f"iterations proof-bound to the pristine reference"
            )
            build_test_sec = build_sec + (time.monotonic() - test_started)
            log(f"build/test stage completed in {build_test_sec:.1f}s")
            try:
                log(f"benchmarking {len(cases)} frozen files")
                q, peak_rss, measurements, ratios = benchmark(expected, cases, work, peak_rss)
                log("benchmark stage completed")
            except Exception as exc:
                return fail(str(exc), tests_pass=True)
        finally:
            unmount_measurement_cgroup()
    rss_limit = int(CHALLENGE["rssLimitKb"])
    if peak_rss > rss_limit:
        return fail(
            f"peak RSS {peak_rss} KiB exceeds frozen limit {rss_limit} KiB",
            tests_pass=True,
            quality=1.0,
        )
    if not math.isfinite(q) or q <= Q_FAIL:
        return fail("oriented scalar is not finite and positive", tests_pass=True, quality=1.0)
    return {
        "valid": True,
        "objectives": {"score": q},
        "constraints": {
            "tests_pass": True,
            "byte_exact": True,
            "diagnostic_hashes": True,
            "idempotent": True,
            "rss_within_limit": True,
        },
        "perExample": {
            "aggregate": {
                "score": q,
                "feedback": f"{len(cases)} frozen files; anchor-scaled geometric mean of median per-pair reference/candidate wall-time ratios, proof-cross-checked against the pristine reference",
            }
        },
        "diagnostics": {
            "quality": 1.0,
            "summary": test_detail,
            "q": q,
            "peak_rss_kb": peak_rss,
            "rss_limit_kb": rss_limit,
            "build_test_sec": build_test_sec,
            "reference_anchor_q": REFERENCE_ANCHOR_Q,
            "reference_ratio": ratios,
            "workload_ms": measurements,
        },
    }


def main() -> None:
    try:
        output = evaluate()
    except Exception as exc:
        output = fail(f"evaluator failure: {exc}")
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
