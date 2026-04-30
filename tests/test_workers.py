"""Tests for the hone.workers package."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from hone.mutators.base import MutatorResult
from hone.scorer_result import ScorerResult
from hone.workers.base import Worker, WorkerAttempt, WorkerError, WorkerResult
from hone.workers.local_worker import LocalWorker
from hone.workers.resolver import resolve_worker


def _scorer(scores: list[float]):
    """Return a scorer callable that returns successive ScorerResults."""
    it = iter(scores)

    def scorer(workdir: Path) -> ScorerResult:
        score = next(it)
        return ScorerResult(score=score, submetrics={}, trace_stderr="", raw_stdout=str(score))

    return scorer


def test_local_worker_one_attempt_and_scorer_call() -> None:
    mutator = MagicMock()
    mutator.propose_edit_mode.return_value = MutatorResult(
        new_prompt="", tokens_in=5, tokens_out=3, cost_usd=0.01
    )
    scorer = _scorer([0.9])

    worker = LocalWorker(mutator)
    result = worker.propose(prompt="test", workdir=Path("/tmp"), scorer=scorer, scorer_budget=1)

    assert len(result.attempts) == 1
    assert result.scorer_calls == 1
    assert result.best_attempt_idx == 0
    assert result.attempts[0].score == pytest.approx(0.9)
    assert result.error is None
    mutator.propose_edit_mode.assert_called_once()


def test_local_worker_mutator_failure_does_not_call_scorer() -> None:
    mutator = MagicMock()
    mutator.propose_edit_mode.side_effect = RuntimeError("boom")
    scorer = MagicMock()

    worker = LocalWorker(mutator)
    result = worker.propose(prompt="test", workdir=Path("/tmp"), scorer=scorer, scorer_budget=1)

    assert result.attempts == []
    assert result.error == "boom"
    assert result.scorer_calls == 0
    scorer.assert_not_called()


class FakeMultiWorker(Worker):
    """Calls scorer N times, picks the attempt with the highest score."""

    name = "fake_multi"

    def __init__(self, n: int = 3) -> None:
        self._n = n

    def propose(
        self, *, prompt: str, workdir: Path, scorer, scorer_budget: int
    ) -> WorkerResult:
        attempts = []
        for i in range(min(self._n, scorer_budget)):
            sr = scorer(workdir)
            attempts.append(
                WorkerAttempt(
                    attempt_idx=i,
                    score=sr.score,
                    submetrics=sr.submetrics,
                    trace_stderr=sr.trace_stderr,
                    raw_stdout=sr.raw_stdout,
                    parsed_envelope=sr.parsed_envelope,
                    commit_sha=None,
                )
            )
        best_idx = max(range(len(attempts)), key=lambda i: attempts[i].score)
        return WorkerResult(
            attempts=attempts,
            best_attempt_idx=best_idx,
            scorer_calls=len(attempts),
            tokens_in=None,
            tokens_out=None,
            cost_usd=None,
        )


def test_fake_multi_worker_three_attempts_picks_best() -> None:
    scorer = _scorer([0.3, 0.7, 0.5])

    worker = FakeMultiWorker(n=3)
    result = worker.propose(prompt="test", workdir=Path("/tmp"), scorer=scorer, scorer_budget=3)

    assert len(result.attempts) == 3
    assert result.scorer_calls == 3
    assert result.best_attempt_idx == 1
    assert result.attempts[1].score == pytest.approx(0.7)
    assert result.error is None


def test_resolve_worker_local_spec() -> None:
    w = resolve_worker("local", mutator=MagicMock())
    assert isinstance(w, LocalWorker)


def test_resolve_worker_none_spec() -> None:
    w = resolve_worker(None, mutator=MagicMock())
    assert isinstance(w, LocalWorker)


def test_resolve_worker_unknown_raises() -> None:
    with pytest.raises(WorkerError):
        resolve_worker("harness", mutator=MagicMock())
