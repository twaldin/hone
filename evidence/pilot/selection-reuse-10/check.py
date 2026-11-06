"""Zero-model launch proof: run from the repository root on CPU 6 at nice 10."""
import ast
import json
import sys
import time
from pathlib import Path
from unittest.mock import patch

from pilot import __main__ as cli


root = Path(__file__).resolve().parents[3]
started = time.monotonic()
snapshot = json.loads((root / "evidence/pilot/source-snapshot-10.json").read_text())
old = snapshot["files"]["pilot/search.py"]
current = (root / "pilot/search.py").read_text()


def gepa(source):
    node = next(node for node in ast.parse(source).body
                if isinstance(node, ast.FunctionDef) and node.name == "_gepa")
    return ast.get_source_segment(source, node)


assert gepa(old) == gepa(current), "Official GEPA adapter changed"
cli.verify_bundle(root / "evidence/pilot/seed0-search-9")
original = cli.load_panel
observed = {}


class AdmissionComplete(Exception):
    pass


def admission(args):
    selected = original(args)
    assert selected == ("mbpp", "hover"), selected
    observed.update(selected_panel=list(selected), search_seeds=args.seed,
                    execution_limits=cli.execution_limits())
    raise AdmissionComplete


sys.argv = ["pilot", "pilot", "--controls", "evidence/pilot/controls-7b",
            "--seed", "1", "2", "--out", ".pilot-runs/pilot-seeds12-10"]
with patch.object(cli, "load_panel", admission), patch.object(
        cli, "environment", side_effect=AssertionError("Preflight must not initialize model access")):
    try:
        cli.main()
    except AdmissionComplete:
        pass
    else:
        raise AssertionError("CLI did not reach admission")
assert observed["search_seeds"] == [1, 2]
proof = {"schema": "pilot-selection-reuse-launch-proof-v10", **observed,
         "elapsed_seconds": time.monotonic() - started, "model_calls": 0,
         "official_gepa_adapter_byte_unchanged": True,
         "seed0_bundle_verified": "evidence/pilot/seed0-search-9",
         "final_test_labels_read": False,
         "boundary": "Original load_panel completes; stop before environment, gateway, or search."}
cli.save(root / "evidence/pilot/selection-reuse-10/admission.json", proof)
print(json.dumps(proof, sort_keys=True), flush=True)
