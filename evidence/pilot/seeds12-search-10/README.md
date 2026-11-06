# Development pilot seeds 1 and 2: stopped after two infrastructure failures

The goal was to give gate-passing Hone/plain candidates selection budget instead of re-scoring known artifacts, then run twelve development cells under [predeclaration 10](../predeclaration-10.md). The declared stop fired after seed-1 MBPP/plain and HoVer/Hone both failed during startup with retained error type `TransportError` and zero recorded calls. Two MBPP cells completed, two cells infrastructure-aborted, and eight cells were never started. No cell was rerun and no merge occurred.

The planned seeds-1–2 method aggregates are **unavailable**, not zero. No seed has both tasks for any method. No missing seed or task is dropped, renormalized or pooled with historical seed 0. The two completed cell intervals both include zero. These are adaptive development-selection results, not deployment estimates or superiority claims.

Observed usage across the attempted prefix was **6,138 model calls, 3,471,500 reported tokens and $15.744984-equivalent**. Estimated tokens/charges, reported refusals, hidden attempts, missing-usage calls and throttle pauses are zero. Dollar-equivalent is the matched accounting measure, not a subscription invoice. Startup-failed timing/accounting prefixes remain explicitly incomplete; zero recorded calls is not a fabricated zero task score.

## Launch and stop evidence

