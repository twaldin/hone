"""Minimal insert/delete edit script between two token sequences.

`solve(payload)` takes `{"before": [str, ...], "after": [str, ...]}` and
returns a list of `[op, token]` pairs with `op` in `equal`, `delete`,
`insert`. Replaying the script in order consumes every `before` token and
produces every `after` token, and the number of `insert` plus `delete`
operations is the minimum possible (`len(before) + len(after) - 2 * LCS`).

This baseline fills the full longest-common-subsequence table and walks it
back to recover the script.
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

    # table[i][j] = LCS length of before[:i] and after[:j].
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        token = before[i - 1]
        prev = table[i - 1]
        row = table[i]
        for j in range(1, m + 1):
            if token == after[j - 1]:
                row[j] = prev[j - 1] + 1
            else:
                up = prev[j]
                left = row[j - 1]
                row[j] = up if up >= left else left

    ops: list[list[str]] = []
    i, j = n, m
    while i > 0 and j > 0:
        if before[i - 1] == after[j - 1]:
            ops.append([EQUAL, before[i - 1]])
            i -= 1
            j -= 1
        elif table[i - 1][j] >= table[i][j - 1]:
            ops.append([DELETE, before[i - 1]])
            i -= 1
        else:
            ops.append([INSERT, after[j - 1]])
            j -= 1
    while i > 0:
        ops.append([DELETE, before[i - 1]])
        i -= 1
    while j > 0:
        ops.append([INSERT, after[j - 1]])
        j -= 1
    ops.reverse()
    return ops
