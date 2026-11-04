from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import struct
import tarfile

REVISION = "cbefbc1aa0f43dd39874ec4bf42211365dbda42e"
ARCHIVE_SHA256 = "0e1db10331bbbdd48701443b0690d5b7b8abef841a73b76882d26853b3f38dd7"
ARCHIVE_BYTES = 1_931_042_598
RUNS = {
    "ifbench": ("IFBench_IFBenchCoT2StageProgram_GEPA-MERGE_gpt-41-mini", "9e00d397cc6e51d39816467eb7d7fc9263b99fe6f1f4d4204aa003b7256bda62", {"generate_response_module": "prompt", "ensure_correct_response_module": "revision_prompt"}),
    "aime": ("AIMEBench_CoT_GEPA_gpt-41-mini", "e223aedd786122a6e67408bb7e374e259c054b1938419b1b21bdd6a0a1fe6d92", {"predict": "prompt"}),
    "hover": ("hoverBench_HoverMultiHop_GEPA-MERGE_gpt-41-mini", "b742b0680bfb1ddaee2ae6a045ea5b50eb9c540df3206ea4a3a1298c31658287", {"create_query_hop2": "query_hop2", "create_query_hop3": "query_hop3", "summarize1": "summarize1", "summarize2": "summarize2"}),
}


@dataclass(frozen=True)
class _Text:
    raw: bytes


@dataclass(eq=False)
class _Node:
    kind: str
    args: object
    state: object = None


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _parse(data: bytes):
    stack, memo = [], {}
    mark = object()
    pos = 0

    def take(n):
        nonlocal pos
        _require(n >= 0 and pos + n <= len(data), "Truncated pickle operand")
        value = data[pos:pos + n]
        pos += n
        return value

    def tail():
        index = len(stack) - 1
        while index >= 0 and stack[index] is not mark:
            index -= 1
        _require(index >= 0, "Missing pickle mark")
        result = stack[index + 1:]
        del stack[index:]
        return result

    while pos < len(data):
        op = take(1)
        if op == b"\x80":
            _require(take(1) in (b"\x04", b"\x05"), "Unsupported pickle protocol")
        elif op == b"\x95":
            _require(int.from_bytes(take(8), "little") <= len(data) - pos, "Invalid pickle frame")
        elif op in (b"\x8c", b"X", b"\x8d", b"C", b"B", b"\x8e"):
            width = {b"\x8c": 1, b"X": 4, b"\x8d": 8, b"C": 1, b"B": 4, b"\x8e": 8}[op]
            payload = take(int.from_bytes(take(width), "little"))
            stack.append(_Text(payload) if op in (b"\x8c", b"X", b"\x8d") else _Node("bytes", len(payload)))
        elif op == b"N":
            stack.append(None)
        elif op == b"\x88":
            stack.append(True)
        elif op == b"\x89":
            stack.append(False)
        elif op in (b"K", b"M", b"J"):
            stack.append(int.from_bytes(take({b"K": 1, b"M": 2, b"J": 4}[op]), "little", signed=op == b"J"))
        elif op in (b"\x8a", b"\x8b"):
            stack.append(int.from_bytes(take(int.from_bytes(take(1 if op == b"\x8a" else 4), "little")), "little", signed=True))
        elif op == b"G":
            stack.append(struct.unpack(">d", take(8))[0])
        elif op == b"(":
            stack.append(mark)
        elif op == b")":
            stack.append(())
        elif op == b"]":
            stack.append([])
        elif op == b"}":
            stack.append({})
        elif op == b"\x8f":
            stack.append(set())
        elif op == b"t":
            stack.append(tuple(tail()))
        elif op in (b"\x85", b"\x86", b"\x87"):
            n = {b"\x85": 1, b"\x86": 2, b"\x87": 3}[op]
            values = tuple(stack[-n:])
            del stack[-n:]
            stack.append(values)
        elif op == b"l":
            stack.append(tail())
        elif op == b"d":
            values = tail()
            stack.append(dict(zip(values[::2], values[1::2], strict=True)))
        elif op == b"a":
            value = stack.pop()
            stack[-1].append(value)
        elif op == b"e":
            values = tail()
            stack[-1].extend(values)
        elif op == b"s":
            value, key = stack.pop(), stack.pop()
            stack[-1][key] = value
        elif op == b"u":
            values = tail()
            stack[-1].update(zip(values[::2], values[1::2], strict=True))
        elif op == b"\x90":
            values = tail()
            stack[-1].update(values)
        elif op == b"\x91":
            stack.append(frozenset(tail()))
        elif op == b"\x94":
            memo[len(memo)] = stack[-1]
        elif op in (b"q", b"r"):
            memo[int.from_bytes(take(1 if op == b"q" else 4), "little")] = stack[-1]
        elif op in (b"h", b"j"):
            stack.append(memo[int.from_bytes(take(1 if op == b"h" else 4), "little")])
        elif op == b"\x93":
            name, module = stack.pop(), stack.pop()
            stack.append(_Node("global", (module, name)))
        elif op == b"c":
            start = pos
            while take(1) != b"\n":
                pass
            module = _Text(data[start:pos - 1])
            start = pos
            while take(1) != b"\n":
                pass
            stack.append(_Node("global", (module, _Text(data[start:pos - 1]))))
        elif op == b"R":
            args, fn = stack.pop(), stack.pop()
            if (isinstance(fn, _Node) and fn.kind == "global" and fn.args[0] == _Text(b"cloudpickle.cloudpickle")
                    and fn.args[1] in (_Text(b"_class_setstate"), _Text(b"_function_setstate"))):
                obj, state = args
                _require(isinstance(obj, _Node), "Invalid symbolic state target")
                obj.state = state
                stack.append(obj)
            else:
                stack.append(_Node("reduce", (fn, args)))
        elif op == b"\x81":
            args, cls = stack.pop(), stack.pop()
            stack.append(_Node("newobj", (cls, args)))
        elif op == b"\x92":
            kwargs, args, cls = stack.pop(), stack.pop(), stack.pop()
            stack.append(_Node("newobj_ex", (cls, args, kwargs)))
        elif op == b"b":
            state = stack.pop()
            _require(isinstance(stack[-1], _Node), "Invalid symbolic build target")
            stack[-1].state = state
        elif op == b"0":
            stack.pop()
        elif op == b"1":
            tail()
        elif op == b"2":
            stack.append(stack[-1])
        elif op == b".":
            _require(pos == len(data) and len(stack) == 1, "Invalid pickle termination")
            return stack[0]
        else:
            raise ValueError(f"Unsupported pickle opcode {op.hex()} at offset {pos - 1}")
    raise ValueError("No pickle termination")


