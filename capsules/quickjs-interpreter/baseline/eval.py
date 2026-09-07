#!/usr/bin/env python3
"""Trusted evaluator for the terminal bellard/quickjs interpreter capsule."""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import random
import re
import resource
import signal
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path("/tmp/hone-quickjs-build")
SOURCE = BUILD_ROOT / "source"
WORKLOAD_DIR = SOURCE / "hone-workload"
LAUNCH_SCRATCH = BUILD_ROOT / "launch-scratch"
REF_SOURCE = BUILD_ROOT / "ref-source"
REF_WORKSPACE = BUILD_ROOT / "ref-workspace"
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 180
# unshare(2) flag: every demoted (candidate-reachable) launch enters a FRESH
# IPC namespace so SysV shared memory, semaphores, and message queues can
# never carry candidate state from one launch to the next (the namespace dies
# with its last process). The broker eval container grants the trusted scorer
# CAP_SYS_ADMIN for exactly this preexec unshare; setuid(2000) then strips it
# from the candidate worker and no-new-privileges prevents reacquisition.
CLONE_NEWIPC = 0x08000000
# Loaded once in the trusted parent BEFORE any fork so the preexec child never
# allocates: dlopen inside preexec_fn is not async-signal-safe.
_LIBC = ctypes.CDLL(None, use_errno=True)
# Min-of-N trimmed sampling (trusted-parent timing). Host contention only ever
# ADDS wall time and every sample is trusted-timed and output-gated, so the
# fastest (least-contended) sample of each binary is the cleanest estimate of
# its true cost and rejects a persistent differential-contention competitor on
# the host without giving the candidate any control over which sample counts.
# N is kept high so at least one near-clean window is captured for each binary
# even under sustained ambient load (min-of-N doctrine for ~1s legs); the
# interleaved per-sample pristine reference then cancels shared host drift.
MICRO_SAMPLES = 15
MICRO_KEEP = 1
MODULE_KEEP = 16
# Per-evaluation iteration jitter: the trusted parent draws a fresh iteration
# count in [base, base + base//MICRO_ITER_JITTER_DIV] so no output can be
# precomputed against a fixed schedule while every sample of one evaluation
# keeps a stable magnitude for apples-to-apples timing.
MICRO_ITER_JITTER_DIV = 32
# Per-operation plausibility floor. Candidate and reference interpret the SAME
# streamed script over the SAME randomized input; a genuine interpreter
# optimization cannot make the candidate more than this many times faster than
# the pristine reference on identical work, so a candidate whose kept-fastest
# wall time falls below this fraction of the reference's is doing far less work
# than interpreting the loop (fabricating the fold across the process boundary)
# and is rejected.
MICRO_MIN_PLAUSIBLE_FRAC = 0.1
# ---------------------------------------------------------------------------
# Out-of-process work-proportional cross-check on every timed leg.
#
# The broker eval container's kernel does NOT expose hardware perf counters:
# perf_event_open(PERF_TYPE_HARDWARE, instructions/cycles) returns ENOENT on
# the pinned VM kernel even for root holding CAP_SYS_ADMIN (CAP_PERFMON is
# not granted, and PERF_TYPE_SOFTWARE events exist but are not
# work-proportional), so retired-instruction ratios cannot be measured here.
# The fallback signal is the kernel's reaped-child CPU accounting (the
# wait4/getrusage channel), read by the TRUSTED parent and never
# candidate-reported: a getrusage(RUSAGE_CHILDREN) delta brackets exactly one
# reaped launch (launches are strictly serial and orphaned stragglers are
# never reaped by this process, so nothing else lands in the window). Two
# gates bind it on candidate legs:
#   1. Single-threaded discipline (MAX_CPU_WALL_RATIO): the scored qjs
#      contract is a single-threaded interpreter, so a leg's CPU time cannot
#      meaningfully exceed its wall time. This rejects thread-parallel
#      wall-time compression and forked-helper CPU inflation alike (every
#      descendant's CPU lands in the same reaped accounting).
#   2. Per-operation CPU floor (MIN_CPU_FRAC): the kept-fastest candidate CPU
#      time must be at least this fraction of the pristine reference's on the
#      IDENTICAL streamed job. A single-threaded process accrues at most one
#      CPU-second per wall-second, so a candidate that produces the fold
#      without doing interpreter-proportional work and then idles or spins
#      into the wall-clock band is bounded to 1/MIN_CPU_FRAC x unearned
#      throughput; the wall floor alone left 1/MICRO_MIN_PLAUSIBLE_FRAC x
#      open. Genuine interpreter optimizations reduce CPU per operation only
#      modestly (the sealed improved control measures well under 2x), so the
#      2.5x band accepts every plausible genuine candidate; anything cheaper
#      than 40% of the reference's CPU on identical work is not interpreting.
# ---------------------------------------------------------------------------
MICRO_MIN_CPU_FRAC = 0.4
MICRO_MAX_CPU_WALL_RATIO = 1.15
MICRO_CPU_WALL_SLACK_SEC = 0.02
MODULE_MIN_CPU_FRAC = 0.4
MODULE_MAX_CPU_WALL_RATIO = 1.5
MODULE_CPU_WALL_SLACK_SEC = 0.005
# Frozen provisional yardstick scale (provisional local qBase; final GCE
# recalibration re-freezes it): a candidate identical to the trusted baseline
# scores this value by construction, independent of host drift, because the
# reported score is raw_q * REFERENCE_NORMALIZATION / reference_q with the
# reference measured from a pristine in-eval build of the trusted baseline.
REFERENCE_NORMALIZATION = 7385110.981771862
SOURCE_REVISION = "04be246001599f5995fa2f2d8c91a0f198d3f34c"
TEST262_REVISION = "5c8206929d81b2d3d727ca6aac56c18358c8d790"

# Source reference only; the original executable terminal bundle stays private.
def _withheld_terminal_input(name):
    raise RuntimeError(f"Private terminal input withheld: {name}; use the original capsule bundle")

EXPECTED_BENCHMARKS = _withheld_terminal_input('EXPECTED_BENCHMARKS')
ALLOWED_MUTABLE_FILES = frozenset(
    {
        "cutils.c",
        "cutils.h",
        "dtoa.c",
        "dtoa.h",
        "libregexp-opcode.h",
        "libregexp.c",
        "libregexp.h",
        "libunicode-table.h",
        "libunicode.c",
        "libunicode.h",
        "list.h",
        "quickjs-atom.h",
        "quickjs-opcode.h",
        "quickjs.c",
        "quickjs.h",
    }
)
METADATA_FIELDS = frozenset(
    {
        "baselineBinaryBytes",
        "binarySizeToleranceDenominator",
        "binarySizeToleranceNumerator",
        "files",
        "microbenchmarks",
        "microbenchScriptSha256",
        "moduleExpected",
        "moduleLaunchesPerRound",
        "moduleRounds",
        "observableExpected",
        "schemaVersion",
        "sourceRevision",
        "split",
        "test262Cases",
        "test262Revision",
    }
)
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def emit_failure(detail: str, result_hash: str = "") -> None:
    safe_detail = detail
    for secret_path in (ASSETS, BUILD_ROOT):
        safe_detail = safe_detail.replace(str(secret_path), "<sealed>")
    safe_detail = safe_detail[:1000]
    output = {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": {
            "tests_pass": False,
            "exact_outputs_pass": False,
            "binary_size_pass": False,
        },
        "perExample": {"aggregate": {"score": 0.0, "feedback": safe_detail}},
        "diagnostics": {
            "summary": safe_detail,
            "quality": 0.0,
            "result_hash": result_hash or sha256_bytes(safe_detail.encode()),
        },
    }
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


