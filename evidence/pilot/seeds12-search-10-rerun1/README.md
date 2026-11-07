# Infrastructure rerun 1 stopped on a durable-journal write failure

Predeclaration 10, addendum 1. Five of twelve matrix cells completed, including the two retained MBPP cells. HoVer/seed 1/plain infrastructure-aborted. All six seed-2 cells were unstarted. No final-test evaluation, seed beyond 2, automatic restart or merge occurred.

**Validation blocker:** the completed-cell protected-metric replay failed after hash verification with `Replay metric disagrees with a retained evaluation`. The attempted scope was 10,236 retained scores; the count checked before failure and the first mismatch location are unknown. No retry or grader change followed. Quality figures below are as recorded, not independently reproduced by this check. Table status `completed` means the producer search terminated normally, not that metric replay passed. See [metric-replay.json](metric-replay.json).

Unit `hone-seeds12-10-rerun1-20261106T111249.service`, historical MainPID `2373777`, exited with status 1 at `2026-11-06T22:37:29.921310+00:00`. MainPID is now 0 and the cgroup is absent. The journal proves `ENOSPC` during the call-ledger flush and fallback manifest writing. Unit-journal wall time was 41,080.409 seconds, CPU time 11,718.853 seconds, memory peak 4.3G and swap peak 0B. Later inspection found 527G available. The historical exhausting writer is not attributed. Raw logs remain private. [terminal-controller.json](terminal-controller.json) retains their hash and the exit evidence. Collected-unit default `Result=success` is not the process exit result.

