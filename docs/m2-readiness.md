# M2 readiness and runbook

**Next stage: close preparation and orchestration gaps, not launch a campaign.** This inventory reconciles published source at [`22fae309`](https://github.com/twaldin/hone/commit/22fae309bbb1c4bf2bbe5b55c72eb33cc2ecf0cc) with retained launch metadata. It establishes neither host readiness nor a completed M2 result. Source contracts take precedence over historical checklists. Preserve the settled campaign routes, execution-host decision and terminal exclusion policy; operator details and evidence remain private.

## What exists, and what it proves

| Area | Current capability and boundary | Source |
| --- | --- | --- |
| Cohort | 16 development identities split into two eight-task panels; 11 terminal identities. Public terminal directories are source references, not runnable bundles. Historical admission/soundness does not supply today's receipt chain or host calibration. | [M2 constants, panels and cohort schema](../schema/src/meta.ts), [capsules](capsules.md), [publication boundary](../PUBLICATION.md) |
| Routes and provider policy | Separate outer/inner observed routes; durable pause for drift, explicit failover and auth/payment/rate limits; at most three jittered retries for ordinary 5xx. This does not prove the selected upstream exposes account rotation or faithfully transports streamed errors. | `M2ModelObservationPolicy` in [meta.ts](../schema/src/meta.ts), [provider-policy.ts](../trusted/proxy/src/provider-policy.ts), [proxy.ts](../trusted/proxy/src/proxy.ts) |
| Corpus and draft | Digest-verifying provenance assembler, broker corpus configuration/fences and fail-closed initial Stage-A draft generator exist. Trusted recursive dispatch now requires the existing artifact/document inputs, verifies their frozen bindings, and passes `corpus`/`corpusCohort` to outer and fresh/resumed child runs. Public preparation/loading commands remain missing. | [corpus-provenance.ts](../trusted/cli/src/corpus-provenance.ts), [launch-draft.ts](../trusted/cli/src/launch-draft.ts), [recursive dispatch](../trusted/cli/src/commands/hone.ts), [supervisor](../trusted/cli/src/supervisor.ts) |
| Calibration | Deterministic saturation scorer and JSON-in/out entrypoint exist. Four fresh calibration-only task drafts are implemented; they are not admitted. Their execution coordinator and selected-host/resource evidence remain missing. | [Calibration task drafts](capsules.md#calibration-only-task-drafts), [saturation.ts](../trusted/scoring/src/saturation.ts), [saturation-cli.ts](../trusted/scoring/src/saturation-cli.ts), `resolveCalibration` in [launch-draft.ts](../trusted/cli/src/launch-draft.ts) |
| Recursive cells | Freeze, search, confirmation, authorization and terminal dispatch exist. Freeze seals supplied inputs; it does not choose the experiment or generate all Stage-B cells. | `recursiveCommand` in [commands/hone.ts](../trusted/cli/src/commands/hone.ts), [CLI reference](cli.md) |
| G1/G2 | Statistical records, human attestations and artifact-bound dispatch checks exist. A separate G1 owner approval guards Stage-B **search**; the existing G1 authorization still guards **confirmation**, and G2 plus G1 guard terminal. Approval does not supply cross-cell winner selection or a campaign result. | [gate-records.ts](../trusted/cli/src/gate-records.ts), `recursiveCommand`, [approval protocol](cli.md#g1-owner-approval-before-stage-b-search) |
| Evidence | Durable receipts/journals and `search-trajectory.v2.json` exist. No complete M2 replay/export/RelayBench publisher is established by these components. | [meta-trajectory.ts](../trusted/cli/src/meta-trajectory.ts), [results](results.md) |

Do not rebuild the dual-route schema, provenance assembler, draft generator or gate-record format from the old “missing tooling” list. Hone source publication and README work already landed in [PR14](https://github.com/twaldin/hone/pull/14) and [PR15](https://github.com/twaldin/hone/pull/15); separate RelayBench publication does not follow from them.

The public tree contains 17 active manifests, 11 terminal reference manifests and four non-discoverable calibration draft manifests. The extra active task, [`seeded-astar`](../capsules/seeded-astar/manifest.json), is outside the declared 16-task launch development cohort and is not a designated calibration task. Directory count does not change the frozen cohort.

### Cardinality is not an execution receipt

The [scorer](../trusted/scoring/src/saturation.ts) requires **80 calibration cells**: four excluded tasks × caps `{2,4,8,12}` × five matched seeds per task. [Confirmation records](../trusted/cli/src/gate-records.ts) require **96 Stage-A measurements** (four arms × eight tasks × three replicates) and **120 Stage-B measurements** (five arms × eight tasks × three replicates). The [terminal contract](../schema/src/meta.ts) is **99 measurements** (three generations × eleven tasks × three replicates).

Their sum, 395, is only those grids once each—not a complete campaign run count or budget. Search cells, outer repetitions, retries and failures must be accounted for separately. Search capacity is twelve calibrated full-panel equivalents, not a guarantee of twelve candidates. Do not reuse old 28-capsule, 12-terminal or 108-terminal-run prose.

## Prerequisites and bounded next work

These are scope candidates, not new execution authorizations. Each row names its dependency and a stopping point.

| Next work | Prerequisite and evidence | Bounded deliverable |
| --- | --- | --- |
| Resolve timing execution contract | [TWA-57](https://linear.app/twaldin/issue/TWA-57) retains failures even after serialization; [getting started](getting-started.md) defines the supported checks. | Use that ticket's approved isolation/environment contract. Do not rerun until green, weaken the 15% bound or treat a passing source suite as host calibration. |
| Finish streamed-error classification | [TWA-58](https://linear.app/twaldin/issue/TWA-58), [proxy policy](../trusted/proxy/src/provider-policy.ts). | Land and verify that owner's offline regression coverage; no duplicate patch. This does not cover upstream account-rotation changes. |
| Validate provider integration and environment | TWA-57/58 outcomes; [runtime prerequisites](getting-started.md#before-a-real-run) and `isProxyFailover`. | Separately authorize exact-image/runtime inventory, upstream failover-signal verification and minimal two-route child/pause/resume smoke on the settled host. Record observed provider provenance privately; no formal soak or route substitution. |
| Finish calibration admission and orchestration | [TWA-59](https://linear.app/twaldin/issue/TWA-59) approved task/seed/bootstrap/resource choices; TWA-90 supplies the [four offline-authored task drafts](capsules.md#calibration-only-task-drafts). | Resolve the recorded ordering gaps and validate/admit these tasks on the selected host. Separately implement the bounded 80-cell coordinator with invalid/incomplete accounting and report binding. Execution requires its own authorized scope and host/provider evidence. |
| Reconcile launch admission and host normalization | [Admission contract](capsules.md#admission-and-authoring), current manifests, preserved ordering metadata and exact original terminal bundles. | Inventory active identities, production receipts, images and host-specific normalization/recalibration markers. Produce a like-for-like validation/refreeze proposal; any identity-bearing edits require separate approval. No renaming reference manifests or mixing public edited baselines with private assets. |
| Assemble and seal freeze inputs | Verified admission outputs, approved calibration, provider/environment evidence and owner choices below; `assembleCorpusProvenance`, `generateM2LaunchDraft`. | Add the supported preparation entrypoint using existing APIs and the [trusted recursive corpus handoff](cli.md#campaigns). Produce a reviewed private freezable draft and provenance artifact. Stop before search. |
| Complete Stage-B orchestration and gate semantics | Stage-A preparation, accepted analysis protocol and the gate limitations below; `recursiveCommand`, `assembleG2Record`. | Validate the two controller-cell handoff, winner selection, pre-search owner authority and terminal identity mapping. Scope any missing code separately; do not equate existing record serialization with end-to-end orchestration. |
| Register and implement evidence publication | [Results contract](results.md), actual 11-task terminal schema and search-trajectory publisher. | First approve an M2 evidence/aggregation/redaction protocol; then build complete digest/cardinality/factor-matched replay export including failures and unavailable artifacts. RelayBench ingest/publication is a separate repository scope. No terminal claim until reviewed evidence exists. |

### Inputs freeze cannot choose

Use [`M2LaunchDraftInputs` and `M2LaunchDraftParameters`](../trusted/cli/src/launch-draft.ts), [`CorpusProvenanceInputs`](../trusted/cli/src/corpus-provenance.ts) and the [M2 schema](../schema/src/meta.ts) as the input contract:

- Current admitted manifest IDs/digests, full development/terminal mapping, both panel assignments and terminal-content hash metadata. Historical contract IDs are not a substitute for admitted manifests.
- Corpus version, hash-verified public snapshot documents and attributed/metered panel evidence. Keep terminal content unavailable to optimizer-visible corpus documents.
- Designated four excluded calibration identities, measured scorer report with recorded RNG/bootstrap settings, and calibrated per-panel resource vectors. `--draft-without-calibration` is an API marker, **not a public CLI flag**; its wrapped draft cannot freeze.
- Pinned optimizer image, child/outer budgets in all four dimensions, concurrency and outer-replicate schedule. Explicitly choose or acknowledge generator defaults for promotion, optimizer paths and candidate counts. The generator creates an initial Stage-A draft, not the whole campaign schedule.
- Source/runtime/control identities and protocol/analysis bindings. Freeze recomputes bindings and revalidates capsules; it does not invent missing evidence or owner decisions. Freeze itself requires a clean source tree, installed admitted inputs and optimizer/control preparation—it is not a harmless dry run.

### Decisions before measured gate work

[`GateThresholdsFileV1`](../trusted/cli/src/gate-records.ts) requires **both** G1 and G2 blocks. Agree on analysis and factor matching before measurement, then obtain actual owner review before recording attestations. Do not use flags as a substitute for that review.

- **G1:** choose the explicit SE multiple and sign epsilon. The implemented paired criterion is mean delta greater than SE multiple × SE; it has no separate effect-size floor. Signs require at least six of eight tasks and three of four in each stratum; controls must remain below seed and winner.
- **G2:** choose paired-win fraction, ordinal/sign epsilons, token slack and yield tolerance. Despite AUC-named fields, `assembleG2Record` compares final `qNormalized` values and total observed tokens; it does not integrate best-so-far trajectories or test every common threshold. Complete-cardinality requirements make the passing-record valid-yield comparison non-discriminating. A protocol requiring the fuller trajectory analysis needs a bounded implementation ticket, not relabeling these statistics.
- **Authority and identity:** use `approve-search` after actual owner review of G1 and before searching each frozen Stage-B cell. It binds the passing Stage-A record, destination config and target/controller identities without later-produced artifacts. Search re-reads the source record and refuses stale approval. The separate historical `authorize --gate G1` still requires control-winner and generation-2 artifacts before confirmation; it is not pre-search approval. See the [compatibility boundary](cli.md#g1-owner-approval-before-stage-b-search). Terminal generation-0 remains bound to Stage-B `controlWinner`, generation-1 to its target and generation-2 to the accepted artifact; a distinct untouched G0 contrast cannot be substituted without a reviewed record change.

## Command surface

From an installed source checkout, these commands are safe source inspection/scoring, not campaign execution:

```sh
node trusted/cli/bin/hone.js --help
pnpm --filter @hone/cli exec tsx ../scoring/src/saturation-cli.ts /absolute/private/calibration-cells.json
```

The scorer accepts `{ "cells": [...], "rngSeed": uint32, "bootstrapSamples"?: positive-int }` and writes its report to stdout. It launches no runs. The paths here are placeholders; keep inputs/output private. Top-level help is abbreviated; the recursive parser also supports `authorize`.

The following are **parser-accurate templates for later authorized work, not a runnable launch script**. `hone` abbreviates `node trusted/cli/bin/hone.js`; all digest variables must contain complete lowercase `sha256:…` identities. `A` and `B` refer to distinct frozen cell configurations, not arbitrary phase labels. The orchestration gaps above must be closed first.

```text
hone recursive --campaign "$DRAFT_A" --headless --phase freeze --out "$A"
hone recursive --campaign "$A" --headless --phase search
hone recursive --campaign "$A" --headless --phase confirmation --gate-thresholds "$THRESHOLDS"

hone recursive --campaign "$DRAFT_B" --headless --phase freeze --out "$B" --target-artifact "$G1" --controller-artifact "$CONTROLLER"
hone recursive --campaign "$B" --headless --phase approve-search --record-dir "$A_STATE_DIR" --approver "$OWNER" --reason "$REASON" --attest-diff-confined --attest-mechanism-plausible
hone recursive --campaign "$B" --headless --phase search
hone recursive --campaign "$B" --headless --phase authorize --gate G1 --record-dir "$A_STATE_DIR" --control-winner "$CONTROL_WINNER" --generation2 "$G2" --approver "$OWNER" --reason "$REASON" --attest-diff-confined --attest-mechanism-plausible
hone recursive --campaign "$B" --headless --phase confirmation --gate-thresholds "$THRESHOLDS" --control-winner "$CONTROL_WINNER" --generation2 "$G2"
hone recursive --campaign "$B" --headless --phase authorize --gate G2 --generation0 "$CONTROL_WINNER" --generation1 "$G1" --generation2 "$G2" --approver "$OWNER" --reason "$REASON" --attest-diff-confined --attest-mechanism-plausible
hone recursive --campaign "$B" --headless --phase terminal --generation0 "$CONTROL_WINNER" --generation1 "$G1" --generation2 "$G2"

hone resume --campaign "$CELL_STATE_DIR" --pause "$PAUSE_ID"
```

`$A_STATE_DIR` is the retained `recursive-cell-<config-hash>` directory under `.hone-runs`, not the config file. Stage-B search above represents one cell only, not construction/comparison of both controller cells. Obtain owner review before `approve-search`; each destination cell needs its own identity-bound approval. Confirmation still requires the preceding search journal and later artifact-bound authorization. `resume` releases a durable campaign pause; it is not `run --resume`. Check its persisted cause before release.

The recursive `search`, `confirmation` and `terminal` templates require the trusted corpus handoff described in [CLI](cli.md#campaigns). The public parser has no corpus-loading flags and refuses those phases without the required inputs. `freeze`, `approve-search` and `authorize` do not require document bytes. These templates are not currently an end-to-end launch path.

**Missing supported command gaps:** public-clone admission/image bootstrap; calibration execution; corpus assembly/draft generation; full cross-cell orchestration; complete M2 evidence export/RelayBench ingest and M2b trigger evaluation. Library APIs and private historical scripts are not public command aliases.

## Exit criteria for the next stage

Advance from preparation only with a reviewed private input manifest tying admission, exact images/host evidence, provider observations, calibration report, budgets, panels, corpus and analysis decisions to source/artifact digests; supported preparation commands; and a tested cross-cell/owner-authorization handoff. No admission bypass, threshold changes or terminal-answer inspection is part of this runbook.

Before publication, register terminal aggregation/contrasts and complete evidence requirements against the eleven-task contract; do not mechanically translate historical sign thresholds. Report success **or failure**, including unavailable replay inputs. Conditional M2b analysis, independent reproduction, RelayBench publication, website deployment and result-based writing remain separately scoped downstream work. See [methodology](methodology.md) and [results](results.md).
