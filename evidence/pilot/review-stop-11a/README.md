# Amended predeclaration 11: substantive review stop

**Do not launch.** Review of implementation head `f3b00bbedf9f0b3045a30c5f362731945abbc310` found a genuine worker death converted into a scored candidate timeout. The finding was reproduced in the unchanged pinned Docker scorer. No measured predeclaration-11 model call or cell started; infrastructure rerun #2 has not launched. No live unit or PID remains.

## Proven failure

| Offline case | Expected | Observed | Elapsed |
|---|---|---|---:|
| Worker calls `os._exit(7)` | infrastructure, unscored | `nonzero_exit`, null | 0.747084 s |
| Same exit after a forked descendant calls `setsid()` and retains the result pipe | infrastructure, unscored | `wrong_answer`, 0.0 | 10.348240 s |

The second program waits for the descendant's acknowledgement after `setsid()` before exiting 7. The descendant sleeps 30 seconds, retaining its inherited worker-result descriptor. `pilot/verification.py:424-439` observes the original worker's exit, but continues waiting for EOF. Killing the original process group does not reach the escaped session. At the ten-second deadline `_supervise` returns `None`; lines 454-459 reap the original exit status and then discard it in favor of a successful candidate-timeout frame. This violates the explicit rule that worker death without a trusted result is unscored infrastructure, not wrong answer 0.

`result.json` retains both observed results, exact programs, timing and validated receipts. `grader-outcomes.jsonl` retains the raw journal. `probe-original.py` is the exact executed driver; `probe.py` changes only its output destination to a required `--out` argument for replay. No grader, engine, metric, retry, cap or method code changed after the finding.

## Replay without model calls

From the repository root, using the pinned cached image:

```sh
proof_out=$(mktemp -d)
nice -n 10 taskset -c 6 env PYTHONPATH="$PWD" OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 pilot/.venv/bin/python evidence/pilot/review-stop-11a/probe.py --out "$proof_out/result"
```

The probe asserts that the current bug reproduces. A future corrected scorer should make that final assertion fail; the retained files must not be rewritten.

## Gates and recommendation

The earlier amendment, three red regressions, 339-test native suite, nine-case real-container smoke and actual zero-call resource/runtime admission all completed. Their immutable proof remains in `../runtime-rerun-11a/`; the admission passed on real CPU6/nice10 with frozen omp18.16.0, OAuth pool/route and existing HoVer index. Those successes do not cover this newly discovered boundary.

The OpenAI trust review is **NOT_READY**. The Opus review passed only the launch/admission/resource/budget scope and explicitly did not audit trusted-result isolation; it is not an overall READY. `reviews.json` records both scopes. After transient API DNS/connection failures, workflow [42373871068](https://github.com/twaldin/hone/actions/runs/42373871068) was confirmed successful on exact reviewed head `f3b00bbedf9f0b3045a30c5f362731945abbc310`; `ci.json` records it. Green CI does not override the reproduced classification defect.

Recommendation: authorize the narrow worker-supervision correction that preserves an already-observed exit/no-frame result through pipe draining and cleanup. Add this escaped-descendant regression, refresh source pins and actual zero-call admission, then obtain green CI and full exact-head cross-family READY before any search. Do not weaken the infrastructure rule, retry a row, or start the benchmark to work around this defect.
