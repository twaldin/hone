#!/usr/bin/env python3
"""Trusted candidate worker for the seeded-astar evaluator.

Runs as `python3 -I -B worker.py <workspace>`: imports the candidate's
astar.py from <workspace> and answers newline-delimited JSON requests on
stdin with newline-delimited JSON responses. The candidate executes ONLY in
this process; the scoring parent (eval.py) never imports candidate code.

Protocol (one JSON object per line):
  parent -> worker   {"id": "<nonce>", "grid": [...], "start": [r,c], "goal": [r,c]}
  worker -> parent   {"ready": true} | {"ready": false, "error": "..."}   (once, at start)
                     {"id": "<nonce>", "path": [[r,c],...] | null}
                     {"id": "<nonce>", "error": "..."}

Hardening inside this (compromisable) process:
  * The real stdout fd is duplicated to a private fd before candidate import
    and fd 1 is redirected to stderr — candidate print()/os.write(1) cannot
    reach the protocol channel by default.
  * References to json/os/stdin primitives are snapshotted before candidate
    import, so monkeypatching module attributes cannot corrupt the protocol.
  * Responses echo the parent's per-request random nonce; the parent
    fail-closes on any mismatch, extra bytes, oversize, or timeout.

None of this makes the child trustworthy — it only narrows its authority to
"raw answer bytes". The parent alone loads fixtures, times calls, checks
correctness, and computes scores.
"""

from __future__ import annotations

import json
import os
import sys
import traceback

MAX_PATH_CELLS = 5_000_000  # worker-side cap; the parent's byte cap is authoritative

# --- Snapshot trusted primitives BEFORE any candidate code can run. ---------
_dumps = json.dumps
_loads = json.loads
_write = os.write
_readline = sys.stdin.buffer.readline

# Private protocol fd: dup the real stdout, then point fd 1 at stderr so the
# candidate's stdout writes land in the diagnostic stream, not the protocol.
_PROTO_FD = os.dup(1)
os.dup2(2, 1)


def _send(obj: dict) -> None:
    data = (_dumps(obj, separators=(",", ":")) + "\n").encode()
    total = 0
    while total < len(data):
        total += _write(_PROTO_FD, data[total:])


def _normalize_path(result: object) -> list[list[int]] | None:
    if result is None:
        return None
    cells = list(result)  # type: ignore[arg-type] — candidate value, duck-typed
    if len(cells) > MAX_PATH_CELLS:
        raise ValueError(f"path too long ({len(cells)} cells)")
    return [[int(r), int(c)] for r, c in cells]


def main() -> None:
    workspace = sys.argv[1]
    sys.path.insert(0, workspace)
    try:
        import astar  # noqa: PLC0415 — the candidate module, child-process only

        find_path = astar.find_path
    except BaseException as exc:  # noqa: BLE001 — import is candidate code
        traceback.print_exc(file=sys.stderr)
        _send({"ready": False, "error": f"{type(exc).__name__}: {exc}"})
        return
    _send({"ready": True})

    while True:
        line = _readline()
        if not line:
            return
        req = _loads(line)
        req_id = req["id"]
        try:
            result = find_path(
                req["grid"], tuple(req["start"]), tuple(req["goal"])
            )
            _send({"id": req_id, "path": _normalize_path(result)})
        except BaseException as exc:  # noqa: BLE001 — candidate code may raise anything
            traceback.print_exc(file=sys.stderr)
            _send({"id": req_id, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
