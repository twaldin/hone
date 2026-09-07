#!/usr/bin/env python3
"""Deterministic maze fixture generator for the seeded-astar capsule.

Generates 14 distinct grid mazes (6 train / 4 validation / 4 holdout) with a
fixed seed and writes them as JSON fixtures under assets/<split>/.

Fixture shape:
    {
      "id": "train_01",
      "width": W, "height": H,
      "grid": ["....#...", ...],      # '#' wall, '.' free; H rows of W chars
      "start": [r, c], "goal": [r, c],
      "optimal_length": N              # cells in a shortest 4-connected path,
                                       # start and goal inclusive (BFS ground truth)
    }

Design notes:
  * Mazes are mostly open (obstacle density ~0.22) and 96-136 cells per side, so
    a depth-first "any path" search wanders badly (long paths) while A* stays
    exact — that gap is what the diagnostic ordering check leans on.
  * Every maze is regenerated (deterministically, from the same RNG stream)
    until start->goal is solvable.

Run from the capsule root:  python3 tools/generate_mazes.py
"""

from __future__ import annotations

import json
import random
from collections import deque
from pathlib import Path

SEED = 20260714
DENSITY = 0.22

# (split, count, size range) — sizes vary per maze for spread in runtimes.
SPLITS = [
    ("train", 6),
    ("validation", 4),
    ("holdout", 4),
]
SIZES = [96, 104, 112, 120, 128, 136]


def bfs_shortest(grid: list[str], start: tuple[int, int], goal: tuple[int, int]) -> int | None:
    """Length (cell count, endpoints inclusive) of a shortest 4-connected path."""
    h, w = len(grid), len(grid[0])
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


def gen_maze(rng: random.Random, size: int) -> dict:
    while True:
        grid = [
            "".join("#" if rng.random() < DENSITY else "." for _ in range(size))
            for _ in range(size)
        ]
        # Start in the top-left quadrant, goal in the bottom-right quadrant.
        start = (rng.randrange(0, size // 4), rng.randrange(0, size // 4))
        goal = (rng.randrange(3 * size // 4, size), rng.randrange(3 * size // 4, size))
        rows = [list(row) for row in grid]
        rows[start[0]][start[1]] = "."
        rows[goal[0]][goal[1]] = "."
        grid = ["".join(row) for row in rows]
        optimal = bfs_shortest(grid, start, goal)
        if optimal is not None:
            return {
                "width": size,
                "height": size,
                "grid": grid,
                "start": list(start),
                "goal": list(goal),
                "optimal_length": optimal,
            }


def main() -> None:
    capsule_root = Path(__file__).resolve().parent.parent
    rng = random.Random(SEED)
    for split, count in SPLITS:
        out_dir = capsule_root / "assets" / split
        out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(count):
            maze_id = f"{split}_{i + 1:02d}"
            maze = {"id": maze_id, **gen_maze(rng, SIZES[i % len(SIZES)])}
            path = out_dir / f"{maze_id}.json"
            path.write_text(json.dumps(maze, indent=1) + "\n")
            print(f"{path}  optimal={maze['optimal_length']}")


if __name__ == "__main__":
    main()
