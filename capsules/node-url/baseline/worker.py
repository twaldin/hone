#!/usr/bin/env python3
"""Unprivileged build and test worker for the node URL capsule."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SOURCE = Path("/opt/node")
MUTABLE_FILES = (
    "src/node_url.cc",
    "src/node_url.h",
    "lib/internal/url.js",
    "deps/ada/ada.cpp",
    "deps/ada/ada.h",
    "deps/ada/ada_c.h",
)


def emit(ok: bool, detail: str, **extra: object) -> None:
    print(json.dumps({"ok": ok, "detail": detail, **extra}, sort_keys=True, separators=(",", ":")))


def run(command: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
    env = dict(os.environ)
    env.update({
        "HOME": "/tmp/hone-node-home",
        "NODE_TEST_DIR": "/tmp/hone-node-tests",
        "NODE_TEST_NO_INTERNET": "1",
        "TMPDIR": "/opt/node/out/Release/hone-tmp",
        "NO_COLOR": "1",
    })
    Path(env["TMPDIR"]).mkdir(mode=0o700, exist_ok=True)
    return subprocess.run(
        command,
        cwd=SOURCE,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )


def prepare(workspace: Path) -> int:
    changed = 0
    for relative in MUTABLE_FILES:
        candidate = workspace / relative
        destination = SOURCE / relative
        if candidate.is_symlink() or not candidate.is_file():
            raise RuntimeError(f"mutable source file is missing or not regular: {relative}")
        if destination.is_symlink() or not destination.is_file():
            raise RuntimeError(f"trusted build source is malformed: {relative}")
        candidate_bytes = candidate.read_bytes()
        if candidate_bytes != destination.read_bytes():
            destination.write_bytes(candidate_bytes)
            changed += 1
    return changed


def checked(action: str, command: list[str], timeout: int) -> float:
    import time

    started = time.monotonic()
    completed = run(command, timeout)
    elapsed = time.monotonic() - started
    if completed.returncode != 0:
        tail = completed.stdout.decode("utf-8", "replace")[-2000:]
        raise RuntimeError(f"{action} failed: {tail}")
    return elapsed


def main() -> None:
    try:
        if len(sys.argv) < 2:
            raise RuntimeError("missing worker action")
        action = sys.argv[1]
        if action == "prepare":
            if len(sys.argv) != 3:
                raise RuntimeError("prepare requires the candidate workspace")
            changed = prepare(Path(sys.argv[2]))
            emit(True, "candidate mutable files staged", changed=changed)
        elif action == "build":
            seconds = checked("incremental ninja build", ["ninja", "-C", "out/Release", "node", "-j4"], 600)
            emit(True, "incremental node build passed", seconds=seconds)
        elif action == "test":
            seconds = checked(
                "WHATWG URL tests",
                [
                    "python3",
                    "tools/test.py",
                    "--mode=release",
                    "parallel/test-url*",
                    "parallel/test-whatwg-url*",
                ],
                600,
            )
            emit(True, "WHATWG URL tests passed", seconds=seconds)
        else:
            raise RuntimeError(f"unknown worker action: {action}")
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        emit(False, str(error)[:2000])
        raise SystemExit(1)


if __name__ == "__main__":
    main()
