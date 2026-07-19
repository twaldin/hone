#!/usr/bin/env python3
"""Unprivileged worker for frozen orjson throughput workloads."""
from __future__ import annotations

import base64
import dataclasses
import datetime as dt
import gc
import hashlib
import json
import math
import os
import sys
import time
from typing import Any

import numpy as np

SITE = os.environ["ORJSON_SITE"]
sys.path.insert(0, SITE)
import orjson  # noqa: E402


@dataclasses.dataclass(slots=True)
class Event:
    sequence: int
    label: str
    active: bool
    ratio: float
    tags: tuple[str, ...]


@dataclasses.dataclass(slots=True)
class Envelope:
    source: str
    created: dt.datetime
    events: list[Event]


def make_value(case: dict[str, Any]) -> Any:
    kind = case["kind"]
    size = int(case["size"])
    salt = int(case["salt"])
    if kind == "dataclass":
        events = [
            Event(
                sequence=salt + i,
                label=f"event-{salt + i:05d}",
                active=(i & 1) == 0,
                ratio=(i % 97) / 7.0,
                tags=("alpha", f"group-{i % 11}", "東京"),
            )
            for i in range(size)
        ]
        return Envelope(
            source=f"source-{salt}",
            created=dt.datetime(2024, 3, 14, 15, 9, 26, 535897, tzinfo=dt.timezone.utc),
            events=events,
        )
    if kind == "datetime":
        return [
            {
                "at": dt.datetime(
                    2020 + (i % 6),
                    1 + (i % 12),
                    1 + (i % 27),
                    i % 24,
                    (i * 7) % 60,
                    (i * 13) % 60,
                    (i * 9973) % 1_000_000,
                    tzinfo=dt.timezone(dt.timedelta(minutes=((i % 17) - 8) * 15)),
                ),
                "day": dt.date(2020 + (i % 6), 1 + (i % 12), 1 + (i % 27)),
                "id": salt + i,
            }
            for i in range(size)
        ]
    if kind == "numpy":
        values = np.arange(salt, salt + size, dtype=np.int64).reshape((-1, 8))
        fractions = np.linspace(-100.0, 100.0, size, dtype=np.float64).reshape((-1, 8))
        return {"values": values, "fractions": fractions, "enabled": np.bool_(True)}
    if kind == "unicode":
        fragments = ("東京", "🙂🚀", "naïve café", "Здравствуй", "مرحبا", "हिन्दी")
        return [
            f"{fragments[(i + salt) % len(fragments)]}:{salt + i:05d}:"
            f"{fragments[(i * 5 + salt) % len(fragments)]}"
            for i in range(size)
        ]
    if kind == "nested":
        return json.loads(base64.b64decode(case["inputB64"]))
    raise ValueError(f"unknown workload kind: {kind}")


def option_for(kind: str) -> int:
    return orjson.OPT_SERIALIZE_NUMPY if kind == "numpy" else 0


def result_hash(operation: str, result: Any) -> str:
    if operation == "dumps":
        payload = bytes(result)
    else:
        payload = json.dumps(
            result,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def measure(case: dict[str, Any]) -> dict[str, Any]:
    operation = case["operation"]
    kind = case["kind"]
    option = option_for(kind)
    if operation == "dumps":
        argument = make_value(case)

        def invoke() -> Any:
            return orjson.dumps(argument, option=option)

    elif operation == "loads":
        argument = base64.b64decode(case["inputB64"])

        def invoke() -> Any:
            return orjson.loads(argument)

    else:
        raise ValueError(f"unknown operation: {operation}")

    result: Any = None
    for _ in range(12):
        result = invoke()
    probe_iterations = 8
    started = time.perf_counter_ns()
    for _ in range(probe_iterations):
        result = invoke()
    probe_ns = max(1, time.perf_counter_ns() - started)
    target_ns = int(case.get("targetNs", 80_000_000)) * 2
    iterations = max(1, min(2_000_000, math.ceil(target_ns * probe_iterations / probe_ns)))
    samples: list[int] = []
    for _ in range(int(case.get("repeats", 5))):
        started = time.perf_counter_ns()
        for _ in range(iterations):
            result = invoke()
        samples.append(time.perf_counter_ns() - started)
    return {
        "id": case["id"],
        "operation": operation,
        "iterations": iterations,
        "elapsedNs": samples,
        "resultSha256": result_hash(operation, result),
    }


def main() -> None:
    request = json.load(sys.stdin)
    cases = request.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("request has no cases")
    if hasattr(gc, "freeze"):
        gc.freeze()
    gc.collect()
    gc.disable()
    response = {"cases": [measure(case) for case in cases]}
    json.dump(response, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
