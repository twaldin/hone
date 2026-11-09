# Predeclaration 11 finished with one infrastructure-failed cell

All twelve cells were attempted. Eleven completed at their declared per-cell caps. MBPP/seed-2/official GEPA ended with an unscored grader-infrastructure outcome after 361 calls. It was not retried, repaired or replaced. The dispatcher finished normally, with no campaign-level stop. The quality report remains `partial_or_stopped` because one planned comparison is unavailable.

The retained campaign records **30,285 calls, 20,122,657 reported tokens and $91.251903 reported cost-equivalent**. This is not an invoice or a complete usage total. One provider call lacks usage, and internal failed-attempt usage remains unknown. No estimated usage fills that gap.

[All tables](tables.md) contain every cell, per-seed methods, primary seeds-1–2 methods, task aggregates, diagnostics, phase spend, timing and separate historical seed 0. [report.json](report.json) is the unchanged `pilot.results` output. Seed 0 is never pooled with predeclaration 11.

## Primary analysis

Hone's equal-seed, equal-task delta is +9.28 percentage points, with a descriptive 95% interval [0.00, 25.75]. Plain's delta is +2.50 points [0.00, 6.94]. GEPA's primary aggregate is unavailable because MBPP/seed-2/GEPA failed. The missing cell is neither zero-filled nor excluded by renormalizing the method's weights.

Neither available primary method interval excludes zero. These are adaptive development-selection results, not confirmatory evidence of optimizer superiority. Intervals retain the predeclared paired comparison, equal seed and task weights, 10,000 MT19937 replicates, random seed 20261109 and type-7 endpoints. The historical predeclaration-9 estimates retain their original same-artifact remeasurement caveats.

## Selection reuse and budget order

Every Hone and plain cell has **zero archived repeated selection evaluations**. All four Hone cells have **zero gate-passing candidates without a complete selection vector**.

The seed-1 HoVer/Hone candidate passed paired training 6/8 versus its parent's 2/8. It received its complete 300-row selection vector, 184/300 versus the seed's stored 86/300, and was promoted. Its 1,188 selection calls were not spent re-scoring the incumbent. Seed-2 HoVer/Hone retained its seed, so the large seed-1 gain is not presented as a replicated improvement.

Unchanged MBPP/seed-1/GEPA has **one** repeated selection evaluation. The identical seed artifact `55ce6835…` appears at evaluation lines 1 and 129. The repeated vector used 90 calls and $0.116832-equivalent. Its artifact was re-proposed at iterations 3, 30 and 60. Official GEPA and its adapter remain unchanged, including `cache_evaluation=False`. The blanket expected-zero diagnostic is therefore not observed for the external baseline. Its count is reported as one, not rewritten to zero.

Plain's fresh incomplete selection tails remain charged and ineligible. They are not incumbent re-scores or fabricated zero-score vectors. The [diagnostic tables](tables.md#fresh-selection-tails) retain the artifact hashes and observed tail lengths. Hone-style gate counts are N/A for plain and GEPA.

## Infrastructure outcome and terminal status

`raw/mbpp/2/gepa/failure.json` retains the receipt for `mbpp:train:603`, artifact `1f43d340…`. The protected worker returned `nonzero_exit`, exit 137, with `score: null`. Its underlying cause is not diagnosed or inferred. No grader replay, row retry or third campaign was run. The failed cell has no terminal `search.json`, which the reporter flags. Its archive, failure receipt, manifest, result, spending and intact journals are present and hash-valid. No missing file was synthesized.

The failure was isolated between completed MBPP/Hone and MBPP/plain cells. The declared consecutive-infrastructure-failure stop did not fire. All eleven successful cells ended at `active_seconds` or `usd_reservation`; a handled `BudgetExhausted` inside reflection is a declared per-cell cap, not a process crash.

