"""Seed mutator policy for hone v1.

The GEPA source prompt we are adapting comes from the installed package at
`gepa.optimize_anything.optimize_anything_reflection_prompt_template`.

Exact source text:

I am optimizing a parameter in my system. The current parameter value is:
```
<curr_param>
```

Below is evaluation data showing how this parameter value performed across
multiple test cases. The data contains performance metrics, diagnostic
information, and other relevant details from the evaluation:
```
<side_info>
```

Your task is to propose a new, improved parameter value that can be used as a
drop-in replacement for the current one.

Carefully analyze all the evaluation data provided above. Look for patterns
that indicate what works and what doesn't. Pay special attention to:
- Performance metrics and how they correlate with parameter behavior
- Recurring issues, errors, or failure patterns across multiple test cases
- Successful patterns or behaviors that should be preserved or enhanced
- Any domain-specific requirements, constraints, or factual information
  revealed in the evaluation data
- Specific technical details that are crucial for understanding the
  parameter's role

Based on your analysis, propose a new parameter value that addresses the
identified issues while maintaining or improving upon what works well. Your
proposal should be directly informed by the patterns and insights from the
evaluation data.

Provide the new parameter value within ``` blocks.

For hone v1 we keep that reflective structure, but move durable behavioral
guidance into a tiny playbook file and keep the per-iteration prompt mostly as
structured state.
"""
from __future__ import annotations

from dataclasses import dataclass


GEPA_OPTIMIZE_ANYTHING_REFLECTION_PROMPT = """I am optimizing a parameter in my system. The current parameter value is:
```
<curr_param>
```

Below is evaluation data showing how this parameter value performed across multiple test cases. The data contains performance metrics, diagnostic information, and other relevant details from the evaluation:
```
<side_info>
```

Your task is to propose a new, improved parameter value that can be used as a drop-in replacement for the current one.

Carefully analyze all the evaluation data provided above. Look for patterns that indicate what works and what doesn't. Pay special attention to:
- Performance metrics and how they correlate with parameter behavior
- Recurring issues, errors, or failure patterns across multiple test cases
- Successful patterns or behaviors that should be preserved or enhanced
- Any domain-specific requirements, constraints, or factual information revealed in the evaluation data
- Specific technical details that are crucial for understanding the parameter's role

Based on your analysis, propose a new parameter value that addresses the identified issues while maintaining or improving upon what works well. Your proposal should be directly informed by the patterns and insights from the evaluation data.

Provide the new parameter value within ``` blocks."""


SEED_PLAYBOOK = """# hone mutator playbook (how to mutate well)

Task: edit files in this workdir to produce a candidate that scores higher on
the grader. Hone runs the grader after you exit — your job is just to make
the edit and hand back.

How to choose what to change:
- Read `trace_summary` and `structured_traces` in the prompt. Identify the
  single failure mode most likely holding the score down (e.g. a specific
  course/seed pattern, a recurring crash reason, a latency anomaly).
- Check `recent_attempts` before editing. Don't repeat a pattern that just
  failed. Use it to narrow the search direction.
- Prefer targeted, minimal edits grounded in trace evidence over speculative
  large rewrites. 1-3 focused changes to the most load-bearing file usually
  beats touching many files.

How to be sure your edit isn't broken:
- Before exiting, confirm the code still imports and returns plausible output
  on a simple synthetic input. Don't ship an edit that fails at import.
- A working-but-worse candidate is more useful to hone than a broken one. If
  your sanity check reveals a clear break (import error, NaN, obvious crash),
  fix or revert before exiting.

Style:
- Preserve stated constraints. Avoid obvious regressions.
- Edits should be legible to a future iteration that reads the diff.
"""


OPERATIONAL_CONSTRAINTS = """# Operational constraints for this run (fixed — not under search)

These are compute/cost rules specific to this experiment. They are NOT
mutation-quality advice. Do not rewrite or reason around them.

Scope:
- Stay inside this workdir. Do NOT read, list, or cd into directories outside
  of it (no `.hone/`, no sibling runs, no parent project dirs).
- Read-only git is allowed: `git log`, `git show`, `git diff`, `git branch`.
  Use these to inspect prior iterations (branches are named
  `hone/<run_id>/iter-N`). `git show <branch>:path/to/file` reads any past
  file version; `git diff <branch1> <branch2> -- path` compares.
- Do NOT write via git: no commit, checkout that moves HEAD, reset, stash,
  merge, rebase. Hone handles all commits.

Grading compute:
- Do NOT run the full grader, `grader.sh`, or `run_parallel.py`. That's the
  multi-course/multi-seed evaluation hone does for you AFTER you exit.
- If you want to sanity-check your edit doesn't crash end-to-end, you MAY run
  ONE invocation of `run_rollout.py` on a single level+seed:
    python3 run_rollout.py --planner planner.py --level 0 --seed 1 --timeout 20
  One rollout total. Do not loop over levels or seeds.

Time:
- Aim to finish in 2-5 minutes. Correctness of the edit matters more than
  speed, but do not re-grade across all courses.

Principle over recipe:
- Your changes must be general principles ("use git log to see history",
  "enumerate invariants before editing", "check for WAL files when a
  SQLite database fails to open") NOT task-specific recipes ("for
  db-wal-recovery task, run X command", "for fix-git, do Y").
- If your proposed AGENTS.md change mentions a specific task ID by name,
  lists exact command invocations for one domain, or adds >15 lines of
  procedural content, you are memorizing. Rewrite as principle.
- Good mutation: +3 lines abstract guidance that would help across 20+
  task types. Bad mutation: +20 lines of specific recipe for one task.
"""


