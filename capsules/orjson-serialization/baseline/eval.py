#!/usr/bin/env python3
"""Trusted offline build, correctness, RSS, and throughput evaluator for OSS-T08."""
from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import lzma
import math
import os
import resource
import secrets
import select
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from typing import Any

TRUSTED_DIR = Path(__file__).resolve().parent
# Under `python -I` the script directory is NOT on sys.path; append it (lowest
# priority, so it never shadows the pristine system orjson) so the trusted
# orjson_workload module can be imported for the reference oracle.
if str(TRUSTED_DIR) not in sys.path:
    sys.path.append(str(TRUSTED_DIR))
CHALLENGE = json.loads((TRUSTED_DIR / "challenge.json").read_text())
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
WORKER = TRUSTED_DIR / "benchmark_worker.py"
CONDUCTOR = TRUSTED_DIR / "test_conductor.py"
TARGET = Path("/tmp/target")
WHEELS = Path("/tmp/wheels")
SITE = Path("/tmp/site")
WORKER_UID = 2000
MAX_OUTPUT_BYTES = 4_000_000
CLONE_NEWIPC = 0x08000000
CLONE_NEWUTS = 0x04000000
CLONE_NEWPID = 0x20000000
CLONE_NEWNET = 0x40000000
PR_SET_CHILD_SUBREAPER = 36
_LIBC = ctypes.CDLL(None, use_errno=True)
EXTENSION_FD: int | None = None
CGROUP_ROOT = Path("/tmp/hone-orjson-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_BENCH = CGROUP_ROOT / "bench"
CGROUP_DRAIN_SEC = 10


def failed(summary: str, constraints: dict[str, bool] | None = None) -> None:
    gates = {
        "build_pass": False,
        "tests_pass": False,
        "byte_exact_dumps": False,
        "semantic_loads": False,
        "rss_within_limit": False,
    }
    if constraints:
        gates.update(constraints)
    output = {
        "valid": False,
        "objectives": {"score": float(CHALLENGE["qFail"])},
        "constraints": gates,
        "perExample": {
            "aggregate": {"score": float(CHALLENGE["qFail"]), "feedback": summary[:500]}
        },
        "diagnostics": {"summary": summary[:500], "quality": 0.0},
    }
    json.dump(output, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(0)


def configure_subreaper() -> None:
    if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f"cannot become candidate subreaper: {os.strerror(code)}")


def candidate_pids() -> list[int]:
    found: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        for line in status.splitlines():
            if line.startswith("Uid:"):
                fields = line.split()
                if len(fields) >= 2 and int(fields[1]) == WORKER_UID:
                    found.append(int(entry.name))
                break
    return found


def candidate_vmhwm_kib() -> int:
    """Dev-only fallback (non-root, no cgroup authority): sum VmHWM of the
    live candidate-uid processes. Never used on the root+linux broker path."""
    total = 0
    for pid in candidate_pids():
        try:
            status = (Path("/proc") / str(pid) / "status").read_text()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        for line in status.splitlines():
            if line.startswith("VmHWM:"):
                total += int(line.split()[1])
                break
    return total


def cgroup_available() -> bool:
    return os.geteuid() == 0 and sys.platform.startswith("linux")


def mount_measurement_cgroup() -> None:
    """Trusted whole-tree memory accounting. Docker mounts the container's
    cgroup2 view read-only, but the trusted evaluator holds mount authority
    (CAP_SYS_ADMIN): a fresh cgroup2 instance over the same namespaced
    hierarchy is writable by root only. The evaluator (and every worker it
    forks) is parked in a trusted leaf so the memory controller can be
    delegated to the per-run measurement leaf."""
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=True)
    completed = subprocess.run(
        ["mount", "-t", "cgroup2", "-o", "nosuid,nodev,noexec", "hone-orjson-cg", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError("trusted measurement cgroup mount failed")
    CGROUP_TRUSTED.mkdir(mode=0o755, exist_ok=True)
    (CGROUP_TRUSTED / "cgroup.procs").write_text(str(os.getpid()))
    (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")


def unmount_measurement_cgroup() -> None:
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


def drain_measurement_leaf(leaf: Path) -> None:
    """Kill every process still charged to the leaf (detached descendants in
    new sessions included), wait for the kernel to release them, then retire
    the leaf, so memory.peak has already been read for the whole tree."""
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
    except OSError:
        pass


def reap_candidates() -> None:
    deadline = time.monotonic() + 2.0
    while True:
        pids = candidate_pids()
        if not pids:
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == 0:
                    break
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise RuntimeError(f"candidate processes survived reset: {pids}")
        time.sleep(0.01)


def worker_preexec() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (3 << 30, 3 << 30))
    if _LIBC.unshare(CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWPID | CLONE_NEWUTS) != 0:
        code = ctypes.get_errno()
        raise RuntimeError(f"cannot isolate candidate namespaces: {os.strerror(code)}")
    init_pid = os.fork()
    if init_pid > 0:
        try:
            os.close_range(0, 2**30)
        except AttributeError:
            os.closerange(0, 1 << 16)
        _, status = os.waitpid(init_pid, 0)
        code = os.waitstatus_to_exitcode(status)
        os._exit(code if code >= 0 else 128 - code)
    os.setgroups([])
    os.setgid(WORKER_UID)
    os.setuid(WORKER_UID)


def run_command(
    argv: list[str],
    *,
    cwd: Path,
    timeout: float,
    env: dict[str, str] | None = None,
    payload: bytes | None = None,
    candidate: bool = False,
    extra_pass_fds: tuple[int, ...] = (),
) -> tuple[int, bytes, bytes]:
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=worker_preexec if candidate else None,
        start_new_session=True,
        pass_fds=(
            ((EXTENSION_FD,) if candidate and EXTENSION_FD is not None else ())
            + extra_pass_fds
        ),
    )
    try:
        stdout, stderr = proc.communicate(input=payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.kill()
        stdout, stderr = proc.communicate()
        return 124, stdout[:MAX_OUTPUT_BYTES], stderr[:MAX_OUTPUT_BYTES]
    if len(stdout) > MAX_OUTPUT_BYTES or len(stderr) > MAX_OUTPUT_BYTES:
        return 125, stdout[:MAX_OUTPUT_BYTES], stderr[:MAX_OUTPUT_BYTES]
    return proc.returncode, stdout, stderr


SKIP_TREE_ENTRIES = {".git", ".gitdir", "__pycache__", ".pytest_cache"}


def tree_files(root: Path) -> tuple[dict[str, Path], list[str]]:
    """Regular files under root keyed by posix relpath, plus any non-regular
    entries encountered. Version-control metadata and bytecode caches are
    excluded on both sides of the comparison."""
    files: dict[str, Path] = {}
    problems: list[str] = []
    stack = [root]
    while stack:
        directory = stack.pop()
        for entry in sorted(directory.iterdir()):
            if entry.name in SKIP_TREE_ENTRIES:
                continue
            rel = entry.relative_to(root).as_posix()
            if entry.is_symlink():
                problems.append(rel)
            elif entry.is_dir():
                stack.append(entry)
            elif entry.is_file():
                files[rel] = entry
            else:
                problems.append(rel)
    return files, problems


def mutable_path(rel: str) -> bool:
    for mutable in CHALLENGE["mutablePaths"]:
        if rel == mutable or rel.startswith(f"{mutable}/"):
            return True
    return False


def workspace_envelope_violation() -> str | None:
    """Every workspace path outside the declared mutable envelope must exist
    in the frozen baseline tree byte-for-byte — additions, modifications, and
    deletions outside src/lib.rs, src/serialize/, and src/deserialize/ are all
    rejected before any candidate code is built or executed."""
    trusted_files, trusted_problems = tree_files(TRUSTED_DIR)
    if trusted_problems:
        raise RuntimeError(f"non-regular path in frozen baseline: {trusted_problems[0]}")
    workspace_files, workspace_problems = tree_files(WORKSPACE)
    if workspace_problems:
        return f"non-regular path in workspace: {workspace_problems[0]}"
    for rel, path in workspace_files.items():
        if mutable_path(rel):
            continue
        trusted = trusted_files.get(rel)
        if trusted is None:
            return f"file outside the mutable envelope: {rel}"
        if path.read_bytes() != trusted.read_bytes():
            return f"protected file modified: {rel}"
    for rel in trusted_files:
        if not mutable_path(rel) and rel not in workspace_files:
            return f"protected file missing: {rel}"
    return None


def prepare_workloads() -> tuple[list[dict[str, Any]], dict[str, str], str]:
    definitions = list(ASSETS.rglob("workloads.json"))
    if len(definitions) != 1:
        raise ValueError(f"expected one workloads.json, found {len(definitions)}")
    document = json.loads(definitions[0].read_text())
    cases = document.get("cases")
    split = document.get("split")
    if not isinstance(cases, list) or len(cases) != 10 or not isinstance(split, str):
        raise ValueError("malformed frozen workloads")
    expected: dict[str, str] = {}
    worker_cases: list[dict[str, Any]] = []
    for source in cases:
        if not isinstance(source, dict) or not isinstance(source.get("id"), str):
            raise ValueError("malformed workload case")
        case = dict(source)
        expected[case["id"]] = str(case.pop("expectedSha256"))
        case.pop("correctness", None)
        fixture = case.pop("fixture", None)
        fixture_hash = case.pop("fixtureSha256", None)
        if fixture is not None:
            matches = list(ASSETS.rglob(str(fixture)))
            if len(matches) != 1:
                raise ValueError(f"missing fixture {fixture}")
            compressed = matches[0].read_bytes()
            if hashlib.sha256(compressed).hexdigest() != fixture_hash:
                raise ValueError(f"fixture hash mismatch: {fixture}")
            case["inputB64"] = base64.b64encode(lzma.decompress(compressed)).decode("ascii")
        worker_cases.append(case)
    return worker_cases, expected, split


def install_extension_memfd() -> bool:
    global EXTENSION_FD
    extensions = list(SITE.rglob("*.so"))
    if len(extensions) != 1:
        return False
    extension = extensions[0]
    fd = os.memfd_create("orjson-extension", 0)
    with extension.open("rb") as source:
        while chunk := source.read(1 << 20):
            os.write(fd, chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    extension.unlink()
    extension.symlink_to(f"/proc/self/fd/{fd}")
    EXTENSION_FD = fd
    return True


def build_candidate() -> tuple[bool, str, float]:
    for path in (TARGET, WHEELS, SITE):
        shutil.rmtree(path, ignore_errors=True)
    started = time.perf_counter()
    env = dict(os.environ)
    env["CARGO_TARGET_DIR"] = str(TARGET)
    prepare = subprocess.run(
        [sys.executable, "/opt/orjson/prepare-target.py"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=20,
    )
    if prepare.returncode != 0:
        return False, "target preparation failed", time.perf_counter() - started
    WHEELS.mkdir()
    code, _, stderr = run_command(
        list(CHALLENGE["build"]["command"]),
        cwd=WORKSPACE,
        timeout=float(CHALLENGE["build"]["timeoutSec"]),
        env=env,
    )
    elapsed = time.perf_counter() - started
    if code != 0:
        detail = stderr.decode("utf-8", "replace").splitlines()[-1:] or ["unknown error"]
        return False, f"offline maturin build failed: {detail[0]}", elapsed
    wheels = list(WHEELS.glob("orjson-*.whl"))
    if len(wheels) != 1:
        return False, "maturin did not produce exactly one orjson wheel", elapsed
    SITE.mkdir()
    with zipfile.ZipFile(wheels[0]) as archive:
        archive.extractall(SITE)
    if not install_extension_memfd():
        return False, "wheel did not contain exactly one extension", elapsed
    shutil.rmtree(TARGET, ignore_errors=True)
    shutil.rmtree(WHEELS, ignore_errors=True)
    return True, "offline maturin build passed", elapsed


def sweep_candidate_tmp() -> None:
    """Drop candidate-owned (uid 2000) scratch left directly under /tmp between
    candidate launches so a file planted by the test process cannot become
    shared state a later launch replays. SITE holds the trusted-extracted
    extension and is root-owned, so it is never a candidate-owned entry."""
    root = Path("/tmp")
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for entry in entries:
        try:
            st = entry.lstat()
        except OSError:
            continue
        if st.st_uid != WORKER_UID:
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            try:
                entry.unlink()
            except OSError:
                pass


def score_test_records(conductor_code: int, blob: bytes) -> tuple[bool, str]:
    """Accept the run ONLY when the trusted conductor — a process that never
    imports the candidate extension — reports that every frozen test file ran
    to session finish with zero failures/errors, and the observed totals and
    identity fingerprint match the frozen expectation.

    The conductor drives one pytest subprocess per test file and derives each
    file's outcome from that child's exit code plus the JUnit report pytest
    itself writes at session finish. No nonce or record fd is ever delivered
    into a process that loads the candidate extension, so candidate module-init
    has nothing to scrape and no in-process channel it can author that the
    trusted side reads. A candidate that ``os._exit(0)``s during import never
    reaches session finish for that file, so its report is absent, the file is
    not counted as completed, and the observed pass count falls below the frozen
    expectation. The conductor relays a single trusted trailer:
        C\\t<auth>\\t<passed>\\t<skipped>\\t<failed>\\t<errored>
          \\t<completed_files>\\t<expected_files>\\t<identity>\\t<manifest_b64>\\t<detail_b64>
    Identity (a sha256 over the exact sorted pass/skip <file>/<class>/<name>
    set), not a bare count, is compared: a shortened or altered suite changes
    the identity even when the totals coincide."""
    expected_passed = int(CHALLENGE["tests"]["passed"])
    expected_skipped = int(CHALLENGE["tests"]["skipped"])
    expected_identity = str(CHALLENGE["tests"].get("identitySha256", ""))
    expected_files = len(CHALLENGE["tests"].get("perFile", {})) or None
    lines = blob.decode("utf-8", "replace").splitlines()
    trailer = lines[-1] if lines and lines[-1].startswith("C\t") else None
    if conductor_code != 0 or trailer is None:
        return False, "test conductor did not complete"
    tfields = trailer.split("\t")
    if len(tfields) != 11:
        return False, "malformed conductor trailer"
    try:
        authenticated = tfields[1] == "1"
        passed = int(tfields[2])
        skipped = int(tfields[3])
        failures = int(tfields[4])
        errored = int(tfields[5])
        completed_files = int(tfields[6])
        reported_files = int(tfields[7])
    except ValueError:
        return False, "malformed conductor trailer"
    identity = tfields[8]

    def detail() -> str:
        if tfields[10]:
            try:
                text = base64.b64decode(tfields[10]).decode("utf-8", "replace")
            except ValueError:
                return ""
            tail = text.strip().splitlines()[-1:]
            return tail[0] if tail else ""
        return ""

    if not authenticated:
        suffix = f": {detail()}" if detail() else ""
        return False, f"test summary not authenticated by the trusted channel{suffix}"
    if failures != 0 or errored != 0:
        return False, "upstream pytest suite reported failures"
    if completed_files != reported_files:
        return False, f"only {completed_files}/{reported_files} test files completed"
    if not expected_identity:
        # Fail-closed: shipped config always pins the identity. This branch only
        # fires during pre-freeze capture; surface the full observed manifest and
        # identity (stderr is not summary-truncated) so they can be frozen.
        sys.stderr.write(
            f"CAPTURE passed={passed} skipped={skipped} files={reported_files}\n"
            f"CAPTURE identity={identity}\n"
            f"CAPTURE manifest={tfields[9]}\n"
        )
        return False, f"tests identity unset; observed={identity}"
    if expected_files is not None and reported_files != expected_files:
        return False, f"test file set changed: {reported_files} of {expected_files}"
    if passed != expected_passed or skipped != expected_skipped:
        return False, f"pytest count changed: {passed} passed, {skipped} skipped"
    if identity != expected_identity:
        return False, f"pytest identity mismatch; observed={identity}"
    return True, f"{expected_passed} passed, {expected_skipped} skipped"


def run_tests() -> tuple[bool, str]:
    if EXTENSION_FD is None:
        return False, "candidate extension unavailable"
    timeout = float(CHALLENGE["tests"]["timeoutSec"])
    # The parent owns the record channel: it holds the read end and passes ONLY
    # the write end to the trusted conductor. No process that loads the candidate
    # extension ever inherits it (conductor clears it CLOEXEC + scrubs env and
    # marks itself non-dumpable) — and, critically, the conductor produces the
    # authenticated verdict itself without importing the extension, so no nonce
    # or record fd is delivered into any pytest process. Candidate module-init
    # therefore has nothing to scrape and no channel to author.
    read_fd, write_fd = os.pipe()
    env = dict(os.environ)
    env["HONE_CONDUCTOR_OUT_FD"] = str(write_fd)
    env["HONE_PYTEST_BASE_ARGV"] = json.dumps(list(CHALLENGE["tests"]["baseArgv"]))
    env["HONE_TEST_ROOT"] = str(CHALLENGE["tests"]["root"])
    env["HONE_TEST_MANIFEST"] = json.dumps(CHALLENGE["tests"].get("perFile", {}))
    env["HONE_SITE"] = str(SITE)
    env["HONE_TRUSTED_DIR"] = str(TRUSTED_DIR)
    env["HONE_EXTENSION_FD"] = str(EXTENSION_FD)
    env["HONE_CONDUCTOR_DEADLINE"] = repr(max(5.0, timeout - 5.0))
    chunks: list[bytes] = []

    def drain() -> None:
        while True:
            try:
                chunk = os.read(read_fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            if sum(len(part) for part in chunks) < MAX_OUTPUT_BYTES:
                chunks.append(chunk)

    drainer = threading.Thread(target=drain, daemon=True)
    drainer.start()
    try:
        code, _, _ = run_command(
            [sys.executable, "-I", "-B", str(CONDUCTOR)],
            cwd=TRUSTED_DIR,
            timeout=timeout,
            env=env,
            candidate=True,
            extra_pass_fds=(write_fd,),
        )
    finally:
        os.close(write_fd)
        drainer.join(timeout=10.0)
        os.close(read_fd)
    reap_candidates()
    sweep_candidate_tmp()
    return score_test_records(code, b"".join(chunks))


PROBE_ITERATIONS = 8
# Interleaved candidate/reference pairs per workload. The per-pair ref/cand
# ratio cancels shared host load; the paired geomean over this many pairs
# tightens the estimate under the contended shared host.
BENCH_PAIRS = 9


class WorkerProtocolError(RuntimeError):
    pass


def _load_reference_orjson() -> Any:
    """Import the PRISTINE orjson built from the frozen baseline at image time
    (installed in the system site-packages), never the candidate overlay under
    SITE. The parent uses it to reproduce the reference result-chain for every
    timed run."""
    import orjson  # noqa: PLC0415

    module_path = getattr(orjson, "__file__", "") or ""
    if str(SITE) in module_path:
        raise WorkerProtocolError("reference orjson resolved to the candidate build")
    return orjson


def benchmark(cases: list[dict[str, Any]]) -> tuple[dict[str, Any], int]:
    """Interactive benchmark protocol with all timing in this trusted parent.

    The worker only executes commanded batches and reports result digests;
    elapsed time for every probe and sample is measured here with
    time.perf_counter_ns() around the full command round-trip, so a clock
    rewritten inside the candidate-linked worker process changes nothing.

    Anti-shortcut is owned here too: every timed run returns a data-dependent
    result-chain over the real serializer output of EVERY iteration, and this
    parent independently reproduces that chain with a pristine reference orjson
    over the same per-run-unpredictable nonce. A run whose chain does not match
    the reference cannot have done the real serialization work for each
    iteration, so it is scored as incorrect.

    Peak memory is the kernel cgroup2 memory.peak of the whole worker process
    tree (exited children included), read from a leaf whose control files the
    demoted uid-2000 worker can never write — not a /proc self-reported value a
    candidate could under-report."""
    reference = _load_reference_orjson()
    import orjson_workload as workload  # noqa: PLC0415

    use_cgroup = cgroup_available()
    if use_cgroup:
        mount_measurement_cgroup()
        CGROUP_BENCH.mkdir(mode=0o755, exist_ok=True)
    bench_procs = CGROUP_BENCH / "cgroup.procs"

    def bench_preexec() -> None:
        if use_cgroup:
            with open(bench_procs, "w") as handle:
                handle.write("0")
        worker_preexec()

    env = dict(os.environ)
    env["ORJSON_SITE"] = str(SITE)
    deadline = time.monotonic() + float(CHALLENGE["benchmarkTimeoutSec"])
    stderr_file = tempfile.TemporaryFile(dir="/tmp")
    proc = subprocess.Popen(
        [sys.executable, "-I", "-B", str(WORKER)],
        cwd=str(TRUSTED_DIR),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=stderr_file,
        preexec_fn=bench_preexec,
        start_new_session=True,
        pass_fds=((EXTENSION_FD,) if EXTENSION_FD is not None else ()),
    )
    assert proc.stdin is not None and proc.stdout is not None
    stdout_fd = proc.stdout.fileno()
    peak_rss = 0
    buffer = bytearray()
    consumed = 0

    def recv() -> dict[str, Any]:
        nonlocal consumed
        while True:
            newline = buffer.find(b"\n")
            if newline >= 0:
                line = bytes(buffer[:newline])
                del buffer[: newline + 1]
                reply = json.loads(line)
                if not isinstance(reply, dict):
                    raise WorkerProtocolError("malformed worker reply")
                return reply
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise WorkerProtocolError("benchmark wall clock exhausted")
            ready, _, _ = select.select([stdout_fd], [], [], min(remaining, 1.0))
            if not ready:
                continue
            chunk = os.read(stdout_fd, 65536)
            if not chunk:
                raise WorkerProtocolError("benchmark worker exited early")
            consumed += len(chunk)
            if consumed > MAX_OUTPUT_BYTES:
                raise WorkerProtocolError("benchmark worker output limit exceeded")
            buffer.extend(chunk)

    def command(payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
        encoded = json.dumps(payload, separators=(",", ":")).encode() + b"\n"
        started = time.perf_counter_ns()
        proc.stdin.write(encoded)
        proc.stdin.flush()
        reply = recv()
        elapsed = time.perf_counter_ns() - started
        if reply.get("op") != payload["op"] or (
            "id" in payload and reply.get("id") != payload["id"]
        ):
            raise WorkerProtocolError("worker reply does not match command")
        return reply, max(1, elapsed)

    rows: list[dict[str, Any]] = []
    try:
        for case in cases:
            case_id = case["id"]
            reference_state = workload.Workload(case)
            setup_reply, _ = command({"op": "setup", "case": case, "id": case_id})
            canon = str(setup_reply.get("canon"))

            def validate(iterations: int, nonce: int) -> tuple[bool, int, int]:
                if time.monotonic() > deadline:
                    raise WorkerProtocolError("benchmark wall clock exhausted")
                reply, cand_ns = command(
                    {"op": "run", "id": case_id, "iterations": iterations, "nonce": nonce}
                )
                candidate_chain = str(reply.get("resultChain"))
                # Interleaved pristine-reference yardstick: time the SAME work on
                # the pristine reference right after the candidate leg, so the
                # per-pair ref/cand ratio cancels the shared host load that
                # otherwise makes absolute timing unstable under contention.
                ref_start = time.perf_counter_ns()
                reference_chain = reference_state.chain(reference, iterations, nonce)
                ref_ns = max(1, time.perf_counter_ns() - ref_start)
                return candidate_chain == reference_chain, cand_ns, ref_ns

            probe_ok, probe_ns, _ = validate(PROBE_ITERATIONS, secrets.randbelow(1 << 30))
            target_ns = int(case.get("targetNs", 80_000_000)) * 2
            iterations = max(
                1, min(1_000_000, math.ceil(target_ns * PROBE_ITERATIONS / probe_ns))
            )
            chain_ok = probe_ok
            cand_samples: list[int] = []
            ref_samples: list[int] = []
            for _ in range(BENCH_PAIRS):
                command({"op": "refresh", "id": case_id})
                sample_ok, cand_ns, ref_ns = validate(iterations, secrets.randbelow(1 << 30))
                chain_ok = chain_ok and sample_ok
                cand_samples.append(cand_ns)
                ref_samples.append(ref_ns)
            command({"op": "teardown", "id": case_id})
            rows.append(
                {
                    "id": case_id,
                    "operation": case["operation"],
                    "iterations": iterations,
                    "candNs": cand_samples,
                    "refNs": ref_samples,
                    "resultSha256": canon,
                    "chainOk": chain_ok,
                }
            )
        proc.stdin.write(b'{"op":"exit"}\n')
        proc.stdin.flush()
        proc.wait(timeout=10)
    except (WorkerProtocolError, OSError, ValueError) as exc:
        stderr_file.seek(0)
        tail = (
            stderr_file.read()[-4000:]
            .decode("utf-8", "replace")
            .strip()
            .splitlines()[-1:]
        )
        detail = tail[0] if tail else "no worker stderr"
        raise WorkerProtocolError(f"benchmark worker failed: {exc} ({detail})") from None
    finally:
        if use_cgroup:
            try:
                peak_bytes = int((CGROUP_BENCH / "memory.peak").read_text().strip())
                peak_rss = peak_bytes // 1024
            except (OSError, ValueError):
                peak_rss = 0
        else:
            peak_rss = candidate_vmhwm_kib()
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        reap_candidates()
        stderr_file.close()
        if use_cgroup:
            try:
                drain_measurement_leaf(CGROUP_BENCH)
            finally:
                unmount_measurement_cgroup()
    return {"cases": rows}, peak_rss


def main() -> None:
    evaluation_started = time.perf_counter()
    configure_subreaper()
    reap_candidates()
    if (WORKSPACE / ".git").exists() or (WORKSPACE / ".gitdir").exists():
        failed("source-control metadata leaked into candidate workspace")
    try:
        envelope_violation = workspace_envelope_violation()
    except Exception as exc:
        failed(f"trusted envelope verification failed: {exc}")
    if envelope_violation is not None:
        failed(f"workspace outside mutable envelope: {envelope_violation}")
    try:
        cases, expected, split = prepare_workloads()
    except Exception as exc:
        failed(f"trusted workload configuration failed: {exc}")
    built, build_detail, build_sec = build_candidate()
    if not built:
        failed(build_detail)
    tests_pass, test_detail = run_tests()
    if not tests_pass:
        failed(test_detail, {"build_pass": True})
    try:
        response, peak_rss = benchmark(cases)
    except Exception as exc:
        failed(str(exc), {"build_pass": True, "tests_pass": True})

    rows = response.get("cases")
    if not isinstance(rows, list) or len(rows) != len(cases):
        failed("benchmark protocol mismatch", {"build_pass": True, "tests_pass": True})
    throughputs: dict[str, float] = {}
    dump_ok = True
    loads_ok = True
    result_rows: list[str] = []
    operations = {case["id"]: case["operation"] for case in cases}
    seen_ids: set[str] = set()
    for row in rows:
        case_id = row.get("id")
        cand = row.get("candNs")
        ref = row.get("refNs")
        iterations = row.get("iterations")
        digest = row.get("resultSha256")
        if (
            not isinstance(case_id, str)
            or case_id not in expected
            or not isinstance(cand, list)
            or not isinstance(ref, list)
            or len(cand) != BENCH_PAIRS
            or len(ref) != BENCH_PAIRS
            or not isinstance(iterations, int)
            or iterations <= 0
            or not all(isinstance(value, int) and value > 0 for value in cand)
            or not all(isinstance(value, int) and value > 0 for value in ref)
            or not isinstance(digest, str)
            or not isinstance(row.get("chainOk"), bool)
        ):
            failed("malformed benchmark result", {"build_pass": True, "tests_pass": True})
        if case_id in seen_ids:
            failed("duplicate workload id in benchmark result", {"build_pass": True, "tests_pass": True})
        seen_ids.add(case_id)
        matches = digest == expected[case_id] and bool(row["chainOk"])
        if operations[case_id] == "dumps":
            dump_ok = dump_ok and matches
        else:
            loads_ok = loads_ok and matches
        # Interleaved-yardstick throughput: the per-pair ratio of pristine
        # reference time to candidate time cancels the shared host load in each
        # back-to-back pair (running slower never helps a candidate: it only
        # shrinks the ratio). Paired geomean over the pairs is the stable
        # per-workload speed relative to the pristine baseline (~1.0 == pristine).
        ratios = [r / c for r, c in zip(ref, cand)]
        throughput = math.exp(statistics.fmean(math.log(value) for value in ratios))
        if not math.isfinite(throughput) or throughput <= 0:
            failed("non-finite throughput", {"build_pass": True, "tests_pass": True})
        throughputs[case_id] = throughput
        result_rows.append(f"{case_id}:{digest}")
    if seen_ids != set(expected) or seen_ids != set(operations):
        failed("workload coverage mismatch", {"build_pass": True, "tests_pass": True})
    rss_limit = int(CHALLENGE["peakRssLimitKiB"])
    rss_ok = 0 < peak_rss <= rss_limit
    hard_pass = dump_ok and loads_ok and rss_ok
    q = math.exp(statistics.fmean(math.log(value) for value in throughputs.values())) if hard_pass else float(CHALLENGE["qFail"])
    if not math.isfinite(q):
        q = float(CHALLENGE["qFail"])
        hard_pass = False
    result_hash = hashlib.sha256("\n".join(sorted(result_rows)).encode()).hexdigest()
    constraints = {
        "build_pass": True,
        "tests_pass": True,
        "byte_exact_dumps": dump_ok,
        "semantic_loads": loads_ok,
        "rss_within_limit": rss_ok,
    }
    summary = (
        f"{split}: 10 frozen workloads; {test_detail}; peak RSS {peak_rss} KiB "
        f"(limit {rss_limit} KiB)"
    )
    output = {
        "valid": hard_pass,
        "objectives": {"score": q},
        "constraints": constraints,
        "perExample": {"aggregate": {"score": q, "feedback": summary}},
        "diagnostics": {
            "summary": summary,
            "quality": 1.0 if hard_pass else 0.0,
            "buildSec": build_sec,
            "evalSec": time.perf_counter() - evaluation_started,
            "peakRssKiB": peak_rss,
            "resultHash": result_hash,
            "throughput": throughputs,
        },
    }
    json.dump(output, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
