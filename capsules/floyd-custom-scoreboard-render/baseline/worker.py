#!/usr/bin/env python3
"""Trusted fd-1-owning adapter for an M2 capsule candidate solution.py.

The candidate never runs in this process. This adapter owns fd 1 (the sole
protocol channel to the trusted parent evaluator) and captures its write and
serialization primitives before spawning anything; because it never imports
candidate code, those bindings stay trusted for the process lifetime. Candidate
execution lives in a SEPARATE candidate_runner.py child whose stdout is a
private pipe read only by this adapter, so the candidate cannot reach fd 1 and
cannot rebind this adapter's emit.

Per request the adapter forwards the scene/edits to the runner (never the
parent's envelope nonce, which the candidate therefore cannot author around),
then MATERIALIZES (parses the runner's bytes back into an object graph) and
SERIALIZES the canonical response itself, keyed with the nonce. Both the runner
and the adapter share the accounting cgroup and run inside the parent's timing
window, so the result-graph construction and JSON serialization that get scored
cannot be shed by a candidate that streams a pre-serialized envelope: the
adapter re-derives the object graph and re-serializes it from whatever bytes the
runner returns.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# Primitives captured up front. This process never imports candidate code, so
# these bindings cannot be rebound by anything the candidate controls.
_OS_WRITE = os.write
_JSON_DUMPS = json.dumps
_JSON_LOADS = json.loads

TRUSTED_DIR = Path(__file__).resolve().parent
RUNNER = TRUSTED_DIR / "candidate_runner.py"


def emit(value) -> None:
    _OS_WRITE(1, (_JSON_DUMPS(value, separators=(",", ":")) + "\n").encode())


class CandidateRunner:
    """The separate candidate-boundary child. Owns solution.py; its stdout is a
    private pipe to this adapter, never the parent's fd 1. It inherits the
    accounting cgroup, uid, and namespaces already established for this adapter,
    so its render work is charged to the same whole-tree memory.peak."""

    def __init__(self, workspace: Path) -> None:
        if not RUNNER.is_file():
            raise RuntimeError("candidate runner is missing")
        self.proc = subprocess.Popen(
            [sys.executable, "-I", "-B", str(RUNNER), str(workspace)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(TRUSTED_DIR),
        )

    def handshake(self) -> None:
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("candidate runner produced no handshake")
        ready = _JSON_LOADS(line)
        if not (isinstance(ready, dict) and ready.get("ready") is True):
            err = ready.get("error") if isinstance(ready, dict) else None
            raise RuntimeError(str(err or "candidate import failed"))

    def render(self, request: dict):
        """Forward one scene/edits request to the candidate; return the runner's
        result object, materialized (parsed) here in the trusted adapter."""
        payload = _JSON_DUMPS(request, separators=(",", ":")) + "\n"
        self.proc.stdin.write(payload.encode())
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("candidate runner died mid-frame")
        response = _JSON_LOADS(line)
        if not isinstance(response, dict):
            raise RuntimeError("candidate runner returned a non-object")
        if "error" in response:
            raise RuntimeError(str(response["error"]))
        if "result" not in response:
            raise RuntimeError("candidate runner returned no result")
        return response["result"]


def main() -> None:
    try:
        runner = CandidateRunner(Path(sys.argv[1]).resolve())
        runner.handshake()
    except BaseException as exc:
        emit({"ready": False, "error": f"{type(exc).__name__}: {exc}"})
        return
    emit({"ready": True})
    base_seen = False
    for raw in sys.stdin.buffer:
        request = None
        try:
            request = _JSON_LOADS(raw)
            nonce = request.get("id")
            if not isinstance(nonce, str):
                raise ValueError("request id missing")
            if "scene" in request:
                scene = request["scene"]
                if not isinstance(scene, dict) or not isinstance(scene.get("entries"), list):
                    raise ValueError("malformed scene")
                result = runner.render({"scene": scene})
                base_seen = True
            elif "edits" in request:
                if not base_seen:
                    raise ValueError("frame request before scene")
                result = runner.render({"edits": request["edits"]})
            else:
                raise ValueError("request must carry scene or edits")
            emit({"id": nonce, "result": result})
        except BaseException as exc:
            emit({"id": request.get("id") if isinstance(request, dict) else None, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
