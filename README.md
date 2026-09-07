# Hone

Hone is an experimental engine for improving code against a measured objective. A task is packaged as a **capsule**: a pinned baseline, an evaluator, data, an execution image and a budget. A trusted supervisor runs a mutable optimizer, checks its candidates and records the measured result.

This repository contains the TypeScript rewrite, its development history, capsule implementations and evaluator source. Development continues here. The earlier Python implementation remains in Git history.

The engine implements single-candidate runs, optimizer campaigns and components of recursive optimization. Public onboarding and the complete M2 experiment and evidence-publication workflow are still being completed. Publishing the implementation does not establish a benchmark result.

## Start with the source

Follow [Getting started](docs/getting-started.md) for the checkout procedure, dependency installation and source checks. The repository includes nested Git object stores that need binary attributes in place before checkout.

There is no root build command or published TypeScript CLI installation assumed by these instructions. After installing workspace dependencies, the source launcher is:

```sh
node trusted/cli/bin/hone.js --help
```

Real execution additionally requires an admitted capsule, its exact image and a configured model provider. `hone run` performs one candidate probe. `hone author` currently queues durable authoring work; the default CLI does not launch the authoring agents itself.

## Read more

- [Getting started](docs/getting-started.md): checkout, dependencies and validation.
- [CLI](docs/cli.md): runs, inspection, delivery and campaign commands.
- [Architecture](docs/architecture.md): trusted execution and optimizer boundaries.
- [Capsules](docs/capsules.md): development tasks, admission and terminal references.
- [Methodology](docs/methodology.md): M0, M1, M2 and remaining experiment work.
- [Results](docs/results.md): how evidence will be published and interpreted.

The public tree includes approved derived task implementations and synthetic development fixtures. Frozen terminal inputs and answers remain private. Terminal directories contain source references rather than complete executable bundles; their manifests are named `manifest.reference.json`.
