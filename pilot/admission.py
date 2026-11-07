from __future__ import annotations

import ast
import copy
from pathlib import Path

from .runtime import digest

MBPP_FILES = ("pilot/program.py", "pilot/verification.py", "pilot/runtime.py", "pilot/gateway.mjs")


class _MBPP(ast.NodeTransformer):
    def visit_Name(self, node):
        if node.id == "name" and isinstance(node.ctx, ast.Load):
            return ast.copy_location(ast.Constant("mbpp"), node)
        return node

    def visit_Attribute(self, node):
        if isinstance(node.value, ast.Name) and node.value.id == "task" and node.attr == "name":
            return ast.copy_location(ast.Constant("mbpp"), node)
        return self.generic_visit(node)

    def visit_Compare(self, node):
        node = self.generic_visit(node)
        if len(node.ops) != 1:
            return node
        try:
            left, right = ast.literal_eval(node.left), ast.literal_eval(node.comparators[0])
        except (ValueError, TypeError):
            return node
        op = node.ops[0]
        if isinstance(op, ast.Eq):
            value = left == right
        elif isinstance(op, ast.NotEq):
            value = left != right
        elif isinstance(op, ast.In):
            value = left in right
        elif isinstance(op, ast.NotIn):
            value = left not in right
        else:
            return node
        return ast.copy_location(ast.Constant(value), node)

    def visit_BoolOp(self, node):
        node = self.generic_visit(node)
        values = []
        conjunction = isinstance(node.op, ast.And)
        for value in node.values:
            if isinstance(value, ast.Constant) and type(value.value) is bool:
                if value.value == conjunction:
                    continue
                values.append(value)
                break
            values.append(value)
        if not values:
            return ast.copy_location(ast.Constant(conjunction), node)
        if len(values) == 1:
            return values[0]
        return ast.copy_location(ast.BoolOp(node.op, values), node)

    def visit_If(self, node):
        node = self.generic_visit(node)
        if isinstance(node.test, ast.Constant) and type(node.test.value) is bool:
            return node.body if node.test.value else node.orelse
        return node

    def visit_IfExp(self, node):
        node = self.generic_visit(node)
        if isinstance(node.test, ast.Constant) and type(node.test.value) is bool:
            return node.body if node.test.value else node.orelse
        return node


def mbpp_ast(source: str, path: str) -> str:
    module = ast.parse(source)
    names = {"load_task", "score_output", "evaluate"} if path == "pilot/tasks.py" else {"_contract"}
    for index, node in enumerate(module.body):
        if isinstance(node, ast.FunctionDef) and node.name in names:
            module.body[index] = _MBPP().visit(copy.deepcopy(node))
    return digest(ast.dump(module, include_attributes=False))


def mbpp_source_contract(root: Path) -> dict:
    import hashlib
    return {"literal_files": {path: "sha256:" + hashlib.sha256((root / path).read_bytes()).hexdigest() for path in MBPP_FILES},
            "specialized_ast": {path: mbpp_ast((root / path).read_text(), path) for path in ("pilot/tasks.py", "pilot/search.py")},
            "specialization": "Only load_task, score_output, evaluate and search._contract specialize name/task.name to mbpp. All remaining module AST and literal files must match. No other expressions execute during comparison."}


SOURCE_HEAD = "3f52884d86b2b562e3c15a875514ee0ac48d0215"


def pinned_source(root: Path, path: str, expected: str | None = None) -> str:
    import json
    snapshot = json.loads((root / "evidence/pilot/source-snapshot-5.json").read_text())
    if snapshot["source_head"] != SOURCE_HEAD:
        raise ValueError("Retained source snapshot head changed")
    if expected is not None and expected in snapshot.get("historical_files", {}):
        return snapshot["historical_files"][expected]
    if expected is not None:
        import hashlib
        baseline = root / "evidence/pilot/source-snapshot-7.json"
        if baseline.exists():
            source = json.loads(baseline.read_text())["files"].get(path)
            if source is not None and "sha256:" + hashlib.sha256(source.encode()).hexdigest() == expected:
                return source
    return snapshot["files"][path]


def measured_checker_failure(proof: dict, task_name: str) -> bool:
    from .adversarial import TEXT_FIELDS
    checks = proof["checks"]
    if checks["positive_score"] != 1:
        return True
    if not checks["records"]:
        return False
    record = checks["records"][-1]
    expected_frames = len(TEXT_FIELDS[task_name]) if record["mode"] == "protected-json" else 1
    return (len(record["frames"]) == expected_frames
            and (record["direct_score"] != 0 or record["scores"] != [0.0]))