The [committed addendum](../predeclaration-10-addendum-1.md), [exact-head green CI](https://github.com/twaldin/hone/actions/runs/42207823091) and [cross-family READY](https://github.com/twaldin/hone/pull/38#issuecomment-6683483922) preceded new search calls on `99ce88b7023391c4d92d5c8882cee35eb576460f`. The local 18.16.0 SDK, route and OAuth-only pool passed zero-call admission. The first real call also succeeded. CPU 6, main nice 10, one-thread settings, explicit `NLTK_DATA` and `Restart=no` were observed. Official GEPA, engine files, broker, global omp, configuration and updater schedule remain unchanged.

## Accounting boundary and preserved evidence

The intact journals record **16,592 calls, 12,035,285 reported tokens and $52.612575-equivalent**. Actual usage is incompletely accounted. The crashed cell has 2,016 complete call records and a 160-byte incomplete tail. At least one provider response reached settlement without complete durable accounting, so actual model invocations are at least 16,593. Its last outcome and usage are unknown. It might include a refusal and is not retried. No invented token or dollar estimate fills the gap. Recorded refusal and missing-usage counters of 0 do not establish 0 for the lost response. The one recorded hidden attempt is not an upper bound on unpersisted activity.

The crashed cell records 2,368,447 tokens and $9.407745-equivalent before the lost response. Its final wall, active and polling summary is unavailable. Do not restart its search, reset its budget, infer a zero score or treat its retained incumbent as a completed paired result. An explicit ruling is needed before infrastructure rerun 2 or any partial-cell budget treatment.

The [resumption boundary](resumption-needed.json) requires a narrow offline diagnosis of that mismatch before any further measured search. Keep the damaged cell censored and do not reset its budget. Any later proposal to run the six unstarted seed-2 cells also needs a new ruling and addendum. This record grants no new search.

- `raw/` preserves all 254 producer files byte-for-byte, including the zero-byte manifest and 160-byte journal tail. The added forensic inventory is not a producer completion claim. [source-inventory.json](source-inventory.json) records every source-file hash.
- `report-inputs/` is an explicit analysis projection. Its five completed leaves are byte-identical. Only the empty partial-cell manifest is omitted from this view; it remains in `raw/`. The existing `resume_result` helper materializes a derived failure summary, and unchanged spend reporting excludes the unframed tail. No manifest, search trajectory, score vector or provider output is reconstructed. [projection.json](report-inputs/projection.json) records the boundary and lower bounds.
- The original two updater-caused startup aborts remain in chronological `raw/attempts.json`. Their known polling overhead is 5.095183 seconds and recorded model usage is 0. The new abort is the first failure after three completed rerun cells, not a third-failure or rate-stop event.

## Primary matrix, seeds 1 and 2

N/A is unavailable, never zero-filled or reweighted. Partial-cell figures are recorded-prefix observations only.

| Seed | Task | Method | Status | Baseline | Chosen | Delta and 95% CI, pp | Changed artifact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | completed | 77.78% | 77.78% | +0.00 [0.00, 0.00] | False |
| 1 | MBPP | Official GEPA | completed | 75.56% | 80.00% | +4.44 [0.00, 10.00] | True |
| 1 | MBPP | Plain | completed | 77.78% | 82.22% | +4.44 [-1.11, 11.11] | True |
| 1 | HoVer | Hone | completed | 30.00% | 30.00% | +0.00 [0.00, 0.00] | False |
| 1 | HoVer | Official GEPA | completed | 30.33% | 30.33% | +0.00 [0.00, 0.00] | False |
| 1 | HoVer | Plain | infrastructure_failure | N/A | N/A | N/A | N/A |
| 2 | MBPP | Hone | missing | N/A | N/A | N/A | N/A |
| 2 | MBPP | Official GEPA | missing | N/A | N/A | N/A | N/A |
| 2 | MBPP | Plain | missing | N/A | N/A | N/A | N/A |
| 2 | HoVer | Hone | missing | N/A | N/A | N/A | N/A |
| 2 | HoVer | Official GEPA | missing | N/A | N/A | N/A | N/A |
| 2 | HoVer | Plain | missing | N/A | N/A | N/A | N/A |

## Per-seed methods and primary aggregation

Intervals use the frozen paired comparisons, equal-seed and equal-task weighting, 10,000 MT19937 replicates with seed `20261109`, and type-7 endpoints. Every primary seeds-1–2 aggregate is unavailable because seed 2 is missing. Seed-1 Plain also lacks a complete two-task comparison. Neither available seed-1 method interval excludes 0. Seed 0 is displayed beside, not pooled.

| Method | Seed1 delta/CI pp | Seed2 delta/CI pp | Primary seeds1–2 delta/CI pp | Observed calls | Observed reported tokens | Observed $equivalent | Historical seed0 delta/CI pp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hone | +0.00 [0.00, 0.00] | N/A | N/A | 5,887 | 3,255,747 | 15.818373 | +2.22 [0.00, 7.22] |
| Official GEPA | +2.22 [0.00, 7.22] | N/A | N/A | 5,373 | 4,839,070 | 19.713222 | +8.61 [-1.11, 17.67] |
| Plain | N/A | N/A | N/A | 5,332 | 3,940,468 | 17.080980 | +2.22 [0.00, 6.67] |

Observed subtotals are not complete primary budget totals. Plain includes the damaged cell's intact prefix and therefore remains a lower bound. Dollar-equivalent usage is not an invoice or a subscription spending cap.

## Selection reuse and censored gate-passers

| Seed | Task | Method | Exact repeated selection evaluations | Observed repeats | Duplicate status | Gate-passers without full selection | Gate status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | 0 | 0 | exact_archived_count | 1 | archived_trajectory |
| 1 | MBPP | Official GEPA | 0 | 0 | exact_archived_count | N/A | not_applicable |
| 1 | MBPP | Plain | 0 | 0 | exact_archived_count | N/A | not_applicable |
| 1 | HoVer | Hone | 0 | 0 | exact_archived_count | 1 | archived_trajectory |
| 1 | HoVer | Official GEPA | 0 | 0 | exact_archived_count | N/A | not_applicable |
| 1 | HoVer | Plain | N/A | 0 | observed_lower_bound | N/A | not_applicable |
| 2 | MBPP | Hone | N/A | N/A | observed_lower_bound | N/A | missing_evidence |
| 2 | MBPP | Official GEPA | N/A | N/A | observed_lower_bound | N/A | not_applicable |
| 2 | MBPP | Plain | N/A | N/A | observed_lower_bound | N/A | not_applicable |
| 2 | HoVer | Hone | N/A | N/A | observed_lower_bound | N/A | missing_evidence |
| 2 | HoVer | Official GEPA | N/A | N/A | observed_lower_bound | N/A | not_applicable |
| 2 | HoVer | Plain | N/A | N/A | observed_lower_bound | N/A | not_applicable |

All five completed cells have exact repeated-selection count 0. The partial Plain cell has observed repeats 0 but an unknown exact count because metadata and its final receipt are incomplete. Unstarted cells are unknown, not 0. GEPA is measured as archived, not described as caching. Plain and GEPA do not use Hone's paired training gate.

- MBPP/seed 1/Hone: one gate-passer, `b67960d4…`, began fresh selection at calls 3427–3434, then hit the active-time cap. It never got a complete vector.
- HoVer/seed 1/Hone: one gate-passer, `b90f1d2e…`, began fresh selection at calls 1681–2453, totaling 773 calls, then hit the dollar-reservation cap. The retained seed stayed at 30.00%. The budget tail scored the new artifact, not a known parent.
- These differ from seed 0's incumbent-remeasurement censoring. The fix removes re-scoring. It does not add budget or guarantee that a late candidate finishes a full vector.

## Usage and error counters, recorded prefix only

| Seed | Task | Method | Recorded calls | Reported tokens | Estimated tokens | $equivalent recorded | Recorded refusals | Recorded hidden | Recorded missing usage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | 3,434 | 1,006,779 | 0 | 5.928681 | 0 | 0 | 0 |
| 1 | MBPP | Official GEPA | 2,704 | 2,464,721 | 0 | 9.816303 | 0 | 0 | 0 |
| 1 | MBPP | Plain | 3,316 | 1,572,021 | 0 | 7.673235 | 0 | 1 | 0 |
| 1 | HoVer | Hone | 2,453 | 2,248,968 | 0 | 9.889692 | 0 | 0 | 0 |
| 1 | HoVer | Official GEPA | 2,669 | 2,374,349 | 0 | 9.896919 | 0 | 0 | 0 |
| 1 | HoVer | Plain | 2,016 | 2,368,447 | 0 | 9.407745 | 0 | 0 | 0 |
| 2 | MBPP | Hone | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Official GEPA | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Plain | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Hone | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Official GEPA | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Plain | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

Only MBPP/seed 1/plain has a recorded hidden attempt: 1/3316 = 0.0302%, below 1%. Its internal failed-attempt usage remains unknown. Recorded pauses are 0. The crashed cell's exact final pause accounting is unavailable. No reported threshold stop fired before the unhandled write failure.

## Per-cell phase spend

Incomplete evaluation tails remain unassigned and counted. All numbers for the aborted cell are durable-prefix subtotals; the lost response is not allocated to a phase.

| Seed | Task | Method | Phase | Calls | Reported tokens | $equivalent |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | proposal | 132 | 445,351 | 1.726881 |
| 1 | MBPP | Hone | training_evaluation | 2,664 | 433,659 | 3.324021 |
| 1 | MBPP | Hone | selection_evaluation | 630 | 125,337 | 0.861939 |
| 1 | MBPP | Hone | unassigned | 8 | 2,432 | 0.015840 |
| 1 | MBPP | Official GEPA | proposal | 86 | 786,638 | 2.900310 |
| 1 | MBPP | Official GEPA | training_evaluation | 1,088 | 631,293 | 2.649939 |
| 1 | MBPP | Official GEPA | selection_evaluation | 1,530 | 1,046,790 | 4.266054 |
| 1 | MBPP | Official GEPA | unassigned | 0 | 0 | 0.000000 |
| 1 | MBPP | Plain | proposal | 104 | 578,648 | 2.265312 |
| 1 | MBPP | Plain | training_evaluation | 832 | 245,800 | 1.356204 |
| 1 | MBPP | Plain | selection_evaluation | 2,340 | 730,423 | 3.965937 |
| 1 | MBPP | Plain | unassigned | 40 | 17,150 | 0.085782 |
| 1 | HoVer | Hone | proposal | 9 | 376,046 | 1.183914 |
| 1 | HoVer | Hone | training_evaluation | 477 | 347,029 | 1.574331 |
| 1 | HoVer | Hone | selection_evaluation | 1,194 | 817,828 | 3.709332 |
| 1 | HoVer | Hone | unassigned | 773 | 708,065 | 3.422115 |
| 1 | HoVer | Official GEPA | proposal | 5 | 457,831 | 1.392861 |
| 1 | HoVer | Official GEPA | training_evaluation | 314 | 222,157 | 0.992487 |
| 1 | HoVer | Official GEPA | selection_evaluation | 1,195 | 816,719 | 3.694989 |
| 1 | HoVer | Official GEPA | unassigned | 1,155 | 877,642 | 3.816582 |
| 1 | HoVer | Plain | proposal | 13 | 946,828 | 2.932980 |
| 1 | HoVer | Plain | training_evaluation | 413 | 278,480 | 1.241496 |
| 1 | HoVer | Plain | selection_evaluation | 1,198 | 820,085 | 3.718671 |
| 1 | HoVer | Plain | unassigned | 392 | 323,054 | 1.514598 |

## Per-cell timing and binding caps

The crashed cell's known pause prefix of 0 is not an exact terminal total. Original startup-abort polling overhead is reported separately above.

| Seed | Task | Method | Ledger wall s | Active s | Polling s | Known pause s | Known episodes | Binding cap or stop |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | 12,463.716 | 7,202.193 | 5,261.523 | 0.000 | 0 | active_seconds |
| 1 | MBPP | Official GEPA | 10,410.028 | 5,607.472 | 4,802.556 | 0.000 | 0 | usd_reservation |
| 1 | MBPP | Plain | 12,778.711 | 7,201.163 | 5,577.548 | 0.000 | 0 | active_seconds |
| 1 | HoVer | Hone | 10,057.463 | 5,899.832 | 4,157.630 | 0.000 | 0 | usd_reservation |
| 1 | HoVer | Official GEPA | 9,619.837 | 5,388.699 | 4,231.138 | 0.000 | 0 | usd_reservation |
| 1 | HoVer | Plain | N/A | N/A | N/A | 0.000 | 0 | OSError_ENOSPC |
| 2 | MBPP | Hone | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Official GEPA | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Plain | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Hone | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Official GEPA | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Plain | N/A | N/A | N/A | N/A | N/A | N/A |

## Historical seed 0 beside the new run

Predeclaration 9, pre-fix Hone/plain and unchanged official GEPA. The original evidence and analysis stay unchanged and are never pooled into the new primary estimates. Plain/MBPP's positive interval used a repeated measurement of the identical chosen artifact. Its earlier measurement included 0. See the [original report](../seed0-search-9/README.md) for that caveat and all differing same-artifact vectors.

| Seed | Task | Method | Status | Baseline | Chosen | Delta and 95% CI, pp | Changed artifact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | MBPP | Hone | completed | 75.56% | 80.00% | +4.44 [0.00, 10.00] | True |
| 0 | MBPP | Official GEPA | completed | 77.78% | 80.00% | +2.22 [-4.44, 8.89] | True |
| 0 | MBPP | Plain | completed | 76.67% | 81.11% | +4.44 [1.11, 8.89] | True |
| 0 | HoVer | Hone | completed | 30.00% | 30.00% | +0.00 [0.00, 0.00] | False |
| 0 | HoVer | Official GEPA | completed | 30.33% | 45.33% | +15.00 [9.67, 20.67] | True |
| 0 | HoVer | Plain | completed | 31.33% | 31.33% | +0.00 [0.00, 0.00] | False |

### Historical usage and errors

| Seed | Task | Method | Recorded calls | Reported tokens | Estimated tokens | $equivalent recorded | Recorded refusals | Recorded hidden | Recorded missing usage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | MBPP | Hone | 4,033 | 1,212,737 | 0 | 7.073547 | 0 | 0 | 0 |
| 0 | MBPP | Official GEPA | 3,172 | 2,362,115 | 0 | 9.852441 | 0 | 0 | 0 |
| 0 | MBPP | Plain | 4,050 | 929,268 | 0 | 6.160872 | 0 | 0 | 0 |
| 0 | HoVer | Hone | 2,708 | 2,318,214 | 0 | 9.897690 | 0 | 0 | 0 |
| 0 | HoVer | Official GEPA | 2,540 | 2,012,059 | 0 | 8.621001 | 0 | 0 | 0 |
| 0 | HoVer | Plain | 1,747 | 2,340,994 | 0 | 8.927514 | 0 | 0 | 0 |

### Historical phase spend

| Seed | Task | Method | Phase | Calls | Reported tokens | $equivalent |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | MBPP | Hone | proposal | 139 | 458,634 | 1.851858 |
| 0 | MBPP | Hone | training_evaluation | 2,904 | 550,699 | 3.831777 |
| 0 | MBPP | Hone | selection_evaluation | 990 | 203,404 | 1.389912 |
| 0 | MBPP | Hone | unassigned | 0 | 0 | 0.000000 |
| 0 | MBPP | Official GEPA | proposal | 100 | 831,231 | 3.014337 |
| 0 | MBPP | Official GEPA | training_evaluation | 1,272 | 616,318 | 2.760774 |
| 0 | MBPP | Official GEPA | selection_evaluation | 1,800 | 914,566 | 4.077330 |
| 0 | MBPP | Official GEPA | unassigned | 0 | 0 | 0.000000 |
| 0 | MBPP | Plain | proposal | 51 | 210,453 | 0.785847 |
| 0 | MBPP | Plain | training_evaluation | 408 | 62,286 | 0.491082 |
| 0 | MBPP | Plain | selection_evaluation | 3,510 | 640,878 | 4.772718 |
| 0 | MBPP | Plain | unassigned | 81 | 15,651 | 0.111225 |
| 0 | HoVer | Hone | proposal | 12 | 454,537 | 1.445955 |
| 0 | HoVer | Hone | training_evaluation | 384 | 280,164 | 1.259268 |
| 0 | HoVer | Hone | selection_evaluation | 1,193 | 818,367 | 3.718197 |
| 0 | HoVer | Hone | unassigned | 1,119 | 765,146 | 3.474270 |
| 0 | HoVer | Official GEPA | proposal | 2 | 198,095 | 0.601593 |
| 0 | HoVer | Official GEPA | training_evaluation | 160 | 115,487 | 0.524169 |
| 0 | HoVer | Official GEPA | selection_evaluation | 2,378 | 1,698,477 | 7.495239 |
| 0 | HoVer | Official GEPA | unassigned | 0 | 0 | 0.000000 |
| 0 | HoVer | Plain | proposal | 16 | 1,169,448 | 3.625452 |
| 0 | HoVer | Plain | training_evaluation | 541 | 362,627 | 1.630461 |
| 0 | HoVer | Plain | selection_evaluation | 1,190 | 808,919 | 3.671601 |
| 0 | HoVer | Plain | unassigned | 0 | 0 | 0.000000 |

### Historical timing and caps

| Seed | Task | Method | Ledger wall s | Active s | Polling s | Known pause s | Known episodes | Binding cap or stop |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | MBPP | Hone | 13,512.727 | 7,201.677 | 6,311.050 | 0.000 | 0 | active_seconds |
| 0 | MBPP | Official GEPA | 11,275.320 | 6,097.018 | 4,956.361 | 221.940 | 1 | usd_reservation |
| 0 | MBPP | Plain | 14,058.275 | 7,200.918 | 6,857.357 | 0.000 | 0 | active_seconds |
| 0 | HoVer | Hone | 10,454.749 | 5,998.424 | 4,456.326 | 0.000 | 0 | usd_reservation |
| 0 | HoVer | Official GEPA | 10,386.586 | 5,203.312 | 5,183.274 | 0.000 | 0 | usd_reservation |
| 0 | HoVer | Plain | 6,997.751 | 3,759.681 | 3,238.071 | 0.000 | 0 | usd_reservation |

### Historical selection diagnostics

| Task | Method | Exact repeated selection evaluations | Gate-passers without complete selection |
| --- | --- | --- | --- |
| MBPP | Hone | 5 | 0 |
| MBPP | Official GEPA | 0 | N/A |
| MBPP | Plain | 4 | N/A |
| HoVer | Hone | 1 | 1 |
| HoVer | Official GEPA | 0 | N/A |
| HoVer | Plain | 0 | N/A |

## Offline replay, no model calls

Verify the preserved raw input and report projection:

```sh
pilot/.venv/bin/python -m pilot verify --out evidence/pilot/seeds12-search-10-rerun1/raw
pilot/.venv/bin/python -m pilot verify --out evidence/pilot/seeds12-search-10-rerun1/report-inputs
```

Rebuild the conservative projection in a fresh external directory, never over retained evidence:

```sh
PYTHONPATH=. pilot/.venv/bin/python evidence/pilot/seeds12-search-10-rerun1/build-view.py --out .pilot-state/rerun1-projection-replay
```

Replay the complete machine report, including its explicit accounting caveat and historical seed0:

```sh
PYTHONPATH=. pilot/.venv/bin/python evidence/pilot/seeds12-search-10-rerun1/replay-report.py --out .pilot-state/results-10-rerun1-replay.json
cmp evidence/pilot/results-10-rerun1.json .pilot-state/results-10-rerun1-replay.json
```

Build completed-only inputs for raw protected-metric replay. The damaged cell is excluded because no contemporaneous manifest or search state survived. No partial score is imputed.

```sh
PYTHONPATH=. pilot/.venv/bin/python evidence/pilot/seeds12-search-10-rerun1/build-view.py --completed-only --out .pilot-state/rerun1-completed-metrics-replay
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python -m pilot replay --out .pilot-state/rerun1-completed-metrics-replay
```

The report and bundle verification do not dispatch a model, load final-test labels, repair lost data or authorize another search. Full raw seed-0 replay earlier reproduced 12,764 retained scores. The new completed-cell metric replay instead failed after 2,624.60 seconds. Its attempted scope was 10,236 retained scores, excluding incomplete tails and the damaged cell. Do not describe that attempted count as successfully replayed. The command above records the failed check for diagnosis, not a passing verification.
