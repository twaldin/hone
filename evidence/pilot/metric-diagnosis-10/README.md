# One historical MBPP training zero explains the reproduced replay failure

The offline diagnosis locates the protected-metric disagreement without changing a grader, an engine, a retained score or a search budget. Task 720 passed all 200 new fresh-worker repetitions. This does not reproduce intrinsic task nondeterminism. A transient protected-worker or frame-processing failure is the leading explanation for the old zero, not a proven historical failure subtype.

No model calls, model retries, seed-2 searches, budget resets, index rebuilds or merges occurred. These findings do not authorize a fix or another search.

## The recovered scan finished

Run 5's diagnostic unit completed successfully at `2026-11-07T03:47:40Z`, before the lane deadline. Its MainPID is now 0 and its exit status is 0. The lane did not consume and report the completion while blocked in an eval wait loop. The recovered [completed-sweep.jsonl](completed-sweep.jsonl) has a final `finished` record for all 10,236 retained scores. The exact executed diagnostic is archived as [runner text](run5-scan.py.txt). No full scan was repeated in run 6.

| Seed-1 cell | Scores checked | Mismatches |
| --- | ---: | ---: |
| HoVer, official GEPA | 380 | 0 |
| HoVer, Hone | 420 | 0 |
| MBPP, official GEPA | 2,970 | 0 |
| MBPP, Hone | 3,294 | 0 |
| MBPP, plain | 3,172 | 1 |
| Total | 10,236 | 1 |

The ENOSPC-damaged HoVer/plain cell was excluded from this scan. Its damage cannot explain this failure. All 5,100 retained selection scores matched. The only mismatch is in training, so it does not directly change a reported selection delta.

## Exact mismatch and counters

- File: [`raw/mbpp/1/plain/evaluations.jsonl`](../seeds12-search-10-rerun1/raw/mbpp/1/plain/evaluations.jsonl), JSONL line 47, `scores[3]`, the fourth entry.
- Row: `mbpp:train:720`, "add a dictionary to the tuple".
- Artifact: `sha256:6722810f38759c00ffae683890e2535059015b12c84ced0adad983380abb5db2`.
- Stored score: **0**. Replayed score: **1**.
- Output SHA-256: `abff8eae1323b36fa2aa9732bacb3d7e1e6c5137857752dc966a90a85ec34af6`.

The exact retained output is:

```python
def add_dict_to_tuple(test_tup, test_dict):
    return test_tup + (test_dict,)
```

The mismatch is scalar **8,502** in sorted replay traversal. The replay's `checked` variable would still be **8,498** because it increments only after an entire vector matches. It computes all eight entries of line 47 before comparing, so **8,506** scores have been computed when that vector is rejected. See `pilot/__main__.py:889-912`.

These are recovered diagnostic counts. The first uninstrumented replay did not log a locator or counter, so its historical failure position cannot be proved retrospectively. This sole differing scalar is sufficient to produce its exact error, `Replay metric disagrees with a retained evaluation`, and was the only mismatch in the complete diagnostic.

## Two hundred unchanged-scorer repetitions

[task720-repeat.jsonl](task720-repeat.jsonl) records 200 calls to the original `pilot.verification.score_solution` with the exact stored output and pinned MBPP training row. Each call starts a fresh protected worker. The original row-keyed trusted-plan cache remains unchanged, with one planning invocation. No score override, cache clearing, fault injection or load manipulation was used.

Result: **200 scores of 1, zero scores of 0**. All 200 workers exited 0, with no stderr, timeout or observed exception. Their result frames were byte-identical. The original full-scan mismatch receipt also contains a successful worker frame matching all three tagged expected results. The repetition completed in 41.473 seconds. This is a bounded observation, not proof that rare or correlated execution failures cannot occur.

The source is [repeat720.py](repeat720.py). Its audit hook permits only Docker subprocesses, rejects Python network access and checks the pinned image. It reads frozen row and source hashes before scoring, then checks the scorer hashes again. CPU 6, nice 10, one-thread settings and a 600-second unit limit bound the diagnostic.

[static-conflicts.json](static-conflicts.json) also records five historical scores of 1 for byte-identical task-720 output: GEPA lines 89 and 177, and Hone lines 109, 110 and 111. Plain line 47 is the sole stored zero for that exact output. These occurrences are not an independent estimate of a task failure rate.

## Cause and alternatives

