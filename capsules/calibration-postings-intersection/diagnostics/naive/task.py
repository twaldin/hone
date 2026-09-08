"""Diagnostic candidate: `naive` — per-element hand-rolled binary search.

Walks the first list in payload order (no shortest-first selection) and, for
each id, probes every other list with a Python-level binary search. Exact,
but pays interpreter cost per probe step: markedly slower than the merge
baseline on the eight-way 20,000-entry workloads.
"""

from __future__ import annotations


def _contains(member: list[int], value: int) -> bool:
    lo = 0
    hi = len(member)
    while lo < hi:
        mid = (lo + hi) // 2
        probe = member[mid]
        if probe < value:
            lo = mid + 1
        elif probe > value:
            hi = mid
        else:
            return True
    return False


def solve(payload: dict) -> list[int]:
    lists = payload["lists"]
    if not lists:
        return []
    first = lists[0]
    others = lists[1:]
    out: list[int] = []
    for value in first:
        present = True
        for member in others:
            if not _contains(member, value):
                present = False
                break
        if present:
            out.append(value)
    return out
