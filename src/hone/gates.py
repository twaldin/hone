"""Gate evaluation — run shell commands to validate a candidate workdir."""
from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class GateSpec:
    name: str
    command: str


@dataclass
class GateResult:
    name: str
    passed: bool
    returncode: int
    stdout: str
    stderr: str
    duration_s: float


def run_gates(
    gates: list[GateSpec],
    workdir: Path,
    timeout_seconds: int = 600,
) -> list[GateResult]:
    """Run gate commands sequentially against workdir. Nonzero exit = failed."""
    results: list[GateResult] = []
    for gate in gates:
        t0 = time.monotonic()
        try:
            proc = subprocess.run(  # noqa: S602
                gate.command,
                shell=True,
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
            duration = time.monotonic() - t0
            results.append(GateResult(
                name=gate.name,
                passed=proc.returncode == 0,
                returncode=proc.returncode,
                stdout=proc.stdout[:4000],
                stderr=proc.stderr[:4000],
                duration_s=duration,
            ))
        except subprocess.TimeoutExpired:
            duration = time.monotonic() - t0
            results.append(GateResult(
                name=gate.name,
                passed=False,
                returncode=-1,
                stdout="",
                stderr=f"Gate timed out after {timeout_seconds}s",
                duration_s=duration,
            ))
    return results


def rejected(results: list[GateResult]) -> bool:
    """True if any gate failed."""
    return any(not r.passed for r in results)
