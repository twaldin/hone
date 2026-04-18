"""High-level optimize() wrapper — the entry point called by cli.py."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import gepa

from hone.adapter import GraderSpec, HoneAdapter
from hone.mutators.base import Mutator
from hone.proposer import HoneProposer


@dataclass
class OptimizeResult:
    """Summary of an optimize run. Full details are in .hone/run-<id>/."""

    best_prompt: str
    best_score: float
    total_iterations: int
    mutator_calls: int
    mutator_failures: int
    mutator_tokens_in: int
    mutator_tokens_out: int
    mutator_cost_usd: float


def optimize(
    seed_prompt: str,
    grader_path: str | Path,
    mutator: Mutator,
    budget: int = 20,
    component_name: str = "instruction",
    grader_timeout_seconds: int = 3600,
    run_dir: str | Path | None = None,
    seed: int = 0,
    display_progress_bar: bool = True,
) -> OptimizeResult:
    """Run one optimization pass.

    Parameters
    ----------
    seed_prompt : initial prompt text (the content of prompt.md).
    grader_path : path to the grader script.
    mutator : configured Mutator instance (e.g. ClaudeCodeMutator).
    budget : max iterations (forwarded to GEPA's max_metric_calls).
    component_name : name of the component being optimized. Defaults to 'instruction'.
    grader_timeout_seconds : per-grader-call timeout.
    run_dir : where GEPA writes its internal logs (None = tempdir).
    seed : RNG seed for GEPA.
    display_progress_bar : show GEPA's built-in progress bar.
    """
    adapter = HoneAdapter(
        grader_path=grader_path,
        component_name=component_name,
        grader_timeout_seconds=grader_timeout_seconds,
    )
    proposer = HoneProposer(mutator=mutator)

    seed_candidate = {component_name: seed_prompt}
    trainset: list[GraderSpec] = [GraderSpec(name="full-run")]

    gepa_result = gepa.optimize(
        seed_candidate=seed_candidate,
        trainset=trainset,
        valset=trainset,
        adapter=adapter,
        custom_candidate_proposer=proposer,
        max_metric_calls=budget,
        skip_perfect_score=True,
        display_progress_bar=display_progress_bar,
        run_dir=str(run_dir) if run_dir else None,
        seed=seed,
        raise_on_exception=False,
    )

    best_candidate = gepa_result.best_candidate
    if isinstance(best_candidate, dict):
        best_prompt = best_candidate.get(component_name, seed_prompt)
    elif isinstance(best_candidate, str):
        best_prompt = best_candidate
    else:
        best_prompt = seed_prompt

    try:
        best_score = float(gepa_result.val_aggregate_scores[gepa_result.best_idx])
    except (IndexError, TypeError, ValueError):
        best_score = 0.0

    return OptimizeResult(
        best_prompt=best_prompt,
        best_score=best_score,
        total_iterations=proposer.stats.calls,
        mutator_calls=proposer.stats.calls,
        mutator_failures=proposer.stats.failures,
        mutator_tokens_in=proposer.stats.tokens_in,
        mutator_tokens_out=proposer.stats.tokens_out,
        mutator_cost_usd=proposer.stats.cost_usd,
    )
