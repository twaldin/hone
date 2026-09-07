#!/usr/bin/env python3
"""Unprivileged build, upstream-test, and source-staging worker for brotli-codec."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TIMEOUT_SEC = 180
TRUSTED_DIR = Path(__file__).resolve().parent
MUTABLE_PREFIXES = ("c/common/", "c/dec/", "c/enc/")


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
    """Seed the build tree from the FULL trusted baseline, then overlay ONLY
    the mutable candidate files (c/common, c/dec, c/enc). A sanitized terminal
    artifact that omits protected files therefore still reconstructs the
    complete worktree, and a candidate copy of any protected file can never
    reach the build."""
    try:
        shutil.copytree(TRUSTED_DIR, source, symlinks=False)
        for root, _dirs, files in os.walk(workspace):
            for name in files:
                path = Path(root) / name
                relative = path.relative_to(workspace).as_posix()
                if not relative.startswith(MUTABLE_PREFIXES):
                    continue
                if path.is_symlink() or not path.is_file():
                    continue
                destination = source / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, destination)
    except OSError as exc:
        return {"ok": False, "stage": "prepare", "detail": str(exc)}
    return {"ok": True, "stage": "prepare"}


def build(source: Path) -> dict:
    commands = [
        [
            "cmake", "-S", ".", "-B", "build",
            "-DBUILD_SHARED_LIBS=OFF", "-DCMAKE_BUILD_TYPE=Release",
        ],
        ["cmake", "--build", "build", "--parallel", "2"],
        [
            "cc", "-O2", "-DNDEBUG", "-std=c99", "-Wall", "-Wextra", "-Werror",
            "-I.", "-Ic/include", "bench.c", "build/libbrotlienc.a", "build/libbrotlidec.a",
            "build/libbrotlicommon.a", "-lm", "-o", "hone-brotli-bench",
        ],
    ]
    for command in commands:
        ok, detail = run_quiet(command, source)
        if not ok:
            return {"ok": False, "stage": "build", "detail": detail}
    return {"ok": True, "stage": "build"}


def test(source: Path) -> dict:
    command = ["ctest", "--test-dir", "build", "--output-on-failure", "-j2"]
    ok, detail = run_quiet(command, source, timeout=120)
    if not ok:
        return {"ok": False, "stage": "upstream_tests", "detail": detail}
    return {
        "ok": True,
        "stage": "upstream_tests",
        "commands": [
            "cmake -S . -B build -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release",
            "cmake --build build --parallel 2",
            "ctest --test-dir build --output-on-failure -j2",
        ],
    }


def main() -> None:
    if len(sys.argv) not in {3, 4} or sys.argv[1] not in {"prepare", "build", "test"}:
        raise SystemExit(64)
    action = sys.argv[1]
    if action == "prepare":
        if len(sys.argv) != 4:
            raise SystemExit(64)
        output = prepare(Path(sys.argv[2]), Path(sys.argv[3]))
    elif action == "build":
        if len(sys.argv) != 3:
            raise SystemExit(64)
        output = build(Path(sys.argv[2]))
    else:
        if len(sys.argv) != 3:
            raise SystemExit(64)
        output = test(Path(sys.argv[2]))
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(0 if output["ok"] else 1)


if __name__ == "__main__":
    main()
