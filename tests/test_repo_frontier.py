"""End-to-end test for the v1 git-native frontier loop with managed workspace."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hone.mutators.base import MutatorResult
from hone.repo_frontier import optimize_repo_frontier
from hone.scorer_result import ScorerResult
from hone.workers.base import Worker, WorkerAttempt, WorkerResult


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


def test_frontier_json_envelope_submetrics_in_mutations(tmp_path: Path) -> None:
    """Grader emitting JSON envelope: submetrics appear in mutations.jsonl seed + iter rows."""
    src = tmp_path / "controllers"
    src.mkdir()
    (src / "planner.py").write_text("score = 0\n", encoding="utf-8")

    grader = tmp_path / "grader.py"
    grader.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys, json\n"
        "root = pathlib.Path(sys.argv[1])\n"
        "text = (root / 'planner.py').read_text()\n"
        "if 'score = 1' in text:\n"
        "    print(json.dumps({'score': 1.0, 'submetrics': {'acc': 0.9, 'f1': 0.85}}))\n"
        "else:\n"
        "    print(json.dumps({'score': 0.0, 'submetrics': {'acc': 0.1, 'f1': 0.05}}))\n",
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

    mutations_path = run_dir / "mutations.jsonl"
    rows = [json.loads(line) for line in mutations_path.read_text().splitlines() if line.strip()]
    assert len(rows) == 2

    seed_row = rows[0]
    assert seed_row.get("kind") == "seed"
    assert "submetrics" in seed_row
    assert seed_row["submetrics"] == {"acc": pytest.approx(0.1), "f1": pytest.approx(0.05)}

    iter_row = rows[1]
    assert "submetrics" in iter_row
    assert iter_row["submetrics"] == {"acc": pytest.approx(0.9), "f1": pytest.approx(0.85)}
    assert "submetric_deltas" in iter_row
    assert "trace_count" in iter_row


def test_frontier_multi_attempt_worker(tmp_path: Path) -> None:
    """FakeMultiWorker with 2 attempts: best attempt (0.8) wins; scorer_calls==2."""

    class _TwoAttemptWorker(Worker):
        name = "two_attempt"

        def propose(self, *, prompt, workdir, scorer, scorer_budget):
            # Attempt 0: write low-score file
            (workdir / "planner.py").write_text("score = low\n", encoding="utf-8")
            sr0 = scorer(workdir)
            att0 = WorkerAttempt(
                attempt_idx=0, score=sr0.score, submetrics=sr0.submetrics,
                trace_stderr=sr0.trace_stderr, raw_stdout=sr0.raw_stdout,
                parsed_envelope=sr0.parsed_envelope, commit_sha=None,
            )
            # Attempt 1: write best-score file
            (workdir / "planner.py").write_text("score = best\n", encoding="utf-8")
            sr1 = scorer(workdir)
            att1 = WorkerAttempt(
                attempt_idx=1, score=sr1.score, submetrics=sr1.submetrics,
                trace_stderr=sr1.trace_stderr, raw_stdout=sr1.raw_stdout,
                parsed_envelope=sr1.parsed_envelope, commit_sha=None,
            )
            return WorkerResult(
                attempts=[att0, att1], best_attempt_idx=1, scorer_calls=2,
                tokens_in=None, tokens_out=None, cost_usd=None,
            )

    src = tmp_path / "controllers"
    src.mkdir()
    (src / "planner.py").write_text("score = 0\n", encoding="utf-8")

    grader = tmp_path / "grader.py"
    grader.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "root = pathlib.Path(sys.argv[1])\n"
        "text = (root / 'planner.py').read_text()\n"
        "if 'score = best' in text:\n"
        "    print(0.8)\n"
        "elif 'score = low' in text:\n"
        "    print(0.3)\n"
        "else:\n"
        "    print(0.0)\n",
        encoding="utf-8",
    )
    grader.chmod(0o755)

    run_dir = tmp_path / "run"
    run_dir.mkdir()

    class _StubMutator:
        def propose_edit_mode(self, prompt, workdir): ...

    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_StubMutator(),
        mutator_spec="harness:claude-code:sonnet",
        budget=1,
        grader_timeout_seconds=30,
        run_dir=run_dir,
        worker=_TwoAttemptWorker(),
        worker_scorer_budget=2,
    )

    assert result.best_score == pytest.approx(0.8)

    workdir = run_dir / "workdir"
    content = (workdir / "planner.py").read_text(encoding="utf-8")
    assert "score = best" in content

    mutations_path = run_dir / "mutations.jsonl"
    rows = [json.loads(line) for line in mutations_path.read_text().splitlines() if line.strip()]
    iter_row = next(r for r in rows if r.get("kind") != "seed")
    assert iter_row["scorer_calls"] == 2

    # Best attempt's commit_sha must be filled in the persisted trace.
    import json as _json
    traces_dir = run_dir / "traces"
    # iter-000 is the seed (no worker attempts); iter-001 is the first worker iteration.
    iter001 = traces_dir / "iter-001.json"
    assert iter001.exists(), "iter-001.json trace not written"
    trace = _json.loads(iter001.read_text())
    best_attempt_trace = next(a for a in trace["attempts"] if a["attempt_idx"] == 1)
    assert best_attempt_trace["commit_sha"] is not None, "best attempt commit_sha not set"


def test_frontier_grader_side_effects_not_committed(tmp_path: Path) -> None:
    """Grader writes output files inside workdir; those files must not be committed."""
    src = tmp_path / "controllers"
    src.mkdir()
    (src / "planner.py").write_text("score = 0\n", encoding="utf-8")

    grader = tmp_path / "grader.py"
    grader.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "root = pathlib.Path(sys.argv[1])\n"
        "text = (root / 'planner.py').read_text()\n"
        "(root / 'grader_output.log').write_text('graded\\n')\n"
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
    import subprocess
    workdir = run_dir / "workdir"
    committed = subprocess.run(
        ["git", "ls-files", "grader_output.log"], cwd=workdir,
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert committed == "", "grader side-effect file must not be committed"
    assert not (workdir / "grader_output.log").exists(), "grader side-effect file must not remain in workdir"


def test_frontier_multi_attempt_reordered_attempt_idx(tmp_path: Path) -> None:
    """Worker returns attempts in reversed list order; best_attempt.attempt_idx drives stash restore."""

    class _ReorderedWorker(Worker):
        name = "reordered"

        def propose(self, *, prompt, workdir, scorer, scorer_budget):
            # scorer call 0: low score
            (workdir / "planner.py").write_text("score = low\n", encoding="utf-8")
            sr0 = scorer(workdir)
            att0 = WorkerAttempt(
                attempt_idx=0, score=sr0.score, submetrics=sr0.submetrics,
                trace_stderr=sr0.trace_stderr, raw_stdout=sr0.raw_stdout,
                parsed_envelope=sr0.parsed_envelope, commit_sha=None,
            )
            # scorer call 1: high score
            (workdir / "planner.py").write_text("score = best\n", encoding="utf-8")
            sr1 = scorer(workdir)
            att1 = WorkerAttempt(
                attempt_idx=1, score=sr1.score, submetrics=sr1.submetrics,
                trace_stderr=sr1.trace_stderr, raw_stdout=sr1.raw_stdout,
                parsed_envelope=sr1.parsed_envelope, commit_sha=None,
            )
            # Return in REVERSED order: att1 at list index 0, att0 at list index 1.
            # best_attempt_idx=0 (list index) points to att1 (attempt_idx=1, high score).
            return WorkerResult(
                attempts=[att1, att0],
                best_attempt_idx=0,
                scorer_calls=2,
                tokens_in=None, tokens_out=None, cost_usd=None,
            )

    src = tmp_path / "controllers"
    src.mkdir()
    (src / "planner.py").write_text("score = 0\n", encoding="utf-8")

    grader = tmp_path / "grader.py"
    grader.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "root = pathlib.Path(sys.argv[1])\n"
        "text = (root / 'planner.py').read_text()\n"
        "if 'score = best' in text:\n"
        "    print(0.8)\n"
        "elif 'score = low' in text:\n"
        "    print(0.3)\n"
        "else:\n"
        "    print(0.0)\n",
        encoding="utf-8",
    )
    grader.chmod(0o755)

    run_dir = tmp_path / "run"
    run_dir.mkdir()

    class _StubMutator:
        def propose_edit_mode(self, prompt, workdir): ...

    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_StubMutator(),
        mutator_spec="harness:claude-code:sonnet",
        budget=1,
        grader_timeout_seconds=30,
        run_dir=run_dir,
        worker=_ReorderedWorker(),
        worker_scorer_budget=2,
    )

    assert result.best_score == pytest.approx(0.8)
    workdir = run_dir / "workdir"
    content = (workdir / "planner.py").read_text(encoding="utf-8")
    assert "score = best" in content, "best attempt (scorer call 1) must be committed, not the list-index-0 stash"


def test_frontier_noop_first_attempt(tmp_path: Path) -> None:
    """Worker makes no file changes on first scorer call; second attempt wins."""

    class _NoopFirstWorker(Worker):
        name = "noop_first"

        def propose(self, *, prompt, workdir, scorer, scorer_budget):
            # First attempt: no changes — scores the parent state
            sr0 = scorer(workdir)
            att0 = WorkerAttempt(
                attempt_idx=0, score=sr0.score, submetrics=sr0.submetrics,
                trace_stderr=sr0.trace_stderr, raw_stdout=sr0.raw_stdout,
                parsed_envelope=sr0.parsed_envelope, commit_sha=None,
            )
            # Second attempt: write winning content
            (workdir / "planner.py").write_text("score = 1\n", encoding="utf-8")
            sr1 = scorer(workdir)
            att1 = WorkerAttempt(
                attempt_idx=1, score=sr1.score, submetrics=sr1.submetrics,
                trace_stderr=sr1.trace_stderr, raw_stdout=sr1.raw_stdout,
                parsed_envelope=sr1.parsed_envelope, commit_sha=None,
            )
            return WorkerResult(
                attempts=[att0, att1],
                best_attempt_idx=1,
                scorer_calls=2,
                tokens_in=None, tokens_out=None, cost_usd=None,
            )

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

    class _StubMutator:
        def propose_edit_mode(self, prompt, workdir): ...

    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=grader,
        mutator=_StubMutator(),
        mutator_spec="harness:claude-code:sonnet",
        budget=1,
        grader_timeout_seconds=30,
        run_dir=run_dir,
        worker=_NoopFirstWorker(),
        worker_scorer_budget=2,
    )

    assert result.best_score == pytest.approx(1.0)
    workdir = run_dir / "workdir"
    content = (workdir / "planner.py").read_text(encoding="utf-8")
    assert "score = 1" in content
