#!/usr/bin/env python3
"""Unprivileged build and upstream-test worker for mimalloc-allocator."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

TIMEOUT_SEC = 180


def run_quiet(argv: list[str], cwd: Path, timeout: int = TIMEOUT_SEC) -> tuple[bool, str]:
    compiler_tmp = cwd / ".hone-compiler-tmp"
    compiler_tmp.mkdir(mode=0o700, exist_ok=True)
    environment = os.environ.copy()
    environment.update({"TMPDIR": str(compiler_tmp), "LC_ALL": "C.UTF-8", "LANG": "C.UTF-8"})
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


def build(source: Path) -> dict:
    build_dir = source.parent / "build"
    commands = [
        [
            "cmake", "-S", str(source), "-B", str(build_dir), "-G", "Ninja",
            "-DCMAKE_BUILD_TYPE=Release",
            "-DCMAKE_C_FLAGS_RELEASE=-O2 -DNDEBUG -DMI_STAT=1",
            "-DMI_BUILD_SHARED=OFF", "-DMI_BUILD_STATIC=ON", "-DMI_BUILD_OBJECT=OFF",
            "-DMI_BUILD_TESTS=ON",
        ],
        ["cmake", "--build", str(build_dir), "-j2"],
    ]
    for workload in ("single", "multithread", "small", "fragmentation"):
        commands.append([
            "cc", "-O2", "-DNDEBUG", "-DMI_STAT=1", "-std=c11", "-Wall", "-Wextra", "-Werror",
            f"-I{source / 'include'}", f"-I{source / 'hone'}",
            str(source / "hone" / "bench.c"), str(source / "hone" / f"bench-{workload}.c"),
            str(build_dir / "libmimalloc.a"), "-pthread", "-lm", "-o", str(build_dir / f"hone-{workload}"),
        ])
    for command in commands:
        ok, detail = run_quiet(command, source)
        if not ok:
            return {"ok": False, "stage": "build", "detail": detail}
    return {"ok": True, "stage": "build"}


def test(source: Path) -> dict:
    build_dir = source.parent / "build"
    command = [
        "ctest", "--test-dir", str(build_dir),
        "-R", "^test-(api|api-fill|stress)$", "--output-on-failure",
    ]
    ok, detail = run_quiet(command, source, timeout=150)
    if not ok:
        return {"ok": False, "stage": "upstream_tests", "detail": detail}
    return {
        "ok": True,
        "stage": "upstream_tests",
        "command": "ctest --test-dir build -R ^test-(api|api-fill|stress)$ --output-on-failure",
    }


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in {"build", "test"}:
        raise SystemExit(64)
    action = sys.argv[1]
    source = Path(sys.argv[2]).resolve()
    if not source.is_dir():
        raise SystemExit(64)
    output = build(source) if action == "build" else test(source)
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(0 if output["ok"] else 1)


if __name__ == "__main__":
    main()
