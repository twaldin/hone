#!/usr/bin/env python3
import json
import sys

payload = json.loads(sys.argv[1])
print(json.dumps({
    "valid": payload.get("valid"),
    "q": payload.get("objectives", {}).get("score"),
    "constraints": payload.get("constraints"),
    "resultHash": payload.get("diagnostics", {}).get("result_hash"),
    "buildSec": payload.get("diagnostics", {}).get("build_sec"),
    "runtimeSec": payload.get("diagnostics", {}).get("runtime_sec"),
    "peakRssKb": payload.get("diagnostics", {}).get("peak_rss_kb"),
    "summary": payload.get("diagnostics", {}).get("summary"),
}, sort_keys=True, separators=(",", ":")))