def task_source_ast(source: str, task_name: str) -> str:
    class Specialize(_MBPP):
        def visit_Name(self, node):
            if node.id == "name" and isinstance(node.ctx, ast.Load):
                return ast.copy_location(ast.Constant(task_name), node)
            return node

        def visit_Attribute(self, node):
            if isinstance(node.value, ast.Name) and node.value.id == "task" and node.attr == "name":
                return ast.copy_location(ast.Constant(task_name), node)
            return self.generic_visit(node)

    module = ast.parse(source)
    for index, node in enumerate(module.body):
        if isinstance(node, ast.FunctionDef) and node.name in {"partition", "load_task", "score_output", "evaluate"}:
            module.body[index] = Specialize().visit(node)
            for position, statement in enumerate(module.body[index].body):
                if isinstance(statement, (ast.Return, ast.Raise)):
                    module.body[index].body = module.body[index].body[:position + 1]
                    break
    return digest(ast.dump(module, include_attributes=False))


TRANSITION_8A_HASH = "sha256:8d6f3298f0e5c0c26b30a32bce491f563e4e424cc4168150b2757b5e6ad3e36a"
TRANSITION_9_HEAD = "cdb1e75fc76c2c3e44f313208e8f86d92ee50291"
TRANSITION_9_HASH = "sha256:2e2b7d25ab9e487b82c05a98915295a477b7a220d42aad0a632757ab840d5d76"
TRANSITION_10_HEAD = "6017e35e0b2f2f8dd72c0cdd8e2bbf94edeaf107"
TRANSITION_10_SEARCH_HASH = "sha256:8bf99067e6d87a12e124b849285e623e4e631f6707e2708822b8330d3f3ef3cb"
TRANSITION_11_HEAD = "b453995e9add69d3d82a11673e80e0dfaa46c8d8"
TRANSITION_11_VERIFICATION_HASH = "sha256:ad2654400810f2493a33e9225686870c768119a35a07874095ef151293729c46"


def transition11_baseline(root: Path) -> dict:
    import hashlib
    import json
    declaration = root / "evidence/pilot/source-transition-11.json"
    if not declaration.exists():
        return {}
    sha = lambda data: "sha256:" + hashlib.sha256(data).hexdigest()
    receipt = json.loads(declaration.read_text())
    prior_path = root / "evidence/pilot/source-transition-10.json"
    prior = json.loads(prior_path.read_text())
    snapshot_path = root / "evidence/pilot/source-snapshot-11.json"
    snapshot = json.loads(snapshot_path.read_text())
    if (receipt.get("version") != "pilot-grader-transition-v11"
            or receipt.get("source_head") != TRANSITION_11_HEAD
            or snapshot.get("source_head") != TRANSITION_11_HEAD
            or receipt.get("prior_source_transition_hash") != sha(prior_path.read_bytes())
            or receipt.get("source_snapshot_hash") != sha(snapshot_path.read_bytes())
            or receipt.get("predeclaration_hash") != sha((root / "evidence/pilot/predeclaration-11.md").read_bytes())
            or set(receipt.get("files", {})) != set(prior["files"]) | {"pilot/campaign.py"}
            or set(snapshot.get("files", {})) != set(prior["files"])
            or receipt["files"].get("pilot/verification.py", {}).get("after") != TRANSITION_11_VERIFICATION_HASH):
        raise ValueError("Grader source transition does not authenticate its baseline")
    changed_files = {"pilot/__main__.py", "pilot/admission.py", "pilot/adversarial.py", "pilot/controls.py",
                     "pilot/hover.py", "pilot/panel.py", "pilot/runtime.py", "pilot/tasks.py", "pilot/verification.py",
                     "pilot/campaign.py"}
    for filename, hashes in receipt["files"].items():
        before = snapshot["files"].get(filename)
        if (hashes.get("before") != (sha(before.encode()) if before is not None else None)
                or (filename in prior["files"] and hashes["before"] != prior["files"][filename]["after"])
                or (filename not in changed_files and hashes["before"] != hashes["after"])
                or hashes.get("after") != sha((root / filename).read_bytes())):
            raise ValueError("Grader source transition changed: " + filename)
    return snapshot["files"]


