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

_KIND_LANGUAGE: dict[str, str] = {
    "code:python": "Python",
    "code:typescript": "TypeScript",
    "code:javascript": "JavaScript",
    "code:go": "Go",
    "code:rust": "Rust",
}


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
        proposer = HoneProposer(mutator=ClaudeCodeMutator(), kind="code:python")
        gepa.optimize(..., custom_candidate_proposer=proposer)
    """

    mutator: Mutator
    kind: str = "prompt"
    max_retries: int = 3
    stats: ProposalStats = field(default_factory=ProposalStats)

    def __call__(
        self,
        candidate: dict[str, str],
        reflective_dataset: dict[str, list[dict[str, Any]]],
        components_to_update: list[str],
    ) -> dict[str, str]:
        import os

        debug = os.environ.get("HONE_DEBUG") == "1"
        out: dict[str, str] = {}
        for component in components_to_update:
            current = candidate.get(component, "")
            rows = reflective_dataset.get(component, [])
            if debug:
                print(
                    f"[hone debug] component={component!r} "
                    f"current_len={len(current)} n_rows={len(rows)}"
                )
                for r in rows[:5]:
                    print(f"[hone debug]   row: {r}")
            prompt = _build_mutator_prompt(current, rows, component, self.kind)
            if debug:
                print(f"[hone debug] mutator_prompt_len={len(prompt)}")
            result = self._try_propose(prompt)
            self._account(result)

            if self.kind == "code:python":
                result = self._syntax_check_python(result, prompt)

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

    def _syntax_check_python(self, result: MutatorResult, original_prompt: str) -> MutatorResult:
        import ast

        try:
            ast.parse(result.new_prompt)
            return result
        except SyntaxError as err:
            print(f"[hone] syntax check failed (attempt 1): {err}")
            retry_prompt = (
                f"{original_prompt}\n\n"
                f"=== SYNTAX ERROR IN PREVIOUS OUTPUT ===\n"
                f"Your previous output failed Python syntax check: {err}\n"
                f"Return ONLY the complete valid Python module. No prose, no markdown fences."
            )
            try:
                result2 = self.mutator.propose(retry_prompt)
                self._account(result2)
                ast.parse(result2.new_prompt)
                return result2
            except SyntaxError as err2:
                self.stats.failures += 1
                raise MutatorError(
                    f"invalid_output: syntax check failed twice. Last error: {err2}"
                ) from err2
            except MutatorError as e:
                self.stats.failures += 1
                raise MutatorError(f"invalid_output: retry mutator call failed: {e}") from e

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
    kind: str = "prompt",
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

    language = _KIND_LANGUAGE.get(kind)
    if language:
        return (
            f"You are editing a {language} module.\n"
            f"Do not use Edit or Write tools. Output ONLY the complete replacement module body as plain text.\n"
            f"NO prose. NO markdown fences (no ``` anywhere). NO explanations.\n"
            f"Output must parse as valid {language}.\n\n"
            f"=== CURRENT {language.upper()} MODULE ===\n"
            f"{current}\n\n"
            f"=== HOW IT PERFORMED ===\n"
            f"{trace_block}\n\n"
            f"=== YOUR TASK ===\n"
            f"Return ONLY the complete replacement {language} module. No preamble, no markdown fences. Just the code.\n"
        )

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
