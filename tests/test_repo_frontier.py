"""End-to-end test for the v1 git-native frontier loop with managed workspace."""
from __future__ import annotations

from pathlib import Path

from hone.mutators.base import MutatorResult
from hone.repo_frontier import optimize_repo_frontier


class _EditingMutator:
    """Deterministic mutator that sets planner.py to `score = 1` on every call."""

    def __init__(self) -> None:
        self.calls = 0

    def propose_edit_mode(self, prompt: str, workdir: Path) -> MutatorResult:
        self.calls += 1
        (workdir / "planner.py").write_text("score = 1\n", encoding="utf-8")
        return MutatorResult(new_prompt="", tokens_in=10, tokens_out=5, cost_usd=0.01)


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
