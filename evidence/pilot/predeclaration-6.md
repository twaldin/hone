# Pilot measurement contract 6

This declaration records the gate owner's ruling before any new pilot task or proposer model call. It corrects a verified partition bug, not an observed score, artifact or acceptance threshold.

## Correct the official IFBench partition

At `gepa-ai/gepa-artifact@cbefbc1aa0f43dd39874ec4bf42211365dbda42e`, [IFBench.init_dataset](https://github.com/gepa-ai/gepa-artifact/blob/cbefbc1aa0f43dd39874ec4bf42211365dbda42e/gepa_artifact/benchmarks/IFBench/ifbench_data.py#L6-L26) first takes development-file rows 300 through 599 for training and rows 0 through 299 for validation. Its inherited [Benchmark.__init__ and trim_dataset](https://github.com/gepa-ai/gepa-artifact/blob/cbefbc1aa0f43dd39874ec4bf42211365dbda42e/gepa_artifact/benchmarks/benchmark.py#L10-L51) then always replace training with `random.Random(1).sample(rows[300:600], 150)`. Validation already has 300 rows, so its 300-row trim is a no-op. [The official runner](https://github.com/gepa-ai/gepa-artifact/blob/cbefbc1aa0f43dd39874ec4bf42211365dbda42e/scripts/run_experiments.py#L154-L173) invokes that constructor; the seed-0 artifact does not subsequently reshuffle the partitions.

Use that exact ordered 150-row training sample. Keep the 300-row selection set unchanged. Decode development material only; never load final-test labels. Fix the shared loader and every affected caller/test/manifest, not the measured control scores.

## Preserve the invalid-cohort evidence

Every earlier IFBench measurement remains byte-for-byte unchanged, including controls-4a, its carryover in controls-5, and earlier failed epochs. Label those measurements `invalid cohort` in new status metadata and documentation outside their existing seals. Do not filter their 40 rows, relabel their raw results as official admission, recompute a favorable subset, or overwrite a prior output folder.

## One fresh IFBench admission

Use only `evidence/pilot/controls-6` for the new attempt. Draw exactly 40 training rows by sorting the corrected official training IDs and applying `random.Random(20261106).sample(eligible, 40)`. Freeze the ordered IDs and cohort hash before model dispatch. No exclusions, second draw, replacement directory, prompt change or gate change after results.

Keep the official naive seed, the same pinned licensed published optimized IFBench instructions, the same broken artifact and the same shortcut. Require `known-improved > naive > max(broken, shortcut)` and broken = 0. Preserve the 0.90 naive headroom boundary: reaching it fails IFBench admission rather than substituting another task. Require every protected-checker/protocol adversarial control to score zero before admission.

After ranking passes, run exactly 16 fresh paired unchanged-seed trials on those same 40 rows without response caching. With paired-delta sample SD `s` and maximum absolute delta `m`, keep `noiseFloor = 3/sqrt(2)*s` and `noiseEnvelope = max(4.5/sqrt(2)*s, m)`. The envelope must be strictly below the improved-minus-naive contrast. Projection remains `sqrt(40/n)`. Infrastructure aborts remain infrastructure failures, never zero candidate scores or admission failures. No automatic restart is authorized.

## Carry the admitted tasks and fix the panel now

MBPP and HoVer admissions stand. Validate their sealed measurements and task-specific scoring/program/data/model/decoding/cohort equivalence; do not rerun their model controls merely because the IFBench loader or panel orchestration changed. MBPP's exact builtin-type and structural-record rules remain unchanged. Complete its final-verifier full-reference development audit without model calls, report every failure and its effect on the reference score, and do not remove rows or change grading to make the reference perfect.

If IFBench passes every gate, the panel is MBPP + IFBench + HoVer. If it fails a checker, headroom, ranking or noise gate, retain the failure and use MBPP + HoVer only, labelled a two-task development pilot with its claim narrowed. There are no further substitutions. A missing or infrastructure-aborted result does not authorize the fallback. AIME remains withdrawn.

## Keep transport, budgets and resource protection

Keep the credential-opaque omp subscription route, fixed identical task/proposer model, personal OAuth account allowlist excluding lindy.ai, API-key prohibition, external reported-usage ledger, published prices, hidden-attempt flags and disclosed undercount. Before every model call, retain the above-80%, stale/missing-usage and broker-outage pauses. Do not read, copy or pass credentials. Use nice 10, CPU 6 after checking live affinities, at most one model request and one CPU-heavy worker in the harness. IFBench calibration retains $100-equivalent, 12 million reported tokens, 30,000 calls and 24 active hours. Search retains $10-equivalent and all existing safety caps.

## Complete review and plan, not a matrix

Finish the outstanding experiment review, including official partition transformations and the final MBPP reference audit. Fix only verified issues, with a failing-before regression test for each behavior change. Preserve the existing real MBPP smoke measurements and their per-method phase spend as evidence. Produce full three-task and two-task fallback run projections from actual smoke and valid task-calibration tokens, costs, wall time, polling and subscription pauses, with explicit assumptions and unbounded outage delay.

Update PR #36, run CI, and obtain exact-head cross-family READY covering both experiment and boundary. Stop before merge. Neither matrix is authorized; the assistant reviews the new measured run plan first. Credential-opaque per-attempt and failed-call receipts in omp remain a prerequisite for the full matrix. File nothing upstream.
