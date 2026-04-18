"""Tests for reflective.py — grader stderr parsing into GEPA's reflective_dataset format."""
from __future__ import annotations

from hone.reflective import build_reflective_dataset, parse_trace


def test_parses_id_colon_trace_lines() -> None:
    stderr = "click-pr2421: 3/3 fixed\nkoa-1834: 0/7 failed (modified wrong file)"
    traces = parse_trace(stderr)
    ids = [t.example_id for t in traces]
    assert "click-pr2421" in ids
    assert "koa-1834" in ids


def test_falls_back_to_single_aggregate_when_no_matches() -> None:
    stderr = "some\nfree-form\ngrader output with no\nstructure"
    traces = parse_trace(stderr)
    assert len(traces) == 1
    assert traces[0].example_id == "aggregate"
    assert "free-form" in traces[0].trace


def test_build_reflective_dataset_wraps_per_component() -> None:
    stderr = "example_a: first\nexample_b: second"
    ds = build_reflective_dataset(stderr=stderr, score=0.75, component="instruction")
    assert "instruction" in ds
    rows = ds["instruction"]
    assert len(rows) == 2
    assert all(row["score"] == 0.75 for row in rows)
    assert {row["example_id"] for row in rows} == {"example_a", "example_b"}
