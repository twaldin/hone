from __future__ import annotations

import ast
from collections.abc import Callable
import copy
from dataclasses import dataclass
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import random
import sys
from types import ModuleType, SimpleNamespace
import urllib.request

from .program import MAX_WIRE_BYTES, ProgramError, SEED_PROGRAM, run_program
from .runtime import BudgetExhausted, CallFailed, digest
from .verification import PLAN_SECONDS, WORKER_SECONDS, plan_digest, prepare_plan, score_solution

ARTIFACT_REV = "cbefbc1aa0f43dd39874ec4bf42211365dbda42e"
ARTIFACT = f"https://raw.githubusercontent.com/gepa-ai/gepa-artifact/{ARTIFACT_REV}/gepa_artifact/benchmarks/IFBench/"
AIME_REV = "13f9e12f613e720c2a2b2f345dd04b998a29494d"
MBPP_REV = "4bb6404fdc6cacfda99d4ac4205087b89d32030c"
DATA_SOURCES = {
    "ifbench": (ARTIFACT + "data/IFBench_train.jsonl", None, "e93fdcb8bb891db9d790c361b5049920cba5a470"),
    "aime": (f"https://huggingface.co/datasets/project-numina/aimo-validation-aime/resolve/{AIME_REV}/data/train-00000-of-00001.parquet", "025484a99fea498e7d0c3b0ee42afcbec0176405c19c5dbf557b9f6ca6445675", None),
    "mbpp_train": (f"https://huggingface.co/datasets/google-research-datasets/mbpp/resolve/{MBPP_REV}/full/train-00000-of-00001.parquet", "09d125ca31edacb7800be8c67c45abff618faf0214ff551291817d06bdb914ae", None),
    "mbpp_selection": (f"https://huggingface.co/datasets/google-research-datasets/mbpp/resolve/{MBPP_REV}/full/validation-00000-of-00001.parquet", "3f0ec060987432d99fe8fb409d31e6c67445b208a01741c5583517c80a10fe80", None),
}
CHECKERS = {
    "instructions_util": "0c005bd9ee2a4ff854b27c26e5c054a22d54f02e",
    "instructions": "4dc72a2d4fc495ed2415b9ef8950b60ffa938952",
    "instructions_util_ifeval": "b39e04782d427ab2138dc246ca0ae555139c6b03",
    "instructions_ifeval": "999f5430abd2da3a62f64d7e9b91e1022ed17491",
    "instructions_registry_ifeval": "b725c96ffa8a18f24745e50ff45b13e9ac22ff66",
    "instructions_registry": "bdd2e295d259ef133cf47c0278af80751c0b3cdd",
}
METRIC_BLOB = "c800063a08b0cee62c28e82cdec5c16fe79085bb"


@dataclass
class Task:
    name: str
    train: list[dict]
    selection: list[dict]
    manifest: dict
    seed_candidate: dict[str, str]


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _fetch(cache: Path, key: str, url: str, sha256: str | None, blob: str | None) -> tuple[Path, dict]:
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / key
    if target.exists():
        data = target.read_bytes()
    else:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024:
            raise ValueError("Source exceeds bounded download size")
    digest = _sha(data)
    if sha256 is not None and digest != sha256:
        raise ValueError(f"Pinned source SHA256 mismatch: {key}")
    if blob is not None and hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest() != blob:
        raise ValueError(f"Pinned Git blob mismatch: {key}")
    if not target.exists():
        target.write_bytes(data)
    return target, {"url": url, "sha256": digest, "bytes": len(data), "git_blob": blob}


def _data(cache: Path, name: str) -> tuple[list[dict], dict]:
    url, digest, blob = DATA_SOURCES[name]
    path, manifest = _fetch(cache, name + (".jsonl" if name == "ifbench" else ".parquet"), url, digest, blob)
    if name == "ifbench":
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()], manifest
    import pyarrow.parquet as parquet
    return parquet.read_table(path).to_pylist(), manifest


def partition(name: str, rows: list[dict]) -> tuple[list[dict], list[dict]]:
    if name == "ifbench":
        if len(rows) < 600:
            raise ValueError("IFBench development source must contain at least 600 rows")
        return rows[300:600], rows[:300]
    if name == "aime":
        if len(rows) != 90:
            raise ValueError("Historical AIME development source must contain exactly 90 rows")
        shuffled = list(rows)
        random.Random(0).shuffle(shuffled)
        return shuffled[:45], shuffled[45:]
    raise ValueError("Unknown development partition")


def _signature(source: str) -> str:
    declarations = []
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
            declarations.append(prefix + node.name + "(" + ast.unparse(node.args) + "):")
    if not declarations:
        raise ValueError("MBPP reference has no function declaration")
    return "\n".join(declarations)


