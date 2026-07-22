#!/usr/bin/env python3
"""Unprivileged worker for frozen orjson throughput workloads.

Command-driven protocol: the trusted evaluator parent writes one JSON command
per line on stdin and reads one JSON reply per line from stdout. All elapsed
time is measured by the parent around each `run` command, so no clock read
inside this candidate-linked process is ever trusted. Every timed iteration
operates on content-distinct input (a per-iteration tag folded into the
argument for dumps, a per-iteration wrapper document for loads), so replaying
a cached result for a repeated argument cannot satisfy the protocol; the
digest returned for each run comes from a final pristine invocation and is
checked by the parent against the frozen expected hash.
"""
from __future__ import annotations

import base64
import dataclasses
import datetime as dt
import gc
import hashlib
import json
import os
import sys
from typing import Any, Callable

import numpy as np

SITE = os.environ["ORJSON_SITE"]
sys.path.insert(0, SITE)
import orjson  # noqa: E402

MUTATION_KEY = "\x00hone-rotation"


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


def make_mutator(value: Any) -> tuple[Callable[[str], None], Callable[[], None]]:
    """Small, size-neutral apply/undo pair that makes the argument content
    distinct for every timed iteration without disturbing the pristine value."""
    if isinstance(value, Envelope):
        original = value.source

        def apply(tag: str) -> None:
            value.source = f"{original}:{tag}"

        def undo() -> None:
            value.source = original

        return apply, undo
    if isinstance(value, dict):
        def apply(tag: str) -> None:
            value[MUTATION_KEY] = tag

        def undo() -> None:
            del value[MUTATION_KEY]

        return apply, undo
    if isinstance(value, list):
        def apply(tag: str) -> None:
            value.append(tag)

        def undo() -> None:
            value.pop()

        return apply, undo
    raise ValueError(f"unsupported workload container: {type(value).__name__}")


class CaseState:
    __slots__ = ("case", "operation", "option", "argument", "apply", "undo")

    def __init__(self, case: dict[str, Any]) -> None:
        self.case = case
        self.operation = case["operation"]
        self.option = option_for(case["kind"])
        if self.operation not in ("dumps", "loads"):
            raise ValueError(f"unknown operation: {self.operation}")
        self.argument: Any = None
        self.apply: Callable[[str], None] | None = None
        self.undo: Callable[[], None] | None = None
        self.refresh()

    def refresh(self) -> None:
        """Rebuild the argument so every sample uses an identity-distinct input.
        References to the previous argument are dropped FIRST so the rebuild
        never holds two copies of a large workload at once (peak-RSS neutral
        with the original single-argument protocol)."""
        self.argument = None
        self.apply = None
        self.undo = None
        if self.operation == "dumps":
            self.argument = make_value(self.case)
            self.apply, self.undo = make_mutator(self.argument)
        else:
            # base64.b64decode always allocates a fresh buffer, so successive
            # samples are identity-distinct without an extra copy.
            self.argument = base64.b64decode(self.case["inputB64"])

    def run(self, iterations: int, nonce: int) -> str:
        if iterations < 1:
            raise ValueError("iterations must be positive")
        if self.operation == "dumps":
            argument = self.argument
            option = self.option
            apply = self.apply
            undo = self.undo
            assert apply is not None and undo is not None
            for index in range(iterations - 1):
                apply(f"{nonce}:{index}")
                orjson.dumps(argument, option=option)
                undo()
            result = orjson.dumps(argument, option=option)
            return result_hash("dumps", result)
        base = self.argument
        prefix = b"[%d," % nonce
        for index in range(iterations - 1):
            orjson.loads(b"%s%d,%s]" % (prefix, index, base))
        result = orjson.loads(base)
        return result_hash("loads", result)


def main() -> None:
    if hasattr(gc, "freeze"):
        gc.freeze()
    gc.collect()
    gc.disable()
    states: dict[str, CaseState] = {}
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
            state = CaseState(case)
            state.run(12, 0)
            states[case["id"]] = state
            reply: dict[str, Any] = {"op": "setup", "id": case["id"]}
        elif op == "refresh":
            case_id = command["id"]
            states[case_id].refresh()
            reply = {"op": "refresh", "id": case_id}
        elif op == "run":
            case_id = command["id"]
            digest = states[case_id].run(int(command["iterations"]), int(command["nonce"]))
            reply = {"op": "run", "id": case_id, "resultSha256": digest}
        elif op == "teardown":
            case_id = command["id"]
            del states[case_id]
            gc.collect()
            reply = {"op": "teardown", "id": case_id}
        else:
            raise ValueError(f"unknown command: {op}")
        out.write(json.dumps(reply, separators=(",", ":")))
        out.write("\n")
        out.flush()


if __name__ == "__main__":
    main()
