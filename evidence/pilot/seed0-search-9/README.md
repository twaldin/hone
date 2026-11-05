# Development pilot, seed 0: six completed searches

The first full seed is complete. The goal was to see whether any of Hone, official GEPA or the plain agent loop improves its unchanged starting artifact before committing to seeds 2–3. All six declared cells completed; no abort or handback condition fired. Final-test labels remain sealed, and PR #37 remains unmerged.

**No method's equal-weight two-task 95% hierarchical interval excludes zero.** Under the predeclared measurement rule, Plain/MBPP and GEPA/HoVer have positive task-level intervals. Plain/MBPP's positive bound appears only after re-scoring the identical chosen artifact; its first measurement's interval includes zero. Four of six cells retained changed artifacts: all three MBPP cells and GEPA on HoVer. This is adaptive development selection, not a superiority claim.

Total subject-model usage was **18,250 calls, 11,175,387 reported tokens and $50.533065-equivalent**. All estimated usage and charges, refusals, hidden attempts, missing retry observations, transport failures and unknown-usage calls are zero. Dollar-equivalent is the frozen experimental accounting measure, not a subscription invoice or a new account spending cap.

## Execution and immutable contract

Predeclaration 9 was committed as `a5ebc90` before any search. Its SHA-256 remains `2ea1f4e7b68e8ddd0d9fe04326a69abdfd624c9650e4eaa1c8aaf4e5b5f0b940`. The exact serial matrix was MBPP then HoVer, each Hone, GEPA, plain, all seed 0. Every manifest agrees on engine hashes, route hash, budget, approved account-pool hash, declaration and transition. The same seed artifact is used by all methods within each task. The retained receipts and the [machine report](../results-9-seed0.json) bind the measurements to their inputs.

The authorized unit was `hone-seed0-9-resume-20261104T235448.service`, launched on approved head `f9ac143553998b994525a023ebb562b21e08d5ff`. Its historical main PID was 4164997. The unit had `Restart=no`, verified `NRestarts=0`, CPU affinity `[6]`, nice 10 and the declared one-thread settings. `NLTK_DATA=/home/tim/worktrees/hone/hone-hone-pilot-seed0-1/.pilot-cache/nltk` was explicitly verified in the unit before Python startup. The CLI also sets it before admission through the single `configure_nlp` definition. No account-pool setup moved before admission.

