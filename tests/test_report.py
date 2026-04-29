from __future__ import annotations

import json
from pathlib import Path

from hone.report import generate_report, write_report


def test_generate_report_contains_required_sections(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "run_id": "run-123",
                "status": "stalled",
                "metric_direction": "max",
                "budget": 5,
                "total_iterations": 3,
                "best_idx": 1,
                "best_score": 0.8,
                "best_sha": "abcdef1234567890",
            }
        ),
        encoding="utf-8",
    )

    rows = [
        {"iter": 0, "candidate_idx": 0, "sha": "seedsha", "score": 0.5, "utility": 0.5, "kind": "seed", "frontier": [0]},
        {
            "iter": 1,
            "parent_idx": 0,
            "child_idx": 1,
            "parent_sha": "seedsha",
            "child_sha": "abcdef1234567890",
            "parent_score": 0.5,
            "child_score": 0.8,
            "utility": 0.8,
            "delta": 0.3,
            "changed_files": ["a.py"],
            "frontier": [1],
        },
        {"iter": 2, "parent_idx": 1, "kind": "mutator_error", "error": "boom", "frontier": [1]},
        {
            "iter": 3,
            "parent_idx": 1,
            "child_idx": 2,
            "kind": "gate_rejected",
            "child_sha": "deadbeef",
            "parent_score": 0.8,
            "child_score": 0.7,
            "delta": -0.1,
            "failing_gates": ["lint"],
            "gate_results": [{"name": "lint", "passed": False, "stderr": "E1 bad thing happened"}],
            "changed_files": ["b.py"],
            "frontier": [1],
        },
    ]
    (run_dir / "mutations.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")

    report = generate_report(run_dir)

    assert "status: **stalled**" in report
    assert "raw score: `0.8`" in report
    assert "## 4) Score trend" in report
    assert any(ch in report for ch in "▁▂▃▄▅▆▇█")
    assert "gate_rejected" in report


def test_write_report_to_directory(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    out_dir = tmp_path / "out"
    run_dir.mkdir()
    out_dir.mkdir()
    (run_dir / "run.json").write_text("{}", encoding="utf-8")
    (run_dir / "mutations.jsonl").write_text("", encoding="utf-8")

    output = write_report(run_dir, out_dir)
    assert output == out_dir / "report.md"
    assert output.exists()
