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
import enum
import hashlib
import json
import uuid
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


# ---------------------------------------------------------------------------
# Broad, trusted-side correctness gate (round-6 EXEC-BOUNDARY).
#
# The correctness verdict is produced ENTIRELY trusted-side and never trusts any
# artifact a candidate-linked process authors. For each frozen case the trusted
# parent (importing the PRISTINE reference orjson) and the candidate-linked
# worker each run ``apply_correctness`` over the SAME ``(case, nonce)``. The
# worker returns ONLY a digest of the real serializer output (success) or the
# raised exception's class name (error) across the subprocess boundary; the
# parent independently reproduces the reference outcome and compares. The
# candidate therefore cannot author the pass/fail decision, and a fresh
# per-case nonce is folded into every input so no output is a constant a
# candidate could hardcode for a fixed input (defeats input special-casing).
# ``apply_correctness`` never assumes an outcome: it try/excepts uniformly and
# reports ok-or-error, so the reference — not a hand-written expectation — is
# the sole oracle for both the produced bytes and the raise/no-raise boundary.
# ---------------------------------------------------------------------------


class Palette(enum.Enum):
    RED = 1
    GREEN = "green"
    BLUE = 3.5


class _SubDict(dict):
    pass


class _SubList(list):
    pass


class _SubStr(str):
    pass


class _SubInt(int):
    pass


_ESCAPE_STRESS = (
    '"\\/\b\f\n\r\t\x00\x01\x1f\x7f'
    "ascii-middle 東京 🙂🚀 naïve café Здравствуй مرحبا हिन्दी </script>"
    "\u2028\u2029\ud7ff\ue000"
)


def _nonce_str(nonce: int) -> str:
    return f"n{nonce:016x}"


