# Pilot measurement contract 5

This declaration is committed before any new pilot task or proposer model call. It records the gate owner's ruling after contract 4a, not a change to an observed score, row, prompt or statistical threshold.

## Withdraw AIME and preserve its failure

AIME is withdrawn from this pilot panel. Its contract-4a ranking passed, but its unchanged-control noise envelope was 0.07616286004346215 against a positive-control contrast of 0.07500000000000001. That failed the required strict inequality. The plan requires killing a measurement contract whose noise exceeds its margin before searching. All AIME controls, outputs, pairs, costs, failures, manifests and hashes in `evidence/pilot/controls-4a` remain unchanged. This declaration does not relabel that failure as a pass.

## Admit the already declared HoVer reserve once

Replace AIME with HoVer, the reserve P task named in predeclaration 4. Reuse exactly its frozen contract-4a 40-row training cohort: sorted official training IDs, `random.Random(20261105).sample(eligible, 40)`, in the recorded order. Compare that order and its hash with `evidence/pilot/adversarial-4a/cohorts.json` before dispatch. No new row draw or row exclusion is allowed.

Keep the same official seed naive program, the same published optimized GEPA-artifact program instructions, the same broken artifact and the same shortcut. The published program remains seed 0, GPT-4.1-mini, GEPA-MERGE at `gepa-ai/gepa-artifact@cbefbc1aa0f43dd39874ec4bf42211365dbda42e`, under its retained MIT notice. Preserve all four editable modules, retrieval 7/7/10, the pinned corpus and numeric-index receipt, official data partition transformation and normalized gold-title subset metric.

Require `known-improved > naive > max(broken, shortcut)` and broken = 0. After ranking passes, run exactly 16 fresh paired unchanged-seed trials on the same 40 rows without response caching. With paired-delta sample SD `s` and maximum absolute delta `m`, keep `noiseFloor = 3/sqrt(2)*s` and `noiseEnvelope = max(4.5/sqrt(2)*s, m)`. Require envelope strictly below the improved-minus-naive contrast. Projection remains `sqrt(40/n)`. Keep the checker/protocol adversarial controls, all of which must score zero before admission.

One attempt only. No prompt, row, model, budget or gate change after seeing HoVer results. No automatic restart after an infrastructure abort. Infrastructure errors must not become candidate scores or count as a measured gate failure.

## Fix the complete panel decision now

MBPP and IFBench retain their independently passing contract-4a controls and noise. Carry them forward only after validating sealed source evidence and unchanged scoring/program/data/model/decoding/cohort dependencies. Do not rerun them merely because panel orchestration changed. Preserve IFBench's observed naive mean 0.80, below the original 0.90 headroom threshold.

If HoVer passes every admission gate, the panel is MBPP + IFBench + HoVer. If HoVer fails a checker/protocol, ranking or noise gate, retain that failure and use MBPP + IFBench only. Label the latter a two-task development pilot and narrow the claim accordingly. AIME never returns to the panel. There is no further reserve, substitution or retune. A missing or infrastructure-aborted HoVer result does not authorize the fallback.

## Keep transport, budgets and smoke fixed

Use the existing credential-opaque omp subscription route, OAuth-only personal account pool, API-key prohibition, external reported-usage ledger and published token prices. Keep the above-80%, stale/missing-usage and broker-outage pauses. Retain nice 10, CPU 6 after checking the live venue's affinities, one model request and one CPU-heavy worker at a time. HoVer calibration uses the existing measurement caps: $100-equivalent, 12 million reported tokens, 30,000 calls and 24 active hours. The search cap remains $10-equivalent per run with the existing safety caps. Selection sets do not change.

After admission, run one seed-0 MBPP smoke per method on the unchanged 90-row selection set: Hone, official pinned GEPA through the real subscription-reflection bridge, and plain. Replay the retained outputs. Report each method's actual proposal spend, training-evaluation spend, selection-evaluation spend, hidden-attempt rate, tokens, wall time and pauses. Include repairs and retries in the appropriate reported-usage totals and reconcile spend categories to the ledger. Do not substitute a cost projection for a measured smoke.

## Apply the security merge rule before smoke

When HoVer finishes, check the main-branch dependency update for mutation-image handlebars 4.7.10, vitest 3.2.6 and tinypool 2.1.2. If merged then, rebase this lane onto main and re-seal the images before any smoke. If not merged, do not wait; use the current seal and record that fact. Preserve measured evidence through either route and validate dependency changes before carrying admissions forward.

## Publication and authorization

Publish the task and panel manifests, adapters, control/noise outcomes, failures, ledgers, spend reconciliation, replay evidence and image/security decision. Open one PR with CI and an exact-head cross-family READY, then stop before merge. Neither a 27-run three-task pilot nor an 18-run two-task pilot is authorized until the assistant reviews the smokes. The pilot makes no optimizer-quality publication claim. Complete credential-opaque per-attempt and failed-call usage receipts in omp remain a prerequisite for the later full benchmark matrix. File nothing upstream.
