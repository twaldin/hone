# hone

> ## Read the source papers first — I can't explain them better than they do
>
> - **GEPA** ([repo](https://github.com/gepa-ai/gepa)) — reflective Pareto optimizer. The core loop `hone` implements.
> - **ACE** ([arxiv 2510.04618](https://arxiv.org/abs/2510.04618), Zhang et al., ICLR 2026) — reflector/curator context engineering. The observer loop `hone` ports.
>
> `hone` is the composition and implementation of these ideas, with one addition: the mutator is an **agentic coding CLI** (Claude Code, Codex, Gemini, Aider, opencode via [harness](https://github.com/twaldin/harness)) rather than a single-completion API call. The agent reads the codebase, runs tools, and iterates internally inside a single mutator step.

v0.3 adds multi-file targeting (`--dir`), a dynamic scheduler that picks which
file to mutate per iteration based on diagnosed bottlenecks, and an ACE
observer that incrementally edits the mutator's `CLAUDE.md` between iterations.

## What this is

An optimizer that calls `claude-code` (or any CLI agent) as the mutation step,
then uses your grader to score each candidate, then keeps the best. GEPA
handles the Pareto-frontier bookkeeping; `hone` handles the coding-agent
dispatch, the grader contract, and the multi-file / observer machinery on top.

Use it when your improvement target is code or instructions that a coding
agent can edit, and you have a script that scores the result.

## What this isn't

- **Not another prompt-only optimizer.** `hone` is GEPA's `optimize_anything`
  applied to source files via coding agents. The mutator gets Edit-tool
  access and a workdir, not just a text completion.
- **Not an API-key wrapper.** The default mutator is `claude-code`, which uses
  your Claude subscription. API backends (`anthropic:`, `openai:`) are
  available but not required.
- **Not tied to a single model.** Any CLI agent exposed through
  [harness](https://github.com/twaldin/harness) works as a mutator.

## Install

```bash
pip install git+https://github.com/twaldin/hone
```

> The PyPI name `hone` is currently taken by an unrelated project. A public
> PyPI release under a different name is pending.

Requires Python 3.11+ and a coding CLI on your `PATH` (e.g. `claude-code`).

## Quickstart: pack circles

```bash
git clone https://github.com/twaldin/hone
cd hone/examples/circle-packing
hone run placer.py --grader ./grader.sh --mutator claude-code:sonnet --budget 10
```

`placer.py` seeds with a grid packing (score `4.666667`). Each iteration the
mutator rewrites it; good solutions push past `5.0` within a few iterations
and a few minutes of wall time. See `examples/circle-packing/README.md` for
the full explainer, including a variant with the ACE observer.

## v0.3 features

| flag | purpose |
|------|---------|
| `--dir <path>` | Optimize every mutable file under a directory as one candidate. Scheduler picks one file per iteration. Single-file mode still works with no flag. |
| `--scheduler <name>` | `round-robin` (default), `diagnose` (routes on grader-reported fail classes), `random`. Only meaningful with `--dir`. |
| `--observer <cli>:<model>` | Enable the ACE observer. Reflector is the given agent; curator is deterministic Python that applies deltas to the `managed:ace` block of the mutator's `CLAUDE.md`. Off by default. |
| `--observer-interval N` | Fire the observer every N iterations. Default 10. |
| `--observer-window N` | How many most-recent mutation rows the observer reads. Default 20. |

The observer is a port of [Zhang et al. (ICLR
2026)](https://arxiv.org/abs/2510.04618). Reflector = LLM; Curator =
deterministic Python. Auto-applied edits are rolled back automatically if the
5-iteration rolling score drops after an update.

## See it on something hard

[`hone-a-drone`](https://github.com/twaldin/hone-a-drone) runs `hone` against
a quadrotor flight controller on a physics-sim racing course. Headline result
from a single-file v0.1 run:

- **+33% aggregate** score gain across all difficulty levels
- **+270%** on level 2 (the hardest non-trivial tier)
- **+100%** on level 3 (from zero completions to reliable ones)
- 13 mutator calls, `$4.08` in subscription wall costs

See that repo for the full log, the seed controller, and the honed
controller.

## Grader contract

Your grader is called as `<grader> <path>`:

- **stdout**: last line is the score (a float). Higher is better.
- **stderr**: one JSON object per rollout, fed back to the mutator (and to
  the diagnose scheduler). Include `fail_class` or domain-specific fields to
  enable routing.

Example stderr line from the circle-packing grader:

```json
{"n": 12, "valid": true, "score": 1.5}
```

## Credits

- [GEPA](https://github.com/gepa-ai/gepa) (Khattab et al.) — the Pareto
  optimization algorithm and the `optimize_anything` API `hone` implements.
- [ACE](https://arxiv.org/abs/2510.04618) (Zhang et al., ICLR 2026) — the
  reflector-curator context-engineering loop ported for the observer.
- [harness](https://github.com/twaldin/harness) — the unified adapter layer
  that lets `hone` treat every coding CLI (Claude Code, Codex, Gemini, Aider,
  opencode, swe-agent) as one kind of mutator.

## Prior work in this repo

A v0.1 run improved Claude Haiku 4.5's bug-fixing solve rate from 55% to 92%
on 20 training bugs and 65% → 85% on a held-out 9-bug set, by evolving the
system prompt alone. Full writeup:
[`writeup/2026-04-18-haiku-20train-9holdout.md`](writeup/2026-04-18-haiku-20train-9holdout.md).

## License

MIT.
