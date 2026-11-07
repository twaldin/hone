from __future__ import annotations

import json
import os
import re
import selectors
import subprocess
import tempfile
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

from . import program
from .runtime import IMAGE, append_json, current_call_scope, digest

PLAN_SECONDS = 10
WORKER_SECONDS = 10
SUPERVISOR_MARGIN_SECONDS = 5
MAX_DEPTH = 64
TYPE_NAMES = frozenset(("bool", "int", "float", "complex", "str", "bytes", "list", "tuple", "dict", "set", "frozenset"))
_INT = re.compile(r"-?0x[0-9a-f]+")
_PLANS: dict[str, str] = {}
_JOURNAL: ContextVar[tuple[Path | None, dict]] = ContextVar("grader_journal", default=(None, {}))
_INFRASTRUCTURE = frozenset(("timeout", "nonzero_exit", "frame_failure"))
_SOURCE_HASH = digest({"verification": Path(__file__).read_text(), "program": Path(program.__file__).read_text()})


class GraderInfrastructureError(RuntimeError):
    def __init__(self, receipt: dict):
        self.receipt = receipt
        super().__init__("Protected grader infrastructure failure: " + receipt["outcome"])


@contextmanager
def grader_journal(path: Path | None = None, **context):
    inherited_path, inherited = _JOURNAL.get()
    token = _JOURNAL.set((Path(path) if path is not None else inherited_path, {**inherited, **context}))
    try:
        yield
    finally:
        _JOURNAL.reset(token)


def grader_input_hash(output: str, reference_code: str, setup: str, tests: list[str]) -> str:
    return digest({"output": output, "reference_code": reference_code, "setup": setup, "tests": tests})


def _source_hash() -> str:
    return _SOURCE_HASH


def _limits(stage: str) -> tuple[float | None, float]:
    if stage == "worker":
        return WORKER_SECONDS, WORKER_SECONDS + SUPERVISOR_MARGIN_SECONDS
    return None, PLAN_SECONDS


def record_grader_outcome(outcome: str, score: float | None, *, invocations: list | None = None,
                          reason: str | None = None, input_hash: str | None = None) -> dict:
    path, context = _JOURNAL.get()
    receipt = {"event": "grader-outcome", "version": 1, "context": {**current_call_scope(), **context},
               "outcome": outcome, "score": score, "reason": reason, "invocations": invocations or [],
               "source_hash": _source_hash(), "image": os.environ.get("PILOT_PYTHON_IMAGE", IMAGE),
               "input_hash": input_hash or context.get("input_hash") or digest(current_call_scope())}
    receipt["receipt_hash"] = digest(receipt)
    validate_grader_receipt(receipt)
    if path is not None:
        append_json(path, receipt)
    return receipt