Unit `hone-seeds12-11-rerun2-20261107T164756Z.service`, historical PID 2668438, ended at 2026-11-09T06:53:11Z. The assistant's terminal receipt reports systemd `Result=success` and `ExecMainStatus=0`. [terminal.json](terminal.json) labels that provenance separately from the producer controller and retained original [journal](unit-journal.jsonl). Post-collection systemd defaults are not used as success proof. No campaign unit is left running.

## Limits and accounting

The guard journal contains consecutive dispatch ordinals 1 through 30,285, below the 35,000-call hard cap. The maximum before-cell projection was 34,506. Recorded pauses total 13,133.284 seconds, below the unchanged 21,600-second run-wide allowance. One call had ten observed hidden attempts; one call lacked usage. Both were below their cell's greater-than-1% abort thresholds. Refusals were zero. [safety.json](safety.json) retains the twelve before-cell receipts.

The 100 GB free-disk floor was enforced at the declared boundaries. The archive does not provide a continuous disk trace or an observed minimum, so none is invented. The existing admitted HoVer index and lane-local omp 18.16.0 were reused. Frozen route, OAuth-only pool, execution-source and index identities remain in `raw/rerun.json`. No global runtime, broker, configuration or updater change occurred. No final-test labels, seed beyond 2, home GUI, Deadlock, campaign relaunch or merge was used.

Incomplete evaluation-tail calls remain in spending totals. The failed GEPA cell's 361 calls and $0.679938-equivalent are also included. `spend.status=incomplete` can mean an unassigned cap tail or unknown usage; it does not imply damaged JSON. The complete original producer inventory has 452 files and 186,154,414 bytes. All JSON and all 120,317 JSONL records were readable. Every copied file, including nested bundle manifests, matches its original byte count and SHA-256.

## Exact historical review recovery

[review-recovery.json](review-recovery.json) records three complete original reviews and their hashes. `reviews/ReleaseReview11d.md` is the authenticated 8,005-byte original, SHA-256 `fde35eb67acdf7f97442d82bb1882823ef0aec9367f7d0a700e2948f407e0df8`. It completes the truncated copy in the immutable 11e bundle. The complete 11f release and I/O reviews are also retained.

Two incidental fixture assertions were removed before the 11f launch, not one: the stderr-marker assertion and the assertion that the reason contained `exceeded`. The protected worker redirected that marker away. The native SIGWINCH/CLD_TRAPPED assertion and the consumer's numeric outcome, completed exit and validated receipt checks remained. The before-fix fixture also wrote the marker; that does not change its demonstrated failure. No wording-only assertion is restored here, and no grader, engine, adapter or test source changes accompany this archival report.

## Replay without model calls or grader execution

Run from the repository root with the committed execution source:

```sh
replay_dir=$(mktemp -d)
nice -n 10 taskset -c 6 env PYTHONPATH="$PWD" PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python evidence/pilot/seeds12-search-11-rerun2/replay-report.py --out "$replay_dir/report"
cmp evidence/pilot/seeds12-search-11-rerun2/report.json "$replay_dir/report/report.json"
cmp evidence/pilot/seeds12-search-11-rerun2/tables.md "$replay_dir/report/tables.md"
```

The replay verifies original file hashes, nested cell bundles and receipt provenance, then calls `report_seeds12` with predeclaration 11. It generates the report and tables outside the sealed evidence. It makes no model calls and does not execute graders. Remove only the scratch directory you created after inspecting the output.

The existing reporter CLI also generates the canonical JSON:

```sh
PYTHONPATH="$PWD" pilot/.venv/bin/python -m pilot.results --runs-seed1 evidence/pilot/seeds12-search-11-rerun2/raw --runs-seed2 evidence/pilot/seeds12-search-11-rerun2/raw --runs evidence/pilot/seed0-search-9 --predeclaration 11 --out /tmp/pilot-predecl11-report.json
```

Archive-derived report and table replay matched byte-for-byte. This is integrity and reporting verification, not a fresh protected-metric replay. Fresh grader replays were explicitly out of scope. Final-head CI and independent cross-family review are recorded on PR #38 after this bundle is committed. Stop before merge.
