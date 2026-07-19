#!/usr/bin/env python3
"""Unprivileged build, relevant-test, and benchmark worker for sqlite-speedtest1."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
import resource
import shutil
import subprocess
import sys
from pathlib import Path

TIMEOUT_SEC = 240
CONFIGURE = [
    "./configure",
    "--disable-shared",
    "--disable-readline",
    "--with-tcl=/usr/lib/aarch64-linux-gnu",
]
TEST_SCRIPTS = ("select1.test", "index.test", "join.test", "where.test")


def run_quiet(argv: list[str], cwd: Path, timeout: int = TIMEOUT_SEC) -> tuple[bool, str]:
    compiler_tmp = cwd / ".hone-compiler-tmp"
    compiler_tmp.mkdir(mode=0o700, exist_ok=True)
    environment = os.environ.copy()
    environment["TMPDIR"] = str(compiler_tmp)
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env=environment,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace")[-2000:]
        return False, f"exit {completed.returncode}: {detail}"
    return True, "ok"


def prepare(workspace: Path, source: Path) -> dict:
    try:
        shutil.copytree(workspace, source, symlinks=False)
    except OSError as exc:
        return {"ok": False, "stage": "prepare", "detail": str(exc)}
    return {"ok": True, "stage": "prepare"}


def build(source: Path) -> dict:
    setup_commands = [CONFIGURE, ["make", "-j2", "sqlite3.c"]]
    for command in setup_commands:
        ok, detail = run_quiet(command, source)
        if not ok:
            return {"ok": False, "stage": "build", "detail": detail}
    compile_commands = [
        ["make", "-j2", "testfixture", "CFLAGS=-O0 -g0"],
        [
            "cc", "-O2", "-DNDEBUG", "-DSQLITE_THREADSAFE=1", "-std=c99",
            "-Wall", "-Wextra", "-Werror", "-I.", "bench.c", "sqlite3.c",
            "-o", "hone-sqlite-bench", "-lm", "-ldl", "-lpthread",
        ],
    ]
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda command: run_quiet(command, source), compile_commands))
    for ok, detail in results:
        if not ok:
            return {"ok": False, "stage": "build", "detail": detail}
    ok, detail = run_quiet(["strip", "hone-sqlite-bench"], source)
    if not ok:
        return {"ok": False, "stage": "build", "detail": detail}
    binary = source / "hone-sqlite-bench"
    return {"ok": True, "stage": "build", "binaryBytes": binary.stat().st_size}


def test(source: Path) -> dict:
    commands: list[list[str]] = []
    for script in TEST_SCRIPTS:
        command = ["./testfixture", f"test/{script}"]
        commands.append(command)
        ok, detail = run_quiet(command, source, timeout=120)
        if not ok:
            return {"ok": False, "stage": "upstream_tests", "detail": detail}
    return {
        "ok": True,
        "stage": "upstream_tests",
        "commands": [" ".join(command) for command in commands],
    }


def benchmark(source: Path, database: Path, workload: str) -> dict:
    try:
        completed = subprocess.run(
            [str(source / "hone-sqlite-bench"), str(database), workload],
            cwd=source,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "stage": "benchmark", "detail": str(exc)}
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace")[-1000:]
        return {"ok": False, "stage": "benchmark", "detail": f"exit {completed.returncode}: {detail}"}
    try:
        output = completed.stdout.decode("ascii").strip()
    except UnicodeDecodeError:
        return {"ok": False, "stage": "benchmark", "detail": "non-ASCII output"}
    return {
        "ok": True,
        "stage": "benchmark",
        "output": output,
        "peakRssKiB": int(usage.ru_maxrss),
    }


def main() -> None:
    if len(sys.argv) not in {3, 4, 5} or sys.argv[1] not in {"prepare", "build", "test", "benchmark"}:
        raise SystemExit(64)
    action = sys.argv[1]
    if action == "prepare":
        if len(sys.argv) != 4:
            raise SystemExit(64)
        workspace = Path(sys.argv[2]).resolve()
        source = Path(sys.argv[3]).resolve()
        if not workspace.is_dir() or source.exists():
            raise SystemExit(64)
        output = prepare(workspace, source)
    else:
        if action == "benchmark":
            if len(sys.argv) != 5 or sys.argv[4] not in {"read", "index", "aggregate", "join"}:
                raise SystemExit(64)
        elif len(sys.argv) != 3:
            raise SystemExit(64)
        source = Path(sys.argv[2]).resolve()
        if not source.is_dir():
            raise SystemExit(64)
        if action == "build":
            output = build(source)
        elif action == "test":
            output = test(source)
        else:
            database = Path(sys.argv[3]).resolve()
            if not database.is_file():
                raise SystemExit(64)
            output = benchmark(source, database, sys.argv[4])
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(0 if output["ok"] else 1)


if __name__ == "__main__":
    main()
