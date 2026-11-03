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
