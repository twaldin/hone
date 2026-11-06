# Predeclaration 10: development pilot, seeds 1 and 2

Commit this declaration before any search call. This declaration authorizes twelve development-pilot cells after the selection-score reuse correction, not a final-test evaluation or a public optimizer-quality claim. No run completion is asserted here.

## Authorization and policy change

Tim chose "Fix, then seeds 1-2" on board tile `obj_01M6PMW7BBZET44KZ7` at `2026-11-06T00:04:02Z`. The option text was "Hone scores each artifact once and gives selection budget to gate-passing candidates first; predeclaration 10 before any run; then seeds 1-2 for all 3 methods (~38 h serial, ~$100-equivalent pool usage, not an invoice)".

After identifying that re-scoring was predeclared, Tim explicitly chose "Reuse scores (your fix, as asked)" on board tile `obj_01M6Q2WGPG5W4DQ75N` at `2026-11-06T00:08:09Z`. This decision supersedes the fresh paired full-selection promotion rule at `docs/pilot.md:163` and the unchanged-search-policy rule at `predeclaration-9.md:22`, only for Hone and plain. All other predeclaration-9 requirements remain in force except its seed-0-only scope and one-seed aggregation, replaced below.

The shared Hone/plain selection loop in `pilot/search.py::_loop` must evaluate each distinct canonical artifact SHA256 on selection at most once per cell. Store only validated complete score vectors and reuse them for later comparisons. A candidate that passes the unchanged training gate receives its selection evaluation without first spending budget re-scoring a known parent. An incomplete evaluation still consumes budget and remains in the evidence. It is not a reusable complete vector or permission to restart an interrupted cell. The cache is per cell, not shared between seeds, tasks, or methods, and does not add persisted resume support.

Seed 0 showed the cost of the former policy: Hone/HoVer spent its remaining budget re-scoring the unchanged seed while a gate-passing candidate never reached selection. Repeated known-artifact measurements use the same matched budget that could evaluate new candidates. Reuse is expected to bias promotion conservatively, because retained parents tend to have lucky-high scores. This is an expected direction, not a measured effect or a claim that adaptive selection becomes unbiased.

Official GEPA is unchanged, including its pilot adapter, native search policy, and existing `cache_evaluation=False` configuration. Do not describe the actual GEPA pilot configuration as caching evaluations. Reuse applies only to Hone and plain. Training gates, proposal, restart, and repair behavior otherwise remain unchanged.

## Fixed matrix, budgets, and resources

Run exactly these cells serially:

| Order | Task | Method | Search seed |
| --- | --- | --- | ---: |
| 1 | MBPP | Hone | 1 |
| 2 | MBPP | Official GEPA | 1 |
| 3 | MBPP | Plain agent loop | 1 |
| 4 | HoVer | Hone | 1 |
| 5 | HoVer | Official GEPA | 1 |
| 6 | HoVer | Plain agent loop | 1 |
| 7 | MBPP | Hone | 2 |
| 8 | MBPP | Official GEPA | 2 |
| 9 | MBPP | Plain agent loop | 2 |
| 10 | HoVer | Hone | 2 |
| 11 | HoVer | Official GEPA | 2 |
| 12 | HoVer | Plain agent loop | 2 |

Use the admitted MBPP + HoVer panel, `controls-7b`, `run-plan-8a.json`, and unchanged starting artifacts. IFBench remains excluded and AIME withdrawn. No new control measurements, substitutions, gate relaxation, route changes, or broker/omp configuration changes are authorized. Bind the actual execution source, declaration identity, admission provenance, and resource hashes in each new manifest without rewriting archived evidence.

Each cell retains $10-equivalent charged usage, 12 million charged tokens, 30,000 model calls, 500 proposer or repair calls, 10,000 scored rollouts, and 7,200 active seconds. All roles, initial selection, task execution, repairs, failed calls, retries, and incomplete selection tails consume the same ledger. Separate provider-reported usage from conservative refusal estimates and unknown non-refusal usage. There is no free confirmation evaluation. The twelve-cell ceilings are $120-equivalent, 144 million charged tokens, 360,000 calls, 6,000 proposer or repair calls, 120,000 scored rollouts, and 24 active hours. Dollar-equivalent matching is not an invoice or a subscription spending cap under H4. Tim's roughly 38-hour and $100-equivalent figures are planning estimates, not measured results or guarantees.