def load_task(name: str, cache: Path) -> Task:
    if name == "hover":
        from .hover import load_hover
        return load_hover(cache)
    if name not in ("ifbench", "aime", "mbpp"):
        raise ValueError("Only explicit development tasks ifbench, aime, mbpp, hover are allowed")
    sources = []
    if name == "mbpp":
        train_raw, train_source = _data(cache, "mbpp_train")
        selection_raw, selection_source = _data(cache, "mbpp_selection")
        if len(train_raw) != 374 or len(selection_raw) != 90:
            raise ValueError("MBPP full development split membership changed")
        sources += [train_source, selection_source]
        def convert(raw: dict, split: str) -> dict:
            return {"id": f"mbpp:{split}:{raw['task_id']}",
                    "input": raw["text"] + "\n\nRequired function declarations (implement bodies):\n" + _signature(raw["code"]),
                    "test_setup_code": raw["test_setup_code"] or "", "test_list": raw["test_list"],
                    "reference_code": raw["code"]}
        train = [convert(row, "train") for row in train_raw]
        selection = [convert(row, "validation") for row in selection_raw]
        seed = {"prompt": "Write Python code solving the problem. Preserve the required function names and signatures. Return only solution code, no markdown.", "program": SEED_PROGRAM}
    else:
        raw, source = _data(cache, name)
        sources.append(source)
        rows = []
        for index, row in enumerate(raw):
            if name == "ifbench":
                rows.append({"id": f"ifbench:train:{index}", "input": row["prompt"],
                             "instruction_id_list": row["instruction_id_list"], "kwargs": row["kwargs"]})
            else:
                rows.append({"id": f"aime:historical:{index}", "input": row["problem"],
                             "answer": row["answer"], "solution": row.get("solution", "")})
        train, selection = partition(name, rows)
        seed = ({"prompt": "Respond to the query",
                 "revision_prompt": "Ensure the response is correct and adheres to the given constraints. Your response will be used as the final response."}
                if name == "ifbench" else {"prompt": "Solve the problem and provide the answer in the correct format."})
    manifest = {"task": name, "development_only": True, "sources": sources,
                "train_ids": [row["id"] for row in train], "selection_ids": [row["id"] for row in selection],
                "scored_final_tests_loaded": False, "metric_artifact_revision": ARTIFACT_REV,
                "adaptation": "Reference AST function declarations only; no bodies, examples or test assertions. Bounded Python agent-program adaptation, not official optimizer artifact." if name == "mbpp" else "Official development transformations; AIME Random(0) 45/45, IFBench source rows 300:600 training and 0:300 selection.",
                "license": "CC-BY-4.0" if name == "mbpp" else "See pinned source"}
    if name in {"aime", "ifbench"}:
        manifest["program_protocol"] = {
            "adaptation": "Current subscription model and fixed deployment limits, identical across methods; not the historical GPT-4.1-mini DSPy panel. Visible JSON reasoning substitutes for DSPy ChainOfThought fields; hidden reasoning is not required.",
            "official_program": ARTIFACT.replace("IFBench/", "") + ("AIME/AIME_program.py" if name == "aime" else "IFBench/ifbench_program.py"),
            "stages": ["reasoning, answer"] if name == "aime" else ["reasoning, response", "reasoning, final_response"],
            "editable_modules": ({"prompt": "GenerateResponse"} if name == "aime" else
                                 {"prompt": "GenerateResponse", "revision_prompt": "EnsureCorrectResponse"}),
            "protected_stage_order": (["prompt -> reasoning, answer"] if name == "aime" else
                                      ["prompt -> reasoning, response", "revision_prompt + query + response -> reasoning, final_response"]),
            "instruction_scope": "Each module receives only its own editable instruction; JSON fields, stage order and host-side scoring are protected and identical for every method.",
            "metric_input": "Extracted answer with official int(answer) semantics." if name == "aime" else "Extracted final_response passed unchanged as metric response.",
        }
    if name == "mbpp":
        manifest["solution_evaluator"] = {
            "answer_extraction": "First exactly python-tagged or bare triple-backtick block, with surrounding horizontal whitespace allowed; unclosed eligible block consumes the remainder; whole output if none. Applied once at shared scoring boundary.",
            "trusted_plan": "A separate bounded pinned-image invocation per row receives only the official reference, setup and assertions. Each assertion must be one equality whose left side is a positional call to an official reference function, optionally inside the official int wrapper. Arguments and the expected right side are evaluated there and returned as tagged plain data, cached by row contents only.",
            "worker": "A fresh network-disabled, read-only, non-root container per candidate row, without host mounts or host environment, receives only extracted source, target function names and tagged arguments. Custom argument objects are rebuilt from class name and fields without constructors, using the candidate class when defined. Calls run in official assertion order and return one bounded tagged-JSON frame.",
            "decision": "The trusted parent alone validates the frame and compares exact canonical builtin types and values, or class name plus exact fields for structural records, after any official int wrapper. A zero exit and one well-formed frame are necessary, never sufficient; failures, extra output and unsupported values score zero.",
            "limits": {"plan_seconds": PLAN_SECONDS, "worker_seconds": WORKER_SECONDS,
                       "source_bytes": MAX_WIRE_BYTES, "wire_output_bytes": MAX_WIRE_BYTES},
        }
        plans = [(row["id"], prepare_plan(row["reference_code"], row["test_setup_code"], row["test_list"]))
                 for row in train + selection]
        manifest["gradeability"] = {
            "gradeable_ids": [key for key, plan in plans if plan["gradeable"]],
            "ungradeable": [{"id": key, "reason": plan["reason"]} for key, plan in plans if not plan["gradeable"]],
            "plans": digest([plan_digest(plan) for _, plan in plans]),
        }
    if name == "ifbench":
        metric, receipts = _official_metric(cache)
        _METRICS[id(manifest)] = metric
        manifest["metric_sources"] = receipts
        manifest["nlp_assets"] = _nlp_assets()
    return Task(name, train, selection, manifest, seed)


