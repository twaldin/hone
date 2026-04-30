"""Subprocess-style tests for hone.workers._scorer_proxy."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


def _git(args, *, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True)


def _init_repo(path: Path) -> None:
    _git(["init", "-q", "-b", "main"], cwd=path)
    _git(["config", "user.email", "test@test.com"], cwd=path)
    _git(["config", "user.name", "Test"], cwd=path)
    (path / "file.txt").write_text("initial\n", encoding="utf-8")
    _git(["add", "-A"], cwd=path)
    _git(["commit", "-q", "-m", "seed", "--no-verify"], cwd=path)


def _make_grader(path: Path, score: float = 0.75) -> Path:
    grader = path / "grader.py"
    grader.write_text(
        "#!/usr/bin/env python3\nimport sys, json\n"
        f'print(json.dumps({{"score": {score}, "submetrics": {{"accuracy": {score}}}}}))\n',
        encoding="utf-8",
    )
    grader.chmod(0o755)
    return grader


def _make_budget_file(path: Path, remaining: int = 3) -> Path:
    bf = path / "budget.json"
    bf.write_text(
        json.dumps({"remaining": remaining, "attempts": [], "policy_decisions": []}),
        encoding="utf-8",
    )
    return bf


def _run_proxy(env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "hone.workers._scorer_proxy"],
        env={**env, "PATH": "/usr/bin:/bin:/usr/local/bin"},
        capture_output=True, text=True,
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

def test_proxy_happy_path(tmp_path):
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    _init_repo(workdir)

    # Give workdir some uncommitted changes so stash is meaningful
    (workdir / "file.txt").write_text("agent edit\n", encoding="utf-8")

    grader = _make_grader(tmp_path, score=0.75)
    budget_file = _make_budget_file(tmp_path, remaining=2)

    env = {
        "HONE_BUDGET_FILE": str(budget_file),
        "HONE_GRADER_PATH": str(grader),
        "HONE_WORKDIR": str(workdir),
        "HONE_RUN_DIR": str(tmp_path),
        "HONE_GRADER_TIMEOUT": "30",
        "HONE_SCORER_READONLY": "0",
    }
    proc = _run_proxy(env)

    assert proc.returncode == 0, f"stderr: {proc.stderr}"

    envelope = json.loads(proc.stdout.strip().splitlines()[-1])
    assert envelope["score"] == pytest.approx(0.75)
    assert envelope["attempt_idx"] == 0
    assert envelope["remaining_budget"] == 1

    budget_data = json.loads(budget_file.read_text())
    assert budget_data["remaining"] == 1
    assert len(budget_data["attempts"]) == 1
    assert budget_data["attempts"][0]["score"] == pytest.approx(0.75)  # noqa: E501


def test_proxy_decrements_remaining_across_calls(tmp_path):
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    _init_repo(workdir)

    grader = _make_grader(tmp_path, score=0.5)
    budget_file = _make_budget_file(tmp_path, remaining=3)

    env = {
        "HONE_BUDGET_FILE": str(budget_file),
        "HONE_GRADER_PATH": str(grader),
        "HONE_WORKDIR": str(workdir),
        "HONE_RUN_DIR": str(tmp_path),
        "HONE_GRADER_TIMEOUT": "30",
        "HONE_SCORER_READONLY": "0",
    }

    for expected_remaining in [2, 1]:
        proc = _run_proxy(env)
        assert proc.returncode == 0
        env_after = json.loads(proc.stdout.strip().splitlines()[-1])
        assert env_after["remaining_budget"] == expected_remaining


# ---------------------------------------------------------------------------
# Budget exhausted
# ---------------------------------------------------------------------------

def test_proxy_exhausted_budget_exits_nonzero(tmp_path):
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    _init_repo(workdir)

    grader = _make_grader(tmp_path)
    budget_file = _make_budget_file(tmp_path, remaining=0)

    env = {
        "HONE_BUDGET_FILE": str(budget_file),
        "HONE_GRADER_PATH": str(grader),
        "HONE_WORKDIR": str(workdir),
        "HONE_RUN_DIR": str(tmp_path),
        "HONE_GRADER_TIMEOUT": "30",
        "HONE_SCORER_READONLY": "0",
    }
    proc = _run_proxy(env)

    assert proc.returncode == 2
    err = json.loads(proc.stderr.strip())
    assert err["error"] == "budget exhausted"


# ---------------------------------------------------------------------------
# Grader inside workdir — rejected
# ---------------------------------------------------------------------------

def test_proxy_grader_inside_workdir_rejected(tmp_path):
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    _init_repo(workdir)

    grader = _make_grader(workdir, score=0.9)  # grader IS inside workdir
    budget_file = _make_budget_file(tmp_path, remaining=2)

    env = {
        "HONE_BUDGET_FILE": str(budget_file),
        "HONE_GRADER_PATH": str(grader),
        "HONE_WORKDIR": str(workdir),
        "HONE_RUN_DIR": str(tmp_path),
        "HONE_GRADER_TIMEOUT": "30",
        "HONE_SCORER_READONLY": "1",
    }
    proc = _run_proxy(env)

    assert proc.returncode == 2
    err = json.loads(proc.stderr.strip())
    assert "workdir" in err["error"]

    budget_data = json.loads(budget_file.read_text())
    assert any(d["reason"] == "grader-inside-workdir" for d in budget_data["policy_decisions"])


# ---------------------------------------------------------------------------
# Scorer-readonly tamper detection
# ---------------------------------------------------------------------------

def test_proxy_scorer_tamper_detected(tmp_path):
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    _init_repo(workdir)

    grader = tmp_path / "grader.py"
    original_content = (
        "#!/usr/bin/env python3\nimport sys, json, pathlib\n"
        # Tamper: rewrite the grader file itself during execution
        f'pathlib.Path("{grader}").write_text('
        '"#!/usr/bin/env python3\\nimport sys,json\\n'
        'print(json.dumps({\\\"score\\\": 0.0}))\\n")\n'
        'print(json.dumps({"score": 0.6}))\n'
    )
    grader.write_text(original_content, encoding="utf-8")
    grader.chmod(0o755)

    budget_file = _make_budget_file(tmp_path, remaining=2)

    env = {
        "HONE_BUDGET_FILE": str(budget_file),
        "HONE_GRADER_PATH": str(grader),
        "HONE_WORKDIR": str(workdir),
        "HONE_RUN_DIR": str(tmp_path),
        "HONE_GRADER_TIMEOUT": "30",
        "HONE_SCORER_READONLY": "1",
    }
    proc = _run_proxy(env)

    assert proc.returncode == 0  # still exits 0; tamper is recorded, not fatal

    budget_data = json.loads(budget_file.read_text())
    assert len(budget_data["attempts"]) == 1
    assert budget_data["attempts"][0]["notes"] == "scorer-tamper"
    assert any(d["reason"] == "scorer-tamper" for d in budget_data["policy_decisions"])


# ---------------------------------------------------------------------------
# Stash is restored after call
# ---------------------------------------------------------------------------

def test_proxy_restores_working_state(tmp_path):
    """After proxy call, agent's in-progress edits should be back in workdir."""
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    _init_repo(workdir)

    (workdir / "file.txt").write_text("agent-in-progress\n", encoding="utf-8")

    grader = _make_grader(tmp_path)
    budget_file = _make_budget_file(tmp_path, remaining=2)

    env = {
        "HONE_BUDGET_FILE": str(budget_file),
        "HONE_GRADER_PATH": str(grader),
        "HONE_WORKDIR": str(workdir),
        "HONE_RUN_DIR": str(tmp_path),
        "HONE_GRADER_TIMEOUT": "30",
        "HONE_SCORER_READONLY": "0",
    }
    proc = _run_proxy(env)

    assert proc.returncode == 0
    # Agent's edit should still be present
    assert (workdir / "file.txt").read_text(encoding="utf-8") == "agent-in-progress\n"
