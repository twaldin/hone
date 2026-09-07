"""Correctness tests for astar.find_path.

Ten solvable mazes (small to 40x40) plus an unsolvable one. Optimality is
checked against an independent BFS reference implemented here, so the tests
hold regardless of how find_path is rewritten.
"""

from __future__ import annotations

import random
from collections import deque

import pytest

from astar import find_path


def bfs_shortest(grid, start, goal):
    """Independent reference: shortest path cell count, endpoints inclusive."""
    h, w = len(grid), len(grid[0])
    start, goal = tuple(start), tuple(goal)
    dist = {start: 1}
    q = deque([start])
    while q:
        r, c = q.popleft()
        if (r, c) == goal:
            return dist[(r, c)]
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < h and 0 <= nc < w and grid[nr][nc] != "#" and (nr, nc) not in dist:
                dist[(nr, nc)] = dist[(r, c)] + 1
                q.append((nr, nc))
    return None


def assert_valid_path(grid, start, goal, path):
    assert path[0] == tuple(start), "path must begin at start"
    assert path[-1] == tuple(goal), "path must end at goal"
    for (r1, c1), (r2, c2) in zip(path, path[1:]):
        assert abs(r1 - r2) + abs(c1 - c2) == 1, "steps must be 4-connected"
    for r, c in path:
        assert 0 <= r < len(grid) and 0 <= c < len(grid[0]), "path leaves the grid"
        assert grid[r][c] != "#", "path crosses a wall"


def random_maze(seed, size, density=0.25):
    rng = random.Random(seed)
    while True:
        grid = [
            "".join("#" if rng.random() < density else "." for _ in range(size))
            for _ in range(size)
        ]
        start, goal = (0, 0), (size - 1, size - 1)
        rows = [list(row) for row in grid]
        rows[0][0] = "."
        rows[-1][-1] = "."
        grid = ["".join(r) for r in rows]
        if bfs_shortest(grid, start, goal) is not None:
            return grid, start, goal


HAND_MAZES = [
    # (grid, start, goal)
    (["...", "...", "..."], (0, 0), (2, 2)),
    (["....", ".##.", ".##.", "...."], (0, 0), (3, 3)),
    ([".#.", ".#.", "..."], (0, 0), (0, 2)),
    (["......", "#####.", "......", ".#####", "......"], (0, 0), (4, 5)),
]

RANDOM_MAZES = [random_maze(seed, size) for seed, size in
                [(1, 12), (2, 16), (3, 20), (4, 28), (5, 34), (6, 40)]]

ALL_MAZES = HAND_MAZES + RANDOM_MAZES


@pytest.mark.parametrize("grid,start,goal", ALL_MAZES)
def test_finds_optimal_path(grid, start, goal):
    path = find_path(grid, start, goal)
    assert path is not None, "solvable maze must yield a path"
    assert_valid_path(grid, start, goal, path)
    optimal = bfs_shortest(grid, start, goal)
    assert len(path) == optimal, f"path length {len(path)} != optimal {optimal}"


def test_unsolvable_returns_none():
    grid = ["...", "###", "..."]
    assert find_path(grid, (0, 0), (2, 2)) is None


def test_start_or_goal_walled_returns_none():
    grid = ["#..", "...", "..#"]
    assert find_path(grid, (0, 0), (1, 1)) is None
    assert find_path(grid, (1, 1), (2, 2)) is None
