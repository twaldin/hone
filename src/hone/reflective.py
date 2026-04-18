"""Turn grader stderr into GEPA's reflective_dataset format.

GEPA expects per-example feedback. We infer "examples" from the grader's stderr
by looking for lines of the shape `<example_id>: <trace>`. Anything that doesn't
parse falls into a single catch-all example.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Matches lines like:
#   click-pr2421: 3/3 fixed
#   koa-1834: 0/7 failed (modified wrong file)
#   example_42: score=0.8, notes=...
#
# The separator is a colon; a dash won't work here because IDs themselves
# commonly contain dashes (click-pr2421).
_EXAMPLE_LINE = re.compile(r"^\s*([A-Za-z0-9][\w\-\.]{2,})\s*:\s+(.+?)\s*$")


@dataclass
class ExampleTrace:
    """Per-example feedback row extracted from grader stderr."""

    example_id: str
    trace: str


def parse_trace(stderr: str) -> list[ExampleTrace]:
    """Best-effort extraction of per-example traces from grader stderr.

    If no lines match the `id: trace` shape, returns a single aggregate row
    with example_id='aggregate' and the full stderr as trace.
    """
    examples: list[ExampleTrace] = []
    for line in stderr.splitlines():
        m = _EXAMPLE_LINE.match(line)
        if m:
            examples.append(ExampleTrace(example_id=m.group(1), trace=m.group(2)))
    if not examples:
        examples.append(ExampleTrace(example_id="aggregate", trace=stderr.strip()))
    return examples


def build_reflective_dataset(
    stderr: str,
    score: float,
    component: str = "instruction",
) -> dict[str, list[dict]]:
    """Build GEPA's reflective_dataset for a single component.

    GEPA expects:
        {component_name: [{example_id, score, trace, ...}, ...]}

    Notes:
      - Per-example scores aren't available from the grader stderr (we get one
        global score). We attach the global score to each example for now;
        richer graders can emit per-example scores via stderr and be parsed
        by a more specific variant later.
    """
    traces = parse_trace(stderr)
    rows: list[dict] = [
        {
            "example_id": t.example_id,
            "score": score,
            "trace": t.trace,
        }
        for t in traces
    ]
    return {component: rows}
