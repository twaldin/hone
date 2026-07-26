#!/usr/bin/env python3
"""Unprivileged candidate-linked worker for frozen orjson throughput workloads.

Command-driven protocol: the trusted evaluator parent writes one JSON command
per line on stdin and reads one JSON reply per line from stdout. All elapsed
time is measured by the parent around each ``run`` command, so no clock read
inside this candidate-linked process is ever trusted.

Correctness and anti-shortcut are both owned by the parent, not this process:

  * ``setup`` returns the pristine (unmutated) ``canon`` digest, which the
    parent compares against the frozen expected hash (byte-exact dumps /
    semantic loads gate).
  * every timed ``run`` returns a data-dependent result-chain digest over the
    real serializer output of EVERY iteration (see ``orjson_workload.py``). The
    parent independently reproduces that chain with a PRISTINE reference
    ``orjson`` over the same per-run-unpredictable nonce and rejects any run
    whose chain does not match, so no iteration can be skipped, replayed from a
    cached constant, or served with cheap-wrong output.

All workload construction lives in the trusted, serializer-agnostic
``orjson_workload`` module (shared with the parent); this file only wires the
CANDIDATE ``orjson`` build into it.
"""
from __future__ import annotations

import gc
import json
import os
import sys
from typing import Any

SITE = os.environ["ORJSON_SITE"]
# Under `python -I` the script directory is NOT added to sys.path, so make the
# trusted worker module dir importable explicitly (appended, so it never
# shadows the candidate orjson taken from SITE).
sys.path.insert(0, SITE)
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import orjson  # noqa: E402

import orjson_workload as workload  # noqa: E402


def main() -> None:
    if hasattr(gc, "freeze"):
        gc.freeze()
    gc.collect()
    gc.disable()
    states: dict[str, workload.Workload] = {}
    correctness = {case["id"]: case for case in workload.correctness_cases()}
    out = sys.stdout
    for line in sys.stdin:
        if not line.strip():
            continue
        command = json.loads(line)
        op = command["op"]
        if op == "exit":
            break
        if op == "setup":
            case = command["case"]
            state = workload.Workload(case)
            # Warm the serializer path once (untimed) with a few iterations.
            state.chain(orjson, 4, 0)
            canon = state.canon(orjson)
            states[case["id"]] = state
            reply: dict[str, Any] = {"op": "setup", "id": case["id"], "canon": canon}
        elif op == "refresh":
            case_id = command["id"]
            states[case_id].build()
            reply = {"op": "refresh", "id": case_id}
        elif op == "run":
            case_id = command["id"]
            digest = states[case_id].chain(
                orjson, int(command["iterations"]), int(command["nonce"])
            )
            reply = {"op": "run", "id": case_id, "resultChain": digest}
        elif op == "teardown":
            case_id = command["id"]
            del states[case_id]
            gc.collect()
            reply = {"op": "teardown", "id": case_id}
        elif op == "check":
            case_id = command["id"]
            nonce = int(command["nonce"])
            result = workload.apply_correctness(orjson, correctness[case_id], nonce)
            reply = {"op": "check", "id": case_id, "nonce": nonce, "result": result}
        else:
            raise ValueError(f"unknown command: {op}")
        out.write(json.dumps(reply, separators=(",", ":")))
        out.write("\n")
        out.flush()


if __name__ == "__main__":
    main()
