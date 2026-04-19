# hone

> Optimize any prompt file against any grader. Uses your coding CLI subscriptions as the mutation engine.

```bash
hone run prompt.md \
  --grader ./grader.sh \
  --mutator claude-code:sonnet \
  --budget 20
```

`hone` wraps [GEPA](https://github.com/gepa-ai/gepa)'s Pareto-frontier prompt optimization with a CLI-first interface that uses Claude Code, Codex, OpenCode, or Gemini subscriptions to propose mutations — no API keys required.

## Proof of concept — Claude Haiku 4.5 on real GitHub bugs

Same model, same unseen bugs, only the system prompt differs:

|                          | bare seed prompt (14 words) | hone-discovered prompt (6-step methodology) |
|--------------------------|------------------------------|-----------------------------------------------|
| 20-challenge training    | **0.5476** (55% solve)       | **0.9176** (92%)                              |
| 9-challenge hold-out ×3  | **0.6496** (65%)             | **0.8462** (85%)                              |

**+20 absolute percentage points / +30% relative lift on bugs GEPA never trained on.** All 3 hold-out samples improved; no regressions. 3 GEPA iterations, ~$1 in Sonnet mutator tokens, ~7 hours on a Claude Max subscription. Graded against [agentelo](https://github.com/twaldin/agentelo) challenges (real PRs from `click`, `qs`, `marshmallow`, `jinja`, `koa`, `requests`, `flask`, `fastify`). Full writeup and the honed prompt text: [writeup/2026-04-18-haiku-20train-9holdout.md](writeup/2026-04-18-haiku-20train-9holdout.md).

The discovered prompt isn't bug-specific — it's a methodology prompt that patches a known haiku failure mode (stopping after the first test passes). That's why it transfers.

## Why

Every existing prompt optimizer (GEPA, DSPy, Arize Prompt Learning) requires paid API keys. If you already pay for Claude Pro or ChatGPT Plus, you can use that subscription as the optimization engine by shelling out to the official CLIs. That's what `hone` does.

## Install

```bash
pip install hone
# or
uv pip install hone
```

## Quick start

1. Write a prompt file:

```markdown
# prompt.md
You are a helpful assistant. Answer questions concisely.
```

2. Write a grader script (any executable that reads a prompt file path as `$1`, prints a float on stdout's last line):

```bash
#!/bin/bash
# grader.sh
score=$(my-eval --prompt "$1")
echo "$score"
```

3. Run `hone`:

```bash
hone run prompt.md --grader ./grader.sh --mutator claude-code:sonnet --budget 20
```

`hone` iterates: proposes new variants of your prompt, runs the grader on each, keeps the winners on a Pareto frontier. Final output: the best-scoring variant.

## Mutators

`--mutator <name>:<model>` picks the backend that proposes prompt mutations:

| Mutator | Requires | Example |
|---------|----------|---------|
| `claude-code` | Claude Code CLI + Claude Pro subscription | `claude-code:sonnet` |
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic:claude-sonnet-4-6` |
| `harness:<adapter>` | [`harness`](https://github.com/twaldin/harness) installed | `harness:gemini:gemini-2.5-pro` |
| `./my-script.sh` | Custom script | `./my-mutator.sh` |

The `harness:` prefix dispatches through [twaldin/harness](https://github.com/twaldin/harness), the unified Python interface for AI coding-agent CLIs. Any harness adapter that produces text output (`claude-code`, `gemini`) is usable as a mutator. Coding-loop adapters (`codex`, `aider`, `swe-agent`) raise a clear error.

Adding a new LLM backend used to mean writing a hone mutator class. Now it's "ship a new adapter in harness."

## Grader contract

Your grader script receives the candidate prompt file path as `$1`:

- **stdout**: last line must be a float (the score). Other stdout is ignored.
- **stderr**: structured trace of how the prompt performed. `hone` parses this into GEPA's `reflective_dataset` so the mutator LLM knows what went wrong.

Example grader stderr (per-example breakdown):

```
click-pr2421: 3/3 fixed
koa-1834: 10/7 fixed
qs-pr506: 0/4 failed (modified wrong file)
```

## Citations

`hone` stands on the shoulders of:

- **[GEPA](https://github.com/gepa-ai/gepa)** (MIT) — the Pareto-frontier optimization algorithm. `hone` uses GEPA's `custom_candidate_proposer` hook to plug in CLI mutators.
- **[ACE](https://arxiv.org/abs/2510.04618)** — conceptual inspiration for continuous context engineering.
- **[Arize Prompt Learning](https://docs.arize.com/arize/prompt-engineering/prompt-learning)** — prior art, API-key based. Demonstrated +10% SWE-Bench Lite improvement from optimizing CLAUDE.md alone.
- **[Karpathy's autoresearch](https://karpathy.ai/autoresearch.html)** — the shape of offline improvement loops.
- **[DSPy](https://github.com/stanfordnlp/dspy)** — the BaseLM pattern informs `hone`'s mutator abstraction.

## A note on subscriptions

When you use a subscription mutator (`claude-code`, `codex`, etc.), `hone` shells out to the official CLI as a subprocess. You're using the tool as intended — we're not scraping OAuth tokens or bypassing auth. That said, check your provider's ToS before heavy use. API mutators (`anthropic:`, `openai:`) are also supported for users who prefer that path.

## Status

v0.1 — early alpha. Designed for Python 3.11+.

## License

MIT
