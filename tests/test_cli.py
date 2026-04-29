"""Tests for CLI — hone run, hone init, hone optimize.

No real harness or optimize_repo_frontier call is made.
Both hone.cli.resolve_mutator and hone.cli.optimize_repo_frontier are
monkeypatched so tests never spawn a coding agent or touch the filesystem
beyond tmp_path.
"""
from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from hone.cli import app
from hone.mutators.base import MutatorResult
from hone.repo_frontier import RepoFrontierResult

runner = CliRunner()


class _FakeMutator:
    def propose_edit_mode(self, prompt: str, workdir: Path | None = None) -> MutatorResult:
        return MutatorResult(new_prompt="")


def _fake_result(run_dir: Path) -> RepoFrontierResult:
    return RepoFrontierResult(
        best_score=0.9,
        best_sha="abc123def456",
        total_iterations=5,
        mutator_calls=5,
        mutator_failures=0,
        mutator_tokens_in=100,
        mutator_tokens_out=50,
        mutator_cost_usd=0.001,
        run_dir=run_dir,
    )


def _setup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, optimize_fn: Any = None) -> Path:
    """Patch resolve_mutator, optimize_repo_frontier, and new_run_dir."""
    run_dir = tmp_path / "run"
    run_dir.mkdir(exist_ok=True)
    monkeypatch.setattr("hone.cli.resolve_mutator", lambda spec: _FakeMutator())
    monkeypatch.setattr(
        "hone.cli.optimize_repo_frontier",
        optimize_fn if optimize_fn is not None else (lambda **kw: _fake_result(run_dir)),
    )
    monkeypatch.setattr("hone.cli.new_run_dir", lambda: run_dir)
    return run_dir


def _make_src_and_scorer(tmp_path: Path) -> tuple[Path, Path]:
    src = tmp_path / "src"
    src.mkdir(exist_ok=True)
    scorer = tmp_path / "scorer.sh"
    scorer.write_text("#!/bin/bash\necho 1.0\n")
    scorer.chmod(0o755)
    return src, scorer


# ---------------------------------------------------------------------------
# hone run — scorer flag
# ---------------------------------------------------------------------------


def test_run_scorer_flag_accepted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _setup(monkeypatch, tmp_path)
    src, scorer = _make_src_and_scorer(tmp_path)
    result = runner.invoke(app, ["run", "--dir", str(src), "--scorer", str(scorer)])
    assert result.exit_code == 0, result.output


def test_run_grader_alias_when_scorer_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup(monkeypatch, tmp_path)
    src, scorer = _make_src_and_scorer(tmp_path)
    result = runner.invoke(app, ["run", "--dir", str(src), "--grader", str(scorer)])
    assert result.exit_code == 0, result.output
    assert "deprecated" in result.output.lower(), f"Expected deprecation warning in output: {result.output!r}"


def test_run_legacy_invocation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """hone run --dir X --grader ./g.sh must still work unchanged."""
    _setup(monkeypatch, tmp_path)
    src, scorer = _make_src_and_scorer(tmp_path)
    result = runner.invoke(app, ["run", "--dir", str(src), "--grader", str(scorer)])
    assert result.exit_code == 0, result.output


# ---------------------------------------------------------------------------
# hone run — stall / metric / gate forwarding
# ---------------------------------------------------------------------------


def test_run_forwards_stall_metric_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict = {}

    def fake_optimize(**kwargs: Any) -> RepoFrontierResult:
        captured.update(kwargs)
        return _fake_result(tmp_path / "run")

    _setup(monkeypatch, tmp_path, optimize_fn=fake_optimize)
    src, scorer = _make_src_and_scorer(tmp_path)

    result = runner.invoke(app, [
        "run",
        "--dir", str(src),
        "--scorer", str(scorer),
        "--stall", "3",
        "--metric", "min",
        "--gate", "lint=ruff check .",
    ])
    assert result.exit_code == 0, result.output
    assert captured.get("stall") == 3
    assert captured.get("metric_direction") == "min"
    gates = captured.get("gates") or []
    assert len(gates) == 1
    assert gates[0].name == "lint"
    assert gates[0].command == "ruff check ."


