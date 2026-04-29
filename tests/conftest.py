"""Shared test fixtures and stubs.

Inserts a minimal ``harness`` stub into sys.modules so tests that exercise
HarnessMutator (and monkeypatch harness.run) work without the real harness
package installed.
"""
from __future__ import annotations

import sys
import types
from dataclasses import dataclass, field
from typing import Any


def _build_harness_stub() -> types.ModuleType:
    mod = types.ModuleType("harness")

    class HarnessError(RuntimeError):
        pass

    @dataclass
    class RunSpec:
        harness: str
        prompt: str
        workdir: Any = None
        model: str | None = None
        timeout_seconds: int = 1800

    @dataclass
    class RunResult:
        harness: str
        model: str | None
        exit_code: int
        duration_seconds: float
        stdout: str
        stderr: str
        timed_out: bool
        cost_usd: float | None = None
        tokens_in: int | None = None
        tokens_out: int | None = None
        raw: Any = None

        @property
        def ok(self) -> bool:
            return self.exit_code == 0 and not self.timed_out

    def run(spec: RunSpec) -> RunResult:  # pragma: no cover
        raise HarnessError("stub harness.run — monkeypatch this in tests")

    mod.HarnessError = HarnessError
    mod.RunSpec = RunSpec
    mod.RunResult = RunResult
    mod.run = run
    return mod


if "harness" not in sys.modules:
    sys.modules["harness"] = _build_harness_stub()
