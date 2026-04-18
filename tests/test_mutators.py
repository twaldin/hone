"""Tests for mutator resolution — custom scripts + registry."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from hone.mutators import resolve
from hone.mutators.base import MutatorError
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
