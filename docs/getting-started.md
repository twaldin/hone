# Getting started

Start by inspecting and testing the engine. Running a real optimization task has additional capsule, admission, image and provider requirements described below.

## Checkout

```sh
git clone https://github.com/twaldin/hone.git
cd hone
```

This repository holds only the engine, so an ordinary clone is enough. Capsules live in [twaldin/hone-capsules](https://github.com/twaldin/hone-capsules); you only need that checkout to run a task, not to build or test the engine. The published history keeps development commits back to the original Python Hone, but a historical revision may describe an earlier layout or protocol; current instructions apply to current main.

## Dependencies and source checks

The workspace uses Node.js and pnpm. Its package metadata declares Node 18 or later; the launcher also needs `node:module.register`. The split was checked with pnpm 10.13.1 on Node 18.20.8 (macOS, full suite) and Node 24.18.0 (Linux, broker suite). Those are validation environments, not a claim that every Node 18 release works.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node trusted/cli/bin/hone.js --help
```

Packages expose TypeScript source; there is no root `build` script. Tests run workspaces sequentially and use synthetic fixtures under `fixtures/`, never a capsules checkout. Some CLI integration tests exercise Docker when it is available, and some deliberately modify temporary workspace state. Use an isolated checkout for validation. The broker's end-to-end tests need Linux (abstract Unix sockets) and Docker; on other hosts they are skipped or fail at setup, which says nothing about the code under test.

The proxy's live model-provider smoke test is skipped unless `HONE_LIVE_PROXY_TEST=1` is explicitly set. That opt-in test targets the local proxy on port 8317 and requests a one-token completion; it can consume provider quota. Ordinary proxy tests use local mocks.

These commands check implementation behavior. They do not run or establish an M2 experiment.

## Pointing Hone at capsules

Commands that discover capsules by name (campaign freeze, corpus discovery, calibration, authoring output) read them from a **capsules root**:

1. `--capsules-root <dir>` on the command line, if given;
2. otherwise the `HONE_CAPSULES_ROOT` environment variable;
3. otherwise `./capsules` under the directory Hone runs from.

A relative value resolves against the current directory. An explicit flag or variable must name an existing directory, or the command stops with a usage error. Records written before the split name repository paths such as `capsules/biome-parser-formatter/baseline/eval.py` (in an image re-pin's evidence) or `capsules/calibration-bitset-rank` (in the calibration selection); Hone maps any recorded `capsules/<rest>` path to `<capsules root>/<rest>`, so those records keep working whatever the root is called.

With hone-capsules cloned next to the engine:

```sh
export HONE_CAPSULES_ROOT=../hone-capsules/capsules
```

`hone run <capsule-dir>` takes the capsule directory directly and works with any path. Run state (`.hone-runs`, `.hone-cas` with its admission receipts, `.hone-sources`) stays under the directory Hone runs from, not in the capsules checkout.

Follow the hone-capsules README to clone it: some capsules embed a Git object store under `baseline/.gitdir` that a plain clone can corrupt, and a capsule whose bytes changed no longer matches its manifest digest.

## Before a real run

The local backend requires Git, a POSIX host, Docker and the capsule's exact pinned image already present. Image availability, architecture, toolchains and runtime capabilities are capsule-specific. Images are not automatically fetched by the optimizer's `--pull never` execution path.

Mutation also requires a compatible model upstream, configured through `HONE_UPSTREAM_BASE_URL`, an optional `HONE_UPSTREAM_API_KEY`, and the appropriate model route. Keep credentials in the operator's local environment. Campaign routes belong to the frozen campaign configuration.

Production execution verifies the capsule's assets, baseline and Gate-2 admission receipt chain. Publishing files does not transfer the original operator's local admission ledger or runtime images. The public-clone admission and image bootstrap is unfinished; do not disable review checks to make an example run.

The authoring workflow supports gate decisions and durable session requests. Its default session boundary queues those requests rather than starting coding workers. A trusted authoring integration must complete the requested work before approval and execution are possible.

See [Capsules](capsules.md) for the distinction between development packages and terminal source references, and [CLI](cli.md) for available command forms.
