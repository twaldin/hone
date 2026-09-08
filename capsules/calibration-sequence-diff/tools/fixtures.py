"""Deterministic workload generator for the calibration-sequence-diff task.

`cases(seed)` returns a list of `{"id": str, "input": {"before": [...],
"after": [...]}}` rows. Every workload family is always present; the seed
only drives token content and edit positions through `random.Random`, so the
same seed always yields byte-identical cases. No expected results are
emitted: the checker derives minimality independently.

Families (MAX_TOKENS = 1024 tokens per side):
  empty_both            both sides empty
  empty_before          all inserts, near max
  empty_after           all deletes, near max
  identical_max         1024 == 1024, zero edits
  near_identical_max    1024-token base with a handful of scattered edits
  unrelated_max         two independent draws from a large vocabulary
  duplicates_max        three-token vocabulary, heavy ties
  ties_periodic         rotated periodic patterns with many equal-length LCSs
  reversed_max          a sequence against its reversal
  block_move            a contiguous block relocated
  asymmetric            long against very short
  mixed_tokens          words, digits, punctuation, empty strings, whitespace,
                        unicode and case variants
  single_token          one-token sides, equal and different
"""

from __future__ import annotations

import random

MAX_TOKENS = 1024

_WORDS = [
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
    "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho",
    "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
]
_MIXED = [
    "", " ", "\t", "0", "42", "-1", "3.14", "true", "True", "TRUE", "null",
    "None", ".", ",", ";", "(", ")", "{", "}", "->", "==", "!=", "naïve",
    "über", "日本語", "emoji😀", "a b", "tab\tin", "quote'", 'dq"', "back\\slash",
    "Alpha", "ALPHA", "alpha", "x", "X", "1e3", "0x1F",
]


def _vocab(rng: random.Random, size: int) -> list[str]:
    return [f"t{rng.randrange(1_000_000):06d}" for _ in range(size)]


def _draw(rng: random.Random, vocab: list[str], count: int) -> list[str]:
    return [rng.choice(vocab) for _ in range(count)]


def _edit(rng: random.Random, base: list[str], vocab: list[str], edits: int) -> list[str]:
    """Apply `edits` random insert/delete/substitute operations to a copy of `base`.

    The result never exceeds MAX_TOKENS.
    """
    out = list(base)
    for _ in range(edits):
        kind = rng.randrange(3)
        if kind == 0 and len(out) < MAX_TOKENS:
            out.insert(rng.randrange(len(out) + 1), rng.choice(vocab))
        elif kind == 1 and out:
            del out[rng.randrange(len(out))]
        elif out:
            out[rng.randrange(len(out))] = rng.choice(vocab)
    return out


def cases(seed: int) -> list[dict]:
    rng = random.Random(seed)
    rows: list[dict] = []

    def add(name: str, before: list[str], after: list[str]) -> None:
        assert len(before) <= MAX_TOKENS and len(after) <= MAX_TOKENS
        rows.append({"id": f"{name}_{len(rows):02d}", "input": {"before": before, "after": after}})

    big = _vocab(rng, 4096)

    add("empty_both", [], [])
    add("empty_before", [], _draw(rng, big, MAX_TOKENS - rng.randrange(8)))
    add("empty_after", _draw(rng, big, MAX_TOKENS - rng.randrange(8)), [])

    same = _draw(rng, big, MAX_TOKENS)
    add("identical_max", same, list(same))

    base = _draw(rng, big, MAX_TOKENS)
    add("near_identical_max", base, _edit(rng, base, big, 12))
    base = _draw(rng, big, MAX_TOKENS)
    add("near_identical_max", base, _edit(rng, base, big, 40))

    add("unrelated_max", _draw(rng, big, MAX_TOKENS), _draw(rng, big, MAX_TOKENS))
    small = _vocab(rng, 64)
    add("unrelated_max", _draw(rng, small, MAX_TOKENS), _draw(rng, small, MAX_TOKENS))

    trio = _vocab(rng, 3)
    add("duplicates_max", _draw(rng, trio, MAX_TOKENS), _draw(rng, trio, MAX_TOKENS))
    dup_base = _draw(rng, trio, MAX_TOKENS)
    add("duplicates_max", dup_base, _edit(rng, dup_base, trio, 25))

    period = _vocab(rng, 5)
    reps = MAX_TOKENS // len(period)
    before = period * reps
    shift = 1 + rng.randrange(len(period) - 1)
    after = (period[shift:] + period[:shift]) * reps
    add("ties_periodic", before, after)
    pair = _vocab(rng, 2)
    add("ties_periodic", pair * 300, list(reversed(pair)) * 300)
    add("ties_periodic", [pair[0]] * 600, [pair[1]] * 600)

    seq = _draw(rng, _vocab(rng, 256), MAX_TOKENS)
    add("reversed_max", seq, list(reversed(seq)))

    seq = _draw(rng, big, 900)
    start = rng.randrange(0, 300)
    length = rng.randrange(50, 200)
    block = seq[start:start + length]
    rest = seq[:start] + seq[start + length:]
    dest = rng.randrange(len(rest) - 300, len(rest) + 1)
    add("block_move", seq, rest[:dest] + block + rest[dest:])

    long_side = _draw(rng, big, MAX_TOKENS)
    picks = sorted(rng.sample(range(MAX_TOKENS), 4))
    add("asymmetric", long_side, [long_side[k] for k in picks] + [rng.choice(big)])
    add("asymmetric", [rng.choice(big) for _ in range(7)], _draw(rng, big, MAX_TOKENS))

    mixed_base = _draw(rng, _MIXED + _WORDS, 700)
    add("mixed_tokens", mixed_base, _edit(rng, mixed_base, _MIXED + _WORDS, 60))
    add("mixed_tokens", _draw(rng, _MIXED, 300), _draw(rng, _MIXED, 320))

    tok = rng.choice(_WORDS)
    add("single_token", [tok], [tok])
    add("single_token", [tok], [tok + "!"])
    add("single_token", [tok], [])

    return rows


if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("seed", type=int, nargs="?", default=0)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rows = cases(args.seed)
    if args.json:
        json.dump(rows, sys.stdout)
    else:
        for row in rows:
            before = row["input"]["before"]
            after = row["input"]["after"]
            print(f"{row['id']:<24} before={len(before):>4} after={len(after):>4}")
