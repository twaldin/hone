"""Tests for detect_component_kind and HoneProposer syntax validation."""
from __future__ import annotations

from pathlib import Path

import pytest

from hone.kinds import detect_component_kind
from hone.mutators.base import MutatorError, MutatorResult
from hone.proposer import HoneProposer, _build_mutator_prompt


# --- detect_component_kind --------------------------------------------------


def test_py_is_code_python() -> None:
    assert detect_component_kind("planner.py") == "code:python"


def test_ts_is_code_typescript() -> None:
    assert detect_component_kind("app.ts") == "code:typescript"


def test_tsx_is_code_typescript() -> None:
    assert detect_component_kind("App.tsx") == "code:typescript"


def test_js_is_code_javascript() -> None:
    assert detect_component_kind("index.js") == "code:javascript"


def test_jsx_is_code_javascript() -> None:
    assert detect_component_kind("Component.jsx") == "code:javascript"


def test_go_is_code_go() -> None:
    assert detect_component_kind("main.go") == "code:go"


def test_rs_is_code_rust() -> None:
    assert detect_component_kind("lib.rs") == "code:rust"


def test_md_defaults_to_prompt() -> None:
    assert detect_component_kind("prompt.md") == "prompt"


def test_unknown_extension_defaults_to_prompt() -> None:
    assert detect_component_kind("something.xyz") == "prompt"


def test_path_object_works() -> None:
    assert detect_component_kind(Path("/some/path/module.py")) == "code:python"


def test_case_insensitive() -> None:
    assert detect_component_kind("Module.PY") == "code:python"


# --- _build_mutator_prompt --------------------------------------------------


def test_code_python_template_forbids_tools() -> None:
    prompt = _build_mutator_prompt("x = 1", [], "instruction", kind="code:python")
    assert "Do not use Edit or Write tools" in prompt
    assert "plain text" in prompt
    assert "no markdown fences" in prompt.lower() or "NO markdown fences" in prompt


def test_code_python_template_has_python_label() -> None:
    prompt = _build_mutator_prompt("x = 1", [], "instruction", kind="code:python")
    assert "Python" in prompt


def test_prompt_kind_uses_original_template() -> None:
    prompt = _build_mutator_prompt("be helpful", [], "instruction", kind="prompt")
    assert "improved prompt text" in prompt
    assert "Do not use Edit or Write tools" not in prompt


def test_unknown_kind_uses_prompt_template() -> None:
    prompt = _build_mutator_prompt("be helpful", [], "instruction", kind="something-else")
    assert "improved prompt text" in prompt


# --- HoneProposer syntax validation -----------------------------------------


class _FakeMutator:
    """Controlled mutator for testing: cycles through prepared responses."""

    def __init__(self, responses: list[str]) -> None:
        self._queue = list(responses)
        self.calls: list[str] = []

    def propose(self, prompt: str) -> MutatorResult:
        self.calls.append(prompt)
        if not self._queue:
            raise MutatorError("no more responses")
        text = self._queue.pop(0)
        return MutatorResult(new_prompt=text, tokens_in=1, tokens_out=1, cost_usd=0.0)


def test_valid_python_passes_through() -> None:
    mutator = _FakeMutator(["x = 1\n"])
    proposer = HoneProposer(mutator=mutator, kind="code:python")  # type: ignore[arg-type]
    result = proposer({"instruction": "x = 0"}, {}, ["instruction"])
    assert result["instruction"] == "x = 1\n"
    assert len(mutator.calls) == 1


def test_invalid_python_triggers_retry() -> None:
    mutator = _FakeMutator(["def broken(\n", "x = 1\n"])
    proposer = HoneProposer(mutator=mutator, kind="code:python")  # type: ignore[arg-type]
    result = proposer({"instruction": "x = 0"}, {}, ["instruction"])
    assert result["instruction"] == "x = 1\n"
    assert len(mutator.calls) == 2
    assert "SYNTAX ERROR" in mutator.calls[1]


def test_two_invalid_python_raises_mutator_error() -> None:
    mutator = _FakeMutator(["def broken(\n", "def also_broken(\n"])
    proposer = HoneProposer(mutator=mutator, kind="code:python")  # type: ignore[arg-type]
    with pytest.raises(MutatorError, match="invalid_output"):
        proposer({"instruction": "x = 0"}, {}, ["instruction"])
    assert proposer.stats.failures >= 1


def test_prompt_kind_skips_syntax_check() -> None:
    mutator = _FakeMutator(["def broken(\n"])
    proposer = HoneProposer(mutator=mutator, kind="prompt")  # type: ignore[arg-type]
    result = proposer({"instruction": "be helpful"}, {}, ["instruction"])
    assert result["instruction"] == "def broken(\n"