def transition10_baseline(root: Path) -> dict:
    import hashlib
    import json
    grader_baseline = transition11_baseline(root)
    declaration = root / "evidence/pilot/source-transition-10.json"
    if not declaration.exists():
        return {}
    sha = lambda data: "sha256:" + hashlib.sha256(data).hexdigest()
    receipt = json.loads(declaration.read_text())
    prior_path = root / "evidence/pilot/source-transition-9.json"
    prior = json.loads(prior_path.read_text())
    snapshot_path = root / "evidence/pilot/source-snapshot-10.json"
    snapshot = json.loads(snapshot_path.read_text())
    if (sha(prior_path.read_bytes()) != TRANSITION_9_HASH
            or receipt.get("version") != "pilot-selection-transition-v10"
            or receipt.get("source_head") != TRANSITION_10_HEAD
            or snapshot.get("source_head") != TRANSITION_10_HEAD
            or receipt.get("prior_source_transition_hash") != TRANSITION_9_HASH
            or receipt.get("source_snapshot_hash") != sha(snapshot_path.read_bytes())
            or receipt.get("predeclaration_hash") != sha((root / "evidence/pilot/predeclaration-10.md").read_bytes())
            or receipt.get("files", {}).get("pilot/search.py", {}).get("after") != TRANSITION_10_SEARCH_HASH
            or set(receipt.get("files", {})) != set(prior["files"])):
        raise ValueError("Selection source transition does not authenticate its baseline")
    changed = {name for name, hashes in receipt["files"].items() if hashes["before"] != hashes["after"]}
    if not changed or set(snapshot.get("files", {})) != changed:
        raise ValueError("Selection source transition snapshot inventory changed")
    for filename, hashes in receipt["files"].items():
        current = grader_baseline.get(filename, "").encode() if filename in grader_baseline else (root / filename).read_bytes()
        baseline = snapshot["files"][filename].encode() if filename in changed else current
        if (hashes["before"] != prior["files"][filename]["after"]
                or hashes["before"] != sha(baseline)
                or hashes["after"] != sha(current)):
            raise ValueError("Selection source transition changed: " + filename)
    return {**grader_baseline, **snapshot["files"]}


def transition9_baseline(root: Path, prior: dict) -> tuple[dict, dict]:
    import hashlib
    import json
    declaration = root / "evidence/pilot/source-transition-9.json"
    if not declaration.exists():
        return {}, {}
    selection_baseline = transition10_baseline(root)
    sha = lambda data: "sha256:" + hashlib.sha256(data).hexdigest()
    receipt = json.loads(declaration.read_text())
    snapshot_path = root / "evidence/pilot/source-snapshot-9.json"
    snapshot = json.loads(snapshot_path.read_text())
    prior_hash = sha((root / "evidence/pilot/source-transition-8a.json").read_bytes())
    if (prior_hash != TRANSITION_8A_HASH
            or receipt.get("version") != "pilot-dispatch-transition-v9"
            or receipt.get("source_head") != TRANSITION_9_HEAD
            or snapshot.get("source_head") != TRANSITION_9_HEAD
            or receipt.get("prior_source_transition_hash") != prior_hash
            or receipt.get("source_snapshot_hash") != sha(snapshot_path.read_bytes())
            or receipt.get("predeclaration_hash") != sha((root / "evidence/pilot/predeclaration-9.md").read_bytes())
            or set(receipt.get("files", {})) != set(prior["files"])):
        raise ValueError("Dispatch source transition does not authenticate its baseline")
    changed = {name for name, hashes in receipt["files"].items() if hashes["before"] != hashes["after"]}
    if not changed or set(snapshot.get("files", {})) != changed:
        raise ValueError("Dispatch source transition snapshot inventory changed")
    for filename, hashes in receipt["files"].items():
        current = selection_baseline[filename].encode() if filename in selection_baseline else (root / filename).read_bytes()
        baseline = snapshot["files"][filename].encode() if filename in changed else current
        if (hashes["before"] != prior["files"][filename]["after"]
                or hashes["before"] != sha(baseline)
                or hashes["after"] != sha(current)):
            raise ValueError("Dispatch source transition changed: " + filename)
    return {**selection_baseline, **snapshot["files"]}, {
        "source_transition_hash": sha(declaration.read_bytes()),
        "source_snapshot_hash": receipt["source_snapshot_hash"],
        "predeclaration_hash": receipt["predeclaration_hash"],
        "prior_source_transition_hash": prior_hash,
    }


