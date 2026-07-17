#!/usr/bin/env python3
"""Trusted evaluator for the terminal FLT workflow-parser holdout capsule.

The evaluator runs only from /trusted/baseline. Candidate JavaScript executes
in a fresh, uid-dropped Node process per case and receives one raw sealed YAML
document over stdin plus one sealed preset registry through a fresh HOME.
Candidate code never imports this evaluator or reads the root-only asset mount.
Only src/workflow/parser.mjs may differ from the frozen baseline tree.

The sole objective is q = passed sealed cases / declared sealed cases. A case
passes only when the owner-derived AST or localized error agrees exactly and a
successful parse is canonical round-trip stable. Crashes, timeouts, oversized
or extra output, schema violations, protected changes, and runaway descendants
fail closed. Standard library only.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import resource
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.mjs"
MUTABLE_PATH = "src/workflow/parser.mjs"
IGNORED_PARTS = {".git", ".gitdir", "__pycache__", ".pytest_cache"}
ALLOWED_GROUPS = {"legacy", "dag", "gate", "reference", "preset", "generated"}
MAX_CASES = 128
MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_INPUT_BYTES = 256 * 1024
MAX_PRESET_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 512 * 1024
MAX_PARSER_BYTES = 128 * 1024
CALL_TIMEOUT_SEC = 4.0
WORKER_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
NODE_BIN = os.environ.get("CAPSULE_NODE", "node")
WORKER_PATH = os.environ.get("CAPSULE_WORKER_PATH", "/usr/bin:/bin")
PR_SET_CHILD_SUBREAPER = 36
STATE_RESET_TIMEOUT_SEC = 1.5
_LIBC = ctypes.CDLL(None, use_errno=True)


class EvaluationFailure(Exception):
    pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def relative_files(root: Path) -> dict[str, Path]:
    if not root.is_dir() or root.is_symlink():
        raise EvaluationFailure(f"candidate root is not a real directory: {root}")
    files: dict[str, Path] = {}
    for current, dirs, names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        kept_dirs: list[str] = []
        for name in sorted(dirs):
            child = current_path / name
            rel_parts = child.relative_to(root).parts
            if any(part in IGNORED_PARTS for part in rel_parts):
                continue
            mode = child.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise EvaluationFailure(f"non-directory or symlink in candidate tree: {child.relative_to(root)}")
            kept_dirs.append(name)
        dirs[:] = kept_dirs
        for name in sorted(names):
            path = current_path / name
            rel = path.relative_to(root)
            if any(part in IGNORED_PARTS for part in rel.parts):
                continue
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
                raise EvaluationFailure(f"non-regular file in candidate tree: {rel}")
            files[rel.as_posix()] = path
    return files


def verify_candidate(workspace: Path) -> None:
    trusted = relative_files(TRUSTED_DIR)
    candidate = relative_files(workspace)
    if set(candidate) != set(trusted):
        missing = sorted(set(trusted) - set(candidate))
        added = sorted(set(candidate) - set(trusted))
        raise EvaluationFailure(
            f"candidate tree changed outside the registered surface (missing={missing[:4]}, added={added[:4]})"
        )
    parser = candidate.get(MUTABLE_PATH)
    if parser is None or parser.stat().st_size == 0 or parser.stat().st_size > MAX_PARSER_BYTES:
        raise EvaluationFailure("mutable parser is missing, empty, or oversized")
    for rel, trusted_path in trusted.items():
        if rel == MUTABLE_PATH:
            continue
        if sha256(candidate[rel]) != sha256(trusted_path):
            raise EvaluationFailure(f"protected file changed: {rel}")


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EvaluationFailure(f"{label} must be an object")
    return value


def safe_asset_path(root: Path, rel: Any, prefix: str, suffix: str) -> Path:
    if not isinstance(rel, str) or not rel.startswith(prefix) or not rel.endswith(suffix):
        raise EvaluationFailure(f"invalid sealed asset path: {rel!r}")
    if rel.startswith("/") or ".." in Path(rel).parts:
        raise EvaluationFailure(f"unsafe sealed asset path: {rel!r}")
    path = root / rel
    cursor = path.parent
    while cursor != root:
        if cursor.is_symlink():
            raise EvaluationFailure(f"sealed asset traverses a symlink: {rel}")
        if root not in cursor.parents:
            raise EvaluationFailure(f"sealed asset escapes its root: {rel}")
        cursor = cursor.parent
    if path.is_symlink() or not path.is_file():
        raise EvaluationFailure(f"sealed asset is not a regular file: {rel}")
    if path.resolve().parent != (root / prefix.rstrip("/")).resolve():
        raise EvaluationFailure(f"sealed asset escapes its directory: {rel}")
    return path


def validate_error(value: Any, label: str) -> dict[str, Any]:
    obj = require_object(value, label)
    if set(obj) != {"name", "message", "line", "column"}:
        raise EvaluationFailure(f"{label} has invalid fields")
    if not isinstance(obj["name"], str) or not obj["name"]:
        raise EvaluationFailure(f"{label}.name must be non-empty")
    if not isinstance(obj["message"], str) or not obj["message"]:
        raise EvaluationFailure(f"{label}.message must be non-empty")
    for field in ("line", "column"):
        if obj[field] is not None and (not isinstance(obj[field], int) or isinstance(obj[field], bool) or obj[field] < 1):
            raise EvaluationFailure(f"{label}.{field} must be null or a positive integer")
    return obj


def validate_expected(value: Any, label: str) -> dict[str, Any]:
    obj = require_object(value, label)
    if obj.get("ok") is True:
        if set(obj) != {"ok", "ast", "canonical"} or not isinstance(obj["canonical"], str):
            raise EvaluationFailure(f"{label} has invalid success schema")
        if canonical_json(obj["ast"]) != obj["canonical"]:
            raise EvaluationFailure(f"{label}.canonical does not match the expected AST")
    elif obj.get("ok") is False:
        if set(obj) != {"ok", "error", "canonical"} or obj["canonical"] is not None:
            raise EvaluationFailure(f"{label} has invalid error schema")
        validate_error(obj["error"], f"{label}.error")
    else:
        raise EvaluationFailure(f"{label}.ok must be boolean")
    return obj


def load_cases(assets: Path) -> list[dict[str, Any]]:
    indexes = sorted(path for path in assets.rglob("cases.json") if path.is_file() and not path.is_symlink())
    if len(indexes) != 1:
        raise EvaluationFailure(f"expected one sealed cases.json, found {len(indexes)}")
    index = indexes[0]
    asset_root = index.parent
    if index.stat().st_size > MAX_INDEX_BYTES:
        raise EvaluationFailure("sealed cases.json is oversized")
    raw = json.loads(index.read_text(encoding="utf-8"))
    obj = require_object(raw, "cases.json")
    if set(obj) != {"version", "declared", "cases"} or obj["version"] != 1:
        raise EvaluationFailure("cases.json has invalid top-level schema")
    cases = obj["cases"]
    if not isinstance(cases, list) or not cases or len(cases) > MAX_CASES or obj["declared"] != len(cases):
        raise EvaluationFailure("cases.json declared count is invalid")
    ids: set[str] = set()
    groups: set[str] = set()
    loaded: list[dict[str, Any]] = []
    for index_value, raw_case in enumerate(cases):
        case = require_object(raw_case, f"cases[{index_value}]")
        if set(case) != {"id", "group", "input", "presets", "expected"}:
            raise EvaluationFailure(f"cases[{index_value}] has invalid fields")
        case_id = case["id"]
        group = case["group"]
        if not isinstance(case_id, str) or not case_id or case_id in ids:
            raise EvaluationFailure(f"cases[{index_value}].id is invalid or duplicated")
        if group not in ALLOWED_GROUPS:
            raise EvaluationFailure(f"case {case_id} has unknown group")
        ids.add(case_id)
        groups.add(group)
        input_path = safe_asset_path(asset_root, case["input"], "inputs/", ".yaml")
        preset_path = safe_asset_path(asset_root, case["presets"], "presets/", ".json")
        if input_path.stat().st_size > MAX_INPUT_BYTES or preset_path.stat().st_size > MAX_PRESET_BYTES:
            raise EvaluationFailure(f"case {case_id} has an oversized sealed input")
        preset_obj = json.loads(preset_path.read_text(encoding="utf-8"))
        if not isinstance(preset_obj, dict):
            raise EvaluationFailure(f"case {case_id} preset registry must be an object")
        loaded.append({
            "id": case_id,
            "group": group,
            "text": input_path.read_text(encoding="utf-8"),
            "preset_bytes": preset_path.read_bytes(),
            "expected": validate_expected(case["expected"], f"case {case_id}.expected"),
        })
    if groups != ALLOWED_GROUPS:
        raise EvaluationFailure(f"case bank does not cover every registered group: {sorted(groups)}")
    return loaded


def configure_subreaper() -> None:
    if not sys.platform.startswith("linux") or os.geteuid() != 0:
        return
    if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        raise EvaluationFailure(f"cannot become candidate subreaper: {os.strerror(code)}")


def candidate_pids() -> list[int]:
    if os.geteuid() != 0 or not Path("/proc").is_dir():
        return []
    found: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            lines = (entry / "status").read_text().splitlines()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        for line in lines:
            if line.startswith("Uid:"):
                fields = line.split()
                if len(fields) >= 2 and int(fields[1]) == WORKER_UID:
                    found.append(int(entry.name))
                break
    return found


def reap_candidate_processes() -> None:
    if os.geteuid() != 0:
        return
    deadline = time.monotonic() + STATE_RESET_TIMEOUT_SEC
    while True:
        pids = candidate_pids()
        if not pids:
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    break
                if pid == 0:
                    break
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise EvaluationFailure(f"candidate processes survived reset: {pids}")
        time.sleep(0.01)


def child_setup() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(WORKER_UID)
        os.setuid(WORKER_UID)


def parse_worker_response(payload: bytes, nonce: str) -> dict[str, Any]:
    if not payload or len(payload) > MAX_RESPONSE_BYTES or not payload.endswith(b"\n"):
        raise EvaluationFailure("worker response is empty, oversized, or unterminated")
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvaluationFailure(f"worker response is not one JSON value: {error}") from error
    obj = require_object(decoded, "worker response")
    if set(obj) != {"nonce", "result"} or obj["nonce"] != nonce:
        raise EvaluationFailure("worker response nonce or fields are invalid")
    result = require_object(obj["result"], "worker result")
    if result.get("ok") is True:
        if set(result) != {"ok", "ast", "canonical", "roundTripStable"}:
            raise EvaluationFailure("worker success result has invalid fields")
        if not isinstance(result["canonical"], str) or not isinstance(result["roundTripStable"], bool):
            raise EvaluationFailure("worker success result has invalid types")
        if canonical_json(result["ast"]) != result["canonical"]:
            raise EvaluationFailure("worker canonical output disagrees with its AST")
    elif result.get("ok") is False:
        if set(result) != {"ok", "error"}:
            raise EvaluationFailure("worker error result has invalid fields")
        validate_error(result["error"], "worker result.error")
    else:
        raise EvaluationFailure("worker result.ok must be boolean")
    return result


def run_case(workspace: Path, case: dict[str, Any]) -> dict[str, Any]:
    reap_candidate_processes()
    nonce = secrets.token_hex(16)
    request = canonical_json({"nonce": nonce, "text": case["text"]}).encode("utf-8")
    with tempfile.TemporaryDirectory(prefix="flt-workflow-home-") as temp:
        home = Path(temp)
        flt_dir = home / ".flt"
        flt_dir.mkdir(mode=0o755)
        presets = flt_dir / "presets.json"
        presets.write_bytes(case["preset_bytes"])
        # The uid-dropped candidate may read this one sealed registry but
        # cannot mutate it or persist state into the fresh HOME.
        presets.chmod(0o444)
        flt_dir.chmod(0o755)
        home.chmod(0o755)
        process = subprocess.Popen(
            [NODE_BIN, "--no-warnings", str(WORKER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={
                "HOME": str(home),
                "PATH": WORKER_PATH,
                "CAPSULE_WORKSPACE": str(workspace),
                "NODE_OPTIONS": "--disable-proto=throw --max-old-space-size=192",
            },
            preexec_fn=child_setup,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(request, timeout=CALL_TIMEOUT_SEC)
        except subprocess.TimeoutExpired as error:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate()
            reap_candidate_processes()
            raise EvaluationFailure("worker timed out") from error
        finally:
            reap_candidate_processes()
        if process.returncode != 0:
            detail = stderr.decode("utf-8", "replace")[:300].replace("\n", " ")
            raise EvaluationFailure(f"worker exited {process.returncode}: {detail}")
        if stderr:
            raise EvaluationFailure("worker wrote unexpected stderr")
        return parse_worker_response(stdout, nonce)


def compare_case(actual: dict[str, Any], expected: dict[str, Any]) -> tuple[bool, list[str]]:
    mismatches: list[str] = []
    if actual.get("ok") is not expected["ok"]:
        return False, ["outcome"]
    if expected["ok"]:
        if actual["ast"] != expected["ast"]:
            mismatches.append("ast-fields")
        if actual["canonical"] != expected["canonical"]:
            mismatches.append("canonical-output")
        if actual["roundTripStable"] is not True:
            mismatches.append("round-trip")
    else:
        expected_error = expected["error"]
        actual_error = actual["error"]
        if actual_error["name"] != expected_error["name"]:
            mismatches.append("error-class")
        if actual_error["message"] != expected_error["message"]:
            mismatches.append("error-message")
        if actual_error["line"] != expected_error["line"] or actual_error["column"] != expected_error["column"]:
            mismatches.append("error-localization")
    return not mismatches, mismatches


def hard_failure(message: str) -> dict[str, Any]:
    return {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": {
            "tests_pass": False,
            "protected_unchanged": False,
            "protocol_valid": False,
            "all_cases_pass": False,
        },
        "perExample": {},
        "diagnostics": {
            "summary": f"hard gate failed: {message[:500]}",
            "quality": 0.0,
            "passed": 0,
            "declared": 0,
        },
    }


def evaluate() -> dict[str, Any]:
    workspace = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace")).resolve()
    assets = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets")).resolve()
    verify_candidate(workspace)
    cases = load_cases(assets)
    configure_subreaper()
    per_example: dict[str, Any] = {}
    passed = 0
    protocol_valid = True
    group_counts: dict[str, list[int]] = {group: [0, 0] for group in sorted(ALLOWED_GROUPS)}
    for case in cases:
        group_counts[case["group"]][1] += 1
        if not protocol_valid:
            ok = False
            mismatches = ["protocol:skipped-after-hard-failure"]
        else:
            try:
                actual = run_case(workspace, case)
                ok, mismatches = compare_case(actual, case["expected"])
            except EvaluationFailure as error:
                protocol_valid = False
                ok = False
                mismatches = [f"protocol:{str(error)[:180]}"]
        if ok:
            passed += 1
            group_counts[case["group"]][0] += 1
        per_example[case["id"]] = {
            "score": 1.0 if ok else 0.0,
            "feedback": {
                "group": case["group"],
                "status": "pass" if ok else "fail",
                "mismatches": mismatches,
            },
        }
    declared = len(cases)
    score = passed / declared if protocol_valid else 0.0
    groups_summary = ", ".join(
        f"{group}={counts[0]}/{counts[1]}" for group, counts in sorted(group_counts.items())
    )
    return {
        "valid": protocol_valid,
        "objectives": {"score": score},
        "constraints": {
            "tests_pass": protocol_valid,
            "protected_unchanged": True,
            "protocol_valid": protocol_valid,
            "all_cases_pass": protocol_valid and passed == declared,
        },
        "perExample": per_example,
        "diagnostics": {
            "summary": f"{'passed' if protocol_valid else 'hard protocol gate failed after'} {passed}/{declared}; {groups_summary}",
            "quality": 1.0 if protocol_valid else 0.0,
            "passed": passed,
            "declared": declared,
            "groups": {group: {"passed": counts[0], "declared": counts[1]} for group, counts in sorted(group_counts.items())},
        },
    }


def main() -> None:
    try:
        output = evaluate()
    except Exception as error:
        output = hard_failure(f"{type(error).__name__}: {error}")
    finally:
        try:
            reap_candidate_processes()
        except Exception:
            pass
    sys.stdout.write(canonical_json(output) + "\n")


if __name__ == "__main__":
    main()