def _attrs(node) -> dict:
    _require(isinstance(node, _Node), "Expected symbolic program node")
    state = node.state
    if isinstance(state, tuple):
        _require(len(state) == 2, "Invalid symbolic class state")
        state = state[0]
    _require(isinstance(state, dict), "Expected symbolic attribute mapping")
    return state


def _member(node, name):
    return _attrs(node)[_Text(name.encode())]


def extract_program(data: bytes, task: str) -> dict:
    run, expected, modules = RUNS[task]
    _require(hashlib.sha256(data).hexdigest() == expected, "Published program digest mismatch")
    root = _parse(data)
    artifact = {}
    state = {}
    for module, field in modules.items():
        predictor = _member(root, "predict") if module == "predict" else _member(_member(root, module), "predict")
        _require(_member(predictor, "lm") is None, "Published predictor has an attached LM")
        for key in ("demos", "traces", "train", "callbacks"):
            _require(_member(predictor, key) == [], "Published predictor has attached examples or callbacks")
        instruction = _member(_member(predictor, "signature"), "__doc__")
        _require(isinstance(instruction, _Text), "Missing published signature instructions")
        artifact[field] = instruction.raw.decode("utf-8")
        state[module] = {"lm": None, "demos": [], "traces": [], "train": [], "callbacks": []}
    return {"run": run, "member": f"experiment_runs_data/experiment_runs/seed_0/{run}/evaluation_results/optimized_program/program.pkl",
            "program_sha256": expected, "program_bytes": len(data), "artifact": artifact, "predictor_state": state,
            "extraction": "Inert pickle stack graph. No imports, reducers, constructors or upstream code execute. Strings remain opaque bytes except the named predictor signature instructions."}


