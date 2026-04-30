"""Structured scorer result parsing for hone graders."""
from __future__ import annotations

import json
from dataclasses import dataclass, field


@dataclass
class ScorerResult:
    """Parsed result from a grader invocation."""

    score: float
    submetrics: dict[str, float] = field(default_factory=dict)
    traces: list[dict] = field(default_factory=list)
    parsed_envelope: dict | None = None
    trace_stderr: str = ""
    raw_stdout: str = ""
    returncode: int = 0


def to_scorer_result(grader_result) -> ScorerResult:
    """Adapt a GraderResult to ScorerResult.

    Uses duck typing to avoid a circular import with hone.grader.
    """
    return ScorerResult(
        score=grader_result.score,
        submetrics=grader_result.submetrics,
        traces=grader_result.traces,
        parsed_envelope=grader_result.parsed_envelope,
        trace_stderr=grader_result.trace_stderr,
        raw_stdout=grader_result.raw_stdout,
        returncode=grader_result.returncode,
    )


def parse_scorer_stdout(
    stdout: str,
) -> tuple[float, dict[str, float], list[dict], dict | None]:
    """Parse grader stdout into (score, submetrics, traces, parsed_envelope).

    Walks stdout lines from end:
    (a) If the last non-empty line is a JSON object with a numeric 'score' key,
        use it as a structured envelope (extracts submetrics and traces too).
    (b) Otherwise fall back to last parseable float; submetrics={}, traces=[],
        parsed_envelope=None (same semantics as _parse_score).

    Raises ValueError if nothing parseable is found.
    """
    lines = stdout.splitlines()

    # Check the last non-empty line for a JSON envelope.
    for line in reversed(lines):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
            if isinstance(obj, dict) and isinstance(obj.get("score"), (int, float)):
                score = float(obj["score"])
                submetrics = {
                    k: float(v)
                    for k, v in obj.get("submetrics", {}).items()
                    if isinstance(v, (int, float))
                }
                traces = [t for t in obj.get("traces", []) if isinstance(t, dict)]
                return score, submetrics, traces, obj
        except (json.JSONDecodeError, ValueError):
            pass
        # Only inspect the last non-empty line for the envelope; stop after first.
        break

    # Float-only fallback: scan all lines from end (identical to _parse_score).
    for line in reversed(lines):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            return float(stripped), {}, [], None
        except ValueError:
            continue

    raise ValueError(
        f"Grader stdout had no parseable float on any line. Got: {stdout[:200]!r}"
    )


def parse_stderr_traces(stderr: str) -> list[dict]:
    """Parse JSON-per-line from stderr into a list of dicts.

    Silently drops lines that are empty or not valid JSON objects.
    """
    traces = []
    for line in stderr.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
            if isinstance(obj, dict):
                traces.append(obj)
        except (json.JSONDecodeError, ValueError):
            pass
    return traces
