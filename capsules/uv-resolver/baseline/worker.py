#!/usr/bin/env python3
"""Unprivileged offline build and resolver-test worker for the uv capsule."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TIMEOUT_SEC = 540
PROFILES = ("profiling",)
WORKSPACE_ARTIFACT_PREFIXES = (
    "libuv_cli-",
    "libuv_dispatch-",
    "libuv_requirements-",
    "libuv_resolver-",
    "libuv_scripts-",
    "libuv_settings-",
    "libuv_tool-",
    "uv_cli-",
    "uv_dispatch-",
    "uv_requirements-",
    "uv_resolver-",
    "uv_scripts-",
    "uv_settings-",
    "uv_tool-",
    "uv-",
)


def sparse_tree(source: Path, destination: Path) -> None:
    destination.mkdir()
    for directory, directories, files in os.walk(source):
        relative = Path(directory).relative_to(source)
        output = destination / relative
        for name in directories:
            (output / name).mkdir()
        for name in files:
            (output / name).symlink_to(Path(directory) / name)


def replace_with_copy(source: Path, destination: Path) -> None:
    if destination.is_dir() and not destination.is_symlink():
        shutil.rmtree(destination)
    elif destination.exists() or destination.is_symlink():
        destination.unlink()
    if source.is_dir():
        shutil.copytree(source, destination, copy_function=shutil.copy2)
    else:
        shutil.copy2(source, destination)


def prepare(target_base: Path, target: Path, source_base: Path, source: Path) -> dict:
    sparse_tree(target_base, target)
    shutil.copytree(source_base, source, copy_function=shutil.copy2)
    for lock in target.rglob(".cargo-*lock"):
        lock.unlink()
    for profile in PROFILES:
        base_profile = target_base / profile
        profile_dir = target / profile
        replace_with_copy(base_profile / ".fingerprint", profile_dir / ".fingerprint")
        for build_dir in (base_profile / "build").glob("uv-*"):
            replace_with_copy(build_dir, profile_dir / "build" / build_dir.name)
        for artifact in (base_profile / "deps").iterdir():
            if "uv_cli" in artifact.name or "uv_resolver" in artifact.name:
                replace_with_copy(artifact, profile_dir / "deps" / artifact.name)
    return {"ok": True, "stage": "prepare"}


def clean_workspace_outputs(target: Path) -> None:
    for profile in PROFILES:
        profile_dir = target / profile
        for artifact in (profile_dir / "deps").iterdir():
            if artifact.is_symlink() and artifact.name.startswith(WORKSPACE_ARTIFACT_PREFIXES):
                artifact.unlink()
        for artifact in profile_dir.glob("uv*"):
            if artifact.is_symlink() or artifact.is_file():
                artifact.unlink()
        incremental = profile_dir / "incremental"
        if incremental.is_dir():
            for entry in incremental.iterdir():
                if entry.name.startswith("uv_"):
                    if entry.is_dir() and not entry.is_symlink():
                        shutil.rmtree(entry)
                    else:
                        entry.unlink()


def run_command(argv: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess[bytes]:
    environment = os.environ.copy()
    environment.update(
        {
            "CARGO_NET_OFFLINE": "true",
            "HOME": "/tmp/hone-uv-build/home",
            "TMPDIR": "/tmp/hone-uv-build/tmp",
        }
    )
    Path(environment["HOME"]).mkdir(exist_ok=True)
    Path(environment["TMPDIR"]).mkdir(exist_ok=True)
    return subprocess.run(
        argv,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        env=environment,
    )

def compact_error(stderr: bytes) -> str:
    text = stderr.decode("utf-8", "replace").strip()
    lines = text.splitlines()
    if not lines:
        return "command failed without stderr"
    return "\n".join(line[-700:] for line in reversed(lines[-10:]))


def build_and_test(root: Path, target: Path, changed: bool) -> dict:
    if changed:
        clean_workspace_outputs(target)
    if not changed:
        candidates = [
            path
            for path in (target / "profiling/deps").glob("uv_resolver-*")
            if path.is_file() and os.access(path, os.X_OK) and path.suffix != ".d"
        ]
        if len(candidates) != 1:
            return {"ok": False, "stage": "resolver_tests", "detail": "prebuilt test executable missing"}
        tests = run_command([str(candidates[0]), "--test-threads=1", "--quiet"], root, 90)
        if tests.returncode != 0:
            return {
                "ok": False,
                "stage": "resolver_tests",
                "detail": tests.stderr.decode("utf-8", "replace")[-1600:],
            }
        binary = target / "profiling/uv"
        if not binary.is_file() or not os.access(binary, os.X_OK):
            return {"ok": False, "stage": "build", "detail": "prebuilt uv binary missing"}
        return {"ok": True, "stage": "prebuilt_baseline_and_tests", "binary": str(binary), "tests": 65}
    test_build = run_command(
        [
            "cargo",
            "test",
            "--locked",
            "--offline",
            "--jobs",
            "2",
            "-p",
            "uv-resolver",
            "--profile",
            "profiling",
            "--no-run",
        ],
        root,
        TIMEOUT_SEC,
    )
    if test_build.returncode != 0:
        return {
            "ok": False,
            "stage": "resolver_test_build",
            "detail": compact_error(test_build.stderr),
        }
    candidates = [
        path
        for path in (target / "profiling/deps").glob("uv_resolver-*")
        if path.is_file() and os.access(path, os.X_OK) and path.suffix != ".d"
    ]
    if len(candidates) != 1:
        return {"ok": False, "stage": "resolver_tests", "detail": "resolver test executable missing"}
    tests = run_command([str(candidates[0]), "--test-threads=1", "--quiet"], root, 90)
    if tests.returncode != 0:
        return {
            "ok": False,
            "stage": "resolver_tests",
            "detail": tests.stderr.decode("utf-8", "replace")[-1600:],
        }
    build = run_command(
        [
            "cargo",
            "build",
            "--locked",
            "--offline",
            "--jobs",
            "2",
            "--profile",
            "profiling",
            "--bin",
            "uv",
            "--no-default-features",
        ],
        root,
        TIMEOUT_SEC,
    )
    if build.returncode != 0:
        return {
            "ok": False,
            "stage": "build",
            "detail": compact_error(build.stderr),
        }
    binary = target / "profiling/uv"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        return {"ok": False, "stage": "build", "detail": "uv binary missing"}
    return {"ok": True, "stage": "build_and_test", "binary": str(binary), "tests": 65}


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(64)
    action = sys.argv[1]
    try:
        if action == "prepare" and len(sys.argv) == 6:
            output = prepare(*(Path(value) for value in sys.argv[2:]))
        elif action == "build" and len(sys.argv) == 5:
            output = build_and_test(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4] == "1")
        else:
            raise SystemExit(64)
    except (OSError, subprocess.SubprocessError) as exc:
        output = {"ok": False, "stage": action, "detail": str(exc)}
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(0 if output.get("ok") is True else 1)


if __name__ == "__main__":
    main()