1. **Leading hypothesis: a transient worker or frame-processing failure became a zero.** `pilot/verification.py:391-414` returns 0 for a timeout, nonzero worker exit, invalid frame or failed comparison. The producer does not retain that worker's exit status, stderr, timeout or result frame. The old subtype is therefore unresolved. Current repetitions support the code's semantic correctness but cannot recover the missing historical receipt.
2. **Intrinsic task nondeterminism was not reproduced.** The function only appends a dictionary to a tuple. Its three assertions use fixed literal inputs and expected results, recorded in [task720-reference.json](task720-reference.json). No task-specific exclusion is justified by these repetitions alone.
3. **A producer-side score/output association error is less supported, not disproved.** `pilot/tasks.py:315-357` appends each score and output together. `pilot/__main__.py:694-712` writes those arrays directly in the same row order. There is no observed producer mutation or reordering.

The following alternatives do not explain the reproduced mismatch:

- **ENOSPC truncation of a completed cell.** All 254 retained source hashes match. The only invalid retained JSON is HoVer/plain's 160-byte call tail and empty manifest. All completed cells' latest writes predate the assistant-proven root-filesystem outage, about `2026-11-06T22:36Z` through `22:42Z`. MBPP/plain's latest write was `15:01:10Z`. See [corruption-audit.json](corruption-audit.json).
- **HoVer cache drift.** All seven admitted corpus and numeric-index payload hashes match. The receipt matches the retained manifest, both index JSON files parse, and all three NPY headers and lengths are valid. No index was rebuilt. HoVer replay scores retained passages without invoking retrieval. See [cache-integrity.json](cache-integrity.json) and `pilot/hover.py:401-414`.
- **An omp runtime-path difference.** Offline scoring invokes Docker, not omp or the gateway. The observed image matches the recorded digest, and all four scoring-source hashes match the frozen identity. The repetition also asserts the image on every invocation.
- **Post-hoc reporting arithmetic.** The disagreement exists in a raw training score before report aggregation. This does not rule out the separate, less-supported producer association hypothesis above.

Plain uses these training scores and traces in its next proposer message, `pilot/search.py:200-212`. Correcting the stored zero after the fact would not recover the search that different feedback might have produced. The old zero and all old reports remain unchanged. No experiment READY is claimed.

## Infrastructure rerun allowance

The HoVer/plain ENOSPC event fits the assistant-proven external filesystem exhaustion at the same time. It is an infrastructure abort, not a measured gate failure. Addendum 1, line 3, explicitly extended predeclaration 7's allowance to this campaign and consumed rerun 1. In that classification, another authorized identical-contract attempt would be number 2 of at most 2.

That count is not permission to launch. Predeclaration 10, line 48, and addendum 1, line 48, prohibit automatic or selective restarts. The damaged cell's final response may have been a refusal, its usage is unknown, and its consumed prefix must not disappear into a fresh budget. A changed metric or filtered cohort under predeclaration 11 is not an identical-contract infrastructure rerun. No allowance was consumed by this offline diagnosis.

## Predeclaration 11 options and costs

None of these options is implemented or authorized here.

| Option | Cost and consequence |
| --- | --- |
| Keep all rows, retain grader outcome receipts, and distinguish infrastructure failure from wrong answers before new measurement. **Recommended first.** | Recording itself needs no extra model calls. A future code and policy change needs boundary checks and admission. Classifying former zeroes as infrastructure changes the measurement contract and can increase aborts. It cannot recover the missing historical worker status. |
| Grade each fixed generated output with three independent workers and a predeclared majority rule. | About three times the candidate-worker invocations, without extra generation calls for those same outputs. More active time reduces search under the unchanged 7,200-second cap. The metric and admission change. Correlated failures can defeat majority voting. Refusals remain zero and are never retried. |
| Exclude task 720 from MBPP training under a frozen quarantine rule. | Training drops from 374 to 373 rows; selection stays at 90. Filtering itself needs no model calls, but feedback, cohort and admission change. New matched searches would be needed, and results cannot be pooled with predeclaration 10. Exclusion does not solve arbitrary worker failures and is not supported as a task-specific remedy by 200 stable repetitions. |
| Stop and publish predeclaration 10 as a stopped exploratory pilot. | No more pool or grader use. The twelve-cell comparison remains incomplete, with six seed-2 cells unstarted and primary aggregates unavailable. |

Any new matched search campaign needs separate authorization. Its usage was not estimated by this diagnostic. The existing twelve-cell ceilings were $120-equivalent and 144 million charged tokens, not a forecast or invoice.

[diagnosis.json](diagnosis.json) contains the machine-readable findings and limits. [bundle.json](bundle.json) seals this additive diagnosis. The earlier stopped-run bundles are unchanged. No fix, search rerun, score replacement or merge follows this report.