The unit was `hone-seeds12-10-20261106T021648.service`, historical MainPID `3385415`, launched on exact approved head `32a6f2adc757cbd5b2000e9cac7535cfd7245012`. [Launch gate](launch-gate.json) records [green CI](https://github.com/twaldin/hone/actions/runs/42147754618) and [cross-family READY](https://github.com/twaldin/hone/pull/38#issuecomment-6675044735) before the first search call. Predeclaration 10 was committed in `c2a03cc` before launch; the explicit resumption and tested guards were committed in `d60d2c2`. Official GEPA and its adapter were untouched.

[The launch controller](controller.json) records CPU affinity [6], actual nice 10, `Restart=no`, zero restarts, explicit `NLTK_DATA` and one-thread settings. The initial systemd/wrapper nice settings were additive and produced nice 19. The owned main PID was paused, corrected to nice 10 and resumed before any cell directory existed, with zero model calls and no unit restart. Every search cell therefore began after the correction. Future launch commands should use only one nice setter.

[The terminal controller](terminal-controller.json) records a successful dispatcher exit under the stop rule after 24,549.478 seconds, not a successful twelve-cell matrix. The transient unit is released, inactive and dead, with MainPID 0. The owned raw unit journal is retained privately at the path and hash in that controller. [stop.json](stop.json) preserves the two-cell infrastructure streak. The original private run root remains untouched. [harness-bundle.json](harness-bundle.json) preserves the original producer inventory; the outer bundle adds this report and terminal metadata. Leaf bundles are unchanged.

The installed CLI reported `omp/18.17.0` after the stop. The frozen gateway requires `omp/18.16.0` before `ModelCalls` can start. **[INFERENCE]** Version drift is consistent with the startup errors, but exact per-failure attribution is not proven. Failure receipts retain only the error type and gateway stderr is discarded. [The version observation](../selection-reuse-10/runtime-stop.json) records this limit. No provider probe, version downgrade, broker/configuration change or retry followed the stop. Completed cells have identical engine, route, pool, budget, declaration and transition identities.

## Per-cell selection and reuse diagnostics

Scores are percentages; deltas and intervals are absolute percentage points. Each complete cell compares its retained artifact with its own initial seed vector on 90 unique MBPP selection instances. N/A means no complete comparison or no applicable training gate, never a zero-filled score. Re-score counts are exact only for the two completed cells. Failed/unstarted rows have no selection evidence, so the reporter leaves their exact counts unavailable rather than inventing zeros.

| Seed | Task | Method | Status | Seed % | Chosen % | Delta [95% interval], pp | Changed? | Selection re-scores | Gate-passers without complete selection |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | completed | 77.78 | 77.78 | 0.00 [0.00, 0.00] | no | 0 | 1 |
| 1 | MBPP | Official GEPA | completed | 75.56 | 80.00 | 4.44 [0.00, 10.00] | yes | 0 | N/A |
| 1 | MBPP | Plain | infrastructure_failure | N/A | N/A | N/A | N/A | N/A | N/A |
| 1 | HoVer | Hone | infrastructure_failure | N/A | N/A | N/A | N/A | N/A | N/A |
| 1 | HoVer | Official GEPA | unstarted | N/A | N/A | N/A | N/A | N/A | N/A |
| 1 | HoVer | Plain | unstarted | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Hone | unstarted | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Official GEPA | unstarted | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Plain | unstarted | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Hone | unstarted | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Official GEPA | unstarted | N/A | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Plain | unstarted | N/A | N/A | N/A | N/A | N/A | N/A |

Hone/MBPP had zero repeated known-artifact selection evaluations. Its last gate-passing candidate `b67960d4`, trajectory entry 99, began a fresh selection evaluation but hit the active-time cap after eight calls, lines 3427–3434. It never obtained a complete vector. This tail was not a parent re-score. The eight calls, 2,432 tokens and $0.015840 remain charged as unassigned. Plain's live reuse path was not exercised because startup failed; its behavior is covered by the failing-before/passing-after regressions.

Both complete-cell 95% intervals include zero. GEPA/MBPP's point estimate meets the 2-point practical threshold, but its interval does not lie above that threshold. Hone retained the unchanged seed, so its artifact-change delta and interval are exactly zero. That is not zero uncertainty about absolute seed accuracy.

## Per-cell usage and phase spend

| Seed | Task | Method | Calls | Reported tokens | Estimated tokens | Reported $-equiv | Estimated $-equiv |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | 3,434 | 1,006,779 | 0 | 5.928681 | 0.000000 |
| 1 | MBPP | Official GEPA | 2,704 | 2,464,721 | 0 | 9.816303 | 0.000000 |
| 1 | MBPP | Plain | 0 | 0 | 0 | 0.000000 | 0.000000 |
| 1 | HoVer | Hone | 0 | 0 | 0 | 0.000000 | 0.000000 |
| 1 | HoVer | Official GEPA | N/A | N/A | N/A | N/A | N/A |
| 1 | HoVer | Plain | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Hone | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Official GEPA | N/A | N/A | N/A | N/A | N/A |
| 2 | MBPP | Plain | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Hone | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Official GEPA | N/A | N/A | N/A | N/A | N/A |
| 2 | HoVer | Plain | N/A | N/A | N/A | N/A | N/A |

Each phase entry is model calls / reported tokens / dollar-equivalent. All recorded estimated phase charges are zero. Unassigned tails are metered usage, not unknown failed-call usage.

| Seed | Task | Method | Proposal | Training evaluation | Selection evaluation | Unassigned tail |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | 132 / 445,351 / $1.726881 | 2,664 / 433,659 / $3.324021 | 630 / 125,337 / $0.861939 | 8 / 2,432 / $0.015840 |
| 1 | MBPP | Official GEPA | 86 / 786,638 / $2.900310 | 1,088 / 631,293 / $2.649939 | 1,530 / 1,046,790 / $4.266054 | 0 / 0 / $0.000000 |
| 1 | MBPP | Plain | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 |
| 1 | HoVer | Hone | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 |
| 1 | HoVer | Official GEPA | N/A | N/A | N/A | N/A |
| 1 | HoVer | Plain | N/A | N/A | N/A | N/A |
| 2 | MBPP | Hone | N/A | N/A | N/A | N/A |
| 2 | MBPP | Official GEPA | N/A | N/A | N/A | N/A |
| 2 | MBPP | Plain | N/A | N/A | N/A | N/A |
| 2 | HoVer | Hone | N/A | N/A | N/A | N/A |
| 2 | HoVer | Official GEPA | N/A | N/A | N/A | N/A |
| 2 | HoVer | Plain | N/A | N/A | N/A | N/A |

## Per-cell runtime and safety

The active cap remains 7,200 seconds. Hone's terminal overrun is reported, not rounded into the cap. Ledger timing excludes setup outside the ledger. Failed startup prefixes retain known polling time but have unavailable active and wall time. The unit's additional elapsed setup and failure time is not assigned arbitrarily to a method.

| Seed | Task | Method | Ledger wall s | Active s | Polling s | Pause s / episodes | Refusals / hidden / missing usage | Binding cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | MBPP | Hone | 12,463.716 | 7,202.193 | 5,261.523 | 0.000 / 0 | 0 / 0 / 0 | active_seconds |
| 1 | MBPP | Official GEPA | 10,410.028 | 5,607.472 | 4,802.556 | 0.000 / 0 | 0 / 0 / 0 | usd_reservation |
| 1 | MBPP | Plain | N/A | N/A | 2.061 | 0.000 / 0 | 0 / 0 / 0 | TransportError |
| 1 | HoVer | Hone | N/A | N/A | 3.034 | 0.000 / 0 | 0 / 0 / 0 | TransportError |
| 1 | HoVer | Official GEPA | N/A | N/A | N/A | N/A / N/A | N/A / N/A / N/A | N/A |
| 1 | HoVer | Plain | N/A | N/A | N/A | N/A / N/A | N/A / N/A / N/A | N/A |
| 2 | MBPP | Hone | N/A | N/A | N/A | N/A / N/A | N/A / N/A / N/A | N/A |
| 2 | MBPP | Official GEPA | N/A | N/A | N/A | N/A / N/A | N/A / N/A / N/A | N/A |
| 2 | MBPP | Plain | N/A | N/A | N/A | N/A / N/A | N/A / N/A / N/A | N/A |
| 2 | HoVer | Hone | N/A | N/A | N/A | N/A / N/A | N/A / N/A / N/A | N/A |
| 2 | HoVer | Official GEPA | N/A | N/A | N/A | N/A / N/A | N/A / N/A / N/A | N/A |
| 2 | HoVer | Plain | N/A | N/A | N/A | N/A / N/A | N/A / N/A / N/A | N/A |

## Per-seed and primary method results

| Seed | Method | Complete / planned cells | Recorded calls | Observed $-equiv | Equal-task delta [95% interval], pp |
| --- | --- | --- | --- | --- | --- |
| 1 | Hone | 1 / 2 | 3,434 | 5.928681 | N/A |
| 1 | Official GEPA | 1 / 2 | 2,704 | 9.816303 | N/A |
| 1 | Plain | 0 / 2 | 0 | 0.000000 | N/A |
| 2 | Hone | 0 / 2 | N/A | N/A | N/A |
| 2 | Official GEPA | 0 / 2 | N/A | N/A | N/A |
| 2 | Plain | 0 / 2 | N/A | N/A | N/A |

The primary seeds-1–2 aggregate requires both seeds and both tasks with equal weights. Observed usage below is a prefix subtotal, not a completed four-cell method total. Historical seed 0 is beside it and never pooled.

| Method | Complete / planned cells | Seeds1–2 delta [95% interval], pp | Observed calls | Observed $-equiv | Historical seed0 delta [95% interval], pp |
| --- | --- | --- | --- | --- | --- |
| Hone | 1 / 4 | N/A | 3,434 | 5.928681 | 2.22 [0.00, 7.22] |
| Official GEPA | 1 / 4 | N/A | 2,704 | 9.816303 | 8.61 [-1.11, 17.67] |
| Plain | 0 / 4 | N/A | 0 | 0.000000 | 2.22 [0.00, 6.67] |

| Method | Observed proposal | Observed training | Observed selection | Observed unassigned | Known wall s | Known active s | Known polling s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hone | 132 / 445,351 / $1.726881 | 2,664 / 433,659 / $3.324021 | 630 / 125,337 / $0.861939 | 8 / 2,432 / $0.015840 | 12,463.716 | 7,202.193 | 5,264.557 |
| Official GEPA | 86 / 786,638 / $2.900310 | 1,088 / 631,293 / $2.649939 | 1,530 / 1,046,790 / $4.266054 | 0 / 0 / $0.000000 | 10,410.028 | 5,607.472 | 4,802.556 |
| Plain | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 | 0 / 0 / $0.000000 | N/A | N/A | 2.061 |

## Historical predeclaration-9 seed 0 beside the stopped run

These are the unchanged pre-fix Hone/plain results and unchanged external GEPA baseline, not additional predeclaration-10 replicates. Repeated adaptive evaluations are never pooled as independent rows.

| Seed | Task | Method | Status | Seed % | Chosen % | Delta [95% interval], pp | Changed? | Selection re-scores | Gate-passers without complete selection |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | MBPP | Hone | completed | 75.56 | 80.00 | 4.44 [0.00, 10.00] | yes | 5 | 0 |
| 0 | MBPP | Official GEPA | completed | 77.78 | 80.00 | 2.22 [-4.44, 8.89] | yes | 0 | N/A |
| 0 | MBPP | Plain | completed | 76.67 | 81.11 | 4.44 [1.11, 8.89] | yes | 4 | N/A |
| 0 | HoVer | Hone | completed | 30.00 | 30.00 | 0.00 [0.00, 0.00] | no | 1 | 1 |
| 0 | HoVer | Official GEPA | completed | 30.33 | 45.33 | 15.00 [9.67, 20.67] | yes | 0 | N/A |
| 0 | HoVer | Plain | completed | 31.33 | 31.33 | 0.00 [0.00, 0.00] | no | 0 | N/A |

Plain/MBPP's historical positive interval depends on re-scoring the identical chosen artifact. Its first measurement gave +2.22 points [-3.33, 7.78]; the later retained vector gives +4.44 [1.11, 8.89]. The first interval includes zero. Historical method intervals for all three methods include zero.

| Seed | Task | Method | Calls | Reported tokens | Estimated tokens | Reported $-equiv | Estimated $-equiv |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | MBPP | Hone | 4,033 | 1,212,737 | 0 | 7.073547 | 0.000000 |
| 0 | MBPP | Official GEPA | 3,172 | 2,362,115 | 0 | 9.852441 | 0.000000 |
| 0 | MBPP | Plain | 4,050 | 929,268 | 0 | 6.160872 | 0.000000 |
| 0 | HoVer | Hone | 2,708 | 2,318,214 | 0 | 9.897690 | 0.000000 |
| 0 | HoVer | Official GEPA | 2,540 | 2,012,059 | 0 | 8.621001 | 0.000000 |
| 0 | HoVer | Plain | 1,747 | 2,340,994 | 0 | 8.927514 | 0.000000 |

| Seed | Task | Method | Proposal | Training evaluation | Selection evaluation | Unassigned tail |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | MBPP | Hone | 139 / 458,634 / $1.851858 | 2,904 / 550,699 / $3.831777 | 990 / 203,404 / $1.389912 | 0 / 0 / $0.000000 |
| 0 | MBPP | Official GEPA | 100 / 831,231 / $3.014337 | 1,272 / 616,318 / $2.760774 | 1,800 / 914,566 / $4.077330 | 0 / 0 / $0.000000 |
| 0 | MBPP | Plain | 51 / 210,453 / $0.785847 | 408 / 62,286 / $0.491082 | 3,510 / 640,878 / $4.772718 | 81 / 15,651 / $0.111225 |
| 0 | HoVer | Hone | 12 / 454,537 / $1.445955 | 384 / 280,164 / $1.259268 | 1,193 / 818,367 / $3.718197 | 1,119 / 765,146 / $3.474270 |
| 0 | HoVer | Official GEPA | 2 / 198,095 / $0.601593 | 160 / 115,487 / $0.524169 | 2,378 / 1,698,477 / $7.495239 | 0 / 0 / $0.000000 |
| 0 | HoVer | Plain | 16 / 1,169,448 / $3.625452 | 541 / 362,627 / $1.630461 | 1,190 / 808,919 / $3.671601 | 0 / 0 / $0.000000 |

| Seed | Task | Method | Ledger wall s | Active s | Polling s | Pause s / episodes | Refusals / hidden / missing usage | Binding cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | MBPP | Hone | 13,512.727 | 7,201.677 | 6,311.050 | 0.000 / 0 | 0 / 0 / 0 | active_seconds |
| 0 | MBPP | Official GEPA | 11,275.320 | 6,097.018 | 4,956.361 | 221.940 / 1 | 0 / 0 / 0 | usd_reservation |
| 0 | MBPP | Plain | 14,058.275 | 7,200.918 | 6,857.357 | 0.000 / 0 | 0 / 0 / 0 | active_seconds |
| 0 | HoVer | Hone | 10,454.749 | 5,998.424 | 4,456.326 | 0.000 / 0 | 0 / 0 / 0 | usd_reservation |
| 0 | HoVer | Official GEPA | 10,386.586 | 5,203.312 | 5,183.274 | 0.000 / 0 | 0 / 0 / 0 | usd_reservation |
| 0 | HoVer | Plain | 6,997.751 | 3,759.681 | 3,238.071 | 0.000 / 0 | 0 / 0 / 0 | usd_reservation |

| Method | Seed mean % | Chosen mean % | Equal-task delta [95% interval], pp | Calls | Reported tokens | Reported $-equiv |
| --- | --- | --- | --- | --- | --- | --- |
| Hone | 52.78 | 55.00 | 2.22 [0.00, 7.22] | 6,741 | 3,530,951 | 16.971237 |
| Official GEPA | 54.06 | 62.67 | 8.61 [-1.11, 17.67] | 5,712 | 4,374,174 | 18.473442 |
| Plain | 54.00 | 56.22 | 2.22 [0.00, 6.67] | 5,797 | 3,270,262 | 15.088386 |

## Replay without model calls

The [machine report](../results-10-seeds12.json) contains every cell, diagnostic evidence, input hash, per-seed summary, primary unavailable aggregate and separately labeled historical report. It uses 10,000 paired/hierarchical resamples, MT19937 seed `20261109` and type-7 percentile endpoints under predeclaration 10.

```sh
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot verify --out evidence/pilot/seeds12-search-10
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot.results --runs-seed1 evidence/pilot/seeds12-search-10 --runs-seed2 evidence/pilot/seeds12-search-10 --runs evidence/pilot/seed0-search-9 --out .pilot-state/results-10-replay.json
cmp evidence/pilot/results-10-seeds12.json .pilot-state/results-10-replay.json
```

[Prelaunch proof](../selection-reuse-10/README.md) includes the full raw seed-0 replay of 12,764 retained scores, fresh real admission, all eight admitted index hashes, guard regressions and exact approved source. No final-test evaluation, seed beyond 2, automatic cell restart, public optimizer-quality claim or merge is authorized. Another measured attempt requires a new explicit ruling; this stopped root is not selectively resumed.
