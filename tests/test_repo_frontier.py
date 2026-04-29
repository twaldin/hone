"""End-to-end test for the v1 git-native frontier loop with managed workspace."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hone.gates import GateSpec
from hone.mutators.base import MutatorError, MutatorResult
from hone.repo_frontier import RepoCandidate, _select_parent, optimize_repo_frontier


def _candidate(idx: int, utility: float) -> RepoCandidate:
    return RepoCandidate(
        idx=idx,
        sha=f"sha-{idx}",
        branch=f"b-{idx}",
        raw_score=utility,
        utility=utility,
        trace_stderr="",
        raw_stdout="",
        parent_idx=None,
        parent_sha=None,
        parent_diff_stat="",
        parent_diff_patch="",
        base_diff_stat="",
        base_diff_patch="",
        changed_files_from_parent=[],
    )


class _EditingMutator:
    """Deterministic mutator that sets planner.py to `score = 1` on every call."""

    def __init__(self) -> None:
        self.calls = 0

    def propose_edit_mode(self, prompt: str, workdir: Path) -> MutatorResult:
        self.calls += 1
        (workdir / "planner.py").write_text("score = 1\n", encoding="utf-8")
        return MutatorResult(new_prompt="", tokens_in=10, tokens_out=5, cost_usd=0.01)


def test_select_parent_does_not_lock_onto_bad_tail_candidate() -> None:
    frontier = [
        _candidate(0, 1.173),
        _candidate(1, 1.167),
        _candidate(2, 1.167),
        _candidate(3, 1.167),
        _candidate(4, 1.167),
        _candidate(5, 1.167),
        _candidate(6, 0.142),
    ]

    selected = [_select_parent(frontier, iteration=i, frontier_size=24).idx for i in range(7, 15)]

    assert selected.count(6) <= 1
    assert selected.count(0) >= 2


def test_frontier_managed_workspace_end_to_end(tmp_path: Path) -> None:
    # The source dir is NOT a git repo — hone should copy + init on its own.
    src = tmp_path / "controllers"
    src.mkdir()
    (src / "planner.py").write_text("score = 0\n", encoding="utf-8")

    grader = tmp_path / "grader.py"
    grader.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "root = pathlib.Path(sys.argv[1])\n"
        "text = (root / 'planner.py').read_text()\n"
        "print(1.0 if 'score = 1' in text else 0.0)\n",
        encoding="utf-8",
    )
    grader.chmod(0o755)

    run_dir = tmp_path / "run"
    run_dir.mkdir()

    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_EditingMutator(),
        mutator_spec="harness:claude-code:sonnet",
        budget=1,
        grader_timeout_seconds=30,
        run_dir=run_dir,
    )

    assert result.best_score == 1.0
    assert result.best_sha  # non-empty sha
    # Source directory must be unchanged.
    assert (src / "planner.py").read_text(encoding="utf-8") == "score = 0\n"
    # Managed workspace exists inside run_dir.
    workdir = run_dir / "workdir"
    assert workdir.is_dir()
    assert (workdir / ".git").is_dir()
    # Run artifacts present.
    assert (run_dir / "mutations.jsonl").exists()
    assert (run_dir / "run.json").exists()


def test_source_dir_with_existing_git_is_not_mutated(tmp_path: Path) -> None:
    """Even if the source IS a git repo (with nested .git), hone shouldn't touch it."""
    import subprocess

    src = tmp_path / "controllers"
    src.mkdir()
    (src / "planner.py").write_text("score = 0\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=src, check=True)
    subprocess.run(["git", "add", "-A"], cwd=src, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init", "--no-verify"], cwd=src, check=True)
    original_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=src, check=True,
        capture_output=True, text=True,
    ).stdout.strip()

    grader = tmp_path / "grader.py"
    grader.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "root = pathlib.Path(sys.argv[1])\n"
        "text = (root / 'planner.py').read_text()\n"
        "print(1.0 if 'score = 1' in text else 0.0)\n",
        encoding="utf-8",
    )
    grader.chmod(0o755)

    run_dir = tmp_path / "run"
    run_dir.mkdir()

    optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_EditingMutator(),
        mutator_spec="harness:claude-code:sonnet",
        budget=1,
        grader_timeout_seconds=30,
        run_dir=run_dir,
    )

    # Source dir's HEAD and file are unchanged.
    post_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=src, check=True,
        capture_output=True, text=True,
    ).stdout.strip()
    assert post_sha == original_sha
    assert (src / "planner.py").read_text(encoding="utf-8") == "score = 0\n"


