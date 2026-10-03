# Methodology and current status

Hone's claims depend on a fixed task and measurement contract. The source distinguishes three levels:

| Level | What is evaluated |
| --- | --- |
| M0 | A candidate change against one capsule. The ordinary `run` command is a one-candidate probe. |
| M1 | Changes to an optimizer across a frozen development and holdout protocol. |
| M2 | Recursive optimizer improvement and transfer to a frozen terminal cohort. |

The schemas enforce experiment cardinalities, budgets, artifact identities and allowed claims. Current M2 contracts require an eight-capsule development panel and eleven terminal capsules, bound to the declared cohort. The public development material in [hone-capsules](https://github.com/twaldin/hone-capsules) is not sufficient to execute that official terminal protocol.

## Implemented components

The source includes separate outer and inner model-route observations, corpus provenance assembly and verification, launch-draft generation, bounded calibration coordination and saturation report binding, search trajectories, phase dispatch and G1/G2 authorization records. Runtime checks bind those records to the appropriate campaign and artifacts.

Campaign model routes are part of the experiment, independent of a contributor's usual coding-agent settings. Keep the declared route, observed provider identity, budget and environment bound to each result. Do not substitute a convenient local default and report the same frozen experiment.

Several preparation capabilities are library APIs with tests rather than public top-level CLI commands. A schema, draft or passing component test establishes an implementation behavior, not completion of the experiment it describes.

The [M2 readiness runbook](m2-readiness.md) maps these components to remaining preparation, orchestration and owner-decision gaps, with source-backed command forms.

## What has been run

In August 2026 the calibration coordinator completed its 80-cell matrix and selected an inner ceiling of four episodes, and several recursive campaigns ran on a 21-capsule cohort. They exercised pauses, resumes, source migration and failure accounting end to end. The promotion decisions in the main campaign were scored on training cases, so they establish nothing about transfer. The [README](../README.md#results-so-far) lists the results that do hold up, and how narrow each is.

## Work still to complete

- Public-clone admission and image bootstrap, and automatic execution of authoring sessions.
- A recursive campaign whose promotion decisions are scored on held-out work, followed by the terminal evaluation it exists for.
- The complete replay/evidence publisher and RelayBench publication pipeline.
- M2b trigger evaluation and results-based release writing.

The design plans that guided the rewrite are not published. Current parsers, schemas and enforced runtime checks are the reference; older commits may describe obsolete milestones. Published results must identify the exact revision and protocol they tested.

No M2 success claim follows from this source. See [Results](results.md) for the intended evidence format and its current limits.
