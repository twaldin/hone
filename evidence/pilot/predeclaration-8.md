# Pilot refusal contract 8

This declaration records the gate owner's ruling before any new pilot task, proposer or judge call. Keep IFBench. A terminal provider-classified, non-retryable refusal is an ordinary failed task response, not missing data and not an infrastructure failure. Apply this rule identically to every method, control, task and seed.

## Refusals score zero and are never retried

The official DSPy Evaluate failure score is zero. The official IFBench metric scores an empty response zero. A terminal provider refusal ends the current program call and rollout with an empty response and score zero. Do not continue later stages of that rollout, retry the refusal, switch accounts or models to evade it, filter the row, or reinterpret it as an infrastructure abort. A refused proposal is an unsuccessful proposal, not a usable artifact or a new retry opportunity.

A refused proposal consumes one proposal step. Every method may continue to the next logical proposal if budget remains. A bridge must block redispatch inside the refused proposal without terminating GEPA's entire remaining search budget.

Classify refusals only from the provider's structured terminal refusal event, including a refusal or sensitive stop reason when stop details are absent. Preserve the supplied refusal category, or record `unspecified` with stop-reason provenance when unavailable. Never classify candidate text, arbitrary HTTP error substrings or a generic synthesized 502 as a refusal. Do not forward explanations, credentials or headers. Keep native omp credential resolution and the existing OAuth-only account restriction.

## Receipts and conservative unknown usage

Every dispatched role continues through the shared external ledger. Each refused call records its category, request hash, role, row identifier and control/noise arm when applicable. Context identifiers never enter the model request or its hash. Report refusal counts by arm and by row. A refused proposer outside a row records an explicit no-row context rather than inventing one.

Keep observed token usage separate from estimated charges. When refused-call usage is unavailable, count the serialized provider input locally with omp's embedded Claude-v3 tokenizer, the installed offline encoding for Claude 3 through 4.6. Use that counted input plus a 4096-token framing allowance as the conservative input bound, and charge the call's full requested maximum output. Use the larger of any reported input and that bound. Price unknown input at the highest published input/cache-write list rate and output at its published rate. Label these tokens and dollars estimated; include them in every budget check and charged total without pretending they are reported tokens. Record the counting method and bounds in each receipt. Native internal failed-attempt usage remains a disclosed limitation and complete attempt receipts remain a prerequisite for the full matrix.

Before dispatch, reserve one token per serialized caller-message UTF-8 byte plus 8192 tokens and the requested maximum output. The extra tokens cover a 4096-token native wire-envelope reserve and the 4096-token refusal charging allowance. This is a reservation, not reported usage or an extra charge. It prevents short caller messages from reserving less than the native provider envelope used by the refusal estimate.

## Detect refusal nondeterminism

Before dispatch, inspect all retained pilot journals for successful answers matching a known refused request hash. During the new attempt, retain and compare successful-answer/refusal outcomes for identical hashes against both prior evidence and new calls. A hash that is sometimes refused and sometimes answered triggers an immediate durable stop, not a zero score, gate failure, infrastructure retry or fallback. Preserve the charged call receipt and both outcome references. Do not issue more model calls after that stop.

The offline scan before this declaration found the known refused hash `sha256:e13f06de0a7ff0d02b4c72e104f6104b9e403c71b6eae6b2ba806bb36cd3d1d9` only in calls 127 and 128 of `controls-6`, both refused. It found no matching successful call. This is not proof of future determinism.

## One identical IFBench admission

Preserve the first zero-model setup at `evidence/pilot/adversarial-8` unchanged as superseded source evidence. Pre-dispatch review found implementation gaps before any new pilot call; the corrected exact-source setup uses `evidence/pilot/adversarial-8-final`. The single budgeted attempt still uses only `evidence/pilot/controls-8`. This is not a new draw or a replacement model attempt. Retain the official ordered training partition `Random(1).sample(source_rows[300:600], 150)`, selection `source_rows[:300]`, and the ordered 40-row training draw with seed `20261106` and hash `sha256:7d71794c42e9b6d7a7789ced7001c225e4fd2760b62539f99da20619f0e1bf04`.

Keep the same official naive seed, pinned licensed published improved instructions, broken and shortcut controls, task/proposer model, decoding, image, budgets and protected-checker attacks. Require known-improved > naive > max(broken, shortcut), broken = 0, naive < 0.90 and every protected-checker attack = 0. After ranking passes, run exactly 16 fresh paired unchanged-seed trials without response caching. Keep `noiseFloor = 3/sqrt(2)*s` and `noiseEnvelope = max(4.5/sqrt(2)*s, max_abs_delta)`, strictly below the improved-minus-naive contrast. Keep the `sqrt(40/n)` projection. Do not retune rows, controls or gates after results.

A completed measured IFBench gate failure selects MBPP + HoVer as a two-task development pilot. A complete pass admits MBPP + IFBench + HoVer. Refusal nondeterminism selects neither. AIME stays withdrawn. Preserve MBPP and HoVer's admitted measurements, and prove that their archived successful executions, scoring, programs, data, model, decoding and rows remain unaffected by this transport-only refusal correction. Bind any source-transition authorization to exact old/new source hashes; do not disable source-equivalence checks or silently declare arbitrary changes equivalent.

Transport failures retain predeclaration 7's infrastructure-only rules and its maximum of two additional attempts after the original abort. This first replacement attempt consumes one allowance; a further attempt is eligible only after a verified infrastructure abort, never after a refusal or completed gate result. No automatic retry controller is introduced.

## Protect resources and publish the measured plan

Keep the personal OAuth account allowlist excluding lindy.ai, API-key prohibition, shared reported-plus-estimated ledger and before-each-call usage throttle. Above-80%, stale/missing usage and broker outages pause dispatch. Use nice 10 and CPU 6 after checking live affinities, at most one model request and one CPU-heavy worker. IFBench calibration keeps its $100-equivalent and 24-active-hour caps; searches retain the $10-equivalent cap and existing safety limits.

Fix Hone only, with failing-before tests for refusal classification, zero scoring, no retry, conservative charging and the nondeterminism stop. Leave all earlier receipts unchanged. Do not change broker, installed omp or system configuration, evade refusals, or file an upstream issue.

Update three-task and two-task run plans from completed IFBench calibration and the retained real smokes, distinguishing measured usage from estimated refusal charges and projection assumptions. Keep PR #36 CI-green and obtain exact-head cross-family READY for experiment and boundary. Stop before merge. Neither matrix is authorized; the assistant reviews the plan first. If the run's time limit arrives, report the exact state and any owned persistent process before it expires.
