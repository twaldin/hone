"""Tests for mutator resolution — custom scripts + registry."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from hone.mutators import HarnessMutator, resolve
from hone.mutators.base import MutatorError, MutatorResult
from hone.mutators.claude_code import ClaudeCodeMutator
from hone.mutators.custom_script import CustomScriptMutator


def test_resolve_claude_code_with_model() -> None:
    m = resolve("claude-code:sonnet")
    assert isinstance(m, ClaudeCodeMutator)
    assert m.model == "sonnet"


def test_resolve_claude_code_default_model() -> None:
    m = resolve("claude-code")
    assert isinstance(m, ClaudeCodeMutator)
    assert m.model is None


def test_resolve_custom_script_relative(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    script = tmp_path / "mutate.sh"
    script.write_text("#!/bin/sh\necho test")
    os.chmod(script, 0o755)
    monkeypatch.chdir(tmp_path)

    m = resolve("./mutate.sh")
    assert isinstance(m, CustomScriptMutator)


def test_resolve_unknown_raises() -> None:
    with pytest.raises(ValueError):
        resolve("not-a-real-backend")


def test_custom_script_rejects_missing_file() -> None:
    with pytest.raises(MutatorError):
        CustomScriptMutator("/tmp/does-not-exist.sh")


# --- harness:* dispatch ---------------------------------------------------


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
    """Models like 'openai/gpt-5.4' must survive the split."""
    m = resolve("harness:opencode:openai/gpt-5.4")
    assert isinstance(m, HarnessMutator)
    assert m.harness_name == "opencode"
    assert m.model == "openai/gpt-5.4"


def test_resolve_harness_empty_raises() -> None:
    with pytest.raises(ValueError):
        resolve("harness:")


def test_harness_mutator_uses_harness_run(monkeypatch, tmp_path) -> None:
    """HarnessMutator.propose() should call harness.run() and convert RunResult -> MutatorResult."""
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


def test_claude_code_mutator_delegates_to_harness(monkeypatch) -> None:
    """ClaudeCodeMutator should route through harness.run() with harness='claude-code'.

    Locks in the post-migration behavior: no direct subprocess.run('claude', ...)
    calls; all CLI plumbing lives in harness.
    """
    from harness import RunResult

    captured = {}

    def fake_run(spec):
        captured["spec"] = spec
        return RunResult(
            harness="claude-code",
            model=spec.model,
            exit_code=0,
            duration_seconds=1.0,
            stdout='{"type":"result","result":"mutated","usage":{"input_tokens":7,"output_tokens":3},"total_cost_usd":0.0005}',
            stderr="",
            timed_out=False,
            cost_usd=0.0005,
            tokens_in=7,
            tokens_out=3,
            raw={"type": "result", "result": "mutated", "usage": {"input_tokens": 7, "output_tokens": 3}, "total_cost_usd": 0.0005},
        )

    monkeypatch.setattr("harness.run", fake_run)

    m = ClaudeCodeMutator(model=None)
    result = m.propose("please mutate")

    assert result.new_prompt == "mutated"
    assert result.tokens_in == 7
    assert result.tokens_out == 3
    assert result.cost_usd == 0.0005
    assert captured["spec"].harness == "claude-code"
    # Default model "sonnet" is applied at propose time when init model is None.
    assert captured["spec"].model == "sonnet"


def test_claude_code_mutator_passes_explicit_model(monkeypatch) -> None:
    from harness import RunResult

    captured = {}

    def fake_run(spec):
        captured["spec"] = spec
        return RunResult(
            harness="claude-code", model=spec.model, exit_code=0, duration_seconds=0.1,
            stdout='{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.0001}',
            stderr="", timed_out=False, cost_usd=0.0001, tokens_in=1, tokens_out=1,
            raw={"type": "result", "result": "ok", "usage": {"input_tokens": 1, "output_tokens": 1}, "total_cost_usd": 0.0001},
        )

    monkeypatch.setattr("harness.run", fake_run)
    ClaudeCodeMutator(model="haiku").propose("x")
    assert captured["spec"].model == "haiku"


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


def test_harness_mutator_rejects_unsupported_response_extraction(monkeypatch) -> None:
    """codex/aider/swe-agent are coding loops, not text generators — should error clearly."""
    from harness import RunResult

    def fake_run(spec):
        return RunResult(
            harness="codex",
            model="gpt-5.3-codex",
            exit_code=0,
            duration_seconds=1.0,
            stdout="some output",
            stderr="",
            timed_out=False,
            cost_usd=None,
            tokens_in=None,
            tokens_out=None,
            raw=None,
        )

    monkeypatch.setattr("harness.run", fake_run)
    m = HarnessMutator(harness_name="codex")
    with pytest.raises(MutatorError) as exc:
        m.propose("x")
    assert "not currently usable as a mutator" in str(exc.value)
