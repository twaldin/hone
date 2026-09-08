"""Diagnostic candidate: `naive` — full table of (length, move) cells.

Correct and minimal, but every cell of the (n + 1) x (m + 1) table is a
freshly allocated tuple carrying both the LCS length and the move that
produced it, and the fill loop indexes the nested table on every access.
That roughly doubles the work and the memory of the plain integer table.
"""

from __future__ import annotations

EQUAL = "equal"
DELETE = "delete"
INSERT = "insert"


def solve(payload: dict) -> list[list[str]]:
    before = payload["before"]
    after = payload["after"]
    n = len(before)
    m = len(after)

    table = [[None] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        table[i][0] = (0, DELETE)
    for j in range(m + 1):
        table[0][j] = (0, INSERT)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if before[i - 1] == after[j - 1]:
                table[i][j] = (table[i - 1][j - 1][0] + 1, EQUAL)
            else:
                up = table[i - 1][j]
                left = table[i][j - 1]
                if up[0] >= left[0]:
                    table[i][j] = (up[0], DELETE)
                else:
                    table[i][j] = (left[0], INSERT)

    ops: list[list[str]] = []
    i, j = n, m
    while i > 0 or j > 0:
        move = table[i][j][1]
        if move == EQUAL:
            ops.append([EQUAL, before[i - 1]])
            i -= 1
            j -= 1
        elif move == DELETE:
            ops.append([DELETE, before[i - 1]])
            i -= 1
        else:
            ops.append([INSERT, after[j - 1]])
            j -= 1
    ops.reverse()
    return ops