# ---------------------------------------------------------------------------
# Helpers shared by new tests
# ---------------------------------------------------------------------------

def _make_grader(tmp_path: Path, filename: str = "grader.py") -> Path:
    """Grader that reads x from v.py and prints it."""
    p = tmp_path / filename
    p.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "root = pathlib.Path(sys.argv[1])\n"
        "ns = {}\n"
        "exec((root / 'v.py').read_text(), ns)\n"
        "print(float(ns.get('x', 0)))\n",
        encoding="utf-8",
    )
    p.chmod(0o755)
    return p


def _make_src(tmp_path: Path, x: float = 0.0) -> Path:
    src = tmp_path / "src"
    src.mkdir()
    (src / "v.py").write_text(f"x = {x}\n", encoding="utf-8")
    return src


class _FailingMutator:
    def propose_edit_mode(self, prompt: str, workdir: Path) -> MutatorResult:
        raise MutatorError("always fails")


class _ScheduledMutator:
    def __init__(self, scores: list[float]) -> None:
        self._scores = scores
        self._idx = 0

    def propose_edit_mode(self, prompt: str, workdir: Path) -> MutatorResult:
        x = self._scores[self._idx]
        self._idx += 1
        (workdir / "v.py").write_text(f"x = {x}\n", encoding="utf-8")
        return MutatorResult(new_prompt="", tokens_in=0, tokens_out=0, cost_usd=0.0)


# ---------------------------------------------------------------------------
# Stall tests
# ---------------------------------------------------------------------------

def test_stall_on_mutator_error(tmp_path: Path) -> None:
    src = _make_src(tmp_path, x=0.0)
    grader = _make_grader(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_FailingMutator(),
        mutator_spec="harness:claude-code:sonnet",
        budget=10,
        grader_timeout_seconds=30,
        run_dir=run_dir,
        stall=2,
    )

    assert result.total_iterations == 2
    manifest = json.loads((run_dir / "run.json").read_text())
    assert manifest["status"] == "stalled"
    assert manifest["total_iterations"] == 2
    assert manifest["completed_iterations"] == 2


def test_stall_on_gate_rejection(tmp_path: Path) -> None:
    src = _make_src(tmp_path, x=0.0)
    grader = _make_grader(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_ScheduledMutator([1.0, 1.0, 1.0, 1.0, 1.0]),
        mutator_spec="harness:claude-code:sonnet",
        budget=10,
        grader_timeout_seconds=30,
        run_dir=run_dir,
        stall=2,
        gates=[GateSpec(name="always-fail", command="false")],
    )

    assert result.total_iterations == 2
    # Gates rejected every child — best stays at seed score 0.0
    assert result.best_score == pytest.approx(0.0)
    manifest = json.loads((run_dir / "run.json").read_text())
    assert manifest["status"] == "stalled"
    assert manifest["total_iterations"] == 2


def test_metric_direction_min(tmp_path: Path) -> None:
    src = _make_src(tmp_path, x=0.5)
    grader = _make_grader(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    # Iter 1 produces 0.3 (better in min), iter 2 produces 0.7 (worse)
    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_ScheduledMutator([0.3, 0.7]),
        mutator_spec="harness:claude-code:sonnet",
        budget=2,
        grader_timeout_seconds=30,
        run_dir=run_dir,
        metric_direction="min",
    )

    assert result.best_score == pytest.approx(0.3)


def test_manifest_status_stalled_and_iterations_accurate(tmp_path: Path) -> None:
    src = _make_src(tmp_path, x=0.0)
    grader = _make_grader(tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_FailingMutator(),
        mutator_spec="harness:claude-code:sonnet",
        budget=5,
        grader_timeout_seconds=30,
        run_dir=run_dir,
        stall=3,
    )

    assert result.total_iterations == 3
    manifest = json.loads((run_dir / "run.json").read_text())
    assert manifest["status"] == "stalled"
    assert manifest["total_iterations"] == manifest["completed_iterations"]
    assert manifest["completed_iterations"] == 3
