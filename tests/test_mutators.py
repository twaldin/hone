"""Tests for mutator resolution — v1 is harness-only."""
from __future__ import annotations

import pytest

from hone.mutators import HarnessMutator, resolve
from hone.mutators.base import MutatorError, MutatorResult


def test_resolve_harness_with_model() -> None:
    m = resolve("harness:claude-code:sonnet")
    assert isinstance(m, HarnessMutator)
    assert m.harness_name == "claude-code"
    assert m.model == "sonnet"


def test_resolve_harness_without_model() -> None:
    m = resolve("harness:opencode")
    assert isinstance(m, HarnessMutator)
    assert m.harness_name == "opencode"
    assert m.model is None


def test_resolve_harness_with_slashed_model() -> None:
    m = resolve("harness:opencode:openai/gpt-5.4")
    assert isinstance(m, HarnessMutator)
    assert m.harness_name == "opencode"
    assert m.model == "openai/gpt-5.4"


def test_resolve_rejects_non_harness_spec() -> None:
    with pytest.raises(ValueError):
        resolve("claude-code:sonnet")


def test_resolve_rejects_custom_script() -> None:
    with pytest.raises(ValueError):
        resolve("./mutate.sh")


def test_resolve_harness_empty_raises() -> None:
    with pytest.raises(ValueError):
        resolve("harness:")


def test_harness_mutator_uses_harness_run(monkeypatch) -> None:
    from harness import RunResult

    captured = {}

    def fake_run(spec):
        captured["spec"] = spec
        return RunResult(
            harness="claude-code",
            model="sonnet",
            exit_code=0,
            duration_seconds=1.0,
            stdout='{"type":"result","result":"new prompt v2","usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":0.001}',
            stderr="",
            timed_out=False,
            cost_usd=0.001,
            tokens_in=10,
            tokens_out=5,
            raw={"type": "result", "result": "new prompt v2", "usage": {"input_tokens": 10, "output_tokens": 5}, "total_cost_usd": 0.001},
        )

    monkeypatch.setattr("harness.run", fake_run)

    m = HarnessMutator(harness_name="claude-code", model="sonnet")
    result = m.propose("mutate this prompt")

    assert isinstance(result, MutatorResult)
    assert result.new_prompt == "new prompt v2"
    assert result.tokens_in == 10
    assert result.tokens_out == 5
    assert result.cost_usd == 0.001
    assert captured["spec"].harness == "claude-code"
    assert captured["spec"].model == "sonnet"
    assert captured["spec"].prompt == "mutate this prompt"


def test_harness_mutator_raises_on_failure(monkeypatch) -> None:
    from harness import RunResult

    def fake_run(spec):
        return RunResult(
            harness="claude-code",
            model="sonnet",
            exit_code=2,
            duration_seconds=0.5,
            stdout="",
            stderr="auth error",
            timed_out=False,
            cost_usd=None,
            tokens_in=None,
            tokens_out=None,
            raw=None,
        )

    monkeypatch.setattr("harness.run", fake_run)
    m = HarnessMutator(harness_name="claude-code")
    with pytest.raises(MutatorError) as exc:
        m.propose("x")
    assert "exited 2" in str(exc.value)
    assert "auth error" in str(exc.value)
