"""ACE outer loop — in-run config optimization.

Periodically reflects on accumulated mutations and evolves the mutator
config (playbook, prompt template, knobs) during a hone run.

Usage: pass ace_interval=N to optimize_repo_frontier(). After every N
iterations the reflector analyzes the run's mutation log and proposes a
new config. The curator validates it deterministically before swapping.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from hone.bootstrap import (
    _knobs_dict,
    _read_json,
    _read_jsonl,
    apply_warmed_config,
    parse_config_output,
)
from hone.policy import MutatorPolicy


ACE_REFLECTOR_PROMPT = """\
You are the ACE Reflector for hone, a code-optimization harness.

Hone runs an LLM agent (the "mutator") to edit source code. After each
edit, a grader scores the result. You are being called MID-RUN to
optimize the mutator's instructions (playbook, prompt template, knobs).

== CURRENT RUN STATUS ==
Iteration {iteration} of {budget} ({pct}% complete)
Seed score: {seed_score}
Best score: {best_score} (lift = {lift})
Recent trajectory: {trajectory}

== CURRENT CONFIG ==

### playbook.md
{playbook}

### prompt-template.md
{prompt_template}

### knobs.json
{knobs_json}

== RECENT MUTATIONS (last {detail_window}) ==

{mutations}

== YOUR TASK ==

Analyze the mutation log. The goal is to improve the config so the
remaining iterations score higher. Look for:

1. **Stuck patterns**: Is the mutator making the same type of change
   repeatedly without improvement? The config should break the cycle.
2. **Regression patterns**: Are regressions caused by the same mistake?
   Add a specific warning to the playbook.
3. **Improvement patterns**: Are improvements coming from a specific
   type of edit? Encourage that pattern.
4. **Missing context**: Is there information the mutator needs that
   it's not getting from the template?
5. **Noise**: Is there information that's distracting from the signal?

