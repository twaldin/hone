# Nonblocking inner and outer worker I/O

This successor fixes the same-class findings on the [11c head](../runtime-rerun-11c/README.md) within the existing authorization. It changes no metric policy, candidate allowance, per-cell cap or method. Official GEPA is untouched. Earlier evidence is immutable.

## Corrected boundaries

- The inner result pipe is genuinely nonblocking. Readiness followed by a competing read can raise EAGAIN; the supervisor handles it without blocking deadline enforcement or exit draining. Both reads remain bounded by the existing wire limit plus overflow sentinel.
- At a deadline with no published exit yet, the supervisor kills the owned worker before waiting for its real exit record. A worker already exiting normally retains its frame/status instead of becoming a timeout zero. A live worker terminated by the deadline kill retains the trusted timeout outcome. No additional candidate execution time is granted.
- The outer invocation observes exit before declaring expiry, drains immediately available stdout/stderr within the existing combined bound, and does not wait for inherited writers to reach EOF. After EOF, an already-exited invocation keeps its real status even if the host reader resumed past the deadline. Outer descriptors are also nonblocking.

The existing bytes/None, invocation-result and receipt shapes remain unchanged. Genuine missing/malformed frames, worker/container failures and no-verdict outer timeouts stay unscored infrastructure. Candidate exceptions, wrong output and trusted own-overrun verdicts retain zero scores. The intentional negative/adversarial exception and all ranking/noise requirements remain unchanged.

## Regressions

`before.txt` records two failures and six errors before these fixes. `after-regression.txt` records the three Docker tests passing afterward:

1. Actual completed Docker invocations retain pass and TypeError-zero scores and validated receipts when host expiry is observed before reading or after both EOFs.
2. A real pipe reader reopened through the inherited writer consumes data between readiness and read. The live deadline and dead-worker drain still complete without blocking.
3. Valid queued pass/error frames survive expiry, including a controlled delayed-publication observation where the nonblocking exit probe has not reported completion yet.

The clock/exit-publication fixtures control scheduling order, not model output or grader source. They are deterministic boundary reproductions, not claims about natural occurrence frequency. No model calls are made.

## Native proof and launch

From the repository root:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 PILOT_CI_CPU=6 PILOT_DOCKER_TESTS=1 PILOT_OFFICIAL_METRIC_TESTS=1 NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python -m unittest discover -s pilot -p 'test_*.py' -v
smoke_out=$(mktemp -d)
nice -n 10 taskset -c 6 env PYTHONPATH="$PWD" pilot/.venv/bin/python evidence/pilot/runtime-rerun-11d/smoke.py --out "$smoke_out/result"
```

The active launcher, admission and run driver preserve 11c behavior with only runtime-directory references changed. The test caller points to this active driver. Fresh zero-call admission must bind current source pins, the frozen lane-local omp 18.16.0 runtime, OAuth-only Gmail x2/Purdue x1 route/pool and existing admitted HoVer index without rebuilding. It uses Restart=no, actual CPU 6, nice 10, one-thread settings and NLTK_DATA. The unchanged `../runtime-rerun-11a/wait-unit.py` waits for an owned unit without polling; admission passed=true is the success proof, not transient-unit collection defaults.

Only after green CI and full exact-head cross-family READY may `.pilot-state/launch-11.json` admit the measured unit. Infrastructure rerun 2 uses a fresh `.pilot-runs/pilot-seeds12-11-rerun2` root. Order is seed 1 then 2; each MBPP then HoVer; each Hone, official GEPA, plain. Preserve original per-cell caps and joined safety history. Enforce the 35,000-call hard cap and before-cell completion projection, plus the 100 GB free-disk floor. No per-row retry, partial-cell restart, third campaign, final-test labels, seeds beyond 2, global runtime/broker/config changes, home GUI, Deadlock or merge.

Further worker-I/O exit/deadline findings are corrected within this authorization. GitHub timeouts back off at least 120 seconds and never count as pilot failures. Only a policy question or different defect class requires review handback; declared operational safety stops remain binding.
