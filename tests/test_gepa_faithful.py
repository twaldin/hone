from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from harness import RunResult

from hone.gepa_faithful import (
    DEFAULT_FRONTIER_TYPE,
    GEPAResultMetadata,
    HarnessAdapterConfig,
    HarnessMutatorAdapter,
    HoneCodeCandidate,
    HoneTaskExample,
    MetricCallBudget,
    TestCommandEvaluator,
    candidate_from_gepa,
    candidate_to_gepa,
    optimize_code,
)


def _git(args: list[str], *, cwd: Path) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
    )
    return proc.stdout.strip()


def _init_repo(path: Path) -> tuple[str, str]:
    _git(["init", "-q", "-b", "main"], cwd=path)
    _git(["config", "user.email", "test@test.com"], cwd=path)
    _git(["config", "user.name", "Test"], cwd=path)
    (path / "marker.txt").write_text("seed\n", encoding="utf-8")
    (path / "check.py").write_text(
        "from pathlib import Path\n"
        "raise SystemExit(0 if Path('marker.txt').read_text().strip() == 'pass' else 1)\n",
        encoding="utf-8",
    )
    _git(["add", "-A"], cwd=path)
    _git(["commit", "-q", "-m", "seed", "--no-verify"], cwd=path)
    base = _git(["rev-parse", "HEAD"], cwd=path)
    (path / "marker.txt").write_text("pass\n", encoding="utf-8")
    _git(["add", "-A"], cwd=path)
    _git(["commit", "-q", "-m", "passing", "--no-verify"], cwd=path)
    passing = _git(["rev-parse", "HEAD"], cwd=path)
    return base, passing


def test_candidate_round_trip_uses_gepa_record_shape() -> None:
    candidate = HoneCodeCandidate(commit_sha="abc123", instructions="make tests pass")

    gepa_candidate = candidate_to_gepa(candidate)

    assert gepa_candidate == {"commit_sha": "abc123", "instructions": "make tests pass"}
    assert candidate_from_gepa(gepa_candidate) == candidate