class _DisableDownloads(ast.NodeTransformer):
    def visit_Expr(self, node: ast.Expr) -> ast.AST:
        call = node.value
        if isinstance(call, ast.Call) and ((isinstance(call.func, ast.Name) and call.func.id in {"download", "download_nltk_resources"}) or
            (isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == "nltk" and call.func.attr == "download")):
            return ast.copy_location(ast.Pass(), node)
        return self.generic_visit(node)


_METRICS: dict[int, Callable] = {}


def _official_metric(cache: Path) -> tuple[Callable, list[dict]]:
    package = "_hone_frozen_ifbench_" + ARTIFACT_REV
    receipts = []
    for suffix in ("", ".utils_ifbench"):
        module = ModuleType(package + suffix)
        module.__path__ = []
        sys.modules[module.__name__] = module
    for name, blob in [*CHECKERS.items(), ("ifbench_metric", METRIC_BLOB)]:
        relative = ("" if name == "ifbench_metric" else "utils_ifbench/") + name + ".py"
        path, receipt = _fetch(cache, "official_" + name + ".py", ARTIFACT + relative, None, blob)
        receipts.append(receipt)
        tree = ast.parse(path.read_text(), filename=str(path))
        if name == "ifbench_metric":
            tree.body = [node for node in tree.body if not (isinstance(node, ast.Import) and any(alias.name == "dspy" for alias in node.names))]
        else:
            tree = _DisableDownloads().visit(tree)
        ast.fix_missing_locations(tree)
        full_name = package + ("." if name == "ifbench_metric" else ".utils_ifbench.") + name
        module = ModuleType(full_name)
        module.__package__ = full_name.rsplit(".", 1)[0]
        module.__dict__["dspy"] = SimpleNamespace(Prediction=SimpleNamespace)
        sys.modules[full_name] = module
        exec(compile(tree, str(path), "exec"), module.__dict__)
        if name == "ifbench_metric":
            metric = module.metric_with_feedback
    return metric, receipts


def _tree_hash(path: Path) -> str:
    digest = hashlib.sha256()
    files = [path] if path.is_file() else sorted(item for item in path.rglob("*") if item.is_file() and "__pycache__" not in item.parts)
    for item in files:
        digest.update((item.name if path.is_file() else str(item.relative_to(path))).encode() + b"\0")
        digest.update(item.read_bytes())
    return digest.hexdigest()


def _nlp_assets() -> dict:
    import nltk
    spec = importlib.util.find_spec("en_core_web_sm")
    if spec is None or spec.origin is None:
        raise RuntimeError("Preinstall pinned en_core_web_sm; runtime NLP downloads are disabled")
    assets = {"en_core_web_sm": _tree_hash(Path(spec.origin).parent)}
    for name in ("tokenizers/punkt", "tokenizers/punkt_tab", "corpora/stopwords", "taggers/averaged_perceptron_tagger_eng"):
        pointer = nltk.data.find(name)
        assets[name] = _tree_hash(Path(str(pointer)))
    return {"sha256": assets, "packages": {name: importlib.metadata.version(name) for name in ("nltk", "spacy", "en-core-web-sm", "emoji", "syllapy", "immutabledict", "langdetect")}, "runtime_downloads": False, "language_detector_seed": 0}


