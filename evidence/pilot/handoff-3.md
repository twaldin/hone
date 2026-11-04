# Admission 3 stopped at IFBench ranking

The goal was a proven three-method development pilot with a protected MBPP verifier. The process boundary repair passed its adversarial controls, but **the epoch is not admitted**. IFBench's predeclared known-improved prompt scored below the unchanged naive prompt. The runner stopped normally at that ranking gate. No retuning, redraw, selective rerun, AIME control measurement or smoke search followed. No PR or READY verdict is claimed.

## Frozen boundary and predeclaration

[Predeclaration 3](predeclaration-3.md) was committed as `62a9257` before new pilot model calls. Implementation head is `d0d1e15aee89d58c0c61b070f22e6cae54eea8ba`. Seed **20261104**, 20 training rows per task; MBPP excludes the 28 earlier control rows from this draw only. All official training and selection rows remain present. Final-test data was not loaded.

The trusted planner runs official reference/setup/assertion expressions in its own pinned container. A separate fresh candidate container receives only candidate code, function names and tagged call arguments. The trusted parent compares canonical data against expected results. The explicit official int wrapper runs in another trusted pinned process on validated plain data. Pair and Node arguments are reconstructed without candidate constructors. Custom results use exact class name and field schema, never candidate equality, hash or repr methods. No reference source, test files, expected values, credentials or host directories enter the candidate worker.

All **464 MBPP development rows are gradeable; zero are filtered or ungradeable**. Under the predeclared exact-type rule, 12 reference programs fail where float differs from int or Counter/defaultdict differs from dict. They remain gradeable and score zero. The full initial real-Docker reference probe recorded 452/464; its scope is explicitly labeled in [verification-3.json](verification-3.json). One strict-type reference failure is in the fresh cohort, so the measured positive-control mean is 0.95 rather than 1.0.

| Task | Train / selection | Metric and license | Choice |
|---|---:|---|---|
| P IFBench | 300 / 300 | Pinned official loose instruction fraction and released partition transformation | Constraint-following prompts, fixed two-stage program |
| P AIME | 45 / 45 | Historical development data, official shuffled halves and integer comparison | Exact-answer reasoning, no final AIME2025 panel |
| A MBPP | 374 / 90 | Official train/validation assertions adapted to the declared exact-type data boundary; CC-BY-4.0 | Executable bounded agent-program task, no Terrarium source/data |

Source revisions, dataset hashes, memberships and checker assets are retained in the manifests.

## Adversarial controls

The offline command exercised **15 MBPP attacks ×20 rows =300 checks**, all scoring **zero**. It used no model calls. Each exact artifact, emitted answer and per-row score is retained in [adversarial-3](adversarial-3/).

| Attack family | Cases |
|---|---|
| Execution replacement | builtins.exec override |
| Always-equal objects | __eq__/__hash__, including builtin subclass |
| Early successful exit | sys.exit(0), os._exit(0) |
| Forgery | stdout verdict, receipt, plain-data frame, dataframe verdict |
| Checker changes | unittest/assert helpers, comparison functions, harness modules |
| Expected-value access | test/expected paths and environment |
| Exit hook | atexit result rewrite |
| Prior shortcut | Original artifact unchanged |

IFBench and AIME checkers remain in the trusted host and receive strings, never executable candidate objects. Each task passed 34 hostile protected-protocol/raw-response checks against a deterministic synthetic metric fixture, plus its genuine positive scoring control. Arbitrary official IFBench outputs can receive partial instruction credit; this does not mean they changed the checker.

The proof is sealed as `sha256:bfafbe06def41ae3e11cbcfdbc596833da1ecbb6a216d01bd3727a344fd83538`. Controls loaded and validated that proof in a separate process before model dispatch. The separate-process plan identity is canonical and independent of set iteration order.

## Ordinary controls and noise

| Task | Improved | Naive | Broken | Original shortcut | Ranking | Noise |
|---|---:|---:|---:|---:|---|---|
| MBPP | 0.950000 | 0.700000 | 0 | 0 | Pass | 16 fresh pairs; SD 0.0301040, floor 0.0638602, envelope 0.0957903 < contrast 0.25 |
| IFBench | 0.866667 | 0.933333 | 0 | 0.300000 | **Fail** | Not run after ranking failure |
| AIME | — | — | — | — | Not measured | Not run after stop |