def validate_grader_receipt(receipt: dict) -> None:
    def hashed(value):
        return type(value) is str and re.fullmatch(r"sha256:[0-9a-f]{64}", value) is not None

    if type(receipt) is not dict:
        raise ValueError("Missing grader receipt")
    outcomes = {"pass": 1.0, "wrong_answer": 0.0, **dict.fromkeys(_INFRASTRUCTURE)}
    outcome = receipt.get("outcome")
    if (type(outcome) is not str or outcome not in outcomes or receipt.get("score") != outcomes[outcome]
            or type(receipt.get("score")) is bool or "score" not in receipt):
        raise ValueError("Inconsistent grader outcome/score")
    if (receipt.get("event") != "grader-outcome" or receipt.get("version") != 1
            or type(receipt.get("context")) is not dict
            or (receipt.get("reason") is not None and type(receipt["reason"]) is not str)
            or receipt.get("source_hash") != _source_hash() or not hashed(receipt.get("input_hash"))
            or type(receipt.get("image")) is not str
            or not re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[0-9a-f]{64}", receipt["image"])
            or receipt["image"] != os.environ.get("PILOT_PYTHON_IMAGE", IMAGE)
            or receipt.get("receipt_hash") != digest({k: v for k, v in receipt.items() if k != "receipt_hash"})):
        raise ValueError("Invalid grader provenance")
    context = receipt["context"]
    if "input_hash" in context and context["input_hash"] != receipt["input_hash"]:
        raise ValueError("Mismatched row input hash")
    if "original_output" in context:
        original = context["original_output"]
        if (type(original) is not dict or type(original.get("text")) is not str
                or type(original.get("bytes")) is not int or original["bytes"] < 0
                or type(original.get("truncated")) is not bool
                or len(original["text"].encode()) > program.MAX_WIRE_BYTES
                or original.get("hash") != context.get("output_hash")
                or not hashed(original.get("hash"))
                or original["truncated"] != (original["bytes"] > program.MAX_WIRE_BYTES)
                or (not original["truncated"] and (len(original["text"].encode()) != original["bytes"]
                                                  or digest(original["text"]) != original["hash"]))):
            raise ValueError("Invalid original output provenance")
    invocations = receipt.get("invocations")
    if type(invocations) is not list:
        raise ValueError("Missing grader invocations")
    for invocation in invocations:
        if type(invocation) is not dict:
            raise ValueError("Invalid invocation")
        try:
            if (type(invocation["stdout_hex"]) is not str or type(invocation["stderr_hex"]) is not str
                    or len(invocation["stdout_hex"]) + len(invocation["stderr_hex"]) > 2 * program.MAX_WIRE_BYTES):
                raise ValueError("Overlarge invocation receipt")
            stdout, stderr = bytes.fromhex(invocation["stdout_hex"]), bytes.fromhex(invocation["stderr_hex"])
            elapsed = invocation["elapsed_seconds"]
            valid = (type(elapsed) in (int, float) and 0 <= elapsed < float("inf")
                     and len(stdout) + len(stderr) <= program.MAX_WIRE_BYTES
                     and invocation["stdout_hash"] == digest(stdout.hex())
                     and invocation["stderr_hash"] == digest(stderr.hex())
                     and hashed(invocation["input_hash"]) and hashed(invocation["script_hash"])
                     and invocation["stage"] in ("planner", "worker", "wrapper")
                     and invocation["outcome"] in ("completed", *_INFRASTRUCTURE)
                     and (invocation["exit_code"] is None or type(invocation["exit_code"]) is int)
                     and (invocation["error"] is None or type(invocation["error"]) is str)
                     and (invocation["candidate_seconds"], invocation["deadline_seconds"]) == _limits(invocation["stage"]))
        except (KeyError, ValueError, TypeError):
            raise ValueError("Malformed invocation receipt") from None
        if not valid:
            raise ValueError("Invalid invocation provenance")
        if invocation["script_hash"] != digest(_STAGES[invocation["stage"]][1]):
            raise ValueError("Mismatched invocation source")
        status, exit_code = invocation["outcome"], invocation["exit_code"]
        if ((status == "completed" and (exit_code != 0 or invocation["error"] is not None))
                or (status == "nonzero_exit" and (exit_code is None or exit_code == 0))
                or (status in _INFRASTRUCTURE and not invocation["error"])):
            raise ValueError("Inconsistent invocation outcome")
    failures = [item for item in invocations if item["outcome"] in _INFRASTRUCTURE]
    if outcome in _INFRASTRUCTURE:
        if (len(failures) != 1 or invocations[-1] != failures[0]
                or failures[0]["outcome"] != outcome or receipt.get("reason") != failures[0]["error"]):
            raise ValueError("Missing infrastructure invocation")
    elif failures:
        raise ValueError("Scored infrastructure invocation")


