# Predeclaration 9: development pilot, seed 0

Commit this declaration before the first search call. It implements Tim's order 276, the first-seed six-search option, and the assistant's subsequent ruling authorizing seed dispatch and stop-rule fixes. The prior preflight stop is preserved under `seed0-preflight-9`; it spent no pilot model calls.

## Fixed matrix and resources

The complete authorized matrix is six cells, in this serial order:

| Order | Task | Method | Search seed |
| --- | --- | --- | ---: |
| 1 | MBPP | Hone | 0 |
| 2 | MBPP | Official GEPA | 0 |
| 3 | MBPP | Plain agent loop | 0 |
| 4 | HoVer | Hone | 0 |
| 5 | HoVer | Official GEPA | 0 |
| 6 | HoVer | Plain agent loop | 0 |

Use the admitted MBPP + HoVer panel in `run-plan-8a.json`, `controls-7b`, and the unchanged seed artifacts. IFBench failed its noise gate and remains excluded. AIME remains withdrawn. No new controls or substitutions are authorized.

Every cell retains the smoke's matched $10-equivalent ceiling, 12 million charged tokens, 30,000 model calls, 500 proposer or repair calls, 10,000 scored rollouts and 7,200 active seconds. Initial selection, task execution, proposals, format repairs, failures, retries and repeated selection all consume the same ledger. Report provider-reported usage and conservative refusal estimates separately. There is no free confirmation evaluation or extra inference budget. Actual subscription access has no monetary spending cap under H4; dollar-equivalent matching remains the experimental purchasing comparison.

Keep the pinned official GEPA commit, Hone and plain search policies, task/proposer route `anthropic/claude-sonnet-4-6`, decoding, model response caps, retrieval recipe, protected graders, data splits, deployment limits and predeclared admission gates unchanged. Source transition 9 authenticates the exact dispatch and pause-boundary changes against the immutable contract-8a source and preserves its archived execution identities. Each new search manifest also records the actual execution-source hashes and transition-9 provenance.

