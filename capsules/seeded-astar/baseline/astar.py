"""Grid A* pathfinder.

find_path(grid, start, goal) -> list[(r, c)] | None

  grid  : list of strings; '#' is a wall, anything else is walkable
  start : (row, col)
  goal  : (row, col)

Returns a shortest 4-connected path as a list of (row, col) tuples including
both endpoints, or None when no path exists.
"""

from __future__ import annotations


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

    # Open set kept as a flat list of (f, g, node); every iteration linearly
    # scans it for the lowest f and linearly searches it again on updates.
    open_list: list[tuple[int, int, tuple[int, int]]] = [
        (_heuristic(start, goal), 0, start)
    ]
    came_from: dict[tuple[int, int], tuple[int, int]] = {}
    g_score: dict[tuple[int, int], int] = {start: 0}
    closed: set[tuple[int, int]] = set()

    while open_list:
        # Linear scan for the entry with the smallest f.
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

        if current in closed:
            continue
        closed.add(current)

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
                f = tentative + _heuristic(neighbor, goal)
                # Linear search for an existing open entry to replace.
                for i, (_, _, node) in enumerate(open_list):
                    if node == neighbor:
                        open_list[i] = (f, tentative, neighbor)
                        break
                else:
                    open_list.append((f, tentative, neighbor))

    return None
