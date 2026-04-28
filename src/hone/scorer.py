"""Scorer invocation — runs user's scorer script against a candidate workdir."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


class ScorerError(RuntimeError):
    """Raised when a scorer cannot be invoked or returns unparseable output."""


@dataclass
class ScorerResult:
    raw_score: float
    utility: float
    trace_stderr: str
    raw_stdout: str
    returncode: int
    metrics: dict = field(default_factory=dict)
    tasks: list = field(default_factory=list)
    gate_results: list = field(default_factory=list)
    json_path_used: bool = False

    @property
    def score(self) -> float:
        """Backward-compat alias for raw_score."""
        return self.raw_score


def run_scorer(
    scorer: str | Path,
    workdir: str | Path,
    timeout_seconds: int = 3600,
    metric_direction: str = "max",
    env: dict | None = None,
) -> ScorerResult:
    """Run the scorer script against a workdir, parse result via JSON path or stdout fallback.

    Contract:
      - scorer is invoked as: `<scorer> <workdir>`
      - HONE_RESULT_PATH: path to a tempfile the scorer MAY write JSON to
      - HONE_TRACE_DIR: a tempdir the scorer MAY write per-task traces to
      - If HONE_RESULT_PATH contains valid JSON with numeric 'score', that takes precedence
      - Otherwise falls back to parsing the last float on stdout
      - non-zero exit returns raw_score=0.0 (caller decides what to do)
    """
    scorer_path = Path(scorer).expanduser().resolve()
    if not scorer_path.exists():
        raise ScorerError(f"Scorer not found: {scorer_path}")

    result_fd, result_path = tempfile.mkstemp(suffix=".json", prefix="hone_result_")
    os.close(result_fd)
    trace_dir = tempfile.mkdtemp(prefix="hone_trace_")

    try:
        run_env = os.environ.copy()
        if env:
            run_env.update(env)
        run_env["HONE_RESULT_PATH"] = result_path
        run_env["HONE_TRACE_DIR"] = trace_dir

        try:
            proc = subprocess.run(  # noqa: S603
                [str(scorer_path), str(workdir)],
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
                env=run_env,
            )
        except subprocess.TimeoutExpired as e:
            raise ScorerError(f"Scorer timed out after {timeout_seconds}s") from e

        if proc.returncode != 0:
            raw: float = 0.0
            utility = raw if metric_direction == "max" else -raw
            return ScorerResult(
                raw_score=raw,
                utility=utility,
                trace_stderr=proc.stderr,
                raw_stdout=proc.stdout,
                returncode=proc.returncode,
            )

        raw_score: float | None = None
        metrics: dict = {}
        tasks: list = []
        json_path_used = False
        utility_override: float | None = None

        result_content = Path(result_path).read_text(encoding="utf-8").strip()
        if result_content:
            try:
                data = json.loads(result_content)
                if isinstance(data, dict) and isinstance(data.get("score"), (int, float)):
                    raw_score = float(data["score"])
                    metrics = data.get("metrics") or {}
                    tasks = data.get("tasks") or []
                    if isinstance(data.get("utility"), (int, float)):
                        utility_override = float(data["utility"])
                    json_path_used = True
            except (json.JSONDecodeError, ValueError, TypeError):
                pass

        if raw_score is None:
            raw_score = _parse_score(proc.stdout)

        if utility_override is not None and json_path_used:
            utility = utility_override
        elif metric_direction == "min":
            utility = -raw_score
        else:
            utility = raw_score

        return ScorerResult(
            raw_score=raw_score,
            utility=utility,
            trace_stderr=proc.stderr,
            raw_stdout=proc.stdout,
            returncode=0,
            metrics=metrics,
            tasks=tasks,
            json_path_used=json_path_used,
        )
    finally:
        try:
            os.unlink(result_path)
        except OSError:
            pass
        try:
            shutil.rmtree(trace_dir, ignore_errors=True)
        except Exception:
            pass


def _parse_score(stdout: str) -> float:
    """Extract the final float from stdout. Tolerates leading junk."""
    for line in reversed(stdout.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            return float(stripped)
        except ValueError:
            continue
    raise ScorerError(
        f"Scorer stdout had no parseable float on any line. Got: {stdout[:200]!r}"
    )
