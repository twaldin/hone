Implemented a skeleton-only `hone discover` command surface.

## What changed

- Added `discover` subcommand in `src/hone/cli.py`.
  - Args: `--src <dir>`, `--suggest <out_dir>`.
  - Behavior: prints a not-yet-implemented stub message.
  - Exit codes: `0` by default, `2` when `--strict` is passed.
- Added `tests/test_discover.py` with one CLI test validating the command exists, parses required options, and prints the stub message.
- Added `specs/discover.md` documenting motivation, UX, data flow, likely v0.1 touchpoints, and explicit out-of-scope items.

See `specs/discover.md` for the design details of the new discover surface.