Retain the pinned official GEPA commit, task/proposer route `anthropic/claude-sonnet-4-6`, temperature-zero decoding, disabled native reasoning, response caps, data splits, protected graders, deployment limits, and retrieval recipe. Reuse the admitted HoVer index copied from `/home/tim/worktrees/hone/hone-hone-pilot-seed0-1/.pilot-cache/`, following `index-artifact-9/README.md`. Verify source and copied hashes against the admitted receipt. Do not rebuild, re-admit, or modify the source index. A mismatch requires handback.

Use a named systemd user unit with `Restart=no`, CPU 6, nice 10, `OPENBLAS_NUM_THREADS=1`, `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `JAX_PLATFORMS=cpu`, and explicit `NLTK_DATA` pointing to the existing lane NLP cache before Python starts. Check live CPU affinities before launch. Keep one model-dispatch stream and one CPU-heavy worker. Record the unit name and MainPID in lane state. The existing CLI harness accepts multiple explicit seeds so one dispatcher retains cumulative stop and pause accounting across both seeds. Use one new output root and this launch command:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python -m pilot pilot --controls evidence/pilot/controls-7b --seed 1 2 --out .pilot-runs/pilot-seeds12-10
```

Single-seed `--seed 0`, `--seed 1`, and `--seed 2` behavior remains unchanged, but separate invocations do not replace this authorized twelve-cell launch. Never overwrite evidence, restart the unit automatically, or selectively rerun an interrupted cell.

## Paired comparisons and deterministic aggregation

Label each cell by method, task, seed, and predeclaration 10. MBPP uses the fraction of its 90 official selection instances passing all protected development assertions. HoVer uses its official normalized supporting-title subset metric on 300 selection instances. Load no final-test rows or labels.

Retain predeclaration 9's vector rules for every cell. The baseline is the first complete full-selection vector of the unchanged starting artifact. For an unchanged chosen artifact, use that identical vector on both sides and report exactly zero artifact-change delta and interval. Report any differing retained score separately. For a changed artifact, use its last complete vector matching the retained mean within absolute tolerance `1e-12`. Reuse means Hone/plain should have only one such complete measurement per distinct artifact. Align unique row IDs and reject duplicates, extra rows, nonfinite values, and inconsistent records. Never pool repeated adaptive measurements or assemble unrelated partial evaluations. If the necessary complete vector is absent, mark inference unavailable with its evidence.

Use 10,000 bootstrap replicates, standard-library `random.Random` MT19937 seeded `20261109`, independently initialized for each reported interval. Use 95% percentile endpoints at 2.5% and 97.5%, with type-7 linear interpolation. Sort unique row identities, order seeds as 1 then 2, and order tasks as MBPP then HoVer before sampling. For every replacement draw from an ordered population of size `n`, use `rng.choices(range(n), k=n)` and map the sampled indices back to that population. Use this same `random.choices` sampling mechanism as the historical predeclaration-9 reports, not repeated `randrange` draws, so their frozen random sequence remains unchanged. Resample paired chosen-minus-baseline differences, never baseline and chosen independently.

1. For each cell, retain predeclaration 9's paired-instance bootstrap. Resample the task's original number of unique instances and compute each mean paired delta.
2. For each method and task, compute raw baseline, chosen, and delta means with equal weight for seeds 1 and 2. For the task interval, draw two seed identities with replacement. Within each drawn seed occurrence, independently draw the original number of paired instances. Average the two seed-occurrence means.
3. For each method, compute the equal-weight mean of the two task aggregates. Thus each task has weight one half and each seed within each task has weight one half, regardless of row count or spend. For its hierarchical interval, draw two task identities with replacement. For each task occurrence, draw two seed identities with replacement. Independently resample paired instances within each seed occurrence, average those two seed means, then average the two task means.
4. Also retain per-seed equal-weight two-task comparisons and predeclaration 9's task-and-instance hierarchical intervals. There is no seed resampling within a single-seed report.

Do not silently drop missing seeds or tasks or reweight the remaining cells. An aggregate requiring an unavailable cell is unavailable. Keep available per-cell evidence and intervals.

