"""ACE bootstrap — reflect on existing run data to produce a warmed-start config.

Reads mutations.jsonl + prompts from past hone runs, feeds them to a Reflector
LLM call, and produces an improved playbook.md + prompt-template.md + knobs.json
without spending any inner-loop compute.

Usage:
    hone reflect \
      --runs <dir1> <dir2> ... \
      --model harness:claude-code:sonnet \
      --output ./warmed-config/
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from hone.mutators import resolve as resolve_mutator
from hone.policy import MutatorPolicy, PromptKnobs, SEED_POLICY


REFLECTOR_PROMPT = """\
You are the ACE Reflector for a code-optimization harness called hone.

Hone runs an LLM agent (the "mutator") to edit source code. After each edit, a
grader scores the result. The mutator receives instructions (a "playbook") and a
structured prompt with scores, traces, and recent attempts.

Below are the results of MULTIPLE runs using the SAME playbook, prompt template,
and knobs. Every single mutation REGRESSED — the mutator never improved the score.
Your job: analyze why and produce a NEW config that might break the regression pattern.

== CURRENT CONFIG ==

### playbook.md
{playbook}

### prompt-template.md
{prompt_template}

### knobs.json
{knobs_json}

== RUN DATA ({total_runs} runs, {total_mutations} mutations) ==

{run_summaries}

== DETAILED MUTATION LOG (last {detail_window} from each run) ==

{detailed_mutations}

== INSTRUCTIONS ==

Analyze the mutation logs. Look for:
1. What did the mutator consistently get wrong? (e.g. always rewrites entire files,
   always changes the wrong parameter, ignores trace evidence)
2. Is the playbook giving bad advice? (e.g. "minimal edits" when the domain needs
   a different strategy, or the advice is too vague)
3. Is the prompt template missing critical information or including noise?
4. Are the knobs set wrong? (e.g. too much trace data overwhelming the agent,
   or too little context to make good decisions)
5. Are there patterns in the DIFFS? What specifically changed in each regression?