def _build_dumps_value(orjson: Any, family: str, params: dict[str, Any], nonce: int) -> Any:
    """Deterministically build the dumps argument for a case. Identical shared
    code runs in the candidate worker and the trusted parent, so the only
    difference between the two runs is which orjson performs the serialization.
    Every value folds ``nonce`` in so the exact output bytes are unpredictable."""
    tag = _nonce_str(nonce)
    if family == "primitives":
        return {
            "null": None,
            "true": True,
            "false": False,
            "zero": 0,
            "neg": -(nonce & 0x7FFF_FFFF),
            "pos": nonce & 0xFFFF_FFFF,
            "i64max": 9223372036854775807,
            "i64min": -9223372036854775808,
            "u64max": 18446744073709551615,
            "floats": [0.0, -0.0, 1.5, -2.25, 1e308, 1e-308, 3.141592653589793,
                       (nonce % 1000) / 7.0, 2.2250738585072014e-308],
            "text": f"payload-{tag}",
            "list": [1, 2, 3, nonce & 0xFF, [], {}],
            "empty_dict": {},
            "empty_list": [],
        }
    if family == "unicode":
        return {
            "stress": f"{_ESCAPE_STRESS}:{tag}",
            "keys東京": f"value-{tag}",
            "arr": [f"{_ESCAPE_STRESS[i % len(_ESCAPE_STRESS)]}{tag}" for i in range(8)],
        }
    if family == "big_ints":
        base = 1 << 63
        return [base - 1, base, (1 << 64) - 1, (1 << 64) - 1 - (nonce & 0xFF),
                -(1 << 63), -(nonce & 0x7FFF_FFFF_FFFF_FFFF)]
    if family == "nested_deep":
        depth = int(params.get("depth", 40))
        node: Any = {"leaf": tag, "n": nonce & 0xFFFF}
        for i in range(depth):
            node = {"child": node, "i": i} if i & 1 else [node, i]
        return node
    if family == "datetime":
        size = int(params.get("size", 6))
        return [
            {
                "aware": dt.datetime(
                    2020 + (i % 6), 1 + (i % 12), 1 + (i % 27),
                    i % 24, (i * 7) % 60, (i * 13) % 60,
                    (nonce + i * 9973) % 1_000_000,
                    tzinfo=dt.timezone(dt.timedelta(minutes=((i % 17) - 8) * 15)),
                ),
                "naive": dt.datetime(2021, 6, 15, 12, 30, 45, (nonce + i) % 1_000_000),
                "date": dt.date(2020 + (i % 6), 1 + (i % 12), 1 + (i % 27)),
                "time": dt.time(i % 24, (i * 7) % 60, (i * 13) % 60, (nonce + i) % 1_000_000),
                "id": (nonce + i) & 0xFFFF_FFFF,
            }
            for i in range(size)
        ]
    if family == "uuid":
        return [uuid.UUID(int=((nonce << 32) ^ (i * 0x9E3779B97F4A7C15)) & ((1 << 128) - 1))
                for i in range(6)]
    if family == "enum":
        return {"members": [Palette.RED, Palette.GREEN, Palette.BLUE], "salt": nonce & 0xFFFF}
    if family == "dataclass":
        return make_value({"kind": "dataclass", "size": int(params.get("size", 12)),
                           "salt": nonce & 0xFFFF})
    if family == "numpy":
        size = int(params.get("size", 64))
        salt = nonce & 0xFFFF
        i8 = np.array([((salt + i) % 200) - 100 for i in range(size)], dtype=np.int8)
        i16 = np.array([((salt + i) % 60000) - 30000 for i in range(size)], dtype=np.int16)
        i32 = np.array([((salt * 7 + i) % 2_000_000) - 1_000_000 for i in range(size)],
                       dtype=np.int32).reshape((-1, 8))
        i64 = np.array([salt * 1_000_003 + i for i in range(size)],
                       dtype=np.int64).reshape((-1, 8))
        u8 = np.array([(salt + i) % 250 for i in range(size)], dtype=np.uint8)
        u32 = np.array([(salt * 3 + i) % 4_000_000 for i in range(size)], dtype=np.uint32)
        u64 = np.array([salt * 1_000_003 + i for i in range(size)], dtype=np.uint64)
        f32 = np.array([((salt % 97) + i) / 7.0 for i in range(size)],
                       dtype=np.float32).reshape((-1, 8))
        f64 = np.array([((salt % 997) + i) * -3.25 for i in range(size)],
                       dtype=np.float64).reshape((-1, 8))
        b = np.array([(i + salt) & 1 == 0 for i in range(size)], dtype=np.bool_)
        return {
            "i8": i8, "i16": i16, "i32": i32, "i64": i64,
            "u8": u8, "u32": u32, "u64": u64,
            "f32": f32, "f64": f64, "b": b,
            "scalar_bool": np.bool_((salt & 1) == 0),
        }
    if family == "fragment":
        inner = orjson.dumps({"pre": f"serialized-{tag}", "n": nonce & 0xFFFF, "arr": [1, 2, 3]})
        return {"wrapped": orjson.Fragment(inner), "plain": nonce & 0xFF}
    if family == "non_str_keys":
        key_dt = dt.datetime(2022, 1, 1, tzinfo=dt.timezone.utc)
        return {
            1: "int-key",
            -5: nonce & 0xFF,
            3.5: "float-key",
            True: "bool-key",
            key_dt: "dt-key",
            uuid.UUID(int=nonce & ((1 << 128) - 1)): "uuid-key",
            f"str-{tag}": "str-key",
        }
    if family == "subclass":
        d = _SubDict({"sub": True, "n": nonce & 0xFF})
        lst = _SubList([1, 2, _SubStr(f"s-{tag}"), _SubInt(nonce & 0xFFFF)])
        return {"dict": d, "list": lst, "str": _SubStr(tag), "int": _SubInt(nonce & 0x7FFF)}
    if family == "default_callback":
        return {"custom": _Uncanned(nonce), "n": nonce & 0xFF}
    if family == "err_bare_object":
        return {"bad": object(), "n": nonce & 0xFF}
    if family == "err_circular":
        loop: list[Any] = [nonce & 0xFF]
        loop.append(loop)
        return loop
    if family == "err_non_str_key_no_opt":
        # Same non-str-key value but WITHOUT OPT_NON_STR_KEYS -> reference raises.
        return {1: "int-key", 2.0: nonce & 0xFF}
    raise ValueError(f"unknown dumps correctness family: {family}")


class _Uncanned:
    """A type orjson cannot serialize natively; only a ``default`` hook can."""

    __slots__ = ("nonce",)

    def __init__(self, nonce: int) -> None:
        self.nonce = nonce


def _default_hook(obj: Any) -> Any:
    if isinstance(obj, _Uncanned):
        return {"__uncanned__": obj.nonce & 0xFFFF, "tag": _nonce_str(obj.nonce)}
    raise TypeError(f"cannot serialize {type(obj).__name__}")


