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

# The trusted baseline tree ships alongside this worker (mounted read-only at
# /trusted/baseline). Protected build inputs (Makefile, qjs.c, run-test262.c,
# the generated repl.c, ...) are stripped from the candidate mutation artifact,
# so the build source is seeded from this trusted tree and only the mutable
# envelope is overlaid from the candidate workspace.
TRUSTED_DIR = Path(__file__).resolve().parent

# Files a candidate may mutate; every other build input comes from the trusted
# baseline. Mirrors manifest sourceDetails.mutableEnvelope / eval.py.
ALLOWED_MUTABLE_FILES = frozenset(
    {
        "cutils.c",
        "cutils.h",
        "dtoa.c",
        "dtoa.h",
        "libregexp-opcode.h",
        "libregexp.c",
        "libregexp.h",
        "libunicode-table.h",
        "libunicode.c",
        "libunicode.h",
        "list.h",
        "quickjs-atom.h",
        "quickjs-opcode.h",
        "quickjs.c",
        "quickjs.h",
    }
)

# Never seed VCS or cache directories into the build source tree.
SKIP_SEED_ENTRIES = frozenset({".git", ".gitdir", "__pycache__", ".pytest_cache", ".hone-compiler-tmp"})


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
    # Seed the build tree from the trusted baseline so every protected input
    # (Makefile, qjs.c, run-test262.c, repl.c, headers, ...) is always present,
    # then overlay only the mutable-envelope files from the candidate workspace.
    try:
        shutil.copytree(
            TRUSTED_DIR,
            source,
            symlinks=False,
            ignore=shutil.ignore_patterns(*SKIP_SEED_ENTRIES),
        )
        for relative in ALLOWED_MUTABLE_FILES:
            candidate_file = workspace / relative
            if candidate_file.is_symlink() or not candidate_file.is_file():
                continue
            destination = source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate_file, destination)
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
    # Enumerate the frozen Test262 cases actually present in the build tree.
    expected_cases = sorted(
        path.relative_to(source).as_posix()
        for path in (source / "test262" / "test").rglob("*.js")
    )
    if len(expected_cases) != 6 or len(set(expected_cases)) != 6:
        return {
            "ok": False,
            "stage": "test262",
            "detail": f"expected 6 Test262 cases in build tree, found {len(expected_cases)}",
        }
    compiler_tmp = source / ".hone-compiler-tmp"
    try:
        compiler_tmp.mkdir(mode=0o700, exist_ok=True)
    except OSError:
        pass
    environment = os.environ.copy()
    environment.update({"LC_ALL": "C.UTF-8", "LANG": "C.UTF-8", "TZ": "UTC", "TMPDIR": str(compiler_tmp)})
    # Route the per-case report to stdout so run-test262 (a protected source the
    # candidate cannot edit) emits one authenticated "<index>: <case>" receipt
    # per executed case, plus a "Result: <failed>/<count> error(s)" summary on
    # stderr. Binding the gate to these receipts defeats an early _exit(0) that
    # would skip every case while returning a bare zero exit.
    try:
        completed = subprocess.run(
            ["./run-test262", "-T", "1", "-c", "test262.conf", "-r", "-"],
            cwd=source,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=90,
            env=environment,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "stage": "test262", "detail": str(exc)}
    stdout = completed.stdout.decode("utf-8", "replace")
    stderr = completed.stderr.decode("utf-8", "replace")
    if completed.returncode != 0:
        return {
            "ok": False,
            "stage": "test262",
            "detail": f"exit {completed.returncode}: {(stdout + stderr)[-2000:]}",
        }
    executed: list[str] = []
    for line in stdout.splitlines():
        head, separator, rest = line.partition(": ")
        if not separator or not head.isdigit():
            continue
        executed.append(rest.split("  ", 1)[0].strip())
    if sorted(executed) != expected_cases:
        return {
            "ok": False,
            "stage": "test262",
            "detail": f"executed Test262 cases {sorted(executed)} != frozen {expected_cases}",
        }
    summary = next((line.strip() for line in stderr.splitlines() if line.strip().startswith("Result:")), None)
    if summary is None:
        return {"ok": False, "stage": "test262", "detail": "missing Test262 result summary"}
    try:
        counts = summary.split("Result:", 1)[1].split("error", 1)[0].strip()
        failed_text, _, total_text = counts.partition("/")
        failed = int(failed_text.strip())
        total = int(total_text.strip())
    except (ValueError, IndexError):
        return {"ok": False, "stage": "test262", "detail": f"unparseable Test262 summary: {summary}"}
    if failed != 0 or total != 6:
        return {"ok": False, "stage": "test262", "detail": f"Test262 summary reported {summary}"}
    return {"ok": True, "stage": "test262", "cases": total}


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
