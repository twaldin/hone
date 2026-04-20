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
    best_snapshot: "DirSnapshot | None" = None


def optimize(
    seed_prompt: str,
    grader_path: str | Path,
    mutator: Mutator,
    mutator_spec: str,
    prompt_path: str | Path,
    budget: int = 20,
    component_name: str = "instruction",
    component_kind: str = "prompt",
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
    proposer = HoneProposer(mutator=mutator, kind=component_kind)

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


# ===========================================================================
# v2 DIR MODE — runs our own loop (no GEPA) since candidate is a dir snapshot.
# ===========================================================================

def optimize_dir(
    dir_target,          # DirTarget
    grader_path,
    mutator: Mutator,
    mutator_spec: str,
    scheduler,           # Scheduler
    observer,            # Observer | None
    budget: int = 100,
    grader_timeout_seconds: int = 3600,
    run_dir=None,
    seed: int = 0,
    display_progress_bar: bool = True,
) -> "OptimizeResult":
    import json
    import shutil
    import sys
    import tempfile
    from pathlib import Path as _P

    from hone.dir_target import DirSnapshot
    from hone.grader import run_grader
    from hone.proposer import HoneProposer
    from hone.scheduler import HistoryRow

    storage_dir = _P(run_dir) if run_dir else new_run_dir()
    storage = RunStorage(storage_dir)

    mutations_path = storage.root / "mutations.jsonl"
    claude_md_path = storage.root / "CLAUDE.md"
    # Seed CLAUDE.md: start from the project's CLAUDE.md if one lives next to the dir
    project_claude = dir_target.root.parent / "CLAUDE.md"
    if project_claude.exists():
        claude_md_path.write_text(project_claude.read_text(encoding="utf-8"), encoding="utf-8")
    else:
        claude_md_path.write_text("# hone ACE-managed CLAUDE.md\n", encoding="utf-8")

    snapshot = dir_target.initial_snapshot()
    candidates_dir = dir_target.mutable_files()
    history: list[HistoryRow] = []
    best_score = -1.0
    best_snapshot = snapshot
    recent_scores: list[float] = []

    proposer = HoneProposer(mutator=mutator, kind="dir")

    manifest = RunManifest(
        run_id=storage.root.name,
        created_at=utcnow(),
        prompt_path=str(dir_target.root),
        grader_path=str(grader_path),
        mutator_spec=mutator_spec,
        component_name="dir",
        budget=budget,
        seed=seed,
        variants=[],
    )
    manifest.mode = "dir"
    manifest.dir_root = str(dir_target.root)
    storage.save_manifest(manifest)

    for it in range(1, budget + 1):
        target = scheduler.pick_next_target(candidates_dir, history)
        print(f"[hone iter {it}/{budget}] target={target} best={best_score:.4f}", flush=True)

        try:
            new_text = proposer.propose_for_file(
                target_rel=target,
                snapshot=snapshot,
                grader_stderr_tail=_stderr_tail(history),
                claude_md_path=claude_md_path,
            )
        except Exception as e:
            print(f"[hone iter {it}] MUTATOR ERROR: {e}", flush=True)
            _log_mutation_row_skeleton(mutations_path, it, target, None,
                                       (history[-1].iter if history else None),
                                       f"mutator_error:{str(e)[:200]}")
            continue

        child = snapshot.with_file(target, new_text)

        grader_dir = _materialize_tmp(child, dir_target.root)
        try:
            gres = run_grader(grader_path, grader_dir, timeout_seconds=grader_timeout_seconds)
        finally:
            shutil.rmtree(grader_dir.parent, ignore_errors=True)

        rollouts = _parse_rollout_jsonlines(gres.raw_stdout)
        row = HistoryRow(
            iter=it,
            target=target,
            parent_iter=(history[-1].iter if history else None),
            score=gres.score,
            fail_class=_infer_fail_class(rollouts),
            grader_stdout_rollouts=rollouts,
            diff_summary=_unified_diff_summary(snapshot.files[target], new_text),
        )
        history.append(row)
        recent_scores.append(gres.score)
        _log_mutation_row_full(mutations_path, row)

        print(f"[hone iter {it}] target={target} score={gres.score:.4f} fail_class={row.fail_class}", flush=True)

        if gres.score > best_score:
            best_score = gres.score
            best_snapshot = child
            snapshot = child

        if observer and observer.should_fire(it):
            try:
                obs_result = observer.fire(storage.root, claude_md_path, recent_scores)
                applied = obs_result.get("applied")
                n_deltas = len(obs_result.get("deltas") or [])
                print(f"[hone observer@{it}] applied={applied} deltas={n_deltas} "
                      f"version={obs_result.get('version')}", flush=True)
            except Exception as e:
                print(f"[hone observer@{it}] ERROR: {e}", flush=True)

    manifest.status = "done"
    manifest.best_score = best_score
    manifest.total_iterations = len(history)
    storage.save_manifest(manifest)

    return OptimizeResult(
        best_prompt="",
        best_score=best_score,
        total_iterations=len(history),
        mutator_calls=proposer.stats.calls,
        mutator_failures=proposer.stats.failures,
        mutator_tokens_in=proposer.stats.tokens_in,
        mutator_tokens_out=proposer.stats.tokens_out,
        mutator_cost_usd=proposer.stats.cost_usd,
        run_dir=storage.root,
        best_snapshot=best_snapshot,
    )


def _materialize_tmp(snapshot, reference_root):
    """Copy reference_root's PARENT to a tmpdir, overlay snapshot, return the target dir path."""
    import shutil
    import tempfile
    from pathlib import Path as _P

    parent = reference_root.parent
    tmp = _P(tempfile.mkdtemp(prefix="hone-dir-grade-"))
    for item in parent.iterdir():
        # Skip venv / run data to keep copy small and fast
        if item.name in {".venv", ".git", ".hone", "runs", "runs-aborted-run1", "__pycache__"}:
            continue
        dest = tmp / item.name
        if item.is_dir():
            shutil.copytree(item, dest, dirs_exist_ok=True, symlinks=True,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy2(item, dest)
    dir_in_tmp = tmp / reference_root.name
    dir_in_tmp.mkdir(parents=True, exist_ok=True)
    snapshot.materialize(dir_in_tmp)
    return dir_in_tmp


def _parse_rollout_jsonlines(stdout: str) -> list[dict]:
    import json as _json
    rows: list[dict] = []
    lines = stdout.splitlines()
    for line in lines[:-1]:
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            rows.append(_json.loads(s))
        except _json.JSONDecodeError:
            continue
    return rows


def _infer_fail_class(rollouts: list[dict]) -> str | None:
    if not rollouts:
        return None
    reasons = [r.get("crash_reason") for r in rollouts if r.get("crashed")]
    if not reasons:
        return None
    from collections import Counter
    return Counter(reasons).most_common(1)[0][0]


def _log_mutation_row_full(path, row) -> None:
    import json as _json
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(_json.dumps({
            "iter": row.iter,
            "target": str(row.target),
            "parent_iter": row.parent_iter,
            "score": row.score,
            "fail_class": row.fail_class,
            "diff_summary": row.diff_summary,
            "rollouts": row.grader_stdout_rollouts,
        }) + "\n")


def _log_mutation_row_skeleton(path, it, target, score, parent_iter, fail_class) -> None:
    import json as _json
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(_json.dumps({
            "iter": it,
            "target": str(target),
            "parent_iter": parent_iter,
            "score": score if score is not None else 0.0,
            "fail_class": fail_class,
            "diff_summary": "",
            "rollouts": [],
        }) + "\n")


def _stderr_tail(history) -> str:
    import json as _json
    if not history:
        return "(no history)"
    return _json.dumps(history[-1].grader_stdout_rollouts[:5], indent=2)[:4000]


def _unified_diff_summary(old: str, new: str) -> str:
    import difflib
    diff = list(difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=1))
    return "\n".join(diff[:40])[:2000]
