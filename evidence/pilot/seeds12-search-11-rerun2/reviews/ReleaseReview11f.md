**READY: full release approval for exact head `0ce2bab10f629c31eb95b32823edd0cb0053ae42`.** This covers the whole PR, not just one area. No must-fix finding remains. I found one should-fix and one nice-to-have, both about retained evidence; neither blocks the first measured call.

- **Resolved model:** `anthropic/claude-opus-5-5`. The author is `openai-codex/gpt-6.1-sol`, so this is a cross-family review.
- **Mode:** read-only. I ran no tests, builds, linters or containers, made no edits and posted nothing. I only read hashes, files, transcripts and GitHub status.
- **CI:** "Pilot unittest and Docker" finished with success on `0ce2bab`, from 16:31:13Z to 16:39:03Z. That job runs the Docker tests. The first GitHub read failed with a connection error; the retry worked.
- **No measured cell has started:** `.pilot-runs/pilot-seeds12-11-rerun2` does not exist, and `.pilot-state/launch-11.json` has not been written yet.

**What this change does:** It is the 11f follow-up to the 11e review. At the 10-second deadline, the trusted supervisor now treats any observed ptrace stop as proof that the candidate is still running, including a stop for a pending harmless signal. A ptrace stop is a pause the kernel reports to the watching parent process. That case now gets the candidate's own timeout score of 0 instead of an unscored infrastructure result (`pilot/verification.py:429-439`). The head also moves the active scripts to `runtime-rerun-11f`, refreshes the source pins and keeps a recovered copy of the 11e test log, a new full test log, smoke results and a fresh zero-call admission.

## Checks you asked for

**Current `full-suite.txt` is real output.**
- It is 112,525 bytes with SHA-256 `5e0fa1a0…8916`.
- The main transcript (lines 4136-4140) shows how it was made. A `subprocess.run` call with `nice -n 10 taskset -c 6` ran from 16:11:51 to 16:17:46 on `122c98d`. Its settings included `PILOT_DOCKER_TESTS=1`, `PILOT_OFFICIAL_METRIC_TESTS=1`, one-thread limits and `NLTK_DATA`.
- The output was written straight to the file, and the code asserted the file hash equals the output hash. The return code was 0.
- `pilot/` did not change between `122c98d` and `0ce2bab`.
- The test list is exactly the 344 tests from 11e plus `test_live_signal_delivery_stop_retains_trusted_timeout_zero`. There are no skips, failures or errors.

**The recovered 11e log is the original.**
- `recovered-11e-full-suite.txt` is byte-identical (`cmp`) to the session file `727.bash.log`. Both are 112,354 bytes with SHA-256 `bf4c1fbc…a745371`.
- That log is the output of background job `bg_18`. It started at 15:29:20 on `9d41f2e` with the full Docker settings and ended with `Ran 344 tests in 454.900s / OK`.

**Other proof bytes are the originals.**
- `admission.json` and the 9 MB admission outcome log (journal) are byte-identical to the unit output in `.pilot-state/hone-predecl11f-admit-20261107T161822Z/`.
- The admission log has 1,808 pass and 2,650 wrong-answer outcomes, with no infrastructure outcomes.
- Every receipt carries the current `verification.py`+`program.py` source hash (`3c8fa445…`).
- MBPP rows 640 and 847 admit, with passes and trusted TypeError/KeyError zeros.
- The smoke files match the scratch output. Their 13 outcomes include candidate-timeout 0, and worker-exit and missing-frame results stay unscored.
- The admission unit ran from 16:18:22 to 16:26:48 (505 s). The launch receipt shows CPU 6, nice 10 and `Restart=no`. It made 0 model calls and 0 gateway requests.

**The live-stop fix works.** `before.txt` shows the old code turning a real SIGWINCH pause into unscored `nonzero_exit`. `after-regression.txt` shows wrong-answer 0 with a valid exit-0 receipt. The new rule only reclassifies a candidate seen alive after its deadline. A genuine SIGKILL or exit, a failed ptrace attach, or an exit already under way still keeps its real status and stays unscored. I found no other worker I/O problem at the exit or deadline boundary; the parallel IOAudit11f also returned READY for its scope.

## Earlier review findings, all addressed

