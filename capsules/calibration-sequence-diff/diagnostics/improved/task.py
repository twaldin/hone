"""Diagnostic candidate: `improved` — bit-parallel LCS rows with backtracking.

Strips the common prefix and suffix, then runs the Hyyrö bit-vector LCS
recurrence over the middle, keeping one Python integer per `before` row.
Each row encodes the columns where the LCS length grows, so the LCS length
of any prefix pair is a popcount, and the standard backtrack recovers a
minimal script in O(n + m) big-integer operations.

Exact: the row recurrence computes the same LCS table as the full DP, and
the backtrack takes a match whenever tokens are equal and otherwise moves in
a direction that preserves the LCS length.
"""

from __future__ import annotations

EQUAL = "equal"
DELETE = "delete"
INSERT = "insert"

try:
    _popcount = int.bit_count
except AttributeError:  # pragma: no cover - Python < 3.10

    def _popcount(value: int) -> int:
        return bin(value).count("1")


def _middle(before: list[str], after: list[str]) -> list[list[str]]:
    n = len(before)
    m = len(after)
    if n == 0:
        return [[INSERT, token] for token in after]
    if m == 0:
        return [[DELETE, token] for token in before]

    full = (1 << m) - 1
    position_masks: dict[str, int] = {}
    for j, token in enumerate(after):
        position_masks[token] = position_masks.get(token, 0) | (1 << j)

    rows = [full]
    vector = full
    for token in before:
        matches = vector & position_masks.get(token, 0)
        vector = ((vector + matches) | (vector - matches)) & full
        rows.append(vector)

    # lcs(i, j) == j - popcount(rows[i] & ((1 << j) - 1))
    ops: list[list[str]] = []
    i, j = n, m
    while i > 0 and j > 0:
        if before[i - 1] == after[j - 1]:
            ops.append([EQUAL, before[i - 1]])
            i -= 1
            j -= 1
            continue
        up = j - _popcount(rows[i - 1] & ((1 << j) - 1))
        left = (j - 1) - _popcount(rows[i] & ((1 << (j - 1)) - 1))
        if up >= left:
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


def solve(payload: dict) -> list[list[str]]:
    before = payload["before"]
    after = payload["after"]
    n = len(before)
    m = len(after)

    prefix = 0
    limit = n if n < m else m
    while prefix < limit and before[prefix] == after[prefix]:
        prefix += 1
    suffix = 0
    limit -= prefix
    while suffix < limit and before[n - 1 - suffix] == after[m - 1 - suffix]:
        suffix += 1

    ops = [[EQUAL, token] for token in before[:prefix]]
    ops.extend(_middle(before[prefix:n - suffix], after[prefix:m - suffix]))
    ops.extend([EQUAL, token] for token in before[n - suffix:])
    return ops
