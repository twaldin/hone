import argparse
import json
from pathlib import Path

from pilot import __main__ as cli
from pilot.results import report_seeds12


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
METHODS = ("hone", "gepa", "plain")


def number(value, places=2):
    return "N/A" if value is None else f"{value:.{places}f}"


def percent(value):
    return "N/A" if value is None else number(100 * value)


def interval(inference):
    return "N/A" if inference is None else "[" + ", ".join(percent(value) for value in inference["ci95"]) + "]"


def table(headers, rows):
    def line(values):
        return "| " + " | ".join(str(value).replace("|", "\\|").replace("\n", " ") for value in values) + " |"
    return "\n".join([line(headers), line(["---"] * len(headers)), *[line(row) for row in rows]]) + "\n"


def quality_row(cell):
    inference = cell.get("inference")
    return [cell["seed"], cell["task"], cell["method"], cell["status"],
            percent(inference["baseline_score"]) if inference else "N/A",
            percent(inference["chosen_score"]) if inference else "N/A",
            percent(inference["delta"]) if inference else "N/A", interval(inference)]


def aggregate_row(label, method, entry):
    inference = entry["inference"]
    return [label, method, percent(inference["baseline_score"]) if inference else "N/A",
            percent(inference["chosen_score"]) if inference else "N/A",
            percent(inference["delta"]) if inference else "N/A", interval(inference)]


def diagnostic_row(cell):
    diagnostic = cell["diagnostics"]
    missing = diagnostic["gate_passing_candidates_without_complete_selection"]
    evidence = diagnostic["gate_passing_missing_selection_evidence"]
    reasons = json.dumps(evidence, sort_keys=True) if evidence else ("None" if missing == 0 else "N/A")
    return [cell["seed"], cell["task"], cell["method"],
            diagnostic["selection_evaluations_of_already_scored_artifacts"],
            diagnostic["duplicate_count_status"], "N/A" if missing is None else missing,
            diagnostic["gate_count_status"], reasons]


def usage_row(cell):
    total, accounting = cell["spend"]["total"], cell["accounting"]
    return [cell["seed"], cell["task"], cell["method"], total["calls"], total["reported_tokens"],
            total["estimated_tokens"], number(total["reported_usd_equivalent"], 6),
            accounting["refusals"], accounting["hidden_attempts"], accounting["usage_missing_calls"]]


def phase_rows(cells):
    return [[cell["seed"], cell["task"], cell["method"], phase, bucket["calls"], bucket["reported_tokens"],
             number(bucket["reported_usd_equivalent"], 6)]
            for cell in cells for phase, bucket in cell["spend"]["buckets"].items()]


def timing_row(cell):
    timing = cell["timing"]
    return [cell["seed"], cell["task"], cell["method"], number(timing["wall_seconds"], 3),
            number(timing["active_seconds"], 3), number(timing["poll_seconds"], 3),
            number(timing["pause_seconds"], 3), timing["pauses"], cell.get("binding_cap") or cell["stop_reason"]]


