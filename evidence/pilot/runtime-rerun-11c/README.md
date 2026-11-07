# Bounded worker-exit drain under predeclaration 11

This runtime completes the authorized correction to the [queued-frame review stop](../review-stop-11b/README.md). On observed worker exit, the supervisor drains immediately readable bytes without waiting for EOF, retaining at most the existing wire limit plus its overflow sentinel. It then preserves the real exit status and validates the captured frame. An escaped descendant cannot force an EOF wait or an unbounded drain. A still-live candidate gets no additional execution time.

The existing bytes-or-None result remains unchanged. Bytes represent an exited worker's captured frame, including an empty or malformed frame for infrastructure validation. None represents only a live candidate overrun. The obsolete persistent exited flag is removed; the operating system's exit observation determines the branch.

Predeclaration 11 and its committed amendment remain unchanged. Candidate exceptions, wrong output and trusted own-timeout verdicts score zero. Genuine worker death, missing or malformed frame, container failure and outer timeout without a trusted verdict remain unscored infrastructure. The intentional negative/adversarial exception, ranking/noise requirements, method code and per-cell caps do not change. Official GEPA is untouched. Same-class worker I/O findings at exit or deadline are fixed within this authorization; a policy question or a different defect class requires handback.

## Verification commands

Run from the repository root:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 PILOT_CI_CPU=6 PILOT_DOCKER_TESTS=1 PILOT_OFFICIAL_METRIC_TESTS=1 NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python -m unittest discover -s pilot -p 'test_*.py' -v
smoke_out=$(mktemp -d)
nice -n 10 taskset -c 6 env PYTHONPATH="$PWD" pilot/.venv/bin/python evidence/pilot/runtime-rerun-11c/smoke.py --out "$smoke_out/result"
```

`before.txt` retains both valid queued-frame cases failing before the drain. `after-regression.txt` retains the queued-frame and earlier escaped-worker regressions passing afterward. The queued-frame Docker fixture completes a worker before its deadline and delays supervisor invocation until afterward, then asserts the original pass or error frame decodes correctly. It changes no grader source or model output. The full native suite also exercises frozen MBPP rows 640 and 847 and retained ranking/noise admission.

## Admission and measured run

The three active scripts preserve the previous launcher, admission and driver, changing only runtime-directory references. Earlier evidence remains immutable. Fresh admission must bind the current source pins, lane-local omp 18.16.0, frozen OAuth-only Gmail x2/Purdue x1 pool and route, and the existing admitted HoVer index without rebuilding.

Use `launch.py admit --unit UNIQUE_NAME --out FRESH_DIRECTORY`, then the unchanged `../runtime-rerun-11a/wait-unit.py` to wait for that owned unit without polling. The launch applies Restart=no, actual CPU6 affinity, nice10, one-thread settings and explicit NLTK_DATA. The admission's passed=true, not defaults returned after transient-unit collection, is the success proof.

After green CI and full exact-head cross-family READY, `.pilot-state/launch-11.json` binds this admission and final head. `launch.py run --unit UNIQUE_NAME` executes a fresh `.pilot-runs/pilot-seeds12-11-rerun2` matrix: seed1 then2, each MBPP then HoVer, each Hone, official GEPA, plain. The original safety history and caps stay joined; no per-row retry, partial-cell restart or third campaign is allowed. Enforce 35000 logical calls and before-cell completion projection, and at least100GB free disk. Final-test evaluation, seeds beyond2, global runtime/broker/config changes, home GUI, Deadlock and merge remain forbidden.

GitHub communication timeouts use at least120-second exponential backoff and never enter pilot failure history. They cannot bypass the before-search gates.
