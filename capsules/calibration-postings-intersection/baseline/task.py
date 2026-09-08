"""Exact posting-list intersection (calibration task, mutable baseline).

Payload: ``{"lists": [[int, ...], ...]}``. Each member list is a posting list
of document ids: strictly increasing, nonnegative integers. At most eight
lists, each at most 20,000 entries, ids at most 2**31 - 1.

``solve`` returns the sorted list of ids present in EVERY list. Two edge
cases are defined by contract, not by set theory:

* zero lists       -> ``[]`` (no universal set)
* any empty member -> ``[]``

Baseline strategy: a k-way cursor walk. Every list keeps a cursor; each round
takes the largest head, advances every cursor below it, and emits the head
when all cursors agree. Any cursor running off its list ends the walk.
"""

from __future__ import annotations


def solve(payload: dict) -> list[int]:
    lists = payload["lists"]
    if not lists:
        return []
    for member in lists:
        if not member:
            return []
    count = len(lists)
    lengths = [len(member) for member in lists]
    cursors = [0] * count
    out: list[int] = []
    while True:
        target = lists[0][cursors[0]]
        agreed = True
        for idx in range(1, count):
            head = lists[idx][cursors[idx]]
            if head > target:
                target = head
                agreed = False
            elif head < target:
                agreed = False
        if agreed:
            out.append(target)
            for idx in range(count):
                cursors[idx] += 1
                if cursors[idx] == lengths[idx]:
                    return out
            continue
        for idx in range(count):
            member = lists[idx]
            pos = cursors[idx]
            end = lengths[idx]
            while pos < end and member[pos] < target:
                pos += 1
            if pos == end:
                return out
            cursors[idx] = pos
