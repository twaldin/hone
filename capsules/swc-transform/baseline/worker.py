#!/usr/bin/env python3
"""Unprivileged offline build and test worker for the sealed SWC capsule."""
from __future__ import annotations

import json
import os
import resource
import shutil
import subprocess
import sys
from pathlib import Path

TIMEOUT_SEC = 600
PROFILE = "hone"
CRATES = (
    "swc_ecma_parser",
    "swc_ecma_transforms_base",
    "swc_ecma_transforms_typescript",
    "swc_ecma_transforms_react",
)
MUTABLE_ARTIFACT_PREFIXES = (
    "hone_swc_bench-",
    "swc_ecma_parser-",
    "swc_ecma_transforms_base-",
    "swc_ecma_transforms_react-",
    "swc_ecma_transforms_typescript-",
)
TEST_PACKAGES = (
    "swc_ecma_parser",
    "swc_ecma_transforms_base",
    "swc_ecma_transforms_typescript",
    "swc_ecma_transforms_react",
)
def is_mutable_artifact(name: str) -> bool:
    return any(
        name.startswith(prefix) or name.startswith(f"lib{prefix}")
        for prefix in MUTABLE_ARTIFACT_PREFIXES
    )




def enter_candidate(uid: int, gid: int, max_file_bytes: int) -> None:
    os.setsid()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_file_bytes, max_file_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))
    resource.setrlimit(resource.RLIMIT_NPROC, (512, 512))
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def sparse_tree(source: Path, destination: Path) -> None:
    destination.mkdir()
    for directory, directories, files in os.walk(source):
        relative = Path(directory).relative_to(source)
        output = destination / relative
        for name in directories:
            (output / name).mkdir()
        for name in files:
            (output / name).symlink_to(Path(directory) / name)


def replace_with_writable_copy(source: Path, destination: Path) -> None:
    if destination.is_dir() and not destination.is_symlink():
        shutil.rmtree(destination)
    elif destination.exists() or destination.is_symlink():
        destination.unlink()
    shutil.copytree(source, destination, copy_function=shutil.copy2)
    for directory, _, files in os.walk(destination):
        os.chmod(directory, 0o755)
        for name in files:
            os.chmod(Path(directory) / name, 0o644)


def prepare_source(source_base: Path, source: Path) -> dict:
    shutil.copytree(source_base, source, copy_function=shutil.copy2)
    for directory, _, files in os.walk(source):
        os.chmod(directory, 0o755)
        for name in files:
            os.chmod(Path(directory) / name, 0o644)
    return {"ok": True, "stage": "prepare_source"}


def prepare_target(target_base: Path, target: Path, changed: bool) -> dict:
    if changed:
        sparse_tree(target_base, target)
        base_profile = target_base / PROFILE
        profile = target / PROFILE
        replace_with_writable_copy(base_profile / ".fingerprint", profile / ".fingerprint")
        for directory in (base_profile / "build").iterdir():
            if directory.name.startswith(("swc", "hstr", "psm", "stacker")):
                replace_with_writable_copy(directory, profile / "build" / directory.name)
        for lock in target.rglob(".cargo-*lock"):
            lock.unlink()
    else:
        target.symlink_to(target_base, target_is_directory=True)
    return {"ok": True, "stage": "prepare_target"}


def clean_mutable_outputs(target: Path) -> None:
    profile = target / PROFILE
    for artifact in (profile / "deps").iterdir():
        if is_mutable_artifact(artifact.name):
            if artifact.is_dir() and not artifact.is_symlink():
                shutil.rmtree(artifact)
            else:
                artifact.unlink()
    for artifact in profile.glob("hone-swc-bench*"):
        if artifact.is_dir() and not artifact.is_symlink():
            shutil.rmtree(artifact)
        else:
            artifact.unlink()
    incremental = profile / "incremental"
    if incremental.is_dir():
        for entry in incremental.iterdir():
            if is_mutable_artifact(entry.name):
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()


def environment() -> dict[str, str]:
    result = os.environ.copy()
    result.update(
        {
            "CARGO_NET_OFFLINE": "true",
            "HOME": "/tmp/hone-swc-build/home",
            "PATH": "/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin",
            "TMPDIR": "/tmp/hone-swc-build/tmp",
        }
    )
    Path(result["HOME"]).mkdir(exist_ok=True)
    Path(result["TMPDIR"]).mkdir(exist_ok=True)
    return result


def run_command(argv: list[str], root: Path, timeout: int = TIMEOUT_SEC) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        argv,
        cwd=root,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        env=environment(),
    )


def compact_error(completed: subprocess.CompletedProcess[bytes]) -> str:
    stderr = completed.stderr.decode("utf-8", "replace").strip()
    stdout = completed.stdout.decode("utf-8", "replace").strip()
    lines = (stderr or stdout).splitlines()
    return "\n".join(line[-700:] for line in lines[-4:]) or f"exit {completed.returncode}"




def locate_test_binary(target: Path, package: str) -> Path:
    matches = [
        path
        for path in (target / PROFILE / "deps").glob(f"{package}-*")
        if path.is_file() and os.access(path, os.X_OK) and path.suffix != ".d"
    ]
    if len(matches) != 1:
        raise RuntimeError(f"expected one prebuilt {package} test executable, found {len(matches)}")
    return matches[0]




def build_and_test(root: Path, target: Path, changed: bool) -> dict:
    if changed:
        clean_mutable_outputs(target)
        command = [
            "cargo",
            "test",
            "--locked",
            "--offline",
            "--jobs",
            "2",
            "--profile",
            PROFILE,
            "--lib",
            "--no-run",
        ]
        for package in TEST_PACKAGES:
            command.extend(("-p", package))
        compiled_tests = run_command(command, root)
        if compiled_tests.returncode != 0:
            return {
                "ok": False,
                "stage": "transform_test_compile",
                "detail": compact_error(compiled_tests),
            }
        built = run_command(
            [
                "cargo",
                "build",
                "--locked",
                "--offline",
                "--jobs",
                "2",
                "--profile",
                PROFILE,
                "-p",
                "hone-swc-bench",
            ],
            root,
        )
        if built.returncode != 0:
            return {"ok": False, "stage": "build", "detail": compact_error(built)}
    binary = target / PROFILE / "hone-swc-bench"
    if not binary.is_file() or not os.access(binary, os.X_OK):
        return {"ok": False, "stage": "build", "detail": "benchmark executable is missing"}
    try:
        test_binaries = {
            package: str(locate_test_binary(target, package))
            for package in TEST_PACKAGES
        }
    except RuntimeError as exc:
        return {"ok": False, "stage": "transform_test_compile", "detail": str(exc)}
    return {
        "ok": True,
        "stage": "rebuilt" if changed else "prebuilt",
        "binary": str(binary),
        "testBinaries": test_binaries,
        "testPackages": list(TEST_PACKAGES),
    }


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(64)
    action = sys.argv[1]
    try:
        if action == "prepare-source" and len(sys.argv) == 4:
            output = prepare_source(Path(sys.argv[2]), Path(sys.argv[3]))
        elif action == "prepare-target" and len(sys.argv) == 5:
            output = prepare_target(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4] == "1")
        elif action == "build" and len(sys.argv) == 5:
            output = build_and_test(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4] == "1")
        else:
            raise SystemExit(64)
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        output = {"ok": False, "stage": action, "detail": str(exc)}
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(0 if output.get("ok") is True else 1)


if __name__ == "__main__":
    main()