Use the frozen command shape with the now-effective explicit seed restriction:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot pilot --controls evidence/pilot/controls-7b --seed 0 --out .pilot-runs/pilot-seed0-9
```

Run serially to keep one model-dispatch stream and one CPU-heavy worker, leaving the subscription reserve and other CPUs available to other seats. No concurrency advantage is claimed. Use a named systemd user unit with `Restart=no`; record its name and MainPID in lane state. Never restart or selectively rerun an interrupted cell.

## Selection comparison and interval

Label every result **development pilot, seed 0**. This is adaptive development selection, not an unbiased deployment estimate or a superiority claim.

MBPP uses the fraction of its 90 official selection instances passing all protected development assertions. HoVer uses its official normalized supporting-title subset metric on its 300 selection instances. Preserve exact unique selection row IDs, with one score per instance per chosen measurement vector. No final-test rows or labels are loaded.

For each method and task, compare the method's chosen artifact with its unchanged starting seed artifact on the same selection instances. Use the first complete full-selection evaluation of the seed artifact as the baseline vector. If the chosen artifact is unchanged, use that identical baseline vector on both sides, so its artifact-change delta and interval are exactly zero. Report the runner's retained selection score separately if later stochastic reevaluations give it a different value.

For a changed chosen artifact, use the last complete full-selection evaluation of that artifact whose mean matches its retained selection score within absolute tolerance `1e-12`. Align both vectors by unique row ID. Reject duplicate, extra, nonfinite or inconsistent records. Never pool repeated adaptive evaluations or count the same row as multiple independent observations. If a completed matching vector is unavailable, report the comparison as unavailable with its evidence, not an invented delta. Do not combine independently logged partial evaluations across unrelated calls.

The assistant's ruling adapts `hone-optimizer-plan.md:180` to one search seed and development selection:

1. For each task and method, form the chosen-minus-seed paired score difference per unique selection instance. Draw 10,000 bootstrap resamples of those instances with replacement, each with that task's original number of unique instances, and compute the mean paired delta for each resample.
2. Report the observed mean paired delta and its 95% percentile interval, using the 2.5th and 97.5th percentiles with type-7 linear interpolation.
3. For each method across MBPP and HoVer, report the equal-weight two-task mean of the raw baseline scores, chosen scores and paired deltas. For its interval, draw two tasks with replacement, then independently resample the original number of paired instances within each drawn task occurrence. Average the two task means. Repeat 10,000 times and use the same percentile endpoints.
4. Use standard-library `random.Random`, MT19937, seeded `20261109`, independently initialized for each reported bootstrap. Sort instance identities before sampling and use the fixed MBPP, HoVer task order for reproducibility.

No seed resampling is performed with one seed. No Holm correction is applied at this stage. Report whether each interval excludes zero, but do not call that superiority. Mark the 2 absolute score-point practical effect threshold, `0.02` on the normalized metric, from the assistant's ruling on plan line 190. Report the point estimate relative to that threshold and whether the interval lies above it. A wide interval is inconclusive, not evidence of a tie. No decisions about further seeds are automated by this report.

## Dispatcher stop rules and throttle

Before each new cell, inspect all finished-cell receipts in the run:

- Stop new dispatch if total hidden attempts divided by total calls exceeds 1%. Exactly 1% does not stop. This is the run-wide rate, not an average of cell rates.
- Stop new dispatch if any finished cell's unknown-usage calls divided by its own calls exceeds 1%. Use all `usage_missing_calls`, including refused calls with conservative estimates, and report unbounded non-refusal omissions separately. Do not dilute one cell's missing usage with another cell's calls.
- Stop new dispatch after two consecutive `infrastructure_failure` cell results. A completed cell resets the streak.
- Stop and hand back if accumulated throttle pauses exceed six hours. Pass the remaining run-wide pause allowance into the active cell's existing throttle so an ongoing outage cannot wait indefinitely beyond this handback boundary. Preserve its pause journal and consumed-usage prefix.

A stop records its reason and supporting counts in `stop.json` and `comparison.json`. A cell already running may finish under the rate and failure rules; no new cell starts after the trigger. Serial execution has no second in-flight cell to cancel. The six-hour pause handback ends the active wait without another provider dispatch. Record a trigger found in the final cell too, even though no next cell remains.

Keep the existing throttle admission rules unchanged: pause above 80% usage, on stale or missing usage, and during broker outage. Check every allowed account and every reported limit; keep the ten-minute freshness bound and 30-second retry cadence. A broker relocation is an outage pause, followed by autonomous reconnection, not permission to change broker or omp configuration. The account pool remains gmail.com ×2 and purdue.edu ×1, with lindy.ai and API keys excluded.

Keep predeclaration 8's refusal rule uniformly across methods and roles: score zero, never retry a terminal refusal, and conservatively charge missing refusal usage. Refusal nondeterminism remains an immediate shared stop. The dispatcher changes do not weaken that existing safety boundary.

A genuine gate or harness failure before the first search, an abort-rule trigger, total throttle pauses above six hours, or two consecutive infrastructure failures ends this run with preserved evidence. The authorized dispatcher corrections and their failing-before regression tests are prerequisites, not permission to ignore a later failed gate.

## Evidence and limits

Report, per cell, chosen and unchanged selection scores, paired delta and interval, changed-artifact retention, calls, reported and estimated tokens and dollar-equivalents by proposal, training evaluation and selection evaluation, unassigned incomplete tails, wall time, active time, polling time, pauses, refusals, hidden attempts and missing usage. Then report per-method totals and equal-weight two-task inference. Preserve raw artifacts, outputs, receipts, manifests, phase reconciliation, stop records and hashes in a replayable bundle. Missing or unstarted cells have unavailable inference, never fabricated zero scores.

Update PR #37. Require green CI and an exact-head cross-family READY before searching on the corrected harness, and again after adding the final evidence. Stop before merge.

**Seeds 2-3 and any final-test evaluation are out of scope.** In zero-based search-seed notation, only seed 0 is authorized; seeds 1 and 2 remain out of scope. No matrix beyond these six cells, no new model route, no public optimizer-quality claim and no merge are authorized.
