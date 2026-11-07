import argparse
import json
from pathlib import Path
import shutil

from pilot import __main__ as cli
from pilot.spend import report_spend


HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description="Project immutable abort evidence without repairing or replaying a search")
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--completed-only", action="store_true", help="Build inputs for protected-metric replay, excluding the damaged cell")
args = parser.parse_args()
assert not args.out.exists(), "Never overwrite a report projection"
assert not args.out.resolve().is_relative_to(HERE), "Write replay outside the sealed bundle"
raw = HERE / "raw"
cli.verify_bundle(raw)
rows = json.loads((raw / "comparison.json").read_text())["runs"]
assert len(rows) == 5 and all(row["status"] == "completed" for row in rows)
for row in rows:
    relative = Path(row["task"]) / str(row["seed"]) / row["method"]
    cli.verify_bundle(raw / relative)
    shutil.copytree(raw / relative, args.out / relative)
if args.completed_only:
    cli.seal(args.out)
    cli.verify_bundle(args.out)
    print(cli.canonical({"completed_cells": len(rows), "model_calls": 0}))
    raise SystemExit(0)
partial = Path("hover/1/plain")
source = raw / partial
assert (source / "manifest.json").read_bytes() == b""
assert not (source / "result.json").exists() and not (source / "search.json").exists()
shutil.copytree(source, args.out / partial, ignore=shutil.ignore_patterns("manifest.json"))
result = cli.resume_result(args.out / partial, "hover", 1, "plain", "OSError_ENOSPC")
spend = report_spend(args.out / partial)
cli.save(args.out / partial / "spend.json", spend)
cli.seal(args.out / partial)
raw_calls = (source / "calls.jsonl").read_bytes()
lines = raw_calls.splitlines(keepends=True)
complete = [line for line in lines if line.endswith(b"\n")]
assert len(complete) == result["calls"] == 2016
assert not lines[-1].endswith(b"\n") and len(lines[-1]) == 160
projection = {
    "schema": "pilot-enospc-report-projection-v10",
    "raw_bundle_inventory_digest": json.loads((raw / "bundle.json").read_text())["bundle_hash"],
    "completed_cells_copied_byte_identically": [f"{row['task']}/{row['seed']}/{row['method']}" for row in rows],
    "derived_failure_cell": str(partial),
    "omitted_from_view_only": {"path": "hover/1/plain/manifest.json", "reason": "empty after ENOSPC", "bytes": 0,
                               "raw_file_hash": cli.file_hash(source / "manifest.json")},
    "raw_prefix_preserved_byte_identically": True,
    "derived_files": ["hover/1/plain/result.json", "hover/1/plain/failure.json", "hover/1/plain/spend.json", "hover/1/plain/bundle.json"],
    "accounting": {"recorded_complete_calls": 2016, "unframed_tail_bytes_excluded": 160,
                   "unpersisted_settlement_responses_at_least": 1,
                   "last_response_outcome_and_usage": "unknown; do not retry or invent usage",
                   "recorded_reported_tokens": result["reported_tokens"],
                   "recorded_usd_equivalent": result["usd_equivalent"],
                   "actual_calls_tokens_and_charges_are_lower_bounds": True,
                   "recorded_only_refusal_hidden_and_missing_usage_counters": True,
                   "wall_active_and_poll_seconds": "unavailable; no terminal ledger summary survived"},
    "measurement_changes": False, "new_model_calls": 0,
}
cli.save(args.out / "projection.json", projection)
cli.seal(args.out)
cli.verify_bundle(args.out)
for row in rows:
    relative = Path(row["task"]) / str(row["seed"]) / row["method"]
    for path in (raw / relative).rglob("*"):
        if path.is_file():
            assert cli.file_hash(path) == cli.file_hash(args.out / relative / path.relative_to(raw / relative))
for path in source.rglob("*"):
    if path.is_file() and path.name != "manifest.json":
        assert cli.file_hash(path) == cli.file_hash(args.out / partial / path.relative_to(source))
print(cli.canonical({"projected_completed_cells": len(rows), "partial_recorded_calls": result["calls"],
                     "unframed_tail_bytes_excluded": 160, "new_model_calls": 0,
                     "report_input_bundle_inventory_digest": json.loads((args.out / "bundle.json").read_text())["bundle_hash"]}))
