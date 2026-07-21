#!/usr/bin/env python3
"""Unprivileged build and test worker for the node URL capsule."""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SOURCE = Path("/opt/node")
NODE = SOURCE / "out/Release/node"
TRUSTED_DIR = Path(__file__).resolve().parent
TEST_SENTINEL = TRUSTED_DIR / "test_sentinel.js"
MUTABLE_FILES = (
    "src/node_url.cc",
    "src/node_url.h",
    "lib/internal/url.js",
    "deps/ada/ada.cpp",
    "deps/ada/ada.h",
    "deps/ada/ada_c.h",
)
TEST_GLOBS = ("test-url*", "test-whatwg-url*")
FLAGS_RE = re.compile(r"^//\s*Flags:\s*(.+?)\s*$")
COMPLETION_PREFIX = "HONE_TEST_COMPLETE "
PER_TEST_TIMEOUT = 120
# Frozen per-file inventory of the pinned upstream tree: every file matched by
# the protected test globs, plus whether its body runs to natural event-loop
# completion under this build configuration (files that self-skip exit before
# 'beforeExit' and never emit the completion marker).
EXPECTED_TESTS: dict[str, bool] = {
    "test-url-domain-ascii-unicode.js": True,
    "test-url-fileurltopath.js": True,
    "test-url-format-invalid-input.js": True,
    "test-url-format-whatwg.js": True,
    "test-url-format.js": True,
    "test-url-invalid-file-url-path-input.js": True,
    "test-url-is-url-internal.js": True,
    "test-url-parse-deprecation.js": True,
    "test-url-parse-format.js": True,
    "test-url-parse-invalid-input.js": True,
    "test-url-parse-query.js": True,
    "test-url-pathtofileurl.js": True,
    "test-url-relative.js": True,
    "test-url-revokeobjecturl.js": True,
    "test-url-urltooptions.js": True,
    "test-urlpattern-invalidthis.js": True,
    "test-urlpattern-types.js": True,
    "test-urlpattern.js": True,
    "test-whatwg-url-canparse.js": True,
    "test-whatwg-url-custom-deepequal.js": True,
    "test-whatwg-url-custom-global.js": True,
    "test-whatwg-url-custom-href-side-effect.js": True,
    "test-whatwg-url-custom-inspect.js": False,
    "test-whatwg-url-custom-parsing.js": False,
    "test-whatwg-url-custom-properties.js": True,
    "test-whatwg-url-custom-searchparams-append.js": True,
    "test-whatwg-url-custom-searchparams-constructor.js": True,
    "test-whatwg-url-custom-searchparams-delete.js": True,
    "test-whatwg-url-custom-searchparams-entries.js": True,
    "test-whatwg-url-custom-searchparams-foreach.js": True,
    "test-whatwg-url-custom-searchparams-get.js": True,
    "test-whatwg-url-custom-searchparams-getall.js": True,
    "test-whatwg-url-custom-searchparams-has.js": True,
    "test-whatwg-url-custom-searchparams-inspect.js": True,
    "test-whatwg-url-custom-searchparams-keys.js": True,
    "test-whatwg-url-custom-searchparams-set.js": True,
    "test-whatwg-url-custom-searchparams-sort.js": True,
    "test-whatwg-url-custom-searchparams-stringifier.js": True,
    "test-whatwg-url-custom-searchparams-values.js": True,
    "test-whatwg-url-custom-searchparams.js": True,
    "test-whatwg-url-custom-setters.js": False,
    "test-whatwg-url-custom-tostringtag.js": True,
    "test-whatwg-url-invalidthis.js": True,
    "test-whatwg-url-properties.js": True,
    "test-whatwg-url-override-hostname.js": True,
}


def emit(ok: bool, detail: str, **extra: object) -> None:
    print(json.dumps({"ok": ok, "detail": detail, **extra}, sort_keys=True, separators=(",", ":")))


def worker_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update({
        "HOME": "/tmp/hone-node-home",
        "NODE_TEST_DIR": "/tmp/hone-node-tests",
        "NODE_TEST_NO_INTERNET": "1",
        "TMPDIR": "/opt/node/out/Release/hone-tmp",
        "NO_COLOR": "1",
    })
    for key in ("TMPDIR", "NODE_TEST_DIR", "HOME"):
        Path(env[key]).mkdir(mode=0o700, exist_ok=True)
    return env


def run(command: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        command,
        cwd=SOURCE,
        env=worker_env(),
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
    started = time.monotonic()
    completed = run(command, timeout)
    elapsed = time.monotonic() - started
    if completed.returncode != 0:
        tail = completed.stdout.decode("utf-8", "replace")[-2000:]
        raise RuntimeError(f"{action} failed: {tail}")
    return elapsed


def source_flags(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for _ in range(15):
            line = handle.readline()
            if not line:
                break
            match = FLAGS_RE.match(line)
            if match:
                return match.group(1).split()
    return []


def run_single_test(name: str) -> str | None:
    """Run one URL test bound to a trusted completion marker.

    The sentinel preload emits the marker only after the event loop drained
    naturally with exit code zero, so a test body cut short by an early exit
    cannot count as complete. Returns a failure detail or None.
    """
    path = SOURCE / "test/parallel" / name
    nonce = secrets.token_hex(16)
    env = worker_env()
    env["HONE_TEST_NONCE"] = nonce
    completed = subprocess.run(
        [str(NODE), *source_flags(path), "-r", str(TEST_SENTINEL), str(path)],
        cwd=SOURCE,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=PER_TEST_TIMEOUT,
        check=False,
    )
    if completed.returncode != 0:
        tail = (completed.stdout + b"\n" + completed.stderr).decode("utf-8", "replace")[-400:]
        return f"{name} exited with {completed.returncode}: {tail}"
    marker = f"{COMPLETION_PREFIX}{nonce}".encode() in completed.stderr
    if EXPECTED_TESTS[name] and not marker:
        return f"{name} did not run its body to completion"
    return None


def run_url_tests() -> tuple[float, int]:
    started = time.monotonic()
    checked(
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
    inventory = sorted({
        path.name
        for pattern in TEST_GLOBS
        for path in (SOURCE / "test/parallel").glob(pattern)
        if path.is_file() and path.suffix in {".js", ".mjs"}
    })
    if inventory != sorted(EXPECTED_TESTS):
        raise RuntimeError("URL test inventory does not match the frozen baseline inventory")
    with ThreadPoolExecutor(max_workers=4) as pool:
        failures = [detail for detail in pool.map(run_single_test, inventory) if detail is not None]
    if failures:
        raise RuntimeError("URL test completion gate failed: " + " | ".join(sorted(failures)[:5]))
    return time.monotonic() - started, len(inventory)


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
            seconds, inventory = run_url_tests()
            emit(True, "WHATWG URL tests passed with completion markers", seconds=seconds, inventory=inventory)
        else:
            raise RuntimeError(f"unknown worker action: {action}")
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        emit(False, str(error)[:2000])
        raise SystemExit(1)


if __name__ == "__main__":
    main()
