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


def candidate_rss_kib() -> int:
    total = 0
    for pid in candidate_pids():
        try:
            status = (Path("/proc") / str(pid) / "status").read_text()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                total += int(line.split()[1])
                break
    return total


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
    measure_rss: bool = False,
    extra_pass_fds: tuple[int, ...] = (),
) -> tuple[int, bytes, bytes, int]:
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
    peak_rss = 0
    stop = threading.Event()

    def sample() -> None:
        nonlocal peak_rss
        while not stop.wait(0.005):
            peak_rss = max(peak_rss, candidate_rss_kib())

    sampler = threading.Thread(target=sample, daemon=True)
    if measure_rss:
        sampler.start()
    try:
        stdout, stderr = proc.communicate(input=payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.kill()
        stdout, stderr = proc.communicate()
        return 124, stdout[:MAX_OUTPUT_BYTES], stderr[:MAX_OUTPUT_BYTES], peak_rss
    finally:
        stop.set()
        if measure_rss:
            sampler.join(timeout=1)
            peak_rss = max(peak_rss, candidate_rss_kib())
    if len(stdout) > MAX_OUTPUT_BYTES or len(stderr) > MAX_OUTPUT_BYTES:
        return 125, stdout[:MAX_OUTPUT_BYTES], stderr[:MAX_OUTPUT_BYTES], peak_rss
    return proc.returncode, stdout, stderr, peak_rss


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
    code, _, stderr, _ = run_command(
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
    """Accept the per-test records the conductor relayed ONLY when its
    authenticated trailer proves: the conductor itself completed, pytest exited
    cleanly, and the stream carried the conductor's fresh per-run nonce (so the
    records came from the trusted plugin, not a candidate that merely wrote to
    the advertised channel). Trailer:
        C\t<child_exit>\t<authenticated>\t<record_count>\t<detail_b64>"""
    expected_passed = int(CHALLENGE["tests"]["passed"])
    expected_skipped = int(CHALLENGE["tests"]["skipped"])
    lines = blob.decode("utf-8", "replace").splitlines()
    trailer = lines.pop() if lines and lines[-1].startswith("C\t") else None
    if conductor_code != 0 or trailer is None:
        return False, "test conductor did not complete"
    tfields = trailer.split("\t")
    if len(tfields) < 4:
        return False, "malformed conductor trailer"
    try:
        child_exit = int(tfields[1])
        authenticated = tfields[2] == "1"
        declared = int(tfields[3])
    except ValueError:
        return False, "malformed conductor trailer"

    def detail() -> str:
        if len(tfields) >= 5 and tfields[4]:
            try:
                text = base64.b64decode(tfields[4]).decode("utf-8", "replace")
            except ValueError:
                return ""
            tail = text.strip().splitlines()[-1:]
            return tail[0] if tail else ""
        return ""

    if not authenticated:
        return False, "test records not authenticated by the trusted channel"
    if child_exit != 0:
        suffix = f": {detail()}" if detail() else ""
        return False, f"pytest exited {child_exit}{suffix}"
    if declared != len(lines):
        return False, "conductor record accounting mismatch"
    passed: set[str] = set()
    skipped: set[str] = set()
    failures = 0
    malformed = 0
    for record in lines:
        fields = record.split("\t")
        if len(fields) == 2 and fields[0] in ("P", "S", "F") and "::" in fields[1]:
            kind, nodeid = fields
            if kind == "F":
                failures += 1
            elif kind == "P":
                if nodeid in passed:
                    malformed += 1
                passed.add(nodeid)
            else:
                if nodeid in skipped:
                    malformed += 1
                skipped.add(nodeid)
        else:
            malformed += 1
    counts_ok = (
        failures == 0
        and malformed == 0
        and len(passed) == expected_passed
        and len(skipped) == expected_skipped
        and not (passed & skipped)
    )
    return counts_ok, (
        f"{expected_passed} passed, {expected_skipped} skipped"
        if counts_ok
        else "full upstream pytest suite failed or count changed"
    )


def run_tests() -> tuple[bool, str]:
    if EXTENSION_FD is None:
        return False, "candidate extension unavailable"
    timeout = float(CHALLENGE["tests"]["timeoutSec"])
    # The parent owns the record channel: it holds the read end and passes ONLY
    # the write end to the trusted conductor. The candidate-executed pytest
    # process never inherits it (conductor clears it CLOEXEC + scrubs env and
    # marks itself non-dumpable), so candidate-linked code cannot write records
    # the trusted side will read.
    read_fd, write_fd = os.pipe()
    env = dict(os.environ)
    env["HONE_CONDUCTOR_OUT_FD"] = str(write_fd)
    env["HONE_PYTEST_ARGV"] = json.dumps(list(CHALLENGE["tests"]["command"]))
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
        code, _, _, _ = run_command(
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


class WorkerProtocolError(RuntimeError):
    pass


def benchmark(cases: list[dict[str, Any]]) -> tuple[dict[str, Any], int]:
    """Interactive benchmark protocol with all timing in this trusted parent.

    The worker only executes commanded batches and reports result digests;
    elapsed time for every probe and sample is measured here with
    time.perf_counter_ns() around the full command round-trip, so a clock
    rewritten inside the candidate-linked worker process changes nothing.
    """
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
        preexec_fn=worker_preexec,
        start_new_session=True,
        pass_fds=((EXTENSION_FD,) if EXTENSION_FD is not None else ()),
    )
    assert proc.stdin is not None and proc.stdout is not None
    stdout_fd = proc.stdout.fileno()
    peak_rss = 0
    stop = threading.Event()

    def sample_rss() -> None:
        nonlocal peak_rss
        while not stop.wait(0.005):
            peak_rss = max(peak_rss, candidate_rss_kib())

    sampler = threading.Thread(target=sample_rss, daemon=True)
    sampler.start()
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
            command({"op": "setup", "case": case, "id": case_id})
            digests: set[str] = set()
            reply, probe_ns = command(
                {
                    "op": "run",
                    "id": case_id,
                    "iterations": PROBE_ITERATIONS,
                    "nonce": secrets.randbelow(1 << 30),
                }
            )
            digests.add(str(reply.get("resultSha256")))
            target_ns = int(case.get("targetNs", 80_000_000)) * 2
            iterations = max(
                1, min(2_000_000, math.ceil(target_ns * PROBE_ITERATIONS / probe_ns))
            )
            samples: list[int] = []
            for _ in range(int(case.get("repeats", 5))):
                command({"op": "refresh", "id": case_id})
                reply, elapsed = command(
                    {
                        "op": "run",
                        "id": case_id,
                        "iterations": iterations,
                        "nonce": secrets.randbelow(1 << 30),
                    }
                )
                digests.add(str(reply.get("resultSha256")))
                samples.append(elapsed)
            command({"op": "teardown", "id": case_id})
            if len(digests) != 1:
                raise WorkerProtocolError(f"unstable result digest for {case_id}")
            rows.append(
                {
                    "id": case_id,
                    "operation": case["operation"],
                    "iterations": iterations,
                    "elapsedNs": samples,
                    "resultSha256": digests.pop(),
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
        stop.set()
        sampler.join(timeout=1)
        peak_rss = max(peak_rss, candidate_rss_kib())
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
        elapsed = row.get("elapsedNs")
        iterations = row.get("iterations")
        digest = row.get("resultSha256")
        if (
            not isinstance(case_id, str)
            or case_id not in expected
            or not isinstance(elapsed, list)
            or len(elapsed) != 5
            or not isinstance(iterations, int)
            or iterations <= 0
            or not all(isinstance(value, int) and value > 0 for value in elapsed)
            or not isinstance(digest, str)
        ):
            failed("malformed benchmark result", {"build_pass": True, "tests_pass": True})
        if case_id in seen_ids:
            failed("duplicate workload id in benchmark result", {"build_pass": True, "tests_pass": True})
        seen_ids.add(case_id)
        matches = digest == expected[case_id]
        if operations[case_id] == "dumps":
            dump_ok = dump_ok and matches
        else:
            loads_ok = loads_ok and matches
        # Fastest-3-of-5 trimmed sampling: host contention only ever ADDS
        # time, so trimming the slow outliers rejects sibling-load noise
        # without giving candidate-controlled code any lever (running slower
        # never helps a candidate).
        fastest = sorted(elapsed)[:3]
        samples = [iterations * 1_000_000_000.0 / value for value in fastest]
        throughput = statistics.median(samples)
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
