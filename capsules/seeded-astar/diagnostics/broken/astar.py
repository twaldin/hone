"""Diagnostic candidate: `broken` — crashes on some inputs.

A "memory optimization" replaced the closed set with a preallocated 64x64
boolean matrix, so any maze larger than 64 cells per side raises IndexError.
Small mazes (including the whole pytest suite) still work — the bug only fires
at fixture scale. Must rank at the bottom of the ordering check.
"""

from __future__ import annotations

_MAX = 64


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

    open_list: list[tuple[int, int, tuple[int, int]]] = [
        (_heuristic(start, goal), 0, start)
    ]
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    g_score: dict[tuple[int, int], int] = {start: 0}
    # BUG: fixed-size closed matrix; IndexError past 64x64.
    closed = [[False] * _MAX for _ in range(_MAX)]

    def is_closed(cell: tuple[int, int]) -> bool:
        r, c = cell
        if r >= _MAX or c >= _MAX:
            raise IndexError(f"closed matrix overflow at {cell}")
        return closed[r][c]

    while open_list:
        best_index = 0
        for i in range(1, len(open_list)):
            if open_list[i][0] < open_list[best_index][0]:
                best_index = i
        _, g, current = open_list.pop(best_index)

        if current == goal:
            path = [current]
            while current in came_from:
                current = came_from[current]
                path.append(current)
            path.reverse()
            return path

        if is_closed(current):
            continue
        closed[current[0]][current[1]] = True

        r, c = current
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = r + dr, c + dc
            if not (0 <= nr < height and 0 <= nc < width):
                continue
            if grid[nr][nc] == "#":
                continue
            neighbor = (nr, nc)
            if is_closed(neighbor):
                continue
            tentative = g + 1
            if tentative < g_score.get(neighbor, 1 << 30):
                g_score[neighbor] = tentative
                came_from[neighbor] = current
                f = tentative + _heuristic(neighbor, goal)
                for i, (_, _, node) in enumerate(open_list):
                    if node == neighbor:
                        open_list[i] = (f, tentative, neighbor)
                        break
                else:
                    open_list.append((f, tentative, neighbor))

    return None
