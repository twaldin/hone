"""Tests for scorer.py — invocation, JSON path, legacy fallback, metric direction."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from hone.scorer import ScorerError, run_scorer


def _write_scorer(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "scorer.sh"
    p.write_text(f"#!/usr/bin/env bash\nset -e\n{body}\n")
    os.chmod(p, 0o755)
    return p


def test_legacy_fallback_stdout_float(tmp_path: Path) -> None:
    scorer = _write_scorer(tmp_path, 'echo "noise"\necho "0.5"')
    result = run_scorer(scorer, tmp_path)
    assert result.raw_score == pytest.approx(0.5)
    assert result.json_path_used is False
    assert result.returncode == 0


def test_rich_json_result_path(tmp_path: Path) -> None:
    scorer = _write_scorer(
        tmp_path,
        'echo \'{"score": 0.7, "metrics": {"x": 1}, "tasks": [{"id": "a", "score": 1.0}]}\' > "$HONE_RESULT_PATH"\n'
        'echo "0.3"',
    )
    result = run_scorer(scorer, tmp_path)
    assert result.raw_score == pytest.approx(0.7)
    assert result.json_path_used is True
    assert result.metrics == {"x": 1}
    assert result.tasks == [{"id": "a", "score": 1.0}]


def test_json_malformed_falls_back_to_stdout(tmp_path: Path) -> None:
    scorer = _write_scorer(
        tmp_path,
        'echo "not valid json {{{" > "$HONE_RESULT_PATH"\n'
        'echo "0.42"',
    )
    result = run_scorer(scorer, tmp_path)
    assert result.raw_score == pytest.approx(0.42)
    assert result.json_path_used is False


def test_metric_direction_min(tmp_path: Path) -> None:
    scorer = _write_scorer(tmp_path, 'echo "0.3"')
    result = run_scorer(scorer, tmp_path, metric_direction="min")
    assert result.raw_score == pytest.approx(0.3)
    assert result.utility == pytest.approx(-0.3)


def test_metric_direction_max_utility_equals_raw(tmp_path: Path) -> None:
    scorer = _write_scorer(tmp_path, 'echo "0.8"')
    result = run_scorer(scorer, tmp_path, metric_direction="max")
    assert result.utility == pytest.approx(0.8)


def test_non_zero_exit_returns_zero_score(tmp_path: Path) -> None:
    scorer = _write_scorer(tmp_path, 'echo "broken" >&2\nexit 1')
    result = run_scorer(scorer, tmp_path)
    assert result.raw_score == pytest.approx(0.0)
    assert result.returncode == 1
    assert "broken" in result.trace_stderr


def test_tempfile_cleanup(tmp_path: Path) -> None:
    captured: list[str] = []
    scorer = _write_scorer(
        tmp_path,
        'echo "$HONE_RESULT_PATH"\necho "0.5"',
    )
    result = run_scorer(scorer, tmp_path)
    result_path = result.raw_stdout.strip().splitlines()[0]
    assert not Path(result_path).exists()


def test_scorer_not_found_raises(tmp_path: Path) -> None:
    with pytest.raises(ScorerError, match="not found"):
        run_scorer(tmp_path / "no_such_scorer.sh", tmp_path)
