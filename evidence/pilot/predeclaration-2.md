# Pilot contract correction 2 — predeclaration

This declaration must be committed before any new model call. It replaces the failed MBPP measurement contract, not the optimizer or the acceptance thresholds. Earlier admission evidence remains immutable and is not reused as a passing calibration.

## MBPP answer and scoring contract

The candidate's answer is program text. If it contains fenced code, extract the first block whose opening fence is exactly ```python or bare ``` (surrounding horizontal whitespace allowed); discard its opening/closing fences and surrounding prose. Other language tags are not eligible. If no eligible fenced block exists, use the whole output. An eligible unclosed block consumes the remaining output after its opening fence. Apply this extraction once at the shared MBPP scoring boundary, identically to every method, every control, trusted reference outputs, and offline replay. Do not repair or reinterpret Python after extraction.

Execute candidate source, official development setup, and every official assertion as Python in one namespace inside the existing non-root, read-only, network-disabled, resource-limited Docker sandbox. Use a ten-second scoring timeout and the pinned Python image. Pair and other ordinary Python objects therefore retain native Python semantics. Remove the literal-only function RPC scorer and its restrictions; filter no rows and change no official assertions. Neither model task calls nor proposer feedback receives selection assertions. Scoring execution itself necessarily receives the assertions inside the sandbox. Candidate stdout is not a score: require successful completion of the scoring runner and its completion receipt; an assertion failure, exception, timeout, incomplete execution, or invalid program scores zero. This is ordinary official Python assertion execution, not a claim that assertions are secret from adversarial code in the same interpreter.

## Fresh fixed control cohorts

Draw exactly 20 official training rows per task, without replacement, using Python `random.Random(20261103).sample(eligible, 20)` independently for each task. Sort eligible rows lexicographically by their stable row ID before drawing. Do not stratify, inspect answers, redraw, or adjust the seed based on results. Preserve the original training/selection partitions and metrics.

For MBPP exclude only the eight already measured control IDs from this new control draw: `mbpp:train:601`, `mbpp:train:654`, `mbpp:train:707`, `mbpp:train:760`, `mbpp:train:814`, `mbpp:train:867`, `mbpp:train:920`, `mbpp:train:974`. They remain in the official training partition and in search; this exclusion applies only to the fresh control cohort. IFBench and AIME use their full official training partitions as eligible pools. Retain the resulting ordered IDs and cohort hashes before dispatching model calls.

Keep the existing control artifacts and model route, decoding, deployment limits, and budgets. In particular, do not strengthen or weaken the naive prompt after seeing results. The only changes to MBPP control execution are shared answer extraction and native sandbox assertion semantics.

## Unchanged acceptance and noise procedure

Require `known-improved > naive > max(broken, shortcut)`, broken = 0, and MBPP shortcut = 0. A tie or reversed ordering stops admission before noise measurement or search. A cohort that is too easy or too hard still fails; do not retune it.

After a task passes ranking, run 16 fresh paired trials of the unchanged seed artifact on the same 20-row cohort, with no cached model responses. Each trial independently evaluates both arms. For paired mean deltas d, retain sample SD s and maximum absolute delta m. Keep `noiseFloor = 3/sqrt(2) * s` and `noiseEnvelope = max(4.5/sqrt(2) * s, m)`. Require the envelope to be strictly smaller than the improved-minus-naive contrast. Preserve the native calibration schema and the declared independent-row projection `sqrt(source_rows / target_rows)` for other evaluation sizes; source_rows is now 20. A zero estimate is not proof of a noiseless evaluator.

Run fresh controls for IFBench, AIME and MBPP before any search. On any failed ranking or noise gate, preserve evidence and stop without retuning or rerunning. Only after all pass, run one seed-0 smoke search per method on MBPP, including real official GEPA subscription reflection and valid native artifact components. Preserve the common reported-usage ledger, observable internal-attempt counts and >1% flags, personal-domain OAuth-only account pool, usage/outage throttle, and $10-equivalent search caps. No full matrix or merge is authorized here; complete omp attempt and failed-call usage receipts remain prerequisites for the full matrix.