SEED_PROMPT_TEMPLATE = """repo: {repo_name}
objective: {objective}

score:
- current: {current_score}
- best: {best_score}
- seed: {seed_score}

trace_summary:
{trace_summary}

structured_traces:
{structured_traces}

recent_attempts:
{recent_attempts}

parent_diff_stat:
{parent_diff_stat}

base_diff_stat:
{base_diff_stat}

constraints:
{constraints}
"""


@dataclass(frozen=True)
class PromptKnobs:
    include_structured_traces: bool = True
    include_recent_attempts: bool = True
    include_parent_diff_stat: bool = True
    include_base_diff_stat: bool = True
    recent_attempts_window: int = 2
    max_trace_chars: int = 4000
    max_trace_summary_chars: int = 1200


@dataclass(frozen=True)
class MutatorPolicy:
    prompt_template: str = SEED_PROMPT_TEMPLATE
    playbook_text: str = SEED_PLAYBOOK
    constraints_text: str = OPERATIONAL_CONSTRAINTS
    knobs: PromptKnobs = PromptKnobs()

    def rendered_playbook(self) -> str:
        """Concat playbook (meta-optimizable) and constraints (fixed) for the agent.

        The split exists so future meta-optimization can rewrite
        `playbook_text` without drifting the operational constraints
        (compute budget, scope, git rules) that are cost-of-compute,
        not mutation-quality, in nature.
        """
        parts = [self.playbook_text.rstrip()]
        if self.constraints_text.strip():
            parts.append(self.constraints_text.rstrip())
        return "\n\n".join(parts) + "\n"


SEED_POLICY = MutatorPolicy()


@dataclass(frozen=True)
class PromptContext:
    repo_name: str
    objective: str
    current_score: float
    best_score: float
    seed_score: float
    trace_summary: str
    structured_traces: str
    recent_attempts: str
    parent_diff_stat: str
    base_diff_stat: str
    constraints: str


def build_iteration_prompt(policy: MutatorPolicy, ctx: PromptContext) -> str:
    """Render the minimal v1 prompt from a structured context."""
    trace_summary = _truncate(ctx.trace_summary, policy.knobs.max_trace_summary_chars)
    structured_traces = ctx.structured_traces if policy.knobs.include_structured_traces else "(omitted)"
    structured_traces = _truncate(structured_traces, policy.knobs.max_trace_chars)
    recent_attempts = ctx.recent_attempts if policy.knobs.include_recent_attempts else "(omitted)"
    parent_diff_stat = ctx.parent_diff_stat if policy.knobs.include_parent_diff_stat else "(omitted)"
    base_diff_stat = ctx.base_diff_stat if policy.knobs.include_base_diff_stat else "(omitted)"
    return policy.prompt_template.format(
        repo_name=ctx.repo_name,
        objective=ctx.objective,
        current_score=_fmt_score(ctx.current_score),
        best_score=_fmt_score(ctx.best_score),
        seed_score=_fmt_score(ctx.seed_score),
        trace_summary=trace_summary or "(none)",
        structured_traces=structured_traces or "(none)",
        recent_attempts=recent_attempts or "(none)",
        parent_diff_stat=parent_diff_stat or "(none)",
        base_diff_stat=base_diff_stat or "(none)",
        constraints=ctx.constraints or "(none)",
    ).strip() + "\n"


def adapter_playbook_filename(mutator_spec: str) -> str:
    if mutator_spec.startswith("harness:"):
        rest = mutator_spec[len("harness:"):]
        adapter = rest.split(":", 1)[0] if ":" in rest else rest
    elif ":" in mutator_spec:
        adapter = mutator_spec.split(":", 1)[0]
    else:
        adapter = mutator_spec
    if adapter in {"opencode", "codex"}:
        return "AGENTS.md"
    return "CLAUDE.md"


def _fmt_score(score: float) -> str:
    return f"{score:.6f}"


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 13)] + "\n...[truncated]"
