"""Diagnostic candidate: `improved` — native set intersection.

Seeds a set from the shortest list and narrows it with C-level
``set.intersection`` against the others, shortest first, exiting as soon as
it empties. Same contract as the baseline; must be exact and faster.
"""

from __future__ import annotations


def solve(payload: dict) -> list[int]:
    lists = payload["lists"]
    if not lists:
        return []
    ordered = sorted(lists, key=len)
    if not ordered[0]:
        return []
    survivors = set(ordered[0])
    for other in ordered[1:]:
        survivors.intersection_update(other)
        if not survivors:
            return []
    return sorted(survivors)
