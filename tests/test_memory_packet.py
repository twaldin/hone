"""Tests for memory_packet.py — build_memory_packet and render_memory_packet."""
from __future__ import annotations

import pytest

from hone.memory_packet import build_memory_packet, render_memory_packet
from hone.repo_frontier import AttemptRecord, RepoCandidate


def _make_candidate(idx: int, score: float, submetrics: dict, traces: list | None = None) -> RepoCandidate:
    return RepoCandidate(
        idx=idx,
        sha=f"sha{idx:03d}",
        branch=f"hone/run/iter-{idx:03d}",
        score=score,
        trace_stderr="",
        raw_stdout="",
        parent_idx=max(idx - 1, 0) if idx > 0 else None,
        parent_sha=f"sha{idx-1:03d}" if idx > 0 else None,
        parent_diff_stat=f"M file{idx}.py" if idx > 0 else "(seed)",
        parent_diff_patch="",
        base_diff_stat=f"M file{idx}.py" if idx > 0 else "(seed)",
        base_diff_patch="",
        changed_files_from_parent=[f"file{idx}.py"] if idx > 0 else [],
        submetrics=submetrics,
        traces=traces or [],
    )


def _make_attempt(iteration: int, parent_idx: int, child_idx: int | None,
                  parent_score: float, child_score: float | None,
                  submetric_deltas: dict | None = None) -> AttemptRecord:
    return AttemptRecord(
        iteration=iteration,
        parent_idx=parent_idx,
        child_idx=child_idx,
        parent_score=parent_score,
        child_score=child_score,
        changed_files=[f"file{iteration}.py"],
        trace_summary=f"trace for iter {iteration}",
        accepted=child_idx is not None,
        submetric_deltas=submetric_deltas or {},
    )


def test_build_memory_packet_submetric_deltas():
    seed = _make_candidate(0, 0.5, {"a": 0.3, "b": 0.7})
    parent = _make_candidate(1, 0.6, {"a": 0.4, "b": 0.8})
    best = _make_candidate(2, 0.7, {"a": 0.6, "b": 0.85})

    attempts = [
        _make_attempt(1, 0, 1, 0.5, 0.6, {"a": 0.1, "b": 0.1}),
        _make_attempt(2, 1, 2, 0.6, 0.7, {"a": 0.2, "b": 0.05}),
        _make_attempt(3, 2, None, 0.7, None),
    ]

    packet = build_memory_packet(parent=parent, best=best, seed=seed, attempts=attempts, window=6)

    assert packet.parent_score == pytest.approx(0.6)
    assert packet.best_score == pytest.approx(0.7)
    assert packet.seed_score == pytest.approx(0.5)
    # submetric_deltas: best - parent
    assert packet.submetric_deltas["a"] == pytest.approx(0.6 - 0.4)
    assert packet.submetric_deltas["b"] == pytest.approx(0.85 - 0.8)


def test_build_memory_packet_top_failing_submetrics_sorted_ascending():
    seed = _make_candidate(0, 0.5, {})
    parent = _make_candidate(1, 0.6, {"a": 0.9, "b": 0.2, "c": 0.5, "d": 0.1})
    best = _make_candidate(2, 0.7, {})

    packet = build_memory_packet(parent=parent, best=best, seed=seed, attempts=[], window=6, submetric_top_k=3)

    # Sorted ascending by score, limited to k=3
    names = [k for k, _ in packet.top_failing_submetrics]
    scores = [v for _, v in packet.top_failing_submetrics]
    assert names == ["d", "b", "c"]
    assert scores == pytest.approx([0.1, 0.2, 0.5])
    assert len(packet.top_failing_submetrics) == 3


def test_build_memory_packet_recent_attempts_windowed():
    seed = _make_candidate(0, 0.5, {})
    parent = _make_candidate(1, 0.6, {})
    best = _make_candidate(1, 0.6, {})

    attempts = [_make_attempt(i, i - 1, i, float(i) * 0.1, float(i) * 0.1 + 0.05) for i in range(1, 10)]

    packet = build_memory_packet(parent=parent, best=best, seed=seed, attempts=attempts, window=3)
    assert len(packet.recent_attempts) == 3
    assert packet.recent_attempts[-1]["iter"] == 9


def test_render_memory_packet_respects_max_attempts():
    seed = _make_candidate(0, 0.5, {})
    parent = _make_candidate(1, 0.6, {})
    best = _make_candidate(1, 0.6, {})

    attempts = [_make_attempt(i, i - 1, i, 0.5, 0.6) for i in range(1, 8)]
    packet = build_memory_packet(parent=parent, best=best, seed=seed, attempts=attempts, window=7)

    rendered = render_memory_packet(packet, max_trace_chars=500, max_attempts=2)
    # Only last 2 attempts should appear
    assert "iter=6" in rendered or "iter=7" in rendered
    assert "iter=1" not in rendered


def test_render_memory_packet_truncates_traces():
    seed = _make_candidate(0, 0.5, {})
    parent = _make_candidate(1, 0.6, {}, traces=[{"case": "x" * 200} for _ in range(20)])
    best = _make_candidate(1, 0.6, {})

    packet = build_memory_packet(parent=parent, best=best, seed=seed, attempts=[], window=6)
    rendered = render_memory_packet(packet, max_trace_chars=100, max_attempts=6)
    assert "...[truncated]" in rendered


def test_render_memory_packet_no_traces_or_submetrics():
    seed = _make_candidate(0, 0.5, {})
    parent = _make_candidate(1, 0.6, {})
    best = _make_candidate(1, 0.6, {})

    packet = build_memory_packet(parent=parent, best=best, seed=seed, attempts=[], window=6)
    rendered = render_memory_packet(packet, max_trace_chars=1000, max_attempts=6)

    assert "submetric_deltas: (none)" in rendered
    assert "structured_traces: (none)" in rendered
    assert "recent_attempts: (none)" in rendered
    assert "top_failing_submetrics: (none)" in rendered
