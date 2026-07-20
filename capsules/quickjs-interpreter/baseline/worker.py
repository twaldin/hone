#!/usr/bin/env python3
"""Unprivileged build and Test262 worker for quickjs-interpreter."""
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
    environment.update({"LC_ALL": "C.UTF-8", "LANG": "C.UTF-8", "TZ": "UTC", "TMPDIR": str(compiler_tmp)})
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env=environment,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    if completed.returncode != 0:
        output = (completed.stdout + completed.stderr).decode("utf-8", "replace")[-2000:]
        return False, f"exit {completed.returncode}: {output}"
    return True, completed.stdout.decode("utf-8", "replace")[-2000:]


def prepare(workspace: Path, source: Path) -> dict[str, object]:
    try:
        shutil.copytree(workspace, source, symlinks=False)
    except OSError as exc:
        return {"ok": False, "stage": "prepare", "detail": str(exc)}
    return {"ok": True, "stage": "prepare"}


def build(source: Path) -> dict[str, object]:
    commands = [
        ["touch", "repl.c"],
        [
            "make", "-j1", "qjs", "run-test262", "QJSC=/usr/bin/false",
            "CFLAGS=-fwrapv -D_GNU_SOURCE -DCONFIG_VERSION=\\\"2026-06-04\\\" -DHAVE_CLOSEFROM",
        ],
        ["strip", "qjs"],
    ]
    for command in commands:
        ok, detail = run_quiet(command, source)
        if not ok:
            return {"ok": False, "stage": "build", "detail": detail}
    return {"ok": True, "stage": "build"}


def test(source: Path) -> dict[str, object]:
    ok, detail = run_quiet(
        ["./run-test262", "-T", "1", "-c", "test262.conf", "-r", "none"],
        source,
        timeout=90,
    )
    if not ok:
        return {"ok": False, "stage": "test262", "detail": detail}
    return {"ok": True, "stage": "test262", "cases": 6}


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
