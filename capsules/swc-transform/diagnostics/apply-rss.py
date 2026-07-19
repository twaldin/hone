#!/usr/bin/env python3
import json
import sys
from pathlib import Path

measurement = json.loads(sys.argv[1])
root = Path(__file__).resolve().parents[1] / "assets"
for split in ("train", "validation"):
    path = root / split / "workloads.json"
    metadata = json.loads(path.read_text())
    rows = measurement[split]
    if [row["file"] for row in rows] != ["javascript.js", "typescript.ts", "react.tsx"]:
        raise SystemExit("unexpected RSS measurement order")
    for workload, measured in zip(metadata["workloads"], rows, strict=True):
        workload["baselinePeakRssKb"] = int(measured["peakRssKb"])
    path.write_text(json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n")
print("rss-frozen")
