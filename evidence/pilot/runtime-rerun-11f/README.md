# Live ptrace stops retain the candidate timeout outcome

This successor fixes the same-class review finding on the [11e head](../runtime-rerun-11e/README.md). It changes no metric policy, candidate allowance, cap or method. Official GEPA and the approved negative/adversarial-probe exception remain unchanged. Earlier bundles remain immutable.

## Correction and regression

An options-free ptrace seize followed by interrupt can first report a pending signal-delivery stop, not just PTRACE_EVENT_STOP. Any observed CLD_TRAPPED stop establishes a live candidate at expiry. The supervisor kills it and returns the existing trusted own-overrun zero. Genuine terminal exit/death still preserves its real status and queued frame; no live stop is inferred from SIGKILL alone.

The actual Docker consumer regression establishes a real SIGWINCH delivery stop after seize, checks its native wait record, then requests interrupt. Before correction it raises unscored nonzero-exit infrastructure (`before.txt`); afterward it returns wrong-answer 0 with a validated completed/exit-0 receipt (`after-regression.txt`). No model calls or timing grace are introduced. `first-after-fixture-error.txt` retains an intermediate test assertion error: the score was already correct, but the fixture wrongly expected stderr redirected away by the protected worker. That incidental assertion was removed; the native stop assertion and consumer receipt checks remain.

Inner and outer reads remain genuinely nonblocking and byte-bounded. Completed outer exit publication, queued frames, genuine delayed SIGKILL, escaped writers and competing readers retain the earlier corrections. No EOF wait or grader retry is added. Candidate exceptions and wrong output remain zero; genuine worker/container failures and missing/malformed frames remain unscored infrastructure.

## Recovered 11e native-suite transcript

11e's immutable `full-suite.txt` contains a tool read error, not the suite output. The original 344-test run did pass in 454.900 seconds. Its exact 112,354 bytes are recovered as `recovered-11e-full-suite.txt`, authenticated against the original artifact's SHA-256 `bf4c1fbcef024ca5724cfe6610580946a65b236094429dadd3f9a2294a745371`. Bounded raw reads stripped range-final newlines; restoring those terminators yields the exact original hash. No tests were rerun merely to recover this evidence. `recovered-11e-suite.json` records the source and digest. The read behavior was reported to the tool maintainers.

## Verification and launch

Run the full native suite with CPU 6, nice 10, one-thread settings, explicit NLTK_DATA, PILOT_DOCKER_TESTS=1 and PILOT_OFFICIAL_METRIC_TESTS=1. `smoke.py` exercises thirteen real frozen-container cases with receipts. Fresh `launch.py admit --unit NAME --out DIRECTORY` uses Restart=no, actual CPU 6/nice 10, frozen lane-local omp 18.16.0, OAuth-only Gmail x2/Purdue x1 and the existing admitted HoVer index without rebuilding.

Green CI, fresh zero-call admission and full exact-head cross-family READY precede search. Active scripts differ from 11e only in runtime-directory references. Infrastructure rerun 2 uses one fresh `.pilot-runs/pilot-seeds12-11-rerun2` root: seed 1 then 2, each MBPP then HoVer, each Hone, official GEPA, plain. Preserve per-cell caps and joined safety history, the 35,000-call hard cap and before-cell completion projection, and the 100 GB disk floor.

No per-row retry, partial-cell restart, third campaign, final-test labels, seeds beyond 2, global runtime/broker/config changes, home GUI, Deadlock or merge. Further same-class I/O findings are fixed without handback. GitHub timeouts back off at least 120 seconds and are never pilot failures. Policy questions, different defect classes and declared operational stops still require handback.

## Observed proof

All 345 native tests passed in 355.255 seconds, including every Docker boundary regression and the complete frozen MBPP ranking/noise replay with rows 640/847. The new suite transcript was captured directly, without an artifact read round-trip: 112,525 bytes, SHA-256 `5e0fa1a06f2ec3c24d11b25fd0cd8abdf4d4ed3460b74e9d4ba4580ac86f8916`. All thirteen standalone frozen-container smoke cases passed with retained receipts.

Fresh admission unit `hone-predecl11f-admit-20261107T161822Z.service`, historical PID 2447485, passed in 505.407 seconds on implementation commit `122c98dc7eb30e9f5fdbe90f932a503af9093ade`. Actual CPU affinity was 6 and nice 10. Frozen omp 18.16.0, OAuth-only route/pool and existing admitted HoVer index matched. Its original journal retains 1,808 pass and 2,650 wrong-answer outcomes, with zero infrastructure outcomes, model calls and gateway requests.

Original admission and journal bytes are retained. The unit exited and was collected; terminal `not-found` defaults are not the success proof. `admission.json` records passed=true after all checks. No measured cell has started. Final exact-head CI and full cross-family READY remain required.
