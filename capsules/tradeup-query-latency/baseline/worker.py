#!/usr/bin/env python3
"""Two-stage protected adapter for one sealed latency sample.

The candidate query module is executed inside a forked inner child that owns
neither the evaluator protocol fd (its stdout is redirected to /dev/null) nor
the canonical serializer.  The child hands its result to this protected parent
over a private pipe; the parent — which never imports candidate code — is the
only process that holds the protocol fd, and it always materializes (re-parses)
and RE-SERIALIZES the result canonically.  A candidate therefore cannot stream
preformatted bytes to the evaluator, cannot return a sentinel to skip the
serialization path, and cannot rebind the emission primitives out from under
the harness: the fixed materialize+serialize cost is always paid inside the
timed window by code the candidate cannot reach.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

# Immutable serialization primitive, captured BEFORE any candidate code can be
# imported.  The parent uses this to canonicalize the result and the inner child
# uses it as an un-rebindable transport encoder.
_DUMPS = json.dumps
_PROTOCOL_FD = 1
MAX_RESPONSE_BYTES = int(os.environ.get("CAPSULE_MAX_RESPONSE_BYTES", "2000000"))


def _load_query(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("candidate_query", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("candidate query module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    run = getattr(module, "run", None)
    if not callable(run):
        raise TypeError("query.py must export callable run(connection, workload)")
    return run


def _run_candidate(query_path: Path, db_path: Path, workload: dict[str, Any], write_fd: int) -> None:
    """Inner child: execute candidate code and transport the raw result to the
    protected parent over ``write_fd``.  Anything the candidate does here is
    confined to this process; the transport encoding uses the captured pristine
    serializer so an honest result always crosses intact, and any bytes a
    candidate injects only corrupt its own payload (fail-closed at the parent)."""
    run = _load_query(query_path)
    uri = f"file:{db_path.as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True, isolation_level=None)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA cache_size=0")
        connection.execute("PRAGMA mmap_size=0")
        connection.execute("PRAGMA cache_spill=OFF")
        connection.execute("PRAGMA temp_store=MEMORY")
        result = run(connection, workload)
    finally:
        connection.close()
    payload = _DUMPS(result, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    with os.fdopen(write_fd, "wb", closefd=True) as stream:
        stream.write(payload)


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: worker.py QUERY DB WORKLOAD")
    query_path = Path(sys.argv[1]).resolve()
    db_path = Path(sys.argv[2]).resolve()
    workload_path = Path(sys.argv[3]).resolve()
    workload = json.loads(workload_path.read_text())

    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        # Inner child: candidate territory.  Sever the protocol fd so the
        # candidate can never write to the evaluator's stream, then run.
        try:
            os.close(read_fd)
            devnull = os.open(os.devnull, os.O_WRONLY)
            os.dup2(devnull, 1)
            if devnull != 1:
                os.close(devnull)
            _run_candidate(query_path, db_path, workload, write_fd)
        except BaseException:
            os._exit(17)
        os._exit(0)

    # Protected parent (adapter): the sole holder of the protocol fd.
    os.close(write_fd)
    chunks: list[bytes] = []
    total = 0
    truncated = False
    while True:
        chunk = os.read(read_fd, 65536)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            truncated = True
            break
        chunks.append(chunk)
    os.close(read_fd)
    _reaped, status = os.waitpid(pid, 0)
    if truncated or total == 0 or not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        raise SystemExit(1)
    result = json.loads(b"".join(chunks))
    encoded = _DUMPS({"result": result}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    os.write(_PROTOCOL_FD, (encoded + "\n").encode())


if __name__ == "__main__":
    main()
