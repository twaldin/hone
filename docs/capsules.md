# Capsules and public data

A runnable capsule needs its manifest, exact baseline, evaluator, declared assets, pinned image and valid admission receipt chain. Files alone are not a new admission. Changing a protected baseline file or restoring assets beneath a different evaluator cannot reuse the original exact-tree approval.

## Development tasks

The public repository includes development tasks and synthetic fixtures, including the approved bounded TradeUp, Monoagent and Floyd implementations. This release covers the derived tasks in this repository, not the complete private applications from which some tasks originated.

The [publication notice](../PUBLICATION.md) records their MIT release and supersedes the earlier distribution restrictions preserved inside identity-bearing metadata. Source contracts retain historical capsule IDs and digests; a new launch takes its identity from the current admitted manifest.

An asset group named `holdout` inside a development capsule describes visibility within that task's execution protocol. It is distinct from the frozen terminal evaluation set. The approved synthetic development fixtures may be public while the terminal inputs and answers remain withheld.

Some baselines include a nested Git object store. Preserve its bytes using the [checkout procedure](getting-started.md#checkout). Do not reconstruct a baseline by copying only the visible working files and assuming its manifest commit still identifies that copy.

## Calibration-only task drafts

Four fresh Python-stdlib packages implement the task choices approved in TWA-59. They reuse neither development/terminal task code nor cohort fixtures and are excluded from both cohorts:

| Package | Objective and hard checks |
| --- | --- |
| `calibration-postings-intersection` | Exact sorted intersection of up to eight strictly increasing document-ID lists, each at most 20,000 entries. Zero lists or an empty member yields an empty intersection. Latency objective; independent occurrence-count oracle. |
| `calibration-sequence-diff` | Minimal insert/delete scripts for two sequences of at most 1,024 string tokens each. `equal`, `delete`, and `insert` operations must reconstruct both sequences; an independent LCS-length calculation checks minimality without requiring a particular tie-break. Latency objective. |
| `calibration-weighted-coverage` | Select distinct sets within a hard total cost budget, from at most 128 sets over at most 256 weighted elements. Quality is covered union weight divided by total weight; valid zero-total-weight cases score 1. Optimal selection is an objective, not a validity requirement. |
| `calibration-online-cache` | Hit-rate objective over at most 10,000 requests, with capacity at most 256. The evaluator owns membership, insertion, hit counting and eviction validation. Only a full-cache miss permits one resident eviction; prefetch and exceeding capacity are invalid. |

Fixtures and their generators are fresh and deterministic. Online fixtures specify deterministic weighted distribution schedules, **not published future-request traces**: the trusted parent samples each request with a private OS random source only after the preceding decision. The worker receives only the current request, resident cache, capacity and hit flag. Realized traces vary between invocations; offline deterministic transition tests do not establish target-host score stability.

The protected evaluator executes candidate code in a separate process rooted in the candidate workspace. Production requires Linux root and root-owned mode-0700 `/capsule` assets; it drops the worker to UID 2000 and applies a fail-closed seccomp filter denying process creation, cross-process reads and signal delivery, and networking, including the `io_uring` entry points. Candidate IPC has a 15-second deadline; all requests in an online case share one deadline rather than restarting it per request. `--offline` is explicitly cooperative, unconfined authoring verification—not a production fallback. A violation in any case invalidates and zero-scores the whole query batch.

Each package has a content-addressed **`manifest.draft.json`**, pinned baseline Git store, hashed compressed fixtures and recorded offline diagnostic observations. There is deliberately no active `manifest.json`: discovery skips the drafts, and the existing scaffold/admission checks reject their explicitly failed ordering reports even if a draft is renamed. Draft IDs will change when baseline or ordering evidence changes; they must not be frozen as admitted calibration IDs.

The approved immutable image reference remains the one in `seeded-astar/manifest.json`. Its local ARM64 launch and isolated baseline checks are preparation evidence, **not validation of the selected execution host**. Full admission still requires target-host image/runtime and resource evidence, isolated diagnostic ordering and stability, independent admission reviews and the Gate-2 receipt chain. The retained offline reports also fail postings shortcut/improved separation and sequence-diff naïve-before-baseline ordering; these gaps remain unresolved, not waived. No image substitution, calibration run, provider call or campaign launch is implied.

Authoring commands, run from the repository root after dependency installation:

```sh
python3 -I -B capsules/tools/prepare-calibration.py
python3 -I -B capsules/test/calibration_checks.py
# Optional offline diagnostic observations; not campaign calibration or admission:
python3 -I -B capsules/tools/prepare-calibration.py --measure
pnpm --filter @hone/capsules exec tsx tools/pin-calibration-drafts.ts
```

Preparation regenerates only these four packages. Pinning commits changed baseline files using the configured Git identity and writes only draft manifests; it never issues an admission receipt. The per-task envelopes retain the approved maxima: 600,000 tokens, $10, two hours, 49 evaluator invocations, 2 GiB and two CPUs. These are limits, not spending or execution authorization. Campaign seeds, bootstrap settings, routes, thresholds and cohort identities are unchanged.

## Terminal source references

The terminal evaluator and task source is inspectable, but private terminal assets, answer banks and selected reconstruction inputs are excluded from the public tree and its published history. Affected source files use explicit unavailable-input placeholders instead of embedded frozen constants.

Terminal directories use `manifest.reference.json`. This records the original contract for inspection; it is not an active admission or a claim that the public directory is executable. Corpus discovery skips directories without an active `manifest.json`.

Complete original terminal bundles remain private, including their original baseline files and Git stores, assets, images and admission records. Do not rename a reference manifest to enable it, or combine the public edited baseline with a subset of private files. Terminal execution uses the complete original bundle through the trusted terminal path.

## Admission and authoring

The production `run` path verifies Gate-2 approval and reads the operator's local admission receipts. Authoring records the source and required identities, runs its gate workflow and appends receipts only for valid transitions. The default authoring boundary still needs an integration to execute queued role requests.

Historical ordering reports describe the inputs and environment of their original check. They are useful evidence, not a portable certificate for a different host, image or edited capsule. Public-clone admission and image preparation remain documented gaps until their supported workflow is validated.
