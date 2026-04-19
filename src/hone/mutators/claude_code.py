"""Claude Code CLI mutator — thin wrapper that delegates to the harness library.

The `claude -p` subprocess plumbing + JSON envelope parsing now lives in
`harness.adapters.claude_code`. This class exists so `--mutator claude-code[:model]`
continues to resolve through hone's mutator registry without users having to
type `harness:claude-code:...`.
"""
from __future__ import annotations

from hone.mutators.base import Mutator, MutatorResult
from hone.mutators.harness_mutator import HarnessMutator


class ClaudeCodeMutator(Mutator):
    """Delegate to harness's claude-code adapter. Kept for CLI ergonomics."""

    name = "claude-code"
    DEFAULT_MODEL = "sonnet"

    def propose(self, mutator_prompt: str) -> MutatorResult:
        delegate = HarnessMutator(
            harness_name="claude-code",
            model=self.model or self.DEFAULT_MODEL,
        )
        return delegate.propose(mutator_prompt)