def test_default_evaluator_returns_side_info_scores(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    base, passing = _init_repo(repo)
    example = HoneTaskExample(
        id="one",
        repo_path=repo,
        base_commit=base,
        test_command="python check.py",
    )
    evaluator = TestCommandEvaluator(worktree_root=tmp_path / "worktrees")

    score, side_info = evaluator.evaluate(
        HoneCodeCandidate(commit_sha=passing, instructions=""),
        example,
    )

    assert score > 0.0
    assert side_info["scores"]["pass"] == 1.0
    assert "speed" in side_info["scores"]
    assert "changed_files" in side_info["scores"]
    assert side_info["test_command"] == "python check.py"
    assert side_info["exit_code"] == 0
    assert side_info["commit_sha"] == passing
    assert side_info["changed_files"] == ["marker.txt"]


def test_default_evaluator_failed_tests_never_outrank_pass(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    base, passing = _init_repo(repo)
    example = HoneTaskExample(
        id="one",
        repo_path=repo,
        base_commit=base,
        test_command="python check.py",
    )
    evaluator = TestCommandEvaluator(worktree_root=tmp_path / "worktrees")

    failed_score, failed_info = evaluator.evaluate(HoneCodeCandidate(base, ""), example)
    passing_score, passing_info = evaluator.evaluate(HoneCodeCandidate(passing, ""), example)

    assert failed_score == 0.0
    assert failed_info["scores"]["pass"] == 0.0
    assert passing_info["scores"]["pass"] == 1.0
    assert passing_score > failed_score


def test_default_evaluator_runs_baseline_before_candidate_when_missing(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    base, passing = _init_repo(repo)
    calls: list[str] = []

    def fake_runner(_command: str, cwd: Path, _timeout: int | None):
        marker = (cwd / "marker.txt").read_text(encoding="utf-8").strip()
        calls.append(marker)
        duration = 10.0 if marker == "seed" else 5.0
        return SimpleNamespace(
            exit_code=0,
            duration_seconds=duration,
            stdout="",
            stderr="",
            timed_out=False,
        )

    example = HoneTaskExample(
        id="one",
        repo_path=repo,
        base_commit=base,
        test_command="python check.py",
    )
    evaluator = TestCommandEvaluator(
        worktree_root=tmp_path / "worktrees",
        command_runner=fake_runner,
    )

    score, side_info = evaluator.evaluate(HoneCodeCandidate(passing, ""), example)

    assert len(calls) == 2
    assert calls == ["seed", "pass"]
    assert side_info["baseline_established"] is True
    assert side_info["baseline_seconds"] == pytest.approx(10.0)
    assert side_info["scores"]["speed"] == pytest.approx(0.25)
    assert score == pytest.approx(1.25)


def test_metric_budget_is_only_a_guard_not_a_frontier_export() -> None:
    budget = MetricCallBudget(max_metric_calls=2)

    assert DEFAULT_FRONTIER_TYPE == "hybrid"
    budget.consume()
    budget.consume(1)
    with pytest.raises(RuntimeError, match="metric-call budget exhausted"):
        budget.consume()


def test_harness_mutator_adapter_uses_stable_runspec_contract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    base, _passing = _init_repo(repo)
    captured = {}

    def fake_run(spec):
        captured["spec"] = spec
        (Path(spec.workdir) / "marker.txt").write_text("mutated\n", encoding="utf-8")
        return RunResult(
            harness="codex",
            model="gpt-5.5",
            exit_code=0,
            duration_seconds=1.25,
            stdout="done",
            stderr="",
            timed_out=False,
            cost_usd=0.5,
            tokens_in=10,
            tokens_out=20,
            raw={"ok": True},
        )

    monkeypatch.setattr("harness.run", fake_run)
    adapter = HarnessMutatorAdapter(
        HarnessAdapterConfig(harness="codex", model="gpt-5.5", timeout_seconds=99),
        worktree_root=tmp_path / "worktrees",
    )
    example = HoneTaskExample(
        id="one",
        repo_path=repo,
        base_commit=base,
        test_command="python check.py",
        prompt="fix marker",
    )

    result = adapter.mutate(
        HoneCodeCandidate(commit_sha=base, instructions="change marker"),
        example,
        iteration=3,
    )

    assert adapter.name == "harness"
    assert result.candidate.commit_sha != base
    assert result.candidate.instructions == "change marker"
    assert result.changed_files == ["marker.txt"]
    assert result.run.harness == "codex"
    assert result.run.cost_usd == 0.5
    assert captured["spec"].harness == "codex"
    assert captured["spec"].model == "gpt-5.5"
    assert captured["spec"].timeout_seconds == 99
    assert Path(captured["spec"].workdir).exists()
    assert "fix marker" in captured["spec"].prompt
    assert captured["spec"].instructions == "change marker"
    assert "HONE_SCORER_PROXY" not in captured["spec"].env


def test_optimize_code_delegates_optimizer_semantics_to_gepa_ts_runner(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    base, _passing = _init_repo(repo)
    captured = {}

    class FakeRunner:
        def optimize_anything(self, **kwargs):
            captured.update(kwargs)
            return {
                "best_candidate": kwargs["seed_candidate"],
                "best_idx": 0,
                "candidates": [kwargs["seed_candidate"]],
                "val_aggregate_scores": [1.0],
                "val_subscores": [{"repo": 1.0}],
                "val_aggregate_subscores": [{"pass": 1.0}],
                "total_metric_calls": 1,
                "run_dir": None,
            }

    result = optimize_code(
        repo_path=repo,
        test_command="python check.py",
        seed_instructions="make it pass",
        base_commit=base,
        max_metric_calls=7,
        reflection_lm=lambda _prompt: "make it pass",
        objective="pass tests",
        background="code-state optimization",
        runner=FakeRunner(),
    )

    assert result.best_commit_sha == base
    assert result.metadata["optimizer"] == "gepa-ts optimize_anything"
    assert result.metadata["frontier_type"] == DEFAULT_FRONTIER_TYPE
    assert captured["seed_candidate"] == {"commit_sha": base, "instructions": "make it pass"}
    assert captured["dataset"] == captured["valset"]
    assert captured["config"]["engine"]["max_metric_calls"] == 7
    assert captured["config"]["engine"]["frontier_type"] == "hybrid"
    assert captured["config"]["engine"]["candidate_selection_strategy"] == "pareto"
    assert callable(captured["evaluator"])


def test_result_metadata_derives_hone_summary_fields() -> None:
    metadata = GEPAResultMetadata(
        best_candidate=HoneCodeCandidate("abc", "do it"),
        best_idx=2,
        candidates=[HoneCodeCandidate("base", ""), HoneCodeCandidate("abc", "do it")],
        val_aggregate_scores=[0.0, 1.0],
        val_subscores=[{"one": 0.0}, {"one": 1.0}],
        val_aggregate_subscores=[{"pass": 0.0}, {"pass": 1.0}],
        total_metric_calls=3,
        run_dir="/tmp/run",
        best_changed_files=["marker.txt"],
        harness_runs=[{"harness": "codex"}],
    )

    assert metadata.best_commit_sha == "abc"
    assert metadata.to_dict()["total_metric_calls"] == 3
    assert metadata.to_dict()["best_changed_files"] == ["marker.txt"]


def test_gepa_faithful_module_does_not_export_local_pareto_front() -> None:
    import hone.gepa_faithful as gepa_faithful

    assert not hasattr(gepa_faithful, "pareto_front")
    assert "pareto_front" not in gepa_faithful.__all__
