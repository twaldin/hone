"""Worker ABC and result types for hone's inner worker abstraction.

Stash-per-attempt protocol
--------------------------
The scorer callable passed to Worker.propose (scorer_fn) is provided by
repo_frontier. Each call to scorer_fn(workdir):

  1. Runs run_grader against workdir — grades the current tree.
  2. Runs ``git stash push --include-untracked -m hone-worker-attempt-N``
     so the workdir is restored to parent HEAD for the next attempt.
  3. Returns ScorerResult.

After Worker.propose returns, repo_frontier:

  1. Inspects best_attempt_idx.
  2. Determines the stash ref for that attempt (LIFO: stash@{total-1-push_pos}).
  3. Applies that stash to restore the best attempt's tree.
  4. Drops all stashes.
  5. Strips the seed-playbook marker, ``git add -A``, commits.

For single-attempt workers (LocalWorker) there is always exactly one stash
at ``stash@{0}``.

Worker rules
------------
- MUST NOT commit git state — repo_frontier owns all git operations.
- MUST NOT edit scorer files.
- MUST return WorkerResult with ≥1 attempt, OR set error (with attempts=[]).
- MUST call scorer at most scorer_budget times.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from hone.scorer_result import ScorerResult


class WorkerError(RuntimeError):
    """Raised when a worker spec is invalid or a worker cannot recover."""


@dataclass
class WorkerAttempt:
    """One attempt made by a worker during a single propose() call."""

    attempt_idx: int
    score: float
    submetrics: dict[str, float]
    trace_stderr: str
    raw_stdout: str
    parsed_envelope: dict | None
    commit_sha: str | None  # filled post-commit by repo_frontier; worker leaves None
    notes: str = ""


@dataclass
class WorkerResult:
    """Aggregated result of all attempts from one Worker.propose() call."""

    attempts: list[WorkerAttempt]
    best_attempt_idx: int  # index into attempts; -1 on error
    scorer_calls: int
    tokens_in: int | None
    tokens_out: int | None
    cost_usd: float | None
    error: str | None = None

    @property
    def best_attempt(self) -> WorkerAttempt:
        if not self.attempts or self.best_attempt_idx < 0:
            raise WorkerError("no successful attempt in WorkerResult")
        return self.attempts[self.best_attempt_idx]


class Worker(ABC):
    """Abstract base for hone inner workers."""

    name: str = "worker"

    @abstractmethod
    def propose(
        self,
        *,
        prompt: str,
        workdir: Path,
        scorer: Callable[[Path], ScorerResult],
        scorer_budget: int,
    ) -> WorkerResult:
        """Run one iteration: mutate workdir, call scorer, return best result.

        The caller provides scorer — a callable that grades workdir and stashes
        its tree (see module docstring). The worker may call scorer at most
        scorer_budget times.
        """
