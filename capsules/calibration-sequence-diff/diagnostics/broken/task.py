"""Diagnostic candidate: `broken` — order-blind multiset diff.

Counts tokens on each side and keeps the shared count as `equal` while
walking `before`, marking surplus `before` tokens as `delete` and appending
surplus `after` tokens as `insert` at the end. Token counts balance, so the
script looks plausible and is fast, but it ignores ordering: replaying it
only reproduces `after` when the shared tokens already appear in the same
order and every insertion belongs at the tail.
"""

from __future__ import annotations

from collections import Counter

EQUAL = "equal"
DELETE = "delete"
INSERT = "insert"


def solve(payload: dict) -> list[list[str]]:
    before = payload["before"]
    after = payload["after"]

    remaining = Counter(after)
    ops: list[list[str]] = []
    for token in before:
        if remaining[token] > 0:
            remaining[token] -= 1
            ops.append([EQUAL, token])
        else:
            ops.append([DELETE, token])
    for token in after:
        if remaining[token] > 0:
            remaining[token] -= 1
            ops.append([INSERT, token])
    return ops