Then propose a NEW config. Output EXACTLY this format with ``` fences:

```playbook.md
(new playbook content here)
```

```prompt-template.md
(new prompt template with {{variables}} here)
```

```knobs.json
{{"key": value, ...}}
```

If you think only one file needs changing, output all three but keep the unchanged
ones as-is. The variables available in the template are: repo_name, objective,
current_score, best_score, seed_score, trace_summary, structured_traces,
recent_attempts, parent_diff_stat, base_diff_stat, constraints.
"""


@dataclass
class RunSummary:
    run_dir: Path
    mutator_spec: str
    total_mutations: int
    improvements: int
    regressions: int
    flat: int
    seed_score: float
    best_score: float
    worst_score: float
    scores: list[float]


def load_run_data(run_dirs: list[Path]) -> list[RunSummary]:
    """Load summary data from multiple hone run directories."""
    summaries = []
    for rd in run_dirs:
        mutations_path = rd / "mutations.jsonl"
        if not mutations_path.exists():
            continue
        rows = _read_jsonl(mutations_path)
        if not rows:
            continue

        run_json = _read_json(rd / "run.json") or {}
        mutator_spec = run_json.get("mutator_spec", "unknown")

        scores = []
        seed_score = rows[0].get("score", 0.0)
        improvements = 0
        regressions = 0
        flat = 0

        for i, row in enumerate(rows):
            score = row.get("score") or row.get("child_score", 0.0)
            scores.append(score)
            if i == 0:
                continue
            delta = row.get("delta")
            if delta is None:
                prev_score = scores[i - 1] if i > 0 else seed_score
                child_score = row.get("child_score", row.get("score", 0.0))
                parent_score = row.get("parent_score", prev_score)
                delta = child_score - parent_score
            if delta > 0.001:
                improvements += 1
            elif delta < -0.001:
                regressions += 1
            else:
                flat += 1

        summaries.append(RunSummary(
            run_dir=rd,
            mutator_spec=mutator_spec,
            total_mutations=len(rows) - 1,
            improvements=improvements,
            regressions=regressions,
            flat=flat,
            seed_score=seed_score,
            best_score=max(scores),
            worst_score=min(scores),
            scores=scores,
        ))
    return summaries


def build_reflector_input(
    runs: list[RunSummary],
    policy: MutatorPolicy = SEED_POLICY,
    detail_window: int = 20,
) -> str:
    """Build the full reflector prompt from run data and current policy."""
    summaries = []
    for r in runs:
        summaries.append(
            f"Run: {r.run_dir.name}  mutator={r.mutator_spec}\n"
            f"  mutations={r.total_mutations}  improvements={r.improvements}  "
            f"regressions={r.regressions}  flat={r.flat}\n"
            f"  seed={r.seed_score:.4f}  best={r.best_score:.4f}  "
            f"worst={r.worst_score:.4f}\n"
            f"  score trajectory: {_score_trajectory(r.scores)}"
        )

    detailed = []
    for r in runs:
        rows = _read_jsonl(r.run_dir / "mutations.jsonl")
        tail = rows[-detail_window:]
        detailed.append(f"--- {r.run_dir.name} ({r.mutator_spec}) last {len(tail)} ---")
        for row in tail:
            if "error" in row:
                detailed.append(f"  iter={row.get('iter','?')} ERROR: {row['error']}")
            else:
                delta = row.get("delta", 0)
                changed = row.get("changed_files", [])
                summary = row.get("trace_summary", "")[:200]
                detailed.append(
                    f"  iter={row.get('iter','?')} "
                    f"parent=c{row.get('parent_idx',0):03d} "
                    f"child=c{row.get('child_idx',0):03d} "
                    f"score={row.get('child_score', row.get('score', 0)):.4f} "
                    f"delta={delta:+.4f} "
                    f"changed={','.join(changed[:3])} "
                    f"trace={summary}"
                )

    total_mutations = sum(r.total_mutations for r in runs)
    return REFLECTOR_PROMPT.format(
        playbook=policy.playbook_text,
        prompt_template=policy.prompt_template,
        knobs_json=json.dumps(_knobs_dict(policy.knobs), indent=2),
        total_runs=len(runs),
        total_mutations=total_mutations,
        run_summaries="\n\n".join(summaries),
        detail_window=detail_window,
        detailed_mutations="\n".join(detailed),
    )


def parse_config_output(text: str) -> dict[str, str]:
    """Parse the ```-fenced config files from the reflector's response.

    Returns dict with keys 'playbook.md', 'prompt-template.md', 'knobs.json'.
    """
    import re
    result: dict[str, str] = {}
    pattern = re.compile(r"```(\S+)\n(.*?)```", re.DOTALL)
    for m in pattern.finditer(text):
        filename = m.group(1)
        content = m.group(2).strip()
        result[filename] = content
    return result


def apply_warmed_config(
    parsed: dict[str, str],
    base: MutatorPolicy = SEED_POLICY,
) -> MutatorPolicy:
    """Build a MutatorPolicy from the reflector's parsed output, falling back to base."""
    playbook = parsed.get("playbook.md", base.playbook_text)
    template = parsed.get("prompt-template.md", base.prompt_template)

    knobs = base.knobs
    if "knobs.json" in parsed:
        try:
            kdict = json.loads(parsed["knobs.json"])
            knobs = PromptKnobs(
                include_structured_traces=kdict.get("include_structured_traces", knobs.include_structured_traces),
                include_recent_attempts=kdict.get("include_recent_attempts", knobs.include_recent_attempts),
                include_parent_diff_stat=kdict.get("include_parent_diff_stat", knobs.include_parent_diff_stat),
                include_base_diff_stat=kdict.get("include_base_diff_stat", knobs.include_base_diff_stat),
                recent_attempts_window=int(kdict.get("recent_attempts_window", knobs.recent_attempts_window)),
                max_trace_chars=int(kdict.get("max_trace_chars", knobs.max_trace_chars)),
                max_trace_summary_chars=int(kdict.get("max_trace_summary_chars", knobs.max_trace_summary_chars)),
            )
        except (json.JSONDecodeError, ValueError):
            pass

    return MutatorPolicy(
        prompt_template=template,
        playbook_text=playbook,
        constraints_text=base.constraints_text,
        knobs=knobs,
    )


