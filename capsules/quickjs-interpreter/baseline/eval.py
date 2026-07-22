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
# Fastest-k-of-N trimmed sampling (trusted-parent timing). Host contention
# only adds wall time and every sample is trusted-timed and output-gated, so
# keeping the fastest samples rejects transient co-scheduling noise without
# giving the candidate any control over which samples count.
MICRO_SAMPLES = 3
MICRO_KEEP = 2
MODULE_KEEP = 16
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


def run_candidate(argv: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            argv,
            cwd=SOURCE,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            preexec_fn=demote,
            env=candidate_environment(),
            start_new_session=True,
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
        if not isinstance(row, dict) or set(row) != {"expected", "iterations", "name", "operations"}:
            raise GateFailure("sealed microbenchmark row is invalid")
        expected = row.get("expected")
        if not isinstance(expected, str) or not expected.endswith("\n") or len(expected.encode()) > 4096:
            raise GateFailure("sealed microbenchmark output is invalid")
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
# (harness + case + a freshly randomized receipt program), computes the
# expected receipt independently in Python, and requires the candidate qjs to
# print exactly that receipt with an empty stderr and exit 0. The receipt
# statement is only reached after the case body completes without throwing,
# and its value cannot be produced without actually evaluating fresh random
# JavaScript, so a runtime that fabricates results instead of executing cases
# has no channel left: the per-case receipt is checked in the parent against
# parent-computed truth, never against candidate-emitted bookkeeping.
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


def base36(value: int) -> str:
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = []
    while value > 0:
        value, digit = divmod(value, 36)
        out.append(digits[digit])
    return "".join(reversed(out))


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


def make_receipt_program(rng: random.SystemRandom) -> tuple[str, bytes]:
    """A fresh random JS program plus its exact expected stdout. The program is
    regenerated per case per evaluation, so its output cannot be baked into a
    candidate build or replayed from any earlier launch; producing it requires
    evaluating the program."""
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
            value = (value * k + a) % T262_MODULUS
        elif kind == 1:
            i = rng.randrange(len(nonce))
            k = rng.randrange(3, 1 << 16)
            lines.append(f"  v = (v + s.charCodeAt({i}) * {k}) % {T262_MODULUS};")
            value = (value + ord(nonce[i]) * k) % T262_MODULUS
        else:
            start = rng.randrange(len(nonce) - 9)
            stop = start + rng.randrange(2, 9)
            k = rng.randrange(3, 512)
            lines.append(
                f"  for (var i = {start}; i < {stop}; i++) v = (v * {k} + s.charCodeAt(i)) % {T262_MODULUS};"
            )
            for ch in nonce[start:stop]:
                value = (value * k + ord(ch)) % T262_MODULUS
    lines.append('  var parts = v.toString(36).split("");')
    lines.append("  parts.reverse();")
    lines.append('  print("HONE262 " + parts.join("") + "-" + (v % 997));')
    program = ";(function(){\n" + "\n".join(lines) + "\n})();\n"
    expected = f"HONE262 {base36(value)[::-1]}-{value % 997}\n".encode()
    return program, expected


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
        pieces: list[str] = []
        for name in (*T262_BASE_HARNESS, *parse_case_includes(case_text, case)):
            harness_path = harness_dir / name
            if harness_path.is_symlink() or not harness_path.is_file():
                raise GateFailure(f"Test262 harness include is missing: {name}")
            pieces.append(harness_path.read_text(encoding="utf-8"))
        # Sloppy mode, matching the frozen run-test262 configuration
        # (mode=default -> nostrict; no frozen case is onlyStrict).
        pieces.append(case_text)
        receipt_js, expected = make_receipt_program(rng)
        pieces.append(receipt_js)
        # Fresh writable state (and a fresh IPC namespace inside run_candidate)
        # per case; the driver lives in a root-owned directory the demoted
        # candidate cannot write, created AFTER the reset that sweeps
        # BUILD_ROOT, and is swept again by the next reset.
        reset_candidate_state()
        T262_DRIVER_DIR.mkdir(mode=0o755)
        driver = T262_DRIVER_DIR / "driver.js"
        driver.write_text("\n".join(pieces), encoding="utf-8")
        driver.chmod(0o444)
        # The pristine in-eval reference build must accept every composed
        # driver first: a failure here is a trusted-composition bug (or a
        # corrupt sealed tree), never candidate behavior, and it fails loudly
        # instead of silently zeroing candidates.
        run_receipt_driver(
            REF_SOURCE / "qjs", driver, expected, f"trusted Test262 driver self-check failed: {case}"
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


def timed_gated_run(argv: list[str], expected_bytes: bytes, timeout: float, label: str) -> float:
    """One trusted-timed, output-gated launch from a pristine writable state."""
    reset_candidate_state()
    started = time.monotonic_ns()
    completed = run_candidate(argv, timeout=timeout)
    elapsed = (time.monotonic_ns() - started) / 1_000_000_000.0
    if completed.returncode != 0 or completed.stderr or completed.stdout != expected_bytes:
        raise GateFailure(f"{label} exact-output gate failed")
    if not math.isfinite(elapsed) or elapsed <= 0:
        raise GateFailure(f"trusted {label} timer failed")
    return elapsed


def run_microbenchmarks(rows: object) -> tuple[list[float], list[float]]:
    if not isinstance(rows, list):
        raise GateFailure("sealed microbenchmark rows are invalid")
    validated: list[tuple[str, int, int, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise GateFailure("sealed microbenchmark row is invalid")
        name = row.get("name")
        iterations = row.get("iterations")
        operations = row.get("operations")
        expected = row.get("expected")
        if (
            not isinstance(name, str)
            or not isinstance(iterations, int)
            or not isinstance(operations, int)
            or not isinstance(expected, str)
        ):
            raise GateFailure("sealed microbenchmark row has invalid values")
        validated.append((name, iterations, operations, expected))
    # Fastest-k-of-N trimmed sampling in the trusted parent: host contention
    # only ever ADDS wall time, and every sample is taken by this trusted
    # process with the full exact-output gate, so keeping the fastest samples
    # rejects transient co-scheduling noise without giving the candidate any
    # influence over which samples count. Sampling rounds are INTERLEAVED
    # round-robin across the sealed benchmarks, and every candidate sample is
    # bracketed by a pristine in-eval trusted-reference sample of the SAME
    # benchmark seconds apart, so both see the same ambient host speed and the
    # reference-normalized ratio cancels cross-eval drift.
    candidate_elapsed: list[list[float]] = [[] for _ in validated]
    reference_elapsed: list[list[float]] = [[] for _ in validated]
    for _ in range(MICRO_SAMPLES):
        for index, (name, iterations, operations, expected) in enumerate(validated):
            script = str(WORKLOAD_DIR / "benchmark.js")
            arguments = [script, name, str(iterations)]
            expected_bytes = expected.encode()
            reference_elapsed[index].append(
                timed_gated_run([str(REF_SOURCE / "qjs"), *arguments], expected_bytes, 120, "reference microbenchmark")
            )
            candidate_elapsed[index].append(
                timed_gated_run([str(SOURCE / "qjs"), *arguments], expected_bytes, 120, "microbenchmark")
            )
    candidate_throughputs: list[float] = []
    reference_throughputs: list[float] = []
    for (name, iterations, operations, expected), cand, ref in zip(validated, candidate_elapsed, reference_elapsed):
        candidate_throughputs.append(operations / statistics.fmean(sorted(cand)[:MICRO_KEEP]))
        reference_throughputs.append(operations / statistics.fmean(sorted(ref)[:MICRO_KEEP]))
    return candidate_throughputs, reference_throughputs


def measure_module_startup(expected: str, launches: int, rounds: int) -> tuple[float, float]:
    expected_bytes = expected.encode()
    module_path = WORKLOAD_DIR / "module-main.js"
    candidate_samples: list[float] = []
    reference_samples: list[float] = []
    for _ in range(rounds):
        candidate_sec: list[float] = []
        reference_sec: list[float] = []
        for _ in range(launches):
            reference_sec.append(
                timed_gated_run([str(REF_SOURCE / "qjs"), "-m", str(module_path)], expected_bytes, 1.0, "reference module-startup")
            )
            candidate_sec.append(
                timed_gated_run([str(SOURCE / "qjs"), "-m", str(module_path)], expected_bytes, 1.0, "module-startup")
            )
        # Same trimmed-sampling rationale as the microbenchmarks: every launch
        # is separately timed by the trusted parent and interleaved with a
        # pristine reference launch; keep the fastest windows of the sealed
        # 31-launch round so a transient host-contention burst cannot halve
        # the round's throughput.
        for source_sec, samples in ((candidate_sec, candidate_samples), (reference_sec, reference_samples)):
            kept = sorted(source_sec)[:MODULE_KEEP]
            elapsed = sum(kept)
            if not math.isfinite(elapsed) or elapsed <= 0:
                raise GateFailure("module-startup timer failed")
            samples.append(len(kept) / elapsed)
    candidate_throughput = statistics.median(candidate_samples)
    reference_throughput = statistics.median(reference_samples)
    if not all(math.isfinite(value) and value > 0 for value in (candidate_throughput, reference_throughput)):
        raise GateFailure("module-startup throughput is invalid")
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
