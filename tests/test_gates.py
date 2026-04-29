"""Tests for gates.py — run_gates and rejected helper."""
from __future__ import annotations

from pathlib import Path

import pytest

from hone.gates import GateSpec, run_gates, rejected


def test_all_pass_gates_not_rejected(tmp_path: Path) -> None:
    gates = [
        GateSpec(name="true1", command="true"),
        GateSpec(name="true2", command="true"),
    ]
    results = run_gates(gates, tmp_path)
    assert len(results) == 2
    assert all(r.passed for r in results)
    assert rejected(results) is False


def test_one_failing_gate_rejected(tmp_path: Path) -> None:
    gates = [
        GateSpec(name="pass", command="true"),
        GateSpec(name="fail", command="false"),
    ]
    results = run_gates(gates, tmp_path)
    assert rejected(results) is True
    fail_result = next(r for r in results if r.name == "fail")
    assert fail_result.passed is False
    assert fail_result.returncode != 0


def test_failing_gate_captures_stderr(tmp_path: Path) -> None:
    gates = [GateSpec(name="err", command="echo 'oops' >&2; exit 1")]
    results = run_gates(gates, tmp_path)
    assert rejected(results) is True
    assert "oops" in results[0].stderr


def test_timeout_produces_failed_gate(tmp_path: Path) -> None:
    gates = [GateSpec(name="slow", command="sleep 60")]
    results = run_gates(gates, tmp_path, timeout_seconds=1)
    assert len(results) == 1
    assert results[0].passed is False
    assert "timed out" in results[0].stderr.lower()


def test_empty_gate_list(tmp_path: Path) -> None:
    results = run_gates([], tmp_path)
    assert results == []
    assert rejected(results) is False
