# Contributing to hone

Thanks for the interest. hone is a small tool with one job: run GEPA against a CLI mutator. Keep contributions focused on that.

## Before you open a PR

- **Open an issue first** for anything bigger than a typo or a one-line fix.
- Keep the scope tight. One conceptual change per PR.
- Match existing style. Read a few neighboring files before writing.

## Running the tests

```bash
PYTHONPATH=src uv run pytest tests/
```

All 22 tests must pass.

## Style

- Type hints on public functions, no `Any` in mutator surfaces.
- `from __future__ import annotations` at the top.
- Match surrounding code.
- Write no comments by default. Only add a comment when *why* the code is the way it is would surprise a future reader.

## PR etiquette

- Title: imperative, lowercase.
- Body: what changed, why, how you tested.

## What I'm likely to merge

- New mutators (inherit from `Mutator`; see `src/hone/mutators/harness_mutator.py` for the cleanest example).
- New graders / grader helpers with a realistic example.
- Bug fixes with a test that would have caught the bug.
- Docs fixes.

## What I'll probably close

- Alternatives to GEPA as the optimizer (different project).
- Feature-flagged additions with no usage path.
- Changes to the mutator contract without a migration plan.
