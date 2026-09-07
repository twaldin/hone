# Hone

Hone is an experimental code-improvement engine: give it a measurable objective and a fixed task, and it uses a model-backed optimizer to propose code changes, evaluate them against a baseline and retain accepted improvements.

The code proposing a change does not decide whether it worked. Hone separates the mutable **optimizer** from the trusted machinery that enforces the task's rules, measures candidates and controls delivery.

## What it is for

Hone is designed for bounded problems where an evaluator can distinguish a useful change from a regression. Tasks in this repository include:

- **Performance:** reduce search latency while preserving exact output and staying within a memory ceiling, as in the ripgrep search capsule.
- **Quality under constraints:** retain more useful structured context within a hard character limit, as in the Monoagent context-retention capsule.
- **Optimizer research:** evaluate changes to the optimization code itself across a fixed set of tasks.

These are task objectives, not claims of achieved gains. See [Capsules](docs/capsules.md) for the available task material and its execution requirements.

## How it works

1. **Define the task.** A **capsule** packages the objective, pinned baseline code, evaluator, data, execution image and budget. It declares which files may not change and which data the optimizer may see.
2. **Approve the contract.** Admission checks the capsule's inputs and review receipts. The **trusted supervisor** fixes the run configuration before execution.
3. **Generate a candidate.** The optimizer uses a model-backed coding worker in a sandbox to propose a change within the capsule's constraints.
4. **Measure it.** The trusted runtime runs the evaluator and compares candidate and baseline measurements. A **broker** mediates optimizer operations, enforces budgets and records acceptance decisions; the optimizer's own claims are not authority.
5. **Retain and deliver.** Candidate artifacts, measurements and durable run records stay local. Inspect the accepted candidate and its diff, then explicitly deliver it to a validated repository. Delivery defaults to off.

The ordinary `run` command performs **one candidate probe**, not an open-ended improvement loop. Campaign operations evaluate optimizer changes across frozen task sets; they have separate preparation and authorization requirements.

### Components

| Component | Role |
| --- | --- |
| `capsules/` and `schema/` | Task packages and the contracts for evaluation, runs and campaigns. |
| `optimizer/` | Mutable candidate-generation logic and coding-worker packaging. |
| `trusted/cli/` and `trusted/broker/` | Admission, supervision, authorized execution, durable decisions and delivery. |
| `trusted/proxy/` and `trusted/scoring/` | Model transport and usage metering; scoring calculations. |
| `trusted/meta/` | Optimizer-campaign support. |

See [Architecture](docs/architecture.md) for the trust boundaries and state model.

## Getting started

**Start with the [full-clone checkout procedure](docs/getting-started.md#checkout).** Embedded Git stores require binary attributes **before checkout**; a shallow clone or source archive is insufficient for provenance checks.

After that checkout, install dependencies and inspect the source CLI from the repository root:

```sh
pnpm install --frozen-lockfile
node trusted/cli/bin/hone.js --help
```

This checks the command surface without starting an optimization run. [Getting started](docs/getting-started.md) covers Node/pnpm requirements, source checks and runtime setup; no published CLI installation or root build step is assumed.

### Before running a task

A real local run needs an admitted capsule, Git, a POSIX host, Docker, the exact pinned image already present and a configured model provider. **Public-clone admission and image bootstrap are unfinished**; the files in a clone are not sufficient to launch a task.

Other current boundaries:

- **Authoring:** `author` records an objective and queues durable agent-work requests. The default CLI does not launch those agents; the authoring-agent integration remains unfinished.
- **Campaigns:** optimizer campaigns and recursive-optimization components exist, but the complete **M2** workflow—recursive optimizer improvement and transfer evaluation on a frozen terminal task set—and its evidence publisher are unfinished. No completed M2 result is established here.
- **Terminal tasks:** public terminal directories are source references, not executable bundles; their evaluation inputs and answers remain private.

Use the [CLI reference](docs/cli.md) for command forms, inspection and delivery. See [Methodology](docs/methodology.md) for implemented experiment components and remaining integration work.

## Documentation

| Guide | Read it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | Safe checkout, dependencies, source checks and runtime prerequisites. |
| [CLI](docs/cli.md) | Run, author, inspect, deliver and campaign commands. |
| [Architecture](docs/architecture.md) | Trusted execution, optimizer boundaries and retained state. |
| [Capsules](docs/capsules.md) | Task packages, admission and terminal source references. |
| [Methodology](docs/methodology.md) | Experiment levels and current implementation status. |
| [Results](docs/results.md) | Evidence requirements and what a published result can support. |

## License and publication

Hone and the approved derived tasks use [MIT](LICENSE); third-party code retains its own licenses and notices. See [Publication and preserved identities](PUBLICATION.md) for distribution boundaries and historical capsule metadata.
