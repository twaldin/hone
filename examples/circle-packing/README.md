# circle-packing — hello world for hone

A tiny, fast optimization target. The mutator's job is to rewrite `placer.py`
so it packs more circle area into the unit square.

## The task

`placer.place(n)` returns a list of `(x, y, r)` tuples. Every circle must sit
fully inside `[0,1] × [0,1]` with no overlaps. Score = sum of radii, summed
across `n ∈ {7, 12, 20}`.

The seed `placer.py` uses a uniform square grid. Grid packing wastes space
whenever `n` is not a perfect square, so there is plenty of room for a smarter
strategy.

Typical single-eval time: well under a second. A 10-iteration run finishes in
a few minutes of wall time on a Claude Code subscription.

## Run it

From this directory:

```bash
hone run placer.py --grader ./grader.sh --mutator claude-code:sonnet --budget 10
```

Seed score is `4.666667`. A good solution breaks through 5.0; variable-radius
packings (big circles in corners, small circles in gaps) can push higher.

## Alternative: ACE observer (overkill here, but demonstrates the flag)

```bash
hone run placer.py --grader ./grader.sh \
  --mutator claude-code:sonnet \
  --observer claude-code:sonnet \
  --observer-interval 5 \
  --budget 15
```

The observer is [Zhang et al.'s ACE](https://arxiv.org/abs/2510.04618) port: a
reflector LLM reads the recent mutation history every 5 iterations and edits
the mutator's `CLAUDE.md` rules block. Useful on hard, heterogeneous problems;
overkill for a single file with a clear scoring signal like this one.

## Files

- `placer.py` — the mutation target. This is what hone rewrites.
- `grader.sh` — validates (no overlaps, everything in-bounds) and scores.
- `README.md` — this file.

## Notes

- The grader emits per-`n` diagnostics as JSON on stderr. hone's diagnose
  scheduler can route on those fields, though for a single-file run the
  scheduler is a no-op.
- All validation uses a `1e-9` tolerance on overlap and bounds. Expect the
  mutator to occasionally propose edits that violate bounds; invalid rollouts
  score 0.0 and are fed back as negative signal.