@dataclass
class InvocationResult:
    stage: str
    outcome: str
    exit_code: int | None
    stdout: bytes
    stderr: bytes
    elapsed_seconds: float
    error: str | None
    input_hash: str
    script_hash: str

    def receipt(self) -> dict:
        candidate_seconds, deadline_seconds = _limits(self.stage)
        return {"stage": self.stage, "outcome": self.outcome, "exit_code": self.exit_code,
                "stdout_hex": self.stdout.hex(), "stderr_hex": self.stderr.hex(),
                "stdout_hash": digest(self.stdout.hex()), "stderr_hash": digest(self.stderr.hex()),
                "elapsed_seconds": self.elapsed_seconds, "error": self.error,
                "input_hash": self.input_hash, "script_hash": self.script_hash,
                "candidate_seconds": candidate_seconds, "deadline_seconds": deadline_seconds}


@dataclass(frozen=True)
class Verdict:
    """A trusted result frame; results None means the candidate failed and scores zero."""
    results: list | None
    failure: dict | None


def _raise_infrastructure(result: InvocationResult, invocations: list, input_hash: str):
    raise GraderInfrastructureError(record_grader_outcome(
        result.outcome, None, invocations=invocations, reason=result.error,
        input_hash=_JOURNAL.get()[1].get("input_hash", input_hash)))

_CODEC = f"_DEPTH = {MAX_DEPTH}\n_WIRE = {program.MAX_WIRE_BYTES}\n" + r'''import json, os, sys
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


def _send(fd, data, status):
    while data:
        data = data[_write(fd, data):]
    _exit(status)


def _emit(fd, value):
    _send(fd, (_dumps(value) + "\n").encode(), 0)
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
import select, signal, time
os.nice(10)
_payload = _loads(sys.stdin.read())
_seconds, _code = _payload["seconds"], _payload["code"]
_calls = [("call " + str(index), call["function"], call["args"]) for index, call in enumerate(_payload["calls"])]
for _where, _function, _args in _calls:
    for _arg in _args:
        decode(_arg, lambda name: _type(name, (), {}))
_out = _private_stdout()
_BaseException, _len, _type_name = BaseException, len, type.__dict__["__name__"].__get__


def _fail(fd, where, error):
    if _type(error) is Unsupported:
        where, detail = where + ": ", error.args[0]
    else:
        where, detail = where + " raised ", _type_name(_type(error))
    _emit(fd, {"failure": {"reason": where + (detail if _type(detail) is str else "?")[:120]}})


def _solve(fd):
    scope, plain = {"__name__": "__main__"}, {}

    def resolve(name):
        found = scope.get(name)
        if _isinstance(found, _type):
            return found
        if name not in plain:
            plain[name] = _type(name, (), {})
        return plain[name]

    try:
        _exec(_compile(_code, "solution", "exec"), scope)
    except _BaseException as error:
        _fail(fd, "solution", error)
    results = []
    for where, function, args in _calls:
        try:
            value = scope[function](*[decode(arg, resolve) for arg in args])
            results.append(encode(value, None, _set()))
        except _BaseException as error:
            _fail(fd, where, error)
    if _len(_dumps({"results": results})) >= _WIRE:
        _emit(fd, {"failure": {"reason": "results exceed the wire bound"}})
    _emit(fd, {"results": results})


def _kill(child):
    for kill in (os.killpg, os.kill):
        try:
            kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _supervise(child, reader, deadline):
    data, eof, exited = b"", False, False
    while not (eof and exited) and len(data) <= _WIRE:
        remaining = deadline - time.monotonic()
        if not exited and os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
            exited = True
            # Stray descendants must not hold the frame open.
            _kill(child)
        if remaining <= 0:
            return data if exited else None
        if eof:
            time.sleep(min(remaining, 0.01))
        elif select.select([reader], [], [], min(remaining, 0.01))[0]:
            chunk = os.read(reader, 65536)
            eof, data = not chunk, data + chunk
    return data


# As container init with no handlers, the supervisor cannot be signalled by the candidate.
signal.signal(signal.SIGINT, signal.SIG_IGN)
_reader, _writer = os.pipe()
_deadline = time.monotonic() + _seconds
_child = os.fork()
if _child == 0:
    os.setpgid(0, 0)
    signal.signal(signal.SIGINT, signal.default_int_handler)
    os.close(_reader)
    os.close(_out)
    _solve(_writer)
os.close(_writer)
_data = _supervise(_child, _reader, _deadline)
_kill(_child)
_status = os.waitpid(_child, 0)[1]
if _data is None:
    _emit(_out, {"failure": {"reason": "exceeded the " + str(_seconds) + " second time limit"}})
_send(_out, _data[:_WIRE + 1], os.WEXITSTATUS(_status) if os.WIFEXITED(_status) else 128 + os.WTERMSIG(_status))
'''

