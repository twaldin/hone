from __future__ import annotations

from hone.policy import (
    GEPA_OPTIMIZE_ANYTHING_REFLECTION_PROMPT,
    OPERATIONAL_CONSTRAINTS,
    PromptContext,
    SEED_PLAYBOOK,
    SEED_POLICY,
    build_iteration_prompt,
)


def test_gepa_source_prompt_matches_expected_anchor_text() -> None:
    assert GEPA_OPTIMIZE_ANYTHING_REFLECTION_PROMPT.startswith(
        "I am optimizing a parameter in my system."
    )
    assert "Provide the new parameter value within ``` blocks." in GEPA_OPTIMIZE_ANYTHING_REFLECTION_PROMPT


def test_seed_playbook_is_mutation_quality_advice_only() -> None:
    """The meta-optimizable playbook covers HOW to mutate well.
    Operational constraints (compute budget, scope) live separately."""
    assert "trace_summary" in SEED_PLAYBOOK
    assert "recent_attempts" in SEED_PLAYBOOK
    # Hard operational rules should NOT be in the meta-optimizable playbook.
    assert "grader.sh" not in SEED_PLAYBOOK
    assert "run_parallel.py" not in SEED_PLAYBOOK


def test_operational_constraints_hold_compute_rules() -> None:
    assert "Stay inside this workdir" in OPERATIONAL_CONSTRAINTS
    assert "Do NOT run the full grader" in OPERATIONAL_CONSTRAINTS
    assert "run_rollout.py" in OPERATIONAL_CONSTRAINTS


def test_rendered_playbook_concatenates_both_parts() -> None:
    rendered = SEED_POLICY.rendered_playbook()
    assert "trace_summary" in rendered  # from playbook
    assert "Stay inside this workdir" in rendered  # from constraints
    assert rendered.endswith("\n")


def test_build_iteration_prompt_renders_structured_state() -> None:
    prompt = build_iteration_prompt(
        SEED_POLICY,
        PromptContext(
            repo_name="hone-a-drone",
            objective="make the controller faster",
            current_score=0.8,
            best_score=0.9,
            seed_score=0.5,
            trace_summary="timeout on level 2",
            structured_traces='{"case": "l2", "score": 0.0}',
            recent_attempts="c000 -> c001: delta=+0.1",
            parent_diff_stat="M planner.py",
            base_diff_stat="M planner.py\nM sim.py",
            constraints="optimize directory root=repo",
        ),
    )
    assert "repo: hone-a-drone" in prompt
    assert "objective: make the controller faster" in prompt
    assert "current: 0.800000" in prompt
    assert "parent_diff_stat:" in prompt
    assert "constraints:" in prompt
