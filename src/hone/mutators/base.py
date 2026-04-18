"""Mutator abstraction: turn (current prompt + reflection context) into a new prompt."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


class MutatorError(RuntimeError):
    """Raised when a mutator cannot produce a valid new prompt."""


@dataclass
class MutatorResult:
    """What a mutator returns to hone's proposer."""

    new_prompt: str
    tokens_in: int | None = None
    tokens_out: int | None = None
    cost_usd: float | None = None
    raw_response: str | None = None


class Mutator(ABC):
    """A mutator takes the current prompt + GEPA's reflective_dataset and returns a new prompt.

    Subclasses implement `propose()` — the shape of the underlying invocation
    (subprocess CLI, SDK call, custom script) is entirely up to the subclass.
    """

    #: Short identifier used in logs / run manifest.
    name: str = "mutator"

    def __init__(self, model: str | None = None) -> None:
        self.model = model

    @abstractmethod
    def propose(self, mutator_prompt: str) -> MutatorResult:
        """Given a fully-assembled prompt for the mutator LLM, return its response.

        The caller (proposer.py) has already built the prompt including
        the current variant + reflective context. The mutator's only job
        is to run the LLM and return the new prompt string.
        """

    def __repr__(self) -> str:  # pragma: no cover
        return f"{type(self).__name__}(model={self.model!r})"
