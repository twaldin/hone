from __future__ import annotations

import json
from pathlib import Path

from hone.gates import GateSpec
from hone.mutators.base import MutatorResult
from hone.repo_frontier import optimize_repo_frontier
from hone.report import generate_report


class _CounterMutator:
    def __init__(self, values: list[int]) -> None:
        self._values = values
        self._idx = 0

    def propose_edit_mode(self, prompt: str, workdir: Path) -> MutatorResult:
        value = self._values[self._idx]
        self._idx += 1
        (workdir / "counter.py").write_text(f"value = {value}\n", encoding="utf-8")
        return MutatorResult(new_prompt="", tokens_in=0, tokens_out=0, cost_usd=0.0)


def test_e2e_smoke_json_scorer_gates_report(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    (src / "counter.py").write_text("value = 0\n", encoding="utf-8")

    run_dir = tmp_path / "run"
    run_dir.mkdir()

    scorer_path = Path(__file__).resolve().parents[1] / "examples" / "scorer-json" / "scorer.sh"
    scorer_path.chmod(0o755)

    result = optimize_repo_frontier(
        src_dir=src,
        grader_path=scorer_path,
        scorer_path=scorer_path,
        mutator=_CounterMutator([1, 2]),
        mutator_spec="harness:claude-code:sonnet",
        budget=2,
        frontier_size=2,
        grader_timeout_seconds=30,
        run_dir=run_dir,
        metric_direction="max",
        stall=None,
        gates=[GateSpec(name="counter-exists", command="test -f counter.py")],
    )

    assert result.total_iterations == 2
    assert result.best_score == 2.0

    manifest = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "done"

    rows = [
        json.loads(line)
        for line in (run_dir / "mutations.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    accepted_rows = [row for row in rows if row.get("child_idx") is not None and row.get("kind", "accepted") == "accepted"]
    assert accepted_rows
    for row in accepted_rows:
        assert row.get("gate_results")
        assert all(gate["passed"] for gate in row["gate_results"])

    report = generate_report(run_dir)
    assert "raw score: `2.0`" in report
    assert "metric_direction: `max`" in report
