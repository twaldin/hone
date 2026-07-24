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


def _translate(base, delta) -> dict:
    """Return a FRESH scene whose block coordinates are shifted by the trusted
    per-frame integer `delta`. The shift is applied HERE in the protected
    adapter (never candidate code), reading the pristine base each time, so
    every frame hands solve a distinct scene object with distinct integer
    coordinates. Because the shift moves the coordinates that feed the render's
    distance stage, the candidate cannot cache one command stream and replay
    it — the costly work genuinely re-runs on every frame."""
    dx, dy, dz = delta
    blocks = [
        {
            "id": b["id"],
            "x": b["x"] + dx,
            "y": b["y"] + dy,
            "z": b["z"] + dz,
            "selected": b["selected"],
        }
        for b in base["blocks"]
    ]
    return {"blocks": blocks, "radius": base["radius"]}


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
    # The trusted evaluator establishes the pristine base scene once (a request
    # carrying "input") and then drives one render per request. Every render
    # request carries its OWN trusted integer "delta"; this protected adapter
    # shifts the pristine base by that delta and hands solve a fresh, distinct
    # scene. Warmup and measured frames use DISJOINT deltas and the trusted
    # parent validates every frame against that frame's own protected expected
    # output, so a candidate can neither cache-and-replay a single command
    # stream nor precompute the measured frames during untimed warmup: future
    # deltas arrive per-frame (each only after the previous response), so
    # stdin never holds any look-ahead. The candidate only ever sees
    # solve(scene) for one distinct scene at a time.
    base = None
    have_base = False
    for raw in sys.stdin.buffer:
        request = None
        try:
            request = json.loads(raw)
            nonce = request.get("id")
            if not isinstance(nonce, str):
                raise ValueError("request id missing")
            if "input" in request:
                base = request["input"]
                if not (isinstance(base, dict) and isinstance(base.get("blocks"), list)):
                    raise ValueError("invalid base scene")
                have_base = True
                scene = _translate(base, (0, 0, 0))
            elif "delta" in request:
                if not have_base:
                    raise ValueError("render frame before any scene was loaded")
                delta = request["delta"]
                if (
                    not isinstance(delta, list)
                    or len(delta) != 3
                    or not all(isinstance(c, int) and not isinstance(c, bool) for c in delta)
                ):
                    raise ValueError("invalid delta")
                scene = _translate(base, delta)
            else:
                raise ValueError("request carries neither input nor delta")
            result = solve(scene)
            emit({"id": nonce, "result": result})
        except BaseException as exc:
            emit({"id": request.get("id") if isinstance(request, dict) else None, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
