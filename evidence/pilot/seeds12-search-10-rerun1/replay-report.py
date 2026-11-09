import argparse
import json
from pathlib import Path

from pilot import __main__ as cli
from pilot.results import report_seeds12


here = Path(__file__).resolve().parent
root = here.parents[2]
parser = argparse.ArgumentParser(description="Replay the stopped infrastructure attempt without model calls")
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args()
inputs = here / "report-inputs"
cli.verify_bundle(here / "raw")
cli.verify_bundle(inputs)
output = args.out.resolve()
assert not output.is_relative_to(here), "Write replay outside the sealed bundle"
report = report_seeds12(inputs, inputs, seed0_runs=root / "evidence/pilot/seed0-search-9")
report["infrastructure_projection"] = json.loads((inputs / "projection.json").read_text())
report["metric_validation"] = json.loads((here / "metric-replay.json").read_text())
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(report, sort_keys=True, indent=2, allow_nan=False) + "\n")
print(json.dumps({"matrix_status": report["matrix_status"], "model_calls": 0,
                  "completed_cells": sum(cell["status"] == "completed" for cell in report["cells"]),
                  "infrastructure_failed_cells": sum(cell["status"] == "infrastructure_failure" for cell in report["cells"]),
                  "missing_cells": sum(cell["status"] == "missing" for cell in report["cells"])}))
