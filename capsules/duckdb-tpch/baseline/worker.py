#!/usr/bin/env python3
"""Unprivileged build and upstream-test worker for duckdb-tpch."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

BUILD_TIMEOUT_SEC = 2700


def run_quiet(argv: list[str], cwd: Path, timeout: int = BUILD_TIMEOUT_SEC) -> tuple[bool, str]:
    environment = os.environ.copy()
    environment.update({
        "CC": "clang",
        "CXX": "clang++",
        "HOME": str(cwd / ".hone-home"),
        "TMPDIR": str(cwd / ".hone-tmp"),
    })
    Path(environment["HOME"]).mkdir(mode=0o700, exist_ok=True)
    Path(environment["TMPDIR"]).mkdir(mode=0o700, exist_ok=True)
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
        detail = completed.stderr.decode("utf-8", "replace")[-3000:]
        return False, f"exit {completed.returncode}: {detail}"
    return True, "ok"


def prepare(workspace: Path, source: Path) -> dict:
    def ignore(_directory: str, names: list[str]) -> set[str]:
        return {name for name in names if name in {".git", ".gitdir", "__pycache__", "build"}}

    try:
        shutil.copytree(workspace, source, symlinks=False, ignore=ignore, dirs_exist_ok=True)
    except OSError as exc:
        return {"ok": False, "stage": "prepare", "detail": str(exc)}
    return {"ok": True, "stage": "prepare"}


def build(source: Path) -> dict:
    build_dir = source / "build" / "hone-release"
    build_dir.mkdir(parents=True, exist_ok=False)
    configure = [
        "cmake", "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Release",
        "-DCMAKE_C_COMPILER=clang",
        "-DCMAKE_CXX_COMPILER=clang++",
        "-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG",
        "-DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld",
        "-DBUILD_BENCHMARKS=0",
        "-DBUILD_UNITTESTS=1",
        "-DBUILD_SHELL=0",
        "-DBUILD_EXTENSIONS=tpch",
        "-DENABLE_JEMALLOC=OFF",
        "../..",
    ]
    ok, detail = run_quiet(configure, build_dir, timeout=180)
    if not ok:
        return {"ok": False, "stage": "configure", "detail": detail}
    ok, detail = run_quiet(
        [
            "cmake", "--build", ".", "--target", "test_sqlite",
            "test_debug_fs_extension", "test_helpers", "duckdb", "-j8",
        ],
        build_dir,
    )
    if not ok:
        return {"ok": False, "stage": "build", "detail": detail}
    include_dirs = [
        "src/include", "third_party/fsst", "third_party/fmt/include", "third_party/hyperloglog",
        "third_party/fastpforlib", "third_party/skiplist", "third_party/ska_sort",
        "third_party/fast_float", "third_party/re2", "third_party/miniz",
        "third_party/utf8proc/include", "third_party/concurrentqueue", "third_party/pcg",
        "third_party/pdqsort", "third_party/tdigest", "third_party/mbedtls/include",
        "third_party/httplib", "third_party/jaro_winkler", "third_party/vergesort",
        "third_party/yyjson/include", "third_party/zstd/include",
        "build/hone-release/codegen/include", "extension", "extension/tpch/include",
        "extension/core_functions/include", "extension/parquet/include",
        "third_party/catch", "third_party/sqlite/include", "test/include",
        "test/extension/debug_fs/include",
    ]
    slim_test_command = [
        "clang++", "-std=c++17", "-O2", "-DNDEBUG", "-fuse-ld=lld",
        "-DDUCKDB_BUILD_LIBRARY", "-DDUCKDB_EXTENSION_CORE_FUNCTIONS_LINKED=1",
        "-DDUCKDB_EXTENSION_PARQUET_LINKED=1", "-DDUCKDB_EXTENSION_TPCH_LINKED=1",
        f'-DDUCKDB_ROOT_DIRECTORY="{source}"', "-DGENERATED_EXTENSION_HEADERS=1",
        *(f"-I{source / path}" for path in include_dirs),
        str(source / "test" / "unittest.cpp"),
        str(build_dir / "test" / "sqlite" / "CMakeFiles" / "test_sqlite.dir" / "ub_test_sqlite.cpp.o"),
        str(build_dir / "test" / "extension" / "CMakeFiles" / "test_debug_fs_extension.dir" / "debug_fs" / "debug_fs_extension.cpp.o"),
        str(build_dir / "test" / "extension" / "CMakeFiles" / "test_debug_fs_extension.dir" / "debug_fs" / "debug_file_system.cpp.o"),
        str(build_dir / "test" / "extension" / "CMakeFiles" / "test_debug_fs_extension.dir" / "debug_fs" / "io_latency_model.cpp.o"),
        str(build_dir / "test" / "helpers" / "libtest_helpers.a"),
        f"-L{build_dir / 'src'}", "-lduckdb",
        str(build_dir / "third_party" / "re2" / "libduckdb_re2.a"),
        str(build_dir / "third_party" / "mbedtls" / "libduckdb_mbedtls.a"),
        "-latomic", "-ldl", "-Wl,-rpath,$ORIGIN/src",
        "-o", str(build_dir / "hone-unittest"),
    ]
    ok, detail = run_quiet(slim_test_command, source, timeout=180)
    if not ok:
        return {"ok": False, "stage": "slim_unittest", "detail": detail}
    helper_command = [
        "clang++", "-std=c++17", "-O2", "-DNDEBUG",
        *(f"-I{source / path}" for path in include_dirs),
        str(source / "result_hash.cpp"),
        f"-L{build_dir / 'src'}", "-lduckdb", "-fuse-ld=lld",
        "-Wl,-rpath,$ORIGIN/src", "-o", str(build_dir / "hone-query-runner"),
    ]
    ok, detail = run_quiet(helper_command, source, timeout=180)
    if not ok:
        return {"ok": False, "stage": "result_helper", "detail": detail}
    return {"ok": True, "stage": "build"}


def test(source: Path) -> dict:
    binary = source / "build" / "hone-release" / "hone-unittest"
    tests = [
        "test/sql/filter/test_expression_executor_select.test",
        "test/sql/filter/filter_cache.test",
    ]
    for test in tests:
        ok, detail = run_quiet([str(binary), test], source, timeout=180)
        if not ok:
            return {"ok": False, "stage": "planner_executor_tests", "detail": f"{test}: {detail}"}
    return {"ok": True, "stage": "planner_executor_tests", "tests": tests}


def main() -> None:
    if len(sys.argv) not in {3, 4} or sys.argv[1] not in {"prepare", "build", "test"}:
        raise SystemExit(64)
    action = sys.argv[1]
    if action == "prepare":
        if len(sys.argv) != 4:
            raise SystemExit(64)
        output = prepare(Path(sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
    else:
        if len(sys.argv) != 3:
            raise SystemExit(64)
        source = Path(sys.argv[2]).resolve()
        output = build(source) if action == "build" else test(source)
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    raise SystemExit(0 if output["ok"] else 1)


if __name__ == "__main__":
    main()
