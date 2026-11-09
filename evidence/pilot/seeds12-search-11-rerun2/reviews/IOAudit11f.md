What this change does: It preserves real worker exits and queued results while recognizing any observed live ptrace stop as a candidate timeout. It also restores the missing native-suite transcript.

- Resolved model: `openai-codex/gpt-6-astra`.
- Exact SHA: `0ce2bab10f629c31eb95b32823edd0cb0053ae42`.
- **Scoped verdict: READY. Not full release clearance.**

No must-fix findings remain within this audit.

### Checked

- **Live stops and terminal exits:** `pilot/verification.py:429-439` accepts any `CLD_TRAPPED` stop, preserves terminal exit/death records, and never infers a trusted timeout merely from SIGKILL. Pending benign or fatal signals can produce a live signal-delivery stop before delivery; SIGKILL does not produce that stop. This matches [Linux ptrace semantics](https://man7.org/linux/man-pages/man2/ptrace.2.html). No exit-tracing option is enabled.

- **Exit/deadline draining:** `pilot/verification.py:442-471,532-585` retains bounded nonblocking reads and completed-exit handling without waiting for pipe EOF. Escaped writers and competing inner readers remain covered. Consumer regressions preserve delayed normal outcomes and genuine SIGKILL as unscored infrastructure (`pilot/test_verification.py:634-768,798-856`).

- **Actual SIGWINCH regression:** The fixture checks a real native `CLD_TRAPPED/SIGWINCH` record, then asserts score zero and a validated completed/exit-0 receipt (`pilot/test_verification.py:770-796`). Retained evidence shows the expected failure before correction and success afterward (`runtime-rerun-11f/before.txt:1-22`, `after-regression.txt:1-6`). Removing the unrelated stderr assertion did not remove those checks.

- **Native evidence:** The current transcript records all 345 tests passing, including Docker boundary regressions (`runtime-rerun-11f/full-suite.txt:667-673,710-713`). Direct byte/hash inspection matched:
  - Current suite: **112,525 bytes**, SHA-256 `5e0fa1a06f2ec3c24d11b25fd0cd8abdf4d4ed3460b74e9d4ba4580ac86f8916`.
  - Recovered 11e suite: **112,354 bytes**, SHA-256 `bf4c1fbcef024ca5724cfe6610580946a65b236094429dadd3f9a2294a745371`, identical to the original `artifact://727`.

- **Consumer receipts:** All thirteen retained smoke outcomes agree with their summary, receipt hashes, current source hash and invocation-script hashes. Scored outcomes have completed/exit-0 invocations. Worker exits and missing frames remain unscored. The reviewed `verification.py` and `program.py` match admission pins.

The earlier authorized worker-I/O finding and evidence-retention finding are resolved. I found no remaining same-class finding, new policy question or different defect.

Principle applied: **Prove It Works**. I inspected original transcript bytes and consumer receipts rather than relying on README claims.

**Verdict: Ship within this scope.** No tests, containers, builds, linters or formatters were executed. Full release approval and CI clearance remain outside this audit.