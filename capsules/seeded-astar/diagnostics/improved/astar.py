"""Grid A* pathfinder.

find_path(grid, start, goal) -> list[(r, c)] | None

  grid  : list of strings; '#' is a wall, anything else is walkable
  start : (row, col)
  goal  : (row, col)

Returns a shortest 4-connected path as a list of (row, col) tuples including
both endpoints, or None when no path exists.
"""

from __future__ import annotations

import heapq


def find_path(
    grid: list[str],
    start: tuple[int, int],
    goal: tuple[int, int],
) -> list[tuple[int, int]] | None:
    height = len(grid)
    width = len(grid[0])

    sr, sc = start
    gr, gc = goal
    if grid[sr][sc] == "#" or grid[gr][gc] == "#":
        return None

    # Fast path: start is goal.
    if sr == gr and sc == gc:
        return [(sr, sc)]

    INF = 1 << 30
    # Flat g-score array; index = r * width + c. 0 means "unseen".
    g_score = [0] * (height * width)
    came_from = [-1] * (height * width)  # predecessor cell index, -1 = none

    goal_idx = gr * width + gc
    goal_h = abs(sr - gr) + abs(sc - gc)

    start_idx = sr * width + sc
    g_score[start_idx] = 1  # store g + 1 so 0 can encode "unseen"

    # Heap entries: (f, node_idx). f = g + h. g is looked up from g_score.
    open_heap: list[tuple[int, int]] = [(goal_h, start_idx)]

    deltas = (-width, width, -1, 1)

    while open_heap:
        f, current = heapq.heappop(open_heap)
        cur_g = g_score[current]
        if cur_g == 0:
            # Stale lazy-deleted entry.
            continue
        if current == goal_idx:
            # Reconstruct path.
            path = [(gr, gc)]
            node = current
            while node != start_idx:
                prev = came_from[node]
                path.append((prev // width, prev % width))
                node = prev
            path.reverse()
            return path
        # Recompute f for the popped node to validate laziness: if the stored
        # g produces an f strictly greater than the heap key we popped, this
        # entry is stale and a better one is/was in the heap.
        cr = current // width
        cc = current % width
        h_cur = abs(cr - gr) + abs(cc - gc)
        if f != cur_g + h_cur:
            # f is the value stored at push time; if it's larger than the
            # current best g+h, this is a stale entry — re-push with the
            # up-to-date value only if needed. Simpler: skip if the current
            # g implies a smaller f (we already processed the better one).
            if f > cur_g + h_cur:
                continue

        new_g = cur_g + 1
        r0 = current // width
        c0 = current % width

        # Up
        if r0 > 0:
            nb = current - width
            if grid[r0 - 1][c0] != "#" and (g_score[nb] == 0 or new_g < g_score[nb]):
                g_score[nb] = new_g
                came_from[nb] = current
                nr = r0 - 1
                heapq.heappush(open_heap, (new_g + abs(nr - gr) + abs(cc - gc), nb))
        # Down
        if r0 < height - 1:
            nb = current + width
            if grid[r0 + 1][c0] != "#" and (g_score[nb] == 0 or new_g < g_score[nb]):
                g_score[nb] = new_g
                came_from[nb] = current
                nr = r0 + 1
                heapq.heappush(open_heap, (new_g + abs(nr - gr) + abs(cc - gc), nb))
        # Left
        if c0 > 0:
            nb = current - 1
            if grid[r0][c0 - 1] != "#" and (g_score[nb] == 0 or new_g < g_score[nb]):
                g_score[nb] = new_g
                came_from[nb] = current
                nc = c0 - 1
                heapq.heappush(open_heap, (new_g + abs(cr - gr) + abs(nc - gc), nb))
        # Right
        if c0 < width - 1:
            nb = current + 1
            if grid[r0][c0 + 1] != "#" and (g_score[nb] == 0 or new_g < g_score[nb]):
                g_score[nb] = new_g
                came_from[nb] = current
                nc = c0 + 1
                heapq.heappush(open_heap, (new_g + abs(cr - gr) + abs(nc - gc), nb))

    return None
