#!/usr/bin/env python3
"""Unprivileged JSON-lines adapter for an M2 capsule candidate solution.py.

Frame repetitions are driven by the trusted parent evaluator: a `scene`
request seeds the frozen sidebar scene and renders frame 0; each `frame`
request applies parent-chosen entry-value edits to a fresh entries list and
renders exactly one frame. The adapter never repeats work on the candidate's
behalf and never reports its own timings.
"""
from __future__ import annotations

import importlib.util
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


def frame_scene(base: dict, edits) -> dict:
    """One frame's scene: fresh top-level dict and entries list, edited
    entries replaced by copies so the stored base stays pristine."""
    entries = list(base["entries"])
    for index, value in edits:
        entry = dict(entries[index])
        entry["value"] = value
        entries[index] = entry
    scene = dict(base)
    scene["entries"] = entries
    return scene


def main() -> None:
    try:
        solve = load_solution(Path(sys.argv[1]).resolve())
    except BaseException as exc:
        emit({"ready": False, "error": f"{type(exc).__name__}: {exc}"})
        return
    emit({"ready": True})
    base = None
    for raw in sys.stdin.buffer:
        request = None
        try:
            request = json.loads(raw)
            nonce = request.get("id")
            if not isinstance(nonce, str):
                raise ValueError("request id missing")
            if "scene" in request:
                scene = request["scene"]
                if not isinstance(scene, dict) or not isinstance(scene.get("entries"), list):
                    raise ValueError("malformed scene")
                base = scene
                emit({"id": nonce, "result": solve(frame_scene(base, ()))})
            elif "edits" in request:
                if base is None:
                    raise ValueError("frame request before scene")
                emit({"id": nonce, "result": solve(frame_scene(base, request["edits"]))})
            else:
                raise ValueError("request must carry scene or edits")
        except BaseException as exc:
            emit({"id": request.get("id") if isinstance(request, dict) else None, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
