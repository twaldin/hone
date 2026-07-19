#!/usr/bin/env python3
"""Trusted offline evaluator for the terminal swc-project/swc transform capsule."""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import re
import resource
import selectors
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

TRUSTED_DIR = Path(__file__).resolve().parent
WORKER = TRUSTED_DIR / "worker.py"
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace")).resolve()
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets")).resolve()
BUILD_ROOT = Path("/tmp/hone-swc-build")
TARGET_BASE = Path("/opt/swc-target-base")
TARGET = BUILD_ROOT / "target"
SOURCE_BASE = Path("/opt/swc-src-base")
SOURCE = BUILD_ROOT / "src"
UPSTREAM_ROOT = Path("/opt/swc-root")
CORPUS = BUILD_ROOT / "corpus"
ORACLE_DIR = BUILD_ROOT / "oracle"
ORACLE_PATH = ORACLE_DIR / "output.js"
ORACLE_BINARY = TARGET_BASE / "hone" / "hone-swc-bench"
SANDBOX_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
SANDBOX_GID = SANDBOX_UID
BUILD_TIMEOUT_SEC = 600
PROCESS_TIMEOUT_SEC = 45
MAX_BUILD_FILE = 1024 << 20
MAX_CHILD_OUTPUT = 2 << 20
_LIBC = ctypes.CDLL(None, use_errno=True)
PR_SET_CHILD_SUBREAPER = 36
CLONE_NEWIPC = 0x08000000
CLONE_NEWNET = 0x40000000
Q_FAIL = 0.0
PRIMARY_REPETITIONS = 3
MUTABLE_CRATES = (
    "swc_ecma_parser",
    "swc_ecma_transforms_base",
    "swc_ecma_transforms_typescript",
    "swc_ecma_transforms_react",
)
TEST_INVENTORY = {
    "swc_ecma_parser": (177, 1),
    "swc_ecma_transforms_base": (205, 1),
    "swc_ecma_transforms_typescript": (4, 0),
    "swc_ecma_transforms_react": (289, 45),
}
MUTABLE_PREFIXES = tuple(f"crates/{crate}/src/" for crate in MUTABLE_CRATES)
PROTECTED_TEST_FILES = {
    "crates/swc_ecma_parser/src/parser/tests.rs",
    "crates/swc_ecma_transforms_base/src/hygiene/tests.rs",
    "crates/swc_ecma_transforms_base/src/resolver/tests.rs",
    "crates/swc_ecma_transforms_base/src/tests.rs",
    "crates/swc_ecma_transforms_react/src/display_name/tests.rs",
    "crates/swc_ecma_transforms_react/src/jsx/tests.rs",
    "crates/swc_ecma_transforms_react/src/jsx_self/tests.rs",
    "crates/swc_ecma_transforms_react/src/jsx_src/tests.rs",
    "crates/swc_ecma_transforms_react/src/pure_annotations/tests.rs",
    "crates/swc_ecma_transforms_react/src/refresh/tests.rs",
}
TEST_SYNTAX_TOKEN = re.compile(
    rb"(?<![A-Za-z0-9_])(?:test|tests|rstest|test_case|cfg|cfg_attr|ignore|should_panic|unsafe|extern|used|link_section|init_array|ctor|constructor|macro_rules|concat_idents|paste|dup2|freopen|setvbuf|process|exit|_exit|_Exit|quick_exit|pthread_exit|abort|terminate|setjmp|longjmp|execve|execveat|fexecve|execv|execvp|execvpe|execl|execlp|execle|posix_spawn|libc|nix|asm|global_asm|syscall|dlopen|dlsym)(?![A-Za-z0-9_])"
)
TEST_ATTRIBUTE = re.compile(
    rb"#\s*\[\s*(?:(?:test|rstest|test_case)\b[^\]]*|"
    rb"cfg\s*\([^\]]*(?<![A-Za-z0-9_])test(?![A-Za-z0-9_])[^\]]*\))\s*\]"
)
RUST_ATTRIBUTE_START = re.compile(rb"#\s*!?\s*\[")


def test_syntax_lines(source: bytes) -> tuple[bytes, ...]:
    return tuple(
        line.strip()
        for line in source.splitlines()
        if TEST_SYNTAX_TOKEN.search(line)
    )
