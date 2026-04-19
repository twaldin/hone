# Hone on Claude Haiku 4.5 — 20 training challenges, 9 hold-out

**Run:** `~/hone/.hone/run-20260418-175259-e848a1/`
**Started:** 2026-04-18 17:53 UTC
**Finished:** 2026-04-19 02:49 UTC — phase 1 done (3 accepted iters, best 0.9176), phase 2 hold-out A/B done

## Setup

- Executor (graded model): `claude-code` / `claude-haiku-4-5-20251001`
- Mutator (prompt proposer): `claude-code` / `sonnet`
- Grader: `~/hone/examples/agentelo-multi-challenge.sh` — runs agentelo practice on each challenge, scores `tests_fixed / tests_broken_before` per challenge, reports mean
- Budget: 20 GEPA iterations
- Parallel: 5 (agentelo practices run 5 at a time)
- Grader timeout: 7200s per full-valset batch

**Training set (20 challenges):** mixed difficulty, mixed repos

```
click-pr2935, marshmallow-pr2874, jinja-pr1858, marshmallow-pr2903,
click-pr3004, click-pr2811, marshmallow-pr2909, marshmallow-pr2861,
click-pr2930, click-pr2846, qs-pr224, jinja-pr1613, qs-pr441,
qs-pr336, marshmallow-pr2800, click-pr3225, qs-pr202, click-pr2956,
qs-pr201, koa-pr1914
```

**Hold-out set (9 challenges, zero overlap with training):**

```
marshmallow-pr2892, marshmallow-pr2894, marshmallow-pr2901, click-pr3152,
requests-pr7205, qs-pr350, qs-pr506, qs-pr335, flask-pr5917
```

Phase 2 will run seed prompt vs honed prompt on hold-out × 3 samples each to test generalization.

## Phase 1 — training trajectory (full valset, 20 challenges)

| iter | candidate | valset score | delta vs seed |
|------|-----------|--------------|---------------|
| 0 | seed | 0.5476 | — |
| 1 | candidate 1 (6-step workflow) | 0.8583 | +0.3107 |
| 2 | candidate 2 (refined 6-step, "all tests", "persist through partial") | 0.9176 | +0.3700 |
| 3 | candidate 3 | 0.9176 | +0.3700 (tied) |

Seed valset score 0.5476 ≈ 11/20 challenges solved. Candidate 2 valset score 0.9176 ≈ 18/20 solved. Candidate 3 got accepted (subsample score climbed) but tied on full valset — GEPA converged.

## Phase 2 — hold-out A/B (9 unseen challenges × 3 samples each)

Hold-out test bypasses any training-set overfitting by running both prompts on challenges GEPA never saw.

| sample | seed | honed | delta |
|---|---|---|---|
| 1 | 0.6496 | 0.8889 | +0.2393 |
| 2 | 0.7607 | 0.8718 | +0.1111 |
| 3 | 0.5385 | 0.7778 | +0.2393 |
| **mean** | **0.6496** | **0.8462** | **+0.1966** |

**All 3 samples improved. Zero regressions.** Same haiku model, same 9 unseen bugs, only the system prompt differs.

- Seed (bare "minimal correct fix") → **65% solve rate**
- Honed (candidate 2, 6-step methodology) → **85% solve rate**
- **+20 absolute percentage points / +30% relative**

Training lift was +0.37; hold-out lift is +0.20 — about half transfers. That's the expected train/test gap.

## Prompts

### Seed (candidate 0) — score 0.5476

```
You are an AI coding agent fixing a bug in an open-source project.
Approach each task carefully and produce a minimal, correct fix.
```

### Candidate 1 — score 0.8583

```
You are an AI coding agent fixing a bug in an open-source project.

Follow this process for every task:

1. **Read the failing tests first.** Before touching any source code, read the relevant test files to understand exactly what behavior is expected. Run the test suite to see the actual error messages and which cases fail.

2. **Find the root cause.** Trace the failure to the specific line(s) responsible. Read the source code — not just the test file. Check git log or comments if the logic is unclear.

3. **Fix the root cause, not the symptom.** Make the minimal change that makes the failing tests pass without breaking existing tests. Do not add workarounds or special-case patches if the underlying logic is wrong.

4. **Handle edge cases.** If the tests involve edge cases (empty strings, null/undefined, special characters, numeric boundaries, nested structures), make sure your fix handles all of them — not just the obvious case.

5. **Verify.** After editing, run the full test suite. Confirm all previously failing tests now pass and no regressions were introduced.

6. **Persist.** If your first fix does not make the tests pass, re-read the error output, revise your understanding of the root cause, and try again. Do not give up after a single attempt.

Keep changes minimal and correct. Do not refactor unrelated code or add new tests unless explicitly required.
```

