#!/usr/bin/env python3
"""Unprivileged build, upstream-test, and benchmark worker for zstd-codec."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TIMEOUT_SEC = 180


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
    commands = [
        [
            "make", "-C", "lib", "-j2", "libzstd.a-mt", "CFLAGS=-O2 -DNDEBUG",
        ],
        [
            "cc", "-O2", "-DNDEBUG", "-std=c99", "-Wall", "-Wextra", "-Werror",
            "-I.", "bench.c", "lib/libzstd.a", "-pthread", "-o", "hone-zstd-bench",
        ],
        [
            "make", "-C", "tests", "-j2", "fuzzer",
            "ZSTDMT_OBJECTS=../lib/libzstd.a", "ZDICT_FILES=",
        ],
    ]
    for command in commands:
        ok, detail = run_quiet(command, source)
        if not ok:
            return {"ok": False, "stage": "build", "detail": detail}
    return {"ok": True, "stage": "build"}


def test(source: Path) -> dict:
    commands = [["./tests/fuzzer", "-i100", "-s1337"]]
    for command in commands:
        ok, detail = run_quiet(command, source, timeout=90)
        if not ok:
            return {"ok": False, "stage": "upstream_tests", "detail": detail}
    return {"ok": True, "stage": "upstream_tests", "commands": [
        "make -C tests -j2 fuzzer ZSTDMT_OBJECTS=../lib/libzstd.a ZDICT_FILES=",
        "tests/fuzzer -i100 -s1337",
    ]}


def main() -> None:
    if len(sys.argv) not in {3, 4} or sys.argv[1] not in {"prepare", "build", "test"}:
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
