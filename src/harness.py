"""Minimal harness stub — the real harness is an optional external package.

Provides just enough for tests to import and monkeypatch harness.run without
installing the full harness library.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class HarnessError(RuntimeError):
    pass


@dataclass
class RunSpec:
    harness: str
    prompt: str
    workdir: Path
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


def run(spec: RunSpec) -> RunResult:
    raise HarnessError(
        "harness library not installed — install the real harness package for production use"
    )