[Launch-head CI](https://github.com/twaldin/hone/actions/runs/41936743094) passed and [exact-head cross-family READY](https://github.com/twaldin/hone/pull/37#issuecomment-6645527443) was recorded before launch. The unit completed with exit 0 after **67,641.978 seconds (18h 47m 21.978s)**. It is now released (`LoadState=not-found`, inactive/dead, MainPID 0); no pilot process remains live. The earlier failed unit was not restarted. [Controller](controller.json) records the full launch argv, pool/domain proof and terminal lifecycle; [journal](unit-journal.log) retains the owned run's output.

Serial execution keeps one optimizer/model stream and leaves the subscription reserve and other CPUs for other seats. The pool stayed gmail.com ×2 plus purdue.edu ×1, API keys denied, lindy.ai excluded. Throttle behavior was unchanged. The only pause was MBPP/GEPA's stale-account-usage episode, automatically resumed after 221.940 seconds; there is no evidence here attributing it to a broker migration. No broker or omp configuration changed.

The exact admitted HoVer index copy was reused. The source artifact remained read-only; no fresh rebuild, BM25S fix, re-admission, new controls, relaxed gate, extra seed or final-test evaluation occurred. The [artifact reuse and byte-reproducibility limit](../index-artifact-9/README.md) remains applicable.

## Per-cell paired selection

Scores are percentages. Deltas and intervals are absolute percentage points. MBPP uses 90 unique selection instances; HoVer uses 300. Each cell compares its retained chosen artifact with the unchanged seed artifact on the same rows. Initial measured seed scores differ across independent cell evaluations despite identical seed artifacts within each task; no baseline is reconstructed or shared across methods.

| Task | Method | Rows | Seed % | Chosen % | Delta [95% interval], pp | Excludes zero? | Changed artifact? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MBPP | Hone | 90 | 75.56 | 80.00 | +4.44 [0.00, 10.00] | No | Yes |
| MBPP | Official GEPA | 90 | 77.78 | 80.00 | +2.22 [-4.44, 8.89] | No | Yes |
| MBPP | Plain | 90 | 76.67 | 81.11 | +4.44 [1.11, 8.89] | Yes, after re-score | Yes |
| HoVer | Hone | 300 | 30.00 | 30.00 | +0.00 [0.00, 0.00] | No | No |
| HoVer | Official GEPA | 300 | 30.33 | 45.33 | +15.00 [9.67, 20.67] | Yes | Yes |
| HoVer | Plain | 300 | 31.33 | 31.33 | +0.00 [0.00, 0.00] | No | No |

The predeclared method is 10,000 paired bootstrap resamples over unique instances, with 95% type-7 percentile intervals. A changed winner uses the last complete matching retained selection vector; no pooling across adaptive evaluations. An unchanged winner reuses its initial seed vector, so its artifact contrast is exactly zero. A `[0, 0]` contrast does not claim zero uncertainty about the seed's absolute accuracy. There is no Holm correction and no superiority claim.

The practical effect threshold is 2 absolute points. The three MBPP point deltas and GEPA/HoVer's point delta meet it. Only GEPA/HoVer's cell interval lies wholly above it; Plain/MBPP's positive interval still includes effects below 2 points.

### Same-artifact stochastic re-evaluations

Plain/MBPP's chosen artifact `51b0db0f` first scored **78.89%** at evaluation line 75, giving **+2.22 points [-3.33, 7.78]** against the initial seed, which includes zero. The identical artifact scored **81.11%** at line 87, giving the primary **+4.44 [1.11, 8.89]**. Episode 48's parent and proposed artifact have identical hashes, yet the second score was accepted as a strict improvement. Its positive bound therefore is not independent evidence from a new artifact revision. The predeclared last-matching-vector rule, primary report and all numbers remain unchanged; this diagnostic uses only archived scores, not another model call.

All differing complete same-artifact selection re-evaluations in the six logs are listed below. Line numbers refer to the cell's `evaluations.jsonl`. The [diagnostic record](stochastic-reevaluations.json) also retains identical-score repeats and the paired calculation above. Repeats are never pooled as independent instances.

| Cell | Artifact hash prefix | Selection evaluation lines and scores |
| --- | --- | --- |
| MBPP/Hone | `55ce6835` (seed) | 1: 75.56%; 122: 76.67%; 145: 76.67%; 155: 76.67%; 240: 75.56% |
| MBPP/Plain | `85841b30` | 37: 75.56%; 44: 77.78% |
| MBPP/Plain | `51b0db0f` (chosen) | 75: 78.89%; 87: 81.11% |

## Per-cell spend

Each phase entry is **model calls / reported tokens / dollar-equivalent**. Estimated tokens and charges are separately zero in every phase. Proposal includes repairs where the frozen method permits them. All charges remain counted.

| Task | Method | Proposal | Training eval | Selection eval | Unassigned tail | Total $-equivalent |
| --- | --- | --- | --- | --- | --- | --- |
| MBPP | Hone | 139 / 458,634 / $1.851858 | 2,904 / 550,699 / $3.831777 | 990 / 203,404 / $1.389912 | 0 / 0 / $0.000000 | $7.073547 |
| MBPP | Official GEPA | 100 / 831,231 / $3.014337 | 1,272 / 616,318 / $2.760774 | 1,800 / 914,566 / $4.077330 | 0 / 0 / $0.000000 | $9.852441 |
| MBPP | Plain | 51 / 210,453 / $0.785847 | 408 / 62,286 / $0.491082 | 3,510 / 640,878 / $4.772718 | 81 / 15,651 / $0.111225 | $6.160872 |
| HoVer | Hone | 12 / 454,537 / $1.445955 | 384 / 280,164 / $1.259268 | 1,193 / 818,367 / $3.718197 | 1,119 / 765,146 / $3.474270 | $9.897690 |
| HoVer | Official GEPA | 2 / 198,095 / $0.601593 | 160 / 115,487 / $0.524169 | 2,378 / 1,698,477 / $7.495239 | 0 / 0 / $0.000000 | $8.621001 |
| HoVer | Plain | 16 / 1,169,448 / $3.625452 | 541 / 362,627 / $1.630461 | 1,190 / 808,919 / $3.671601 | 0 / 0 / $0.000000 | $8.927514 |

Unassigned tails are **known, metered usage without a completed evaluation span**, not unknown usage. MBPP/Plain has 81 such calls, 15,651 tokens and $0.111225. HoVer/Hone has 1,119 calls, 765,146 tokens and $3.474270. Those 1,200 calls and $3.585495 remain in totals. They are not silently moved into training or selection, and do not trigger the unknown-usage abort rule. The ordered call receipts and completed spans remain available in each `spend.json`.

The diagnostic call contexts identify both tails as selection re-scores of their incumbent artifacts. The primary completed-span phase buckets stay unchanged and retain them as unassigned; no cost, measurement vector or rule is rewritten. The two `spend.json` reports therefore remain explicitly `incomplete` for phase attribution even though every call's usage is metered. `controller.json` qualifies its provenance flags accordingly.

## Per-cell runtime and safety

Ledger wall is active plus usage-polling plus pause time. It excludes setup outside the ledger. Budget exits are successful completion under the frozen caps, not infrastructure failures. The configured active cap remained 7,200 seconds; the two active-bound exits record small terminal overruns, shown rather than rounded away. Dollar-reservation exits can leave headroom below $10 when the next operation's reservation cannot fit.

| Task | Method | Ledger wall s | Active s | Usage polling s | Pause s / episodes | Calls | Tokens | Refusals / hidden / unknown usage | Binding cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MBPP | Hone | 13512.727 | 7201.677 | 6311.050 | 0.000 / 0 | 4,033 | 1,212,737 | 0 / 0 / 0 | active_seconds |
| MBPP | Official GEPA | 11275.320 | 6097.018 | 4956.361 | 221.940 / 1 | 3,172 | 2,362,115 | 0 / 0 / 0 | usd_reservation |
| MBPP | Plain | 14058.275 | 7200.918 | 6857.357 | 0.000 / 0 | 4,050 | 929,268 | 0 / 0 / 0 | active_seconds |
| HoVer | Hone | 10454.749 | 5998.424 | 4456.326 | 0.000 / 0 | 2,708 | 2,318,214 | 0 / 0 / 0 | usd_reservation |
| HoVer | Official GEPA | 10386.586 | 5203.312 | 5183.274 | 0.000 / 0 | 2,540 | 2,012,059 | 0 / 0 / 0 | usd_reservation |
| HoVer | Plain | 6997.751 | 3759.681 | 3238.071 | 0.000 / 0 | 1,747 | 2,340,994 | 0 / 0 / 0 | usd_reservation |

Ledger wall sums to 66685.409 seconds. The unit's remaining 956.569 seconds cover startup, pre-ledger work and teardown that cannot be allocated to individual methods from these receipts. Usage polling (31002.438 seconds) is not a capacity/outage pause. The run-wide actual pause total is 221.940 seconds, one complete episode, well below six hours. All pause-accounting markers are complete.

The dispatcher recorded `dispatch_stop: null`. All per-cell unknown-usage rates and the run-wide hidden-attempt rate are 0%; there were no infrastructure-failure streaks, refusals or retry-observation gaps.

## Per-method equal-weight two-task results

The point estimate is the equal-weight mean of the two task deltas. The interval uses 10,000 hierarchical bootstrap resamples over tasks, then instances within each sampled task. It is not a pooled-row or an independent-method superiority interval. Hone's and GEPA's point means meet the two-point threshold. Plain's primary +2.22 meets it only with the second Plain/MBPP measurement; the first measurement of those same artifact bytes gives +1.11 [-1.11, 5.00], below the threshold. No method interval excludes zero or lies wholly above two points. The primary figures below stay unchanged; first-measurement figures are sensitivity diagnostics, not a replacement protocol.

| Method | Equal-task seed % | Equal-task chosen % | Mean delta [95% interval], pp | Excludes zero? | Changed cells | Calls | Reported tokens | $-equivalent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hone | 52.78 | 55.00 | +2.22 [0.00, 7.22] | No | 1/2 | 6,741 | 3,530,951 | $16.971237 |
| Official GEPA | 54.06 | 62.67 | +8.61 [-1.11, 17.67] | No | 2/2 | 5,712 | 4,374,174 | $18.473442 |
| Plain (reported re-score) | 54.00 | 56.22 | +2.22 [0.00, 6.67] | No | 1/2 | 5,797 | 3,270,262 | $15.088386 |

### Per-method phase accounting

The same calls / reported tokens / dollar-equivalent format applies. Estimated charges are zero.

| Method | Proposal | Training eval | Selection eval | Unassigned tail |
| --- | --- | --- | --- | --- |
| Hone | 151 / 913,171 / $3.297813 | 3,288 / 830,863 / $5.091045 | 2,183 / 1,021,771 / $5.108109 | 1,119 / 765,146 / $3.474270 |
| Official GEPA | 102 / 1,029,326 / $3.615930 | 1,432 / 731,805 / $3.284943 | 4,178 / 2,613,043 / $11.572569 | 0 / 0 / $0.000000 |
| Plain | 67 / 1,379,901 / $4.411299 | 949 / 424,913 / $2.121543 | 4,700 / 1,449,797 / $8.444319 | 81 / 15,651 / $0.111225 |

### Per-method runtime and safety

Method wall is the sum of its two cell ledgers, not a separate concurrent wall observation. The actual matrix ran serially.

| Method | Ledger wall s | Active s | Usage polling s | Pause s / episodes | Refusals / hidden / unknown usage |
| --- | --- | --- | --- | --- | --- |
| Hone | 23967.476 | 13200.101 | 10767.375 | 0.000 / 0 | 0 / 0 / 0 |
| Official GEPA | 21661.906 | 11300.331 | 10139.635 | 221.940 / 1 | 0 / 0 / 0 |
| Plain | 21056.026 | 10960.598 | 10095.427 | 0.000 / 0 | 0 / 0 / 0 |

## Limits that matter for the next decision

- Plain/HoVer produced 16 proposer responses and zero valid updates. All 16 failed JSON parsing at the first character; the first response begins with explanatory prose before its JSON. The seventeenth episode ended on the dollar reservation. The unchanged seed was retained. This measures the frozen plain loop's artifact-generation compliance as well as search quality, not evidence that no useful HoVer prompt exists. No repair or retry was added after observing it.
- Hone/HoVer's episode-5 candidate `70a889a4` passed the paired training gate at 6/8 versus the seed's 1/8, delta +0.625. The budget then ran out during a selection re-score of the incumbent seed: calls 1590–2708, 1,119 calls / $3.474270, touched 281 of 300 selection instances. The gate-passing candidate received no selection evaluation. The retained seed's zero artifact contrast is a censored promotion result, not evidence that this candidate would or would not improve selection.
- Plain/MBPP's positive interval depends on the second evaluation of identical artifact `51b0db0f`; its first interval includes zero, as disclosed above. Its 81-call tail is a third selection attempt of that same artifact, touching 81 of 90 rows. Nothing was completed or re-run after the frozen cell ended.
- Selection is adaptive, and this is one optimizer seed and two tasks. The broad task-hierarchical intervals are the requested uncertainty description, not a ranking or public optimizer-quality result.
- Only the declared default lane cache is used. Pre-existing child handling of a custom `--cache` is outside this run and unchanged.
- Future admitted reruns must reuse the admitted index artifact. Fresh byte-identical rebuilding is not guaranteed by the pinned recipe.

## Replay without models or final-test labels

Verify the complete raw bundle, including its nested cells:

```sh
nice -n 10 taskset -c 6 python3 -m pilot verify --out evidence/pilot/seed0-search-9
```

Recompute the report from archived development outputs, without data loaders, provider credentials, model calls or final-test labels:

```sh
nice -n 10 taskset -c 6 python3 -m pilot.results --runs evidence/pilot/seed0-search-9 --out .pilot-state/results-9-seed0-replay.json
cmp evidence/pilot/results-9-seed0.json .pilot-state/results-9-seed0-replay.json
```

The source, statistical rule, cap settings and all six model-output receipts are retained. `harness-bundle.json` preserves the original harness-produced inventory and hash from before this README, controller, journal and stochastic diagnostics were added. `controller.json` records that original hash; the outer bundle is resealed for these additions. Leaf cell bundles are unchanged.

**Seeds 2–3 and any final-test evaluation remain out of scope. No merge is authorized.**