def identity_source_hash(root: Path, path: str) -> str:
    import hashlib
    import json
    prior = root / "evidence/pilot/source-transition-8a.json"
    if (root / "evidence/pilot/source-transition-9.json").exists():
        transition_source(root, "pilot/runtime.py")
        baseline, _ = transition9_baseline(root, json.loads(prior.read_text()))
        source = baseline[path].encode() if path in baseline else (root / path).read_bytes()
    else:
        source = (root / path).read_bytes()
    return "sha256:" + hashlib.sha256(source).hexdigest()


def transition_source(root: Path, path: str) -> str:
    import hashlib
    import json
    declaration = root / "evidence/pilot/source-transition-8a.json"
    if not declaration.exists():
        if (root / "evidence/pilot/source-transition-9.json").exists():
            raise ValueError("Dispatch source transition requires its prior refusal grant")
        return (root / path).read_text()
    receipt = json.loads(declaration.read_text())
    baseline, _ = transition9_baseline(root, receipt)
    snapshot_path = root / "evidence/pilot/source-snapshot-7.json"
    snapshot = json.loads(snapshot_path.read_text())
    sha = lambda data: "sha256:" + hashlib.sha256(data).hexdigest()
    if (receipt.get("version") != "pilot-refusal-transition-v8a"
            or receipt.get("source_head") != "ed610b55c95beea8ee4810dc2a709786f790d04c"
            or snapshot.get("source_head") != receipt["source_head"]
            or receipt.get("source_snapshot_hash") != sha(snapshot_path.read_bytes())
            or receipt.get("predeclaration_hash") != sha((root / "evidence/pilot/predeclaration-8.md").read_bytes())
            or receipt.get("request_encoding_correction_hash") != sha((root / "evidence/pilot/predeclaration-8a.md").read_bytes())
            or receipt.get("prior_source_transition_hash") != sha((root / "evidence/pilot/source-transition-8.json").read_bytes())
            or not set(snapshot["files"]).issubset(receipt["files"])):
        raise ValueError("Refusal source transition does not authenticate its baseline")
    for filename, hashes in receipt["files"].items():
        current = baseline[filename].encode() if filename in baseline else (root / filename).read_bytes()
        if (hashes["after"] != sha(current)
                or hashes["before"] != (sha(snapshot["files"][filename].encode())
                                        if filename in snapshot["files"] else None)):
            raise ValueError("Refusal source transition changed: " + filename)
    if path not in snapshot["files"]:
        raise ValueError("Retained execution source absent from transition: " + path)
    return snapshot["files"][path]


def retained_transport_proof(root: Path, task_name: str) -> dict | None:
    import hashlib
    import json
    path = root / "evidence/pilot/source-transition-8a.json"
    if not path.exists():
        return None
    receipt = json.loads(path.read_text())
    if set(receipt.get("retained_calls", {})) != {"mbpp", "hover"}:
        raise ValueError("Refusal transition omits a retained task")
    proof = receipt["retained_calls"][task_name]
    source = root / proof["path"]
    data = source.read_bytes()
    rows = [json.loads(line) for line in data.splitlines()]
    if (proof["sha256"] != "sha256:" + hashlib.sha256(data).hexdigest()
            or not rows or len(rows) != proof["calls"]
            or any(row.get("status") != 200 or row.get("failed") is not False
                   or row.get("usage_missing") is not False or row.get("outcome") == "refusal" for row in rows)):
        raise ValueError("Retained transport is not an entirely answered, metered execution")
    return {"source_transition_hash": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
            "calls_hash": proof["sha256"], "answered_calls": len(rows), "refusals": 0,
            "model_calls": 0}


