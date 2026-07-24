#!/usr/bin/env python3
"""Trusted, serializer-agnostic workload generation for OSS-T08.

This module holds every bit of workload construction and per-iteration input
derivation shared by TWO callers:

  * ``benchmark_worker.py`` — the candidate-linked worker: it imports the
    CANDIDATE ``orjson`` build and passes that module into the functions here.
  * ``eval.py`` — the trusted evaluator parent: it imports the PRISTINE
    system ``orjson`` (built from the frozen baseline at image time, never the
    candidate overlay) and runs the exact same derivations to produce a
    reference digest for every timed run.

Because the generation is identical and deterministic given ``(case, nonce)``,
the parent can independently reproduce the reference result-chain for the same
inputs the candidate just processed. That closes the round-2 seam where only a
single FINAL invocation was validated: the timed body used per-iteration
marker-tagged inputs whose results were discarded, so a worker could skip the
expensive stage on every non-final call. Here every timed iteration feeds a
data-dependent chain (iteration ``i``'s input is perturbed by iteration
``i-1``'s output), so the final digest depends on the real serializer output of
EVERY iteration — no iteration can be skipped, cached-constant, or shortcut —
and the parent validates that digest against a pristine reference over
per-run-unpredictable inputs.

NOTE: this module NEVER imports ``orjson`` itself; the serializer is always an
explicit argument, so the trusted parent that imports this module never links
the candidate extension.
"""
from __future__ import annotations

import base64
import dataclasses
import datetime as dt
import hashlib
import json
from typing import Any

import numpy as np

MUTATION_KEY = "\x00hone-rotation"
_MASK = (1 << 32) - 1


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


def option_for(orjson: Any, kind: str) -> int:
    return orjson.OPT_SERIALIZE_NUMPY if kind == "numpy" else 0


def canonical_bytes(result: Any) -> bytes:
    """Serializer-independent canonical form of a parsed (loads) result."""
    return json.dumps(
        result,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


class Workload:
    """One frozen workload case, rebuilt fresh so each sample starts from a
    pristine argument with no state carried across samples."""

    __slots__ = ("case", "operation", "kind", "option_kind", "value", "base")

    def __init__(self, case: dict[str, Any]) -> None:
        self.case = case
        self.operation = case["operation"]
        self.kind = case["kind"]
        if self.operation not in ("dumps", "loads"):
            raise ValueError(f"unknown operation: {self.operation}")
        self.value: Any = None
        self.base: bytes | None = None
        self.build()

    def build(self) -> None:
        """(Re)build the pristine argument. Prior references are dropped FIRST
        so a rebuild never holds two copies of a large workload at once."""
        self.value = None
        self.base = None
        if self.operation == "dumps":
            self.value = make_value(self.case)
        else:
            self.base = base64.b64decode(self.case["inputB64"])

    # --- canonical (pristine, unmutated) digest: the byte-exact / semantic gate ---
    def canon(self, orjson: Any) -> str:
        if self.operation == "dumps":
            out = orjson.dumps(self.value, option=option_for(orjson, self.kind))
            return hashlib.sha256(bytes(out)).hexdigest()
        assert self.base is not None
        result = orjson.loads(self.base)
        return hashlib.sha256(canonical_bytes(result)).hexdigest()

    # --- per-iteration, spread, reversible mutation for the dumps argument ---
    def _apply(self, carry: int) -> list[tuple[Any, Any]]:
        value = self.value
        undo: list[tuple[Any, Any]] = []
        if isinstance(value, Envelope):
            undo.append(("env-source", value.source))
            value.source = f"{value.source}:{carry}"
            if value.events:
                idx = carry % len(value.events)
                undo.append((("env-seq", idx), value.events[idx].sequence))
                value.events[idx].sequence = value.events[idx].sequence ^ carry
        elif isinstance(value, dict):
            value[MUTATION_KEY] = carry
            undo.append(("dict-key", MUTATION_KEY))
        elif isinstance(value, list) and value:
            idx = carry % len(value)
            undo.append((("list-idx", idx), value[idx]))
            value[idx] = carry
            value.append(carry)
            undo.append(("list-tail", None))
        else:
            raise ValueError(f"unsupported dumps container: {type(value).__name__}")
        return undo

    def _undo(self, undo: list[tuple[Any, Any]]) -> None:
        value = self.value
        for key, old in reversed(undo):
            if key == "env-source":
                value.source = old
            elif isinstance(key, tuple) and key[0] == "env-seq":
                value.events[key[1]].sequence = old
            elif key == "dict-key":
                del value[old]
            elif isinstance(key, tuple) and key[0] == "list-idx":
                value[key[1]] = old
            elif key == "list-tail":
                value.pop()

    def _wrap(self, carry: int) -> bytes:
        assert self.base is not None
        # A fresh outer array forces a full parse of the base document every
        # iteration; the leading integer makes the parsed result carry-distinct.
        return b"[%d,%s]" % (carry, self.base)

    @staticmethod
    def _mix(out: bytes, carry: int, index: int) -> int:
        first = out[0] if out else 0
        last = out[-1] if out else 0
        return ((carry * 1_000_003) ^ first ^ (last << 8) ^ (len(out) & 0xFFFF) ^ index) & _MASK

    def chain(self, orjson: Any, iterations: int, nonce: int) -> str:
        """Run ``iterations`` real serializations in a data-dependent chain and
        return the digest of the FINAL output. Each iteration's input is
        perturbed by the previous iteration's real output, so the final digest
        depends on the serializer output of every iteration."""
        if iterations < 1:
            raise ValueError("iterations must be positive")
        carry = nonce & _MASK
        out = b""
        if self.operation == "dumps":
            option = option_for(orjson, self.kind)
            value = self.value
            for index in range(iterations):
                undo = self._apply(carry)
                out = orjson.dumps(value, option=option)
                self._undo(undo)
                carry = self._mix(out, carry, index)
        else:
            # Re-serialize the parsed result with the SAME serializer (C path,
            # no stdlib json in the hot loop) so the timed iteration stays
            # dominated by real parse+encode work. The chain therefore depends
            # on the candidate correctly loading AND encoding every iteration;
            # the pristine reference reproduces it byte-for-byte.
            for index in range(iterations):
                out = orjson.dumps(orjson.loads(self._wrap(carry)))
                carry = self._mix(out, carry, index)
        return hashlib.sha256(out).hexdigest()