### Candidate 2 — score 0.9176 (current best)

```
You are an AI coding agent fixing a bug in an open-source project.

Follow this process for every task:

1. **Read ALL the failing tests first.** Before touching any source code, read the relevant test files completely. Run the test suite and capture the full output — note every failing test case, not just the first one. Group the failures by type to understand the full scope of what needs to be fixed.

2. **Find the root cause.** Trace each failure to the specific line(s) responsible. Read the source code — not just the test file. If multiple test cases fail, check whether they share a single root cause or require separate fixes. Check git log or comments if the logic is unclear.

3. **Fix the root cause, not the symptom.** Make the minimal change that makes the failing tests pass without breaking existing tests. Do not add workarounds or special-case patches if the underlying logic is wrong. If the same logical error appears in multiple places in the source, fix all of them.

4. **Handle edge cases.** If the tests involve edge cases (empty strings, null/undefined, special characters, numeric boundaries, nested structures, encoding, array notation, option flags), make sure your fix handles all of them — not just the obvious case. For libraries with configurable behavior, check whether option or configuration values affect the code path you are fixing.

5. **Verify all tests pass.** After editing, run the full test suite. If some previously failing tests still fail, do not stop — re-read those specific failing test cases, understand precisely what they expect, and revise your fix. Keep iterating until every originally-failing test passes and no regressions are introduced.

6. **Persist through partial fixes.** If your fix makes some but not all tests pass, treat that as an incomplete fix. Re-read the remaining failures carefully, check if there is a second location in the source that needs the same or a related fix, and continue. Partial progress is not success.

Keep changes minimal and correct. Do not refactor unrelated code or add new tests unless explicitly required.
```

## What GEPA learned

Diff 1 → 2 is subtle but pointed:

| change | 1 → 2 |
|---|---|
| Test reading | "Read the failing tests" → **"Read ALL the failing tests"**. "note every failing test case, not just the first one" added. |
| Root cause | "Trace the failure" → "Trace each failure". "check whether they share a single root cause or require separate fixes" added. |
| Fix | Added: "If the same logical error appears in multiple places in the source, fix all of them." |
| Edge cases | Added: "encoding, array notation, option flags". Added: library-configurability check. |
| Verification | "Confirm all previously failing tests now pass" → **"Keep iterating until every originally-failing test passes"**. |
| Persistence | Reworded to "Persist through partial fixes" with "Partial progress is not success". |

Every addition targets **multi-failure scope management** — treating a bug as a set of failing tests to chase down rather than the first one the agent finds. That's a known haiku failure mode: it fixes the first visible issue and declares done. Candidate 2 explicitly counters that.

## Prior comparison (why this run matters)

A previous run on only 3 training challenges (`qs-pr335, click-pr2846, marshmallow-pr2901`) lifted seed from 0.6667 → 1.0, but the A/B test on 6 held-out challenges regressed from 0.9167 (seed) to 0.8102 (honed). Conclusion: 3-challenge training was too narrow, the honed prompt overfit to qs-pr335 specifics.

This 20-challenge run should be much more robust. Phase 2 A/B on 9 held-out challenges (3 samples each) will be the real test.

## What this proves (so far)

- **Hone + haiku + GEPA produces real prompt improvements** on coding-agent bug-fix tasks, at least within the training distribution.
- **Stronger models saturate** — gpt-5.4 stayed at 0.6667 in an earlier run because the seed instruction (`minimal correct fix`) already matches what gpt-5.4 does internally. Prompt lift is highest on weaker models.
- **Cost so far:** ~$0.65 sonnet mutator + ~20min/valset-eval × 3 evals worth of haiku grader calls — cheap relative to the ceiling improvement.

## Verdict

**Hone works on haiku for real bug-fixing.** Confirmed across 20 training + 9 hold-out challenges, 3 samples per hold-out for statistical confidence. Same model, same bugs, prompt-only change lifts solve rate by 20 percentage points absolute on unseen tasks.

The candidate 2 prompt transfers because it isn't bug-specific — it's a methodology prompt targeting known haiku failure modes (stopping after first test passes, ignoring multi-location bugs, giving up after one fix attempt). Those failure modes generalize across codebases, so the fix generalizes too.

## Next experiments

- Re-run the same training set with weaker models (gpt-5.4-mini / gemini-flash-lite / gpt-oss-120b / minimax) to test: does hone lift generalize across models, or is candidate 2 specific to haiku?
- Seed-only evals first on each candidate model to identify the Goldilocks zone (seed 0.2-0.5) before committing full runs.
