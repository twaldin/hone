#!/usr/bin/env python3
"""Trusted evaluator for nodejs/node WHATWG URL throughput."""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import re
import resource
import secrets
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
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 180
MIN_MARGINAL_SEC = 0.01
SAMPLES_PER_SCALE = 2
BOOST = 8

# Trusted whole-tree memory accounting: a fresh cgroup2 instance the demoted
# candidate can never write, so memory.peak is kernel-owned and monotone for
# each measurement leaf's lifetime (unlike GNU time %M of the direct node).
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

DRIVER_RE = re.compile(rb"HONE_DRIVER_OK (\S+) (\d+) (\d+) (\d+) (\d+)")
EXPECTED_WORKLOAD_FIELDS = frozenset({
    "version",
    "split",
    "provenance",
    "urlParseExponent",
    "urlPropertiesExponent",
    "searchParamsIterations",
    "baselineMemory",
    "withBase",
    "urls",
    "searchParams",
})

# Trusted rolling-checksum ring shared with bench_driver.js. MOD is prime and
# (MULT-1) is a unit mod MOD, so a per-iteration fold has a closed form the
# trusted parent recomputes from the sealed expected observation.
DIGEST_MOD = 2147483647
DIGEST_MULT = 48271
DIGEST_POLY = 257
CONTENT_SAMPLES = 64


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
    """Kill and reap every candidate-uid process until none remain.

    killpg alone misses detached/new-session descendants and a plain SIGKILL
    sweep leaves zombies pinned by dead parents; as subreaper this process
    inherits those orphans, so loop until a /proc scan finds no candidate-uid
    process at all (bounded by a hard deadline)."""
    if os.geteuid() != 0:
        return
    deadline = time.monotonic() + 5.0
    while True:
        pids = _candidate_pids()
        if not any(not zombie for zombie in pids.values()):
            # Drain any inherited zombies before returning.
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
    """Purge candidate-owned residue from every candidate-writable root so
    nothing a launch stashed under /tmp, /var/tmp, or /dev/shm (including POSIX
    shm) survives into the next launch."""
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
    # Docker mounts the container cgroup2 view read-only, but the trusted
    # evaluator holds mount authority (CAP_SYS_ADMIN): a fresh cgroup2 instance
    # over the namespaced hierarchy is writable by root only.
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
        # cgroup v2 no-internal-process rule: park the evaluator (and every
        # worker it forks) in a trusted leaf so the memory controller can be
        # delegated to the per-launch measurement leaves.
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
    # Kill every process still charged to the leaf (detached descendants in new
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
        # Reap and purge whatever the unprivileged worker tree left behind.
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
    # Sanitized candidate workspaces intentionally omit protected baseline
    # files (the trusted copies are mounted separately at TRUSTED_DIR), so
    # absence of a protected file is expected. Only the mutable envelope must
    # be present; any protected file that IS present must match byte for byte.
    for relative in MUTABLE_FILES:
        path = WORKSPACE / relative
        if path.is_symlink() or not path.is_file():
            raise GateFailure(f"required mutable source file is missing: {relative}")


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
    if not isinstance(workload["provenance"], str) or "benchmark/url" not in workload["provenance"]:
        raise GateFailure("sealed workload provenance is invalid")
    if workload["urlParseExponent"] != 12 or workload["urlPropertiesExponent"] != 11:
        raise GateFailure("sealed URL benchmark scale is invalid")
    if workload["searchParamsIterations"] != 1_000_000 or not isinstance(workload["withBase"], bool):
        raise GateFailure("sealed SearchParams benchmark scale is invalid")
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
    memory = workload["baselineMemory"]
    memory_fields = {"heapUsedBytes", "rssBytes", "limitHeapUsedBytes", "limitRssBytes"}
    if not isinstance(memory, dict) or set(memory) != memory_fields:
        raise GateFailure("sealed memory baseline is invalid")
    if any(not isinstance(memory[field], int) or memory[field] <= 0 for field in memory_fields):
        raise GateFailure("sealed memory values are invalid")
    if memory["limitHeapUsedBytes"] != memory["heapUsedBytes"] * 102 // 100:
        raise GateFailure("sealed heap limit is not baseline plus two percent")
    if memory["limitRssBytes"] != memory["rssBytes"] * 102 // 100:
        raise GateFailure("sealed RSS limit is not baseline plus two percent")
    return workload, hashlib.sha256(raw).hexdigest()


