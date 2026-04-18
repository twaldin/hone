"""GEPAAdapter implementation — plugs hone's grader/mutator into GEPA's optimize loop.

hone's abstraction:
    - A "DataInst" is a grader invocation spec. v0.1 uses a single-element
      trainset so each iteration = one grader run over whatever examples the
      grader script chooses to evaluate internally.
    - Score = the float the grader printed on its last stdout line.
    - Trajectory = the grader's stderr, used to build the reflective_dataset
      for the mutator LLM.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from gepa import EvaluationBatch, GEPAAdapter

from hone.grader import GraderResult, run_grader
from hone.reflective import build_reflective_dataset


@dataclass
class GraderSpec:
    """What GEPA passes in the trainset/valset. Currently just a label."""

    name: str = "grader-run"


@dataclass
class GraderTrajectory:
    """Per-example trajectory returned from evaluate(). We store the raw grader result."""

    result: GraderResult


class HoneAdapter(GEPAAdapter):
    """Run the user's grader against a candidate prompt.

    The "component" GEPA mutates is the prompt text. Default component name is
    'instruction' so it matches GEPA's built-in reflection conventions.
    """

    def __init__(
        self,
        grader_path: str | Path,
        component_name: str = "instruction",
        grader_timeout_seconds: int = 3600,
    ) -> None:
        self.grader_path = Path(grader_path).expanduser().resolve()
        self.component_name = component_name
        self.grader_timeout_seconds = grader_timeout_seconds

    def evaluate(
        self,
        batch: list[GraderSpec],
        candidate: dict[str, str],
        capture_traces: bool = False,
    ) -> EvaluationBatch[GraderTrajectory, GraderResult]:
        prompt_text = candidate.get(self.component_name, "")
        outputs: list[GraderResult] = []
        scores: list[float] = []
        trajectories: list[GraderTrajectory] = []

        for _item in batch:
            # Write candidate prompt to a temp file so grader can read it.
            import tempfile

            with tempfile.NamedTemporaryFile(
                mode="w",
                suffix=".prompt",
                delete=False,
                encoding="utf-8",
            ) as f:
                f.write(prompt_text)
                tmp_path = f.name

            try:
                result = run_grader(
                    self.grader_path,
                    tmp_path,
                    timeout_seconds=self.grader_timeout_seconds,
                )
            finally:
                Path(tmp_path).unlink(missing_ok=True)

            outputs.append(result)
            scores.append(result.score)
            trajectories.append(GraderTrajectory(result=result))

        return EvaluationBatch(
            outputs=outputs,
            scores=scores,
            trajectories=trajectories if capture_traces else None,
        )

    def make_reflective_dataset(
        self,
        candidate: dict[str, str],
        eval_batch: EvaluationBatch[GraderTrajectory, GraderResult],
        components_to_update: list[str],
    ) -> dict[str, list[dict[str, Any]]]:
        """Aggregate grader stderr across the batch into GEPA's reflective_dataset format."""
        # Use the trajectories (grader stderr) from the batch.
        # For each component to update, build one reflective dataset.
        result: dict[str, list[dict[str, Any]]] = {}
        traj_list = eval_batch.trajectories or []

        # Concatenate stderr from each grader call (typically just one).
        stderr_parts = [t.result.trace_stderr for t in traj_list]
        score_parts = [t.result.score for t in traj_list]
        combined_stderr = "\n".join(s for s in stderr_parts if s)
        avg_score = sum(score_parts) / len(score_parts) if score_parts else 0.0

        for component in components_to_update:
            per_component = build_reflective_dataset(
                stderr=combined_stderr,
                score=avg_score,
                component=component,
            )
            result[component] = per_component[component]

        return result
