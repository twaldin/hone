"""Tests for HarnessWorker."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from harness import RunResult
from hone.workers.harness_worker import HarnessWorker
from hone.workers.resolver import resolve_worker


def _git(args, *, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True)


def _init_repo(path: Path) -> None:
    _git(["init", "-q", "-b", "main"], cwd=path)
    _git(["config", "user.email", "test@test.com"], cwd=path)
    _git(["config", "user.name", "Test"], cwd=path)
    (path / "file.txt").write_text("v0\n", encoding="utf-8")
    _git(["add", "-A"], cwd=path)
    _git(["commit", "-q", "-m", "seed", "--no-verify"], cwd=path)


def _write_manifest(run_dir: Path, grader_path: Path) -> None:
    (run_dir / "run.json").write_text(
        json.dumps({
            "run_id": "test",
            "created_at": "2026-01-01T00:00:00Z",
            "src_dir": str(run_dir),
            "grader_path": str(grader_path),
            "mutator_spec": "harness:claude-code:sonnet",
            "budget": 2,
        }),
        encoding="utf-8",
    )


def _make_fake_grader(path: Path) -> Path:
    grader = path / "grader.py"
    grader.write_text(
        "#!/usr/bin/env python3\nimport sys, json\n"
        'print(json.dumps({"score": 0.5, "submetrics": {"x": 0.5}}))\n',
        encoding="utf-8",
    )
    grader.chmod(0o755)
    return grader


def _noop_scorer(_workdir):
    from hone.scorer_result import ScorerResult
    return ScorerResult(score=0.0)


# ---------------------------------------------------------------------------
# Happy-path: 2 proxy attempts, picks best
# ---------------------------------------------------------------------------

def test_harness_worker_two_attempts_picks_best(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    workdir = run_dir / "workdir"
    workdir.mkdir()
    _init_repo(workdir)

    grader = _make_fake_grader(tmp_path)
    _write_manifest(run_dir, grader)

    captured_spec = {}

    def fake_run(spec):
        captured_spec["spec"] = spec
        # Simulate 2 proxy invocations by writing attempt records directly
        # and performing actual git stash operations.
        budget_file = Path(spec.env["HONE_BUDGET_FILE"])

        # Attempt 0: score=0.5
        (workdir / "file.txt").write_text("v1\n", encoding="utf-8")
        stash_out = subprocess.run(
            ["git", "stash", "push", "--include-untracked", "-m", "hone-worker-attempt-0"],
            cwd=str(workdir), capture_output=True, text=True,
        )
        pushed0 = "No local changes to save" not in stash_out.stdout

        data = json.loads(budget_file.read_text())
        data["remaining"] -= 1
        data["attempts"].append({
            "attempt_idx": 0, "score": 0.5, "submetrics": {"x": 0.5},
            "pushed": pushed0, "stash_ref": "stash@{0}" if pushed0 else None,
            "traces_path": None, "trace_stderr": "", "raw_stdout": "0.5",
            "parsed_envelope": None, "notes": "",
        })
        budget_file.write_text(json.dumps(data), encoding="utf-8")

        # Restore v1 for agent to continue editing
        if pushed0:
            subprocess.run(["git", "stash", "apply", "stash@{0}"], cwd=str(workdir),
                           capture_output=True, check=True)

        # Attempt 1: score=0.8
        (workdir / "file.txt").write_text("v2\n", encoding="utf-8")
        stash_out = subprocess.run(
            ["git", "stash", "push", "--include-untracked", "-m", "hone-worker-attempt-1"],
            cwd=str(workdir), capture_output=True, text=True,
        )
        pushed1 = "No local changes to save" not in stash_out.stdout

        data = json.loads(budget_file.read_text())
        data["remaining"] -= 1
        data["attempts"].append({
            "attempt_idx": 1, "score": 0.8, "submetrics": {"x": 0.8},
            "pushed": pushed1, "stash_ref": "stash@{0}" if pushed1 else None,
            "traces_path": None, "trace_stderr": "", "raw_stdout": "0.8",
            "parsed_envelope": None, "notes": "",
        })
        budget_file.write_text(json.dumps(data), encoding="utf-8")

        if pushed1:
            subprocess.run(["git", "stash", "apply", "stash@{0}"], cwd=str(workdir),
                           capture_output=True, check=True)

        return RunResult(
            harness="claude-code", model="sonnet", exit_code=0,
            duration_seconds=1.0, stdout="", stderr="", timed_out=False,
            cost_usd=0.01, tokens_in=100, tokens_out=50, raw=None,
        )

    monkeypatch.setattr("harness.run", fake_run)

    worker = HarnessWorker("claude-code", "sonnet", worker_budget=2, scorer_readonly=False)
    result = worker.propose(
        prompt="improve code",
        workdir=workdir,
        scorer=_noop_scorer,
        scorer_budget=3,
    )

    assert result.error is None
    assert len(result.attempts) == 2
    assert result.scorer_calls == 2
    assert result.best_attempt_idx == 1  # index in attempts list; attempt[1].score=0.8
    assert result.attempts[1].score == pytest.approx(0.8)
    assert result.attempts[0].score == pytest.approx(0.5)
    # Best stash (v2) should be applied
    assert (workdir / "file.txt").read_text(encoding="utf-8") == "v2\n"


# ---------------------------------------------------------------------------
# Budget enforcement
# ---------------------------------------------------------------------------

def test_harness_worker_zero_budget_returns_error(monkeypatch):
    scorer = lambda _wd: None  # noqa: E731
    worker = HarnessWorker("claude-code", worker_budget=0, scorer_readonly=False)
    result = worker.propose(prompt="x", workdir=Path("/tmp"), scorer=scorer, scorer_budget=1)
    assert result.error is not None
    assert result.attempts == []
    assert result.scorer_calls == 0


def test_harness_worker_scorer_budget_zero_returns_error(monkeypatch):
    scorer = lambda _wd: None  # noqa: E731
    worker = HarnessWorker("claude-code", worker_budget=3, scorer_readonly=False)
    result = worker.propose(prompt="x", workdir=Path("/tmp"), scorer=scorer, scorer_budget=0)
    assert result.error is not None
    assert result.attempts == []


def test_harness_worker_effective_budget_is_min(tmp_path, monkeypatch):
    """worker_budget=5 but scorer_budget=1 → effective=1; proxy script must encode 1."""
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    workdir = run_dir / "workdir"
    workdir.mkdir()
    _init_repo(workdir)
    grader = _make_fake_grader(tmp_path)
    _write_manifest(run_dir, grader)

    def fake_run(spec):
        proxy_path = Path(spec.env["HONE_SCORER_PROXY"])
        script_text = proxy_path.read_text()
        # Proxy script should bake in effective budget = min(5,1) = 1
        # That's enforced via the budget file's "remaining" field
        budget_file = Path(spec.env["HONE_BUDGET_FILE"])
        data = json.loads(budget_file.read_text())
        assert data["remaining"] == 1, f"expected remaining=1, got {data['remaining']}"
        # Simulate 1 attempt
        data["remaining"] = 0
        data["attempts"].append({
            "attempt_idx": 0, "score": 0.4, "submetrics": {},
            "pushed": False, "stash_ref": None, "traces_path": None,
            "trace_stderr": "", "raw_stdout": "", "parsed_envelope": None, "notes": "",
        })
        budget_file.write_text(json.dumps(data), encoding="utf-8")
        return RunResult(
            harness="claude-code", model=None, exit_code=0,
            duration_seconds=0.5, stdout="", stderr="", timed_out=False,
            cost_usd=None, tokens_in=None, tokens_out=None, raw=None,
        )

    monkeypatch.setattr("harness.run", fake_run)

    worker = HarnessWorker("claude-code", worker_budget=5, scorer_readonly=False)
    result = worker.propose(prompt="x", workdir=workdir, scorer=_noop_scorer, scorer_budget=1)
    assert result.error is None
    assert len(result.attempts) == 1


# ---------------------------------------------------------------------------
# Scorer-readonly tamper detection
# ---------------------------------------------------------------------------

def test_harness_worker_scorer_readonly_tamper_marked_in_notes(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    workdir = run_dir / "workdir"
    workdir.mkdir()
    _init_repo(workdir)
    grader = _make_fake_grader(tmp_path)
    _write_manifest(run_dir, grader)

    def fake_run(spec):
        budget_file = Path(spec.env["HONE_BUDGET_FILE"])
        data = json.loads(budget_file.read_text())
        data["remaining"] = 0
        data["attempts"].append({
            "attempt_idx": 0, "score": 0.3, "submetrics": {},
            "pushed": False, "stash_ref": None, "traces_path": None,
            "trace_stderr": "", "raw_stdout": "", "parsed_envelope": None,
            "notes": "scorer-tamper",  # proxy detected tamper
        })
        data["policy_decisions"].append({
            "decision": "tamper-detected", "reason": "scorer-tamper", "attempt_idx": 0,
        })
        budget_file.write_text(json.dumps(data), encoding="utf-8")
        return RunResult(
            harness="claude-code", model=None, exit_code=0,
            duration_seconds=0.5, stdout="", stderr="", timed_out=False,
            cost_usd=None, tokens_in=None, tokens_out=None, raw=None,
        )

    monkeypatch.setattr("harness.run", fake_run)

    worker = HarnessWorker("claude-code", worker_budget=2, scorer_readonly=True)
    result = worker.propose(prompt="x", workdir=workdir, scorer=_noop_scorer, scorer_budget=2)

    assert result.error is None
    assert len(result.attempts) == 1
    assert "scorer-tamper" in result.attempts[0].notes


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------

def test_resolve_worker_harness_spec(monkeypatch):
    from unittest.mock import MagicMock
    w = resolve_worker("harness:claude-code:sonnet", mutator=MagicMock(), worker_budget=3)
    assert isinstance(w, HarnessWorker)
    assert w.harness_name == "claude-code"
    assert w.model == "sonnet"
    assert w.worker_budget == 3


def test_resolve_worker_harness_without_model(monkeypatch):
    from unittest.mock import MagicMock
    w = resolve_worker("harness:opencode", mutator=MagicMock(), worker_budget=2)
    assert isinstance(w, HarnessWorker)
    assert w.harness_name == "opencode"
    assert w.model is None


def test_resolve_worker_harness_empty_raises():
    from hone.workers.base import WorkerError
    from unittest.mock import MagicMock
    with pytest.raises(WorkerError):
        resolve_worker("harness:", mutator=MagicMock())


def test_resolve_worker_unknown_spec_still_raises():
    from hone.workers.base import WorkerError
    from unittest.mock import MagicMock
    with pytest.raises(WorkerError):
        resolve_worker("unknown", mutator=MagicMock())


# ---------------------------------------------------------------------------
# Timeout propagation
# ---------------------------------------------------------------------------

def test_harness_worker_timeout_plumbed_into_proxy(tmp_path, monkeypatch):
    """HONE_GRADER_TIMEOUT in proxy script must equal constructor timeout_seconds."""
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    workdir = run_dir / "workdir"
    workdir.mkdir()
    _init_repo(workdir)
    grader = _make_fake_grader(tmp_path)
    _write_manifest(run_dir, grader)

    captured_timeout_line: list[str] = []

    def fake_run(spec):
        proxy_path = Path(spec.env["HONE_SCORER_PROXY"])
        for line in proxy_path.read_text().splitlines():
            if "HONE_GRADER_TIMEOUT" in line:
                captured_timeout_line.append(line)
        budget_file = Path(spec.env["HONE_BUDGET_FILE"])
        data = json.loads(budget_file.read_text())
        data["remaining"] = 0
        data["attempts"].append({
            "attempt_idx": 0, "score": 0.4, "submetrics": {},
            "pushed": False, "stash_ref": None, "traces_path": None,
            "trace_stderr": "", "raw_stdout": "", "parsed_envelope": None, "notes": "",
        })
        budget_file.write_text(json.dumps(data), encoding="utf-8")
        return RunResult(
            harness="claude-code", model=None, exit_code=0,
            duration_seconds=0.5, stdout="", stderr="", timed_out=False,
            cost_usd=None, tokens_in=None, tokens_out=None, raw=None,
        )

    monkeypatch.setattr("harness.run", fake_run)

    worker = HarnessWorker("claude-code", worker_budget=1, scorer_readonly=False, timeout_seconds=999)
    worker.propose(prompt="x", workdir=workdir, scorer=_noop_scorer, scorer_budget=1)

    assert captured_timeout_line, "HONE_GRADER_TIMEOUT line not found in proxy script"
    assert "999" in captured_timeout_line[0], (
        f"Expected 999 in timeout line, got: {captured_timeout_line[0]!r}"
    )


# ---------------------------------------------------------------------------
# Shell-safe path quoting in proxy script
# ---------------------------------------------------------------------------

def test_proxy_script_shell_quotes_special_paths(tmp_path):
    """_write_proxy_script must shell-quote all interpolated values."""
    import shlex
    from hone.workers.harness_worker import _write_proxy_script

    proxy = tmp_path / "proxy.sh"
    budget = tmp_path / "path with spaces" / "budget.json"
    budget.parent.mkdir()
    budget.write_text("{}", encoding="utf-8")

    _write_proxy_script(
        proxy,
        budget_file=budget,
        grader_path=Path("/grader path/g.py"),
        workdir=Path("/work dir"),
        run_dir=Path("/run dir"),
        grader_timeout=300,
        scorer_readonly=True,
    )

    script = proxy.read_text()
    for line in script.splitlines():
        if not line.startswith("export ") or "=" not in line:
            continue
        _, value_part = line.split("=", 1)
        tokens = shlex.split(value_part)
        assert len(tokens) == 1, (
            f"Unsafe shell quoting in proxy script line: {line!r} "
            f"(parsed as {len(tokens)} tokens)"
        )