def run_exact_output_gate(workload: dict) -> dict:
    # ORACLE-PARENT: ship only input identities + withBase; the sealed expected
    # outputs never leave the trusted parent, so candidate code that wraps
    # JSON.parse/readFileSync has nothing to capture and echo back.
    request = {
        "withBase": workload["withBase"],
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


def benchmark_cells(workload: dict) -> list[dict]:
    """16 trusted-driver cells, each timed at a base and an 8x scale.

    The trusted bench_driver.js owns the measurement loop; the candidate URL
    code only influences the per-op output, which the driver folds into two
    parent-verifiable accumulators. Throughput is the marginal wall-clock
    between the fastest base-scale and fastest 8x-scale runs, so startup and
    setup costs cancel and candidate-emitted stdout is never a timing source.
    Because EVERY timed scale is bound to the sealed expected observation, a
    scale-selective cheap-wrong path cannot pass unnoticed (SCALE-BIND).
    """
    parse_base = 200 * (2 ** workload["urlParseExponent"])
    href_base = 200 * (2 ** workload["urlPropertiesExponent"])
    sp_base = workload["searchParamsIterations"]
    cells: list[dict] = []
    for row in workload["urls"]:
        cells.append({
            "id": f"url-parse:{row['id']}",
            "mode": "parse",
            "input_id": row["id"],
            "expected": row["expectedHref"],
            "base": parse_base,
            "boosted": parse_base * BOOST,
        })
        cells.append({
            "id": f"url-href:{row['id']}",
            "mode": "href",
            "input_id": row["id"],
            "expected": row["expectedHref"],
            "base": href_base,
            "boosted": href_base * BOOST,
        })
    for row in workload["searchParams"]:
        for mode in ("sp-parse", "sp-serialize"):
            cells.append({
                "id": f"searchparams-{mode.split('-')[1]}:{row['id']}",
                "mode": mode,
                "input_id": row["id"],
                "expected": row["expected"],
                "base": sp_base,
                "boosted": sp_base * BOOST,
            })
    return cells


def _poly_hash(text: str) -> int:
    h = 0
    for ch in text:
        h = (h * DIGEST_POLY + ord(ch)) % DIGEST_MOD
    return h


def _closed_form_acc(term: int, n: int) -> int:
    # acc_n = term * (MULT^n - 1) / (MULT - 1) mod MOD, for the recurrence
    # acc_i = acc_{i-1} * MULT + term (acc_0 = 0). MOD prime, MULT-1 a unit.
    numer = (pow(DIGEST_MULT, n, DIGEST_MOD) - 1) % DIGEST_MOD
    inv = pow(DIGEST_MULT - 1, DIGEST_MOD - 2, DIGEST_MOD)
    return (term % DIGEST_MOD) * numer % DIGEST_MOD * inv % DIGEST_MOD


def expected_digest(expected_output: str, count: int) -> tuple[int, int]:
    sample_count = min(CONTENT_SAMPLES, count)
    len_acc = _closed_form_acc(len(expected_output), count)
    content_acc = _closed_form_acc(_poly_hash(expected_output), sample_count)
    return len_acc, content_acc


def run_driver(cell: dict, count: int, withbase: str) -> tuple[float, int, int]:
    """One trusted-driver child, timed on the trusted parent's monotonic clock
    inside a fresh cgroup measurement leaf and IPC namespace, then fully reaped.

    Returns (elapsed_seconds, heap_used_bytes, tree_peak_rss_bytes). Raises
    GateFailure unless the nonce-authenticated checksum line matches the sealed
    expected observation for the cell at this scale.
    """
    leaf = CGROUP_ROOT / f"bench-{secrets.token_hex(8)}"
    leaf.mkdir(mode=0o755, exist_ok=False)
    leaf_procs = leaf / "cgroup.procs"
    scratch = Path(tempfile.mkdtemp(prefix="hone-node-url-"))
    home = scratch / "home"
    home.mkdir()
    os.chmod(scratch, 0o777)
    os.chmod(home, 0o777)

    nonce = secrets.token_hex(16)
    challenge_read, challenge_write = os.pipe()
    receipt_read, receipt_write = os.pipe()
    os.set_inheritable(challenge_read, True)
    os.set_inheritable(receipt_write, True)
    os.write(challenge_write, f"{nonce}\n".encode())
    os.close(challenge_write)
    challenge_write = -1

    env = dict(os.environ)
    env.update({
        "HOME": str(home),
        "TMPDIR": str(scratch),
        "NODE_TEST_NO_INTERNET": "1",
        "NO_COLOR": "1",
        "HONE_CHALLENGE_FD": str(challenge_read),
        "HONE_RECEIPT_FD": str(receipt_write),
    })

    libc = ctypes.CDLL(None, use_errno=True)

    def preexec() -> None:
        os.setsid()
        # Join the measurement leaf while still root so the WHOLE candidate
        # process tree is charged to a cgroup the demoted uid can never write.
        with open(leaf_procs, "w") as handle:
            handle.write("0")
        # Fresh IPC namespace: SysV/POSIX segments cannot carry state between
        # launches (runs before the privilege drop).
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

    started = time.monotonic()
    receipt = bytearray()
    stderr = b""
    returncode = -1
    leftover = ""
    tree_peak_text = "0"
    try:
        try:
            process = subprocess.Popen(
                [str(NODE), str(BENCH_DRIVER), cell["mode"], cell["input_id"], str(count), withbase],
                cwd=SOURCE,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=preexec,
                pass_fds=(challenge_read, receipt_write),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise GateFailure(f"benchmark process failed: {exc}") from exc
        os.close(challenge_read)
        challenge_read = -1
        os.close(receipt_write)
        receipt_write = -1
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
        elapsed = time.monotonic() - started
        returncode = process.returncode
        while len(receipt) <= 4096:
            chunk = os.read(receipt_read, 4096)
            if not chunk:
                break
            receipt.extend(chunk)
        try:
            leftover = leaf_procs.read_text().strip()
            tree_peak_text = (leaf / "memory.peak").read_text().strip()
        except OSError as exc:
            raise GateFailure("trusted memory accounting could not be read") from exc
    finally:
        for descriptor in (challenge_read, challenge_write, receipt_read, receipt_write):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
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

    match = DRIVER_RE.search(bytes(receipt))
    if match is None:
        raise GateFailure(f"benchmark cell {cell['id']} did not deliver the trusted checksum")
    got_nonce = match.group(1).decode("ascii", "replace")
    processed = int(match.group(2))
    len_acc = int(match.group(3))
    content_acc = int(match.group(4))
    heap_used = int(match.group(5))
    if got_nonce != nonce:
        raise GateFailure(f"benchmark cell {cell['id']} checksum nonce mismatch")
    if processed != count:
        raise GateFailure(f"benchmark cell {cell['id']} iteration count mismatch")
    exp_len, exp_content = expected_digest(cell["expected"], count)
    if len_acc != exp_len or content_acc != exp_content:
        raise GateFailure(f"benchmark cell {cell['id']} produced incorrect output at its timed scale")
    if heap_used <= 0:
        raise GateFailure(f"benchmark cell {cell['id']} reported a non-positive heap measurement")
    try:
        tree_peak = int(tree_peak_text)
    except ValueError as exc:
        raise GateFailure("trusted memory accounting returned malformed output") from exc
    if tree_peak <= 0:
        raise GateFailure("trusted memory accounting returned a non-positive peak")
    return elapsed, heap_used, tree_peak


def run_benchmark(cell: dict, withbase: str) -> tuple[float, int, int]:
    """Trusted parent-side differential throughput for one driver cell.

    Each scale is sampled SAMPLES_PER_SCALE times and the FASTEST wall-clock is
    kept (host contention only ever adds time, so the minimum rejects slow
    outliers without giving candidate code any control). Every timed run is
    correctness-bound to the sealed expected observation; a cell only earns
    credit from a positive marginal strictly above MIN_MARGINAL_SEC.
    """
    base_walls: list[float] = []
    boosted_walls: list[float] = []
    heap_used = 0
    tree_rss = 0
    for _ in range(SAMPLES_PER_SCALE):
        base_elapsed, base_heap, base_tree = run_driver(cell, cell["base"], withbase)
        boosted_elapsed, _, _ = run_driver(cell, cell["boosted"], withbase)
        # Memory gates bind to base-scale runs only (the sealed baseline limits
        # were measured at exactly that scale). Ceiling across samples.
        heap_used = max(heap_used, base_heap)
        tree_rss = max(tree_rss, base_tree)
        base_walls.append(base_elapsed)
        boosted_walls.append(boosted_elapsed)
    marginal = min(boosted_walls) - min(base_walls)
    if marginal <= MIN_MARGINAL_SEC:
        raise GateFailure(
            f"benchmark cell {cell['id']} marginal wall-clock {marginal:.6f}s is not a "
            f"positive scale-dependent cost above the {MIN_MARGINAL_SEC}s floor"
        )
    extra_ops = cell["boosted"] - cell["base"]
    rate = extra_ops / marginal
    if not math.isfinite(rate) or rate <= 0:
        raise GateFailure("trusted benchmark produced non-finite throughput")
    return rate, heap_used, tree_rss


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
        run_worker("prepare", str(WORKSPACE))
        build = run_worker("build")
        tests = run_worker("test")
        exact = run_exact_output_gate(workload)

        mount_measurement_cgroup()
        cgroup_mounted = True

        withbase = "true" if workload["withBase"] else "false"
        cells = benchmark_cells(workload)
        # One discarded warmup run charges cold page-cache and volume costs
        # before any timed measurement.
        run_driver(cells[0], cells[0]["base"], withbase)

        rates: list[float] = []
        max_heap = 0
        max_rss = 0
        for cell in cells:
            rate, heap, rss = run_benchmark(cell, withbase)
            rates.append(rate)
            max_heap = max(max_heap, heap)
            max_rss = max(max_rss, rss)

        memory = workload["baselineMemory"]
        if max_heap > memory["limitHeapUsedBytes"]:
            raise GateFailure("heap-used gate failed: candidate exceeds baseline plus two percent")
        if max_rss > memory["limitRssBytes"]:
            raise GateFailure("RSS gate failed: candidate exceeds baseline plus two percent")

        score = geometric_mean(rates)
        identity = {
            "sourceRevision": "9df0e9b4d4a5be5ce7506fae44acb6667bb68d6b",
            "split": workload["split"],
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
                    "feedback": f"16 trusted-driver benchmark cells passed all hard gates; q={score:.3f} ops/s (trusted parent-side marginal wall-clock)",
                }
            },
            "diagnostics": {
                "summary": "WHATWG URL tests, exact serialization, and baseline+2% heap/whole-tree-RSS gates passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(float(build.get("seconds", 0.0)), 6),
                "test_sec": round(float(tests.get("seconds", 0.0)), 6),
                "eval_sec": round(elapsed, 6),
                "max_heap_used_bytes": max_heap,
                "max_rss_bytes": max_rss,
                "benchmark_cells": len(rates),
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
