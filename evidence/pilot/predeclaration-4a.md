# Predeclaration 4a: transport corrections before measurement

No new pilot task or proposer model call has occurred since predeclaration 4. This correction is committed before any such call. It changes neither a task metric nor a control prompt, cohort, ranking rule, noise procedure, model, decoding setting, or search budget.

## Defects found in exact-head preflight

At `616579c85e1c2de19926896047e8fd34c46e421d`, `Gateway` explicitly starts Bun with `taskset -c 0`, overriding the required inherited CPU-6 placement. The transport must inherit CPU 6 instead. No CPU-placement waiver is used. This changes a literal MBPP execution dependency, so the contract-3 MBPP measurements cannot authorize the corrected transport.

Exhausted provider failures currently raise `CallFailed`, which the row evaluators convert into a zero candidate score. During calibration, provider failures must instead abort as infrastructure failures, without deciding a rank, noise envelope, or IFBench headroom branch. All attempted calls remain in the reported-usage ledger; this adds no unaccounted retry or selective row rerun. Search/deployment failure semantics are unchanged.

## MBPP re-admission after the code change

The gate owner's rule permits MBPP reruns when its code changes. Re-admit MBPP with the corrected transport, using exactly the previously admitted 20-row cohort: seed `20261104` and the existing exclusions. Keep its original naive program, reference positive, broken and shortcut controls, strict ranking, 16 paired unchanged-control noise trials, projection and envelope unchanged. Run the full 300 adversarial checks again; all must score zero. Grade all 464 official development rows or report ungradeable rows, without filtering. A positive adversary, failed ranking or failed noise gate ends this admission without retuning.

The new `readmit-mbpp` entrypoint must freeze the execution-source contract and adversarial proof before auth/model bootstrap, then produce a separate sealed bundle at `evidence/pilot/mbpp-readmission-4a`. Old control and adversarial bundles remain immutable historical evidence, not authorization for the corrected transport. Later P-only work may reuse only this newly admitted MBPP source contract.

## P rules remain predeclaration 4

Seed `20261105`, 40 training rows each, published pinned GEPA positives, official seed naive programs, inclusive IFBench naive >= 0.90 replacement by HoVer, and AIME's unchanged rule remain fixed. No fresh P model result has been seen. Regenerate zero-call protocol admissions under the corrected source identities at `adversarial-4a`; measure controls at `controls-4a` and smokes at `smoke-4a`. No search until all selected task controls and noise pass.

The reported-usage accounting limit, hidden-attempt flags, personal OAuth allowlist, 80% usage/outage pauses, $10-equivalent search cap, real GEPA reflection requirement, later-matrix attempt-receipt prerequisite, and stop-before-merge instruction remain unchanged.