def _build_loads_input(family: str, params: dict[str, Any], nonce: int) -> bytes:
    tag = _nonce_str(nonce)
    if family == "loads_object":
        return json.dumps({
            "id": nonce & 0xFFFF_FFFF, "name": f"obj-{tag}", "flag": True,
            "nil": None, "nested": {"a": [1, 2, 3], "b": {"c": nonce & 0xFF}},
            "unicode": "東京🙂 café", "escapes": "line1\nline2\t\"quote\"\\slash",
        }).encode("utf-8")
    if family == "loads_array":
        return json.dumps([nonce & 0xFF, [1, [2, [3, [4]]]], {"k": tag}, [], {}]).encode("utf-8")
    if family == "loads_numbers":
        return (
            b'[0,-0,1,-1,%d,1.5,-2.25,1e10,1E-10,3.141592653589793,'
            b'9223372036854775807,-9223372036854775808,1.7976931348623157e308,'
            b'2.2250738585072014e-308,%d.5]' % (nonce & 0xFFFF_FFFF, nonce & 0xFF)
        )
    if family == "loads_unicode":
        return json.dumps(
            {"s": f"{_ESCAPE_STRESS[:20]}{tag}", "u": "\u0000\u001f\u2028\uffff"}
        ).encode("utf-8")
    if family == "loads_deep":
        depth = int(params.get("depth", 60))
        return (b"[" * depth) + str(nonce & 0xFF).encode() + (b"]" * depth)
    if family == "loads_whitespace":
        return b'  \t\n {  "a" :\t[ 1 ,2\n, 3 ] , "b"  : %d }  \n' % (nonce & 0xFF)
    # --- malformed inputs (structural; reference decides raise/class) ---
    if family == "loads_truncated":
        return b'{"a": [1, 2, 3'
    if family == "loads_trailing":
        return b'{"a": 1} garbage'
    if family == "loads_bad_token":
        return b'{"a": nul}'
    if family == "loads_unterminated_str":
        return b'{"a": "unterminated'
    if family == "loads_bad_escape":
        return b'{"a": "bad\\xescape"}'
    if family == "loads_lone_surrogate":
        return b'"\\ud800"'
    if family == "loads_empty":
        return b""
    if family == "loads_depth_bomb":
        return (b"[" * 4096) + (b"]" * 4096)
    if family == "loads_invalid_utf8":
        return b'{"a": "\xff\xfe"}'
    if family == "loads_leading_zero":
        return b"0123"
    raise ValueError(f"unknown loads correctness family: {family}")


def _resolve_options(orjson: Any, names: list[str]) -> int:
    option = 0
    for name in names:
        option |= int(getattr(orjson, name))
    return option


def apply_correctness(orjson: Any, case: dict[str, Any], nonce: int) -> dict[str, Any]:
    """Run one correctness case with ``orjson`` and return a comparable result:
    ``{"kind": "ok", "digest": <sha256>}`` on success or
    ``{"kind": "err", "cls": <exception class name>}`` on any exception. The
    caller compares the candidate's result to the reference's; neither side is
    told the expected outcome, so the reference is the sole oracle."""
    op = case["op"]
    params = case.get("params", {})
    options = case.get("options", [])
    try:
        if op == "dumps":
            value = _build_dumps_value(orjson, case["family"], params, nonce)
            option = _resolve_options(orjson, options)
            kwargs: dict[str, Any] = {}
            if option:
                kwargs["option"] = option
            if case.get("default"):
                kwargs["default"] = _default_hook
            out = orjson.dumps(value, **kwargs)
            return {"kind": "ok", "digest": hashlib.sha256(bytes(out)).hexdigest()}
        if op == "loads":
            data = _build_loads_input(case["family"], params, nonce)
            result = orjson.loads(data)
            return {"kind": "ok", "digest": hashlib.sha256(canonical_bytes(result)).hexdigest()}
        raise ValueError(f"unknown correctness op: {op}")
    except Exception as exc:  # noqa: BLE001 - the exception CLASS is the signal
        return {"kind": "err", "cls": type(exc).__name__}


