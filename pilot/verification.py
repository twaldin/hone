from __future__ import annotations

import json
import os
import re
import selectors
import subprocess
import tempfile
import time
import uuid

from . import program
from .runtime import digest

PLAN_SECONDS = 10
WORKER_SECONDS = 10
MAX_DEPTH = 64
TYPE_NAMES = frozenset(("bool", "int", "float", "complex", "str", "bytes", "list", "tuple", "dict", "set", "frozenset"))
_INT = re.compile(r"-?0x[0-9a-f]+")
_PLANS: dict[str, str] = {}

_CODEC = f"_DEPTH = {MAX_DEPTH}\n" + r'''import json, os, sys
_type, _id, _object, _isinstance, _all, _any, _set = type, id, object, isinstance, all, any, set
_exec, _compile, _hex, _float_hex, _float_from_hex = exec, compile, hex, float.hex, float.fromhex
_new, _setattr, _getattribute = object.__new__, object.__setattr__, object.__getattribute__
_loads, _dumps, _write, _exit = json.loads, json.dumps, os.write, os._exit
_VALUES = ((type(None), "none"), (bool, "bool"), (int, "int"), (float, "float"), (complex, "complex"),
           (str, "str"), (bytes, "bytes"), (list, "list"), (tuple, "tuple"), (dict, "dict"),
           (set, "set"), (frozenset, "frozenset"))
_CLASSES = {tag: known for known, tag in _VALUES}
_HEAP_TYPE = 1 << 9


class Unsupported(Exception):
    pass


def _tag(value):
    cls = _type(value)
    for known, tag in _VALUES:
        if cls is known:
            return tag
    if cls is _type:
        return "type"
    mro = cls.__mro__
    if mro[-1] is _object and cls.__dictoffset__ and _all(base.__flags__ & _HEAP_TYPE for base in mro[:-1]):
        return "object"
    raise Unsupported("unsupported " + cls.__name__ + " value")


def _finite(number):
    if number != number:
        raise Unsupported("NaN value")
    return _float_hex(number)


def encode(value, seen, active, depth=0):
    if depth > _DEPTH:
        raise Unsupported("value nesting exceeds limit")
    tag = _tag(value)
    if tag == "none":
        return {"t": tag}
    if tag == "type":
        for known, name in _VALUES[1:]:
            if value is known:
                return {"t": tag, "v": name}
        raise Unsupported("unsupported type value")
    if tag in ("bool", "str"):
        return {"t": tag, "v": value}
    if tag == "int":
        return {"t": tag, "v": _hex(value)}
    if tag == "float":
        return {"t": tag, "v": _finite(value)}
    if tag == "complex":
        return {"t": tag, "v": [_finite(value.real), _finite(value.imag)]}
    if tag == "bytes":
        return {"t": tag, "v": value.hex()}
    key = _id(value)
    if key in active:
        raise Unsupported("cyclic value")
    if seen is not None and tag in ("list", "dict", "set", "object"):
        if key in seen:
            raise Unsupported("shared mutable argument")
        seen.add(key)
    active.add(key)
    if tag == "object":
        fields = _getattribute(value, "__dict__")
        if _type(fields) is not _CLASSES["dict"] or _any(_type(name) is not _CLASSES["str"] for name in fields):
            raise Unsupported("object without plain instance fields")
        tree = {"t": tag, "class": _type(value).__name__,
                "fields": {name: encode(item, seen, active, depth + 1) for name, item in fields.items()}}
    elif tag == "dict":
        tree = {"t": tag, "v": [[encode(name, seen, active, depth + 1), encode(item, seen, active, depth + 1)]
                                for name, item in value.items()]}
    else:
        tree = {"t": tag, "v": [encode(item, seen, active, depth + 1) for item in value]}
    active.discard(key)
    return tree


def decode(tree, resolve):
    tag, value = tree["t"], tree.get("v")
    if tag == "none":
        return None
    if tag in ("bool", "str"):
        return value
    if tag == "int":
        return _CLASSES["int"](value, 16)
    if tag == "float":
        return _float_from_hex(value)
    if tag == "complex":
        return _CLASSES["complex"](_float_from_hex(value[0]), _float_from_hex(value[1]))
    if tag == "bytes":
        return _CLASSES["bytes"].fromhex(value)
    if tag == "type":
        return _CLASSES[value]
    if tag == "object":
        instance = _new(resolve(tree["class"]))
        for name, item in tree["fields"].items():
            _setattr(instance, name, decode(item, resolve))
        return instance
    if tag == "dict":
        return {decode(name, resolve): decode(item, resolve) for name, item in value}
    return _CLASSES[tag](decode(item, resolve) for item in value)


def _private_stdout():
    out = os.dup(1)
    null = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null, 1)
    os.dup2(null, 2)
    return out


def _emit(fd, value):
    data = (_dumps(value) + "\n").encode()
    while data:
        data = data[_write(fd, data):]
    _exit(0)
'''

