#!/usr/bin/env python3
"""Mechanical evaluator for the seeded-astar capsule.

Reads maze fixtures (*.json) from $CAPSULE_ASSETS (default /capsule/assets),
runs astar.find_path on each with a wall-clock measurement (median of 5 inner
reps), runs the pytest correctness suite, and emits EvaluatorOutput JSON on
stdout. Nothing else is written to stdout.

Scoring:
  correctness = 0                       if the call crashed, timed out,
                                        returned no path, or returned an
                                        invalid path
              = (optimal / actual)**4   for a valid path (harshly sublinear in
                                        suboptimality: a 2x-too-long path is
                                        worth ~6% of an optimal one)
  score       = 1 / (1 + median_ms) * correctness

Objectives (higher is better — the trusted default scalarization is the mean
of objective values, so every objective must reward improvement):
  score       mean per-example score (correctness / (1 + median_ms));
              faster and more-correct pathfinders raise it

Constraints:
  tests_pass  pytest suite in the artifact root exits 0

Diagnostics (informational, never aggregated):
  runtime_ms  median across examples of the per-example median-of-5 ms
  quality     mean correctness across examples

stdlib + pytest only.
"""

from __future__ import annotations

import json
import os
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent
INNER_REPS = 5
CALL_TIMEOUT_SEC = 10.0


class CallTimeout(Exception):
    pass


def _alarm_handler(signum, frame):  # noqa: ARG001
    raise CallTimeout(f"find_path exceeded {CALL_TIMEOUT_SEC}s")


def load_mazes(assets_dir: Path) -> list[dict]:
    fixtures = sorted(assets_dir.rglob("*.json"))
    return [json.loads(p.read_text()) for p in fixtures]


def path_is_valid(maze: dict, path) -> bool:
    if not isinstance(path, (list, tuple)) or len(path) == 0:
        return False
    grid = maze["grid"]
    h, w = maze["height"], maze["width"]
    cells = [tuple(cell) for cell in path]
    if cells[0] != tuple(maze["start"]) or cells[-1] != tuple(maze["goal"]):
        return False
    for r, c in cells:
        if not (0 <= r < h and 0 <= c < w) or grid[r][c] == "#":
            return False
    for (r1, c1), (r2, c2) in zip(cells, cells[1:]):
        if abs(r1 - r2) + abs(c1 - c2) != 1:
            return False
    return True


def timed_call(find_path, maze: dict):
    """One measured invocation. Returns (elapsed_ms, result, error_str)."""
    grid = maze["grid"]
    start = tuple(maze["start"])
    goal = tuple(maze["goal"])
    signal.signal(signal.SIGALRM, _alarm_handler)
    signal.setitimer(signal.ITIMER_REAL, CALL_TIMEOUT_SEC)
    t0 = time.perf_counter()
    try:
        result = find_path(grid, start, goal)
        return (time.perf_counter() - t0) * 1000.0, result, None
    except Exception as exc:  # noqa: BLE001 — candidate code may raise anything
        return (time.perf_counter() - t0) * 1000.0, None, f"{type(exc).__name__}: {exc}"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0.0)


def evaluate_example(find_path, maze: dict) -> tuple[float, float, dict]:
    """Returns (median_ms, correctness, perExample entry)."""
    reps: list[float] = []
    result = None
    error: str | None = None
    for _ in range(INNER_REPS):
        ms, result, error = timed_call(find_path, maze)
        reps.append(ms)
        if error is not None:
            break  # a crashing candidate is not re-run
    median_ms = statistics.median(reps)
    optimal = maze["optimal_length"]

    if error is not None:
        correctness = 0.0
        feedback = f"error: {error} in {median_ms:.2f} ms"
    elif result is None:
        correctness = 0.0
        feedback = f"no path found (optimal {optimal}) in {median_ms:.2f} ms"
    elif not path_is_valid(maze, result):
        correctness = 0.0
        feedback = f"invalid path (len {len(result)} vs optimal {optimal}) in {median_ms:.2f} ms"
    else:
        correctness = (optimal / len(result)) ** 4
        feedback = f"path len {len(result)} vs optimal {optimal} in {median_ms:.2f} ms"

    score = correctness / (1.0 + median_ms)
    return median_ms, correctness, {"score": score, "feedback": feedback}


def run_pytest() -> bool:
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider"],
        cwd=REPO_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=300,
    )
    return proc.returncode == 0


def main() -> None:
    assets_dir = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
    mazes = load_mazes(assets_dir)

    sys.path.insert(0, str(REPO_DIR))
    import_error: str | None = None
    find_path = None
    try:
        from astar import find_path  # noqa: PLC0415 — candidate module
    except Exception as exc:  # noqa: BLE001
        import_error = f"{type(exc).__name__}: {exc}"

    per_example: dict[str, dict] = {}
    runtimes: list[float] = []
    correctnesses: list[float] = []
    for maze in mazes:
        if find_path is None:
            per_example[maze["id"]] = {
                "score": 0.0,
                "feedback": f"error: astar import failed: {import_error}",
            }
            correctnesses.append(0.0)
            continue
        median_ms, correctness, entry = evaluate_example(find_path, maze)
        per_example[maze["id"]] = entry
        runtimes.append(median_ms)
        correctnesses.append(correctness)

    tests_pass = run_pytest()

    output = {
        "valid": len(mazes) > 0,
        "objectives": {
            "score": statistics.fmean(
                [entry["score"] for entry in per_example.values()]
            )
            if per_example
            else 0.0,
        },
        "constraints": {"tests_pass": tests_pass},
        "perExample": per_example,
        "diagnostics": {
            "summary": f"{len(mazes)} mazes from {assets_dir}; tests_pass={tests_pass}",
            "runtime_ms": statistics.median(runtimes) if runtimes else 0.0,
            "quality": statistics.fmean(correctnesses) if correctnesses else 0.0,
        },
    }
    json.dump(output, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
