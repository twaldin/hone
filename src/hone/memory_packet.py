"""Experiment memory packet assembly for hone iterations."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hone.repo_frontier import AttemptRecord, RepoCandidate


@dataclass
class MemoryPacket:
    """Structured summary of run state for injection into the iteration prompt."""

    parent_score: float
    best_score: float
    seed_score: float
    submetric_deltas: dict[str, float]
    top_failing_submetrics: list[tuple[str, float]]
    recent_attempts: list[dict]
    parent_diff_stat: str
    base_diff_stat: str
    structured_traces: list[dict]


def build_memory_packet(
    *,
    parent: RepoCandidate,
    best: RepoCandidate,
    seed: RepoCandidate,
    attempts: list[AttemptRecord],
    window: int,
    submetric_top_k: int = 5,
) -> MemoryPacket:
    """Build a MemoryPacket from current run state."""
    all_keys = set(best.submetrics) | set(parent.submetrics)
    submetric_deltas = {
        k: best.submetrics.get(k, 0.0) - parent.submetrics.get(k, 0.0)
        for k in all_keys
    }

    top_failing = sorted(parent.submetrics.items(), key=lambda x: x[1])[:submetric_top_k]

    recent: list[dict] = []
    for attempt in attempts[-window:] if window > 0 else []:
        delta = (
            (attempt.child_score or 0.0) - attempt.parent_score
            if attempt.child_score is not None
            else None
        )
        recent.append({
            "iter": attempt.iteration,
            "parent_idx": attempt.parent_idx,
            "child_idx": attempt.child_idx,
            "delta": delta,
            "changed_files": attempt.changed_files,
            "trace_summary": attempt.trace_summary,
            "submetric_deltas": attempt.submetric_deltas,
        })

    return MemoryPacket(
        parent_score=parent.score,
        best_score=best.score,
        seed_score=seed.score,
        submetric_deltas=submetric_deltas,
        top_failing_submetrics=top_failing,
        recent_attempts=recent,
        parent_diff_stat=parent.parent_diff_stat,
        base_diff_stat=parent.base_diff_stat,
        structured_traces=parent.traces,
    )


def render_memory_packet(
    packet: MemoryPacket,
    *,
    max_trace_chars: int,
    max_attempts: int,
) -> str:
    """Render a MemoryPacket as a markdown-ish text block for the iteration prompt."""
    parts: list[str] = []

    parts.append(
        f"scores: parent={packet.parent_score:.6f} "
        f"best={packet.best_score:.6f} "
        f"seed={packet.seed_score:.6f}"
    )

    if packet.submetric_deltas:
        lines = [
            f"  {k}: {v:+.6f}"
            for k, v in sorted(packet.submetric_deltas.items())
        ]
        parts.append("submetric_deltas:\n" + "\n".join(lines))
    else:
        parts.append("submetric_deltas: (none)")

    if packet.top_failing_submetrics:
        lines = [f"  {k}={v:.6f}" for k, v in packet.top_failing_submetrics]
        parts.append("top_failing_submetrics:\n" + "\n".join(lines))
    else:
        parts.append("top_failing_submetrics: (none)")

    if packet.recent_attempts:
        shown = packet.recent_attempts[-max_attempts:] if max_attempts > 0 else []
        attempt_lines: list[str] = []
        for a in shown:
            delta_str = f"{a['delta']:+.4f}" if a["delta"] is not None else "N/A"
            changed = ", ".join((a.get("changed_files") or [])[:3]) or "(none)"
            child_str = (
                f"c{a['child_idx']:03d}" if a["child_idx"] is not None else "None"
            )
            attempt_lines.append(
                f"  iter={a['iter']} parent=c{a['parent_idx']:03d} child={child_str} "
                f"delta={delta_str} changed={changed} "
                f"trace={a.get('trace_summary') or '(none)'}"
            )
        parts.append("recent_attempts:\n" + "\n".join(attempt_lines))
    else:
        parts.append("recent_attempts: (none)")

    parts.append(f"parent_diff_stat: {packet.parent_diff_stat or '(none)'}")
    parts.append(f"base_diff_stat: {packet.base_diff_stat or '(none)'}")

    if packet.structured_traces:
        traces_str = "\n".join(json.dumps(t) for t in packet.structured_traces)
        if len(traces_str) > max_trace_chars:
            traces_str = traces_str[: max(0, max_trace_chars - 13)] + "\n...[truncated]"
        parts.append("structured_traces:\n" + traces_str)
    else:
        parts.append("structured_traces: (none)")

    return "\n\n".join(parts)