def correctness_cases() -> list[dict[str, Any]]:
    """Frozen, deterministic correctness corpus. Immutable (this module is not a
    candidate-mutable path), so the case set cannot be shrunk by the candidate."""
    cases: list[dict[str, Any]] = [
        {"id": "dumps-primitives", "op": "dumps", "family": "primitives"},
        {"id": "dumps-primitives-indent", "op": "dumps", "family": "primitives",
         "options": ["OPT_INDENT_2"]},
        {"id": "dumps-primitives-sort", "op": "dumps", "family": "primitives",
         "options": ["OPT_SORT_KEYS"]},
        {"id": "dumps-primitives-newline", "op": "dumps", "family": "primitives",
         "options": ["OPT_APPEND_NEWLINE"]},
        {"id": "dumps-primitives-combo", "op": "dumps", "family": "primitives",
         "options": ["OPT_INDENT_2", "OPT_SORT_KEYS", "OPT_APPEND_NEWLINE"]},
        {"id": "dumps-unicode", "op": "dumps", "family": "unicode"},
        {"id": "dumps-unicode-sort", "op": "dumps", "family": "unicode",
         "options": ["OPT_SORT_KEYS"]},
        {"id": "dumps-big-ints", "op": "dumps", "family": "big_ints"},
        {"id": "dumps-nested-deep", "op": "dumps", "family": "nested_deep",
         "params": {"depth": 40}},
        {"id": "dumps-datetime", "op": "dumps", "family": "datetime"},
        {"id": "dumps-datetime-naive-utc", "op": "dumps", "family": "datetime",
         "options": ["OPT_NAIVE_UTC"]},
        {"id": "dumps-datetime-utc-z", "op": "dumps", "family": "datetime",
         "options": ["OPT_UTC_Z"]},
        {"id": "dumps-datetime-omit-micro", "op": "dumps", "family": "datetime",
         "options": ["OPT_OMIT_MICROSECONDS"]},
        {"id": "dumps-uuid", "op": "dumps", "family": "uuid"},
        {"id": "dumps-enum", "op": "dumps", "family": "enum"},
        {"id": "dumps-dataclass", "op": "dumps", "family": "dataclass"},
        {"id": "dumps-dataclass-sort", "op": "dumps", "family": "dataclass",
         "options": ["OPT_SORT_KEYS"]},
        {"id": "dumps-numpy", "op": "dumps", "family": "numpy",
         "options": ["OPT_SERIALIZE_NUMPY"]},
        {"id": "dumps-numpy-indent", "op": "dumps", "family": "numpy",
         "options": ["OPT_SERIALIZE_NUMPY", "OPT_INDENT_2"]},
        {"id": "dumps-fragment", "op": "dumps", "family": "fragment"},
        {"id": "dumps-non-str-keys", "op": "dumps", "family": "non_str_keys",
         "options": ["OPT_NON_STR_KEYS"]},
        {"id": "dumps-non-str-keys-sort", "op": "dumps", "family": "non_str_keys",
         "options": ["OPT_NON_STR_KEYS", "OPT_SORT_KEYS"]},
        {"id": "dumps-subclass", "op": "dumps", "family": "subclass"},
        {"id": "dumps-default-callback", "op": "dumps", "family": "default_callback",
         "default": True},
        {"id": "dumps-err-bare-object", "op": "dumps", "family": "err_bare_object"},
        {"id": "dumps-err-circular", "op": "dumps", "family": "err_circular"},
        {"id": "dumps-err-non-str-key", "op": "dumps", "family": "err_non_str_key_no_opt"},
        {"id": "loads-object", "op": "loads", "family": "loads_object"},
        {"id": "loads-array", "op": "loads", "family": "loads_array"},
        {"id": "loads-numbers", "op": "loads", "family": "loads_numbers"},
        {"id": "loads-unicode", "op": "loads", "family": "loads_unicode"},
        {"id": "loads-deep", "op": "loads", "family": "loads_deep", "params": {"depth": 60}},
        {"id": "loads-whitespace", "op": "loads", "family": "loads_whitespace"},
        {"id": "loads-err-truncated", "op": "loads", "family": "loads_truncated"},
        {"id": "loads-err-trailing", "op": "loads", "family": "loads_trailing"},
        {"id": "loads-err-bad-token", "op": "loads", "family": "loads_bad_token"},
        {"id": "loads-err-unterminated", "op": "loads", "family": "loads_unterminated_str"},
        {"id": "loads-err-bad-escape", "op": "loads", "family": "loads_bad_escape"},
        {"id": "loads-err-lone-surrogate", "op": "loads", "family": "loads_lone_surrogate"},
        {"id": "loads-err-empty", "op": "loads", "family": "loads_empty"},
        {"id": "loads-err-depth-bomb", "op": "loads", "family": "loads_depth_bomb"},
        {"id": "loads-err-invalid-utf8", "op": "loads", "family": "loads_invalid_utf8"},
        {"id": "loads-err-leading-zero", "op": "loads", "family": "loads_leading_zero"},
    ]
    return cases
