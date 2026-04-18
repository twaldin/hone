# hone

> Optimize any prompt file against any grader. Uses your coding CLI subscriptions as the mutation engine.

```bash
hone run prompt.md \
  --grader ./grader.sh \
  --mutator claude-code:sonnet \
  --budget 20
```

`hone` wraps [GEPA](https://github.com/gepa-ai/gepa)'s Pareto-frontier prompt optimization with a CLI-first interface that uses Claude Code, Codex, OpenCode, or Gemini subscriptions to propose mutations — no API keys required.

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
| `codex` | OpenAI Codex CLI | `codex:gpt-5.4-mini` |
| `opencode` | OpenCode CLI | `opencode:glm-5` |
| `gemini` | Gemini CLI | `gemini:gemini-3-flash-preview` |
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic:claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | `openai:gpt-5.4-mini` |
| `./my-script.sh` | Custom script | `./my-mutator.sh` |

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