Output EXACTLY this format with ``` fences:

```playbook.md
(new playbook content here)
```

```prompt-template.md
(new prompt template with {{variables}} here)
```

```knobs.json
{{"key": value, ...}}
```

If the config is already working well, output all three files as-is.
Available template variables: repo_name, objective, current_score,
best_score, seed_score, trace_summary, structured_traces,
recent_attempts, parent_diff_stat, base_diff_stat, constraints.
"""


def should_reflect(iteration: int, ace_interval: int) -> bool:
    return ace_interval > 0 and iteration > 0 and iteration % ace_interval == 0


def ace_reflect(
    mutator,
    run_dir: Path,
    current_policy: MutatorPolicy,
    iteration: int,
    budget: int,
    detail_window: int = 15,
) -> MutatorPolicy | None:
    """Run one ACE reflection cycle. Returns new policy or None if rejected."""
    rows = _read_jsonl(run_dir / "mutations.jsonl")
    if len(rows) < 5:
        _emit(f"[ace @{iteration}] skipping — only {len(rows)} rows")
        return None

    scores = _extract_scores(rows)
    seed_score = scores[0] if scores else 0.0
    best_score = max(scores) if scores else 0.0

    prompt = ACE_REFLECTOR_PROMPT.format(
        iteration=iteration,
        budget=budget,
        pct=round(100 * iteration / budget),
        seed_score=f"{seed_score:.4f}",
        best_score=f"{best_score:.4f}",
        lift=f"{best_score - seed_score:+.4f}",
        trajectory=_score_trajectory(scores),
        playbook=current_policy.playbook_text,
        prompt_template=current_policy.prompt_template,
        knobs_json=json.dumps(_knobs_dict(current_policy.knobs), indent=2),
        detail_window=detail_window,
        mutations=_format_mutations(rows[-detail_window:]),
    )

    t0 = time.time()
    try:
        tmp = run_dir / "ace" / f"reflect-{iteration}"
        tmp.mkdir(parents=True, exist_ok=True)
        result = mutator.propose_edit_mode(prompt, workdir=tmp)
    except Exception as exc:
        _emit(f"[ace @{iteration}] reflector call failed: {exc}")
        return None

    parsed = parse_config_output(result.new_prompt or result.raw_response)
    if not parsed:
        _emit(f"[ace @{iteration}] reflector returned no config blocks")
        return None

    new_policy = apply_warmed_config(parsed, current_policy)

    if not curate(new_policy, current_policy):
        _emit(f"[ace @{iteration}] curator rejected proposed config")
        return None

    _save_ace_cycle(run_dir, iteration, current_policy, new_policy)
    elapsed = time.time() - t0
    _emit(
        f"[ace @{iteration}] config updated "
        f"playbook={len(new_policy.playbook_text)}c "
        f"template={len(new_policy.prompt_template)}c "
        f"({elapsed:.0f}s)"
    )
    return new_policy


def curate(new_policy: MutatorPolicy, old_policy: MutatorPolicy) -> bool:
    """Deterministic validation of a proposed config change."""
    if len(new_policy.playbook_text.strip()) < 50:
        return False
    if len(new_policy.playbook_text) < len(old_policy.playbook_text) * 0.4:
        return False

    for var in ("repo_name", "objective", "current_score", "seed_score"):
        if f"{{{var}}}" not in new_policy.prompt_template:
            return False

    knobs = new_policy.knobs
    if not (0 <= knobs.recent_attempts_window <= 20):
        return False
    if not (100 <= knobs.max_trace_chars <= 50000):
        return False
    if not (50 <= knobs.max_trace_summary_chars <= 10000):
        return False

    return True


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _extract_scores(rows: list[dict]) -> list[float]:
    scores = []
    for row in rows:
        score = row.get("child_score") or row.get("score", 0.0)
        scores.append(score)
    return scores


def _score_trajectory(scores: list[float], max_points: int = 10) -> str:
    if len(scores) <= max_points:
        return " -> ".join(f"{s:.3f}" for s in scores)
    step = len(scores) / max_points
    sampled = [scores[int(i * step)] for i in range(max_points)]
    return " -> ".join(f"{s:.3f}" for s in sampled) + f" (n={len(scores)})"


def _format_mutations(rows: list[dict]) -> str:
    lines = []
    for row in rows:
        if "error" in row:
            lines.append(f"  iter={row.get('iter','?')} ERROR: {row['error'][:120]}")
        else:
            delta = row.get("delta", 0)
            changed = row.get("changed_files", [])
            summary = row.get("trace_summary", "")[:150]
            lines.append(
                f"  iter={row.get('iter','?')} "
                f"parent=c{row.get('parent_idx',0):03d} "
                f"child=c{row.get('child_idx',0):03d} "
                f"score={row.get('child_score', row.get('score', 0)):.4f} "
                f"delta={delta:+.4f} "
                f"changed={','.join(changed[:3])} "
                f"trace={summary}"
            )
    return "\n".join(lines)


def _save_ace_cycle(
    run_dir: Path,
    iteration: int,
    old_policy: MutatorPolicy,
    new_policy: MutatorPolicy,
) -> None:
    ace_dir = run_dir / "ace"
    ace_dir.mkdir(exist_ok=True)

    (ace_dir / f"cycle-{iteration}.json").write_text(json.dumps({
        "iteration": iteration,
        "old_knobs": _knobs_dict(old_policy.knobs),
        "new_knobs": _knobs_dict(new_policy.knobs),
        "old_playbook_chars": len(old_policy.playbook_text),
        "new_playbook_chars": len(new_policy.playbook_text),
        "old_template_chars": len(old_policy.prompt_template),
        "new_template_chars": len(new_policy.prompt_template),
    }, indent=2), encoding="utf-8")

    config_dir = ace_dir / f"config-{iteration}"
    config_dir.mkdir(exist_ok=True)
    (config_dir / "playbook.md").write_text(new_policy.playbook_text, encoding="utf-8")
    (config_dir / "prompt-template.md").write_text(new_policy.prompt_template, encoding="utf-8")
    (config_dir / "knobs.json").write_text(
        json.dumps(_knobs_dict(new_policy.knobs), indent=2) + "\n",
        encoding="utf-8",
    )


def _emit(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    sys.stdout.write(f"{ts} {msg}\n")
    sys.stdout.flush()