def _validation_provenance(data: bytes) -> dict:
    state = _parse(data)
    _require(isinstance(state, dict) and state.get(_Text(b"track_scores_on")) == _Text(b"val"),
             "Published control was not selected on validation")
    scores = state.get(_Text(b"program_full_scores_val_set"))
    _require(isinstance(scores, list) and bool(scores)
             and all(type(value) in (int, float) and 0 <= value <= 100 for value in scores)
             and scores == state.get(_Text(b"per_program_tracked_scores")), "Invalid published validation scores")
    selected = max(range(len(scores)), key=scores.__getitem__)
    _require(scores[selected] > scores[0], "Published optimized control did not improve its official seed")
    return {"state_sha256": hashlib.sha256(data).hexdigest(), "track_scores_on": "val",
            "baseline_validation_percent": scores[0], "selected_validation_percent": scores[selected],
            "compile_selected_index": selected, "selected_by_pilot_scores": False}


def export_controls(archive: Path, output: Path) -> dict:
    with archive.open("rb") as stream:
        _require(archive.stat().st_size == ARCHIVE_BYTES and hashlib.file_digest(stream, "sha256").hexdigest() == ARCHIVE_SHA256,
                 "Published archive digest mismatch")
    members = {f"experiment_runs_data/experiment_runs/seed_0/{run}/evaluation_results/optimized_program/program.pkl": name
               for name, (run, _, _) in RUNS.items()}
    state_members = {f"experiment_runs_data/experiment_runs/seed_0/{run}/gepa_state.bin": name
                     for name, (run, _, _) in RUNS.items()}
    prefixes = {f"experiment_runs_data/experiment_runs/seed_0/{run}/prog_candidates/": name
                for name, (run, _, _) in RUNS.items()}
    states, candidate_hashes = {}, {name: {} for name in RUNS}
    controls = {}
    with tarfile.open(archive, mode="r|gz") as tar:
        for member in tar:
            if member.name in members:
                name = members[member.name]
                _require(name not in controls and member.isfile() and member.size <= 32_768, "Invalid published program member")
                stream = tar.extractfile(member)
                _require(stream is not None, "Missing published program payload")
                controls[name] = extract_program(stream.read(32_769), name)
            elif member.name in state_members:
                name = state_members[member.name]
                _require(name not in states and member.isfile() and member.size <= 131_072, "Invalid validation-state member")
                states[name] = _validation_provenance(tar.extractfile(member).read(131_073))
                states[name]["state_member"] = member.name
            else:
                for prefix, name in prefixes.items():
                    if not member.name.startswith(prefix):
                        continue
                    suffix = member.name[len(prefix):].split("/")
                    if len(suffix) == 2 and suffix[0].isdigit() and suffix[1] == "program.pkl":
                        index = int(suffix[0])
                        _require(index not in candidate_hashes[name] and member.isfile() and member.size <= 1_048_576,
                                 "Invalid published checkpoint member")
                        candidate_hashes[name][index] = hashlib.sha256(tar.extractfile(member).read(1_048_577)).hexdigest()
                    break
    _require(set(controls) == set(RUNS), "Published archive omits a selected control")
    _require(set(states) == set(RUNS), "Published archive omits validation provenance")
    for name, state in states.items():
        matches = candidate_hashes[name].get(state["compile_selected_index"]) == controls[name]["program_sha256"]
        _require(matches, "Final published export differs from the compile-selected checkpoint")
        controls[name]["published_validation"] = dict(state, final_export_matches_compile_selected_pickle=matches)
    result = {"source": f"https://github.com/gepa-ai/gepa-artifact/tree/{REVISION}", "revision": REVISION,
              "archive_sha256": ARCHIVE_SHA256, "archive_bytes": ARCHIVE_BYTES,
              "license": "MIT", "copyright": "2025 Lakshya A Agrawal", "controls": controls}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
    return result


def control_artifact(task: str) -> dict[str, str]:
    source = Path(__file__).with_name("published-controls.json")
    result = json.loads(source.read_text())
    _require(result["revision"] == REVISION and result["archive_sha256"] == ARCHIVE_SHA256,
             "Published control provenance mismatch")
    control = result["controls"][task]
    _require(control["program_sha256"] == RUNS[task][1] and set(control["artifact"]) == set(RUNS[task][2].values()),
             "Published control identity mismatch")
    _require(control["published_validation"]["final_export_matches_compile_selected_pickle"] is True
             and control["published_validation"]["selected_validation_percent"] > control["published_validation"]["baseline_validation_percent"],
             "Published control lacks external improvement evidence")
    return dict(control["artifact"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = export_controls(args.archive, args.output)
    print(json.dumps({"exported": sorted(result["controls"]), "model_calls": 0, "upstream_code_executed": False}))
