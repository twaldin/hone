"""Grader invocation — runs user's grader script against a candidate prompt."""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from hone.scorer_result import parse_scorer_stdout, parse_stderr_traces


class GraderError(RuntimeError):
    """Raised when a grader cannot be invoked or returns unparseable output."""


@dataclass
class GraderResult:
    """What the grader produced for a single candidate prompt."""

    score: float
    trace_stderr: str
    raw_stdout: str
    returncode: int
    submetrics: dict[str, float] = field(default_factory=dict)
    traces: list[dict] = field(default_factory=list)
    parsed_envelope: dict | None = None


def run_grader(
    grader: str | Path,
    prompt_path: str | Path,
    timeout_seconds: int = 3600,
) -> GraderResult:
    """Run the grader script against a prompt file, parse stdout and stderr.

    Contract:
      - grader is invoked as: `<grader> <prompt_path>`
      - stdout: last non-empty line is a float or a JSON envelope with 'score'
      - stderr: free-form trace; JSON-per-line is collected into traces when
        stdout is float-only
      - non-zero exit is treated as score=0.0; stderr traces are still collected
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
        return GraderResult(
            score=0.0,
            trace_stderr=proc.stderr,
            raw_stdout=proc.stdout,
            returncode=proc.returncode,
            traces=parse_stderr_traces(proc.stderr),
        )

    try:
        score, submetrics, traces, parsed_envelope = parse_scorer_stdout(proc.stdout)
    except ValueError as exc:
        raise GraderError(str(exc)) from exc

    if parsed_envelope is None:
        traces = parse_stderr_traces(proc.stderr)

    return GraderResult(
        score=score,
        trace_stderr=proc.stderr,
        raw_stdout=proc.stdout,
        returncode=0,
        submetrics=submetrics,
        traces=traces,
        parsed_envelope=parsed_envelope,
    )