def test_run_rejects_invalid_metric(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _setup(monkeypatch, tmp_path)
    src, scorer = _make_src_and_scorer(tmp_path)
    result = runner.invoke(app, [
        "run", "--dir", str(src), "--scorer", str(scorer), "--metric", "median"
    ])
    assert result.exit_code != 0


def test_run_requires_scorer_or_grader(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _setup(monkeypatch, tmp_path)
    src, _ = _make_src_and_scorer(tmp_path)
    result = runner.invoke(app, ["run", "--dir", str(src)])
    assert result.exit_code != 0


# ---------------------------------------------------------------------------
# hone init
# ---------------------------------------------------------------------------


def test_init_writes_hone_toml(tmp_path: Path) -> None:
    out = tmp_path / "hone.toml"
    result = runner.invoke(app, [
        "init",
        "--src-dir", "/some/repo",
        "--scorer", "./scorer.sh",
        "--to", str(out),
    ])
    assert result.exit_code == 0, result.output
    assert out.exists()
    with open(out, "rb") as f:
        data = tomllib.load(f)
    assert data["src_dir"] == "/some/repo"
    assert data["scorer"] == "./scorer.sh"


def test_init_includes_defaults(tmp_path: Path) -> None:
    out = tmp_path / "hone.toml"
    result = runner.invoke(app, [
        "init",
        "--src-dir", "/repo",
        "--scorer", "./s.sh",
        "--to", str(out),
        "--budget", "10",
        "--metric", "min",
    ])
    assert result.exit_code == 0, result.output
    with open(out, "rb") as f:
        data = tomllib.load(f)
    assert data["budget"] == 10
    assert data["metric_direction"] == "min"


def test_init_refuses_overwrite_without_force(tmp_path: Path) -> None:
    out = tmp_path / "hone.toml"
    out.write_text("existing = true\n", encoding="utf-8")
    result = runner.invoke(app, [
        "init", "--src-dir", "/repo", "--scorer", "./s.sh", "--to", str(out)
    ])
    assert result.exit_code != 0
    assert "existing = true" in out.read_text()


def test_init_force_overwrites(tmp_path: Path) -> None:
    out = tmp_path / "hone.toml"
    out.write_text("old = true\n", encoding="utf-8")
    result = runner.invoke(app, [
        "init", "--src-dir", "/repo", "--scorer", "./s.sh", "--to", str(out), "--force"
    ])
    assert result.exit_code == 0, result.output
    with open(out, "rb") as f:
        data = tomllib.load(f)
    assert data["src_dir"] == "/repo"


def test_init_rejects_invalid_metric(tmp_path: Path) -> None:
    out = tmp_path / "hone.toml"
    result = runner.invoke(app, [
        "init", "--src-dir", "/repo", "--scorer", "./s.sh", "--to", str(out),
        "--metric", "median",
    ])
    assert result.exit_code != 0
    assert not out.exists()


# ---------------------------------------------------------------------------
# hone optimize
# ---------------------------------------------------------------------------


def test_optimize_reads_toml_and_calls_optimize(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg_path = tmp_path / "hone.toml"
    cfg_path.write_text(
        'src_dir = "/some/repo"\nscorer = "./scorer.sh"\nbudget = 7\n',
        encoding="utf-8",
    )

    captured: dict = {}

    def fake_optimize(**kwargs: Any) -> RepoFrontierResult:
        captured.update(kwargs)
        return _fake_result(tmp_path / "run")

    _setup(monkeypatch, tmp_path, optimize_fn=fake_optimize)

    result = runner.invoke(app, ["optimize", "--config", str(cfg_path)])
    assert result.exit_code == 0, result.output
    assert captured.get("budget") == 7


def test_optimize_fails_on_missing_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup(monkeypatch, tmp_path)
    missing = tmp_path / "no_such.toml"
    result = runner.invoke(app, ["optimize", "--config", str(missing)])
    assert result.exit_code != 0


def test_optimize_fails_on_invalid_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg_path = tmp_path / "bad.toml"
    cfg_path.write_text('scorer = "./s.sh"\n', encoding="utf-8")  # missing src_dir
    _setup(monkeypatch, tmp_path)
    result = runner.invoke(app, ["optimize", "--config", str(cfg_path)])
    assert result.exit_code != 0