def demote() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (1536 << 20, 1536 << 20))
    if os.geteuid() == 0:
        # Fresh IPC namespace per launch, taken while still root (CAP_SYS_ADMIN
        # is required and is dropped by the setuid below). Fail CLOSED: a launch
        # that cannot get an isolated IPC namespace must not run at all.
        if _LIBC.unshare(CLONE_NEWIPC) != 0:
            raise OSError(ctypes.get_errno(), "unshare(CLONE_NEWIPC) failed")
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


def fixed_environment() -> dict[str, str]:
    environment = os.environ.copy()
    environment.update({"LC_ALL": "C.UTF-8", "LANG": "C.UTF-8", "TZ": "UTC"})
    return environment


def candidate_environment() -> dict[str, str]:
    """Environment for a candidate launch pinned to a fresh private scratch dir
    so temp files never leak into the next launch or into shared /tmp."""
    environment = fixed_environment()
    scratch = str(LAUNCH_SCRATCH)
    environment.update({"TMPDIR": scratch, "TMP": scratch, "TEMP": scratch, "HOME": scratch})
    return environment


def reap_candidate_processes() -> None:
    """SIGKILL any surviving unprivileged (candidate/helper) processes so a
    launch cannot outlive its wall clock or carry state into the next launch."""
    self_pid = os.getpid()
    try:
        pids = [name for name in os.listdir("/proc") if name.isdigit()]
    except OSError:
        return
    for pid in pids:
        if int(pid) == self_pid:
            continue
        real_uid: int | None = None
        try:
            with open(f"/proc/{pid}/status", "r", encoding="ascii", errors="replace") as handle:
                for line in handle:
                    if line.startswith("Uid:"):
                        real_uid = int(line.split()[1])
                        break
        except (OSError, ValueError):
            continue
        if real_uid == SANDBOX_UID:
            try:
                os.kill(int(pid), signal.SIGKILL)
            except OSError:
                pass


