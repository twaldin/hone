#!/usr/bin/env python3
"""Trusted evaluator for nodejs/node WHATWG URL throughput.

Round-5 EXEC-BOUNDARY rebuild. The scored parse/serialize loop runs inside a
node binary that links candidate-mutable URL code, so a C++ constructor /
.init_array routine can run before any JavaScript. Rather than trust an in-
process, closed-form, single-repeated-input checksum (which such a routine can
reproduce from public constants without doing the work), this evaluator:

  * interleaves a PRISTINE reference leg (the baseline node binary, copied out
    of /opt/node BEFORE the candidate is built into it, so it never links
    candidate code) with each candidate leg on the SAME per-iteration nonce
    stream, and reports throughput as the drift-cancelling min-of-N ratio
    reference_time / candidate_time;
  * delivers the go nonce only AFTER the driver's JS-top-level readiness marker
    (a C++ constructor runs before that marker and so cannot cause the parent
    to release the nonce);
  * derives every timed iteration's structurally-distinct, NON-idempotent input
    from that go-time nonce, and requires the candidate's nonce-salted output
    fold to equal the reference's fold over the identical stream — so no correct
    result is precomputable in the untimed window, there is no per-input parse
    cache, and the only way to match the reference is to run the real per-
    iteration URL work inside the timed window.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import re
import resource
import secrets
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
EXACT_OUTPUT = TRUSTED_DIR / "exact_output.js"
BENCH_DRIVER = TRUSTED_DIR / "bench_driver.js"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
SOURCE = Path("/opt/node")
NODE = SOURCE / "out/Release/node"
# Pristine reference: the baseline node binary as built in the image, copied
# BEFORE the candidate mutable files are prepared into /opt/node and rebuilt.
# It never links candidate code, so it is the trusted ground truth for both the
# per-iteration output fold and the timing yardstick. It lives UNDER /opt/node
# (the writable, exec-capable anonymous volume) rather than the eval /tmp tmpfs,
# which the broker caps at 16 MiB and mounts noexec; prepare() only rewrites the
# six mutable files and build() only rewrites out/, so this copy survives both.
# A trusted root-owned 0755 directory the demoted candidate uid cannot rewrite.
REFERENCE_ROOT = SOURCE / "hone-node-url-ref"
REFERENCE_NODE = REFERENCE_ROOT / "node"
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 180
LEG_TIMEOUT_SEC = 120
BENCH_TIMED_REPS = 11
# Frozen provisional yardstick scale (PROVISIONAL local value; final GCE
# recalibration re-freezes it): a candidate identical to the trusted baseline
# scores this value by construction (ratio ~ 1.0), independent of host drift.
REFERENCE_NORMALIZATION = 3_000_000.0

# Trusted whole-tree memory accounting: a fresh cgroup2 instance the demoted
# candidate can never write, so memory.peak is kernel-owned and monotone for
# each measurement leaf's lifetime.
CGROUP_ROOT = Path("/tmp/hone-node-url-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10
CLONE_NEWIPC = 0x08000000
PR_SET_CHILD_SUBREAPER = 36
PR_SET_NO_NEW_PRIVS = 38
CANDIDATE_WRITABLE_ROOTS = (Path("/tmp"), Path("/var/tmp"), Path("/dev/shm"))

MUTABLE_FILES = frozenset({
    "src/node_url.cc",
    "src/node_url.h",
    "lib/internal/url.js",
    "deps/ada/ada.cpp",
    "deps/ada/ada.h",
    "deps/ada/ada_c.h",
})

READY_MARKER = b"HONE_DRIVER_READY\n"
DRIVER_RE = re.compile(rb"HONE_DRIVER_OK (\S+) (\d+) (\d+) (\d+)")
BENCH_MODES = frozenset({"url-parse", "sp-parse", "sp-serialize"})
EXPECTED_WORKLOAD_FIELDS = frozenset({
    "version",
    "split",
    "family",
    "provenance",
    "memoryTolerance",
    "cells",
    "urls",
    "searchParams",
})


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def safe_detail(detail: str) -> str:
    return detail.replace(str(ASSETS), "<sealed-assets>").replace(str(WORKSPACE), "<workspace>")[:1200]


def emit_failure(detail: str, result_hash: str = "") -> None:
    message = safe_detail(detail)
    output = {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": {
            "tests_pass": False,
            "exact_outputs_pass": False,
            "memory_pass": False,
        },
        "perExample": {"aggregate": {"score": 0.0, "feedback": message}},
        "diagnostics": {
            "summary": message,
            "quality": 0.0,
            "result_hash": result_hash or hashlib.sha256(message.encode()).hexdigest(),
        },
    }
    print(canonical(output))


def demote() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (12 << 30, 12 << 30))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


# ---------------------------------------------------------------------------
# Subreaper + full candidate-tree reaping (REAP).
# ---------------------------------------------------------------------------
def become_subreaper() -> None:
    """Adopt orphaned candidate descendants so detached/new-session children
    reparent here instead of pid 1 and can be waited on."""
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    except (OSError, AttributeError):
        pass


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
        if uid == SANDBOX_UID:
            pids[int(entry.name)] = zombie
    return pids


def reap_candidate_processes() -> None:
    """Kill and reap every candidate-uid process until none remain."""
    if os.geteuid() != 0:
        return
    deadline = time.monotonic() + 5.0
    while True:
        pids = _candidate_pids()
        if not any(not zombie for zombie in pids.values()):
            while pids:
                try:
                    reaped, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if reaped == 0:
                    break
                pids.pop(reaped, None)
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


def clear_candidate_writable() -> None:
    """Purge candidate-owned residue from every candidate-writable root."""
    for root in CANDIDATE_WRITABLE_ROOTS:
        try:
            entries = list(root.iterdir())
        except OSError:
            continue
        for path in entries:
            try:
                if path.lstat().st_uid != SANDBOX_UID:
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


# ---------------------------------------------------------------------------
# Trusted measurement cgroup (CG).
# ---------------------------------------------------------------------------
def mount_measurement_cgroup() -> None:
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "cgroup2", "-o", "nosuid,nodev,noexec", "hone-node-url-cg", str(CGROUP_ROOT)],
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
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Build / test worker.
# ---------------------------------------------------------------------------
def parse_worker(completed: subprocess.CompletedProcess[bytes], action: str) -> dict:
    try:
        payload = json.loads(completed.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise GateFailure(f"{action} worker returned malformed output") from error
    if completed.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
        detail = payload.get("detail") if isinstance(payload, dict) else None
        raise GateFailure(f"{action} gate failed: {str(detail or 'worker failure')[:700]}")
    return payload


def run_worker(action: str, *arguments: str) -> dict:
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(WORKER), action, *arguments],
            cwd=TRUSTED_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=650,
            check=False,
            preexec_fn=demote,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise GateFailure(f"{action} worker failed: {error}") from error
    finally:
        reap_candidate_processes()
        clear_candidate_writable()
    return parse_worker(completed, action)


def file_sha256(path: Path) -> bytes:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").digest()


def check_source_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    trusted_paths = {
        path.relative_to(TRUSTED_DIR).as_posix(): path
        for path in TRUSTED_DIR.rglob("*")
        if path.is_file()
    }
    for path in WORKSPACE.rglob("*"):
        relative = path.relative_to(WORKSPACE).as_posix()
        if relative in {".git", ".gitdir"} or relative.startswith((".git/", ".gitdir/")):
            raise GateFailure("repository metadata is forbidden in the candidate")
        if path.is_symlink() and relative in MUTABLE_FILES:
            raise GateFailure(f"mutable source must be a regular file: {relative}")
        if not path.is_file():
            continue
        if relative in MUTABLE_FILES:
            continue
        trusted = trusted_paths.get(relative)
        if trusted is None:
            raise GateFailure(f"file outside mutable source envelope: {relative}")
        if file_sha256(path) != file_sha256(trusted):
            raise GateFailure(f"protected source file changed: {relative}")
    for relative in MUTABLE_FILES:
        path = WORKSPACE / relative
        if path.is_symlink() or not path.is_file():
            raise GateFailure(f"required mutable source file is missing: {relative}")


def copy_reference_binary() -> None:
    """Copy the pristine baseline node binary out of /opt/node BEFORE the
    candidate mutable files are prepared into it. Must run before
    run_worker('prepare'); afterwards /opt/node holds the candidate build."""
    if not NODE.is_file():
        raise GateFailure("pristine reference binary is missing before prepare")
    REFERENCE_ROOT.mkdir(mode=0o755, exist_ok=False)
    shutil.copy2(NODE, REFERENCE_NODE)
    os.chmod(REFERENCE_ROOT, 0o755)
    os.chmod(REFERENCE_NODE, 0o755)


def load_workload() -> tuple[dict, str]:
    paths = sorted(ASSETS.rglob("workload.json"))
    if len(paths) != 1:
        raise GateFailure("selected asset group must contain exactly one workload")
    try:
        raw = paths[0].read_bytes()
        workload = json.loads(raw)
    except (OSError, ValueError) as error:
        raise GateFailure("sealed workload is malformed") from error
    if not isinstance(workload, dict) or set(workload) != EXPECTED_WORKLOAD_FIELDS:
        raise GateFailure("sealed workload has an invalid schema")
    if workload["version"] != 1 or workload["split"] not in {"train", "validation"}:
        raise GateFailure("sealed workload identity is invalid")
    if workload["family"] not in {"train", "validation"}:
        raise GateFailure("sealed workload family is invalid")
    if not isinstance(workload["provenance"], str) or "benchmark/url" not in workload["provenance"]:
        raise GateFailure("sealed workload provenance is invalid")
    tol = workload["memoryTolerance"]
    if not isinstance(tol, (int, float)) or not (0.0 < float(tol) <= 0.25):
        raise GateFailure("sealed memory tolerance is invalid")
    cells = workload["cells"]
    if not isinstance(cells, list) or not (1 <= len(cells) <= 16):
        raise GateFailure("sealed benchmark cells are invalid")
    seen_cells: set[str] = set()
    for cell in cells:
        if not isinstance(cell, dict) or set(cell) != {"id", "mode", "count"}:
            raise GateFailure("sealed benchmark cell schema is invalid")
        if not isinstance(cell["id"], str) or cell["id"] in seen_cells:
            raise GateFailure("sealed benchmark cell identity is invalid")
        if cell["mode"] not in BENCH_MODES:
            raise GateFailure("sealed benchmark cell mode is invalid")
        if not isinstance(cell["count"], int) or not (100 <= cell["count"] <= 50_000_000):
            raise GateFailure("sealed benchmark cell count is invalid")
        seen_cells.add(cell["id"])
    for key, expected_field in (("urls", "expectedHref"), ("searchParams", "expected")):
        rows = workload[key]
        if not isinstance(rows, list) or len(rows) != 4:
            raise GateFailure(f"sealed {key} workload must contain four cases")
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"id", expected_field}:
                raise GateFailure(f"sealed {key} row is invalid")
            if not isinstance(row["id"], str) or not isinstance(row[expected_field], str) or row["id"] in seen:
                raise GateFailure(f"sealed {key} identity is invalid")
            seen.add(row["id"])
    return workload, hashlib.sha256(raw).hexdigest()


def run_exact_output_gate(workload: dict) -> dict:
    # ORACLE-PARENT: ship only input identities; the sealed expected outputs
    # never leave the trusted parent, so candidate code that wraps
    # JSON.parse/readFileSync has nothing to capture and echo back.
    request = {
        "withBase": False,
        "urls": [{"id": row["id"]} for row in workload["urls"]],
        "searchParams": [{"id": row["id"]} for row in workload["searchParams"]],
    }
    try:
        completed = subprocess.run(
            [str(NODE), str(EXACT_OUTPUT)],
            cwd=TRUSTED_DIR,
            input=canonical(request).encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
            preexec_fn=demote,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise GateFailure(f"exact-output worker failed: {error}") from error
    finally:
        reap_candidate_processes()
        clear_candidate_writable()
    try:
        payload = json.loads(completed.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise GateFailure("exact-output worker returned malformed output") from error
    if completed.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
        raise GateFailure("exact serialized output gate failed")
    expected_urls = {row["id"]: row["expectedHref"] for row in workload["urls"]}
    expected_params = {row["id"]: row["expected"] for row in workload["searchParams"]}
    if payload.get("urls") != expected_urls or payload.get("searchParams") != expected_params:
        raise GateFailure("exact serialized output mismatch")
    return {"urls": payload["urls"], "searchParams": payload["searchParams"]}


# ---------------------------------------------------------------------------
# Timed benchmark legs (LEG).
# ---------------------------------------------------------------------------
class LegResult:
    __slots__ = ("elapsed_ns", "acc", "heap_used", "tree_peak")

    def __init__(self, elapsed_ns: int, acc: int, heap_used: int, tree_peak: int) -> None:
        self.elapsed_ns = elapsed_ns
        self.acc = acc
        self.heap_used = heap_used
        self.tree_peak = tree_peak


def _read_line(fd: int, deadline: float) -> bytes:
    """Read a single '\\n'-terminated line with a wall-clock deadline. A pre-JS
    drain of the go channel makes the driver block without emitting readiness or
    a receipt; that stalls this read until the deadline and fails the leg."""
    buffer = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GateFailure("benchmark leg timed out awaiting driver output")
        ready, _, _ = select.select([fd], [], [], min(0.5, remaining))
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except BlockingIOError:
            continue
        except OSError as exc:
            raise GateFailure("benchmark leg control channel failed") from exc
        if not chunk:
            raise GateFailure("benchmark leg closed control channel early")
        buffer.extend(chunk)
        nl = buffer.find(0x0a)
        if nl >= 0:
            return bytes(buffer[: nl + 1])
        if len(buffer) > 65536:
            raise GateFailure("benchmark leg emitted an oversized control line")


def run_leg(node_bin: Path, cell: dict, count: int, family: str, nonce: str) -> LegResult:
    """One timed leg. The parent forks the driver, waits for its JS-top-level
    readiness marker, starts the monotonic clock as it releases the go nonce,
    and stops the clock on the nonce-authenticated receipt. The receipt folds
    every per-iteration output over the go-nonce-derived input stream, so the
    measured window necessarily contains the real URL work; the driver holds no
    clock of its own to rewrite, and no correct fold exists before the nonce."""
    leaf = CGROUP_ROOT / f"bench-{secrets.token_hex(8)}"
    leaf.mkdir(mode=0o755, exist_ok=False)
    leaf_procs = leaf / "cgroup.procs"
    scratch = Path(tempfile.mkdtemp(prefix="hone-node-url-"))
    home = scratch / "home"
    home.mkdir()
    os.chmod(scratch, 0o777)
    os.chmod(home, 0o777)

    go_read, go_write = os.pipe()
    receipt_read, receipt_write = os.pipe()
    os.set_inheritable(go_read, True)
    os.set_inheritable(receipt_write, True)

    env = dict(os.environ)
    env.update({
        "HOME": str(home),
        "TMPDIR": str(scratch),
        "NODE_TEST_NO_INTERNET": "1",
        "NO_COLOR": "1",
        "HONE_GO_FD": str(go_read),
        "HONE_RECEIPT_FD": str(receipt_write),
    })

    libc = ctypes.CDLL(None, use_errno=True)

    def preexec() -> None:
        os.setsid()
        with open(leaf_procs, "w") as handle:
            handle.write("0")
        if libc.unshare(CLONE_NEWIPC) != 0:
            os._exit(126)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
        resource.setrlimit(resource.RLIMIT_AS, (12 << 30, 12 << 30))
        if os.geteuid() == 0:
            os.setgroups([])
            os.setgid(SANDBOX_UID)
            os.setuid(SANDBOX_UID)
            if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
                os._exit(126)

    receipt = b""
    stderr = b""
    returncode = -1
    leftover = ""
    tree_peak_text = "0"
    elapsed_ns = 0
    deadline = time.monotonic() + LEG_TIMEOUT_SEC
    process = None
    try:
        try:
            process = subprocess.Popen(
                [str(node_bin), str(BENCH_DRIVER), cell["mode"], cell["id"], str(count), family],
                cwd=scratch,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=preexec,
                pass_fds=(go_read, receipt_write),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise GateFailure(f"benchmark process failed: {exc}") from exc
        os.close(go_read)
        go_read = -1
        os.close(receipt_write)
        receipt_write = -1

        # Readiness: emitted from JS top level, before the clock and the nonce.
        ready = _read_line(receipt_read, deadline)
        if ready != READY_MARKER:
            raise GateFailure(f"benchmark cell {cell['id']} did not emit the readiness marker")

        # Clock-start: release the go nonce, then time to the receipt line.
        started = time.monotonic_ns()
        os.write(go_write, f"{nonce}\n".encode())
        os.close(go_write)
        go_write = -1
        receipt = _read_line(receipt_read, deadline)
        elapsed_ns = time.monotonic_ns() - started

        try:
            _, stderr = process.communicate(timeout=PROCESS_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                process.kill()
            try:
                process.communicate(timeout=15)
            except (OSError, subprocess.SubprocessError):
                pass
            raise GateFailure("benchmark process exceeded its wall-clock budget") from None
        returncode = process.returncode
        try:
            leftover = leaf_procs.read_text().strip()
            tree_peak_text = (leaf / "memory.peak").read_text().strip()
        except OSError as exc:
            raise GateFailure("trusted memory accounting could not be read") from exc
    finally:
        for descriptor in (go_read, go_write, receipt_read, receipt_write):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
        drain_measurement_leaf(leaf)
        reap_candidate_processes()
        clear_candidate_writable()
        shutil.rmtree(scratch, ignore_errors=True)

    if returncode != 0:
        tail = stderr.decode("utf-8", "replace")[-300:]
        raise GateFailure(f"benchmark cell {cell['id']} exited with {returncode}: {tail}")
    if leftover:
        raise GateFailure(f"benchmark cell {cell['id']} left live descendant processes")

    match = DRIVER_RE.search(receipt)
    if match is None:
        raise GateFailure(f"benchmark cell {cell['id']} did not deliver the trusted receipt")
    if match.group(1).decode("ascii", "replace") != nonce:
        raise GateFailure(f"benchmark cell {cell['id']} receipt nonce mismatch")
    processed = int(match.group(2))
    acc = int(match.group(3))
    heap_used = int(match.group(4))
    if processed != count:
        raise GateFailure(f"benchmark cell {cell['id']} iteration count mismatch")
    if heap_used <= 0:
        raise GateFailure(f"benchmark cell {cell['id']} reported a non-positive heap measurement")
    if elapsed_ns <= 0:
        raise GateFailure(f"benchmark cell {cell['id']} clock resolution failure")
    try:
        tree_peak = int(tree_peak_text)
    except ValueError as exc:
        raise GateFailure("trusted memory accounting returned malformed output") from exc
    if tree_peak <= 0:
        raise GateFailure("trusted memory accounting returned a non-positive peak")
    return LegResult(elapsed_ns, acc, heap_used, tree_peak)


def run_benchmark_cell(cell: dict, family: str) -> tuple[float, int, int, int, int]:
    """Drift-cancelling throughput for one cell. Each rep runs the pristine
    reference leg and the candidate leg BACK-TO-BACK on the SAME go nonce; the
    cell throughput is min(reference_ns) / min(candidate_ns) over the timed reps.
    The shared Docker VM carries permanent ambient contention (the omp git
    poller plus unrelated user containers) that only ever ADDS time, and it is
    differential across paired legs, so the per-binary minimum -- the least-
    contended sample of each binary -- is the robust estimator for these ~1s
    legs (round-4 doctrine; paired ratios cannot cancel differential load). A
    discarded warm rep settles page cache and JIT, and every rep's output fold
    must equal the reference's fold over the identical nonce-derived stream."""
    count = int(cell["count"])
    reference_ns: list[int] = []
    candidate_ns: list[int] = []
    cand_peak = 0
    ref_peak = 0
    for rep in range(1 + BENCH_TIMED_REPS):
        nonce = secrets.token_hex(16)
        ref = run_leg(REFERENCE_NODE, cell, count, family, nonce)
        cand = run_leg(NODE, cell, count, family, nonce)
        if cand.acc != ref.acc:
            raise GateFailure(
                f"benchmark cell {cell['id']} output disagrees with the trusted reference"
            )
        if rep > 0:
            reference_ns.append(ref.elapsed_ns)
            candidate_ns.append(cand.elapsed_ns)
            cand_peak = max(cand_peak, cand.tree_peak)
            ref_peak = max(ref_peak, ref.tree_peak)
    min_ref = min(reference_ns)
    min_cand = min(candidate_ns)
    cell_ratio = min_ref / min_cand
    if not math.isfinite(cell_ratio) or cell_ratio <= 0:
        raise GateFailure(f"benchmark cell {cell['id']} produced a non-finite ratio")
    return cell_ratio, cand_peak, ref_peak, min_ref, min_cand


