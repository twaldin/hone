# Observed exit state before deadline classification

This successor fixes the two same-class findings on the [11d head](../runtime-rerun-11d/README.md), without changing predeclaration 11, metric policy, candidate allowance, caps or methods. Official GEPA remains untouched. Earlier bundles remain immutable.

## Corrected boundaries

The outer invocation resolves deadline termination and final exit status before closing its pipes. If a normal exit was already in progress but hidden from nonblocking `poll()`, its actual exit code and bounded queued frame survive. A genuinely live invocation killed by the outer deadline remains unscored infrastructure.

The inner supervisor no longer infers a trusted timeout from SIGKILL alone. At expiry it seizes and interrupts only its owned child using Linux ptrace, then observes stopped-versus-exited state. An interrupt stop establishes that the candidate is still alive; it is killed and receives the existing trusted own-overrun zero. An already-exiting child retains its real exit status and queued frame, including genuine SIGKILL infrastructure. Failure to establish a live stop never generates a timeout zero; final exit status and captured bytes determine the outcome. No new sandbox capability, configuration or candidate execution allowance is introduced. The retained frozen-image probe demonstrates that this owned-child operation is permitted.

Both readers retain genuinely nonblocking, byte-bounded drains. No EOF wait, grace interval or grader retry is added. Candidate exceptions and wrong output remain zero. Missing/malformed frames, genuine worker/container failure and no-verdict outer timeouts remain unscored. The bound negative/adversarial-probe exception and all ranking/noise rows remain unchanged.

## Reproduction and proof

`before.txt` records the consumer regressions failing before correction: four lost completed outer outcomes and a genuine SIGKILL incorrectly scored zero. `after-regression.txt` records four Docker regression tests passing afterward, including queued frames and the competing-reader boundary. The controlled fixtures delay exit publication or host observation, not candidate output; they do not estimate natural frequency.

`trace-probe.py` and `trace-probe-result.json` retain the successful owned-child seize/interrupt in the unchanged frozen sandbox, without model calls.

Run native verification with CPU 6, nice 10, one-thread settings, explicit NLTK_DATA, PILOT_DOCKER_TESTS=1 and PILOT_OFFICIAL_METRIC_TESTS=1:

```sh
pilot/.venv/bin/python -m unittest discover -s pilot -p 'test_*.py' -v
```

The standalone `smoke.py` retains thirteen real-container cases and receipts. `launch.py admit --unit NAME --out DIRECTORY` performs fresh zero-call admission with the frozen lane-local omp 18.16.0, OAuth-only route/pool and existing admitted HoVer index, without rebuilding. Passing admission, green CI and full exact-head cross-family READY must precede search.

## Authorized campaign

The active launcher and run driver preserve 11d behavior with only runtime-directory references changed. Infrastructure rerun 2 uses one fresh `.pilot-runs/pilot-seeds12-11-rerun2` root: seed 1 then 2, each MBPP then HoVer, each Hone, official GEPA, plain. Preserve per-cell caps, joined safety history, the 35,000-call hard cap and before-cell projection, and the 100 GB disk floor. Restart=no, CPU 6, nice 10, one-thread settings and NLTK_DATA remain required.

No per-row retry, partial-cell restart, third campaign, final-test labels, seeds beyond 2, global runtime/broker/config changes, home GUI, Deadlock or merge. Further same-class I/O findings are fixed without handback. GitHub communication failures back off at least 120 seconds and are never pilot failures. Policy questions, different defect classes and declared operational stops still require handback.

## Observed proof

All 344 native tests passed in 454.900 seconds, including the complete frozen MBPP ranking/noise replay and rows 640/847. All thirteen standalone real-container smoke cases passed with retained receipts.

Fresh admission unit `hone-predecl11e-admit-20261107T153745Z.service`, historical PID 2107520, passed in 450.954 seconds on implementation commit `9d41f2ef42bf86a6818d627c72b5e3f46063b698`. Actual affinity was CPU 6 and nice 10. Frozen omp 18.16.0, OAuth-only Gmail x2/Purdue x1 route/pool and existing admitted index matched. The original journal retains 1,808 pass and 2,650 wrong-answer outcomes, with zero infrastructure outcomes, model calls and gateway requests.

Original proof and journal bytes are retained. The admission unit exited and was collected; its terminal `not-found` defaults are not the success proof. `admission.json` records passed=true after all checks. No measured cell has started. Final exact-head CI and cross-family READY remain required.