_PLANNER = r'''
import ast, types
os.nice(10)
_row = _loads(sys.stdin.read())
_out = _private_stdout()


def _official(action):
    try:
        return action()
    except Exception as error:
        raise Unsupported("official code raised " + type(error).__name__) from None


def _shape(source):
    body = _official(lambda: ast.parse(source).body)
    if len(body) != 1 or not isinstance(body[0], ast.Assert) or body[0].msg is not None:
        raise Unsupported("not one plain assert")
    test = body[0].test
    if not isinstance(test, ast.Compare) or len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        raise Unsupported("not one equality")
    call, wrapper = test.left, None
    if (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "int"
            and len(call.args) == 1 and not call.keywords):
        call, wrapper = call.args[0], "int"
    if (not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.keywords
            or any(isinstance(arg, ast.Starred) for arg in call.args)):
        raise Unsupported("left side is not a positional function call")
    return call.func.id, call.args, wrapper, test.comparators[0]


def _evaluate(node, scope):
    return _official(lambda: eval(compile(ast.Expression(node), "official-assertion", "eval"), scope))


try:
    shapes = []
    for index, source in enumerate(_row["tests"]):
        where = "assertion " + str(index)
        shapes.append(_shape(source))
    scope = {"__name__": "__main__"}
    where = "official reference"
    _official(lambda: exec(compile(_row["reference"], "official-reference", "exec"), scope))
    where = "official setup"
    _official(lambda: exec(compile(_row["setup"], "official-setup", "exec"), scope))
    seen, retained_arguments, calls = set(), [], []
    for index, (function, args, wrapper, expected) in enumerate(shapes):
        where = "assertion " + str(index)
        if type(scope.get(function)) is not types.FunctionType:
            raise Unsupported("target is not an official reference function")
        values = [_evaluate(arg, scope) for arg in args]
        retained_arguments.append(values)
        calls.append({"function": function, "args": [encode(value, seen, set()) for value in values],
                      "wrapper": wrapper, "expected": encode(_evaluate(expected, scope), None, set())})
except Unsupported as error:
    _emit(_out, {"gradeable": False, "reason": where + ": " + str(error), "calls": []})
_emit(_out, {"gradeable": True, "reason": None, "calls": calls})
'''

_WORKER = r'''
os.nice(10)
_payload = _loads(sys.stdin.read())
_out = _private_stdout()
_scope = {"__name__": "__main__"}
_plain = {}


def _resolve(name):
    found = _scope.get(name)
    if _isinstance(found, _type):
        return found
    if name not in _plain:
        _plain[name] = _type(name, (), {})
    return _plain[name]


_exec(_compile(_payload["code"], "solution", "exec"), _scope)
_results = []
for _call in _payload["calls"]:
    _value = _scope[_call["function"]](*[decode(arg, _resolve) for arg in _call["args"]])
    _results.append(encode(_value, None, _set()))
_emit(_out, {"results": _results})
'''

_WRAPPER = r'''
os.nice(10)
_payload = _loads(sys.stdin.read())
_out = _private_stdout()
_results = []
for _value, _wrapper in zip(_payload["results"], _payload["wrappers"]):
    if _wrapper == "int":
        if _value["t"] not in ("bool", "int", "float", "str", "bytes"):
            raise Unsupported("Official int wrapper requires a plain builtin value")
        _value = encode(_CLASSES["int"](decode(_value, None)), None, set())
    _results.append(_value)
_emit(_out, {"results": _results})
'''


