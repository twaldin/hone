"""LocalWorker: wraps a Mutator and reproduces hone's original one-shot behavior."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from hone.scorer_result import ScorerResult
from hone.workers.base import Worker, WorkerAttempt, WorkerResult


class LocalWorker(Worker):
    """One mutator call, one scorer call per propose() — identical to the original loop."""

    name = "local"

    def __init__(self, mutator) -> None:
        self._mutator = mutator

    def propose(
        self,
        *,
        prompt: str,
        workdir: Path,
        scorer: Callable[[Path], ScorerResult],
        scorer_budget: int,
    ) -> WorkerResult:
        if scorer_budget < 1:
            return WorkerResult(
                attempts=[],
                best_attempt_idx=-1,
                scorer_calls=0,
                tokens_in=None,
                tokens_out=None,
                cost_usd=None,
                error="scorer budget exhausted",
            )

        try:
            result = self._mutator.propose_edit_mode(prompt, workdir=workdir)
        except Exception as exc:
            return WorkerResult(
                attempts=[],
                best_attempt_idx=-1,
                scorer_calls=0,
                tokens_in=None,
                tokens_out=None,
                cost_usd=None,
                error=str(exc),
            )

        sr = scorer(workdir)
        attempt = WorkerAttempt(
            attempt_idx=0,
            score=sr.score,
            submetrics=sr.submetrics,
            trace_stderr=sr.trace_stderr,
            raw_stdout=sr.raw_stdout,
            parsed_envelope=sr.parsed_envelope,
            commit_sha=None,
        )
        return WorkerResult(
            attempts=[attempt],
            best_attempt_idx=0,
            scorer_calls=1,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            cost_usd=result.cost_usd,
        )
