# Predeclaration 11: stopped before search

Predeclaration 11 was committed first as `b453995e9add69d3d82a11673e80e0dfaa46c8d8`. Implementation is committed as `0d929fa76b030aefe84c6de967362cf90b170f6c`.

## Proof completed

- Three timeout/nonzero/missing-frame regressions failed before the fix because the old scorer returned zero instead of raising.
- All 325 pilot tests passed with real Docker and official metrics enabled. All 12 offline provider-receipt tests passed.
- The real pinned sandbox produced pass=1, wrong-answer=0, and nonzero-exit/frame-failure/timeout with no score. `grader-smoke.jsonl` retains the invocation and outcome receipts, including generated source and output hashes. No model calls were made.
- Official GEPA and its adapter remain unchanged. The shared grader boundary changes equally for all three methods. Earlier measurement bundles were not edited.

## Admission stop

Unit `hone-predecl11-admit-r10-20261107T110326Z.service` exited 1. Its historical main PID was 431140; it is no longer live. The unit had `Restart=no`, `AllowedCPUs=6` and nice 10, but `execution_limits()` rejected the inherited process affinity before the pinned CLI version check, gateway startup or admission replay. The exact rejected affinity mask was not retained. `admission-failure.json` is the original receipt; `launch-stop.json` records the unit properties and stop.

The admission command lacked an explicit `taskset -c 6` wrapper. The declared admission-failure stop was honored: no restart and no search launch. Recommendation for a resumed run: use explicit `taskset -c 6` before Python, retaining all other unit settings and the pinned runtime. This recommendation was not executed.

All twelve predeclaration-11 cells remain unstarted. Campaign calls used: 0/35,000. The initial full-matrix forecast remains 33,438. Selection re-score and unselected-gate-passer counts are unobserved, not fabricated zeros. No new quality table or aggregate exists.

Run 9's outbound outage dispatched no new model calls or search cells, so it produced no new measured scores to reclassify. Historical predeclaration-10 cells and the ENOSPC prefix remain separate.

## Offline replay

From the worktree root, replay the outcome, admission and reporting regressions without model calls:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 PILOT_CI_CPU=6 PILOT_DOCKER_TESTS=1 PILOT_OFFICIAL_METRIC_TESTS=1 NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python -m unittest discover -s pilot -p 'test_*.py' -v
nice -n 10 taskset -c 6 bun test --max-concurrency=1 pilot/gateway-receipts.test.mjs
pilot/.venv/bin/python -m pilot verify --out evidence/pilot/runtime-rerun-11
```

The synthetic sandbox smoke uses reference `def add(a,b): return a+b`, tests `assert add(1,2)==3` and `assert add(2,2)==4`, and the five sources retained in the outcome receipts. Fresh execution receipts include elapsed times, so compare outcomes and scores rather than receipt hashes.

A passing zero-call admission, green CI and exact-head cross-family READY are all required before any search. This stopped bundle is not launch permission. No merge, final-test evaluation, seed beyond 2, global runtime/broker/config change, home GUI or Deadlock access occurred.