def validate_source_equivalence(root: Path, original: dict, task_name: str) -> dict:
    import hashlib
    files = original["evaluator_files"]
    expected_paths = {"pilot/tasks.py", "pilot/program.py", "pilot/verification.py", "pilot/adversarial.py",
                      "pilot/controls.py", "pilot/runtime.py", "pilot/gateway.mjs", "pilot/__main__.py",
                      "pilot/admission.py", "pilot/hover.py", "pilot/published.py",
                      "pilot/published-controls.json", "pilot/panel.py"}
    if task_name == "mbpp" and original.get("contract") == 4:
        expected_paths.remove("pilot/panel.py")
    if set(files) != expected_paths:
        raise ValueError("Original admission source inventory changed")
    scoped = {}
    for path, expected in files.items():
        old = pinned_source(root, path, expected)
        if "sha256:" + hashlib.sha256(old.encode()).hexdigest() != expected:
            raise ValueError("Pinned source does not authenticate original admission: " + path)
        current = transition_source(root, path)
        if path == "pilot/tasks.py":
            before, after = task_source_ast(old, task_name), task_source_ast(current, task_name)
        elif path == "pilot/controls.py":
            if original.get("contract", 0) < 6:
                current = current.replace("IFBENCH_CONTROL_SEED = 20261106\n", "")
                current = current.replace('    if task.name == "ifbench":\n        seed = IFBENCH_CONTROL_SEED\n', "")
                current = current.replace('IFBENCH_CONTROL_SEED if task.name == "ifbench" else CONTROL_SEED if task.name == "mbpp" else P_CONTROL_SEED',
                                          'CONTROL_SEED if task.name == "mbpp" else P_CONTROL_SEED')
            before = digest(ast.dump(ast.parse(old), include_attributes=False))
            after = digest(ast.dump(ast.parse(current), include_attributes=False))
        elif path == "pilot/admission.py":
            names = {"_MBPP", "mbpp_ast", "mbpp_source_contract", "text_admission", "validate_text_admission"}
            before = digest([ast.dump(node, include_attributes=False) for node in ast.parse(old).body
                             if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names])
            after = digest([ast.dump(node, include_attributes=False) for node in ast.parse(current).body
                            if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names])
        elif path == "pilot/__main__.py":
            names = {"environment", "calls_for", "calibration_transport", "execution_limits"}
            before = digest([ast.dump(node, include_attributes=False) for node in ast.parse(old).body
                             if isinstance(node, ast.FunctionDef) and node.name in names])
            after = digest([ast.dump(node, include_attributes=False) for node in ast.parse(current).body
                            if isinstance(node, ast.FunctionDef) and node.name in names])
        elif path == "pilot/panel.py":
            continue
        else:
            before, after = digest(old), digest(current)
        if before != after:
            raise ValueError("Retained task execution source changed: " + path)
        scoped[path] = after
    result = {"source_head": SOURCE_HEAD, "original_files": files, "task_execution_hashes": scoped}
    if task_name in ("mbpp", "hover"):
        result["refusal_transition"] = retained_transport_proof(root, task_name)
    return result


def text_admission(task, identity: dict, rows: list[dict]) -> dict:
    from .adversarial import text_checks
    checks = text_checks(task)
    return {"version": "pilot-text-admission-v4", "task": task.name, "identity": identity,
            "rows": [value["id"] for value in rows], "checks": checks, "passed": checks["passed"],
            "model_calls": 0,
            "boundary": "Direct host scoring plus protected-JSON and raw-protocol attacks through every real stage. Candidate strings never execute in the checker."}


def validate_text_admission(proof: dict, task, identity: dict, rows: list[dict]) -> None:
    import json
    from .adversarial import TEXT_FIELDS, string_task, text_manifest
    from .tasks import score_output
    try:
        synthetic, row, good = string_task(task)
        checks = proof["checks"]
        if (proof["version"] != "pilot-text-admission-v4" or proof["task"] != task.name
                or proof["identity"] != identity or proof["rows"] != [value["id"] for value in rows]
                or proof["model_calls"] != 0 or proof["passed"] is not True or checks["passed"] is not True
                or checks["row"] != row or checks["positive_output"] != good
                or checks["positive_score"] != 1 or score_output(synthetic, row, good) != 1):
            raise ValueError("P checker admission identity or positive control changed")
        payloads = text_manifest()
        if [(record["attack"], record["mode"]) for record in checks["records"]] != [
            (payload["name"], mode) for payload in payloads for mode in ("protected-json", "raw-protocol")
        ]:
            raise ValueError("P checker admission omits a protocol attack")
        sources = {payload["name"]: payload["source"] for payload in payloads}
        for record in checks["records"]:
            source = sources[record["attack"]]
            frames = ([json.dumps({"reasoning": "", field: source}) for field in TEXT_FIELDS[task.name]]
                      if record["mode"] == "protected-json" else [source])
            outputs = record["outputs"]
            if (record["source"] != source or record["frames"] != frames or record["direct_score"] != 0
                    or score_output(synthetic, row, source) != 0 or record["scores"] != [0.0]
                    or not isinstance(outputs, list) or len(outputs) != 1 or not isinstance(outputs[0], str)
                    or score_output(synthetic, row, outputs[0]) != 0
                    or task.name != "hover" and outputs != ([source] if record["mode"] == "protected-json" else [""])
                    or record["mode"] == "raw-protocol" and outputs != [""]):
                raise ValueError("P checker admission contains a positive, altered or inconsistent attack")
    except (KeyError, TypeError, IndexError) as error:
        raise ValueError("P checker admission is incomplete") from error
