---
title: using gepa to hone claude haiku on github bug fixes (+20pp unseen)
date: 2026-04-19
slug: 2026-04-19-hone-technical
---

GEPA ran 7 hours against claude haiku 4.5 on 20 github bug-fix challenges and produced a system prompt that moved haiku from 65% to 85% solve rate on 9 held-out bugs. Same model, same evaluator, same scoring — only the system prompt changed. That's +20 absolute percentage points (+30% relative) on bugs GEPA never trained on.

The system isn't novel. It's three off-the-shelf pieces glued together. [GEPA](https://github.com/dspy-ai/gepa) is the prompt optimizer (pareto-style mutation + selection out of the dspy project). [harness](https://github.com/twaldin/harness) is my python lib that wraps 6 AI coding CLIs — claude code, codex, opencode, gemini, cursor, aider — behind one API so GEPA can drive any of them as the executor. [agentelo](https://github.com/twaldin/agentelo) is my leaderboard / challenge runner; it scores each challenge as `tests_fixed / tests_broken_before` and reports the mean. Hone is the ~300-line coordinator wiring them together: GEPA proposes a system prompt variant, harness runs the executor CLI with that prompt, agentelo grades the resulting diff against the real PR's test suite.

(The mutator here was sonnet via the claude code CLI on my max sub, so no API billing — but the point of hone is that any CLI can drive any other CLI, not that it happened to be free this run.)

## training trajectory

20 training challenges pulled from 5 repos — `click` (9), `marshmallow` (5), `qs` (4), `jinja` (2), `koa` (1) — all real PRs from the last 90 days with clean red/green test suites.

| iter | candidate | full valset (20) | delta vs seed |
| ---- | --------- | ---------------- | ------------- |
| 0 | seed (14 words) | 0.5476 | — |
| 1 | candidate 1 (6-step v1) | 0.8583 | +0.3107 |
| 2 | candidate 2 (6-step v2) | 0.9176 | +0.3700 |
| 3 | candidate 3 (tied on full) | 0.9176 | +0.3700 |

Seed solves 11/20. Candidate 2 solves 18/20. Third candidate climbed on GEPA's subsample eval but tied on the full valset, so GEPA stopped. Budget was 20 iters; actual spend was 4.

## holdout — 9 unseen bugs × 3 samples

Holdout has zero overlap with training: `marshmallow-pr2892, marshmallow-pr2894, marshmallow-pr2901, click-pr3152, requests-pr7205, qs-pr350, qs-pr506, qs-pr335, flask-pr5917`. `requests` and `flask` weren't in training at all. Three independent samples per prompt = 27 runs per column.

| sample | seed   | honed  | delta   |
| ------ | ------ | ------ | ------- |
| 1      | 0.6496 | 0.8889 | +0.2393 |
| 2      | 0.7607 | 0.8718 | +0.1111 |
| 3      | 0.5385 | 0.7778 | +0.2393 |
| mean   | 0.6496 | 0.8462 | +0.1966 |

All three samples improved. No regressions. Training lift was +0.37, holdout lift is +0.20 — about half transfers, which is roughly the train/test gap you'd expect from any ML setup.

## what GEPA actually discovered

The diff between candidate 1 and candidate 2 is small, but every change points at the same failure mode: haiku fixes the first visible failing test and declares victory.

| area          | 1 → 2                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------- |
| test reading  | "read the failing tests" → "read ALL the failing tests" + "note every failing test case". |
| root cause    | "trace the failure" → "trace each failure". Added multi-failure root-cause check.         |
| fix           | Added: "if the same logical error appears in multiple places, fix all of them".           |
| edge cases    | Added concrete examples (encoding, array notation, option flags) + a config-check clause. |
| verification  | "confirm all tests pass" → "keep iterating until every originally-failing test passes".   |
| persistence   | "persist" → "persist through partial fixes. partial progress is not success."             |

The honed prompt isn't clever. It's "don't trust the first green, check every test, keep looking for a second bug site". GEPA spent its three accepted mutations localizing exactly that one failure mode — and because that failure mode generalizes across codebases, the fix generalizes too.

Seed (0.5476):

```
You are an AI coding agent fixing a bug in an open-source project.
Approach each task carefully and produce a minimal, correct fix.
```

Candidate 2, the one that shipped (train 0.9176 / holdout 0.8462):

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

## why haiku and not anything else

Haiku sits in the goldilocks band for this kind of prompt honing. Too weak, and the executor can't actually follow the methodology the mutator writes — adding "check for a second bug site" to the prompt doesn't help if the model couldn't trace to the first bug site reliably. Too strong, and the bare seed prompt already matches what the model does internally, so there's nothing for GEPA to discover.

I ran overnight seed baselines on four neighbours to find the next goldilocks target. The news was mostly flat:

- `opencode + gemini-2.5-flash` — seed in the 0.2 range. Followed up a short hone run; no meaningful lift. Executor is too weak to actually execute the 6-step methodology.
- `codex + gpt-5.2` — saturated at seed (already in the 0.85+ band). GEPA mutations produced no measurable improvement over the already-strong baseline.
- `codex + gpt-5.4-mini` — saturated at seed.
- `codex + gpt-5.4-mini-fast` — saturated at seed.

The earlier gpt-5.4 run sat in the same bucket — bare "minimal correct fix" already matches gpt-5.4's internal behavior, zero movement from GEPA. So the window where prompt honing moves the number is narrower than I'd hoped: somewhere in the 0.5–0.7 seed band. Outside that, either the executor can't use the better prompt (floor) or doesn't need it (ceiling).

## the 3-challenge run I wasted two days on

First attempt trained on only 3 challenges (`qs-pr335, click-pr2846, marshmallow-pr2901`). Training score hit 1.0 but the A/B on 6 unseen bugs regressed from 0.9167 seed to 0.8102 honed. GEPA had memorized qs-pr335's query-string specifics and tanked on unrelated bugs. Scaling training to 20 challenges across 5 repos was the fix — probably obvious in hindsight (diversity of training distribution matters for generalization) but I only caught it after the holdout came back worse.

Run directory with every candidate prompt and every grader log: `~/hone/.hone/run-20260418-175259-e848a1/`. Repo: [github.com/twaldin/hone](https://github.com/twaldin/hone). Earlier writeup with the full training log: [writeup/2026-04-18-haiku-20train-9holdout.md](https://github.com/twaldin/hone/blob/main/writeup/2026-04-18-haiku-20train-9holdout.md).
