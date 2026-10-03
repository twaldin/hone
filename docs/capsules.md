# Capsules

A capsule is a task package: objective, pinned baseline, evaluator, declared assets, execution image and budget, bound together by a content-addressed `manifest.json`. A runnable capsule also needs its pinned image and a valid admission receipt chain. Files alone are not a new admission. Changing a protected baseline file or restoring assets beneath a different evaluator cannot reuse the original exact-tree approval.

## Where capsules live

The engine does not ship capsules. Public capsules are in [twaldin/hone-capsules](https://github.com/twaldin/hone-capsules), under its `capsules/` directory, with the same bytes they had when they lived in this repository, so their IDs and manifest digests are unchanged. Point Hone at that directory with `--capsules-root` or `HONE_CAPSULES_ROOT` (see [Getting started](getting-started.md#pointing-hone-at-capsules)). Without either, Hone uses `./capsules` under the directory it runs from.

hone-capsules holds:

- the sixteen development capsules of the recursive cohort, plus `seeded-astar`, the first capsule written for the TypeScript rewrite;
- four calibration capsules (`calibration-bitset-rank`, `calibration-byte-escape`, `calibration-interval-merge`, `calibration-varint-decode`), their shared `calibration-runtime` image definition and the `m2-calibration-selection.json` used by the August 2026 calibration;
- eleven terminal source references (below);
- the improved Leduc CFR+ solver artifacts, without the sealed capsule;
- integration tests that check real capsules against this engine, and the publication notice and per-capsule licenses.

Some baselines include a nested Git object store. Clone hone-capsules with the procedure in its README. Do not reconstruct a baseline by copying only the visible working files and assuming its manifest commit still identifies that copy.

## Development tasks

The development capsules include the approved bounded TradeUp, Monoagent and Floyd implementations. That release covers the derived tasks, not the complete private applications some tasks came from; hone-capsules' `PUBLICATION.md` records it. Source contracts keep historical capsule IDs and digests; a new launch takes its identity from the current admitted manifest.

An asset group named `holdout` inside a development capsule describes visibility within that task's execution protocol. It is distinct from the frozen terminal evaluation set.

## capsule-kit

[`capsule-kit/`](../capsule-kit/) is the workspace package `@hone/capsule-kit`: the tools for building and checking capsules, and the frozen task contracts.

| Path | What it is |
| --- | --- |
| `tools/scaffold.ts` | Writes a capsule's `manifest.json`: hashes every asset, reads the baseline Git commit, embeds the ordering report's hash and derives the content-addressed ID. Re-running over an unchanged tree gives byte-identical output. Admission errors about asset drift point here. |
| `tools/ordering-check.ts` | The trusted ordering check: runs naive, improved, broken and shortcut diagnostics through the broker and writes `ordering-report.json`. `schema/src/ordering.ts` validates its report. |
| `tools/m2-author.ts`, `tools/author-m2-owner-train.ts`, `tools/m2-generic-*.py` | Authoring helpers used to build the M2 cohort capsules. |
| `tools/preflight-m2-*.m*ts`, `tools/ts-aa-probe.mts` | Host preflights and an A-A noise probe used before the M2 campaigns. |
| `contracts/` | The frozen OSS and owner-task contracts (`OSS-*`, `OWN-*`) the cohort capsules were built against. |

The tools read the capsules root from `HONE_CAPSULES_ROOT`, falling back to `./capsules` under the working directory. The CLI's `--capsules-root` flag does not apply to them. Run them from the engine root, for example:

```sh
HONE_CAPSULES_ROOT="$PWD/../hone-capsules/capsules" pnpm --filter @hone/capsule-kit scaffold <capsule-dir>
```

A relative `<capsule-dir>` resolves under the capsules root.

## Terminal source references

Eleven capsules form the terminal set of the recursive experiment: `brotli-codec`, `duckdb-tpch`, `floyd-custom-scoreboard-render`, `flt-workflow-parser`, `harness-pi-readiness`, `mimalloc-allocator`, `node-url`, `quickjs-interpreter`, `sqlite-speedtest1`, `tradeup-query-latency` and `tree-sitter-parse`. Their evaluator and task source is inspectable in hone-capsules, but private terminal assets, answer banks and selected reconstruction inputs are not published. Affected source files use explicit unavailable-input placeholders instead of embedded frozen constants.

Terminal directories use `manifest.reference.json`. It records the original contract for inspection; it is not an active admission or a claim that the public directory is executable. Corpus discovery skips directories without an active `manifest.json`.

Complete original terminal bundles stay private, including their original baseline files and Git stores, assets, images and admission records. Do not rename a reference manifest to enable it, or combine the public edited baseline with a subset of private files. Terminal execution uses the complete original bundle through the trusted terminal path.

## Admission and authoring

The production `run` path verifies Gate-2 approval and reads the operator's local admission receipts from `.hone-cas` under the directory Hone runs from. Authoring records the source and required identities, runs its gate workflow, appends receipts only for valid transitions and writes the new capsule under the capsules root. The default authoring boundary still needs an integration to execute queued role requests.

Historical ordering reports describe the inputs and environment of their original check. They are useful evidence, not a portable certificate for a different host, image or edited capsule. Public-clone admission and image preparation remain documented gaps until their supported workflow is validated.
