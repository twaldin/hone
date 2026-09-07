#!/usr/bin/env python3
"""Unprivileged build, relevant-test, and benchmark worker for sqlite-speedtest1."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
import signal
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
TRUSTED_DIR = Path(__file__).resolve().parent
MUTABLE_FILES = (
    "src/btree.c", "src/expr.c", "src/main.c", "src/pager.c",
    "src/select.c", "src/sqliteInt.h", "src/vdbe.c", "src/vdbeapi.c",
    "src/vdbesort.c", "src/where.c", "src/wherecode.c",
)
SEED_EXCLUDE = frozenset({".gitdir", "eval.py", "worker.py", "__pycache__"})


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
    # Seed the FULL pinned baseline from the trusted capsule directory so the
    # sanitized terminal artifact (which carries only the mutable files) still
    # builds: configure/Makefile*/test/tool/bench.c always come from the
    # trusted seed, and ONLY the mutable source files are overlaid from the
    # candidate workspace.
    def ignore_seed(directory: str, names: list[str]) -> set[str]:
        if Path(directory) == TRUSTED_DIR:
            return {name for name in names if name in SEED_EXCLUDE}
        return {name for name in names if name == "__pycache__"}

    try:
        shutil.copytree(TRUSTED_DIR, source, symlinks=False, ignore=ignore_seed)
        for relative in MUTABLE_FILES:
            candidate = workspace / relative
            if not candidate.is_file():
                return {
                    "ok": False,
                    "stage": "prepare",
                    "detail": f"missing mutable source file: {relative}",
                }
            shutil.copyfile(candidate, source / relative)
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


def benchmark(binary: Path, database: Path, state_dir: Path) -> dict:
    environment = os.environ.copy()
    environment["HOME"] = str(state_dir)
    environment["TMPDIR"] = str(state_dir)
    try:
        process = subprocess.Popen(
            [str(binary), str(database), "sort"],
            cwd=state_dir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=60)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            return {"ok": False, "stage": "benchmark", "detail": "sample timed out"}
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    except OSError as exc:
        return {"ok": False, "stage": "benchmark", "detail": str(exc)}
    if process.returncode != 0:
        detail = stderr.decode("utf-8", "replace")[-1000:]
        return {"ok": False, "stage": "benchmark", "detail": f"exit {process.returncode}: {detail}"}
    try:
        output = stdout.decode("ascii").strip()
    except UnicodeDecodeError:
        return {"ok": False, "stage": "benchmark", "detail": "non-ASCII output"}
    return {
        "ok": True,
        "stage": "benchmark",
        "output": output,
    }


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in {"prepare", "build", "test", "benchmark"}:
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
    elif action == "benchmark":
        if len(sys.argv) != 5:
            raise SystemExit(64)
        binary = Path(sys.argv[2]).resolve()
        database = Path(sys.argv[3]).resolve()
        state_dir = Path(sys.argv[4]).resolve()
        if not binary.is_file() or not database.is_file() or not state_dir.is_dir():
            raise SystemExit(64)
        output = benchmark(binary, database, state_dir)
    else:
        if len(sys.argv) != 3:
            raise SystemExit(64)
        source = Path(sys.argv[2]).resolve()
        if not source.is_dir():
            raise SystemExit(64)
        output = build(source) if action == "build" else test(source)
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(0 if output["ok"] else 1)


if __name__ == "__main__":
    main()
