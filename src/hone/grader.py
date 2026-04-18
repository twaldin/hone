"""Grader invocation — runs user's grader script against a candidate prompt."""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class GraderError(RuntimeError):
    """Raised when a grader cannot be invoked or returns unparseable output."""


@dataclass
class GraderResult:
    """What the grader produced for a single candidate prompt."""

    score: float
    trace_stderr: str
    raw_stdout: str
    returncode: int


def run_grader(
    grader: str | Path,
    prompt_path: str | Path,
    timeout_seconds: int = 3600,
) -> GraderResult:
    """Run the grader script against a prompt file, parse stdout and stderr.

    Contract:
      - grader is invoked as: `<grader> <prompt_path>`
      - stdout: the LAST non-empty line must be a float (the score)
      - stderr: free-form trace, passed to the mutator LLM via reflective_dataset
      - non-zero exit is logged but treated as score=0.0 (caller decides what to do)
    """
    grader_path = Path(grader).expanduser().resolve()
    if not grader_path.exists():
        raise GraderError(f"Grader not found: {grader_path}")

    try:
        proc = subprocess.run(  # noqa: S603
            [str(grader_path), str(prompt_path)],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise GraderError(
            f"Grader timed out after {timeout_seconds}s"
        ) from e

    if proc.returncode != 0:
        # Grader failure -> score 0.0, but preserve the stderr for the trace.
        return GraderResult(
            score=0.0,
            trace_stderr=proc.stderr,
            raw_stdout=proc.stdout,
            returncode=proc.returncode,
        )

    score = _parse_score(proc.stdout)
    return GraderResult(
        score=score,
        trace_stderr=proc.stderr,
        raw_stdout=proc.stdout,
        returncode=0,
    )


def _parse_score(stdout: str) -> float:
    """Extract the final float from stdout. Tolerates leading junk."""
    for line in reversed(stdout.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            return float(stripped)
        except ValueError:
            continue
    raise GraderError(
        f"Grader stdout had no parseable float on any line. Got: {stdout[:200]!r}"
    )