def skip_rust_literal(source: bytes, offset: int) -> int | None:
    size = len(source)
    if source.startswith(b"//", offset):
        end = source.find(b"\n", offset + 2)
        return size if end < 0 else end + 1
    if source.startswith(b"/*", offset):
        depth = 1
        index = offset + 2
        while index < size and depth:
            if source.startswith(b"/*", index):
                depth += 1
                index += 2
            elif source.startswith(b"*/", index):
                depth -= 1
                index += 2
            else:
                index += 1
        if depth:
            raise GateFailure("unterminated Rust block comment")
        return index
    raw_start = None
    if source.startswith(b"br", offset):
        raw_start = offset + 2
    elif source.startswith(b"r", offset):
        raw_start = offset + 1
    if raw_start is not None:
        index = raw_start
        while index < size and source[index] == ord("#"):
            index += 1
        if index < size and source[index] == ord('"'):
            suffix = b'"' + (b"#" * (index - raw_start))
            end = source.find(suffix, index + 1)
            if end < 0:
                raise GateFailure("unterminated Rust raw string")
            return end + len(suffix)
    quote_offset = offset
    if (
        offset + 1 < size
        and source[offset : offset + 1] in (b"b", b"c")
        and source[offset + 1] == ord('"')
    ):
        quote_offset += 1
    if quote_offset < size and source[quote_offset] == ord('"'):
        index = quote_offset + 1
        while index < size:
            if source[index] == ord("\\"):
                index += 2
            elif source[index] == ord('"'):
                return index + 1
            else:
                index += 1
        raise GateFailure("unterminated Rust string")
    if offset < size and source[offset] == ord("'"):
        index = offset + 1
        if index < size and source[index] == ord("\\"):
            index += 2
            if index < size and source[index - 1] in (ord("u"), ord("x")):
                while index < min(size, offset + 16) and source[index] != ord("'"):
                    index += 1
        elif index < size:
            lead = source[index]
            width = 1 if lead < 0x80 else 2 if lead < 0xE0 else 3 if lead < 0xF0 else 4
            index += width
        if index < size and source[index] == ord("'"):
            return index + 1
    return None


def skip_rust_space_comments(source: bytes, offset: int) -> int:
    index = offset
    while index < len(source):
        if source[index] in b" \t\r\n":
            index += 1
            continue
        skipped = skip_rust_literal(source, index)
        if skipped is not None and (
            source.startswith(b"//", index) or source.startswith(b"/*", index)
        ):
            index = skipped
            continue
        return index
    return index


def test_item_end(source: bytes, offset: int) -> int:
    index = offset
    parentheses = 0
    brackets = 0
    while index < len(source):
        skipped = skip_rust_literal(source, index)
        if skipped is not None:
            index = skipped
            continue
        byte = source[index]
        if byte == ord("("):
            parentheses += 1
        elif byte == ord(")"):
            parentheses -= 1
        elif byte == ord("["):
            brackets += 1
        elif byte == ord("]"):
            brackets -= 1
        elif byte == ord(";") and parentheses == 0 and brackets == 0:
            return index + 1
        elif byte == ord("{") and parentheses == 0 and brackets == 0:
            depth = 1
            end = index + 1
            while end < len(source) and depth:
                nested = skip_rust_literal(source, end)
                if nested is not None:
                    end = nested
                    continue
                if source[end] == ord("{"):
                    depth += 1
                elif source[end] == ord("}"):
                    depth -= 1
                end += 1
            if depth:
                raise GateFailure("unterminated candidate test block")
            after = skip_rust_space_comments(source, end)
            return after + 1 if after < len(source) and source[after] == ord(";") else end
        index += 1
    raise GateFailure("unterminated candidate test item")


def rust_attribute_end(source: bytes, offset: int) -> int:
    bracket = source.find(b"[", offset)
    if bracket < 0:
        raise GateFailure("malformed Rust attribute")
    depth = 1
    index = bracket + 1
    while index < len(source) and depth:
        skipped = skip_rust_literal(source, index)
        if skipped is not None:
            index = skipped
            continue
        if source[index] == ord("["):
            depth += 1
        elif source[index] == ord("]"):
            depth -= 1
        index += 1
    if depth:
        raise GateFailure("unterminated Rust attribute")
    return index


