# Citations & related work

`hone` is mostly a CLI+ergonomics layer on top of existing research. This document credits the work we build on.

## GEPA — our core algorithm

[gepa-ai/gepa](https://github.com/gepa-ai/gepa) (MIT license)

`hone` uses GEPA's `gepa.optimize()` engine and plugs into its `custom_candidate_proposer` hook. We do NOT reimplement:

- The Pareto frontier (per-validation-example tracking)
- The candidate selection strategy (uniform sampling across frontier)
- The `reflective_dataset` API for per-example feedback
- GEPA's default `InstructionProposalSignature` mutator template

What `hone` adds on top:

- CLI interface (GEPA is a Python library)
- Subscription-based mutators (Claude Code, Codex, OpenCode, Gemini CLIs)
- A Unix grader contract (stdout = score, stderr = trace)
- Persistent runs with resume (`.hone/run-<id>/`)
- Live TUI progress display

## ACE — conceptual inspiration

[Agentic Context Engineering](https://arxiv.org/abs/2510.04618)

ACE proposes continuous playbook updates via delta operations during execution. `hone` currently runs offline (batch optimization), but ACE's helpful/harmful counter concept may inform a future streaming mode.

Note: the public ACE reference implementation only implements ADD operations and counter increments. UPDATE/MERGE/DELETE are TODOs in the public repo. `hone` does not depend on ACE code today.

## Arize Prompt Learning — prior art

[Arize Prompt Learning](https://docs.arize.com/arize/prompt-engineering/prompt-learning)

Arize demonstrated that optimizing CLAUDE.md against SWE-Bench Lite yields ~10% pass-rate improvement. They use LLM-as-judge graders with API keys. `hone` covers the same pattern with subscription-based mutators and a generalized grader contract.

## Karpathy's autoresearch — the shape

[karpathy.ai/autoresearch.html](https://karpathy.ai/autoresearch.html)

Karpathy's autoresearch (train.py + prepare.py + program.md) is the shape of offline improvement loops. `hone` is effectively "autoresearch where the AI iterates on the prompt, not the training code."

## DSPy — patterns, not code

[stanfordnlp/dspy](https://github.com/stanfordnlp/dspy)

DSPy's `BaseLM` subclass pattern is worth citing as conceptual influence for `hone`'s `Mutator` abstraction. `hone` does not depend on DSPy directly.

## The subscription angle

No published work (as of April 2026) has packaged GEPA-style optimization with CLI-subscription mutators. Verified gap:

- Anthropic issue #42106 shows users requesting this path
- No npm/PyPI package exists today
- Arize, Opik, promptimal, prompt-ops, and Nous all require API keys

That's the niche `hone` fills.