def write_config_dir(policy: MutatorPolicy, output_dir: Path) -> None:
    """Write a MutatorPolicy to a config directory."""
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "playbook.md").write_text(policy.playbook_text, encoding="utf-8")
    (output_dir / "prompt-template.md").write_text(policy.prompt_template, encoding="utf-8")
    (output_dir / "knobs.json").write_text(
        json.dumps(_knobs_dict(policy.knobs), indent=2) + "\n",
        encoding="utf-8",
    )


def read_config_dir(config_dir: Path) -> MutatorPolicy:
    """Read a MutatorPolicy from a config directory."""
    playbook = (config_dir / "playbook.md").read_text(encoding="utf-8")
    template = (config_dir / "prompt-template.md").read_text(encoding="utf-8")
    knobs_json = (config_dir / "knobs.json").read_text(encoding="utf-8")
    kdict = json.loads(knobs_json)
    knobs = PromptKnobs(
        include_structured_traces=kdict.get("include_structured_traces", True),
        include_recent_attempts=kdict.get("include_recent_attempts", True),
        include_parent_diff_stat=kdict.get("include_parent_diff_stat", True),
        include_base_diff_stat=kdict.get("include_base_diff_stat", True),
        recent_attempts_window=int(kdict.get("recent_attempts_window", 2)),
        max_trace_chars=int(kdict.get("max_trace_chars", 4000)),
        max_trace_summary_chars=int(kdict.get("max_trace_summary_chars", 1200)),
    )
    return MutatorPolicy(
        prompt_template=template,
        playbook_text=playbook,
        constraints_text=SEED_POLICY.constraints_text,
        knobs=knobs,
    )


def run_bootstrap(
    run_dirs: list[Path],
    model_spec: str,
    output_dir: Path,
    detail_window: int = 20,
    base_policy: MutatorPolicy = SEED_POLICY,
) -> MutatorPolicy:
    """Run the bootstrap reflector over existing data and write warmed config."""
    runs = load_run_data(run_dirs)
    if not runs:
        raise ValueError("no valid run data found in provided directories")

    prompt = build_reflector_input(runs, base_policy, detail_window)

    mutator = resolve_mutator(model_spec)
    result = mutator.propose(prompt)

    parsed = parse_config_output(result.new_prompt)
    warmed = apply_warmed_config(parsed, base_policy)

    write_config_dir(warmed, output_dir)
    return warmed


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _score_trajectory(scores: list[float], max_points: int = 10) -> str:
    if len(scores) <= max_points:
        return " -> ".join(f"{s:.3f}" for s in scores)
    step = len(scores) / max_points
    sampled = [scores[int(i * step)] for i in range(max_points)]
    return " -> ".join(f"{s:.3f}" for s in sampled) + f" (n={len(scores)})"


def _knobs_dict(knobs: PromptKnobs) -> dict:
    return {
        "include_structured_traces": knobs.include_structured_traces,
        "include_recent_attempts": knobs.include_recent_attempts,
        "include_parent_diff_stat": knobs.include_parent_diff_stat,
        "include_base_diff_stat": knobs.include_base_diff_stat,
        "recent_attempts_window": knobs.recent_attempts_window,
        "max_trace_chars": knobs.max_trace_chars,
        "max_trace_summary_chars": knobs.max_trace_summary_chars,
    }


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    return [json.loads(l) for l in lines if l.strip()]


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))
