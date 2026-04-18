"""HarnessMutator — proposes new prompts via the `harness` library.

Lets hone target any of harness's adapters (claude-code, opencode, codex,
gemini, aider, swe-agent) without each mutator type reimplementing
subprocess plumbing. Token/cost extraction is handled by the harness
adapter; this class only converts harness's RunResult into a MutatorResult
and pulls the agent's text response out of the per-harness raw output.

Usage from hone CLI:
    --mutator harness:claude-code:sonnet
    --mutator harness:opencode:openai/gpt-5.4
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from hone.mutators.base import Mutator, MutatorError, MutatorResult


class HarnessMutator(Mutator):
    """Wrap harness.run() so hone can mutate via any adapter."""

    name = "harness"

    DEFAULT_TIMEOUT_SECONDS = 300

    def __init__(
        self,
        harness_name: str,
        model: str | None = None,
        workdir: str | Path | None = None,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        super().__init__(model=model)
        self.harness_name = harness_name
        self.workdir = Path(workdir).expanduser() if workdir else None
        self.timeout_seconds = timeout_seconds

    def propose(self, mutator_prompt: str) -> MutatorResult:
        try:
            from harness import HarnessError, RunSpec, run
        except ImportError as e:
            raise MutatorError(
                "harness library not installed. `pip install -e ~/harness` "
                "or add it to your environment."
            ) from e

        # Per-call tmpdir if no fixed workdir — keeps mutator runs isolated.
        if self.workdir is not None:
            workdir_ctx = _NoCleanup(self.workdir)
        else:
            workdir_ctx = tempfile.TemporaryDirectory(prefix="hone-mutator-")

        with workdir_ctx as wd:
            spec = RunSpec(
                harness=self.harness_name,
                prompt=mutator_prompt,
                workdir=Path(wd),
                model=self.model,
                timeout_seconds=self.timeout_seconds,
            )
            try:
                result = run(spec)
            except HarnessError as e:
                raise MutatorError(f"harness {self.harness_name!r}: {e}") from e

        if not result.ok:
            tail = (result.stderr or result.stdout or "").strip()[:500]
            raise MutatorError(
                f"harness {self.harness_name!r} exited {result.exit_code} "
                f"(timed_out={result.timed_out}): {tail}"
            )

        text = _extract_response_text(self.harness_name, result)
        if not text.strip():
            raise MutatorError(
                f"harness {self.harness_name!r} returned empty response. "
                f"stdout head: {result.stdout[:200]!r}"
            )

        return MutatorResult(
            new_prompt=text,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            cost_usd=result.cost_usd,
            raw_response=result.stdout,
        )


def _extract_response_text(harness_name: str, result) -> str:
    """Pull the agent's textual response out of a RunResult.

    Each CLI emits its final message differently. For now we support the
    harnesses that make sense as MUTATORS (LLMs that produce a single text
    answer): claude-code, gemini, anthropic-shaped JSON. Coding-loop
    harnesses (codex/aider/swe-agent) write code — using them as a hone
    mutator doesn't fit cleanly and is left unsupported until there's a
    use case.
    """
    if harness_name == "claude-code":
        envelope = result.raw or {}
        if envelope.get("type") == "result":
            return envelope.get("result") or ""
        return envelope.get("result") or envelope.get("text") or result.stdout

    if harness_name == "gemini":
        # gemini --output-format json puts the model text under "response" or in stdout
        envelope = result.raw or {}
        text = envelope.get("response") or envelope.get("text")
        if text:
            return text
        return result.stdout

    raise MutatorError(
        f"harness {harness_name!r} is not currently usable as a mutator — its output "
        "is a coding loop, not a text response. Use claude-code or gemini for prompt mutation."
    )


class _NoCleanup:
    """Context manager that yields a path without creating/destroying it."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def __enter__(self) -> Path:
        self.path.mkdir(parents=True, exist_ok=True)
        return self.path

    def __exit__(self, *exc) -> None:
        return None
