"""GEPA custom_candidate_proposer hook — routes mutation requests to our mutator.

GEPA's hook signature (from research):
    proposer(candidate, reflective_dataset, components_to_update) -> dict[str, str]

Where `candidate` is the current component map {name: prompt_text} and
`reflective_dataset` is {name: [{example_id, score, trace}, ...]}.

We build a mutator prompt from these, hand it to the configured Mutator, and
return the new component map.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from hone.mutators.base import Mutator, MutatorError, MutatorResult


@dataclass
class ProposalStats:
    """Accumulated mutator-call telemetry for the run."""

    calls: int = 0
    failures: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0


@dataclass
class HoneProposer:
    """GEPA custom_candidate_proposer implementation.

    Usage:
        proposer = HoneProposer(mutator=ClaudeCodeMutator())
        gepa.optimize(..., custom_candidate_proposer=proposer)
    """

    mutator: Mutator
    max_retries: int = 3
    stats: ProposalStats = field(default_factory=ProposalStats)

    def __call__(
        self,
        candidate: dict[str, str],
        reflective_dataset: dict[str, list[dict[str, Any]]],
        components_to_update: list[str],
    ) -> dict[str, str]:
        out: dict[str, str] = {}
        for component in components_to_update:
            current = candidate.get(component, "")
            rows = reflective_dataset.get(component, [])
            prompt = _build_mutator_prompt(current, rows, component)
            result = self._try_propose(prompt)
            self._account(result)
            out[component] = result.new_prompt
        return out

    def _try_propose(self, prompt: str) -> MutatorResult:
        last_err: MutatorError | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                return self.mutator.propose(prompt)
            except MutatorError as e:
                last_err = e
                self.stats.failures += 1
                continue
        raise MutatorError(
            f"Mutator failed after {self.max_retries} attempts: {last_err}"
        ) from last_err

    def _account(self, r: MutatorResult) -> None:
        self.stats.calls += 1
        if r.tokens_in:
            self.stats.tokens_in += r.tokens_in
        if r.tokens_out:
            self.stats.tokens_out += r.tokens_out
        if r.cost_usd:
            self.stats.cost_usd += r.cost_usd


def _build_mutator_prompt(
    current: str,
    rows: list[dict[str, Any]],
    component: str,
) -> str:
    """Compose the LLM-facing prompt.

    Style: declarative, tells the LLM what to read, what to return. Mirrors
    the shape of GEPA's default InstructionProposalSignature but formatted
    as a standalone prompt (since we're bypassing DSPy signatures).
    """
    trace_lines: list[str] = []
    for row in rows:
        ex_id = row.get("example_id", "?")
        score = row.get("score")
        trace = row.get("trace", "")
        score_str = f" (score={score:.3f})" if isinstance(score, (int, float)) else ""
        trace_lines.append(f"  {ex_id}{score_str}: {trace}")

    trace_block = "\n".join(trace_lines) if trace_lines else "  (no per-example feedback)"

    return (
        f"You are improving a prompt so it scores higher on an evaluation.\n\n"
        f"The prompt governs a component named: {component}\n\n"
        f"=== CURRENT PROMPT ===\n"
        f"{current}\n\n"
        f"=== HOW IT PERFORMED ===\n"
        f"{trace_block}\n\n"
        f"=== YOUR TASK ===\n"
        f"Return ONLY the improved prompt text. No preamble, no explanation, "
        f"no code fences. Just the new prompt, ready to replace the current one.\n"
    )
