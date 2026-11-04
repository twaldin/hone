# MBPP final-verifier reference audit

This audit measures how the final pilot verifier scores the official MBPP reference implementations on all development rows. It does not measure optimizer quality or a mathematical ceiling on valid solutions.

## Result

The single full audit took 248.29510742099956 seconds. It loaded no final-test data and made zero model calls.

| Split | Rows | Gradeable | Reference passes | Reference failures |
| --- | ---: | ---: | ---: | ---: |
| Train | 374 | 374 | 364 | 10 |
| Validation | 90 | 90 | 88 | 2 |
| Total | 464 | 464 | 452 | 12 |

The reference pass rate is 452/464, or approximately 97.414%. All 464 rows are gradeable. Gradeability means that the trusted planner can express the official assertions, not that the reference worker passes them.

The audited `tasks.py` and `__main__.py` bytes match commit `c8b55d2042d07104aedeca54dba7e715df83f57c`. Later loader changes affect IFBench only; retained-admission checks establish unchanged MBPP execution. The report identifies the audit module and all consumed source bytes by hash.

The single failing reference in MBPP's 20-row control cohort is `mbpp:train:959`. Its float/int mismatch explains the known-improved reference score of 0.95. The admitted contrast remains 0.25 against a noise envelope of 0.086535.

Exact failing IDs:

- `mbpp:train:653`
- `mbpp:train:814`
- `mbpp:train:835`
- `mbpp:train:848`
- `mbpp:train:851`
- `mbpp:train:902`
- `mbpp:train:931`
- `mbpp:train:935`
- `mbpp:train:957`
- `mbpp:train:959`
- `mbpp:validation:511`
- `mbpp:validation:518`

Ten failed references return a builtin `float` where at least one assertion expects a builtin `int`. Their numeric values match, but the final verifier requires exact types. For example, `rombus_area(10,20)` returns `100.0`, while its assertion expects `100`. The canonical values are `["float", "0x1.9000000000000p+6"]` and `["int", "0x64"]`.

The references for `mbpp:train:653` and `mbpp:train:902` score zero. Their isolated diagnostic workers exit with status 1. The audit does not infer their exception or cause from the exit code. Worker stdout and stderr are private under the existing verifier protocol.

The 452/464 rate is not a mathematical ceiling. Alternative valid solutions can return the exact expected builtin types and values. This audit neither changes the grader nor concludes that the twelve rows are unsolvable.

## Replay

Run from the repository root with the pilot environment and the pinned verifier Docker image available:

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot.reference_audit --out evidence/pilot/reference-audit-6
```

The command rewrites `report.json`. Use another `--out` directory to retain this captured report unchanged. The existing `execution_limits` helper rejects execution without inherited CPU 6 affinity and nice priority of at least 10. The audit also requires the four documented thread limits to equal 1. It runs only one verifier worker at a time.

## Evidence contract

[report.json](report.json) contains every row's gradeability, reference score, reference pass flag, row hash, reference hash, setup hash, assertion hash, and trusted-plan hash. It includes split totals, exact failing IDs, elapsed time, source-file hashes, pinned dataset receipts, and the task manifest.

The audit uses `pilot.tasks.load_task("mbpp", ...)` to load the pinned 374-row train split and 90-row validation split. It sends each official reference through `pilot.tasks.score_output`, including the unchanged extraction and final-verifier boundary. The trusted plans come from `pilot.verification.prepare_plan`.

Only failed rows receive a second isolated worker invocation for diagnostics. Diagnostic results never replace scores. Diagnostic comparisons use the existing verifier's validated canonical tagged plain data, not candidate-defined equality or representation methods. Each canonical value retains its exact type tag. The report records every observed assertion mismatch and distinguishes worker failures from type or value mismatches.

No controls, extractors, verifier code, task-loader code, or admission evidence was edited. No tests, builds, linters, formatters, model commands, or broker commands were run for this audit.
