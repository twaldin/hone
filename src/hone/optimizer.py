"""High-level optimize() wrapper — the entry point called by cli.py."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import gepa

from hone.adapter import GraderSpec, HoneAdapter
from hone.mutators.base import Mutator
from hone.proposer import HoneProposer
from hone.storage import RunManifest, RunStorage, VariantRecord, new_run_dir, utcnow


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
    run_dir: Path


def optimize(
    seed_prompt: str,
    grader_path: str | Path,
    mutator: Mutator,
    mutator_spec: str,
    prompt_path: str | Path,
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
    # Set up run directory (storage for variants + manifest)
    storage_dir = Path(run_dir) if run_dir else new_run_dir()
    storage = RunStorage(storage_dir)

    # Write seed as v0
    storage.write_variant(0, seed_prompt)

    # Initial manifest
    manifest = RunManifest(
        run_id=storage.root.name,
        created_at=utcnow(),
        prompt_path=str(prompt_path),
        grader_path=str(grader_path),
        mutator_spec=mutator_spec,
        component_name=component_name,
        budget=budget,
        seed=seed,
        variants=[VariantRecord(idx=0, score=0.0, parent_idx=None, created_at=utcnow())],
    )
    storage.save_manifest(manifest)

    adapter = HoneAdapter(
        grader_path=grader_path,
        component_name=component_name,
        grader_timeout_seconds=grader_timeout_seconds,
    )
    proposer = HoneProposer(mutator=mutator)

    seed_candidate = {component_name: seed_prompt}
    trainset: list[GraderSpec] = [GraderSpec(name="full-run")]

    try:
        gepa_result = gepa.optimize(
            seed_candidate=seed_candidate,
            trainset=trainset,
            valset=trainset,
            adapter=adapter,
            custom_candidate_proposer=proposer,
            max_metric_calls=budget,
            skip_perfect_score=True,
            display_progress_bar=display_progress_bar,
            run_dir=str(storage.root / "gepa"),
            seed=seed,
            raise_on_exception=False,
        )
    except Exception:
        manifest.status = "error"
        storage.save_manifest(manifest)
        raise

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

    # Persist all candidates that GEPA explored
    manifest.variants = []
    for i, cand in enumerate(gepa_result.candidates):
        text = cand.get(component_name, "") if isinstance(cand, dict) else str(cand)
        storage.write_variant(i, text)
        score = (
            float(gepa_result.val_aggregate_scores[i])
            if i < len(gepa_result.val_aggregate_scores)
            else 0.0
        )
        parent_idx = (
            gepa_result.parents[i][0] if i < len(gepa_result.parents) and gepa_result.parents[i] else None
        )
        manifest.variants.append(
            VariantRecord(idx=i, score=score, parent_idx=parent_idx, created_at=utcnow())
        )
    manifest.status = "done"
    manifest.best_idx = gepa_result.best_idx
    manifest.best_score = best_score
    manifest.total_iterations = proposer.stats.calls
    storage.save_manifest(manifest)

    return OptimizeResult(
        best_prompt=best_prompt,
        best_score=best_score,
        total_iterations=proposer.stats.calls,
        mutator_calls=proposer.stats.calls,
        mutator_failures=proposer.stats.failures,
        mutator_tokens_in=proposer.stats.tokens_in,
        mutator_tokens_out=proposer.stats.tokens_out,
        mutator_cost_usd=proposer.stats.cost_usd,
        run_dir=storage.root,
    )
