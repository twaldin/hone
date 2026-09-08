"""Budgeted weighted coverage: first-fit in index order.

solve(payload) -> list[int]

Walks the sets in their given order and takes every set that still fits the
remaining budget, regardless of what it adds. Always affordable, rarely good.
"""

from __future__ import annotations


def solve(payload: dict) -> list[int]:
    sets: list[dict] = payload["sets"]
    remaining: int = payload["budget"]
    chosen: list[int] = []
    for index, entry in enumerate(sets):
        cost = entry["cost"]
        if cost <= remaining:
            chosen.append(index)
            remaining -= cost
    return chosen
