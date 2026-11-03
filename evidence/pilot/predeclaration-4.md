# Pilot measurement contract 4

This declaration must be committed before any new pilot model call. It changes the P controls and their draw, not the ranking gate, noise estimator, model route, search policy, budget or admitted MBPP contract. Earlier results remain immutable.

## Published P controls

Use the official task seed program as the naive control. Do not use the previous IFBench instruction-ignoring prompt. The known-improved control must be the published optimized program or instructions from [gepa-ai/gepa-artifact](https://github.com/gepa-ai/gepa-artifact/tree/cbefbc1aa0f43dd39874ec4bf42211365dbda42e), pinned at `cbefbc1aa0f43dd39874ec4bf42211365dbda42e`. Do not author an improved prompt or substitute trusted answers for the P optimized control.

Select the final `evaluation_results/optimized_program` export from seed 0, GPT-4.1-mini, GEPA-MERGE. If that optimizer directory does not exist for a task, use seed 0, GPT-4.1-mini, GEPA. This metadata-only fallback chooses AIME GEPA. Never choose a seed, checkpoint or optimizer by its final-test result or the new pilot scores.

The published `experiment_runs_data.tar.gz` has SHA256 `0e1db10331bbbdd48701443b0690d5b7b8abef841a73b76882d26853b3f38dd7` and 1,931,042,598 bytes. Its selected program files are:

| Task | Directory below `experiment_runs_data/experiment_runs/seed_0/` | Program SHA256 |
| --- | --- | --- |
| IFBench | `IFBench_IFBenchCoT2StageProgram_GEPA-MERGE_gpt-41-mini/evaluation_results/optimized_program/` | `9e00d397cc6e51d39816467eb7d7fc9263b99fe6f1f4d4204aa003b7256bda62` |
| AIME | `AIMEBench_CoT_GEPA_gpt-41-mini/evaluation_results/optimized_program/` | `e223aedd786122a6e67408bb7e374e259c054b1938419b1b21bdd6a0a1fe6d92` |
| HoVer | `hoverBench_HoverMultiHop_GEPA-MERGE_gpt-41-mini/evaluation_results/optimized_program/` | `b742b0680bfb1ddaee2ae6a045ea5b50eb9c540df3206ea4a3a1298c31658287` |

The artifact is MIT, copyright 2025 Lakshya A Agrawal, [LICENSE blob `a2d71aed19ccc43d94b9c3afe6430da9b2277f32`](https://github.com/gepa-ai/gepa-artifact/blob/cbefbc1aa0f43dd39874ec4bf42211365dbda42e/LICENSE). Retain its notice with any redistributed instructions. The exports exist but use whole-program pickle, not instruction-only JSON. Safe extraction must preserve all predictor instructions and required program state without importing histories, credentials or sealed labels. Do not deserialize upstream code in the trusted host. If safe extraction cannot be established, stop with that missing prerequisite rather than invent a control. No absence of a safe export is evidence that a published optimized artifact does not exist.

Preserve the official module topology and seed instructions: IFBench generation and revision have distinct instructions; AIME uses its official problem-solving signature. Current-model transport and fixed deployment limits remain identical across methods. This is not a reproduction of the historical GPT-4.1-mini panel.

## Fresh draw and headroom

For each P task, sort its official training partition lexicographically by stable ID, then take `random.Random(20261105).sample(eligible, 40)`. Freeze the ordered IDs, data manifest, program artifacts and hashes before dispatch. Do not redraw based on scores. Load no final-test rows or labels.

Measure the official IFBench naive control first. If its mean score on these 40 rows is at least 0.90, replace IFBench with HoVer. This is a predeclared headroom branch, not a failed-ranking retune. Do not measure a new IFBench improved control or noise after that branch fires. If IFBench is below 0.90, retain it and apply the unchanged ranking and noise gates. AIME retains its own ranking and noise rule, with no automatic HoVer replacement.

The HoVer alternate uses the pinned official GEPA artifact partitions, capped train and validation sets, `HoverMultiHop` program and discrete supporting-document retrieval metric. It does not use claim classification, another retrieval index, original source validation as GEPA validation, or cached gold passages. The official data transform filters three distinct supporting-document titles, shuffles with seed 0, splits test/validation/train 40/40/20, and independently samples caps 300/300/150 with seed 1. Partition membership must be established before loading development labels. A label-free membership projection or equivalent safe development export is required. If that cannot be established, stop rather than open sealed labels.

HoVer data is CC BY-SA 4.0. The official corpus resource is `dspy/cache@ef6a5e72a98b47cef31574a400fea8fe149559a3/wiki.abstracts.2017.tar.gz`, published SHA256 `744183e61af986bde9b25c880b59c1502618a8b673671e189cbc0ee684fceb42`, 608,448,121 bytes. Preserve the official BM25S 0.2.12 and PyStemmer 2.2.0.3 recipe, English stemming and stopwords, `k1=0.9`, `b=0.4`, and retrieval counts 7, 7 and 10. Record exact corpus provenance and attribution before use. Do not silently substitute a public index with different parameters.

## Unchanged admission and noise

Require `known-improved > naive > max(broken, shortcut)` and broken = 0. Preserve the original P shortcut and trusted external checkers. A tie or reversed ranking stops, without retuning. A published optimized program need not improve a different current model. That risk is part of this admission experiment.

After ranking passes, run 16 fresh paired unchanged-seed trials on the same 40 P rows, without response caching. For paired mean-delta sample SD `s` and maximum absolute delta `m`, keep `noiseFloor = 3/sqrt(2)*s` and `noiseEnvelope = max(4.5/sqrt(2)*s, m)`. Require the envelope strictly below the improved-minus-naive contrast. Project to an `n`-row cohort with `sqrt(40/n)` for these P calibrations. Preserve the native schema and zero-noise caveat.

MBPP stays admitted under contract 3. Do not rerun its controls, adversarial cohort or noise unless its execution contract changes. Preserve its 20-row cohort, artifacts, protected worker/comparison code, route, calibration, manifests and evidence hashes. A changed orchestration file alone must not silently relabel old measurements as new measurements. Demonstrate unchanged MBPP execution dependencies before reusing its admission.

## Searches, accounting and stop

Only after all three tasks are admitted, run one seed-0 MBPP smoke for Hone, pinned official GEPA with a real subscription reflection call, and plain. Keep the $10-equivalent cap per search, reported-usage ledger, role coverage, observable hidden-attempt counts and rate/spread flags. Keep the OAuth-only personal-domain allowlist, API-key prohibition and credential-opaque omp resolution. Throttle above 80% usage and pause on broker or usage outages. No full pilot or merge in this lane.

Keep nice 10, one model request and one CPU-heavy worker at a time. Recheck the live venue affinity before heavy work and avoid its CPUs. Publish manifests, exact artifacts, control and noise outcomes, failures, ledgers and replay evidence. Complete credential-opaque per-attempt and failed-call receipts in omp remain a prerequisite for the later full benchmark matrix, not the 27-run development pilot. File nothing upstream.
