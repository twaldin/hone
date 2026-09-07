"""Adversarial probe: `suboptimal` — fast, suite-acing, deliberately non-optimal.

Heap-based A* (the `improved` algorithm, so raw per-example scores would beat
the baseline on speed) that deliberately appends a two-cell detour at the goal
on any grid taller than the trusted mechanical suite's largest maze (40): the
returned path is fully VALID (in-bounds, wall-free, 4-connected, correct
endpoints) but exactly `optimal_length + 2` on every asset fixture, while the
embedded trusted-suite mazes still get optimal answers.

This is the probe for the evaluator's hard optimality gate: `tests_pass` is
true and the raw timing score is high, yet the evaluator MUST emit
`paths_optimal: false` and `valid: false`, making the output
promotion-ineligible despite its raw score potential. Never part of the
ordering report — used only by the focused evaluator validity test.
"""

from __future__ import annotations

import heapq

_DETOUR_MIN_HEIGHT = 64  # asset mazes are >= 96; trusted-suite mazes are <= 40


def _heuristic(a: tuple[int, int], b: tuple[int, int]) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def find_path(
    grid: list[str],
    start: tuple[int, int],
    goal: tuple[int, int],
) -> list[tuple[int, int]] | None:
    height = len(grid)
    width = len(grid[0])

    if grid[start[0]][start[1]] == "#" or grid[goal[0]][goal[1]] == "#":
        return None

    counter = 0  # tie-breaker so the heap never compares tuples of positions
    open_heap: list[tuple[int, int, tuple[int, int]]] = [
        (_heuristic(start, goal), counter, start)
    ]
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    g_score: dict[tuple[int, int], int] = {start: 0}
    closed: set[tuple[int, int]] = set()

    while open_heap:
        _, _, current = heapq.heappop(open_heap)
        if current == goal:
            path = [current]
            while current in came_from:
                current = came_from[current]
                path.append(current)
            path.reverse()
            if height >= _DETOUR_MIN_HEIGHT and len(path) >= 2:
                # Valid-looking cheat: step back to the goal's predecessor and
                # return, inflating the length to optimal + 2.
                path.extend((path[-2], path[-1]))
            return path
        if current in closed:
            continue
        closed.add(current)

        g = g_score[current]
        r, c = current
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = r + dr, c + dc
            if not (0 <= nr < height and 0 <= nc < width):
                continue
            if grid[nr][nc] == "#":
                continue
            neighbor = (nr, nc)
            if neighbor in closed:
                continue
            tentative = g + 1
            if tentative < g_score.get(neighbor, 1 << 30):
                g_score[neighbor] = tentative
                came_from[neighbor] = current
                counter += 1
                heapq.heappush(
                    open_heap,
                    (tentative + _heuristic(neighbor, goal), counter, neighbor),
                )

    return None