def geometric_mean(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("cannot scalarize invalid benchmark throughput")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def main() -> None:
    become_subreaper()
    started = time.monotonic()
    result_hash = ""
    cgroup_mounted = False
    try:
        check_source_envelope()
        workload, workload_hash = load_workload()
        # Snapshot the pristine reference BEFORE the candidate is built in.
        copy_reference_binary()
        run_worker("prepare", str(WORKSPACE))
        build = run_worker("build")
        tests = run_worker("test")
        exact = run_exact_output_gate(workload)

        mount_measurement_cgroup()
        cgroup_mounted = True

        family = workload["family"]
        cells = workload["cells"]
        # One discarded warmup leg (reference binary) charges cold caches.
        run_leg(REFERENCE_NODE, cells[0], int(cells[0]["count"]), family, secrets.token_hex(16))

        ratios: list[float] = []
        cell_timings: dict[str, dict[str, float]] = {}
        max_cand_peak = 0
        max_ref_peak = 0
        for cell in cells:
            ratio, cand_peak, ref_peak, min_ref, min_cand = run_benchmark_cell(cell, family)
            ratios.append(ratio)
            cell_timings[cell["id"]] = {
                "ratio": round(ratio, 6),
                "min_ref_ms": round(min_ref / 1e6, 3),
                "min_cand_ms": round(min_cand / 1e6, 3),
            }
            max_cand_peak = max(max_cand_peak, cand_peak)
            max_ref_peak = max(max_ref_peak, ref_peak)

        tol = float(workload["memoryTolerance"])
        rss_limit = int(max_ref_peak * (1.0 + tol))
        if max_cand_peak > rss_limit:
            raise GateFailure(
                "whole-tree memory gate failed: candidate peak exceeds pristine reference plus tolerance"
            )

        score = REFERENCE_NORMALIZATION * geometric_mean(ratios)
        identity = {
            "sourceRevision": "9df0e9b4d4a5be5ce7506fae44acb6667bb68d6b",
            "split": workload["split"],
            "family": family,
            "workloadSha256": workload_hash,
            "exactOutputs": exact,
            "tests": "parallel/test-url*+parallel/test-whatwg-url*",
            "benchmarkCells": [cell["id"] for cell in cells],
        }
        result_hash = hashlib.sha256(canonical(identity).encode()).hexdigest()
        elapsed = time.monotonic() - started
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "exact_outputs_pass": True,
                "memory_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": (
                        f"{len(ratios)} reference-yardstick benchmark cells passed all hard gates; "
                        f"q={score:.3f} (reference-normalized min-of-{BENCH_TIMED_REPS} "
                        f"reference/candidate wall-clock ratio)"
                    ),
                }
            },
            "diagnostics": {
                "summary": "WHATWG URL tests, exact serialization, reference-fold correctness, and whole-tree RSS gates passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(float(build.get("seconds", 0.0)), 6),
                "test_sec": round(float(tests.get("seconds", 0.0)), 6),
                "eval_sec": round(elapsed, 6),
                "max_cand_tree_peak_bytes": max_cand_peak,
                "max_ref_tree_peak_bytes": max_ref_peak,
                "benchmark_cells": len(ratios),
                "raw_ratio": geometric_mean(ratios),
                "cell_timings": cell_timings,
            },
        }
        print(canonical(output))
    except (GateFailure, OSError, ValueError) as error:
        emit_failure(str(error), result_hash)
    finally:
        if cgroup_mounted:
            reap_candidate_processes()
            unmount_measurement_cgroup()


if __name__ == "__main__":
    main()
