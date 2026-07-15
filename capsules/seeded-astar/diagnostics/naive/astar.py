"""Diagnostic candidate: `naive` — returns *a* path, rarely a good one.

Iterative depth-first search with a goal-averse neighbor order (heads up/left
first from a top-left start), returning the DFS-tree path to the goal. Fast
but wildly suboptimal on open grids; the evaluator's (optimal/actual)**4
correctness term must keep it below the baseline in the ordering check.
"""

from __future__ import annotations


def find_path(
    grid: list[str],
    start: tuple[int, int],
    goal: tuple[int, int],
) -> list[tuple[int, int]] | None:
    height = len(grid)
    width = len(grid[0])

    if grid[start[0]][start[1]] == "#" or grid[goal[0]][goal[1]] == "#":
        return None

    stack = [start]
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    visited = {start}

    while stack:
        current = stack.pop()
        if current == goal:
            path = [current]
            while current in came_from:
                current = came_from[current]
                path.append(current)
            path.reverse()
            return path
        r, c = current
        # Stack order makes (-1, 0) i.e. "up" explored first — away from a
        # bottom-right goal, which is what makes the tree path so bad.
        for dr, dc in ((0, 1), (1, 0), (0, -1), (-1, 0)):
            nr, nc = r + dr, c + dc
            if not (0 <= nr < height and 0 <= nc < width):
                continue
            if grid[nr][nc] == "#":
                continue
            neighbor = (nr, nc)
            if neighbor in visited:
                continue
            visited.add(neighbor)
            came_from[neighbor] = current
            stack.append(neighbor)

    return None
