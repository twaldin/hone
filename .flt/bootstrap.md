Previous reviewer failure feedback, if this is a retry:


Add a SKELETON-ONLY `hone discover` command + design doc. Do NOT implement autonomous benchmark construction. The goal is to lock the surface and the docs so future work can hang implementation off it without re-litigating UX.

Files to create/modify:
- MODIFY src/hone/cli.py (add a `hone discover` command that prints a 'not yet implemented' message and exits with code 0 by default, or 2 with --strict). Coordinate additively with the cli-config-integration node — keep edits in a small clearly-bounded section.
- CREATE specs/discover.md with: motivation (steal from GEPA's discover skeleton), proposed UX (`hone discover --src <dir> --suggest <out_dir>`), data flow, what a v0.1 implementation would touch, what is explicitly out of scope for the medium patch.
- CREATE tests/test_discover.py: a single typer.testing.CliRunner test asserting the subcommand exists, parses, and prints the stub message.

Do NOT add any logic that scans or modifies user repos. No LLM calls. No filesystem writes outside of stdout.

Before signaling pass, inspect `git diff --name-status main...HEAD`. Revert/remove unrelated flt injection or local environment noise. Do not include CLAUDE.md, .flt/**, pyproject.toml, or uv.lock unless this node task explicitly requires them.

Write a coder.md in your worktree root summarizing: the new subcommand surface and a pointer to specs/discover.md.

flt workflow pass when tests are green and your coder.md handoff is written.