_WRAPPER = r'''
os.nice(10)
_payload = _loads(sys.stdin.read())
_out = _private_stdout()
_results = []
for _index, (_value, _wrapper) in enumerate(zip(_payload["results"], _payload["wrappers"])):
    if _wrapper == "int":
        _where = "call " + str(_index) + ": official int wrapper "
        if _value["t"] not in ("bool", "int", "float", "str", "bytes"):
            _emit(_out, {"failure": {"reason": _where + "received " + _value["t"]}})
        _plain = decode(_value, None)
        try:
            _value = _CLASSES["int"](_plain)
        except Exception as _error:
            _emit(_out, {"failure": {"reason": _where + "raised " + type(_error).__name__}})
        _value = encode(_value, None, set())
    _results.append(_value)
_emit(_out, {"results": _results})
'''

_STAGES = {"planner": ("hone-pilot-plan-", _CODEC + _PLANNER), "worker": ("hone-pilot-score-", _CODEC + _WORKER),
           "wrapper": ("hone-pilot-wrapper-", _CODEC + _WRAPPER)}


def _run(stage: str, payload: dict) -> InvocationResult:
    from .campaign import check_disk

    check_disk()
    prefix, script = _STAGES[stage]
    candidate_seconds, seconds = _limits(stage)
    data = json.dumps(payload if candidate_seconds is None else {**payload, "seconds": candidate_seconds}).encode()
    name = prefix + uuid.uuid4().hex
    started = time.monotonic()
    process = None
    selector = selectors.DefaultSelector()
    stdout, stderr = bytearray(), bytearray()
    outcome, error, exit_code = "completed", None, None
    try:
        with tempfile.TemporaryFile() as inputs:
            inputs.write(data)
            inputs.seek(0)
            process = subprocess.Popen(program.docker_command(name) + ["-c", script], stdin=inputs,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert process.stdout is not None and process.stderr is not None
        selector.register(process.stdout, selectors.EVENT_READ)
        selector.register(process.stderr, selectors.EVENT_READ)
        deadline = time.monotonic() + seconds
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("protected grader", seconds)
            events = selector.select(remaining)
            if not events:
                raise subprocess.TimeoutExpired("protected grader", seconds)
            for key, _ in events:
                chunk = os.read(key.fd, 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                available = program.MAX_WIRE_BYTES - len(stdout) - len(stderr)
                target = stdout if key.fileobj is process.stdout else stderr
                target.extend(chunk[:available])
                if len(chunk) > available:
                    outcome, error = "frame_failure", "Combined output exceeded wire bound"
                    break
            if error:
                break
        if error is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("protected grader", seconds)
            exit_code = process.wait(timeout=remaining)
            if exit_code != 0:
                outcome, error = "nonzero_exit", "Invocation exited nonzero"
    except subprocess.TimeoutExpired:
        outcome, error = "timeout", "Invocation exceeded deadline"
    except (OSError, RuntimeError) as exception:
        outcome, error = "frame_failure", "Invocation failed before a complete frame: " + type(exception).__name__
    finally:
        selector.close()
        if process is not None:
            try:
                program._remove(name, process)
            except (OSError, subprocess.TimeoutExpired) as exception:
                cleanup_error = "Owned invocation cleanup failed: " + type(exception).__name__
                if outcome == "completed":
                    outcome, error = "frame_failure", cleanup_error
                else:
                    error = str(error) + "; " + cleanup_error
            exit_code = process.returncode
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
    result = InvocationResult(stage, outcome, exit_code, bytes(stdout), bytes(stderr),
                              time.monotonic() - started, error, digest(data.hex()), digest(script))
    path, context = _JOURNAL.get()
    if path is not None:
        append_json(path, {"event": "grader-invocation", "context": {**current_call_scope(), **context},
                          "source_hash": _source_hash(), "image": os.environ.get("PILOT_PYTHON_IMAGE", IMAGE),
                          **result.receipt()})
    return result


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
        finished = _run("planner", row)
        if finished.outcome != "completed":
            _raise_infrastructure(finished, [finished.receipt()], key)
        try:
            plan = _plan(finished.stdout, len(tests))
        except (ValueError, TypeError, OverflowError, RecursionError):
            finished.outcome, finished.error = "frame_failure", "Planner returned an invalid plan"
            _raise_infrastructure(finished, [finished.receipt()], key)
        _PLANS[key] = json.dumps(plan)
    return json.loads(_PLANS[key])


def _results(result: InvocationResult, count: int, invocations: list, input_hash: str) -> Verdict:
    if result.outcome == "completed":
        try:
            frame = _frame(result.stdout)
            if set(frame) == {"failure"}:
                failure = frame["failure"]
                if type(failure) is not dict or set(failure) != {"reason"} or type(failure["reason"]) is not str:
                    raise ValueError("Malformed candidate failure")
                verdict = Verdict(None, failure)
            else:
                if set(frame) != {"results"} or type(frame["results"]) is not list or len(frame["results"]) != count:
                    raise ValueError("Malformed results")
                for value in frame["results"]:
                    _canonical(value)
                verdict = Verdict(frame["results"], None)
        except (ValueError, TypeError, OverflowError, RecursionError):
            result.outcome, result.error = "frame_failure", "Invocation returned an invalid result frame"
    invocations.append(result.receipt())
    if result.outcome != "completed":
        _raise_infrastructure(result, invocations, input_hash)
    return verdict


def score_solution(output: str, reference_code: str, setup: str, tests: list[str]) -> float:
    input_hash = grader_input_hash(output, reference_code, setup, tests)
    invocations = []
    encoded = output.encode()
    original_output = {"text": encoded[:program.MAX_WIRE_BYTES].decode("utf-8", errors="ignore"),
                       "bytes": len(encoded), "hash": digest(output),
                       "truncated": len(encoded) > program.MAX_WIRE_BYTES}
    with grader_journal(input_hash=input_hash, output_hash=digest(output), original_output=original_output):
        if len(output.encode()) > program.MAX_WIRE_BYTES:
            record_grader_outcome("wrong_answer", 0.0, reason="Source exceeded wire bound", input_hash=input_hash)
            return 0.0
        plan = prepare_plan(reference_code, setup, tests)
        if not plan["gradeable"]:
            record_grader_outcome("wrong_answer", 0.0, reason=plan["reason"], input_hash=input_hash)
            return 0.0
        calls = plan["calls"]
        payload = {"code": program.extract_solution(output),
                   "calls": [{"function": call["function"], "args": call["args"]} for call in calls]}
        verdict = _results(_run("worker", payload), len(calls), invocations, input_hash)
        if verdict.results is not None and any(call["wrapper"] for call in calls):
            verdict = _results(_run("wrapper", {"results": verdict.results,
                                                "wrappers": [call["wrapper"] for call in calls]}),
                               len(calls), invocations, input_hash)
        if verdict.results is None:
            record_grader_outcome("wrong_answer", 0.0, invocations=invocations,
                                  reason="Candidate failure: " + verdict.failure["reason"], input_hash=input_hash)
            return 0.0
        matched = all(_canonical(result) == _canonical(call["expected"])
                      for call, result in zip(calls, verdict.results))
        score = 1.0 if matched else 0.0
        record_grader_outcome("pass" if matched else "wrong_answer", score,
                              invocations=invocations, input_hash=input_hash)
        return score