def active_rust_attributes(source: bytes) -> list[tuple[int, int, int, int, int, bool]]:
    attributes: list[tuple[int, int, int, int, int, bool]] = []
    index = 0
    braces = 0
    parentheses = 0
    brackets = 0
    while index < len(source):
        skipped = skip_rust_literal(source, index)
        if skipped is not None:
            index = skipped
            continue
        attribute = RUST_ATTRIBUTE_START.match(source, index)
        if attribute is not None:
            end = rust_attribute_end(source, index)
            attributes.append(
                (
                    index,
                    end,
                    braces,
                    parentheses,
                    brackets,
                    TEST_ATTRIBUTE.fullmatch(source[index:end]) is not None,
                )
            )
            index = end
            continue
        byte = source[index]
        if byte == ord("{"):
            braces += 1
        elif byte == ord("}"):
            braces -= 1
        elif byte == ord("("):
            parentheses += 1
        elif byte == ord(")"):
            parentheses -= 1
        elif byte == ord("["):
            brackets += 1
        elif byte == ord("]"):
            brackets -= 1
        index += 1
    return attributes


def test_region_hashes(source: bytes) -> tuple[str, ...]:
    attributes = active_rust_attributes(source)
    regions: list[str] = []
    for index, (start, end, braces, parentheses, brackets, is_test) in enumerate(attributes):
        if not is_test:
            continue
        stack_start = start
        previous = index - 1
        while previous >= 0:
            prior_start, prior_end, prior_braces, prior_parentheses, prior_brackets, _ = attributes[previous]
            if (
                (prior_braces, prior_parentheses, prior_brackets) != (braces, parentheses, brackets)
                or skip_rust_space_comments(source, prior_end) != stack_start
            ):
                break
            stack_start = prior_start
            previous -= 1
        digest = sha256_bytes(source[stack_start:test_item_end(source, end)])
        regions.append(f"{braces}:{parentheses}:{brackets}:{digest}")
    return tuple(regions)


ALLOWED_PROTECTED = {
    "LICENSE",
    "UPSTREAM_REVISION",
    "challenge.json",
    "eval.py",
    "toolchain.lock.json",
    "worker.py",
}


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def emit_failure(detail: str, result_hash: str = "") -> None:
    safe = detail.replace(str(ASSETS), "<sealed-assets>")[:1200]
    output = {
        "valid": False,
        "objectives": {"score": Q_FAIL},
        "constraints": {
            "tests_pass": False,
            "ast_semantic_hash_pass": False,
            "output_semantic_hash_pass": False,
            "output_size_pass": False,
            "rss_pass": False,
        },
        "perExample": {"aggregate": {"score": Q_FAIL, "feedback": safe}},
        "diagnostics": {
            "quality": 0.0,
            "summary": safe,
            "result_hash": result_hash or sha256_bytes(safe.encode()),
        },
    }
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


def demote(max_processes: int) -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BUILD_FILE, MAX_BUILD_FILE))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(SANDBOX_GID)
        os.setuid(SANDBOX_UID)
    resource.setrlimit(resource.RLIMIT_NPROC, (max_processes, max_processes))


def run_worker(action: str, *arguments: str, timeout: int) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(WORKER), action, *arguments],
            cwd=TRUSTED_DIR,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
            preexec_fn=lambda: demote(512),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateFailure(f"{action} worker failed: {exc}") from exc
    try:
        payload = json.loads(completed.stdout)
    except (UnicodeDecodeError, ValueError) as exc:
        raise GateFailure(f"{action} worker returned malformed output") from exc
    if completed.returncode != 0 or not isinstance(payload, dict) or payload.get("ok") is not True:
        detail = payload.get("detail") if isinstance(payload, dict) else "worker failure"
        raise GateFailure(f"{action} gate failed: {str(detail)[:900]}")
    return payload


