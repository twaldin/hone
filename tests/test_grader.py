"""Tests for grader.py — invocation + score parsing."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from hone.grader import GraderError, run_grader


def _write_grader(tmp_path: Path, body: str) -> Path:
    """Write a one-shot executable grader script."""
    p = tmp_path / "grader.sh"
    p.write_text(f"#!/usr/bin/env bash\nset -e\n{body}\n")
    os.chmod(p, 0o755)
    return p


def test_parses_float_from_last_stdout_line(tmp_path: Path) -> None:
    grader = _write_grader(tmp_path, 'echo "noise"\necho "0.5"')
    prompt = tmp_path / "prompt.md"
    prompt.write_text("hello")

    result = run_grader(grader, prompt)
    assert result.score == 0.5
    assert result.returncode == 0


def test_captures_stderr_trace(tmp_path: Path) -> None:
    grader = _write_grader(
        tmp_path, 'echo "ex1: 3/3 fixed" >&2\necho "ex2: 0/2 failed" >&2\necho "0.6"'
    )
    prompt = tmp_path / "prompt.md"
    prompt.write_text("hello")

    result = run_grader(grader, prompt)
    assert result.score == pytest.approx(0.6)
    assert "ex1: 3/3 fixed" in result.trace_stderr
    assert "ex2: 0/2 failed" in result.trace_stderr


def test_tolerates_leading_nonfloat_lines(tmp_path: Path) -> None:
    grader = _write_grader(
        tmp_path,
        'echo "preamble"\necho "not a number either"\necho ""\necho "0.42"',
    )
    prompt = tmp_path / "prompt.md"
    prompt.write_text("hello")

    result = run_grader(grader, prompt)
    assert result.score == pytest.approx(0.42)


def test_raises_on_unparseable_stdout(tmp_path: Path) -> None:
    grader = _write_grader(tmp_path, 'echo "not a number at all"')
    prompt = tmp_path / "prompt.md"
    prompt.write_text("hello")

    with pytest.raises(GraderError):
        run_grader(grader, prompt)


def test_non_zero_exit_returns_zero_score(tmp_path: Path) -> None:
    grader = _write_grader(
        tmp_path, 'echo "broken" >&2\nexit 1'
    )
    prompt = tmp_path / "prompt.md"
    prompt.write_text("hello")

    result = run_grader(grader, prompt)
    assert result.score == 0.0
    assert result.returncode == 1
    assert "broken" in result.trace_stderr
