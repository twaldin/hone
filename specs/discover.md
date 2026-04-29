# hone discover (skeleton)

## Motivation

`hone` currently requires users to provide a grader and objective upfront. A `discover` surface lets us reserve a first-class CLI entry point for future workflow automation that helps users scaffold benchmark ideas from an existing repository. This mirrors GEPA-style discover skeleton intent: define UX and interfaces first, then iterate on internals.

This patch intentionally ships only the command surface and documentation, so later implementation work does not need to re-litigate naming and invocation shape.

## Proposed UX

```bash
hone discover --src <dir> --suggest <out_dir>
```

- `--src <dir>`: existing source repository/directory to inspect.
- `--suggest <out_dir>`: destination for generated benchmark suggestions and related artifacts.

Current behavior in this medium patch:
- Command exists and parses options.
- Command prints a clear "not yet implemented" stub message.
- Default exit code is `0`.
- `--strict` exits with code `2` so automation can fail fast until implementation lands.

## Data flow (target shape)

Planned high-level flow for a future implementation:
1. Parse CLI inputs (`src`, `suggest`).
2. Read-only inspection of repo metadata and structure.
3. Build candidate benchmark/problem statements.
4. Materialize suggestion artifacts in `suggest`.
5. Emit a concise summary to stdout.

In this patch, only step (1) and the user-facing stub output are implemented.

## v0.1 implementation touchpoints

A future v0.1 would likely touch:
- `src/hone/cli.py`: replace stub command body with orchestration call.
- New module(s) under `src/hone/` for discovery pipeline logic.
- Structured output schema for suggested artifacts.
- Additional tests covering happy path and failure modes.

## Explicitly out of scope for this medium patch

- Any autonomous benchmark construction logic.
- Any repository scanning beyond argument validation.
- Any LLM/provider calls.
- Any writes to user repository or suggestion directories.
- Any mutation of project files beyond this CLI surface and docs/tests.
