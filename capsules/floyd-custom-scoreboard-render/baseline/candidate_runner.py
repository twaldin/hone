#!/usr/bin/env python3
"""Candidate boundary: the ONLY process that imports and calls solution.py.

This process never owns the trusted parent's protocol fd. Its stdout is a
private pipe consumed by the trusted adapter (worker.py), which re-materializes
and re-serializes every result it returns. The moment solution.py is imported
this process is candidate-tainted, so nothing it writes is trusted: the adapter
parses and canonicalizes the bytes, and the trusted parent evaluator validates
the materialized result against the sealed reference renderer.

Frame construction lives here so the candidate sees exactly the input-object
semantics the reference does: a `scene` request seeds the frozen sidebar scene
(held across frames), and each `edits` request builds a fresh entries list from
that persistent base, replacing only the edited entries with copies. The scored
render happens in solve(); the result-graph materialization and canonical
serialization that get scored happen in the trusted adapter, in the shared
accounting cgroup, inside the parent's timing window.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path


def _emit(value) -> None:
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
    """One frame's scene: fresh top-level dict and entries list, edited entries
    replaced by copies so the stored base stays pristine and unedited entry
    objects keep stable identity across frames."""
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
        _emit({"ready": False, "error": f"{type(exc).__name__}: {exc}"})
        return
    _emit({"ready": True})
    base = None
    for raw in sys.stdin.buffer:
        try:
            request = json.loads(raw)
            if "scene" in request:
                base = request["scene"]
                _emit({"result": solve(frame_scene(base, ()))})
            elif "edits" in request:
                if base is None:
                    raise ValueError("frame request before scene")
                _emit({"result": solve(frame_scene(base, request["edits"]))})
            else:
                raise ValueError("request must carry scene or edits")
        except BaseException as exc:
            _emit({"error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