def aime_score(answer: str, expected: str) -> float:
    try:
        parsed = int(answer)
    except ValueError:
        return 0.0
    return float(parsed == int(expected))


def _ifbench_result(task: Task, row: dict, output: str) -> SimpleNamespace:
    metric = _METRICS[id(task.manifest)]
    from langdetect import DetectorFactory
    DetectorFactory.seed = 0
    state = random.getstate()
    try:
        random.seed(row["id"])
        return metric(SimpleNamespace(prompt=row["input"], instruction_id_list=row["instruction_id_list"],
                                      kwargs=copy.deepcopy(row["kwargs"])), SimpleNamespace(response=output))
    finally:
        random.setstate(state)


def score_output(task: Task, row: dict, output: str) -> float:
    if task.name == "hover":
        from .hover import score_hover_output
        return score_hover_output(task, row, output)
    if task.name == "aime":
        return aime_score(output, row["answer"])
    if task.name == "ifbench":
        return float(_ifbench_result(task, row, output).score)
    return score_solution(output, row["reference_code"], row["test_setup_code"], row["test_list"])

def _response(call: Callable, messages: list[dict], field: str, traces: list[dict]) -> str:
    protocol = (
        f"Return only one JSON object with exactly two string fields: reasoning and {field}. "
        f"Put visible reasoning in reasoning and only the requested answer in {field}. "
        "No markdown fences or text outside JSON."
    )
    messages = [{"role": "system", "content": protocol}] + messages
    raw = call("task", messages, 4096)
    traces.append({"messages": messages, "output": raw, "max_tokens": 4096})
    parsed = json.loads(raw)
    if (not isinstance(parsed, dict) or set(parsed) != {"reasoning", field}
            or any(not isinstance(value, str) for value in parsed.values())):
        raise ValueError("Invalid protected response fields")
    return parsed[field]


def evaluate(task: Task, candidate: dict[str, str], rows: list[dict],
             call: Callable[[str, list[dict], int], str], capture_traces: bool = False) -> dict:
    allowed = {row["id"]: row for row in task.train + task.selection}
    if any(row["id"] not in allowed for row in rows):
        raise ValueError("Evaluation row is outside frozen development membership")
    train_ids = {row["id"] for row in task.train}
    if capture_traces and any(row["id"] not in train_ids for row in rows):
        raise ValueError("Selection labels and feedback cannot be captured")
    valid_candidate = ((task.name == "mbpp" or isinstance(candidate, dict))
                       and set(candidate) == ({"prompt", "program"} if task.name == "mbpp" else
                                              {"prompt", "revision_prompt"} if task.name == "ifbench" else
                                              {"prompt"} if task.name == "aime" else set(task.seed_candidate))
                       and all(isinstance(value, str) for value in candidate.values()))
    if task.name == "hover" and valid_candidate:
        from .hover import evaluate_hover
        return evaluate_hover(task, candidate, [allowed[row["id"]] for row in rows], call, capture_traces)
    scores, outputs, trajectories = [], [], []
    for row in rows:
        row = allowed[row["id"]]
        output = ""
        traces = []
        feedback = ""
        try:
            if not valid_candidate:
                raise ProgramError("Invalid candidate fields")
            if task.name == "mbpp":
                output, traces = run_program(candidate, row["input"], call)
                score = score_output(task, row, output)
                feedback = "Solution passed development assertions." if score else "Solution failed development assertions or execution."
            else:
                messages = [{"role": "system", "content": candidate["prompt"]}, {"role": "user", "content": row["input"]}]
                output = _response(call, messages, "answer" if task.name == "aime" else "response", traces)
                if task.name == "aime":
                    score = aime_score(output, row["answer"])
                    feedback = f"Correct integer answer: {row['answer']}. " + row.get("solution", "")
                else:
                    revision = [
                        {"role": "system", "content": candidate["revision_prompt"]},
                        {"role": "user", "content": json.dumps({"query": row["input"], "response": output})},
                    ]
                    output = _response(call, revision, "final_response", traces)
                    result = _ifbench_result(task, row, output)
                    score, feedback = float(result.score), result.feedback
        except BudgetExhausted:
            raise
        except (CallFailed, ProgramError, SyntaxError, KeyError, ValueError, TypeError):
            output = ""
            score, feedback = 0.0, "Candidate crashed or returned invalid output."
        scores.append(score)
        outputs.append(output)
        if capture_traces:
            assert row["id"] in train_ids
            trajectories.append({"id": row["id"], "input": row["input"], "output": output,
                                 "score": score, "feedback": feedback, "calls": traces})
    return {"scores": scores, "outputs": outputs, "trajectories": trajectories}