Report whether intervals exclude zero, the point estimate relative to the practical threshold of 2 absolute score points (`0.02`), and whether each interval lies above that threshold. Apply no Holm correction. Wide intervals are inconclusive, not evidence of a tie. These are adaptive development-selection estimates, not superiority claims, unbiased deployment estimates, or automatic authorization for more seeds.

Keep predeclaration-9 seed 0 beside seeds 1–2 as historical pre-fix evidence. Never pool seed 0 with seeds 1–2 for Hone or plain. If GEPA seed 0 is shown, label it explicitly as historical predeclaration-9 seed 0 under unchanged GEPA, separate from the primary seeds-1–2 aggregate. Do not rewrite its reports or reinterpret stochastic re-scoring as independent artifact improvements.

## Stops, throttle, and refusal rules

Retain all predeclaration-9 stop and refusal rules. Treat seeds 1 and 2 as one twelve-cell run for cumulative stops, including the seed boundary. Before each cell inspect all finished receipts:

- Stop new dispatch when total hidden attempts divided by total calls exceeds 1%. Exactly 1% is allowed.
- Stop when any cell's `usage_missing_calls` divided by its own calls exceeds 1%, including estimated refusals. Report unknown non-refusal omissions separately. Do not dilute one cell's rate across other cells.
- Stop after two consecutive `infrastructure_failure` cell results. A completed cell resets the streak.
- Stop and hand back when total throttle pauses exceed six hours. Pass the remaining cumulative allowance into the active throttle, preserving pause journals and consumed-usage prefixes.

A running cell may finish before a rate-based stop, but no new cell starts after the trigger. The pause boundary ends an active wait without another dispatch. Record final-cell triggers too. Preserve reason and counts in `stop.json` and `comparison.json`, including a stop discovered at the seed boundary.

Keep the 80% usage threshold, every-account/every-limit checks, ten-minute freshness bound, and 30-second polling cadence. Missing, malformed, or stale usage and broker outages pause dispatch. Reconnect autonomously after outages without changing configuration. The OAuth-only pool remains gmail.com ×2 and purdue.edu ×1, excluding lindy.ai and API keys. Preserve the existing metered non-refusal retry policy and all unknown-usage disclosures. No new retry allowance is introduced.

A terminal provider refusal scores zero and is never retried, uniformly across methods, roles, and seeds. Conservatively charge missing refusal usage. A request hash both refused and answered triggers an immediate shared stop, never a fallback. A genuine pre-search gate or harness failure, an abort trigger, or a pause-boundary handback ends the run with evidence preserved. No automatic infrastructure restart or fresh control allowance is authorized. Stop and hand back if the fix would change official GEPA or any search behavior beyond selection reuse and budget order. The original two-failed-review stop was honored before any search. The assistant authorized resumption around `2026-11-06T00:45Z` under Tim's order 302, reset the review-failure counter, and allowed up to two more review rounds. Under that ruling, hand back for a substantive finding about measurement validity, budget fairness, or official GEPA changes, or if a third round fails. CI must still pass before launch.

## Evidence, launch gate, and limits

Open a PR with the fix, regressions, and this committed declaration. Require green PR CI, the real zero-model CLI admission replay, unchanged admitted resources, and an exact-head cross-family READY before any search call. Require green CI and exact-head cross-family READY again on the final evidence head. Stop before merge.

Report per seed and cell, then per method and the seeds-1–2 aggregates: baseline and chosen scores, paired deltas and intervals, changed-artifact retention, calls, reported and estimated tokens and dollar-equivalents by proposal/training/selection, unassigned incomplete tails, wall and active time, polling, pauses, refusals, hidden attempts, and missing usage. Derive counts from evaluation and call records, including incomplete tails, rather than only completed evaluations. Report selection evaluations of already-scored artifacts and gate-passing candidates without a selection score, with reasons. The former must be zero for Hone and plain. Disclose GEPA's observed counts without asserting the unchanged external baseline follows the new reuse rule.

Preserve raw artifacts, outputs, receipts, manifests, source/admission provenance, phase reconciliation, stop records, and hashes in a replayable bundle. Unstarted cells have unavailable inference, never zero scores. If the lane deadline arrives with a live unit, hand back its name, PID, completed cells, and expected finish rather than restart it.

**Final-test evaluation and any seed beyond 2 are out of scope.** No public optimizer-quality claim, broker/configuration change, or merge is authorized.
