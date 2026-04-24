---
title: i lifted claude haiku 4.5 from 65% to 85% solve rate on unseen github bugs for $1
date: 2026-04-19
slug: 2026-04-19-hone-haiku-20pp
---

$1 in sonnet mutator tokens lifted claude haiku 4.5 from 65% to 85% solve rate on 9 github bugs it had never seen. Same model, same evaluator, same scoring — only the system prompt changed. GEPA ran for ~7 hours on my claude max subscription (so no API spend at all on the executor side; the $1 is what sonnet burned proposing mutations).

The implication I didn't expect: every "model A beats model B" leaderboard that runs a bare seed prompt is under-specifying its agents. $1 of prompt optimization moves a model 20 percentage points on unseen bugs. If that holds even partially for other weak-to-medium models, the current wave of coding-agent benchmarks is measuring something closer to "how good is the model at guessing what the bare prompt means" than "how good is the model at fixing bugs".

The setup: haiku is the executor (the model actually fixing the bugs), sonnet is the mutator (proposes new prompt variants — this doesn't use any API credits since it shells out to the claude code CLI on my max sub). The grader runs [agentelo](https://github.com/twaldin/agentelo) challenges, scoring `tests_fixed / tests_broken_before` per challenge and reporting the mean. GEPA budget was 20 iterations, which converged after 3 accepted mutations (4th variant tied so it stopped).

## Training set (20 challenges)

Mix of repos to avoid single-library overfit: `click` (9 challenges), `marshmallow` (5), `qs` (4), `jinja` (2), `koa` (1). All real PRs from the last 90 days, each with a clean red/green test suite.

## Phase 1 — training trajectory

| iter | candidate                  | score (20 challenges) | delta vs seed |
| ---- | -------------------------- | --------------------- | ------------- |
| 0    | seed (14-word baseline)    | 0.5476                | —             |
| 1    | candidate 1 (6-step v1)    | 0.8583                | +0.3107       |
| 2    | candidate 2 (6-step v2)    | 0.9176                | +0.3700       |
| 3    | candidate 3 (tied)         | 0.9176                | +0.3700       |

Seed scored 11/20. Candidate 2 scored 18/20. The third candidate accepted on subsampling but didn't move the full-valset number, so GEPA stopped.

Obvious objection: the honed prompt is overfit to those 20 challenges. That's what phase 2 is for.

## Phase 2 — hold-out (9 unseen challenges × 3 samples)

Hold-out set has zero overlap with training: `marshmallow-pr2892, marshmallow-pr2894, marshmallow-pr2901, click-pr3152, requests-pr7205, qs-pr350, qs-pr506, qs-pr335, flask-pr5917` (requests and flask weren't even represented in training). Three independent samples per prompt, so 27 runs per column.

| sample | seed   | honed  | delta   |
| ------ | ------ | ------ | ------- |
| 1      | 0.6496 | 0.8889 | +0.2393 |
| 2      | 0.7607 | 0.8718 | +0.1111 |
| 3      | 0.5385 | 0.7778 | +0.2393 |
| mean   | 0.6496 | 0.8462 | +0.1966 |

All three samples improved. No regressions. Seed solves 65% of unseen bugs, honed solves 85%. That's +20 absolute percentage points on bugs GEPA never trained on — roughly half the training-set lift transfers (training gap was +0.37, hold-out is +0.20, which is the expected train/test delta you'd get in any ML setup).

## The actual prompts

Seed (score 0.5476):

```
You are an AI coding agent fixing a bug in an open-source project.
Approach each task carefully and produce a minimal, correct fix.
```

Honed candidate 2 (score 0.9176 train / 0.8462 holdout):

```
You are an AI coding agent fixing a bug in an open-source project.

Follow this process for every task:

1. Read ALL the failing tests first. Before touching any source code, read the
   relevant test files completely. Run the test suite and capture the full
   output — note every failing test case, not just the first one. Group the
   failures by type to understand the full scope of what needs to be fixed.

2. Find the root cause. Trace each failure to the specific line(s) responsible.
   Read the source code — not just the test file. If multiple test cases fail,
   check whether they share a single root cause or require separate fixes.
   Check git log or comments if the logic is unclear.

3. Fix the root cause, not the symptom. Make the minimal change that makes the
   failing tests pass without breaking existing tests. Do not add workarounds
   or special-case patches if the underlying logic is wrong. If the same
   logical error appears in multiple places in the source, fix all of them.

4. Handle edge cases. If the tests involve edge cases (empty strings,
   null/undefined, special characters, numeric boundaries, nested structures,
   encoding, array notation, option flags), make sure your fix handles all of
   them — not just the obvious case. For libraries with configurable behavior,
   check whether option or configuration values affect the code path you are
   fixing.

5. Verify all tests pass. After editing, run the full test suite. If some
   previously failing tests still fail, do not stop — re-read those specific
   failing test cases, understand precisely what they expect, and revise your
   fix. Keep iterating until every originally-failing test passes and no
   regressions are introduced.

6. Persist through partial fixes. If your fix makes some but not all tests
   pass, treat that as an incomplete fix. Re-read the remaining failures
   carefully, check if there is a second location in the source that needs the
   same or a related fix, and continue. Partial progress is not success.

Keep changes minimal and correct. Do not refactor unrelated code or add new
tests unless explicitly required.
```

## What GEPA learned

Diff between candidate 1 and candidate 2 is small but pointed. Every addition targets the same failure mode: haiku fixes the first visible issue and declares victory.

| change area   | 1 → 2                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| Test reading  | "Read the failing tests" → "Read ALL the failing tests". "note every failing test case". |
| Root cause    | "Trace the failure" → "Trace each failure". Added multi-failure root-cause check.        |
| Fix           | Added: "If the same logical error appears in multiple places, fix all of them."          |
| Edge cases    | Added concrete examples (encoding, array notation, option flags) + config-check clause.  |
| Verification  | "Confirm all tests pass" → "Keep iterating until every originally-failing test passes".  |
| Persistence   | "Persist" → "Persist through partial fixes. Partial progress is not success."            |

Every one of those additions pushes against haiku's tendency to stop early. The honed prompt isn't clever — it's basically "don't stop, check everything, don't trust the first fix". That's why it generalizes: the failure mode generalizes.

## Prior run I wasted time on

My first honing attempt trained on only 3 challenges (`qs-pr335, click-pr2846, marshmallow-pr2901`), lifted seed from 0.6667 → 1.0 on the training set — but the A/B test on 6 unseen challenges regressed from 0.9167 (seed) to 0.8102 (honed). Three training challenges was just too narrow to force a generalizable prompt; GEPA memorized the qs-pr335 specifics and tanked on unrelated bugs. Going to 20 training challenges was the fix. Lesson is probably obvious in hindsight but I didn't catch it until the holdout run came back worse.

The lift isn't universal though — it correlates inversely with how strong the seed model already is. I ran an earlier hone experiment on gpt-5.4 and it stayed at 0.6667, zero movement. The bare seed (`minimal correct fix`) already matches gpt-5.4's internal behavior, so there's nothing for GEPA to discover. Stronger models saturate at seed; weaker models have headroom. Haiku sits in the sweet spot, which is why $1 of mutation moved it 20 percentage points and the same setup moved gpt-5.4 zero.

## Cost breakdown

- Sonnet mutator (via claude code CLI on my claude max sub): ~$1 in tokens for 3 mutation rounds. Would have been more if GEPA hadn't converged early.
- Haiku executor (via claude code CLI on the same sub): not billed per API call — claude max caps apply, but this is the most GEPA-efficient path since API usage would have cost real money.
- Wall clock: ~7 hours across phase 1 (training) + phase 2 (hold-out A/B × 3 samples).
- Grader overhead: agentelo spins up fresh repo checkouts per challenge, so most of the wall clock is git/docker, not model calls.

GEPA, DSPy, and Arize Prompt Learning all require paid API keys to run. Hone uses your existing CLI subscription (claude code, codex, opencode, gemini) as the mutation engine instead.

## Next experiments (running as I type this)

Ran seed-only passes on `opencode + gpt-5.4-mini` and `opencode + gemini-2.5-flash` on a 6-challenge subset of the training set while drafting this. gpt-5.4-mini came in at 0.78 (4 perfect, 1 failed, 1 at 0.67) — moderate headroom, maybe 10-15pp of room if hone is as effective here as it was on haiku. gemini-2.5-flash came in near 0.2 — classic Goldilocks, big room for lift. Running full hone on both this week.

If you want the hone repo and the full honed prompt text: [github.com/twaldin/hone](https://github.com/twaldin/hone). Run directory with all variants: `~/hone/.hone/run-20260418-175259-e848a1/`. Full writeup with the original training log is at [writeup/2026-04-18-haiku-20train-9holdout.md](https://github.com/twaldin/hone/blob/main/writeup/2026-04-18-haiku-20train-9holdout.md).
