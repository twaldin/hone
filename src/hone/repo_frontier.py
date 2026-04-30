"""v1 git-native frontier search over repository states.

hone copies the user's source directory into a managed workspace
(`<run_dir>/workdir/`) and initializes it as a private git repo. All
iterations create branches in that workspace. The user's source
directory is never touched.

Per iteration:
  1. checkout --detach parent_sha; create hone/<run_id>/iter-N branch
  2. inject playbook file, run mutator in-place in workdir
  3. restore playbook (so it isn't committed)
  4. commit whatever the mutator left (squashes any agent-side commits)
  5. grade the working tree
  6. record child sha + diffs vs parent and seed
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from hone.ace import ace_reflect, should_reflect
from hone.gates import GateSpec, GateResult, run_gates, rejected as _gates_rejected
from hone.mutators.base import MutatorError
from hone.policy import (
    MutatorPolicy,
    PromptContext,
    SEED_POLICY,
    adapter_playbook_filename,
    build_iteration_prompt,
)
from hone.scorer import run_scorer
from hone.storage import RunManifest, RunStorage, utcnow


@dataclass
class RepoCandidate:
    idx: int
    sha: str
    branch: str
    raw_score: float
    utility: float
    trace_stderr: str
    raw_stdout: str
    parent_idx: int | None
    parent_sha: str | None
    parent_diff_stat: str
    parent_diff_patch: str
    base_diff_stat: str
    base_diff_patch: str
    changed_files_from_parent: list[str]
    gate_results: list = field(default_factory=list)


@dataclass
class AttemptRecord:
    iteration: int
    parent_idx: int
    child_idx: int | None
    parent_score: float
    child_score: float | None
    changed_files: list[str]
    trace_summary: str
    accepted: bool
    error: str | None = None


@dataclass
class RepoFrontierResult:
    best_score: float
    best_sha: str
    total_iterations: int
    mutator_calls: int
    mutator_failures: int
    mutator_tokens_in: int
    mutator_tokens_out: int
    mutator_cost_usd: float
    run_dir: Path


_WORKSPACE_IGNORE = (
    ".git", ".hone", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".venv", "venv", "node_modules",
    "*.pyc", "*.pyo",
)


def optimize_repo_frontier(
    *,
    src_dir: Path,
    grader_path: Path,
    mutator,
    mutator_spec: str,
    budget: int,
    grader_timeout_seconds: int,
    run_dir: Path,
    frontier_size: int = 4,
    objective: str = "Improve the repository so the grader score increases.",
    policy: MutatorPolicy = SEED_POLICY,
    ace_interval: int = 0,
    ace_mutator=None,
    resume: bool = False,
    metric_direction: str = "max",
    stall: int | None = None,
    gates: list[GateSpec] | None = None,
    scorer_path: Path | None = None,
) -> RepoFrontierResult:
    src_dir = Path(src_dir).resolve()
    effective_scorer = Path(scorer_path).resolve() if scorer_path is not None else Path(grader_path).resolve()
    storage = RunStorage(run_dir)
    prompts_dir = storage.root / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)

    playbook_name = adapter_playbook_filename(mutator_spec)
    workdir = storage.root / "workdir"
    run_id = storage.root.name
    branch_prefix = f"hone/{run_id}"

    if resume:
        if not (storage.root / "mutations.jsonl").exists():
            raise FileNotFoundError(f"resume requires mutations.jsonl in {storage.root}")
        if not workdir.exists():
            raise FileNotFoundError(f"resume requires workdir in {storage.root}")
        _emit(f"RESUMING from {storage.root}")
        manifest = storage.load_manifest()
        _git(["reset", "--hard", "HEAD"], cwd=workdir)
        _git(["clean", "-fd"], cwd=workdir)
        seed_candidate, all_candidates, frontier, best, attempts_resumed, start_iter = _load_resume_state(
            storage=storage, workdir=workdir, branch_prefix=branch_prefix,
            metric_direction=metric_direction,
        )
        seed_sha = seed_candidate.sha
        completed_iterations = start_iter - 1
        _emit(
            f"resumed: {len(all_candidates)} candidates, best=c{best.idx:03d}({best.raw_score:.3f}), "
            f"frontier=[{','.join(str(c.idx) for c in frontier)}], resuming at iter {start_iter}/{budget}"
        )
    else:
        (storage.root / "seed-playbook.md").write_text(policy.rendered_playbook(), encoding="utf-8")
        (storage.root / "seed-prompt-template.md").write_text(policy.prompt_template, encoding="utf-8")
        _init_managed_workspace(src=src_dir, dest=workdir)
        seed_sha = _git(["rev-parse", "HEAD"], cwd=workdir).strip()

        _emit(f"managed workspace: {workdir}")
        _emit(f"source: {src_dir}")

        manifest = RunManifest(
            run_id=run_id,
            created_at=utcnow(),
            src_dir=str(src_dir),
            grader_path=str(effective_scorer),
            mutator_spec=mutator_spec,
            budget=budget,
            metric_direction=metric_direction,
            stall=stall,
        )
        storage.save_manifest(manifest)

        seed_grade = run_scorer(effective_scorer, workdir, timeout_seconds=grader_timeout_seconds, metric_direction=metric_direction)
        seed_candidate = RepoCandidate(
            idx=0, sha=seed_sha, branch="main",
            raw_score=seed_grade.raw_score,
            utility=seed_grade.utility,
            trace_stderr=seed_grade.trace_stderr, raw_stdout=seed_grade.raw_stdout,
            parent_idx=None, parent_sha=None,
            parent_diff_stat="(seed)", parent_diff_patch="",
            base_diff_stat="(seed)", base_diff_patch="",
            changed_files_from_parent=[],
        )
        _write_trace(storage, 0, seed_grade.trace_stderr, seed_grade.raw_stdout)
        all_candidates = [seed_candidate]
        frontier = [seed_candidate]
        best = seed_candidate
        attempts_resumed = []
        start_iter = 1
        completed_iterations = 0

    attempts: list[AttemptRecord] = list(attempts_resumed)
    active_policy = policy

    mutator_calls = 0
    mutator_failures = 0
    tokens_in = 0
    tokens_out = 0
    cost_usd = 0.0
    iters_without_best_improvement = 0
    stall_triggered = False

    if not resume:
        _append_jsonl(storage.root / "mutations.jsonl", {
            "iter": 0, "candidate_idx": 0, "sha": seed_sha,
            "score": seed_candidate.raw_score, "utility": seed_candidate.utility,
            "kind": "seed", "frontier": [0],
        })
        _emit(
            f"[iter 0/{budget}] SEED sha={seed_sha[:8]} "
            f"score={seed_candidate.raw_score:.4f} best={seed_candidate.raw_score:.4f}"
        )

    for iteration in range(start_iter, budget + 1):
        completed_iterations += 1
        iter_started = time.time()
        parent = _select_parent(frontier, iteration, frontier_size)

        prompt_ctx = PromptContext(
            repo_name=workdir.name,
            objective=objective,
            current_score=parent.raw_score,
            best_score=best.raw_score,
            seed_score=seed_candidate.raw_score,
            trace_summary=_summarize_trace(parent.trace_stderr, active_policy.knobs.max_trace_summary_chars),
            structured_traces=parent.trace_stderr.strip() or "(none)",
            recent_attempts=_format_recent_attempts(attempts, active_policy.knobs.recent_attempts_window),
            parent_diff_stat=parent.parent_diff_stat,
            base_diff_stat=parent.base_diff_stat,
            constraints=_workspace_file_list(workdir),
        )
        prompt = build_iteration_prompt(active_policy, prompt_ctx)
        (prompts_dir / f"iter-{iteration:03d}.txt").write_text(prompt, encoding="utf-8")

        child_branch = f"{branch_prefix}/iter-{iteration:03d}"
        _checkout_clean(workdir, parent.sha, new_branch=child_branch)

        playbook_path = workdir / playbook_name
        original_playbook = playbook_path.read_text(encoding="utf-8") if playbook_path.exists() else None
        playbook_path.write_text(_compose_playbook(original_playbook, active_policy.rendered_playbook()), encoding="utf-8")

        try:
            if not hasattr(mutator, "propose_edit_mode"):
                raise MutatorError(
                    "dir mode requires a mutator with propose_edit_mode(workdir=...) support"
                )
            result = mutator.propose_edit_mode(prompt, workdir=workdir)
            mutator_calls += 1
            if result.tokens_in:
                tokens_in += result.tokens_in
            if result.tokens_out:
                tokens_out += result.tokens_out
            if result.cost_usd:
                cost_usd += result.cost_usd
        except Exception as exc:
            mutator_failures += 1
            _restore_playbook(playbook_path, original_playbook)
            _reset_to(workdir, parent.sha)
            _delete_branch(workdir, child_branch)
            iters_without_best_improvement += 1
            attempts.append(AttemptRecord(
                iteration=iteration, parent_idx=parent.idx, child_idx=None,
                parent_score=parent.raw_score, child_score=None, changed_files=[],
                trace_summary="", accepted=False, error=str(exc),
            ))
            _append_jsonl(storage.root / "mutations.jsonl", {
                "iter": iteration, "parent_idx": parent.idx,
                "kind": "mutator_error",
                "error": str(exc), "frontier": [c.idx for c in frontier],
            })
            _emit(
                f"[iter {iteration}/{budget}] ERROR parent=c{parent.idx:03d} "
                f"({time.time()-iter_started:.0f}s): {exc}"
            )
            manifest.completed_iterations = completed_iterations
            manifest.total_iterations = completed_iterations
            storage.save_manifest(manifest)
            if stall is not None and iters_without_best_improvement >= stall:
                stall_triggered = True
                break
            continue

        _strip_seed_playbook_section(playbook_path)

        _git(["add", "-A"], cwd=workdir)
        if _has_changes_vs_parent(workdir, parent.sha):
            _git(["commit", "-m", f"hone iter {iteration}", "--no-verify"], cwd=workdir)
        child_sha = _git(["rev-parse", "HEAD"], cwd=workdir).strip()

        child_grade = run_scorer(effective_scorer, workdir, timeout_seconds=grader_timeout_seconds, metric_direction=metric_direction)
        _write_trace(storage, iteration, child_grade.trace_stderr, child_grade.raw_stdout)

        parent_diff_stat = _git(["diff", "--stat", parent.sha, child_sha], cwd=workdir).strip() or "(no changes)"
        parent_diff_patch = _git(["diff", parent.sha, child_sha], cwd=workdir)[:4000]
        base_diff_stat = _git(["diff", "--stat", seed_sha, child_sha], cwd=workdir).strip() or "(no changes)"
        base_diff_patch = _git(["diff", seed_sha, child_sha], cwd=workdir)[:4000]
        changed_from_parent = [
            ln for ln in _git(["diff", "--name-only", parent.sha, child_sha], cwd=workdir).splitlines()
            if ln.strip()
        ]

        child_idx = len(all_candidates)

        # Gate evaluation — before updating frontier/best
        gate_results_list: list[GateResult] = []
        if gates:
            gate_results_list = run_gates(gates, workdir)
            if _gates_rejected(gate_results_list):
                iters_without_best_improvement += 1
                failing = [r.name for r in gate_results_list if not r.passed]
                _append_jsonl(storage.root / "mutations.jsonl", {
                    "iter": iteration, "parent_idx": parent.idx, "child_idx": child_idx,
                    "kind": "gate_rejected",
                    "child_sha": child_sha,
                    "parent_score": parent.raw_score, "child_score": child_grade.raw_score,
                    "utility": child_grade.utility,
                    "delta": child_grade.raw_score - parent.raw_score,
                    "changed_files": changed_from_parent,
                    "trace_summary": _summarize_trace(child_grade.trace_stderr, 400),
                    "failing_gates": failing,
                    "gate_results": [_gate_result_dict(r) for r in gate_results_list],
                    "frontier": [c.idx for c in frontier],
                })
                _emit(
                    f"[iter {iteration}/{budget}] GATE_REJECTED parent=c{parent.idx:03d} "
                    f"gates={failing} ({time.time()-iter_started:.0f}s)"
                )
                manifest.completed_iterations = completed_iterations
                manifest.total_iterations = completed_iterations
                storage.save_manifest(manifest)
                if stall is not None and iters_without_best_improvement >= stall:
                    stall_triggered = True
                    break
                continue

        child = RepoCandidate(
            idx=child_idx, sha=child_sha, branch=child_branch,
            raw_score=child_grade.raw_score,
            utility=child_grade.utility,
            trace_stderr=child_grade.trace_stderr, raw_stdout=child_grade.raw_stdout,
            parent_idx=parent.idx, parent_sha=parent.sha,
            parent_diff_stat=parent_diff_stat, parent_diff_patch=parent_diff_patch,
            base_diff_stat=base_diff_stat, base_diff_patch=base_diff_patch,
            changed_files_from_parent=changed_from_parent,
            gate_results=gate_results_list,
        )
        all_candidates.append(child)
        attempts.append(AttemptRecord(
            iteration=iteration, parent_idx=parent.idx, child_idx=child.idx,
            parent_score=parent.raw_score, child_score=child.raw_score,
            changed_files=changed_from_parent,
            trace_summary=_summarize_trace(child.trace_stderr, policy.knobs.max_trace_summary_chars),
            accepted=True,
        ))

        if child.utility > best.utility:
            best = child
            iters_without_best_improvement = 0
        else:
            iters_without_best_improvement += 1

        frontier = _update_frontier(frontier, child, frontier_size)
        _append_jsonl(storage.root / "mutations.jsonl", {
            "iter": iteration, "parent_idx": parent.idx, "child_idx": child.idx,
            "parent_sha": parent.sha, "child_sha": child_sha,
            "parent_score": parent.raw_score, "child_score": child.raw_score,
            "utility": child.utility,
            "delta": child.raw_score - parent.raw_score,
            "changed_files": changed_from_parent,
            "trace_summary": _summarize_trace(child.trace_stderr, 400),
            "gate_results": [_gate_result_dict(r) for r in gate_results_list],
            "frontier": [c.idx for c in frontier],
        })
        delta = child.raw_score - parent.raw_score
        kept = "kept" if child in frontier else "dropped"
        changed_str = ",".join(changed_from_parent[:3]) or "none"
        if len(changed_from_parent) > 3:
            changed_str += f"+{len(changed_from_parent)-3}"
        _emit(
            f"[iter {iteration}/{budget}] "
            f"c{parent.idx:03d}({parent.raw_score:.3f}) -> c{child.idx:03d}({child.raw_score:.3f}) "
            f"delta={delta:+.3f} best={best.raw_score:.3f} {kept} "
            f"changed={changed_str} ({time.time()-iter_started:.0f}s)"
        )

        manifest.completed_iterations = completed_iterations
        manifest.total_iterations = completed_iterations
        storage.save_manifest(manifest)

        if stall is not None and iters_without_best_improvement >= stall:
            stall_triggered = True
            break

        # ACE: reflect and update config
        if should_reflect(iteration, ace_interval):
            reflector = ace_mutator if ace_mutator is not None else mutator
            new_policy = ace_reflect(
                mutator=reflector,
                run_dir=storage.root,
                current_policy=active_policy,
                iteration=iteration,
                budget=budget,
            )
            if new_policy is not None:
                active_policy = new_policy

    _checkout_clean(workdir, best.sha, new_branch=None)
    best_tag = f"{branch_prefix}/best"
    try:
        _git(["tag", "-f", best_tag, best.sha], cwd=workdir)
    except subprocess.CalledProcessError:
        pass

    manifest.status = "stalled" if stall_triggered else "done"
    manifest.best_idx = best.idx
    manifest.best_score = best.raw_score
    manifest.best_sha = best.sha
    manifest.total_iterations = completed_iterations
    manifest.completed_iterations = completed_iterations
    storage.save_manifest(manifest)

    return RepoFrontierResult(
        best_score=best.raw_score,
        best_sha=best.sha,
        total_iterations=completed_iterations,
        mutator_calls=mutator_calls,
        mutator_failures=mutator_failures,
        mutator_tokens_in=tokens_in,
        mutator_tokens_out=tokens_out,
        mutator_cost_usd=cost_usd,
        run_dir=storage.root,
    )


# ---------------------------------------------------------------------------
# managed workspace
# ---------------------------------------------------------------------------

def _init_managed_workspace(*, src: Path, dest: Path) -> None:
    if dest.exists():
        raise RuntimeError(f"managed workspace already exists: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns(*_WORKSPACE_IGNORE))
    _git(["init", "-q", "-b", "main"], cwd=dest)
    gitignore = dest / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text(
            "__pycache__/\n*.pyc\n*.pyo\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n",
            encoding="utf-8",
        )
    _git(["add", "-A"], cwd=dest)
    _git(["commit", "-q", "-m", "hone: seed", "--no-verify"], cwd=dest)


def _workspace_file_list(workdir: Path) -> str:
    try:
        files = [
            f for f in _git(["ls-tree", "-r", "--name-only", "HEAD"], cwd=workdir).splitlines()
            if f.strip() and not f.startswith(".")
        ]
    except subprocess.CalledProcessError:
        return "(unable to list files)"
    preview = files[:30]
    more = "" if len(files) <= 30 else f" ... (+{len(files)-30} more)"
    return f"workspace={workdir.name}; tracked files: {', '.join(preview)}{more}"


# ---------------------------------------------------------------------------
# git helpers
# ---------------------------------------------------------------------------

def _git(args: list[str], *, cwd: Path) -> str:
    res = subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True
    )
    return res.stdout


def _checkout_clean(target: Path, sha: str, *, new_branch: str | None) -> None:
    _git(["reset", "--hard", "HEAD"], cwd=target)
    _git(["clean", "-fd"], cwd=target)
    _git(["checkout", "--detach", sha], cwd=target)
    if new_branch is not None:
        _git(["checkout", "-b", new_branch], cwd=target)


def _reset_to(target: Path, sha: str) -> None:
    _git(["reset", "--hard", sha], cwd=target)
    _git(["clean", "-fd"], cwd=target)


def _delete_branch(target: Path, branch: str) -> None:
    current = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=target).strip()
    if current == branch:
        _git(["checkout", "--detach", "HEAD"], cwd=target)
    try:
        _git(["branch", "-D", branch], cwd=target)
    except subprocess.CalledProcessError:
        pass


def _has_changes_vs_parent(target: Path, parent_sha: str) -> bool:
    head = _git(["rev-parse", "HEAD"], cwd=target).strip()
    if head != parent_sha:
        return True
    status = _git(["status", "--porcelain"], cwd=target).strip()
    return bool(status)


# ---------------------------------------------------------------------------
# formatting + frontier helpers
# ---------------------------------------------------------------------------

def _format_recent_attempts(attempts: list[AttemptRecord], window: int) -> str:
    if not attempts:
        return "(none)"
    lines: list[str] = []
    for attempt in attempts[-window:]:
        if attempt.child_idx is None:
            lines.append(
                f"iter {attempt.iteration}: parent c{attempt.parent_idx:03d} "
                f"mutator_error={attempt.error}"
            )
            continue
        delta = (attempt.child_score or 0.0) - attempt.parent_score
        changed = ", ".join(attempt.changed_files[:5]) or "(no file changes detected)"
        lines.append(
            f"c{attempt.parent_idx:03d} -> c{attempt.child_idx:03d}: "
            f"delta={delta:+.4f}; changed={changed}; "
            f"trace={attempt.trace_summary or '(none)'}"
        )
    return "\n".join(lines)


def _update_frontier(
    frontier: list[RepoCandidate], child: RepoCandidate, frontier_size: int
) -> list[RepoCandidate]:
    merged = frontier + [child]
    unique: dict[str, RepoCandidate] = {}
    for candidate in sorted(merged, key=lambda c: (c.utility, -c.idx), reverse=True):
        unique.setdefault(candidate.sha, candidate)
    kept = sorted(unique.values(), key=lambda c: (c.utility, -c.idx), reverse=True)
    return kept[:frontier_size]


def _select_parent(
    frontier: list[RepoCandidate], iteration: int, frontier_size: int
) -> RepoCandidate:
    """Pick a mutation parent from the ranked frontier without tail lock-in.

    The frontier itself is worth keeping: lower-scoring states can contain useful
    partial repairs or alternate structure. But the old `iteration % len(frontier)`
    policy interacted badly with a growing, score-sorted frontier during warm-up:
    a catastrophic tail candidate could be selected repeatedly until the frontier
    filled, causing many mutations to merely revert it back to an already-known
    working state.

    Rank on every selection, always revisit the current best regularly, and only
    round-robin across a bounded top window. This preserves exploration while
    preventing repeated selection of the same bad tail candidate.
    """
    if not frontier:
        raise ValueError("frontier must not be empty")
    ranked = sorted(frontier, key=lambda c: (c.utility, -c.idx), reverse=True)
    if iteration == 1 or iteration % 3 == 1:
        return ranked[0]
    window = min(len(ranked), max(1, frontier_size // 2))
    return ranked[(iteration - 1) % window]


def _summarize_trace(trace: str, limit: int) -> str:
    stripped = trace.strip()
    if not stripped:
        return "(none)"
    lines = [line.strip() for line in stripped.splitlines() if line.strip()]
    summary = " | ".join(lines[:5])
    if len(summary) <= limit:
        return summary
    return summary[: max(0, limit - 13)] + "...[truncated]"


def _strip_seed_playbook_section(path: Path) -> None:
    """Strip the appended seed-playbook section so mutations survive git commit.

    When the playbook filename equals the artifact being mutated (e.g. AGENTS.md
    for opencode targets), _restore_playbook would clobber the mutation before
    git add. Instead, strip just the marker+trailing section so the committed
    file contains the mutator's edit without the playbook boilerplate.
    """
    if not path.exists():
        return
    content = path.read_text(encoding="utf-8")
    marker = "\n\n<!-- hone:v1 seed playbook -->"
    if marker in content:
        path.write_text(content.split(marker)[0].rstrip(), encoding="utf-8")


def _restore_playbook(path: Path, original: str | None) -> None:
    if original is None:
        path.unlink(missing_ok=True)
        return
    path.write_text(original, encoding="utf-8")


def _compose_playbook(original: str | None, seed_playbook: str) -> str:
    if not original or not original.strip():
        return seed_playbook
    return original.rstrip() + "\n\n<!-- hone:v1 seed playbook -->\n\n" + seed_playbook


def _append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def _emit(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    sys.stdout.write(f"{ts} {msg}\n")
    sys.stdout.flush()


def _gate_result_dict(r: GateResult) -> dict:
    return {
        "name": r.name,
        "passed": r.passed,
        "returncode": r.returncode,
        "stdout": r.stdout[:200],
        "stderr": r.stderr[:200],
        "duration_s": r.duration_s,
    }


def _load_resume_state(
    *, storage: RunStorage, workdir: Path, branch_prefix: str,
    metric_direction: str = "max",
):
    """Reconstruct candidates + frontier + best + attempts + start_iter from mutations.jsonl + git.

    Trace fields lost in resume (trace_stderr, raw_stdout) — we have only the short
    trace_summary persisted per-iteration. That's enough for recent_attempts formatting
    but means the resumed iter's PromptContext sees empty structured_traces for prior
    iterations. Acceptable tradeoff for emergency recovery.
    """
    jsonl_path = storage.root / "mutations.jsonl"
    all_candidates: list[RepoCandidate] = []
    attempts: list[AttemptRecord] = []
    last_frontier_indices: list[int] = [0]
    last_iter = 0
    seed_sha: str | None = None

    with jsonl_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)

            if rec.get("kind") == "seed":
                seed_sha = rec["sha"]
                seed_trace, seed_stdout = _read_trace(storage, 0)
                raw = rec["score"]
                seed = RepoCandidate(
                    idx=0, sha=seed_sha, branch="main",
                    raw_score=raw,
                    utility=raw if metric_direction == "max" else -raw,
                    trace_stderr=seed_trace, raw_stdout=seed_stdout,
                    parent_idx=None, parent_sha=None,
                    parent_diff_stat="(seed)", parent_diff_patch="",
                    base_diff_stat="(seed)", base_diff_patch="",
                    changed_files_from_parent=[],
                )
                all_candidates.append(seed)
                last_frontier_indices = rec.get("frontier", [0])
                continue

            it = rec.get("iter", 0)
            last_iter = max(last_iter, it)

            if rec.get("kind") == "gate_rejected":
                attempts.append(AttemptRecord(
                    iteration=it,
                    parent_idx=rec.get("parent_idx", -1),
                    child_idx=None,
                    parent_score=rec.get("parent_score", 0.0),
                    child_score=rec.get("child_score"),
                    changed_files=rec.get("changed_files", []),
                    trace_summary=rec.get("trace_summary", "")[:1200],
                    accepted=False,
                ))
                last_frontier_indices = rec.get("frontier", last_frontier_indices)
                continue

            if "child_idx" in rec and "child_sha" in rec:
                parent_sha = rec["parent_sha"]
                child_sha = rec["child_sha"]
                try:
                    parent_diff_stat = _git(["diff", "--stat", parent_sha, child_sha], cwd=workdir).strip() or "(no changes)"
                    parent_diff_patch = _git(["diff", parent_sha, child_sha], cwd=workdir)[:4000]
                    base_diff_stat = _git(["diff", "--stat", seed_sha, child_sha], cwd=workdir).strip() or "(no changes)" if seed_sha else "(resume)"
                    base_diff_patch = _git(["diff", seed_sha, child_sha], cwd=workdir)[:4000] if seed_sha else ""
                except Exception:
                    parent_diff_stat = "(resume)"
                    parent_diff_patch = ""
                    base_diff_stat = "(resume)"
                    base_diff_patch = ""
                child_trace, child_stdout = _read_trace(storage, it)
                raw = rec["child_score"]
                utility = rec.get("utility", raw if metric_direction == "max" else -raw)
                child = RepoCandidate(
                    idx=rec["child_idx"],
                    sha=child_sha,
                    branch=f"{branch_prefix}/iter-{it:03d}",
                    raw_score=raw,
                    utility=utility,
                    trace_stderr=child_trace, raw_stdout=child_stdout,
                    parent_idx=rec["parent_idx"],
                    parent_sha=parent_sha,
                    parent_diff_stat=parent_diff_stat,
                    parent_diff_patch=parent_diff_patch,
                    base_diff_stat=base_diff_stat,
                    base_diff_patch=base_diff_patch,
                    changed_files_from_parent=rec.get("changed_files", []),
                )
                all_candidates.append(child)
                attempts.append(AttemptRecord(
                    iteration=it,
                    parent_idx=rec["parent_idx"],
                    child_idx=child.idx,
                    parent_score=rec["parent_score"],
                    child_score=child.raw_score,
                    changed_files=rec.get("changed_files", []),
                    trace_summary=rec.get("trace_summary", "")[:1200],
                    accepted=True,
                ))
                last_frontier_indices = rec.get("frontier", last_frontier_indices)
            elif "error" in rec:
                attempts.append(AttemptRecord(
                    iteration=it,
                    parent_idx=rec.get("parent_idx", -1),
                    child_idx=None,
                    parent_score=0.0,
                    child_score=None,
                    changed_files=[],
                    trace_summary="",
                    accepted=False,
                    error=rec["error"],
                ))
                last_frontier_indices = rec.get("frontier", last_frontier_indices)

    if not all_candidates:
        raise ValueError(f"mutations.jsonl at {jsonl_path} has no seed entry")

    idx_to_cand = {c.idx: c for c in all_candidates}
    frontier = [idx_to_cand[i] for i in last_frontier_indices if i in idx_to_cand]
    if not frontier:
        frontier = [all_candidates[0]]
    best = max(all_candidates, key=lambda c: c.utility)
    start_iter = last_iter + 1
    return all_candidates[0], all_candidates, frontier, best, attempts, start_iter


def _write_trace(storage: RunStorage, iteration: int, trace_stderr: str, raw_stdout: str) -> None:
    """Persist full scorer trace + stdout for an iteration (enables resume without trace loss)."""
    traces_dir = storage.root / "traces"
    traces_dir.mkdir(parents=True, exist_ok=True)
    path = traces_dir / f"iter-{iteration:03d}.json"
    try:
        path.write_text(
            json.dumps({"trace_stderr": trace_stderr or "", "raw_stdout": raw_stdout or ""}),
            encoding="utf-8",
        )
    except Exception:
        pass


def _read_trace(storage: RunStorage, iteration: int) -> tuple[str, str]:
    """Load persisted trace for an iteration. Returns ('', '') if not present."""
    path = storage.root / "traces" / f"iter-{iteration:03d}.json"
    if not path.exists():
        return "", ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("trace_stderr", "") or "", data.get("raw_stdout", "") or ""
    except Exception:
        return "", ""
