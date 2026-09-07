# Capsules and public data

A runnable capsule needs its manifest, exact baseline, evaluator, declared assets, pinned image and valid admission receipt chain. Files alone are not a new admission. Changing a protected baseline file or restoring assets beneath a different evaluator cannot reuse the original exact-tree approval.

## Development tasks

The public repository includes development tasks and synthetic fixtures, including the approved bounded TradeUp, Monoagent and Floyd implementations. This release covers the derived tasks in this repository, not the complete private applications from which some tasks originated.

The [publication notice](../PUBLICATION.md) records their MIT release and supersedes the earlier distribution restrictions preserved inside identity-bearing metadata. Source contracts retain historical capsule IDs and digests; a new launch takes its identity from the current admitted manifest.

An asset group named `holdout` inside a development capsule describes visibility within that task's execution protocol. It is distinct from the frozen terminal evaluation set. The approved synthetic development fixtures may be public while the terminal inputs and answers remain withheld.

Some baselines include a nested Git object store. Preserve its bytes using the [checkout procedure](getting-started.md#checkout). Do not reconstruct a baseline by copying only the visible working files and assuming its manifest commit still identifies that copy.

## Terminal source references

The terminal evaluator and task source is inspectable, but private terminal assets, answer banks and selected reconstruction inputs are excluded from the public tree and its published history. Affected source files use explicit unavailable-input placeholders instead of embedded frozen constants.

Terminal directories use `manifest.reference.json`. This records the original contract for inspection; it is not an active admission or a claim that the public directory is executable. Corpus discovery skips directories without an active `manifest.json`.

Complete original terminal bundles remain private, including their original baseline files and Git stores, assets, images and admission records. Do not rename a reference manifest to enable it, or combine the public edited baseline with a subset of private files. Terminal execution uses the complete original bundle through the trusted terminal path.

## Admission and authoring

The production `run` path verifies Gate-2 approval and reads the operator's local admission receipts. Authoring records the source and required identities, runs its gate workflow and appends receipts only for valid transitions. The default authoring boundary still needs an integration to execute queued role requests.

Historical ordering reports describe the inputs and environment of their original check. They are useful evidence, not a portable certificate for a different host, image or edited capsule. Public-clone admission and image preparation remain documented gaps until their supported workflow is validated.
