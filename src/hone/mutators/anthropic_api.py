"""Anthropic SDK mutator — uses ANTHROPIC_API_KEY (not subscription).

Fallback for users who don't have claude-code CLI installed, or for running
in CI/servers where subscription auth isn't available.
"""
from __future__ import annotations

import os

from hone.mutators.base import Mutator, MutatorError, MutatorResult


class AnthropicApiMutator(Mutator):
    """Call Anthropic's messages API directly. Requires ANTHROPIC_API_KEY."""

    name = "anthropic"
    DEFAULT_MODEL = "claude-sonnet-4-6"
    MAX_TOKENS = 8000

    def propose(self, mutator_prompt: str) -> MutatorResult:
        try:
            from anthropic import Anthropic
        except ImportError as e:  # pragma: no cover
            raise MutatorError(
                "anthropic package missing. pip install anthropic"
            ) from e

        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise MutatorError(
                "ANTHROPIC_API_KEY not set. "
                "Use `--mutator claude-code:sonnet` to use your subscription instead, "
                "or set the API key."
            )

        model = self.model or self.DEFAULT_MODEL
        client = Anthropic()
        try:
            response = client.messages.create(
                model=model,
                max_tokens=self.MAX_TOKENS,
                messages=[{"role": "user", "content": mutator_prompt}],
            )
        except Exception as e:  # pragma: no cover
            raise MutatorError(f"Anthropic API error: {e}") from e

        # Extract text from the response
        text_blocks = [b.text for b in response.content if getattr(b, "type", None) == "text"]
        text = "\n".join(text_blocks).strip()
        if not text:
            raise MutatorError("Anthropic API returned empty response")

        tokens_in = response.usage.input_tokens + getattr(response.usage, "cache_read_input_tokens", 0) + getattr(response.usage, "cache_creation_input_tokens", 0)
        tokens_out = response.usage.output_tokens

        return MutatorResult(
            new_prompt=text,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=None,  # Anthropic doesn't return cost in the response; user computes.
        )
