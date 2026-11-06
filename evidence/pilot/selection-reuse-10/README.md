# Selection reuse before development seeds 1 and 2

The goal is to stop Hone and plain from spending selection budget on already-scored artifacts before a gate-passing candidate reaches selection. Tim explicitly superseded fresh paired selection measurement. [Predeclaration 10](../predeclaration-10.md) records the decision, conservative-promotion bias, exact scope, twelve-cell order, inference, and stops. Official GEPA and its adapter are unchanged.

## Cause and correction

At baseline `6017e35`, `pilot/search.py:247-252` remeasured Hone's parent and optional incumbent before the child. The same shared `_loop` evaluated every plain proposal at line 260 without checking artifact identity. The old behavior was deliberate under `docs/pilot.md:163` and predeclaration 9:22. The initial lane stopped until Tim chose reuse on board tile `obj_01M6Q2WGPG5W4DQ75N` at `2026-11-06T00:08:09Z`.

The corrected loop stores a complete validated selection score vector under the canonical hash of the whole artifact. Later comparisons reuse it. Training measurements, restart draws, proposal/repair behavior, promotion thresholds, graders, and per-cell caps do not change. The cache is local to one cell. It does not resume interrupted evaluations or share measurements across methods, tasks, or seeds.

[Regression evidence](regression.json) records three failures before the correction and the passing integrated search, transition, and dispatcher run afterward. [Initial CI](ci-initial.json) records 284 passing Python tests with real Docker and official metrics, plus eight passing and four skipped bounded provider-receipt tests. [The first independent review](review-initial.json) records the accepted replay and documentation corrections.

## Real admission and retained evidence

[The refreshed CLI proof](admission.json) ran the unchanged `load_panel` through `pilot.main` on committed head `d60d2c2`, selected MBPP + HoVer, and stopped before environment, gateway, or search initialization. It records that head and all three changed execution-source hashes, CPU 6, nice 10, the verified seed-0 bundle, and byte-identical official GEPA adapter source. It made zero model calls and loaded no final-test labels. Replaying the print-only check does not rewrite this retained proof.

Replay that boundary from the repository root:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu PYTHONPATH=. NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python evidence/pilot/selection-reuse-10/check.py
```

The [source index proof](index-source.json) and [copied index proof](index-copy.json) match all eight admitted SHA256 values from the seed-0 cache. The source was read only. The index was copied, not rebuilt. [Source transition 10](../source-transition-10.json) binds the exact execution changes and predeclaration to the [pre-fix source snapshot](../source-snapshot-10.json), while preserving earlier admission identities.

The permanent archive regression compares every seed-0 report field except the reporter's own source hash:

```sh
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m unittest pilot.test_results.ReportTests.test_seed0_archive_replays_all_measurements_and_intervals
```

The sealed seed-0 README and report remain unchanged. Their byte-identical report replay requires the frozen reporter from commit `6017e35`; the current reporter has a different `reporter_sha256`.

The [full raw metric replay](metric-replay.json) verified the seed-0 bundle and reproduced all 12,764 retained rollout scores with zero model calls and no final-test labels. This is separate from the report-value regression above.

[Guard CI](ci-guards.json) passed all 287 Python tests with real Docker and official metrics, including duplicate-seed rejection and coordinated search-plus-receipt tamper rejection. The [independent comment audit](comment-audit.json) found no remaining findings or added suppressions. [Resumption](resumption.json) records the explicit review-counter reset after the original stop. Fresh final-head CI and cross-family READY remain prerequisites for search.

No final-test evaluation, seed beyond 2, broker/configuration change, automatic restart, or merge is authorized.