| Review | Finding | Status at this head |
|---|---|---|
| 11c release | A worker still shutting down at the deadline got "timeout, 0" | Fixed: the supervisor seizes and interrupts with ptrace and keeps the real exit (`verification.py:429-462`) |
| 11c release / 11c worker | The outer invocation lost finished results at its deadline | Fixed: `expire()` kills then waits, and a normal exit keeps its status and output (`:532-585`) |
| 11c worker | "Nonblocking" reads could still block | Fixed: `set_blocking(False)` and `BlockingIOError` handled in all reads (`:443,455-469,546-565`) |
| 11d I/O and release | An exit not yet visible to `poll()` became a timeout; a delayed SIGKILL became a 0 | Fixed and covered by Docker regressions (`test_verification.py:696-768`) |
| 11e I/O and release | Only one ptrace stop type was accepted; the 11e suite file held a tool error | Fixed (`:433`); the 11e log is recovered and authenticated |

## The rest of the PR, checked independently

- **Source pins:**
  - All 21 execution-source hashes and the 8 HoVer index hashes match the files at `0ce2bab`, and so do the outcome-log and transition hashes.
  - Every "after" hash in `source-transition-11.json` matches HEAD, and every "before" hash matches `b453995`.
  - `TRANSITION_11_VERIFICATION_HASH` equals the current `verification.py`.
  - The 11f bundle hash and all its file hashes check out, with no unlisted files. The 11d, 11e and review-stop-11b bundles also check out.
- **Selection cache and GEPA:**
  - Hone and plain score each distinct artifact once per cell through `selection_vectors` (`search.py:177-185`). A gate-passing Hone child is scored first (`:254-256`).
  - `_gepa` is untouched, and `search.py` equals the rerun-10 pin `8bf99067…`.
- **Candidate failures versus infrastructure:**
  - A trusted failure frame is a wrong answer (`verification.py:715-735,761-764`).
  - Worker exits, missing or malformed frames and outer timeouts raise infrastructure.
  - Negative-probe infrastructure is accepted only with a receipt tied to its stage, row, input and image (`controls.py:88-108`).
- **Campaign rules:**
  - `MATRIX` runs seed 1 then 2, MBPP then HoVer, each Hone, official GEPA, plain.
  - The forecasts sum to 33,438 calls. The projection is checked before each cell and only ever increases (`campaign.py:49-61,77-79`). The 35,000-call cap is checked before every gateway attempt (`:67`, `runtime.py:517`).
  - The 100 GB disk floor is checked at launch, before each cell, before each model call and before each grading run.
- **History and restarts:**
  - Safety history joins 7 historical rows plus the ENOSPC row, with pause time included (`run.py:18-34,52`).
  - Nothing can restart: an existing run root or launch receipt is refused, `Restart=no` is checked, and pins plus exact-head gates are re-checked before each cell.
- **Predeclarations:** predeclaration 11 was committed at 08:04 and amended at 11:40 on Nov 7. The last run file was written Nov 6 at 22:37, so no search call happened after the declaration.

## Should fix (not blocking)

1. **One kept review copy is cut short** (`evidence/pilot/runtime-rerun-11e/review-11d-release.txt:12,56`)
   - **What this is:** The 11e bundle keeps a copy of the 11d release review.
   - **Problem:** It is 7,771 bytes, but the original `ReleaseReview11d.md` is 8,005 bytes. Line 12 stops at "trips `consecutive-infra…`" and a tool note was added at line 56. The lost text includes the reviewer's statement that the finding came from reading code, not from seeing it happen. This is the same tool-read problem as the 11e suite file. The finding and its fix are still readable, and the 11e README makes no claim that this copy is complete.
   - **Fix:** Keep the exact 8,005 original bytes in the next evidence bundle with their SHA-256, as was done for the 11e log. It can go into the run/report evidence; no new head is needed before launch.
   - **If we skip it:** One earlier review is incomplete in the repo.
   - **Class:** keeping evidence. It is not worker I/O, not a policy question and does not affect measurement.

## Nice to have

2. **The README undercounts what the test lost** (`evidence/pilot/runtime-rerun-11f/README.md:9`; `pilot/test_verification.py:770-796`)
   - **What this is:** The README says one "incidental" assertion was dropped from the new regression test.
   - **Problem:** Two were dropped: the stderr check and `assertIn("exceeded", receipt["reason"])` (transcript edit at line 4114). Also, `before.txt` ran an earlier version of the test with an extra write to stderr, which the worker sends to `/dev/null`, so the failure it shows still holds. Coverage is the same in practice, because an endless loop can only reach a wrong answer through the timeout frame.
   - **Fix:** Put the `"exceeded"` reason check back and say both assertions were removed. Do this at the next code change.
   - **If we skip it:** The test proves "zero" but does not name the timeout reason.

Verdict: Ship. Optionally fix 1 when the run/report evidence is committed.

Not checked: real Docker timing and how often signals arrive at the deadline. The kernel behavior rests on kernel source and the Docker regression, not on my own runs.