def mount_tmpfs(path: Path, options: str, name: str) -> None:
    completed = subprocess.run(
        ["mount", "-t", "tmpfs", "-o", options, name, str(path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        raise GateFailure(f"trusted {name} tmpfs mount failed")


def mount_build_tmpfs() -> None:
    BUILD_ROOT.mkdir(mode=0o755, exist_ok=False)
    try:
        mount_tmpfs(
            BUILD_ROOT,
            "size=3400m,mode=0755,uid=2000,gid=2000,nr_inodes=500000",
            "hone-swc-build",
        )
    except GateFailure:
        BUILD_ROOT.rmdir()
        raise
def remount_build_read_only() -> None:
    completed = subprocess.run(
        ["mount", "-o", "remount,ro,nosuid,nodev", str(BUILD_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        raise GateFailure("trusted build tmpfs read-only remount failed")


def mount_runtime_state() -> list[Path]:
    mounted: list[Path] = []
    specifications = (
        (BUILD_ROOT / "home", "size=16m,mode=0700,uid=2000,gid=2000,nr_inodes=4096", "hone-swc-home"),
        (BUILD_ROOT / "tmp", "size=16m,mode=0700,uid=2000,gid=2000,nr_inodes=4096", "hone-swc-tmp"),
        (ORACLE_DIR, "size=4m,mode=0711,uid=0,gid=0,nr_inodes=32", "hone-swc-oracle"),
    )
    try:
        for path, options, name in specifications:
            mount_tmpfs(path, f"{options},nosuid,nodev,noexec", name)
            mounted.append(path)
    except GateFailure:
        for path in reversed(mounted):
            unmount(path)
        raise
    return mounted




def seal_asset_mount() -> None:
    mount_tmpfs(ASSETS, "size=1m,mode=0700,uid=0,gid=0,nr_inodes=16", "hone-swc-assets-seal")


def unmount(path: Path) -> None:
    subprocess.run(
        ["umount", str(path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
        check=False,
    )


def regular_files(root: Path) -> dict[str, Path]:
    output: dict[str, Path] = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        base = Path(directory)
        for name in directories:
            path = base / name
            if path.is_symlink():
                raise GateFailure(f"candidate symlink rejected: {path.relative_to(root)}")
        for name in files:
            path = base / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink() or not path.is_file():
                raise GateFailure(f"candidate non-regular file rejected: {relative}")
            output[relative] = path
    return output


def apply_candidate() -> tuple[bool, dict[Path, str]]:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    files = regular_files(WORKSPACE)
    for relative in files:
        if relative in ALLOWED_PROTECTED or relative.startswith(MUTABLE_PREFIXES):
            continue
        raise GateFailure(f"file outside mutable transform/parser envelope: {relative}")
    changed = False
    expected: dict[Path, str] = {}
    for crate, prefix in zip(MUTABLE_CRATES, MUTABLE_PREFIXES, strict=True):
        trusted = {
            path.relative_to(SOURCE_BASE / crate).as_posix(): path
            for path in (SOURCE_BASE / crate).rglob("*")
            if path.is_file()
        }
        candidate = {
            relative.removeprefix(prefix): path
            for relative, path in files.items()
            if relative.startswith(prefix)
        }
        protected = {
            relative
            for relative in trusted
            if f"{prefix}{relative}" in PROTECTED_TEST_FILES
        }
        missing = sorted((set(trusted) - protected) - set(candidate))
        extra = sorted(set(candidate) - set(trusted))
        if missing or extra:
            detail = missing[0] if missing else extra[0]
            raise GateFailure(f"mutable {crate} source set mismatch: {detail}")
        for relative, trusted_path in trusted.items():
            full_relative = f"{prefix}{relative}"
            trusted_bytes = trusted_path.read_bytes()
            candidate_path = candidate.get(relative)
            if relative in protected:
                if candidate_path is not None and candidate_path.read_bytes() != trusted_bytes:
                    raise GateFailure(f"protected upstream test changed: {full_relative}")
                candidate_bytes = trusted_bytes
            else:
                assert candidate_path is not None
                candidate_bytes = candidate_path.read_bytes()
                if len(candidate_bytes) > 4 << 20:
                    raise GateFailure(f"mutable source file exceeds 4 MiB: {full_relative}")
                if test_syntax_lines(candidate_bytes) != test_syntax_lines(trusted_bytes):
                    raise GateFailure(f"candidate test/termination syntax changed: {full_relative}")
                if test_region_hashes(candidate_bytes) != test_region_hashes(trusted_bytes):
                    raise GateFailure(f"candidate-controlled test body changed: {full_relative}")
            destination = SOURCE / crate / relative
            if candidate_bytes != trusted_bytes:
                changed = True
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(candidate_bytes)
            expected[destination] = sha256_bytes(candidate_bytes)
    return changed, expected


def verify_source_snapshot(expected: dict[Path, str]) -> None:
    for path, digest in expected.items():
        if not path.is_file() or sha256(path) != digest:
            raise GateFailure(f"compiled source snapshot changed during build: {path.name}")


def freeze_tree(root: Path) -> None:
    if root.is_symlink():
        return
    for directory, directories, files in os.walk(root, topdown=False, followlinks=False):
        base = Path(directory)
        for name in files:
            path = base / name
            if path.is_symlink():
                continue
            os.chmod(path, 0o555 if os.access(path, os.X_OK) else 0o444)
        for name in directories:
            path = base / name
            if path.is_symlink():
                continue
            os.chmod(path, 0o555)
        os.chmod(base, 0o555)


def remount_read_only(root: Path, source: Path | None = None) -> None:
    bind_source = source or root
    for argv in (
        ["mount", "--bind", str(bind_source), str(root)],
        ["mount", "-o", "remount,bind,ro", str(root)],
    ):
        completed = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=10,
            check=False,
        )
        if completed.returncode != 0:
            raise GateFailure(f"trusted read-only remount failed: {root.name}")


def load_assets() -> tuple[str, dict[str, list[dict[str, Any]]], str]:
    selection_files = sorted(ASSETS.rglob("*-selection.json"))
    metadata_files = sorted(ASSETS.rglob("workloads.json"))
    if len(selection_files) != 1 or len(metadata_files) != 2:
        raise GateFailure("selected SWC group must contain two corpora and one selection marker")
    try:
        selection = json.loads(selection_files[0].read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed selection marker is malformed") from exc
    if set(selection) != {"format", "primary"} or selection.get("format") != "swc-transform-selection-v1" or selection.get("primary") not in {"train", "validation"}:
        raise GateFailure("sealed selection marker is invalid")
    expected_keys = {
        "baselineOutputBytes",
        "baselinePeakRssKb",
        "bytes",
        "expectedAstSemanticSha256",
        "expectedOutputSemanticSha256",
        "id",
        "kind",
        "path",
        "sha256",
    }
    corpora: dict[str, list[dict[str, Any]]] = {}
    identity: list[dict[str, Any]] = []
    for metadata_path in metadata_files:
        split = metadata_path.parent.name
        if split not in {"train", "validation"} or split in corpora:
            raise GateFailure("sealed corpus labels are invalid")
        try:
            metadata = json.loads(metadata_path.read_text())
        except (OSError, ValueError) as exc:
            raise GateFailure("sealed workload metadata is malformed") from exc
        if set(metadata) != {"format", "generator", "workloads"} or metadata.get("format") != "swc-transform-workloads-v1":
            raise GateFailure("sealed workload metadata keys are invalid")
        rows = metadata.get("workloads")
        if not isinstance(rows, list) or len(rows) != 3:
            raise GateFailure("sealed workload metadata shape is invalid")
        loaded: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, dict) or set(row) != expected_keys:
                raise GateFailure("sealed workload row keys are invalid")
            if row["id"] in seen or row["kind"] not in {"js", "ts", "tsx"}:
                raise GateFailure("sealed workload identity is invalid")
            seen.add(row["id"])
            source_path = metadata_path.parent / row["path"]
            source_bytes = source_path.read_bytes() if source_path.is_file() else b""
            if (
                len(source_bytes) != row["bytes"]
                or sha256_bytes(source_bytes) != row["sha256"]
                or not isinstance(row["baselineOutputBytes"], int)
                or row["baselineOutputBytes"] <= 0
                or not isinstance(row["baselinePeakRssKb"], int)
                or row["baselinePeakRssKb"] <= 0
            ):
                raise GateFailure(f"sealed workload integrity failed: {split}/{row['id']}")
            loaded.append({**row, "sourceBytes": source_bytes, "split": split})
            identity.append({"split": split, **{key: row[key] for key in sorted(expected_keys)}})
        corpora[split] = loaded
    if set(corpora) != {"train", "validation"}:
        raise GateFailure("both sealed corpus labels are required")
    return selection["primary"], corpora, sha256_bytes(canonical(identity).encode())


def materialize_runtime_corpus(corpora: dict[str, list[dict[str, Any]]]) -> dict[tuple[str, str], Path]:
    CORPUS.mkdir(mode=0o755)
    paths: dict[tuple[str, str], Path] = {}
    for split, rows in corpora.items():
        split_dir = CORPUS / split
        split_dir.mkdir(mode=0o755)
        for index, row in enumerate(rows):
            extension = row["kind"]
            path = split_dir / f"case-{index}.{extension}"
            path.write_bytes(row["sourceBytes"])
            os.chmod(path, 0o444)
            paths[(split, row["id"])] = path
        os.chmod(split_dir, 0o555)
    os.chmod(CORPUS, 0o555)
    return paths


def clear_directory(root: Path, preserve: set[str] | None = None) -> None:
    preserved = preserve or set()
    for entry in root.iterdir():
        if entry.name in preserved:
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()


def clear_sandbox_state() -> None:
    clear_directory(Path("/tmp"), {BUILD_ROOT.name})
    clear_directory(Path("/dev/shm"))
    for root in (BUILD_ROOT / "home", BUILD_ROOT / "tmp"):
        clear_directory(root)
        os.chmod(root, 0o700)


def set_sandbox_process_policy() -> None:
    if _LIBC.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise GateFailure("trusted subreaper setup failed")


def isolate_child() -> None:
    if _LIBC.unshare(CLONE_NEWIPC | CLONE_NEWNET) != 0:
        raise OSError(ctypes.get_errno(), "sandbox namespace setup failed")


def reap_sandbox_processes() -> None:
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text(errors="replace")
        except OSError:
            continue
        uid_line = next((line for line in status.splitlines() if line.startswith("Uid:")), "")
        values = uid_line.split()
        if len(values) >= 2 and values[1] == str(SANDBOX_UID):
            try:
                os.kill(int(entry.name), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        try:
            waited, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if waited == 0:
            time.sleep(0.005)


def run_child(
    argv: list[str],
    *,
    timeout: int,
    environment: dict[str, str] | None = None,
    cwd: Path | None = None,
    max_processes: int,
) -> tuple[bytes, int, int]:
    clear_sandbox_state()
    read_fd, write_fd = os.pipe()
    os.set_blocking(read_fd, False)
    started = time.monotonic_ns()
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            devnull = os.open(os.devnull, os.O_RDWR)
            os.dup2(devnull, 0)
            os.dup2(write_fd, 1)
            os.dup2(write_fd, 2)
            os.close(read_fd)
            if write_fd > 2:
                os.close(write_fd)
            if devnull > 2:
                os.close(devnull)
            if cwd is not None:
                os.chdir(cwd)
            isolate_child()
            demote(max_processes)
            child_environment = {
                "HOME": str(BUILD_ROOT / "home"),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "PATH": "/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin",
                "TMPDIR": str(BUILD_ROOT / "tmp"),
                "CARGO_NET_OFFLINE": "true",
                "CARGO_HOME": "/usr/local/cargo",
                "RUSTUP_HOME": "/usr/local/rustup",
                "RUSTUP_TOOLCHAIN": "nightly-2026-04-10",
            }
            if environment:
                child_environment.update(environment)
            os.execve(argv[0], argv, child_environment)
        except BaseException:
            os._exit(127)
    os.close(write_fd)
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    selector.register(read_fd, selectors.EVENT_READ)
    output = bytearray()
    status: int | None = None
    usage = None
    while time.monotonic() < deadline:
        waited, current_status, current_usage = os.wait4(pid, os.WNOHANG)
        if waited == pid:
            status, usage = current_status, current_usage
        for _, _ in selector.select(0.01):
            try:
                chunk = os.read(read_fd, 65536)
            except BlockingIOError:
                chunk = b""
            if chunk:
                output.extend(chunk)
                if len(output) > MAX_CHILD_OUTPUT:
                    status = status if status is not None else -1
                    break
        if len(output) > MAX_CHILD_OUTPUT or status is not None:
            break
    if status is None or len(output) > MAX_CHILD_OUTPUT:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if status is None:
            try:
                _, status, usage = os.wait4(pid, 0)
            except ChildProcessError:
                pass
        selector.close()
        os.close(read_fd)
        reap_sandbox_processes()
        if len(output) > MAX_CHILD_OUTPUT:
            raise GateFailure("candidate process output exceeded 2 MiB")
        raise GateFailure("candidate process timed out")
    drain_deadline = time.monotonic() + 0.1
    while time.monotonic() < drain_deadline:
        try:
            chunk = os.read(read_fd, 65536)
        except BlockingIOError:
            time.sleep(0.001)
            continue
        if not chunk:
            break
        output.extend(chunk)
        if len(output) > MAX_CHILD_OUTPUT:
            break
    selector.close()
    os.close(read_fd)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    reap_sandbox_processes()
    if len(output) > MAX_CHILD_OUTPUT:
        raise GateFailure("candidate process output exceeded 2 MiB")
    exit_code = os.waitstatus_to_exitcode(status)
    if exit_code != 0:
        raise GateFailure(f"candidate process exited {exit_code}")
    elapsed_ns = time.monotonic_ns() - started
    peak_rss_kb = int(usage.ru_maxrss) if usage is not None else 0
    return bytes(output), elapsed_ns, peak_rss_kb


def run_transform_tests(built: dict[str, Any]) -> None:
    binaries = built.get("testBinaries")
    if not isinstance(binaries, dict) or set(binaries) != set(built.get("testPackages", [])):
        raise GateFailure("compiled transform-test inventory is invalid")
    for package in built["testPackages"]:
        binary = str(Path(binaries[package]))
        output, _, _ = run_child(
            [binary, "--test-threads=1", "--quiet"],
            timeout=180,
            cwd=UPSTREAM_ROOT,
            environment={
                "CARGO_MANIFEST_DIR": str(UPSTREAM_ROOT / "crates" / package),
                "CARGO_WORKSPACE_DIR": str(UPSTREAM_ROOT),
            },
            max_processes=64,
        )
        passed, ignored = TEST_INVENTORY[package]
        summaries = [
            line.strip()
            for line in output.splitlines()
            if line.strip().startswith(b"test result:")
        ]
        expected = re.compile(
            (
                rf"test result: ok\. {passed} passed; 0 failed; {ignored} ignored; "
                r"0 measured; 0 filtered out; finished in [0-9]+(?:\.[0-9]+)?s"
            ).encode()
        )
        if len(summaries) != 1 or expected.fullmatch(summaries[0]) is None:
            raise GateFailure(f"upstream transform test inventory mismatch: {package}")
    binary = str(Path(built["binary"]))
    output, _, _ = run_child([binary, "selftest"], timeout=30, max_processes=1)
    if output.strip() != b"selftest: 3 parse+transform cases passed":
        raise GateFailure("protected transform self-test completion missing")


def verify_observation(row: dict[str, Any], payload: object, peak_rss_kb: int) -> dict[str, Any]:
    expected_fields = {
        "astSemanticSha256",
        "id",
        "outputBytes",
        "outputCode",
        "outputSemanticSha256",
        "sourceSha256",
    }
    if not isinstance(payload, dict) or set(payload) != expected_fields or payload.get("id") != "sealed":
        raise GateFailure(f"transform observation shape failed: {row['id']}")
    if payload["sourceSha256"] != row["sha256"]:
        raise GateFailure(f"source hash gate failed: {row['id']}")
    if payload["astSemanticSha256"] != row["expectedAstSemanticSha256"]:
        raise GateFailure(f"AST semantic hash gate failed: {row['id']}")
    output_code = payload["outputCode"]
    if not isinstance(output_code, str):
        raise GateFailure(f"emitted output payload failed: {row['id']}")
    output_bytes = len(output_code.encode())
    if payload["outputBytes"] != output_bytes or output_bytes * 100 > row["baselineOutputBytes"] * 101:
        raise GateFailure(f"output size gate failed: {row['id']}")
    oracle_path = ORACLE_PATH
    oracle_path.write_text(output_code)
    os.chmod(oracle_path, 0o444)
    try:
        oracle_output, _, _ = run_child(
            [str(ORACLE_BINARY), "output-hash", str(oracle_path)],
            timeout=PROCESS_TIMEOUT_SEC,
            max_processes=1,
        )
        oracle_hash = oracle_output.decode("ascii", "strict").strip()
    finally:
        oracle_path.unlink(missing_ok=True)
    if (
        payload["outputSemanticSha256"] != row["expectedOutputSemanticSha256"]
        or oracle_hash != row["expectedOutputSemanticSha256"]
    ):
        raise GateFailure(f"output semantic hash gate failed: {row['id']}")
    rss_limit = math.floor(row["baselinePeakRssKb"] * 1.02)
    if peak_rss_kb <= 0 or peak_rss_kb > rss_limit:
        raise GateFailure(f"RSS gate failed for {row['id']}: {peak_rss_kb} KiB > {rss_limit} KiB")
    return {
        key: payload[key]
        for key in expected_fields
        if key != "outputCode"
    }


def geometric_mean(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("benchmark timing samples are invalid")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def evaluate_corpora(
    binary: str,
    primary: str,
    corpora: dict[str, list[dict[str, Any]]],
    paths: dict[tuple[str, str], Path],
) -> tuple[float, dict[str, Any], int, list[dict[str, Any]]]:
    timings: dict[str, Any] = {}
    primary_samples: list[float] = []
    maximum_rss = 0
    deterministic: list[dict[str, Any]] = []
    for split in ("train", "validation"):
        repetitions = PRIMARY_REPETITIONS if split == primary else 1
        for row in corpora[split]:
            samples: list[float] = []
            first_observation: dict[str, Any] | None = None
            for _ in range(repetitions):
                output, elapsed_ns, peak_rss_kb = run_child(
                    [binary, "once", str(paths[(split, row["id"])]), row["kind"]],
                    timeout=PROCESS_TIMEOUT_SEC,
                    max_processes=1,
                )
                try:
                    payload = json.loads(output)
                except (UnicodeDecodeError, ValueError) as exc:
                    raise GateFailure(f"transform observation is malformed: {row['id']}") from exc
                observation = verify_observation(row, payload, peak_rss_kb)
                first_observation = first_observation or observation
                samples.append(float(elapsed_ns))
                maximum_rss = max(maximum_rss, peak_rss_kb)
            timings[f"{split}/{row['id']}"] = {"nanoseconds": samples}
            if split == primary:
                primary_samples.extend(samples)
            deterministic.append({"split": split, "id": row["id"], "observation": first_observation})
    q = 1_000_000_000.0 / geometric_mean(primary_samples)
    if not math.isfinite(q) or q <= Q_FAIL:
        raise GateFailure("oriented transform scalar is invalid")
    return q, timings, maximum_rss, deterministic


def main() -> None:
    build_mounted = False
    assets_sealed = False
    frozen_mounts: list[Path] = []
    state_mounts: list[Path] = []
    result_hash = ""
    started = time.monotonic()
    try:
        set_sandbox_process_policy()
        primary, corpora, result_hash = load_assets()
        seal_asset_mount()
        assets_sealed = True
        mount_build_tmpfs()
        build_mounted = True
        run_worker("prepare-source", str(SOURCE_BASE), str(SOURCE), timeout=45)
        changed, expected_source = apply_candidate()
        run_worker(
            "prepare-target",
            str(TARGET_BASE),
            str(TARGET),
            "1" if changed else "0",
            timeout=90,
        )
        build_started = time.monotonic()
        built = run_worker(
            "build",
            str(UPSTREAM_ROOT),
            str(TARGET),
            "1" if changed else "0",
            timeout=BUILD_TIMEOUT_SEC,
        )
        build_sec = time.monotonic() - build_started
        verify_source_snapshot(expected_source)
        freeze_tree(SOURCE)
        remount_read_only(SOURCE)
        frozen_mounts.append(SOURCE)
        if TARGET.is_symlink():
            TARGET.unlink()
            TARGET.mkdir()
            remount_read_only(TARGET, TARGET_BASE)
        else:
            freeze_tree(TARGET)
            remount_read_only(TARGET)
        frozen_mounts.append(TARGET)
        runtime_paths = materialize_runtime_corpus(corpora)
        (BUILD_ROOT / "home").mkdir(mode=0o700, exist_ok=True)
        (BUILD_ROOT / "tmp").mkdir(mode=0o700, exist_ok=True)
        ORACLE_DIR.mkdir(mode=0o700)
        os.chmod(BUILD_ROOT, 0o555)
        remount_build_read_only()
        state_mounts = mount_runtime_state()
        run_transform_tests(built)
        binary = str(Path(built["binary"]))
        q, timings, peak_rss_kb, deterministic = evaluate_corpora(
            binary, primary, corpora, runtime_paths
        )
        result_hash = sha256_bytes(
            canonical(
                {
                    "assetIdentity": result_hash,
                    "testPackages": built["testPackages"],
                    "observations": deterministic,
                }
            ).encode()
        )
        output = {
            "valid": True,
            "objectives": {"score": q},
            "constraints": {
                "tests_pass": True,
                "ast_semantic_hash_pass": True,
                "output_semantic_hash_pass": True,
                "output_size_pass": True,
                "rss_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": q,
                    "feedback": f"primary {primary} parse+transform workloads and the opposite sealed gate corpus passed; q={q:.6f} operations/s",
                }
            },
            "diagnostics": {
                "quality": 1.0,
                "summary": "protected upstream tests plus both sealed semantic/output-size/RSS corpora passed",
                "result_hash": result_hash,
                "build_sec": round(build_sec, 6),
                "peak_rss_kb": peak_rss_kb,
                "runtime_sec": round(time.monotonic() - started, 6),
                "primary": primary,
                "measurements": timings,
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except GateFailure as exc:
        emit_failure(str(exc), result_hash)
    except BaseException as exc:
        emit_failure(f"evaluator internal failure: {type(exc).__name__}", result_hash)
    finally:
        reap_sandbox_processes()
        for state_mount in reversed(state_mounts):
            unmount(state_mount)
        for frozen in reversed(frozen_mounts):
            unmount(frozen)
        if build_mounted:
            unmount(BUILD_ROOT)
            try:
                BUILD_ROOT.rmdir()
            except OSError:
                pass
        if assets_sealed:
            unmount(ASSETS)


if __name__ == "__main__":
    main()
