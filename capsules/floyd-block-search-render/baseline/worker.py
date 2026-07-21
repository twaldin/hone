#!/usr/bin/env python3
"""Unprivileged JSON-lines adapter for an M2 capsule candidate solution.py."""
from __future__ import annotations

import importlib.util
import gc
import json
import os
import sys
from pathlib import Path


def emit(value) -> None:
    os.write(1, (json.dumps(value, separators=(",", ":")) + "\n").encode())


def load_solution(workspace: Path):
    path = workspace / "solution.py"
    if not path.is_file():
        raise RuntimeError("candidate is missing solution.py")
    spec = importlib.util.spec_from_file_location("candidate_solution", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load candidate solution.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    solve = getattr(module, "solve", None)
    if not callable(solve):
        raise RuntimeError("solution.py must export callable solve(value)")
    return solve


def main() -> None:
    # Refcounting still frees non-cyclic garbage immediately, so RSS stays
    # bounded; disabling cyclic GC removes nondeterministic collection pauses
    # from the trusted per-frame render timing.
    gc.disable()
    try:
        solve = load_solution(Path(sys.argv[1]).resolve())
    except BaseException as exc:
        emit({"ready": False, "error": f"{type(exc).__name__}: {exc}"})
        return
    emit({"ready": True})
    # The trusted evaluator loads the frozen scene once (a request carrying
    # "input") and then drives repeated render frames with tiny repeat
    # requests (no "input", optional "reps" batch count), so per-frame timing
    # reflects render cost, not scene transport or pipe round-trips. The
    # candidate never sees this protocol: it only ever receives solve(scene).
    have_scene = False
    scene = None
    for raw in sys.stdin.buffer:
        request = None
        try:
            request = json.loads(raw)
            nonce = request.get("id")
            if not isinstance(nonce, str):
                raise ValueError("request id missing")
            if "input" in request:
                scene = request["input"]
                have_scene = True
            elif not have_scene:
                raise ValueError("repeat frame before any scene was loaded")
            reps = request.get("reps", 1)
            if not isinstance(reps, int) or reps < 1 or reps > 1000:
                raise ValueError("invalid reps")
            result = None
            for _ in range(reps):
                result = solve(scene)
            emit({"id": nonce, "result": result})
        except BaseException as exc:
            emit({"id": request.get("id") if isinstance(request, dict) else None, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