The IFBench result refutes the assumed ordering of these two control prompts on the fixed draw. It does not show that the official checker was altered or that the process-separated MBPP boundary failed. There is no post-hoc explanation used to waive the gate. All prompts, rows, thresholds and incomplete-task status remain unchanged.

## Reported usage and hidden attempts

| Calibration | Calls | Reported tokens | List-rate equivalent | Wall seconds | Active seconds | Poll seconds | High/outage pauses | Hidden attempts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| MBPP | 660 | 89,640 | $0.699996 | 2103.546 | 1072.359 | 1031.187 | 0 | 0 |
| IFBench | 77 | 46,206 | $0.407994 | 482.105 | 350.188 | 131.917 | 0 | 0 |
| Total | 737 | 135,846 | $1.107990 | 2585.651 | 1422.547 | 1163.104 | 0 | 0 |

Both ledgers report zero failed calls, missing-usage completions and retry logger events among recorded calls. All IFBench transport completions reported stop, not length. This does not imply every protected response was valid or every task answer correct. Reported usage can still omit opaque internal failed-attempt and non-200 token volume. Actual subscription invoices are not inferred from list-rate equivalents.

| Method | Smoke selection score | Calls/tokens/cost/wall/pauses | Per-method hidden attempts |
|---|---|---|---|
| Hone | Not run | Not measured | Not measured |
| Official GEPA | Not run | Not measured | Not measured; real subscription reflection remains unproved |
| Plain | Not run | Not measured | Not measured |

The complete control command elapsed 2685.50 seconds. Per-task ledger totals above omit approximately 99.85 seconds of preparation and command overhead.

## Throttle, replay and CI

The unchanged OAuth-only pool permits gmail.com ×2 and purdue.edu ×1. API keys, lindy.ai and all other domains/providers are excluded. Credentials are resolved by omp, not read or copied by the harness author. Execution uses nice 10 and CPU6, avoiding the live worker's observed CPUs0/5 and previously reserved CPUs1–4/13–16. One model request and CPU-heavy worker run at a time.

The new [throttle proof](throttle-proof-3/result.json) injected 99% utilization against the 80% threshold, then a broker outage, then a normal reading. It recorded **one 0.1024835-second pause** and dispatch only after resume. The live broker was not interrupted.

The stopped control prefix hash is `sha256:ea49cecaaf0bddefe1ff318efff552f122167b869f79162a08cae9ea84c1625a`. Offline verification succeeded, and replay reproduced **800 scored rollouts**, with zero model calls and no final-test material. A separate offline replay reproduced **436 adversarial checks**, also with zero model calls and no final-test material.

The local final suite passed **112 tests**, zero failures or skips, with real Docker and official metrics enabled. [CI run41594966941](https://github.com/twaldin/hone/actions/runs/41594966941) passed on the exact implementation head. Tests include the measured-calibration Python-to-Bun Hone bridge and the official GEPA adapter, but are not evidence of a real subscription reflection smoke.

Cross-family preliminary review found set-order-dependent plan identity and auth bootstrap before proof validation; both were fixed before formal adversarial admission. Five explanatory comments were deleted and `kept` renamed `retained_arguments`. No final READY is claimed for this failed admission. Earlier unmodified-main proof remains [main-baseline.json](main-baseline.json): the three reported repository failures are pre-existing and were not rerun merely to confirm them.

## Run plan remains blocked

There is no authorized next-lane search command for the failed epoch. The next safe command is offline evidence reproduction:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 pilot/.venv/bin/python -m pilot replay --out evidence/pilot/controls-3
```

A defensible per-method 27-run subscription token/throttled-hours estimate requires admitted smokes and is unavailable after this stop. Nominal configured ceilings remain $270-equivalent, 324 million reported tokens and 54 aggregate active-work hours. Those are limits, not a measured forecast or strict elapsed bounds; polling, outages and quota pauses add time.

Any next epoch needs a new gate-owner decision and predeclaration. The measured IFBench prompt is not a reliable known-improved control; silently strengthening it, changing the draw or continuing to search would violate this run's contract. Complete credential-opaque attempt and failed-call receipts inside omp remain prerequisites for the later full benchmark matrix. No upstream issue was filed for that requirement. No merge is authorized.
