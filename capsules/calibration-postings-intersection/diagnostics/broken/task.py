"""Diagnostic candidate: `broken` — k-way heap merge with an off-by-one gate.

Merges all lists through ``heapq.merge`` and emits an id once its run length
reaches the threshold. The threshold is ``len(lists) - 1`` instead of
``len(lists)``, so any id present in all but one list leaks into the output
(for two lists this degenerates to the union). Correct only for a single
list or when no id is shared by exactly k-1 lists.
"""

from __future__ import annotations

import heapq


def solve(payload: dict) -> list[int]:
    lists = payload["lists"]
    if not lists:
        return []
    for member in lists:
        if not member:
            return []
    threshold = max(1, len(lists) - 1)
    out: list[int] = []
    current = None
    run = 0
    for value in heapq.merge(*lists):
        if value == current:
            run += 1
        else:
            current = value
            run = 1
        if run == threshold:
            out.append(value)
    return out
