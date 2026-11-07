# Predeclaration 11: receipted grader infrastructure and rerun 2

Commit this declaration before implementation tests, admission or search runs. Tim's order 367 selected "Record infra failures separately, then rerun" on ask `obj_01M6T9JX3ZE3DQK9J8` at `2026-11-07T07:33:25Z`. The assistant subsequently authorized the narrow negative-probe exception below and corrected the campaign budget. This declaration records those decisions, not a completed gate or run.

## Amendment: trusted candidate verdicts

The assistant's ruling after the exact-head review of `13cfdf8d8bb5a25be125a895291df8f759c90f52` accepts this distinction under Tim's order 367: a candidate program's own exception, wrong output or own time-limit overrun, reported through a trusted worker result, is a **wrong answer, score 0**, as before. This supersedes the earlier interpretation that every nonzero process exit caused by candidate code was necessarily infrastructure. Ordinary candidate failures must not invalidate the frozen naive controls or unchanged-seed noise trials; retained MBPP rows 640 and 847 must admit.

Only genuine sandbox/worker failures are unscored infrastructure: a worker dying or exiting without a valid trusted result frame, Docker/container failure, or a harness timeout without a trusted worker verdict. A raw process failure is never converted to a wrong answer. A trusted candidate-failure result is not a raw process failure. Preserve receipts for both, including the candidate-failure reason and invocation provenance. The approved intentional negative-control/adversarial unscored-rejection exception remains unchanged.

The candidate execution allowance remains 10 seconds. Enforce it inside the protected worker so an ordinary candidate overrun can produce a trusted wrong-answer verdict. A separately bounded outer supervision allowance may cover trusted startup and result delivery, never additional permitted candidate work; freeze that bound in the reviewed source/receipt before admission and charge all elapsed time under the unchanged active-time cap. If no trusted verdict arrives, outer timeout remains infrastructure. No row retry, campaign retry, budget reset, gate relaxation or method change is introduced.

The earlier CPU-affinity failure is independent launch configuration, not a policy choice: `AllowedCPUs=6` did not make the inherited affinity mask equal `[6]`. Use explicit `taskset -c 6` before Python in both admission and measured systemd commands, with the existing CPU-6 guard, nice 10, `Restart=no`, thread settings and `NLTK_DATA` unchanged. Do not suppress or relax the guard.

Commit this amendment before implementation tests, worker smoke, admission or search execution. Earlier failed admission receipts and the NOT_READY review remain historical evidence. The matrix, call/disk limits and all other rules below remain unchanged.

## Grader outcomes and the approved admission exception

Retain each grader outcome and its receipt: pass, wrong answer, sandbox timeout, nonzero worker exit without a trusted verdict, or frame failure. Only pass and wrong answer have numeric task scores, 1 and 0 respectively. Trusted candidate exceptions, incorrect output and candidate time-limit verdicts are wrong answers. Genuine sandbox/worker timeout, nonzero-exit and frame-failure outcomes are infrastructure, have no task score, and must never become wrong answers through an exception handler, comparison, missing-value default, mean, report or replay. Preserve stage, row and artifact context, pinned image/source identity, elapsed time, exit status, bounded output and error provenance sufficient to distinguish these outcomes. Retain receipts even when a cell aborts before an evaluation vector is written.

This is a shared protected-evaluation change for Hone, official GEPA and plain. It does not modify official GEPA source, its adapter/search policy, Hone/plain proposal/training/promotion policy, successful grader semantics, data, prompts, decoding, route, retrieval, deployment limits or per-cell caps. Hone and plain still store one complete selection vector per distinct canonical artifact per cell and reuse it; no incumbent remeasurement is introduced.

The assistant explicitly approved one necessary exception to the literal-zero admission expectations: receipt-bearing infrastructure outcomes from intentional negative-control and adversarial admission probes count as rejected, unscored results. Preserve every probe payload and row. A completed negative result must still be zero, never positive. An infrastructure negative is not assigned a synthetic zero and contributes no task mean. Require all such probes to be rejected, whether by a scored zero or by a receipted unscored infrastructure outcome. Reject positive outcomes and missing or inconsistent receipts.

This supersedes only the negative-probe numeric-zero requirements in earlier declarations and their validators where an approved probe produces infrastructure. Keep all other H7 requirements: the positive ranking, its zero lower boundary, naive below 0.90, the improved-minus-naive contrast, the original noise formula, thresholds, paired draws and memberships. Infrastructure during ordinary positive, training, selection or unchanged-seed noise evaluation is not an admissible zero or a discarded row. It aborts that evaluation and must be reported as infrastructure. No filtering, imputation or dilution of positive/noise measurements is authorized.

Infrastructure retry eligibility remains the existing campaign allowance. The updater replacement was rerun 1. The assistant authorized this fresh twelve-cell campaign as rerun 2 of at most 2 after the ENOSPC infrastructure abort. Do not multiply that allowance into two new attempts per grader row, retry a refused request, restart a partial cell, or introduce a third campaign. A grader infrastructure error propagates to a durable infrastructure-failure cell result; other cells may proceed only under the unchanged cumulative stop rules. Intentional negative fault probes record their expected rejection without consuming a campaign retry. No automatic restart is introduced.

## Fixed twelve-cell campaign

Use a fresh output root. Do not overwrite earlier attempts, replace their scores, or relabel prior-policy cells as new-policy measurements. Run serially in exactly this order:

