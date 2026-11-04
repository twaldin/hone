# Development pilot, seed 0: admission stop

The requested outcome is six full searches, Hone, official GEPA and plain on MBPP and HoVer, to decide whether to fund the remaining seeds. The authorized dispatcher fixes and predeclaration 9 are complete. No search started because the real frozen-admission check failed before model dispatch. The brief's unchanged pre-search handback condition applies.

## What is implemented and verified

`pilot --seed 0` now dispatches exactly the six seed-0 cells. Before each new cell, the dispatcher checks the aggregate hidden-attempt rate, each finished cell's unknown-usage rate and the consecutive infrastructure-failure streak. Stops persist their reason and counts. The runner is serial, so a finished cell is preserved before any stop prevents the next cell. Exactly 1% remains allowed. The existing throttle also receives the remaining six-hour run-wide pause allowance.

The nine new dispatcher tests produced ten failing assertions, including two seed subtests, against the unchanged dispatcher. Each fixture visited 18 cells instead of its expected six or earlier stop. Those tests pass after the fix. The full updated suite passes 260 Python tests with real Docker and official metrics enabled; the twelve native receipt tests also pass. The smaller integrated dispatcher, transition, inference and runtime suite passes 69 tests.

The offline reporter implements the paired and hierarchical 10,000-resample bootstrap specified in [predeclaration 9](../predeclaration-9.md). It preserves unique row pairing, equal task weights, the 95% type-7 percentile interval, the 2-point practical threshold and adaptive-selection caveats. It cannot create model calls or load final-test data. An unchanged artifact compares the same baseline vector with itself, rather than reporting stochastic rescoring as an optimizer gain.

Predeclaration 9 was committed as `a5ebc90` before the failed admission check and before any search call. [Source transition 9](../source-transition-9.json) authenticates the corrected execution source against immutable contract 8a. It preserves archived evaluator identities while new search manifests would record actual execution hashes and declaration provenance. The original control bundles and source-transition-8a.json are unchanged.

## Real gate failure

The actual `load_panel` entrypoint failed in `load_admission`, before account-pool creation, gateway startup or model calls:

```text
ValueError: Frozen development cohorts or retrieval changed
```

The [preflight stop record](preflight-stop.json) preserves the command, source hashes, 147.50-second elapsed time and both retrieval receipts. A fresh HoVer index was built in this lane's ignored cache. It has the same pinned corpus archive and extracted corpus, dependency versions, document count, retrieval recipe and params file hash as the admitted index, but four exact index hashes differ:

| Index file | Admitted SHA-256 | Prepared SHA-256 |
| --- | --- | --- |
| data.csc.index.npy | `66574350c13aaab3e0573d8db5331852b185970de0c1fdf2b151e38a5059da2d` | `322c55b543c46e25dd3cc2eafc26da38754fad5c5d2f4c084244a4f7f38acad0` |
| indices.csc.index.npy | `ade1a43143a12df60712e44001de789f5e8df6629c3673f988810c49bc6770a1` | `917fec3b246a2e95894b2b3254d75fc65bc5111f7f8605593a206686f472116d` |
| indptr.csc.index.npy | `6ded75207cbfaf340339b1e8d9ddad0a1829975460df87a469e137fd672c19a5` | `ad667f887c23efd42c74162898d5c9c5d52a14520f0ca8411442af92d578907d` |
| vocab.index.json | `788eb76beab87d1c3511485f23759582bf98f5295d22d6865d7bf85b5b447bbc` | `7e00c9fd8f525a202a48fadf1ea165077107a27c0fc3730dd98b83a89a88d8b6` |

Exact receipt equality is an existing gate, not a new restriction. Semantic retrieval equivalence was not measured. No gate, receipt or index was modified to turn this failure into a pass. The gate was not rerun after failure, and no search was launched.

After preserving the failure, directory discovery found the previous lane's `hone-hone-pilot-harness-1/.pilot-cache/hover-retrieval/index-receipt.json`. Its metadata matches the admitted receipt. Its underlying index files were not rehashed or copied in this stopped run. Reusing and verifying that exact admitted artifact is the smaller next action; another fresh rebuild is not evidence of bit-identical retrieval. This discovery does not override the handback rule.

## Per-cell selection and accounting

Every cell is `not_started`. A dash means unavailable inference, not zero performance. Each phase entry is calls / charged tokens / dollar-equivalent; reported and estimated charges are separately zero. Search wall time, active time, polling time and pauses are unavailable because no cell began. The admission-check wall time above is setup time, not search time.

| Task | Method | Chosen / seed selection | Paired delta / 95% interval | Proposal | Training eval | Selection eval | Search wall / pauses | Refusals | Hidden attempts | Unknown-usage calls | Changed artifact retained |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| MBPP | Hone | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| MBPP | GEPA | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| MBPP | Plain | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | Hone | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | GEPA | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | Plain | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |

No model receipts, deployment calls or incomplete evaluation tails exist for these six cells. Hidden-attempt and missing-usage rates have no nonzero denominator. Synthetic test receipts are excluded from all pilot accounting.

## Per-method totals across both tasks

| Method | Completed / intended | Calls | Reported / estimated tokens | Reported / estimated dollar-equivalent | Proposal / training / selection dollar-equivalent | Refusals / hidden attempts | Equal-weight delta / interval | Interval excludes zero | Changed artifact retained |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| Hone | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | — / — | Not assessed | Not assessed |
| GEPA | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | — / — | Not assessed | Not assessed |
| Plain | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | — / — | Not assessed | Not assessed |

There is no evidence here that any method improves or fails to improve the seed. No point estimate can be compared with the 2-point practical threshold. The [machine-readable report](../results-9.json) keeps all absent cell inputs explicit and does not invent missing-cell inference or totals.

## Replay and handoff

Recompute the stopped-run report without data loaders, credentials or model calls:

```sh
nice -n 10 taskset -c 6 python3 -m pilot.results --runs evidence/pilot/seed0-9 --out .pilot-state/results-9-replay.json
```

Compare the result with `evidence/pilot/results-9.json`. The reporter hashes its own source. Verify the stop evidence bundle with:

```sh
python3 -m pilot verify --out evidence/pilot/seed0-9
```

Reproduce the corrected dispatch boundaries and bootstrap behavior with the offline regression tests:

```sh
nice -n 10 taskset -c 6 python3 -m unittest pilot.test_dispatch pilot.test_transition pilot.test_results pilot.test_runtime -v
```

No account pool was created, no model or route probe ran, no final-test labels were read, and no systemd pilot unit or live PID was started. The runtime and fresh cache remain ignored in this worktree for inspection. PR #37 must remain unmerged. Any new search run requires resumption after this gate-failure handback, with the admitted retrieval artifact verified before dispatch.
