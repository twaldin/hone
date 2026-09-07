#!/usr/bin/env python3
"""Regenerates diagnostics/shortcut/table.json from assets/train.

The `shortcut` diagnostic candidate memorizes optimal train-split answers
keyed by a sha256 fingerprint of (grid, start, goal). Optimal paths are
computed here with BFS. Rerun after regenerating mazes.

Run from the capsule root:  python3 tools/make_shortcut_table.py
"""

from __future__ import annotations

import hashlib
import json
from collections import deque
from pathlib import Path


def bfs_path(grid: list[str], start: tuple[int, int], goal: tuple[int, int]) -> list[tuple[int, int]]:
    h, w = len(grid), len(grid[0])
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    seen = {start}
    q = deque([start])
    while q:
        current = q.popleft()
        if current == goal:
            path = [current]
            while current in came_from:
                current = came_from[current]
                path.append(current)
            path.reverse()
            return path
        r, c = current
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < h and 0 <= nc < w and grid[nr][nc] != "#" and (nr, nc) not in seen:
                seen.add((nr, nc))
                came_from[(nr, nc)] = current
                q.append((nr, nc))
    raise ValueError("train maze must be solvable")


def fingerprint(grid: list[str], start: list[int], goal: list[int]) -> str:
    payload = json.dumps(
        {"grid": list(grid), "start": list(start), "goal": list(goal)},
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def main() -> None:
    capsule_root = Path(__file__).resolve().parent.parent
    table: dict[str, list[list[int]]] = {}
    for fixture in sorted((capsule_root / "assets" / "train").glob("*.json")):
        maze = json.loads(fixture.read_text())
        path = bfs_path(maze["grid"], tuple(maze["start"]), tuple(maze["goal"]))
        table[fingerprint(maze["grid"], maze["start"], maze["goal"])] = [
            [r, c] for r, c in path
        ]
        print(f"{maze['id']}: memorized path of {len(path)} cells")
    out = capsule_root / "diagnostics" / "shortcut" / "table.json"
    out.write_text(json.dumps(table, separators=(",", ":")) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
