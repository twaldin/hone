"""Grader invocation — thin backwards-compatible shim around scorer.py."""
from __future__ import annotations

from pathlib import Path

from hone.scorer import ScorerError as GraderError
from hone.scorer import ScorerResult as GraderResult
from hone.scorer import run_scorer


def run_grader(
    grader: str | Path,
    prompt_path: str | Path,
    timeout_seconds: int = 3600,
) -> GraderResult:
    return run_scorer(grader, prompt_path, timeout_seconds)
