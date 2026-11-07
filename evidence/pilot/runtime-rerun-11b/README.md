# Worker-exit preservation under predeclaration 11

This runtime implements the authorized narrow correction to the [review stop](../review-stop-11a/README.md). Predeclaration 11 and its committed amendment remain unchanged. The candidate allowance, metric, method code, caps, admission controls and infrastructure retry policy do not change. Official GEPA is untouched.

`_supervise` checks for worker exit before handling its deadline. Its existing result is captured bytes, including an empty frame, for an exited worker. `None` means only a still-live candidate overrun. The caller retains the worker's real exit status and applies the existing frame validation. An escaped descendant can delay pipe EOF but cannot replace a dead worker's outcome with a timeout zero. Pipe draining remains bounded by the existing deadline.

## Verification

`before.txt` records the new real-Docker regression failing before the correction. Its four cases distinguish nonzero exit, clean exit without a frame, a trusted pass and a trusted candidate exception while an escaped descendant retains the result pipe. The admission must also retain the frozen MBPP control and noise results, including rows 640 and 847.

Run the native suite and standalone smoke from the repository root:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 PILOT_CI_CPU=6 PILOT_DOCKER_TESTS=1 PILOT_OFFICIAL_METRIC_TESTS=1 NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python -m unittest discover -s pilot -p 'test_*.py' -v
smoke_out=$(mktemp -d)
nice -n 10 taskset -c 6 env PYTHONPATH="$PWD" pilot/.venv/bin/python evidence/pilot/runtime-rerun-11b/smoke.py --out "$smoke_out/result"
```

The standalone smoke exercises the normal nine cases and all four escaped-descendant outcomes with retained receipts. No model calls are made.

## Admission and search

The earlier `runtime-rerun-11a` proof stays immutable. This successor uses the same launcher, admission and measured driver, with only their active runtime-directory references updated. The ignored `.pilot-state/launch-11.json` must bind this fresh admission and the final exact head's green CI and full cross-family READY before any measured call.

The launcher applies `Restart=no`, explicit CPU6 affinity, nice10, one-thread settings, `NLTK_DATA` and lane-local omp18.16.0. Admission checks the frozen OAuth-only Gmail x2 plus Purdue x1 route and existing admitted HoVer index without rebuilding. Wait for an owned unit using the unchanged `../runtime-rerun-11a/wait-unit.py` helper.

Infrastructure rerun2 uses a fresh `.pilot-runs/pilot-seeds12-11-rerun2` root. Order is seed1 then seed2; each MBPP then HoVer; each Hone, official GEPA, plain. The 35,000-call hard cap and before-cell projection, 100GB free-disk floor, original per-cell caps and joined safety history remain enforced. No per-row retry, partial-cell restart, third campaign, final-test evaluation, seed beyond2 or merge is authorized. GitHub API failures are launch-gate communication failures, never pilot failures; retries wait at least two minutes.

## Observed proof

The native suite passed all 340 tests in 633.873 seconds. The thirteen-case standalone Docker smoke passed, including both unscored escaped-worker exits and the trusted pass and TypeError-zero results. `full-suite.txt`, `smoke-result.json` and `smoke-grader-outcomes.jsonl` retain the observations.

Fresh unit `hone-predecl11b-admit-20261107T133114Z.service`, historical PID 1062246, passed in 442.631 seconds on implementation commit `9a0d6e5c4cf4934a92c8749863a70f49632d9ac2`. Its observed CPU affinity was 6 and nice 10. Frozen omp 18.16.0, the OAuth-only pool and route, all existing HoVer index hashes and the original ranking/noise admission matched. The original journal contains 1,808 pass and 2,650 wrong-answer outcomes. Model calls and gateway requests were zero.

`admission.json` and `admission-grader-outcomes.jsonl` preserve the original bytes. The transient unit exited and was collected; its terminal `not-found` status is not the success proof. The admission's `passed=true` is written only after every check succeeds. No measured cell has started. CI and full exact-head cross-family READY remain required.