def _run(prefix: str, script: str, payload: bytes, seconds: float) -> tuple[int, bytes] | None:
    name = prefix + uuid.uuid4().hex
    with tempfile.TemporaryFile() as inputs:
        inputs.write(payload)
        inputs.seek(0)
        process = subprocess.Popen(program.docker_command(name) + ["-c", script], stdin=inputs,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        selector = selectors.DefaultSelector()
        assert process.stdout is not None and process.stderr is not None
        selector.register(process.stdout, selectors.EVENT_READ)
        selector.register(process.stderr, selectors.EVENT_READ)
        deadline = time.monotonic() + seconds
        received = 0
        stdout = bytearray()
        try:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                events = selector.select(remaining)
                if not events:
                    return None
                for key, _ in events:
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    received += len(chunk)
                    if received > program.MAX_WIRE_BYTES:
                        return None
                    if key.fileobj is process.stdout:
                        stdout.extend(chunk)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            return process.wait(timeout=remaining), bytes(stdout)
        except (OSError, subprocess.TimeoutExpired):
            return None
        finally:
            selector.close()
            program._remove(name, process)


def _frame(stdout: bytes) -> dict:
    if stdout.count(b"\n") != 1 or not stdout.endswith(b"\n"):
        raise ValueError("Expected exactly one result line")
    value = json.loads(stdout)
    if type(value) is not dict:
        raise ValueError("Result frame must be an object")
    return value


def _float(text: str) -> str:
    number = float.fromhex(text)
    if number != number:
        raise ValueError("NaN is not comparable")
    # Python equality treats -0.0 and 0.0 as the same float value.
    return (number or 0.0).hex()


def _canonical(tree: object, depth: int = 0) -> list:
    if depth > MAX_DEPTH or type(tree) is not dict:
        raise ValueError("Malformed tagged value")
    tag = tree.get("t")
    if tag == "none" and set(tree) == {"t"}:
        return ["none"]
    if tag == "object" and set(tree) == {"t", "class", "fields"}:
        fields = tree["fields"]
        if type(tree["class"]) is str and type(fields) is dict:
            return ["object", tree["class"], sorted([name, _canonical(item, depth + 1)] for name, item in fields.items())]
    if set(tree) != {"t", "v"}:
        raise ValueError("Malformed tagged value")
    value = tree["v"]
    if type(value) is bool and tag == "bool":
        return [tag, value]
    if type(value) is str:
        if tag == "str":
            return [tag, value]
        if tag == "int" and _INT.fullmatch(value):
            return [tag, hex(int(value, 16))]
        if tag == "float":
            return [tag, _float(value)]
        if tag == "bytes":
            return [tag, bytes.fromhex(value).hex()]
        if tag == "type" and value in TYPE_NAMES:
            return [tag, value]
    if type(value) is list:
        if tag == "complex" and len(value) == 2 and all(type(part) is str for part in value):
            return [tag, _float(value[0]), _float(value[1])]
        if tag in ("list", "tuple"):
            return [tag, [_canonical(item, depth + 1) for item in value]]
        if tag in ("set", "frozenset"):
            return [tag, sorted((_canonical(item, depth + 1) for item in value), key=json.dumps)]
        if tag == "dict" and all(type(pair) is list and len(pair) == 2 for pair in value):
            return [tag, sorted(([_canonical(name, depth + 1), _canonical(item, depth + 1)] for name, item in value),
                                key=json.dumps)]
    raise ValueError("Malformed tagged value")




def _plan(stdout: bytes, count: int) -> dict:
    plan = _frame(stdout)
    if set(plan) != {"gradeable", "reason", "calls"}:
        raise ValueError("Malformed plan")
    if plan["gradeable"] is False and type(plan["reason"]) is str and plan["calls"] == []:
        return plan
    calls = plan["calls"]
    if plan["gradeable"] is not True or plan["reason"] is not None or type(calls) is not list or len(calls) != count:
        raise ValueError("Malformed plan")
    for call in calls:
        if (type(call) is not dict or set(call) != {"function", "args", "wrapper", "expected"}
                or type(call["function"]) is not str or call["wrapper"] not in (None, "int") or type(call["args"]) is not list):
            raise ValueError("Malformed planned call")
        for value in [*call["args"], call["expected"]]:
            _canonical(value)
    return plan


def plan_digest(plan: dict) -> str:
    calls = [{"function": call["function"], "args": [_canonical(arg) for arg in call["args"]],
              "wrapper": call["wrapper"], "expected": _canonical(call["expected"])}
             for call in plan["calls"]]
    return digest({"gradeable": plan["gradeable"], "reason": plan["reason"], "calls": calls})


def prepare_plan(reference_code: str, setup: str, tests: list[str]) -> dict:
    row = {"reference": reference_code, "setup": setup, "tests": tests}
    key = digest(row)
    if key not in _PLANS:
        finished = _run("hone-pilot-plan-", _CODEC + _PLANNER, json.dumps(row).encode(), PLAN_SECONDS)
        if finished is None or finished[0] != 0:
            raise RuntimeError("Trusted MBPP planning invocation failed")
        try:
            plan = _plan(finished[1], len(tests))
        except (ValueError, TypeError, OverflowError, RecursionError) as error:
            raise RuntimeError("Trusted MBPP planning returned an invalid plan") from error
        _PLANS[key] = json.dumps(plan)
    return json.loads(_PLANS[key])


def score_solution(output: str, reference_code: str, setup: str, tests: list[str]) -> float:
    if len(output.encode()) > program.MAX_WIRE_BYTES:
        return 0.0
    plan = prepare_plan(reference_code, setup, tests)
    if not plan["gradeable"]:
        return 0.0
    calls = plan["calls"]
    payload = {"code": program.extract_solution(output),
               "calls": [{"function": call["function"], "args": call["args"]} for call in calls]}
    finished = _run("hone-pilot-score-", _CODEC + _WORKER, json.dumps(payload).encode(), WORKER_SECONDS)
    if finished is None or finished[0] != 0:
        return 0.0
    try:
        frame = _frame(finished[1])
        if set(frame) != {"results"} or type(frame["results"]) is not list or len(frame["results"]) != len(calls):
            return 0.0
        for result in frame["results"]:
            _canonical(result)
        if any(call["wrapper"] for call in calls):
            wrapped = _run("hone-pilot-wrapper-", _CODEC + _WRAPPER,
                           json.dumps({"results": frame["results"], "wrappers": [call["wrapper"] for call in calls]}).encode(),
                           PLAN_SECONDS)
            if wrapped is None or wrapped[0] != 0:
                return 0.0
            frame = _frame(wrapped[1])
            if set(frame) != {"results"} or type(frame["results"]) is not list or len(frame["results"]) != len(calls):
                return 0.0
        for call, result in zip(calls, frame["results"]):
            actual = _canonical(result)
            if actual != _canonical(call["expected"]):
                return 0.0
    except (ValueError, TypeError, OverflowError, RecursionError):
        return 0.0
    return 1.0
