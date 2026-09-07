# Getting started

Start by inspecting and testing the source. Running a real optimization task has additional admission, image and provider requirements described below.

## Checkout

Some capsules contain a nested Git object store at `baseline/.gitdir`. Upstream attributes inside the baseline can otherwise normalize those binary files during checkout. Install the repository's rules at Git's highest local precedence first:

```sh
git clone --no-checkout https://github.com/twaldin/hone.git
cd hone
git show HEAD:.gitattributes > .git/info/attributes
git checkout main
```

Use a new directory for this procedure. Keep the rules when updating this checkout. The published history preserves development commits, but a historical revision may describe an earlier capsule or protocol; current instructions apply to current main.

The capsule provenance tests verify historical source IDs and digests in Git. They require a full clone; a shallow checkout or downloaded source archive does not contain that evidence.

## Dependencies and source checks

The workspace uses Node.js and pnpm. Its package metadata declares Node 18 or later; the launcher also needs `node:module.register`. The export is being checked with Node 26.6.0 and pnpm 10.13.1. This is a validation environment, not a claim that every earlier Node 18 release works.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node trusted/cli/bin/hone.js --help
```

Packages expose TypeScript source; there is no root `build` script. Tests run workspaces sequentially. Some CLI integration tests exercise Docker when it is available, and some deliberately modify temporary workspace state. Use an isolated checkout for validation.

The proxy's live model-provider smoke test is skipped unless `HONE_LIVE_PROXY_TEST=1` is explicitly set. That opt-in test targets the local proxy on port 8317 and requests a one-token completion; it can consume provider quota. Ordinary proxy tests use local mocks.

These commands check implementation behavior. They do not run or establish an M2 experiment.

## Before a real run

The local backend requires Git, a POSIX host, Docker and the capsule's exact pinned image already present. Image availability, architecture, toolchains and runtime capabilities are capsule-specific. Images are not automatically fetched by the optimizer's `--pull never` execution path.

Mutation also requires a compatible model upstream, configured through `HONE_UPSTREAM_BASE_URL`, an optional `HONE_UPSTREAM_API_KEY`, and the appropriate model route. Keep credentials in the operator's local environment. Campaign routes belong to the frozen campaign configuration.

Production execution verifies the capsule's assets, baseline and Gate-2 admission receipt chain. Publishing files does not transfer the original operator's local admission ledger or runtime images. The public-clone admission and image bootstrap is unfinished; do not disable review checks to make an example run.

The authoring workflow supports gate decisions and durable session requests. Its default session boundary queues those requests rather than starting coding workers. A trusted authoring integration must complete the requested work before approval and execution are possible.

See [Capsules](capsules.md) for the distinction between development packages and terminal source references, and [CLI](cli.md) for available command forms.
