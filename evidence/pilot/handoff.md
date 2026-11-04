# Pilot admission stopped

The requested end state was a frozen, proven harness ready for the optimizer pilot. It was not reached: the fresh MBPP controls failed the predeclared ranking. This is the assistant's admission stop, not a measured Hone-versus-baseline result or Tim's H7 kill gate.

Frozen implementation: `88079246304d01a497d1530a48800fe465441e80`. No searches ran. No controls were retuned or rerun after this failure.

## Task choices

| Task | Official development partitions | Metric | Reason |
| --- | --- | --- | --- |
| P IFBench | 300 training / 300 selection from the released development-file transformation | Official loose instruction fraction | Explicit prompt constraints and a non-LLM checker. |
| P AIME | Historical 90 questions, official Random(0) shuffle and 45/45 halves | Official integer answer equality | Reasoning-heavy exact answers without the final AIME2025 panel. |
| A MBPP | Official full training 374 / validation 90; CC-BY-4.0 | All published development assertions pass | Licensed bounded executable agent programs; the present adaptation failed admission. |

Pins, licenses and transformations are in [the contract](../../docs/pilot.md) and `preparation-v2/tasks.json`. No final-test material was loaded.

## Controls and noise

| Task | Known-improved | Naive | Broken | Shortcut | Ranking | Noise |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| MBPP, 8 training rows | 0.875 | 0 | 0 | 0 | Failed: naive ties both negatives | Not measured; ranking stopped the run |
| IFBench | — | — | — | — | Fresh calibration not run | Not measured |
| AIME | — | — | — | — | Not run | Not measured |

All eight retained naive outputs contain Markdown/explanatory text rather than only executable Python. The failed trusted-reference row, `mbpp:train:601`, uses `Pair` objects; the current RPC boundary supports literal-valued arguments/results only. The zero reference score is not evidence that the official reference is wrong. These are reasons to review the A-task measurement contract, not to relax the ranking or silently filter official partitions.

The stopped calibration used **8 task calls, 2,715 reported tokens, $0.033165-equivalent, 52.281 seconds wall time, 0 pauses and 0 observed hidden attempts**. There were no transport failures or missing-usage calls. This usage belongs to evaluator calibration, not to the plain-loop baseline.

## Smoke

| Method | Selection score | Calls / tokens / dollar-equivalent / wall / pauses |
| --- | --- | --- |
| Hone | Not run | Not measured: control gate failed |
| Official GEPA | Not run | Not measured: control gate failed |
| Plain loop | Not run | Not measured: control gate failed |

GEPA's native package/component bridge passed deterministic integration tests. Its real subscription reflection smoke remains unproved. There are no per-method hidden-attempt rates to compare.

## Preserved proof

- Failed bundle: `controls/mbpp`, hash `sha256:4b9cd713489e48b6281ee938e6020a242d1dd5b55558de16e90c918b2c5254e0`.
- Hash verification passed. Offline replay recomputed **32 retained control rollouts with 0 model calls** and matched every score:
  `nice -n 10 taskset -c 0 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 pilot/.venv/bin/python -m pilot replay --out evidence/pilot/controls/mbpp`.
- `route-proof-v4` proves real OAuth access and native fallback refusal: no allowed OAuth account, 0 provider HTTP attempts, and 0 API-key-header guard rejections. Allowed pool: **gmail.com ×2, purdue.edu ×1**; API keys and lindy.ai excluded.
- `throttle-proof-v2` forced 99% usage at an 80% threshold, then an outage, then a live normal reading. One pause lasted **0.102994 seconds**; dispatch occurred only after resume. No shared broker was interrupted.
- `boundary-proof.json` records the real Docker exit failure before correction and the corrected zero-score/paused-container behavior.
- **79 pilot tests, 71 native optimizer tests and workspace typecheck pass.** The full repository suite has three failures in unmodified CLI files; no baseline rerun was performed. See `verification.json`. GitHub Actions workflow count was 0.

## What remains blocked

No final cross-family READY or PR is claimed. The first failed ranking stops further calibration and every search. The earlier aborted IFBench measurement is explicitly inadmissible and is not reused as a passing result.

There is no defensible empirical 27-run token or throttled-hours estimate without valid controls and smoke. Configured allowances are $270-equivalent, 324 million reported tokens and 54 active-work hours across 27 runs; these are not forecasts or hard elapsed-time bounds. In-flight work, usage polling and subscription pauses add time. Old IFBench call costs also warn that Hone may exhaust its fixed budget before its first promotion; see the contract's feasibility note.

The planned command below is **blocked, not authorized**. The current failed controls intentionally make it refuse before model dispatch:

```sh
nice -n 10 taskset -c 0 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 pilot/.venv/bin/python -m pilot pilot --controls evidence/pilot/controls --out .pilot-runs/pilot-27
```

Recommendation: have the assistant review the MBPP execution/format contract and predeclare any authorized replacement calibration before another lane proceeds. Preserve official partitions; do not drop failing rows or alter controls to obtain a favorable result. Credential-opaque per-attempt and failed-call usage receipts inside omp remain prerequisites for the full matrix. Reported usage currently omits internal failed-attempt tokens and non-200 usage; omitted volume is unknown. Nothing was filed upstream.
