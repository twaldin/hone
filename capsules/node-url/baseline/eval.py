#!/usr/bin/env python3
"""Trusted evaluator for nodejs/node WHATWG URL throughput."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import resource
import subprocess
import sys
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
EXACT_OUTPUT = TRUSTED_DIR / "exact_output.js"
MEMORY_PROBE = TRUSTED_DIR / "memory_probe.js"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
SOURCE = Path("/opt/node")
NODE = SOURCE / "out/Release/node"
SANDBOX_UID = 2000
PROCESS_TIMEOUT_SEC = 180
MUTABLE_FILES = frozenset({
    "src/node_url.cc",
    "src/node_url.h",
    "lib/internal/url.js",
    "deps/ada/ada.cpp",
    "deps/ada/ada.h",
    "deps/ada/ada_c.h",
})
MEMORY_RE = re.compile(rb"HONE_MEMORY (\d+) (\d+)")
EXTERNAL_RSS_RE = re.compile(rb"HONE_EXTERNAL_RSS_KB=(\d+)")
EXPECTED_WORKLOAD_FIELDS = frozenset({
    "version",
    "split",
    "provenance",
    "urlParseExponent",
    "urlPropertiesExponent",
    "searchParamsIterations",
    "baselineMemory",
    "withBase",
    "urls",
    "searchParams",
})


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def safe_detail(detail: str) -> str:
    return detail.replace(str(ASSETS), "<sealed-assets>").replace(str(WORKSPACE), "<workspace>")[:1200]


def emit_failure(detail: str, result_hash: str = "") -> None:
    message = safe_detail(detail)
    output = {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": {
            "tests_pass": False,
            "exact_outputs_pass": False,
            "memory_pass": False,
        },
        "perExample": {"aggregate": {"score": 0.0, "feedback": message}},
        "diagnostics": {
            "summary": message,
            "quality": 0.0,
            "result_hash": result_hash or hashlib.sha256(message.encode()).hexdigest(),
        },
    }
    print(canonical(output))


def demote() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (12 << 30, 12 << 30))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


def parse_worker(completed: subprocess.CompletedProcess[bytes], action: str) -> dict:
    try:
        payload = json.loads(completed.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise GateFailure(f"{action} worker returned malformed output") from error
    if completed.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
        detail = payload.get("detail") if isinstance(payload, dict) else None
        raise GateFailure(f"{action} gate failed: {str(detail or 'worker failure')[:700]}")
    return payload


def run_worker(action: str, *arguments: str) -> dict:
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(WORKER), action, *arguments],
            cwd=TRUSTED_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=650,
            check=False,
            preexec_fn=demote,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise GateFailure(f"{action} worker failed: {error}") from error
    return parse_worker(completed, action)


def file_sha256(path: Path) -> bytes:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").digest()


def check_source_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    trusted_paths = {
        path.relative_to(TRUSTED_DIR).as_posix(): path
        for path in TRUSTED_DIR.rglob("*")
        if path.is_file()
    }
    candidate_paths: set[str] = set()
    for path in WORKSPACE.rglob("*"):
        relative = path.relative_to(WORKSPACE).as_posix()
        if relative == ".git" or relative.startswith(".git/") or relative == ".gitdir":
            raise GateFailure("repository metadata is forbidden in the candidate")
        if path.is_symlink() and relative in MUTABLE_FILES:
            raise GateFailure(f"mutable source must be a regular file: {relative}")
        if not path.is_file():
            continue
        candidate_paths.add(relative)
        trusted = trusted_paths.get(relative)
        if trusted is None and relative not in MUTABLE_FILES:
            raise GateFailure(f"file outside mutable source envelope: {relative}")
        if relative in MUTABLE_FILES:
            continue
        if file_sha256(path) != file_sha256(trusted):
            raise GateFailure(f"protected source file changed: {relative}")
    missing = set(trusted_paths) - candidate_paths - MUTABLE_FILES
    if missing:
        raise GateFailure(f"protected source file is missing: {min(missing)}")
    for relative in MUTABLE_FILES:
        path = WORKSPACE / relative
        if path.is_symlink() or not path.is_file():
            raise GateFailure(f"required mutable source file is missing: {relative}")


def load_workload() -> tuple[dict, str]:
    paths = sorted(ASSETS.rglob("workload.json"))
    if len(paths) != 1:
        raise GateFailure("selected asset group must contain exactly one workload")
    try:
        raw = paths[0].read_bytes()
        workload = json.loads(raw)
    except (OSError, ValueError) as error:
        raise GateFailure("sealed workload is malformed") from error
    if not isinstance(workload, dict) or set(workload) != EXPECTED_WORKLOAD_FIELDS:
        raise GateFailure("sealed workload has an invalid schema")
    if workload["version"] != 1 or workload["split"] not in {"train", "validation"}:
        raise GateFailure("sealed workload identity is invalid")
    if not isinstance(workload["provenance"], str) or "benchmark/url" not in workload["provenance"]:
        raise GateFailure("sealed workload provenance is invalid")
    if workload["urlParseExponent"] != 12 or workload["urlPropertiesExponent"] != 11:
        raise GateFailure("sealed URL benchmark scale is invalid")
    if workload["searchParamsIterations"] != 1_000_000 or not isinstance(workload["withBase"], bool):
        raise GateFailure("sealed SearchParams benchmark scale is invalid")
    for key, expected_field in (("urls", "expectedHref"), ("searchParams", "expected")):
        rows = workload[key]
        if not isinstance(rows, list) or len(rows) != 4:
            raise GateFailure(f"sealed {key} workload must contain four cases")
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != {"id", expected_field}:
                raise GateFailure(f"sealed {key} row is invalid")
            if not isinstance(row["id"], str) or not isinstance(row[expected_field], str) or row["id"] in seen:
                raise GateFailure(f"sealed {key} identity is invalid")
            seen.add(row["id"])
    memory = workload["baselineMemory"]
    memory_fields = {"heapUsedBytes", "rssBytes", "limitHeapUsedBytes", "limitRssBytes"}
    if not isinstance(memory, dict) or set(memory) != memory_fields:
        raise GateFailure("sealed memory baseline is invalid")
    if any(not isinstance(memory[field], int) or memory[field] <= 0 for field in memory_fields):
        raise GateFailure("sealed memory values are invalid")
    if memory["limitHeapUsedBytes"] != memory["heapUsedBytes"] * 102 // 100:
        raise GateFailure("sealed heap limit is not baseline plus two percent")
    if memory["limitRssBytes"] != memory["rssBytes"] * 102 // 100:
        raise GateFailure("sealed RSS limit is not baseline plus two percent")
    return workload, hashlib.sha256(raw).hexdigest()


def run_exact_output_gate(workload: dict) -> dict:
    try:
        completed = subprocess.run(
            [str(NODE), str(EXACT_OUTPUT)],
            cwd=TRUSTED_DIR,
            input=canonical(workload).encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
            preexec_fn=demote,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise GateFailure(f"exact-output worker failed: {error}") from error
    try:
        payload = json.loads(completed.stdout)
    except (ValueError, UnicodeDecodeError) as error:
        raise GateFailure("exact-output worker returned malformed output") from error
    if completed.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
        raise GateFailure("exact serialized output gate failed")
    expected_urls = {row["id"]: row["expectedHref"] for row in workload["urls"]}
    expected_params = {row["id"]: row["expected"] for row in workload["searchParams"]}
    if payload.get("urls") != expected_urls or payload.get("searchParams") != expected_params:
        raise GateFailure("exact serialized output mismatch")
    return {"urls": payload["urls"], "searchParams": payload["searchParams"]}


def benchmark_cells(workload: dict) -> list[tuple[str, str, list[str]]]:
    cells: list[tuple[str, str, list[str]]] = []
    base = str(workload["withBase"]).lower()
    for row in workload["urls"]:
        cells.append((
            f"url-parse:{row['id']}",
            "benchmark/url/whatwg-url-parse.js",
            [f"e={workload['urlParseExponent']}", f"withBase={base}", f"type={row['id']}"],
        ))
        cells.append((
            f"url-href:{row['id']}",
            "benchmark/url/whatwg-url-properties.js",
            ["prop=href", f"e={workload['urlPropertiesExponent']}", f"withBase={base}", f"type={row['id']}"],
        ))
    for row in workload["searchParams"]:
        for operation in ("parse", "serialize"):
            cells.append((
                f"searchparams-{operation}:{row['id']}",
                f"benchmark/url/legacy-vs-whatwg-url-searchparams-{operation}.js",
                [f"n={workload['searchParamsIterations']}", "method=whatwg", f"searchParam={row['id']}"],
            ))
    return cells


def run_benchmark(script: str, arguments: list[str]) -> tuple[float, int, int]:
    env = dict(os.environ)
    env.update({
        "HOME": "/tmp/hone-node-home",
        "NODE_OPTIONS": f"--require={MEMORY_PROBE}",
        "NODE_TEST_NO_INTERNET": "1",
        "NO_COLOR": "1",
    })
    try:
        completed = subprocess.run(
            ["/usr/bin/time", "-f", "HONE_EXTERNAL_RSS_KB=%M", str(NODE), str(SOURCE / script), *arguments],
            cwd=SOURCE,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=PROCESS_TIMEOUT_SEC,
            check=False,
            preexec_fn=demote,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise GateFailure(f"benchmark process failed: {error}") from error
    if completed.returncode != 0:
        raise GateFailure("upstream benchmark process failed")
    try:
        lines = [line for line in completed.stdout.decode("ascii").splitlines() if line.strip()]
        if len(lines) != 1 or ": " not in lines[0]:
            raise ValueError
        rate = float(lines[0].rsplit(": ", 1)[1].replace(",", ""))
    except (ValueError, UnicodeDecodeError) as error:
        raise GateFailure("upstream benchmark returned malformed throughput") from error
    memory_rows = [(int(heap), int(rss)) for heap, rss in MEMORY_RE.findall(completed.stderr)]
    external_rss_rows = [int(rss_kib) * 1024 for rss_kib in EXTERNAL_RSS_RE.findall(completed.stderr)]
    if not memory_rows or len(external_rss_rows) != 1:
        raise GateFailure("trusted benchmark memory probes did not run")
    heap_used = max(heap for heap, _ in memory_rows)
    rss = max([rss for _, rss in memory_rows] + external_rss_rows)
    if not math.isfinite(rate) or rate <= 0:
        raise GateFailure("upstream benchmark returned non-finite throughput")
    return rate, heap_used, rss


def geometric_mean(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("cannot scalarize invalid benchmark throughput")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def main() -> None:
    started = time.monotonic()
    result_hash = ""
    try:
        check_source_envelope()
        workload, workload_hash = load_workload()
        run_worker("prepare", str(WORKSPACE))
        build = run_worker("build")
        tests = run_worker("test")
        exact = run_exact_output_gate(workload)

        rates: list[float] = []
        max_heap = 0
        max_rss = 0
        for _, script, arguments in benchmark_cells(workload):
            rate, heap, rss = run_benchmark(script, arguments)
            rates.append(rate)
            max_heap = max(max_heap, heap)
            max_rss = max(max_rss, rss)

        memory = workload["baselineMemory"]
        if max_heap > memory["limitHeapUsedBytes"]:
            raise GateFailure("heap-used gate failed: candidate exceeds baseline plus two percent")
        if max_rss > memory["limitRssBytes"]:
            raise GateFailure("RSS gate failed: candidate exceeds baseline plus two percent")

        score = geometric_mean(rates)
        identity = {
            "sourceRevision": "9df0e9b4d4a5be5ce7506fae44acb6667bb68d6b",
            "split": workload["split"],
            "workloadSha256": workload_hash,
            "exactOutputs": exact,
            "tests": "parallel/test-url*+parallel/test-whatwg-url*",
            "benchmarkCells": [cell_id for cell_id, _, _ in benchmark_cells(workload)],
        }
        result_hash = hashlib.sha256(canonical(identity).encode()).hexdigest()
        elapsed = time.monotonic() - started
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "exact_outputs_pass": True,
                "memory_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": f"16 upstream benchmark/url cells passed all hard gates; q={score:.3f} ops/s",
                }
            },
            "diagnostics": {
                "summary": "WHATWG URL tests, exact serialization, and baseline+2% heap/RSS gates passed",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(float(build.get("seconds", 0.0)), 6),
                "test_sec": round(float(tests.get("seconds", 0.0)), 6),
                "eval_sec": round(elapsed, 6),
                "max_heap_used_bytes": max_heap,
                "max_rss_bytes": max_rss,
                "benchmark_cells": len(rates),
            },
        }
        print(canonical(output))
    except (GateFailure, OSError, ValueError) as error:
        emit_failure(str(error), result_hash)


if __name__ == "__main__":
    main()
