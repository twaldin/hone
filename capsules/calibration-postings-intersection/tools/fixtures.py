#!/usr/bin/env python3
"""Deterministic fixture generator for the posting-list intersection task.

``cases(seed) -> [{"id": str, "input": {"lists": [[int, ...], ...]}}, ...]``

Every seed yields the same catalogue of workload SHAPES with different random
draws, so distinct seeds give structurally matched train/validation splits.
No expected answers are emitted: ``baseline/checker.py`` derives them.

Workload catalogue (ids are stable across seeds; the caller may namespace):

  empty-lists           zero lists                                   -> []
  lone-empty            a single empty list                          -> []
  empty-member          8 lists, one empty in the middle             -> []
  single-list           one list                                     -> itself
  small-universe        5 lists drawn from ids 0..63 (dense ties)
  bound-values          varied sizes, all sharing 0 and MAX_DOC_ID plus a
                        planted middle set, ids over the full range
  nested-chain          L0 c L1 c ... c L5 (20,000)                  -> L0
  two-lists-max         2 x 20,000, ~50% overlap
  identical-max         4 identical lists of 20,000                  -> the list
  disjoint-max          8 x 20,000 pairwise disjoint                 -> []
  dense-overlap-max     8 x 20,000 from a 26,001-id universe (large output)
  skew-max              7 x 20,000 followed by one tiny list whose ids are
                        planted into a random subset of the big lists
  sparse-large-max      8 x 20,000 over the full id range, 150 planted common
  near-miss-max         8 x 20,000 with 500 common ids and, for each list,
                        100 ids present in every OTHER list (k-1 spoilers)

Sizes are chosen so the eight-way, 20,000-entry cases dominate wall time and
separate a merge, a set-based, and a per-element bisect strategy.

Run directly to print a summary:  python3 tools/fixtures.py [seed]
"""

from __future__ import annotations

import random
import sys

MAX_LISTS = 8
MAX_LEN = 20_000
MAX_DOC_ID = 2**31 - 1


def _sorted_sample(rng: random.Random, hi: int, n: int) -> list[int]:
    """``n`` distinct ids in ``[0, hi]``, sorted."""
    return sorted(rng.sample(range(hi + 1), n))


def _list_with(rng: random.Random, hi: int, n: int, planted: set[int],
               excluded: set[int] | frozenset[int] = frozenset()) -> list[int]:
    """Exactly ``n`` distinct ids including ``planted`` and omitting ``excluded``."""
    chosen = set(planted)
    chosen.update(value for value in rng.sample(range(hi + 1), n - len(planted))
                  if value not in excluded)
    while len(chosen) < n:
        value = rng.randrange(hi + 1)
        if value not in excluded:
            chosen.add(value)
    return sorted(chosen)


def _case(case_id: str, lists: list[list[int]]) -> dict:
    return {"id": case_id, "input": {"lists": lists}}


def cases(seed: int) -> list[dict]:
    rng = random.Random(seed)
    out: list[dict] = []

    out.append(_case("empty-lists", []))
    out.append(_case("lone-empty", [[]]))

    members = [_sorted_sample(rng, 50_000, 2_000) for _ in range(MAX_LISTS)]
    members[4] = []
    out.append(_case("empty-member", members))

    out.append(_case("single-list", [_sorted_sample(rng, 1_000_000, 5_000)]))

    out.append(
        _case(
            "small-universe",
            [_sorted_sample(rng, 63, rng.randint(1, 64)) for _ in range(5)],
        )
    )

    planted = set(rng.sample(range(1, MAX_DOC_ID), 40))
    planted.update((0, MAX_DOC_ID))
    sizes = [60, 700, 3_000, 9_000, 15_000, MAX_LEN]
    out.append(
        _case(
            "bound-values",
            [_list_with(rng, MAX_DOC_ID, size, planted) for size in sizes],
        )
    )

    chain: list[list[int]] = []
    grown: set[int] = set()
    for size in (300, 1_000, 3_000, 7_000, 12_000, MAX_LEN):
        grown.update(rng.sample(range(2_000_001), size - len(grown)))
        while len(grown) < size:
            grown.add(rng.randrange(2_000_001))
        chain.append(sorted(grown))
    out.append(_case("nested-chain", chain))

    out.append(
        _case(
            "two-lists-max",
            [_sorted_sample(rng, 40_000, MAX_LEN) for _ in range(2)],
        )
    )

    shared = _sorted_sample(rng, 1_000_000, MAX_LEN)
    out.append(_case("identical-max", [list(shared) for _ in range(4)]))

    disjoint = []
    for residue in range(MAX_LISTS):
        base = _sorted_sample(rng, 60_000, MAX_LEN)
        disjoint.append([MAX_LISTS * value + residue for value in base])
    out.append(_case("disjoint-max", disjoint))

    out.append(
        _case(
            "dense-overlap-max",
            [_sorted_sample(rng, 26_000, MAX_LEN) for _ in range(MAX_LISTS)],
        )
    )

    tiny = _sorted_sample(rng, MAX_DOC_ID, 40)
    skew = []
    for _ in range(MAX_LISTS - 1):
        keep = {value for value in tiny if rng.random() < 0.8}
        skew.append(_list_with(rng, MAX_DOC_ID, MAX_LEN, keep))
    skew.append(tiny)
    out.append(_case("skew-max", skew))

    common = set(rng.sample(range(MAX_DOC_ID + 1), 150))
    out.append(
        _case(
            "sparse-large-max",
            [_list_with(rng, MAX_DOC_ID, MAX_LEN, common) for _ in range(MAX_LISTS)],
        )
    )

    pool = rng.sample(range(200_001), 500 + 100 * MAX_LISTS)
    core = set(pool[:500])
    spoilers = [set(pool[500 + 100 * i : 600 + 100 * i]) for i in range(MAX_LISTS)]
    near_miss = []
    for i in range(MAX_LISTS):
        must = set(core)
        for j, spoiler in enumerate(spoilers):
            if j != i:
                must |= spoiler
        near_miss.append(_list_with(rng, 200_000, MAX_LEN, must, spoilers[i]))
    out.append(_case("near-miss-max", near_miss))

    return out


def main() -> None:
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    for row in cases(seed):
        lists = row["input"]["lists"]
        shape = ",".join(str(len(member)) for member in lists) or "-"
        print(f"{row['id']:<20} lists={len(lists)} sizes=[{shape}]")


if __name__ == "__main__":
    main()