def reset_candidate_state() -> None:
    """Hand the next launch a pristine writable environment. Every scored and
    unscored candidate launch is a fresh subprocess, but its writable state is
    not reset by the broker between launches; without this a candidate could
    stash a record (e.g. keyed by module source) during an unscored invocation
    and replay it on every timed launch instead of parsing/executing the
    module. Clear every candidate-writable location and reap surviving helpers
    before each launch. Writable locations in the eval container: the shared
    16 MiB /tmp and /dev/shm tmpfs, and the mode-1777 trusted build tmpfs
    mounted at BUILD_ROOT (a candidate could write beside the sealed source),
    so BUILD_ROOT is swept too — keeping only the sealed source tree and the
    fresh private launch scratch."""
    reap_candidate_processes()
    keep: dict[Path, set[str]] = {
        Path("/tmp"): {BUILD_ROOT.name},
        Path("/dev/shm"): set(),
        BUILD_ROOT: {SOURCE.name, LAUNCH_SCRATCH.name, REF_SOURCE.name, REF_WORKSPACE.name},
    }
    for root, keep_names in keep.items():
        try:
            entries = list(root.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.name in keep_names:
                continue
            try:
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    entry.unlink()
            except OSError:
                pass
    if LAUNCH_SCRATCH.exists():
        shutil.rmtree(LAUNCH_SCRATCH, ignore_errors=True)
    LAUNCH_SCRATCH.mkdir(parents=True, exist_ok=True)
    os.chmod(LAUNCH_SCRATCH, 0o1777)


def run_worker(action: str, *paths: Path) -> dict[str, object]:
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
            env=fixed_environment(),
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


def run_candidate(
    argv: list[str], timeout: float = 10.0, stdin_bytes: bytes | None = None
) -> subprocess.CompletedProcess[bytes]:
    # subprocess.run forbids passing both stdin= and input=; when a streamed job
    # is supplied, hand it via input= (which opens the stdin pipe itself),
    # otherwise close stdin with DEVNULL.
    stream_kwargs: dict[str, object] = (
        {"stdin": subprocess.DEVNULL} if stdin_bytes is None else {"input": stdin_bytes}
    )
    try:
        return subprocess.run(
            argv,
            cwd=SOURCE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            preexec_fn=demote,
            env=candidate_environment(),
            start_new_session=True,
            **stream_kwargs,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateFailure(f"candidate process failed: {exc}") from exc


def mount_build_tmpfs() -> None:
    BUILD_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "tmpfs", "-o", "size=768m,mode=1777,exec,nosuid,nodev", "hone-quickjs-build", str(BUILD_ROOT)],
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


def check_source_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    try:
        inventory = json.loads((TRUSTED_DIR / "source-files.json").read_text())
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise GateFailure("protected source inventory is malformed") from exc
    if (
        not isinstance(inventory, dict)
        or set(inventory) != {"schemaVersion", "files"}
        or inventory.get("schemaVersion") != 1
        or not isinstance(inventory.get("files"), list)
        or not all(isinstance(path, str) for path in inventory["files"])
        or len(set(inventory["files"])) != len(inventory["files"])
    ):
        raise GateFailure("protected source inventory is invalid")
    trusted_paths = set(inventory["files"])
    for path in WORKSPACE.rglob("*"):
        relative = path.relative_to(WORKSPACE).as_posix()
        if path.is_symlink():
            raise GateFailure(f"symbolic link is forbidden: {relative}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise GateFailure(f"non-regular workspace entry is forbidden: {relative}")
        if relative not in trusted_paths and relative not in ALLOWED_MUTABLE_FILES:
            raise GateFailure(f"file outside mutable source envelope: {relative}")


def validate_hex_digest(value: object, label: str) -> str:
    if not isinstance(value, str) or HEX64.fullmatch(value) is None:
        raise GateFailure(f"invalid sealed digest for {label}")
    return value


def load_workload() -> tuple[dict[str, object], Path, str]:
    metadata_files = sorted(ASSETS.rglob("workload.json"))
    if len(metadata_files) != 1:
        raise GateFailure("selected asset split must contain exactly one workload.json")
    metadata_path = metadata_files[0]
    try:
        raw = metadata_path.read_bytes()
        metadata = json.loads(raw)
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        raise GateFailure("sealed workload metadata is malformed") from exc
    if not isinstance(metadata, dict) or frozenset(metadata) != METADATA_FIELDS:
        raise GateFailure("sealed workload metadata has invalid fields")
    split = metadata.get("split")
    if split not in EXPECTED_BENCHMARKS:
        raise GateFailure("sealed workload split is invalid")
    if metadata.get("schemaVersion") != 1 or metadata.get("sourceRevision") != SOURCE_REVISION:
        raise GateFailure("sealed source identity is invalid")
    if metadata.get("test262Revision") != TEST262_REVISION:
        raise GateFailure("sealed Test262 identity is invalid")
    rows = metadata.get("microbenchmarks")
    if not isinstance(rows, list) or len(rows) != len(EXPECTED_BENCHMARKS[split]):
        raise GateFailure("sealed microbenchmark list is invalid")
    frozen_rows: list[tuple[object, object, object]] = []
    for row in rows:
        # The timed microbenchmark output is no longer a sealed closed-form
        # constant: truth for each randomized job is captured from the pristine
        # in-eval reference build, so the sealed row only pins the benchmark
        # identity and its base schedule (the per-evaluation iteration count is
        # jittered up from this base at run time).
        if not isinstance(row, dict) or set(row) != {"iterations", "name", "operations"}:
            raise GateFailure("sealed microbenchmark row is invalid")
        frozen_rows.append((row.get("name"), row.get("iterations"), row.get("operations")))
    if tuple(frozen_rows) != EXPECTED_BENCHMARKS[split]:
        raise GateFailure("sealed microbenchmark schedule is invalid")
    if metadata.get("moduleLaunchesPerRound") != 31 or metadata.get("moduleRounds") != 3:
        raise GateFailure("sealed module-startup schedule is invalid")
    if metadata.get("baselineBinaryBytes") != 1_051_952:
        raise GateFailure("sealed baseline binary size is invalid")
    if metadata.get("binarySizeToleranceNumerator") != 101 or metadata.get("binarySizeToleranceDenominator") != 100:
        raise GateFailure("sealed binary-size tolerance is invalid")
    for key in ("observableExpected", "moduleExpected"):
        value = metadata.get(key)
        if not isinstance(value, str) or not value.endswith("\n") or len(value.encode()) > 4096:
            raise GateFailure(f"sealed {key} is invalid")

    files = metadata.get("files")
    if not isinstance(files, dict) or not files:
        raise GateFailure("sealed file inventory is invalid")
    split_dir = metadata_path.parent
    actual_files = {
        path.relative_to(split_dir).as_posix()
        for path in split_dir.rglob("*")
        if path.is_file() and path != metadata_path
    }
    if set(files) != actual_files:
        raise GateFailure("sealed file inventory does not match selected assets")
    for relative, expected_hash in files.items():
        if not isinstance(relative, str) or relative.startswith(("/", "../")) or "/../" in relative:
            raise GateFailure("sealed file path is invalid")
        digest = validate_hex_digest(expected_hash, relative)
        try:
            contents = (split_dir / relative).read_bytes()
        except OSError as exc:
            raise GateFailure("sealed workload file is missing") from exc
        if sha256_bytes(contents) != digest:
            raise GateFailure("sealed workload hash mismatch")

    cases = metadata.get("test262Cases")
    if not isinstance(cases, list) or len(cases) != 6 or len(set(cases)) != 6 or not all(isinstance(case, str) for case in cases):
        raise GateFailure("sealed Test262 case list is invalid")
    actual_cases = sorted(
        path.relative_to(split_dir / "test262").as_posix()
        for path in (split_dir / "test262" / "test").rglob("*.js")
    )
    if sorted(cases) != actual_cases:
        raise GateFailure("sealed Test262 case list does not match frozen files")
    script_digest = validate_hex_digest(metadata.get("microbenchScriptSha256"), "microbench script")
    if sha256_bytes((TRUSTED_DIR / "tests" / "microbench.js").read_bytes()) != script_digest:
        raise GateFailure("protected upstream microbenchmark script hash mismatch")
    return metadata, split_dir, sha256_bytes(raw)


def copy_candidate() -> None:
    run_worker("prepare", WORKSPACE, SOURCE)


def prepare_reference() -> None:
    # Reference yardstick: a pristine build of the trusted baseline, prepared
    # and benchmarked inside the SAME evaluation so host frequency/contention
    # drift between evaluations cancels out of the reported score. The
    # candidate workspace never touches this tree: prepare() seeds from the
    # trusted baseline and overlays mutable files from an EMPTY workspace.
    REF_WORKSPACE.mkdir(mode=0o755)
    run_worker("prepare", REF_WORKSPACE, REF_SOURCE)


def install_trusted_workload(split_dir: Path) -> None:
    shutil.copy2(TRUSTED_DIR / "tests" / "microbench.js", SOURCE / "tests" / "microbench.js")
    shutil.copy2(TRUSTED_DIR / "test262.conf", SOURCE / "test262.conf")
    shutil.copy2(TRUSTED_DIR / "test262_errors.txt", SOURCE / "test262_errors.txt")
    WORKLOAD_DIR.mkdir(mode=0o755)
    for filename in ("benchmark.js", "observable.js", "module-main.js", "module-lib.js"):
        shutil.copy2(split_dir / filename, WORKLOAD_DIR / filename)
    shutil.copytree(split_dir / "test262", SOURCE / "test262", symlinks=False)


def seal_built_tree(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_symlink():
            raise GateFailure("build produced a forbidden symbolic link")
        if not path.is_dir() and not path.is_file():
            raise GateFailure("build produced a non-regular entry")
    unsealed = BUILD_ROOT / f"unsealed-{root.name}"
    root.rename(unsealed)
    shutil.copytree(unsealed, root, symlinks=False)
    shutil.rmtree(unsealed)
    for path in root.rglob("*"):
        if path.is_dir():
            path.chmod(0o555)
        else:
            path.chmod(0o555 if os.access(path, os.X_OK) else 0o444)
    root.chmod(0o555)


# ---------------------------------------------------------------------------
# Trusted per-case Test262 boundary.
#
# run-test262 links the candidate-mutable quickjs.c, so EVERYTHING that
# process emits (per-case report lines, the Result summary, its exit status)
# is candidate-influenced: a build-time seam (e.g. a constructor in the
# mutable objects) can print six passing lines and exit 0 without executing a
# single case. The worker's run-test262 gate is therefore kept only as
# defense-in-depth; the AUTHORITATIVE gate below is driven entirely by this
# trusted parent: it composes one root-owned read-only driver per frozen case
# (a trusted instrumentation prologue + harness + an assertion wrapper + the
# case + a freshly randomized receipt program). The instrumentation seeds a
# global accumulator and wraps every assertion so each per-case assertion
# EVENT folds the case's real computed values into it; the receipt folds that
# accumulator into its printed value. The expected receipt is CAPTURED from
# the pristine in-eval reference build (a sealed copy of the trusted baseline,
# never candidate-linked), and the candidate qjs must reproduce it byte for
# byte with empty stderr and exit 0. Because the receipt value now depends on
# the accumulator, an engine that locates the HONE262 suffix and evaluates
# only the receipt -- skipping the Test262 source -- leaves the accumulator at
# its seed and prints a different value: passing REQUIRES the frozen case's
# assertions to have actually fired with their real values. The observation is
# thus bound to case execution across a boundary the candidate engine cannot
# bypass, and truth comes from the trusted reference, never from
# candidate-emitted bookkeeping.
# ---------------------------------------------------------------------------

T262_DRIVER_DIR = BUILD_ROOT / "hone-t262"
# Default harness, prepended in this order exactly like the Test262 runner
# contract (assert.js and sta.js are implicit includes of every case).
T262_BASE_HARNESS = ("assert.js", "sta.js")
# Frontmatter keys this trusted composer understands. Anything else (flags,
# negative, ...) would change execution semantics, so the gate fails CLOSED on
# it instead of guessing: the frozen six-case corpus uses none of those.
T262_KNOWN_KEYS = frozenset(
    {"author", "defines", "description", "es5id", "es6id", "esid", "features", "includes", "info"}
)
T262_KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*):")
T262_INCLUDES = re.compile(r"^includes:\s*\[([^\]]*)\]\s*$")
T262_HARNESS_NAME = re.compile(r"^[A-Za-z0-9_.-]+\.js$")
# Receipt arithmetic runs modulo this prime; every intermediate stays a safe
# integer (max ~2^31 * 2^20 < 2^53), so JS doubles and Python ints agree bit
# for bit.
T262_MODULUS = 2147483647
T262_STEPS = 24


def make_instrumentation(rng: random.SystemRandom) -> tuple[str, str]:
    """Trusted-composed instrumentation woven into each driver so the receipt
    value is BOUND to the frozen case actually executing. The prologue seeds a
    global accumulator; the wrapper (installed after assert.js has defined
    `assert`) folds every asserted value into that accumulator on each
    assertion EVENT the case fires. The receipt folds the accumulator into its
    printed value, so an engine that skips the Test262 source and evaluates
    only the HONE262 receipt leaves the accumulator at its seed and prints a
    different value than the reference build produced."""
    seed = rng.randrange(1, T262_MODULUS)
    prologue = (
        f"var __hone_acc = {seed};\n"
        "function __hone_fold(x) {\n"
        '  var s; try { s = String(x); } catch (e) { s = "?"; }\n'
        "  var h = 0;\n"
        f"  for (var i = 0; i < s.length; i++) {{ h = (h * 131 + s.charCodeAt(i)) % {T262_MODULUS}; }}\n"
        f"  __hone_acc = (__hone_acc * 1000003 + h + 1) % {T262_MODULUS};\n"
        "}"
    )
    wrapper = (
        "(function(){\n"
        "  function wrap(orig, tag) {\n"
        "    var w = function() {\n"
        "      __hone_fold(tag);\n"
        "      for (var i = 0; i < arguments.length; i++) __hone_fold(arguments[i]);\n"
        "      return orig.apply(this, arguments);\n"
        "    };\n"
        "    for (var k in orig) { if (Object.prototype.hasOwnProperty.call(orig, k)) w[k] = orig[k]; }\n"
        "    return w;\n"
        "  }\n"
        "  var base = assert;\n"
        '  var wrapped = wrap(base, "assert");\n'
        "  for (var k in base) {\n"
        '    if (Object.prototype.hasOwnProperty.call(base, k) && typeof base[k] === "function") {\n'
        '      wrapped[k] = wrap(base[k], "assert." + k);\n'
        "    }\n"
        "  }\n"
        "  assert = wrapped;\n"
        "})();"
    )
    return prologue, wrapper


def parse_case_includes(text: str, case: str) -> list[str]:
    start = text.find("/*---")
    end = text.find("---*/")
    if start < 0 or end <= start:
        raise GateFailure(f"Test262 case {case} lacks parseable metadata")
    includes: list[str] = []
    for line in text[start + 5 : end].splitlines():
        key_match = T262_KEY.match(line)
        if key_match is None:
            continue  # indented continuation of a block scalar
        key = key_match.group(1)
        if key not in T262_KNOWN_KEYS:
            raise GateFailure(f"Test262 case {case} uses unsupported metadata key: {key}")
        if key != "includes":
            continue
        include_match = T262_INCLUDES.match(line.strip())
        if include_match is None:
            raise GateFailure(f"Test262 case {case} has an unsupported includes form")
        for name in include_match.group(1).split(","):
            name = name.strip()
            if T262_HARNESS_NAME.fullmatch(name) is None:
                raise GateFailure(f"Test262 case {case} names an invalid harness include")
            includes.append(name)
    return includes


def make_receipt_program(rng: random.SystemRandom) -> str:
    """A fresh random JS program regenerated per case per evaluation, so its
    output cannot be baked into a candidate build or replayed from an earlier
    launch. It folds the assertion accumulator (see make_instrumentation) into
    its printed value, so the receipt cannot be reproduced without the frozen
    case's assertions having actually fired with their real values. The
    expected receipt is captured from the pristine reference build, never
    computed against candidate-emitted bookkeeping."""
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    nonce = "".join(rng.choice(alphabet) for _ in range(48))
    value = rng.randrange(1, T262_MODULUS)
    lines = [f'  var s = "{nonce}";', f"  var v = {value};"]
    for _ in range(T262_STEPS):
        kind = rng.randrange(3)
        if kind == 0:
            k = rng.randrange(3, 1 << 20)
            a = rng.randrange(T262_MODULUS)
            lines.append(f"  v = (v * {k} + {a}) % {T262_MODULUS};")
        elif kind == 1:
            i = rng.randrange(len(nonce))
            k = rng.randrange(3, 1 << 16)
            lines.append(f"  v = (v + s.charCodeAt({i}) * {k}) % {T262_MODULUS};")
        else:
            start = rng.randrange(len(nonce) - 9)
            stop = start + rng.randrange(2, 9)
            k = rng.randrange(3, 512)
            lines.append(
                f"  for (var i = {start}; i < {stop}; i++) v = (v * {k} + s.charCodeAt(i)) % {T262_MODULUS};"
            )
    lines.append(f'  v = (v + (typeof __hone_acc === "number" ? __hone_acc : -1)) % {T262_MODULUS};')
    lines.append('  var parts = v.toString(36).split("");')
    lines.append("  parts.reverse();")
    lines.append('  print("HONE262 " + parts.join("") + "-" + (v % 997));')
    program = ";(function(){\n" + "\n".join(lines) + "\n})();\n"
    return program


def capture_receipt_reference(binary: Path, driver: Path, label: str) -> bytes:
    """Run the pristine reference build and CAPTURE its receipt as the trusted
    expected output. The reference genuinely executes the case, so its
    accumulator reflects real assertion events; the candidate must reproduce
    this byte for byte. A malformed reference result is a trusted-composition
    bug (or a corrupt sealed tree), never candidate behavior, so it fails
    loudly instead of silently zeroing candidates."""
    completed = run_candidate([str(binary), str(driver)], timeout=30.0)
    expected = completed.stdout
    if (
        completed.returncode != 0
        or completed.stderr
        or not expected.startswith(b"HONE262 ")
        or not expected.endswith(b"\n")
    ):
        raise GateFailure(label)
    return expected


def run_receipt_driver(binary: Path, driver: Path, expected: bytes, label: str) -> None:
    completed = run_candidate([str(binary), str(driver)], timeout=30.0)
    if completed.returncode != 0 or completed.stderr or completed.stdout != expected:
        raise GateFailure(label)


def run_trusted_test262(metadata: dict[str, object]) -> None:
    cases = sorted(str(case) for case in metadata["test262Cases"])
    harness_dir = SOURCE / "test262" / "harness"
    rng = random.SystemRandom()
    for case in cases:
        case_path = SOURCE / "test262" / case
        if case_path.is_symlink() or not case_path.is_file():
            raise GateFailure(f"frozen Test262 case is missing from the sealed tree: {case}")
        case_text = case_path.read_text(encoding="utf-8")
        prologue, wrapper = make_instrumentation(rng)
        # Order matters: the seed prologue first, then the full harness (which
        # defines `assert`), then the assertion wrapper (which rebinds it), then
        # the case, then the receipt. Only after this does an assertion event
        # fold into the accumulator the receipt reads.
        pieces: list[str] = [prologue]
        for name in (*T262_BASE_HARNESS, *parse_case_includes(case_text, case)):
            harness_path = harness_dir / name
            if harness_path.is_symlink() or not harness_path.is_file():
                raise GateFailure(f"Test262 harness include is missing: {name}")
            pieces.append(harness_path.read_text(encoding="utf-8"))
        pieces.append(wrapper)
        # Sloppy mode, matching the frozen run-test262 configuration
        # (mode=default -> nostrict; no frozen case is onlyStrict).
        pieces.append(case_text)
        pieces.append(make_receipt_program(rng))
        # Fresh writable state (and a fresh IPC namespace inside run_candidate)
        # per case; the driver lives in a root-owned directory the demoted
        # candidate cannot write, created AFTER the reset that sweeps
        # BUILD_ROOT, and is swept again by the next reset.
        reset_candidate_state()
        T262_DRIVER_DIR.mkdir(mode=0o755)
        driver = T262_DRIVER_DIR / "driver.js"
        driver.write_text("\n".join(pieces), encoding="utf-8")
        driver.chmod(0o444)
        # Expected receipt = whatever the pristine reference build produces for
        # this driver (it truly runs the case, so its accumulator is authentic).
        expected = capture_receipt_reference(
            REF_SOURCE / "qjs", driver, f"trusted Test262 driver self-check failed: {case}"
        )
        run_receipt_driver(
            SOURCE / "qjs", driver, expected, f"trusted Test262 gate failed: {case}"
        )


def require_exact_output(script: Path, expected: str, module: bool = False) -> bytes:
    reset_candidate_state()
    argv = [str(SOURCE / "qjs")]
    if module:
        argv.append("-m")
    argv.append(str(script))
    completed = run_candidate(argv)
    expected_bytes = expected.encode()
    if completed.returncode != 0 or completed.stderr or completed.stdout != expected_bytes:
        raise GateFailure("exact observable-output gate failed")
    return completed.stdout


def timed_gated_run(argv: list[str], expected_bytes: bytes, timeout: float, label: str) -> tuple[float, float]:
    """One trusted-timed, output-gated launch from a pristine writable state.
    Returns (wall seconds, CPU seconds); the CPU time is measured OUT OF
    PROCESS by the trusted parent from the kernel's reaped-child accounting
    (a getrusage(RUSAGE_CHILDREN) delta bracketing this single serial launch
    -- the wait4 channel), never from anything candidate-emitted."""
    reset_candidate_state()
    usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic_ns()
    completed = run_candidate(argv, timeout=timeout)
    elapsed = (time.monotonic_ns() - started) / 1_000_000_000.0
    usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = (usage_after.ru_utime - usage_before.ru_utime) + (usage_after.ru_stime - usage_before.ru_stime)
    if completed.returncode != 0 or completed.stderr or completed.stdout != expected_bytes:
        raise GateFailure(f"{label} exact-output gate failed")
    if not math.isfinite(elapsed) or elapsed <= 0 or not math.isfinite(cpu) or cpu < 0:
        raise GateFailure(f"trusted {label} timer failed")
    return elapsed, cpu


# Alphabets for the streamed regexp jobs. The UTF-16 alphabet carries code
# points above U+00FF so regexp_utf16 jobs force the interpreter's wide string
# and regexp paths, matching the upstream selection intent.
MICRO_ASCII_ALPHABET = _withheld_terminal_input('MICRO_ASCII_ALPHABET')
MICRO_UTF16_ALPHABET = _withheld_terminal_input('MICRO_UTF16_ALPHABET')


def timed_stream_run(
    binary: Path, script: Path, job_bytes: bytes, timeout: float, label: str
) -> tuple[float, float, bytes]:
    """One trusted-timed streamed launch from a pristine writable state. The
    randomized job -- including the trusted-composed benchmark program itself
    -- is delivered on stdin at clock-start (never argv/env), so no correct
    fold can be produced in the untimed window; the caller validates the
    returned fold against the pristine reference run on the identical job.
    The returned CPU time is measured OUT OF PROCESS by the trusted parent
    from the kernel's reaped-child accounting (a getrusage(RUSAGE_CHILDREN)
    delta bracketing this single serial launch -- the wait4 channel); nothing
    candidate-emitted contributes to it."""
    reset_candidate_state()
    argv = [str(binary), "--std", str(script)]
    usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic_ns()
    completed = run_candidate(argv, timeout=timeout, stdin_bytes=job_bytes)
    elapsed = (time.monotonic_ns() - started) / 1_000_000_000.0
    usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = (usage_after.ru_utime - usage_before.ru_utime) + (usage_after.ru_stime - usage_before.ru_stime)
    if completed.returncode != 0 or completed.stderr or not completed.stdout:
        raise GateFailure(f"{label} streamed run failed")
    if not math.isfinite(elapsed) or elapsed <= 0 or not math.isfinite(cpu) or cpu < 0:
        raise GateFailure(f"trusted {label} timer failed")
    return elapsed, cpu, completed.stdout


def make_micro_params(name: str, ops_factor: int, rng: random.SystemRandom):
    return _withheld_terminal_input("microbenchmark input factory")


# ---------------------------------------------------------------------------
# Trusted per-sample benchmark program composition.
#
# Round-6: the timed fold used to be computed by a FIXED public script (only
# its data, nonce, and iteration count varied), so the scored recurrence was
# a public closed form; a candidate build could recognize the sealed loop (by
# script content or bytecode shape) and stand in a precompiled native
# equivalent, then coast into the wall-clock plausibility band. Now the
# trusted parent composes the whole benchmark PROGRAM per timed sample --
# fresh identifiers, object shapes with shuffled insertion order and decoy
# properties, permuted read/update schedules and dependency graphs,
# randomized loop directions, index strides, fold expression shapes, and
# constants -- and streams it on stdin at clock-start. No fixed loop exists
# to pattern-match and nothing structural is visible in the untimed window
# (candidate-writable state is swept between launches, so no launch can
# record a program for a later one), so reproducing the pristine reference's
# fold requires evaluating an arbitrary member of this program family:
# exactly the interpreter work being scored. Every family member preserves
# the sealed benchmark identity -- the same scored per-iteration operation
# count and workload class, with every variant emitting the same operation
# mix (only names, constants, order, direction, and equal-cost expression
# shapes vary) -- so operations accounting and min-of-N comparability are
# unchanged, and every iteration still executes at least one float64-range %
# so the sealed control classes keep their signal.
# ---------------------------------------------------------------------------

JS_RESERVED_WORDS = frozenset(
    {
        "arguments", "async", "await", "break", "case", "catch", "class",
        "const", "continue", "debugger", "default", "delete", "do", "else",
        "enum", "eval", "export", "extends", "false", "finally", "for",
        "function", "get", "globalthis", "if", "import", "in", "instanceof",
        "interface", "let", "new", "null", "of", "package", "private",
        "protected", "public", "return", "set", "static", "super", "switch",
        "this", "throw", "true", "try", "typeof", "undefined", "var", "void",
        "while", "with", "yield",
    }
)


def make_js_ident(rng: random.SystemRandom, used: set[str]) -> str:
    while True:
        name = "".join(rng.choice(MICRO_ASCII_ALPHABET) for _ in range(rng.randrange(3, 9)))
        if name not in JS_RESERVED_WORDS and name not in used:
            used.add(name)
            return name


def make_fold_stmt(rng: random.SystemRandom, fold_var: str, value_expr: str) -> str:
    """One nonce-seeded fold step. Both shapes carry the same operation mix
    (one multiply, adds, one % whose left operand always leaves int32 range,
    keeping the float64 remainder path hot on every iteration); value_expr
    must evaluate inside [0, T262_MODULUS) so every intermediate stays an
    exact safe integer."""
    k1 = rng.randrange(1 << 10, 1 << 19)
    k2 = rng.randrange(1, T262_MODULUS)
    if rng.randrange(2) == 0:
        return f"{fold_var} = ({fold_var} * {k1} + {value_expr} + {k2}) % {T262_MODULUS};"
    return f"{fold_var} = (({fold_var} + {value_expr}) * {k1} + {k2}) % {T262_MODULUS};"


def make_loop_header(
    rng: random.SystemRandom, kw: str, var: str, count: str, index_safe: bool = False
) -> str:
    """Ascending or descending counted loop over `count` iterations.
    index_safe requests the zero-based descending form for loops whose
    variable indexes an array."""
    if rng.randrange(2) == 0:
        return f"for ({kw} {var} = 0; {var} < {count}; {var}++)"
    if index_safe:
        return f"for ({kw} {var} = {count} - 1; {var} >= 0; {var}--)"
    return f"for ({kw} {var} = {count}; {var} > 0; {var}--)"


def _program_prop(name: str, rng: random.SystemRandom) -> str:
    used: set[str] = set()
    kw = rng.choice(("var", "let"))
    n_v, s_v, p_v, f_v, o_v, a_v, j_v = (make_js_ident(rng, used) for _ in range(7))
    keys = [make_js_ident(rng, used) for _ in range(4)]
    entries = [(key, f"{p_v}.{source}") for key, source in zip(keys, ("a", "b", "c", "d"))]
    entries += [(make_js_ident(rng, used), str(rng.randrange(1, 8191))) for _ in range(rng.randrange(4))]
    rng.shuffle(entries)
    literal = ", ".join(f"{key}: {value}" for key, value in entries)
    order = keys[:]
    rng.shuffle(order)
    lines = [
        f"(function({n_v}, {s_v}, {p_v}) {{",
        f"  {kw} {f_v} = {s_v} % {T262_MODULUS};",
        f"  {kw} {o_v} = {{ {literal} }};",
    ]
    if name == "prop_read":
        lines.append(f"  {kw} {a_v} = 0;")
        read_expr = " + ".join(f"{o_v}.{key} * {rng.randrange(1, 8)}" for key in order)
        target = rng.choice(keys)
        mutate = (
            f"    {o_v}.{target} = ({o_v}.{target} * {rng.choice((3, 5, 7, 11, 13))}"
            f" + {rng.randrange(1, 8191)}) % 8191;"
        )
        fold = "    " + make_fold_stmt(rng, f_v, a_v)
        body = [f"    {a_v} = ({a_v} + {read_expr}) % {T262_MODULUS};"]
        body += [fold, mutate] if rng.randrange(2) == 0 else [mutate, fold]
    else:
        body = []
        for key in order:
            source = rng.choice(keys)
            body.append(
                f"    {o_v}.{key} = ({o_v}.{source} + {j_v} * {rng.randrange(1, 6)}"
                f" + {rng.randrange(1, 98)}) % {T262_MODULUS};"
            )
        total = " + ".join(f"{o_v}.{key}" for key in keys)
        body.append("    " + make_fold_stmt(rng, f_v, f"({total}) % {T262_MODULUS}"))
    lines.append(f"  {make_loop_header(rng, kw, j_v, n_v)} {{")
    lines += body
    lines.append("  }")
    lines.append(f"  return {{ operations: {n_v} * 4, fold: {f_v} }};")
    lines.append("})")
    return "\n".join(lines)


def _program_array(name: str, ops_factor: int, rng: random.SystemRandom) -> str:
    used: set[str] = set()
    kw = rng.choice(("var", "let"))
    n_v, s_v, p_v, f_v, t_v, a_v, j_v, i_v, sum_v, k_v = (make_js_ident(rng, used) for _ in range(10))
    length = ops_factor
    mult = rng.choice((3, 5, 7, 11, 13))
    add = rng.randrange(1, 8191)
    lines = [
        f"(function({n_v}, {s_v}, {p_v}) {{",
        f"  {kw} {f_v} = {s_v} % {T262_MODULUS};",
    ]
    if name == "typed_array_read":
        lines.append(f"  {kw} {t_v} = new Int32Array({length});")
        lines.append(
            f"  for ({kw} {i_v} = 0; {i_v} < {length}; {i_v}++) {t_v}[{i_v}] = {p_v}.tab[{i_v}] | 0;"
        )
        clamp = "& 0x3fffffff" if rng.randrange(2) == 0 else "% 8191"
    else:
        lines.append(f"  {kw} {t_v} = {p_v}.tab.slice();")
        clamp = "% 8191"
    lines.append(f"  {kw} {a_v} = 0;")
    term = f"{t_v}[{i_v}] * {rng.randrange(1, 4)} + {rng.randrange(0, 8)}"
    inner = make_loop_header(rng, kw, i_v, str(length), index_safe=True)
    lines.append(f"  {make_loop_header(rng, kw, j_v, n_v)} {{")
    lines.append(f"    {kw} {sum_v} = 0;")
    lines.append(f"    {inner} {sum_v} += {term};")
    lines.append(f"    {a_v} = ({a_v} + {sum_v} % {T262_MODULUS}) % {T262_MODULUS};")
    lines.append("    " + make_fold_stmt(rng, f_v, a_v))
    lines.append(f"    {kw} {k_v} = ({j_v} * {rng.choice((1, 3, 5, 7))} + {rng.randrange(length)}) % {length};")
    lines.append(f"    {t_v}[{k_v}] = ({t_v}[{k_v}] * {mult} + {add}) {clamp};")
    lines.append("  }")
    lines.append(f"  return {{ operations: {n_v} * {length}, fold: {f_v} }};")
    lines.append("})")
    return "\n".join(lines)


def _program_int_arith(ops_factor: int, rng: random.SystemRandom) -> str:
    used: set[str] = set()
    kw = rng.choice(("var", "let"))
    n_v, s_v, p_v, f_v, seed_v, j_v, i_v, sum_v = (make_js_ident(rng, used) for _ in range(8))
    c1 = rng.randrange(32)
    m2 = rng.randrange(1 << 10, 1 << 19)
    c2 = rng.randrange(1, T262_MODULUS)
    inner = make_loop_header(rng, kw, i_v, str(ops_factor))
    lines = [
        f"(function({n_v}, {s_v}, {p_v}) {{",
        f"  {kw} {f_v} = {s_v} % {T262_MODULUS};",
        f"  {kw} {seed_v} = {p_v}.seed % {T262_MODULUS};",
        f"  {make_loop_header(rng, kw, j_v, n_v)} {{",
        f"    {kw} {sum_v} = 0;",
        f"    {inner} {sum_v} = ({sum_v} + ({i_v} + {c1}) * {seed_v}) % {T262_MODULUS};",
        "    " + make_fold_stmt(rng, f_v, sum_v),
        f"    {seed_v} = ({seed_v} * {m2} + {c2}) % {T262_MODULUS};",
        "  }",
        f"  return {{ operations: {n_v} * {ops_factor}, fold: {f_v} }};",
        "})",
    ]
    return "\n".join(lines)


def _program_float_arith(ops_factor: int, rng: random.SystemRandom) -> str:
    used: set[str] = set()
    kw = rng.choice(("var", "let"))
    n_v, s_v, p_v, f_v, a_v, j_v, i_v, sum_v = (make_js_ident(rng, used) for _ in range(8))
    jstep = f"{rng.randrange(1, 10)}e-4"
    cf = rng.choice(("0.25", "0.5", "1.5", "2.5"))
    round_fn = rng.choice(("Math.round", "Math.floor"))
    inner = make_loop_header(rng, kw, i_v, str(ops_factor))
    lines = [
        f"(function({n_v}, {s_v}, {p_v}) {{",
        f"  {kw} {f_v} = {s_v} % {T262_MODULUS};",
        f"  {make_loop_header(rng, kw, j_v, n_v)} {{",
        f"    {kw} {sum_v} = 0.0;",
        f"    {kw} {a_v} = {p_v}.a0 + {j_v} * {jstep};",
        f"    {inner} {{ {sum_v} += {a_v} * {a_v} + {cf}; {a_v} += {p_v}.incr; }}",
        "    " + make_fold_stmt(rng, f_v, f"({round_fn}({sum_v}) % {T262_MODULUS})"),
        "  }",
        f"  return {{ operations: {n_v} * {ops_factor}, fold: {f_v} }};",
        "})",
    ]
    return "\n".join(lines)


def _program_regexp(ops_factor: int, rng: random.SystemRandom) -> str:
    used: set[str] = set()
    kw = rng.choice(("var", "let"))
    n_v, s_v, p_v, f_v, r_v, st_v, j_v, i_v, v_v, m_v = (make_js_ident(rng, used) for _ in range(10))
    sc = rng.choice((1, 3, 5, 7))
    cm = rng.randrange(1, 6)
    c0 = rng.randrange(1, 98)
    c1 = rng.randrange(1, 98)
    inner = make_loop_header(rng, kw, i_v, str(ops_factor))
    lines = [
        f"(function({n_v}, {s_v}, {p_v}) {{",
        f"  {kw} {f_v} = {s_v} % {T262_MODULUS};",
        f"  {kw} {r_v} = new RegExp({p_v}.pattern);",
        f"  {kw} {st_v} = {p_v}.strings;",
        f"  {make_loop_header(rng, kw, j_v, n_v)} {{",
        f"    {kw} {v_v} = 0;",
        f"    {inner} {{",
        f"      {kw} {m_v} = {r_v}.exec({st_v}[({j_v} * {sc} + {i_v}) % {st_v}.length]);",
        f"      {v_v} = ({v_v} + ({m_v} ? {m_v}.index * {cm} + {m_v}[0].length + {c0} : {c1})) % {T262_MODULUS};",
        "    }",
        "    " + make_fold_stmt(rng, f_v, v_v),
        "  }",
        f"  return {{ operations: {n_v} * {ops_factor}, fold: {f_v} }};",
        "})",
    ]
    return "\n".join(lines)


def make_micro_program(name: str, ops_factor: int, rng: random.SystemRandom) -> str:
    if name in ("prop_read", "prop_update"):
        return _program_prop(name, rng)
    if name in ("array_read", "typed_array_read"):
        return _program_array(name, ops_factor, rng)
    if name == "int_arith":
        return _program_int_arith(ops_factor, rng)
    if name == "float_arith":
        return _program_float_arith(ops_factor, rng)
    if name in ("regexp_ascii", "regexp_utf16"):
        return _program_regexp(ops_factor, rng)
    raise GateFailure("unknown microbenchmark name")


def check_reference_result(ref_out: bytes, name: str, iterations: int, operations: int) -> None:
    """The pristine reference's printed result is the trusted truth for the
    candidate's fold, so a malformed or mis-accounted reference result is a
    trusted-composition bug (or a corrupt sealed tree), never candidate
    behavior: fail loudly instead of silently zeroing candidates."""
    try:
        payload = json.loads(ref_out)
    except (ValueError, UnicodeDecodeError) as exc:
        raise GateFailure("trusted microbenchmark composition self-check failed") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("name") != name
        or payload.get("iterations") != iterations
        or payload.get("operations") != operations
        or not isinstance(payload.get("fold"), int)
        or not 0 <= payload["fold"] < T262_MODULUS
    ):
        raise GateFailure("trusted microbenchmark composition self-check failed")


def make_micro_job(name: str, iterations: int, ops_factor: int, rng: random.SystemRandom) -> dict[str, object]:
    return {
        "name": name,
        "nonce": rng.randrange(1, T262_MODULUS),
        "iterations": iterations,
        "params": make_micro_params(name, ops_factor, rng),
        "program": make_micro_program(name, ops_factor, rng),
    }


def run_microbenchmarks(rows: object) -> tuple[list[float], list[float]]:
    if not isinstance(rows, list):
        raise GateFailure("sealed microbenchmark rows are invalid")
    validated: list[tuple[str, int, int]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise GateFailure("sealed microbenchmark row is invalid")
        name = row.get("name")
        iterations = row.get("iterations")
        operations = row.get("operations")
        if not isinstance(name, str) or not isinstance(iterations, int) or not isinstance(operations, int):
            raise GateFailure("sealed microbenchmark row has invalid values")
        if iterations <= 0 or operations <= 0 or operations % iterations != 0:
            raise GateFailure("sealed microbenchmark schedule is invalid")
        validated.append((name, iterations, operations))
    rng = random.SystemRandom()
    script = WORKLOAD_DIR / "benchmark.js"
    ref_binary = REF_SOURCE / "qjs"
    cand_binary = SOURCE / "qjs"
    # Per-evaluation randomized schedule: draw one jittered iteration count per
    # benchmark so this evaluation's operation counts are fixed across samples
    # (apples-to-apples timing) yet unknown before the evaluation begins.
    schedule: list[tuple[str, int, int, int]] = []  # name, iterations, operations, ops_factor
    for name, base_iters, base_ops in validated:
        ops_factor = base_ops // base_iters
        iters = base_iters + rng.randrange(base_iters // MICRO_ITER_JITTER_DIV + 1)
        schedule.append((name, iters, iters * ops_factor, ops_factor))
    # Interleaved round-robin: every candidate sample is bracketed by a pristine
    # in-eval reference sample of the SAME streamed job seconds apart, so both
    # see the same ambient host speed and the reference-normalized ratio cancels
    # cross-eval drift. Fastest-k-of-N trimming rejects transient co-scheduling
    # noise (which only ever ADDS wall time) without giving the candidate any
    # control over which samples count.
    candidate_elapsed: list[list[float]] = [[] for _ in schedule]
    reference_elapsed: list[list[float]] = [[] for _ in schedule]
    candidate_cpu: list[list[float]] = [[] for _ in schedule]
    reference_cpu: list[list[float]] = [[] for _ in schedule]
    for _ in range(MICRO_SAMPLES):
        for index, (name, iters, operations, ops_factor) in enumerate(schedule):
            # Fresh trusted-composed program + nonce + input data for THIS
            # sample, streamed on stdin at clock-start to both the pristine
            # reference and the candidate. The reference's fold is the trusted
            # truth; the candidate must reproduce it byte for byte on the
            # identical streamed job.
            job = make_micro_job(name, iters, ops_factor, rng)
            job_bytes = json.dumps(job, separators=(",", ":")).encode()
            ref_sec, ref_cpu_sec, ref_out = timed_stream_run(ref_binary, script, job_bytes, 120, "reference microbenchmark")
            check_reference_result(ref_out, name, iters, operations)
            cand_sec, cand_cpu_sec, cand_out = timed_stream_run(cand_binary, script, job_bytes, 120, "microbenchmark")
            if cand_out != ref_out:
                raise GateFailure("microbenchmark fold gate failed")
            # Single-threaded discipline on the out-of-process CPU signal:
            # EVERY candidate sample must satisfy it, so min-of-N trimming can
            # never hide a thread-parallel or CPU-inflating launch.
            if cand_cpu_sec > cand_sec * MICRO_MAX_CPU_WALL_RATIO + MICRO_CPU_WALL_SLACK_SEC:
                raise GateFailure("microbenchmark candidate CPU time exceeds the single-threaded envelope")
            reference_elapsed[index].append(ref_sec)
            candidate_elapsed[index].append(cand_sec)
            reference_cpu[index].append(ref_cpu_sec)
            candidate_cpu[index].append(cand_cpu_sec)
    candidate_throughputs: list[float] = []
    reference_throughputs: list[float] = []
    for index, ((name, iters, operations, ops_factor), cand, ref) in enumerate(
        zip(schedule, candidate_elapsed, reference_elapsed)
    ):
        cand_kept = statistics.fmean(sorted(cand)[:MICRO_KEEP])
        ref_kept = statistics.fmean(sorted(ref)[:MICRO_KEEP])
        # Per-operation plausibility floor: interpreting the identical streamed
        # loop cannot make the candidate implausibly faster than the pristine
        # reference; a kept time far below the reference means the fold was
        # produced without doing the interpreter's per-iteration work.
        if not math.isfinite(cand_kept) or not math.isfinite(ref_kept) or cand_kept <= 0 or ref_kept <= 0:
            raise GateFailure("microbenchmark timing is invalid")
        if cand_kept < ref_kept * MICRO_MIN_PLAUSIBLE_FRAC:
            raise GateFailure("microbenchmark per-operation cost is implausibly below reference")
        # Out-of-process work-proportional cross-check (see the constant
        # block): the kept-fastest candidate CPU time on the identical
        # streamed jobs must be a plausible fraction of the pristine
        # reference's. CPU time is contention-robust (co-scheduled load adds
        # wall time, not CPU time), so min-of-N is a clean estimate for both
        # legs.
        cand_cpu_kept = min(candidate_cpu[index])
        ref_cpu_kept = min(reference_cpu[index])
        if not math.isfinite(cand_cpu_kept) or not math.isfinite(ref_cpu_kept) or ref_cpu_kept <= 0:
            raise GateFailure("microbenchmark CPU measurement is invalid")
        if cand_cpu_kept < ref_cpu_kept * MICRO_MIN_CPU_FRAC:
            raise GateFailure("microbenchmark per-operation CPU work is implausibly below reference")
        candidate_throughputs.append(operations / cand_kept)
        reference_throughputs.append(operations / ref_kept)
    return candidate_throughputs, reference_throughputs


def measure_module_startup(expected: str, launches: int, rounds: int) -> tuple[float, float]:
    expected_bytes = expected.encode()
    module_path = WORKLOAD_DIR / "module-main.js"
    candidate_samples: list[float] = []
    reference_samples: list[float] = []
    candidate_cpu_sums: list[float] = []
    reference_cpu_sums: list[float] = []
    for _ in range(rounds):
        candidate_runs: list[tuple[float, float]] = []
        reference_runs: list[tuple[float, float]] = []
        for _ in range(launches):
            reference_runs.append(
                timed_gated_run([str(REF_SOURCE / "qjs"), "-m", str(module_path)], expected_bytes, 1.0, "reference module-startup")
            )
            cand_sec, cand_cpu = timed_gated_run(
                [str(SOURCE / "qjs"), "-m", str(module_path)], expected_bytes, 1.0, "module-startup"
            )
            # Single-threaded discipline per launch on the out-of-process CPU
            # signal (see the constant block).
            if cand_cpu > cand_sec * MODULE_MAX_CPU_WALL_RATIO + MODULE_CPU_WALL_SLACK_SEC:
                raise GateFailure("module-startup candidate CPU time exceeds the single-threaded envelope")
            candidate_runs.append((cand_sec, cand_cpu))
        # Same trimmed-sampling rationale as the microbenchmarks: every launch
        # is separately timed by the trusted parent and interleaved with a
        # pristine reference launch; keep the fastest windows of the sealed
        # 31-launch round so a transient host-contention burst cannot halve
        # the round's throughput. The kept-fastest CPU sums feed the startup
        # work floor below.
        for runs, samples, cpu_sums in (
            (candidate_runs, candidate_samples, candidate_cpu_sums),
            (reference_runs, reference_samples, reference_cpu_sums),
        ):
            kept = sorted(sec for sec, _ in runs)[:MODULE_KEEP]
            elapsed = sum(kept)
            if not math.isfinite(elapsed) or elapsed <= 0:
                raise GateFailure("module-startup timer failed")
            samples.append(len(kept) / elapsed)
            cpu_sums.append(sum(sorted(cpu for _, cpu in runs)[:MODULE_KEEP]))
    candidate_throughput = statistics.median(candidate_samples)
    reference_throughput = statistics.median(reference_samples)
    if not all(math.isfinite(value) and value > 0 for value in (candidate_throughput, reference_throughput)):
        raise GateFailure("module-startup throughput is invalid")
    # Out-of-process CPU floor on startup work: a candidate that emits the
    # fixed expected module output without doing interpreter startup work
    # (then exits or idles inside the wall-clock band) shows implausibly
    # little CPU per launch versus the pristine reference on identical work.
    candidate_cpu_med = statistics.median(candidate_cpu_sums)
    reference_cpu_med = statistics.median(reference_cpu_sums)
    if not math.isfinite(candidate_cpu_med) or not math.isfinite(reference_cpu_med) or reference_cpu_med <= 0:
        raise GateFailure("module-startup CPU measurement is invalid")
    if candidate_cpu_med < reference_cpu_med * MODULE_MIN_CPU_FRAC:
        raise GateFailure("module-startup CPU work is implausibly below reference")
    return candidate_throughput, reference_throughput


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
        metadata, split_dir, metadata_hash = load_workload()
        identity = {
            "metadataHash": metadata_hash,
            "sourceRevision": SOURCE_REVISION,
            "split": metadata["split"],
            "test262Revision": TEST262_REVISION,
        }
        result_hash = sha256_bytes(canonical(identity).encode())

        mount_build_tmpfs()
        mounted = True
        copy_candidate()
        prepare_reference()
        build_started = time.monotonic()
        run_worker("build")
        run_worker("build", REF_SOURCE)
        build_sec = time.monotonic() - build_started
        install_trusted_workload(split_dir)

        binary_bytes = (SOURCE / "qjs").stat().st_size
        baseline_bytes = int(metadata["baselineBinaryBytes"])
        if binary_bytes * int(metadata["binarySizeToleranceDenominator"]) > baseline_bytes * int(metadata["binarySizeToleranceNumerator"]):
            raise GateFailure("binary-size gate failed: stripped qjs exceeds baseline by more than 1%")

        seal_built_tree(SOURCE)
        seal_built_tree(REF_SOURCE)
        # Candidate-linked run-test262 first (defense-in-depth), then the
        # authoritative trusted parent-driven per-case receipt gate.
        run_worker("test")
        run_trusted_test262(metadata)
        observable = require_exact_output(
            WORKLOAD_DIR / "observable.js", str(metadata["observableExpected"])
        )
        module = require_exact_output(
            WORKLOAD_DIR / "module-main.js", str(metadata["moduleExpected"]), module=True
        )
        throughputs, reference_throughputs = run_microbenchmarks(metadata["microbenchmarks"])
        module_throughput, reference_module_throughput = measure_module_startup(
            str(metadata["moduleExpected"]),
            int(metadata["moduleLaunchesPerRound"]),
            int(metadata["moduleRounds"]),
        )
        throughputs.append(module_throughput)
        reference_throughputs.append(reference_module_throughput)
        raw_q = geometric_mean(throughputs)
        reference_q = geometric_mean(reference_throughputs)
        # Drift compensation: the trusted in-eval baseline yardstick divides
        # out host frequency/contention state shared by both measurements, so
        # the reported score is comparable across evaluations.
        score = raw_q * REFERENCE_NORMALIZATION / reference_q
        if not math.isfinite(score) or score <= 0:
            raise GateFailure("reference-normalized score is invalid")
        deterministic = {
            **identity,
            "binaryBytes": binary_bytes,
            "moduleOutput": sha256_bytes(module),
            "observableOutput": sha256_bytes(observable),
            "test262Cases": metadata["test262Cases"],
        }
        result_hash = sha256_bytes(canonical(deterministic).encode())
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "exact_outputs_pass": True,
                "binary_size_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": "valid reference-normalized geometric-mean throughput across four upstream interpreter microbenchmarks and module startup",
                }
            },
            "diagnostics": {
                "summary": "all correctness, output, Test262, and binary-size gates passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "binary_bytes": binary_bytes,
                "build_sec": build_sec,
                "eval_sec": time.monotonic() - started,
                "metric_count": len(throughputs),
                "raw_q": raw_q,
                "reference_q": reference_q,
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except GateFailure as exc:
        emit_failure(str(exc), result_hash)
    except Exception as exc:
        emit_failure(f"internal evaluator failure: {type(exc).__name__}: {exc}", result_hash)
    finally:
        if mounted:
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
