#!/usr/bin/env python3
"""Trusted test-record conductor for OSS-T08.

The evaluator parent (eval.py) never hands the candidate-executed pytest
process a file descriptor that reaches the trusted side. Instead it launches
THIS conductor as the sandboxed command. The conductor is trusted code
(protected, reconstructed from the frozen baseline seed), and it alone holds
the parent-owned record channel. Candidate-linked code loaded later by pytest
(the native extension) runs in a *different* process whose only reporting
channel is an inner pipe the conductor treats as untrusted input.

Ownership chain:

    eval.py (root, host ns)
      └─ os.pipe() -> parent-owned record channel; parent holds the read end
         and passes ONLY the write end to the conductor via pass_fds
           └─ conductor (uid 2000, fresh NET/IPC/PID/UTS ns via worker_preexec)
              · PR_SET_DUMPABLE=0  -> same-uid candidate code cannot ptrace it
                or read /proc/<pid>/fd, so the parent channel is unreachable
              · sets FD_CLOEXEC on the parent channel and scrubs its env, so
                pytest and every candidate subprocess it spawns never inherit it
              · mints a fresh unguessable per-run nonce and feeds it to the
                trusted report-sink plugin over a one-shot pipe the plugin
                consumes BEFORE any candidate code is imported
                └─ pytest (uid 2000) -> trusted plugin emits `H\t<nonce>` then
                   one P/S/F record per test to the inner pipe

The conductor authenticates the stream (the header must carry the exact nonce,
which only the trusted plugin could have read from the consumed one-shot pipe),
owns the session boundary (pytest's real exit code, observed here, not a
candidate-emitted session record), and relays only the per-test records plus
its own authenticated trailer to the parent. A stub that blindly writes
fabricated records to the advertised channel cannot produce the nonce and gains
nothing; the residual is full in-process interpreter compromise scraping the
plugin's live memory for the nonce, which is out of scope for a record channel.
"""
from __future__ import annotations

import base64
import ctypes
import fcntl
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time

PR_SET_DUMPABLE = 4
MAX_RECORD_BYTES = 4_000_000
_LIBC = ctypes.CDLL(None, use_errno=True)


def _fail(message: str) -> None:
    sys.stderr.write(f"test_conductor: {message}\n")
    raise SystemExit(3)


def _set_cloexec(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFD)
    fcntl.fcntl(fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)


def main() -> None:
    # Sever same-uid reach from candidate code (ptrace, /proc/<pid>/fd, /proc/<pid>/mem)
    # to this process's private parent channel and memory BEFORE anything else.
    if _LIBC.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        _fail(f"cannot clear dumpable flag: {os.strerror(code)}")

    try:
        out_fd = int(os.environ["HONE_CONDUCTOR_OUT_FD"])
        pytest_argv = json.loads(os.environ["HONE_PYTEST_ARGV"])
        site = os.environ["HONE_SITE"]
        trusted_dir = os.environ["HONE_TRUSTED_DIR"]
        deadline_sec = float(os.environ["HONE_CONDUCTOR_DEADLINE"])
    except (KeyError, ValueError) as exc:
        _fail(f"missing/invalid conductor configuration: {exc}")
    extension_fd_raw = os.environ.get("HONE_EXTENSION_FD")
    if not isinstance(pytest_argv, list) or not all(isinstance(a, str) for a in pytest_argv):
        _fail("HONE_PYTEST_ARGV is not a string list")

    # The parent record channel must never survive into the candidate process.
    _set_cloexec(out_fd)

    # Fresh, unguessable per-run authenticator for the trusted plugin.
    nonce = secrets.token_hex(32).encode("ascii")

    inner_r, inner_w = os.pipe()
    nonce_r, nonce_w = os.pipe()
    os.write(nonce_w, nonce + b"\n")
    os.close(nonce_w)

    child_env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("HONE_")
    }
    child_env["PYTHONPATH"] = f"{site}:{trusted_dir}"
    child_env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    child_env["ORJSON_REPORT_FD"] = str(inner_w)
    child_env["ORJSON_REPORT_NONCE_FD"] = str(nonce_r)

    pass_fds = [inner_w, nonce_r]
    if extension_fd_raw is not None:
        try:
            pass_fds.append(int(extension_fd_raw))
        except ValueError:
            _fail("HONE_EXTENSION_FD is not an integer")

    stderr_file = tempfile.TemporaryFile(dir="/tmp")
    try:
        proc = subprocess.Popen(
            pytest_argv,
            cwd=trusted_dir,
            env=child_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=stderr_file,
            pass_fds=tuple(pass_fds),
            start_new_session=True,
        )
    except OSError as exc:
        _fail(f"cannot launch pytest: {exc}")
    finally:
        os.close(inner_w)
        os.close(nonce_r)

    collected = bytearray()
    truncated = False

    def drain() -> None:
        nonlocal truncated
        while True:
            try:
                chunk = os.read(inner_r, 65536)
            except OSError:
                return
            if not chunk:
                return
            if len(collected) < MAX_RECORD_BYTES:
                collected.extend(chunk)
            else:
                truncated = True

    drainer = threading.Thread(target=drain, daemon=True)
    drainer.start()

    child_exit: int
    try:
        proc.wait(timeout=deadline_sec)
        child_exit = proc.returncode
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        child_exit = 124
    finally:
        # Records only count within the child's lifetime. Once every write end
        # (child + any descendant that inherited the inner pipe) is closed the
        # drain sees EOF; a lingering writer is bounded by our own deadline.
        drainer.join(timeout=min(10.0, max(1.0, deadline_sec)))

    lines = bytes(collected).split(b"\n")
    if lines and lines[-1] == b"":
        lines.pop()

    nonce_ok = bool(lines) and lines[0] == b"H\t" + nonce
    records = lines[1:] if nonce_ok else []

    detail_b64 = ""
    if child_exit != 0 or not nonce_ok:
        try:
            stderr_file.seek(0)
            tail = stderr_file.read()[-2000:]
        except OSError:
            tail = b""
        if tail:
            detail_b64 = base64.b64encode(tail).decode("ascii")
    stderr_file.close()

    out = bytearray()
    for record in records:
        out.extend(record)
        out.extend(b"\n")
    out.extend(
        b"C\t%d\t%d\t%d\t%s\n"
        % (
            child_exit,
            1 if (nonce_ok and not truncated) else 0,
            len(records),
            detail_b64.encode("ascii"),
        )
    )
    view = memoryview(out)
    offset = 0
    while offset < len(view):
        try:
            offset += os.write(out_fd, view[offset:])
        except OSError:
            break
    os.close(out_fd)


if __name__ == "__main__":
    main()
