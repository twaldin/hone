"""Mutator adapters — backends that propose new prompt variants."""
from __future__ import annotations

from hone.mutators.base import Mutator, MutatorError, MutatorResult
from hone.mutators.claude_code import ClaudeCodeMutator
from hone.mutators.custom_script import CustomScriptMutator

# Registry: slug -> factory(model: str | None) -> Mutator
_REGISTRY: dict[str, type[Mutator]] = {
    "claude-code": ClaudeCodeMutator,
}


def resolve(spec: str) -> Mutator:
    """Parse a --mutator spec into a Mutator instance.

    Examples:
        "claude-code:sonnet"            -> ClaudeCodeMutator(model="sonnet")
        "claude-code"                   -> ClaudeCodeMutator(model=None)
        "./mutate.sh"                   -> CustomScriptMutator("./mutate.sh")
        "/abs/path/to/mutate.sh"        -> CustomScriptMutator("/abs/...")
    """
    # Custom script: anything starting with ./ / / or ending in .sh / .py
    if spec.startswith(("./", "/")) or spec.endswith((".sh", ".py")):
        return CustomScriptMutator(spec)

    if ":" in spec:
        backend, model = spec.split(":", 1)
    else:
        backend, model = spec, None

    if backend not in _REGISTRY:
        available = ", ".join(sorted(_REGISTRY)) or "(none)"
        raise ValueError(
            f"Unknown mutator backend: {backend!r}. "
            f"Available: {available}. Or pass a script path like './mutate.sh'."
        )

    return _REGISTRY[backend](model=model)


__all__ = [
    "ClaudeCodeMutator",
    "CustomScriptMutator",
    "Mutator",
    "MutatorError",
    "MutatorResult",
    "resolve",
]
