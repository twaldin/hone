# Queued completed verdict: review stop

Do not launch. Review of `7040004e6c51b1960cc83750320424731fb3f20a` found that an exited worker's valid result can remain unread when the supervisor handles an expired deadline. The Docker fixture reproduced this with the unchanged supervisor functions. No measured predeclaration 11 call or cell started, and no live pilot unit or PID remains.

## Proven boundary failure

The original escaped-descendant exit-status defect is corrected. The four new Docker regression cases, all 340 native tests, thirteen standalone smoke cases and fresh zero-call admission passed. Their immutable evidence remains in `../runtime-rerun-11b/`.

The remaining premise was that an exited worker's captured bytes already contain its result. `probe.py` tests that premise directly:

1. Extract the current `_kill` and `_supervise` definitions without changing them.
2. Execute them in the same pinned Docker sandbox. A worker forks a descendant into a separate session and writes a complete valid frame before exiting 0.
3. Observe the worker exit before the fixture's deadline. Delay only supervisor invocation until after that deadline, simulating supervisor scheduling delay.
4. Observe the pipe is readable, then call the unchanged `_supervise`.
5. Observe it returns empty bytes while the complete valid frame remains queued. Decode both captures with the actual unchanged `_frame` decoder.

Both the pass frame and the trusted candidate-TypeError frame reproduce this ordering. The captured bytes are empty and rejected; the queued bytes remain complete and decode successfully. `result.json` retains both observations, and `fixture.py` retains the actual executed Docker script. The function-source SHA-256 is `8099b83ac87c6283f6d5c27435d1a1e6c4491310324645fd3fa9ea5e87018b8d`.

This is a controlled function-boundary reproduction, not a new model evaluation or an observed campaign abort. Natural occurrence frequency is unknown. The downstream infrastructure result is traced through the unchanged caller: `verification.py:432-433` returns before draining readable data; lines 454-459 forward the empty capture with exit 0; lines 665-684 reject the missing frame as infrastructure. A valid completed verdict can therefore be lost.

## Replay offline

From the repository root:

```sh
proof_out=$(mktemp -d)
nice -n 10 taskset -c 6 env PYTHONPATH="$PWD" OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1 pilot/.venv/bin/python evidence/pilot/review-stop-11b/probe.py --out "$proof_out/result"
```

The probe asserts the present bug. A corrected supervisor should make that assertion fail. Retained evidence must not be rewritten. No grader or engine source changed after this review finding, and the probe makes zero model calls.

## Recommendation

Drain bytes immediately available after observing worker exit, bounded by the existing wire limit and without waiting for EOF. Then preserve the worker's actual status and validate the complete captured frame. A live candidate gets no extra execution time. Add a deterministic queued-frame deadline regression, refresh source pins and zero-call admission, and obtain green CI and full exact-head cross-family READY before search. This completes the existing ruling rather than introducing another metric policy.

The substantive review stop is active. Infrastructure campaign rerun 2 has not launched; the 35,000-call cap and 100 GB disk floor are unchanged. GitHub communication retries waited at least 120 seconds and were not recorded as pilot failures.

## Review disposition

Exact-head CI passed in [run 42378473693](https://github.com/twaldin/hone/actions/runs/42378473693). The OpenAI audit returned NOT_READY for the queued-frame case. The full Opus review returned READY but also identified that edge as a nonblocking, inferred-rare event. The owner does not accept that severity judgment after the deterministic reproduction: completed-frame loss violates the requested outcome preservation, and rerun 2 has no spare campaign retry. Natural occurrence frequency is unknown. `reviews.json` retains both opinions without claiming that either reviewer changed its verdict. Aggregate launch clearance remains blocked.
