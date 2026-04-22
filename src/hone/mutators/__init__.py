"""Mutator resolver — v1 supports only harness-backed mutators."""
from __future__ import annotations

from hone.mutators.base import Mutator, MutatorError, MutatorResult
from hone.mutators.harness_mutator import HarnessMutator


def resolve(spec: str) -> Mutator:
    """Parse a --mutator spec into a Mutator instance.

    Only `harness:<adapter>[:<model>]` is supported in v1.

    Examples:
        "harness:claude-code:sonnet"
        "harness:opencode:openai/gpt-5.3-codex-spark"
        "harness:codex:gpt-5.3-codex"
    """
    if not spec.startswith("harness:"):
        raise ValueError(
            f"v1 only supports harness-backed mutators. Got {spec!r}. "
            f"Use e.g. 'harness:claude-code:sonnet' or 'harness:opencode:openai/gpt-5.4'."
        )
    rest = spec[len("harness:"):]
    if not rest:
        raise ValueError(
            "harness mutator spec must include an adapter name, e.g. 'harness:claude-code:sonnet'"
        )
    if ":" in rest:
        harness_name, model = rest.split(":", 1)
    else:
        harness_name, model = rest, None
    return HarnessMutator(harness_name=harness_name, model=model)


__all__ = [
    "HarnessMutator",
    "Mutator",
    "MutatorError",
    "MutatorResult",
    "resolve",
]