| Order | Seed | Task | Method |
| --- | ---: | --- | --- |
| 1 | 1 | MBPP | Hone |
| 2 | 1 | MBPP | Official GEPA |
| 3 | 1 | MBPP | Plain |
| 4 | 1 | HoVer | Hone |
| 5 | 1 | HoVer | Official GEPA |
| 6 | 1 | HoVer | Plain |
| 7 | 2 | MBPP | Hone |
| 8 | 2 | MBPP | Official GEPA |
| 9 | 2 | MBPP | Plain |
| 10 | 2 | HoVer | Hone |
| 11 | 2 | HoVer | Official GEPA |
| 12 | 2 | HoVer | Plain |

Keep the admitted MBPP and HoVer development rows, `controls-7b`, `run-plan-8a.json`, original starting artifacts and all numerical admission requirements except the approved unscored negative-probe rejection. Require zero-model-call source/resource and outcome-boundary admission before launch. A genuine failed admission or substantive review finding requires handback, not a waiver.

Keep the exact lane-local omp 18.16.0 installation under `.pilot-cache/omp-18.16.0`, its CLI and lock hashes, OAuth-only Gmail x2 plus Purdue x1 pool, API-key prohibition and Lindy exclusion. Bind both runner and gateway explicitly to that copy. Reuse the admitted copied HoVer index, verify its receipt/hashes, and never rebuild it. Global omp, broker, configuration and updater schedule remain untouched.

Use a named systemd user unit with `Restart=no`, CPU 6, nice 10, one-thread settings and explicit `NLTK_DATA`. Keep one model-dispatch stream and one CPU-heavy worker. Record the unit, PID, declaration commit and exact-head launch gates. Never access home's GUI or Deadlock.

## Caps, projection and disk stop

All original per-cell ceilings remain: $10-equivalent charged usage, 12 million charged tokens, 30,000 model calls, 500 proposer or repair calls, 10,000 scored rollouts and 7,200 active seconds. All roles, incomplete evaluations, failures and allowed transport retries consume their original ledger. Grader time and failures are not free extra search time. Refusals remain zero and are never retried; conservative unknown-usage charging and the shared answered/refused-request stop remain unchanged.

The corrected additional-campaign cap is **35,000 model calls** across the twelve new cells, all roles included. The approximately $110-equivalent figure is a planning conversion from the prior recorded $52.612575-equivalent per 16,592 calls, not an invoice or a separate dollar spending cap under H4. The former 1.5x/24,888-call planning stop is superseded; the earlier "~3-equivalent" was a shell-mangled "$53-equivalent". Preserve all old usage and abort overhead separately instead of erasing it or counting it twice as new campaign usage.

Freeze an initial matched-cell call projection from the five completed seed-1 cells. For HoVer/plain, use the ceiling of its recorded 2,016-call prefix multiplied by the unchanged $10-equivalent per-cell ceiling divided by its recorded $9.407745-equivalent prefix: 2,143 calls per seed. This gives 33,438 projected calls for the full matrix. This is a planning estimate, not a statistical or physical bound.

Before each cell, add actual new-campaign usage to the projected costs of remaining cells. For each task/method, use at least the frozen forecast and increase it to any larger observed completed-cell call total from this campaign. Do not lower a forecast from an aborted or shortened cell. If the updated completion projection exceeds 35,000, stop before starting the next cell and report actual, remaining, projected and cap values. Independently stop model dispatch before the next call could exceed the hard 35,000-call total. Do not change per-cell caps, narrow the matrix or conceal an incomplete result to fit.

Require at least **100,000,000,000 free bytes**, available to the current user on the run/evidence filesystem. Check before launch, each cell, model dispatch and grader invocation. If free disk falls below that floor, stop further dispatch and hand back with the observed space and preserved prefix. Do not clean another project's output, kill another seat or overwrite prior evidence.

Carry the unchanged run-wide hidden-attempt and unknown-usage rules, two-consecutive-infrastructure-failure stop, cumulative six-hour pause allowance, 80% pool threshold, freshness bounds, outage pause/resume and existing metered non-refusal transport retries. Retain prior attempt chronology and overhead when applying shared safety checks; do not reset failure/pause history at task, method or seed boundaries. No third infrastructure replacement is authorized.

## Analysis, evidence and gates

Use predeclaration 10's paired selection metric, complete-vector validation, first baseline vector, chosen-vector rule, 10,000-replicate MT19937 bootstrap with seed 20261109, `random.choices` draws, type-7 95% intervals, equal-seed/equal-task aggregation and 0.02 practical threshold. Missing contributing cells make an aggregate unavailable, never zero or reweighted. No final-test rows or labels are loaded.

Aggregate seeds 1 and 2 measured under predeclaration 11 by method. Show all predeclaration-9 seed 0 and predeclaration-10 attempts beside them with their original labels, never pooled into the new primary aggregate for any method. Preserve the old task-720 zero and original failed replay as historical evidence; do not repair an old search by changing its feedback retrospectively.

Report every cell and seed, then each method: baseline/chosen scores and paired intervals, retention, phase calls/tokens/usage, active/poll/wall time, pauses/refusals/hidden attempts/missing usage, grader outcome counts and unscored infrastructure receipts, incomplete tails and abort reasons. Include duplicate selection measurements and gate-passers without a complete selection vector. Hone/plain duplicate selection evaluations must remain zero. Disclose official GEPA's observed behavior without changing its cache policy.

Commit this declaration first. Require failing-before/passing-after regressions, real offline protected-worker smoke and admission, green CI and exact-head cross-family READY on PR #38 before the first search call. Report the declaration, implementation/launch-gate and run/report phase ends. Require final evidence gates again. Preserve replayable bundles and explicit source-transition identity; no source-equivalence bypass or compatibility score-zero shim is authorized.

If a declared stop fires or the lane deadline arrives while the unit is live, preserve the durable state and hand back its unit, PID, completed cells and expected finish. Do not restart it. **Final-test evaluation, seeds beyond 2 and merge are out of scope.**