def render(report):
    cells, historical = report["cells"], report["seed0_historical"]
    quality_headers = ["Seed", "Task", "Method", "Status", "Baseline %", "Chosen %", "Delta pp", "95% CI pp"]
    usage_headers = ["Seed", "Task", "Method", "Calls", "Reported tokens", "Estimated tokens", "Reported $equivalent", "Refusals", "Hidden attempts", "Missing usage calls"]
    phase_headers = ["Seed", "Task", "Method", "Phase", "Calls", "Reported tokens", "Reported $equivalent"]
    timing_headers = ["Seed", "Task", "Method", "Ledger wall s", "Active s", "Polling s", "Pause s", "Pause episodes", "Binding cap or stop"]
    diagnostic_headers = ["Seed", "Task", "Method", "Repeated selection evaluations", "Count status", "Gate-passers without complete selection", "Gate status", "Missing-gate evidence and reason"]
    sections = ["# Predeclaration 11 archive-derived tables\n",
                "Twelve cells were attempted. Eleven completed at declared caps. MBPP/seed-2/GEPA is an unscored infrastructure failure. N/A is unavailable, never zero-filled or renormalized.\n",
                "All intervals describe adaptive development selection. They are not confirmatory evidence of optimizer superiority. Seed 0 is historical and never pooled with seeds 1 and 2. Values are percentages or percentage points as labeled.\n",
                "## Primary cells, seeds 1 and 2\n", table(quality_headers, [quality_row(cell) for cell in cells]),
                "## Per-seed methods and primary aggregation\n"]
    aggregates = [aggregate_row("PD11 seeds 1 and 2", method, report["methods"][method]) for method in METHODS]
    aggregates += [aggregate_row(f"PD11 seed {seed}", method, report["per_seed"][str(seed)]["methods"][method]) for seed in (1, 2) for method in METHODS]
    aggregates += [aggregate_row("PD9 seed 0, separate", method, historical["methods"][method]) for method in METHODS]
    sections += [table(["Measurement", "Method", "Baseline %", "Chosen %", "Delta pp", "95% CI pp"], aggregates),
                 "Intervals use equal seed and task weighting, 10,000 MT19937 replicates, seed 20261109, and type-7 endpoints. GEPA's primary aggregate is unavailable because MBPP/seed-2/GEPA failed.\n",
                 "## Per-task aggregation across seeds 1 and 2\n"]
    task_rows = []
    for method in METHODS:
        for task, entry in report["methods"][method]["tasks"].items():
            inference = entry["inference"]
            task_rows.append([task, method, ", ".join(map(str, entry["paired_seeds"])),
                              percent(inference["baseline_score"]) if inference else "N/A",
                              percent(inference["chosen_score"]) if inference else "N/A",
                              percent(inference["delta"]) if inference else "N/A", interval(inference)])
    sections += [table(["Task", "Method", "Paired seeds", "Baseline %", "Chosen %", "Delta pp", "95% CI pp"], task_rows),
                 "## Selection reuse and missing gate-passers\n", table(diagnostic_headers, [diagnostic_row(cell) for cell in cells]),
                 "All Hone and plain cells have zero archived repeated selection evaluations. Unchanged MBPP/seed-1/GEPA has one. The failed GEPA cell has no terminal search.json, which remains absent and is flagged by the reporter.\n",
                 "## Fresh selection tails\n"]
    tails = [[cell["seed"], cell["task"], cell["method"], tail["artifact_hash"], len(tail["call_lines"]), tail["reason"]]
             for cell in cells for tail in cell["diagnostics"]["started_incomplete_selection_tails"]]
    sections += [table(["Seed", "Task", "Method", "Artifact", "Observed tail calls", "Reason"], tails),
                 "These are incomplete vectors, not zero scores. They remain charged and do not become eligible selections. The raw result records retain the binding cap or infrastructure failure.\n",
                 "## Usage and error counters\n", table(usage_headers, [usage_row(cell) for cell in cells]),
                 "Reported cost-equivalent is not an invoice. One provider call lacks reported usage, and internal failed-attempt usage remains unknown. Conservative estimates are not reported usage.\n",
                 "## Per-cell phase spend\n", table(phase_headers, phase_rows(cells)),
                 "Unassigned evaluation-tail calls stay in the total and are not allocated to a fabricated completed evaluation.\n",
                 "## Per-cell timing and binding caps\n", table(timing_headers, [timing_row(cell) for cell in cells]),
                 "## Historical seed 0, separate\n", table(quality_headers, [quality_row(cell) for cell in historical["cells"]]),
                 "These predeclaration-9 measurements retain the original last-matching-vector policy and same-artifact stochastic remeasurement caveats. See ../seed0-search-9/README.md.\n",
                 "### Historical usage and errors\n", table(usage_headers, [usage_row(cell) for cell in historical["cells"]]),
                 "### Historical phase spend\n", table(phase_headers, phase_rows(historical["cells"])),
                 "### Historical timing and caps\n", table(timing_headers, [timing_row(cell) for cell in historical["cells"]]),
                 "### Historical selection diagnostics\n", table(diagnostic_headers, [diagnostic_row(cell) for cell in historical["cells"]])]
    return "\n".join(sections)


def main():
    parser = argparse.ArgumentParser(description="Replay immutable pilot reports and tables without model calls or grader replays")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    output = args.out.resolve()
    assert not output.is_relative_to(HERE), "Write replay outside the sealed bundle"
    assert not output.exists(), "Never overwrite replay output"
    raw = HERE / "raw"
    cli.verify_bundle(raw)
    inventory = json.loads((HERE / "source-inventory.json").read_bytes())["producer_inventory"]
    for name, entry in inventory.items():
        path = (raw / name).resolve()
        assert path.is_relative_to(raw.resolve())
        assert path.stat().st_size == entry["bytes"] and cli.file_hash(path) == entry["sha256"], name
    for row in json.loads((raw / "comparison.json").read_bytes())["runs"]:
        cli.verify_bundle(raw / row["task"] / str(row["seed"]) / row["method"])
    report = report_seeds12(raw, raw, seed0_runs=ROOT / "evidence/pilot/seed0-search-9", predeclaration=11)
    output.mkdir(parents=True)
    (output / "report.json").write_text(json.dumps(report, sort_keys=True, indent=2, allow_nan=False) + "\n")
    (output / "tables.md").write_text(render(report))
    print(json.dumps({"matrix_status": report["matrix_status"], "completed_cells": sum(cell["status"] == "completed" for cell in report["cells"]),
                      "infrastructure_failed_cells": sum(cell["status"] == "infrastructure_failure" for cell in report["cells"]),
                      "model_calls": 0, "grader_replays": 0}, sort_keys=True))


if __name__ == "__main__":
    main()
