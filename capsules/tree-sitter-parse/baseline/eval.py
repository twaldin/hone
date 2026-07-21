#!/usr/bin/env python3
"""Trusted evaluator for OSS-H06 full and incremental Tree-sitter parsing."""
from __future__ import annotations

import hashlib
import json
import math
import os
import resource
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TRUSTED_DIR = Path(__file__).resolve().parent
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
BUILD_ROOT = Path(f"/tmp/hone-tree-sitter-build-{os.getpid()}")
SOURCE = BUILD_ROOT / "source"
OBJECTS = BUILD_ROOT / "objects"
BINARY = OBJECTS / "hone-ts-harness"
REF_SOURCE = BUILD_ROOT / "ref-source"
REF_OBJECTS = BUILD_ROOT / "ref-objects"
REF_BINARY = REF_OBJECTS / "hone-ts-ref-harness"
# Frozen provisional yardstick scale (provisional local qBase; final GCE
# recalibration re-freezes it): a candidate identical to the trusted baseline
# scores this value by construction, independent of host drift.
REFERENCE_NORMALIZATION = 50661657.83045164
SANDBOX_UID = 2000
PROCESS_MEMORY_BYTES = 1792 << 20
BUILD_TIMEOUT_SEC = 180
VERIFY_TIMEOUT_SEC = 60
BENCH_TIMEOUT_SEC = 90
BENCH_TIMED_REPS = 3
OUTPUT_LIMIT = 1 << 20
TREE_SITTER_REVISION = "1ffd612be56259938c47507bbe953af739c7f640"
LANGUAGES = ("javascript", "rust", "python")
EXPECTED_GRAMMAR_REVISIONS = {
    "javascript": "44c892e0be055ac465d5eeddae6d3e194424e7de",
    "rust": "18b0515fca567f5a10aee9978c6d2640e878671a",
    "python": "bffb65a8cfe4e46290331dfef0dbf0ef3679de11",
}


class GateFailure(RuntimeError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def emit_failure(detail: str, result_hash: str = "") -> None:
    safe = detail.replace(str(ASSETS), "<sealed-assets>").replace(str(BUILD_ROOT), "<build>")[:1000]
    output = {
        "valid": False,
        "objectives": {"score": 0.0},
        "constraints": {
            "tests_pass": False,
            "exact_trees_pass": False,
            "edit_results_pass": False,
            "rss_pass": False,
        },
        "perExample": {"aggregate": {"score": 0.0, "feedback": safe}},
        "diagnostics": {
            "summary": safe,
            "quality": 0.0,
            "result_hash": result_hash or hashlib.sha256(safe.encode()).hexdigest(),
        },
    }
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


def demote() -> None:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))
    resource.setrlimit(resource.RLIMIT_AS, (PROCESS_MEMORY_BYTES, PROCESS_MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(SANDBOX_UID)
        os.setuid(SANDBOX_UID)


def regular_files(root: Path) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in list(directories):
            path = current_path / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise GateFailure(f"non-directory entry in candidate: {path.relative_to(root).as_posix()}")
        for name in files:
            path = current_path / name
            mode = path.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise GateFailure(f"non-regular candidate file: {path.relative_to(root).as_posix()}")
            result[path.relative_to(root).as_posix()] = path
    return result


def check_source_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("candidate workspace is missing")
    trusted = regular_files(TRUSTED_DIR)
    candidate = regular_files(WORKSPACE)
    required_mutable = {path for path in trusted if path.startswith("lib/src/")}
    for relative in candidate:
        if relative in trusted or relative.startswith("lib/src/"):
            continue
        raise GateFailure(f"file outside mutable source envelope: {relative}")
    missing = sorted(required_mutable - set(candidate))
    if missing:
        raise GateFailure(f"required runtime source missing: {missing[0]}")
    protected = {
        relative: path
        for relative, path in trusted.items()
        if not relative.startswith("lib/src/") and not relative.startswith(".gitdir/")
    }
    for relative, trusted_path in protected.items():
        candidate_path = candidate.get(relative)
        if candidate_path is None:
            raise GateFailure(f"protected source missing: {relative}")
        if sha256(candidate_path) != sha256(trusted_path):
            raise GateFailure(f"protected source changed: {relative}")


def load_metadata() -> tuple[dict[str, object], Path]:
    metadata_paths = sorted(ASSETS.rglob("workloads.json"))
    if len(metadata_paths) != 1:
        raise GateFailure("selected asset split must contain exactly one workloads.json")
    metadata_path = metadata_paths[0]
    try:
        metadata = json.loads(metadata_path.read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("sealed workload metadata is malformed") from exc
    if not isinstance(metadata, dict) or metadata.get("schemaVersion") != 1:
        raise GateFailure("sealed workload metadata has invalid schema")
    if metadata.get("treeSitterRevision") != TREE_SITTER_REVISION:
        raise GateFailure("sealed Tree-sitter revision mismatch")
    grammars = metadata.get("grammars")
    if not isinstance(grammars, dict) or set(grammars) != set(LANGUAGES):
        raise GateFailure("sealed grammar set is incomplete")
    for language, revision in EXPECTED_GRAMMAR_REVISIONS.items():
        entry = grammars.get(language)
        if not isinstance(entry, dict) or entry.get("revision") != revision:
            raise GateFailure(f"sealed {language} grammar revision mismatch")
    rows = metadata.get("workloads")
    if not isinstance(rows, list) or len(rows) != 6:
        raise GateFailure("sealed workload matrix must contain six rows")
    identities = {(row.get("language"), row.get("id")) for row in rows if isinstance(row, dict)}
    expected_identities = {(language, f"{language}-{variant}") for language in LANGUAGES for variant in (1, 2)}
    if identities != expected_identities:
        raise GateFailure("sealed workload language matrix is incomplete")
    return metadata, metadata_path.parent


def verify_assets(metadata: dict[str, object], split_dir: Path) -> None:
    grammar_hashes = metadata.get("grammarFileHashes")
    if not isinstance(grammar_hashes, dict) or not grammar_hashes:
        raise GateFailure("sealed grammar hashes are missing")
    actual_grammar_files = {
        path.relative_to(split_dir).as_posix(): path
        for path in (split_dir / "grammars").rglob("*")
        if path.is_file()
    }
    if set(actual_grammar_files) != set(grammar_hashes):
        raise GateFailure("sealed grammar file set mismatch")
    for relative, path in actual_grammar_files.items():
        expected = grammar_hashes.get(relative)
        if not isinstance(expected, str) or sha256(path) != expected:
            raise GateFailure(f"sealed grammar hash mismatch: {relative}")

    for row in metadata["workloads"]:
        if not isinstance(row, dict):
            raise GateFailure("sealed workload row is malformed")
        required = {
            "baselinePeakRssKiB",
            "baselinePeakRssSamplesKiB",
            "benchmark",
            "bytes",
            "edit",
            "expected",
            "id",
            "language",
            "path",
            "sha256",
        }
        if set(row) != required:
            raise GateFailure(f"sealed workload fields are invalid: {row.get('id')}")
        path = split_dir / str(row["path"])
        if not path.is_file() or path.stat().st_size != row["bytes"] or sha256(path) != row["sha256"]:
            raise GateFailure(f"sealed workload hash mismatch: {row.get('id')}")
        edit = row["edit"]
        benchmark = row["benchmark"]
        expected = row["expected"]
        if not isinstance(edit, dict) or set(edit) != {"startByte", "oldEndByte", "replacement"}:
            raise GateFailure(f"sealed edit is malformed: {row.get('id')}")
        if not isinstance(benchmark, dict) or set(benchmark) != {"fullIterations", "incrementalIterations"}:
            raise GateFailure(f"sealed benchmark is malformed: {row.get('id')}")
        if not isinstance(expected, dict) or set(expected) != {
            "originalTreeSha256",
            "incrementalTreeSha256",
            "editedFullTreeSha256",
            "changedRangesSha256",
        }:
            raise GateFailure(f"sealed exact-tree oracle is missing: {row.get('id')}")
        if not isinstance(row["baselinePeakRssKiB"], int) or row["baselinePeakRssKiB"] <= 0:
            raise GateFailure(f"sealed RSS baseline is missing: {row.get('id')}")
        if not isinstance(row["baselinePeakRssSamplesKiB"], list) or len(row["baselinePeakRssSamplesKiB"]) != 10:
            raise GateFailure(f"sealed RSS calibration samples are missing: {row.get('id')}")


def run_command(arguments: list[str], timeout: int) -> None:
    identity: dict[str, object] = {}
    if os.geteuid() == 0:
        identity = {"user": SANDBOX_UID, "group": SANDBOX_UID, "extra_groups": ()}
    try:
        with tempfile.TemporaryFile(mode="w+t") as errors:
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=errors,
                cwd=SOURCE,
                text=True,
                start_new_session=True,
                **identity,
            )
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
                raise GateFailure("candidate runtime compilation timed out") from exc
            if process.returncode != 0:
                errors.seek(0)
                detail = errors.read(1000).replace(str(BUILD_ROOT), "<build>")
                raise GateFailure(f"candidate runtime failed to compile: {detail}")
    except OSError as exc:
        raise GateFailure(f"build command failed: {exc}") from exc


def mount_build_tmpfs() -> None:
    BUILD_ROOT.mkdir(mode=0o755)
    completed = subprocess.run(
        ["mount", "-t", "tmpfs", "-o", "size=512m,mode=755,exec,nosuid,nodev", "hone-tree-sitter-build", str(BUILD_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        BUILD_ROOT.rmdir()
        raise GateFailure("trusted build tmpfs mount failed")


def unmount_build_tmpfs() -> None:
    completed = subprocess.run(
        ["umount", str(BUILD_ROOT)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=False,
    )
    if completed.returncode == 0:
        BUILD_ROOT.rmdir()


def prepare_source(split_dir: Path) -> None:
    shutil.copytree(TRUSTED_DIR, SOURCE)
    shutil.rmtree(SOURCE / ".gitdir", ignore_errors=True)
    shutil.rmtree(SOURCE / "lib" / "src")
    shutil.copytree(WORKSPACE / "lib" / "src", SOURCE / "lib" / "src")
    shutil.copytree(split_dir / "grammars", SOURCE / "grammars")
    # Reference yardstick: a pristine copy of the trusted baseline runtime,
    # built and benchmarked inside the SAME evaluation so host frequency and
    # contention drift between evaluations cancels out of the reported score.
    # The candidate workspace never touches this tree.
    shutil.copytree(TRUSTED_DIR, REF_SOURCE)
    shutil.rmtree(REF_SOURCE / ".gitdir", ignore_errors=True)
    shutil.copytree(split_dir / "grammars", REF_SOURCE / "grammars")
    OBJECTS.mkdir(mode=0o777)
    os.chmod(OBJECTS, 0o777)
    REF_OBJECTS.mkdir(mode=0o777)
    os.chmod(REF_OBJECTS, 0o777)
    for root in (SOURCE, REF_SOURCE):
        os.chmod(root, 0o755)
        for path in root.rglob("*"):
            if path.is_dir():
                os.chmod(path, 0o755)
            elif path.is_file():
                os.chmod(path, 0o644)


def compile_source(root: Path, source: Path, output: Path, *extra_flags: str) -> None:
    flags = [
        "cc",
        "-O3",
        "-DNDEBUG",
        "-std=c11",
        "-D_DEFAULT_SOURCE",
        "-D_BSD_SOURCE",
        "-fvisibility=hidden",
        *extra_flags,
        f"-I{root / 'lib/src'}",
        f"-I{root / 'lib/src/wasm'}",
        f"-I{root / 'lib/include'}",
        "-c",
        str(source),
        "-o",
        str(output),
    ]
    run_command(flags, BUILD_TIMEOUT_SEC)


def build_harness() -> float:
    started = time.monotonic()
    for root, objects, binary in ((SOURCE, OBJECTS, BINARY), (REF_SOURCE, REF_OBJECTS, REF_BINARY)):
        compile_source(root, root / "lib/src/lib.c", objects / "runtime.o")
        compile_source(root, root / "harness.c", objects / "harness.o")
        for language in LANGUAGES:
            grammar = root / "grammars" / language / "src"
            compile_source(root, grammar / "parser.c", objects / f"{language}-parser.o")
            compile_source(root, grammar / "scanner.c", objects / f"{language}-scanner.o")
        run_command(["cc", *[str(path) for path in sorted(objects.glob("*.o"))], "-o", str(binary)], BUILD_TIMEOUT_SEC)
    return time.monotonic() - started


def run_sandbox(arguments: list[str], timeout: int) -> tuple[bytes, resource.struct_rusage]:
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_fd)
            os.dup2(write_fd, 1)
            with open(os.devnull, "wb") as devnull:
                os.dup2(devnull.fileno(), 0)
                os.dup2(devnull.fileno(), 2)
                os.chdir(BUILD_ROOT)
                os.setsid()
                demote()
                os.execv(arguments[0], arguments)
        finally:
            os._exit(127)

    os.close(write_fd)
    os.set_blocking(read_fd, False)
    output = bytearray()
    deadline = time.monotonic() + timeout
    status: int | None = None
    usage: resource.struct_rusage | None = None
    while status is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status, usage = os.wait4(pid, 0)
            os.close(read_fd)
            raise GateFailure("candidate parser process timed out")
        ready, _, _ = select.select([read_fd], [], [], min(0.1, remaining))
        if ready:
            try:
                chunk = os.read(read_fd, 65536)
            except BlockingIOError:
                chunk = b""
            if chunk:
                output.extend(chunk)
                if len(output) > OUTPUT_LIMIT:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.wait4(pid, 0)
                    os.close(read_fd)
                    raise GateFailure("candidate parser emitted excessive output")
        waited, child_status, child_usage = os.wait4(pid, os.WNOHANG)
        if waited == pid:
            status = child_status
            usage = child_usage
    while True:
        try:
            chunk = os.read(read_fd, 65536)
        except BlockingIOError:
            break
        if not chunk:
            break
        output.extend(chunk)
    os.close(read_fd)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0 or usage is None:
        raise GateFailure("candidate parser process failed")
    return bytes(output), usage


def run_workload(row: dict[str, object], split_dir: Path) -> tuple[float, float, float, float, int, dict[str, str]]:
    identifier = str(row["id"])
    replacement = BUILD_ROOT / f"replacement-{identifier}.txt"
    replacement.write_text(str(row["edit"]["replacement"]))
    os.chmod(replacement, 0o444)
    source = BUILD_ROOT / f"workload-{identifier}.txt"
    shutil.copy2(split_dir / str(row["path"]), source)
    os.chmod(source, 0o444)
    output_dir = BUILD_ROOT / f"verify-{identifier}"
    output_dir.mkdir(mode=0o777)
    os.chmod(output_dir, 0o777)
    base = [
        str(row["language"]),
        str(source),
        str(row["edit"]["startByte"]),
        str(row["edit"]["oldEndByte"]),
        str(replacement),
    ]
    verify_output, _ = run_sandbox(
        ["/usr/bin/prlimit", "--nproc=1", "--", str(BINARY), "verify", *base, str(output_dir)],
        VERIFY_TIMEOUT_SEC,
    )
    try:
        verify_payload = json.loads(verify_output)
    except (ValueError, UnicodeDecodeError) as exc:
        raise GateFailure(f"parser test output malformed: {identifier}") from exc
    if verify_payload != {"ok": True, "parserTests": True, "incrementalEqualsFull": True}:
        raise GateFailure(f"parser tests failed: {identifier}")
    observed = {
        "originalTreeSha256": sha256(output_dir / "original.tree"),
        "incrementalTreeSha256": sha256(output_dir / "incremental.tree"),
        "editedFullTreeSha256": sha256(output_dir / "edited-full.tree"),
        "changedRangesSha256": sha256(output_dir / "changed-ranges.txt"),
    }
    if observed != row["expected"]:
        raise GateFailure(f"exact tree/edit oracle mismatch: {identifier}")
    if observed["incrementalTreeSha256"] != observed["editedFullTreeSha256"]:
        raise GateFailure(f"incremental tree differs from full edited parse: {identifier}")

    benchmark = row["benchmark"]
    edit = row["edit"]
    source_bytes = int(row["bytes"])
    edited_bytes = source_bytes - (int(edit["oldEndByte"]) - int(edit["startByte"])) + len(str(edit["replacement"]).encode())
    expected_full_bytes = source_bytes * int(benchmark["fullIterations"])
    expected_incremental_bytes = edited_bytes * int(benchmark["incrementalIterations"])

    # Robustness: host contention and frequency drift only ever add time and
    # neither is candidate-controlled. Candidate and trusted-reference
    # repetitions are interleaved seconds apart, one warm repetition settles
    # the machine, and the fastest timed repetition is kept per phase
    # (trusted trimmed sampling). Byte counters are re-verified against the
    # sealed workload on every repetition.
    candidate_full_ns: list[int] = []
    candidate_incremental_ns: list[int] = []
    reference_full_ns: list[int] = []
    reference_incremental_ns: list[int] = []
    peak_rss_kib = 0
    for rep in range(1 + BENCH_TIMED_REPS):
        ref_full, ref_incremental, _ = run_bench_rep(
            REF_BINARY, f"ref-{rep}", base, benchmark, output_dir, identifier, expected_full_bytes, expected_incremental_bytes
        )
        full_ns, incremental_ns, rep_rss_kib = run_bench_rep(
            BINARY, f"candidate-{rep}", base, benchmark, output_dir, identifier, expected_full_bytes, expected_incremental_bytes
        )
        peak_rss_kib = max(peak_rss_kib, rep_rss_kib)
        if rep > 0:
            reference_full_ns.append(ref_full)
            reference_incremental_ns.append(ref_incremental)
            candidate_full_ns.append(full_ns)
            candidate_incremental_ns.append(incremental_ns)
    full_speed = expected_full_bytes * 1_000_000_000.0 / min(candidate_full_ns)
    incremental_speed = expected_incremental_bytes * 1_000_000_000.0 / min(candidate_incremental_ns)
    reference_full_speed = expected_full_bytes * 1_000_000_000.0 / min(reference_full_ns)
    reference_incremental_speed = expected_incremental_bytes * 1_000_000_000.0 / min(reference_incremental_ns)
    speeds = (full_speed, incremental_speed, reference_full_speed, reference_incremental_speed)
    if not all(math.isfinite(value) and value > 0 for value in speeds):
        raise GateFailure(f"benchmark throughput non-finite: {identifier}")
    baseline_rss_kib = int(row["baselinePeakRssKiB"])
    if peak_rss_kib * 100 > baseline_rss_kib * 102:
        raise GateFailure(f"peak RSS gate failed: {identifier} {peak_rss_kib} KiB > baseline+2%")
    return full_speed, incremental_speed, reference_full_speed, reference_incremental_speed, peak_rss_kib, observed


def run_bench_rep(
    binary: Path,
    label: str,
    base: list[str],
    benchmark: dict[str, object],
    output_dir: Path,
    identifier: str,
    expected_full_bytes: int,
    expected_incremental_bytes: int,
) -> tuple[int, int, int]:
    rss_path = output_dir / f"peak-rss-kib-{label}.txt"
    bench_output, _ = run_sandbox(
        [
            "/usr/bin/time",
            "-f",
            "%M",
            "-o",
            str(rss_path),
            "--",
            "/usr/bin/prlimit",
            "--nproc=1",
            "--",
            str(binary),
            "bench",
            *base,
            str(benchmark["fullIterations"]),
            str(benchmark["incrementalIterations"]),
        ],
        BENCH_TIMEOUT_SEC,
    )
    try:
        payload = json.loads(bench_output)
    except (ValueError, UnicodeDecodeError) as exc:
        raise GateFailure(f"benchmark output malformed: {identifier}") from exc
    if not isinstance(payload, dict) or set(payload) != {"ok", "fullBytes", "fullNs", "incrementalBytes", "incrementalNs"} or payload.get("ok") is not True:
        raise GateFailure(f"benchmark output invalid: {identifier}")
    numeric = [payload.get(key) for key in ("fullBytes", "fullNs", "incrementalBytes", "incrementalNs")]
    if any(not isinstance(value, int) or value <= 0 for value in numeric):
        raise GateFailure(f"benchmark counters invalid: {identifier}")
    # Robustness: recompute both byte counters from the sealed workload row and
    # trusted iteration counts; the harness value is accepted only when it
    # matches exactly, so candidate-linked code cannot inflate throughput by
    # forging counters.
    if payload["fullBytes"] != expected_full_bytes:
        raise GateFailure(f"benchmark full byte counter disagrees with sealed workload: {identifier}")
    if payload["incrementalBytes"] != expected_incremental_bytes:
        raise GateFailure(f"benchmark incremental byte counter disagrees with sealed workload: {identifier}")
    try:
        peak_rss_kib = int(rss_path.read_text().strip())
    except (OSError, ValueError) as exc:
        raise GateFailure(f"benchmark RSS output malformed: {identifier}") from exc
    return payload["fullNs"], payload["incrementalNs"], peak_rss_kib


def geometric_mean(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) or value <= 0 for value in values):
        raise GateFailure("cannot scalarize invalid throughput")
    return math.exp(math.fsum(math.log(value) for value in values) / len(values))


def main() -> None:
    result_hash = ""
    started = time.monotonic()
    try:
        check_source_envelope()
        metadata, split_dir = load_metadata()
        verify_assets(metadata, split_dir)
        mount_build_tmpfs()
        prepare_source(split_dir)
        build_sec = build_harness()
        speeds: list[float] = []
        reference_speeds: list[float] = []
        rss: dict[str, int] = {}
        exact: dict[str, dict[str, str]] = {}
        for row in metadata["workloads"]:
            full, incremental, ref_full, ref_incremental, peak, observed = run_workload(row, split_dir)
            speeds.extend((full, incremental))
            reference_speeds.extend((ref_full, ref_incremental))
            rss[str(row["id"])] = peak
            exact[str(row["id"])] = observed
        raw_q = geometric_mean(speeds)
        reference_q = geometric_mean(reference_speeds)
        # Drift compensation: the trusted in-eval baseline yardstick divides
        # out host frequency/contention state shared by both measurements, so
        # the reported bytes/sec-scale score is comparable across evaluations.
        score = raw_q * REFERENCE_NORMALIZATION / reference_q
        deterministic = {
            "treeSitterRevision": TREE_SITTER_REVISION,
            "grammarRevisions": EXPECTED_GRAMMAR_REVISIONS,
            "splitGenerator": metadata["generator"],
            "exact": exact,
            "parserTests": "full-incremental-equivalence-v1",
        }
        result_hash = hashlib.sha256(canonical(deterministic).encode()).hexdigest()
        elapsed = time.monotonic() - started
        output = {
            "valid": True,
            "objectives": {"score": score},
            "constraints": {
                "tests_pass": True,
                "exact_trees_pass": True,
                "edit_results_pass": True,
                "rss_pass": True,
            },
            "perExample": {
                "aggregate": {
                    "score": score,
                    "feedback": f"12 full/incremental throughput cells passed exact tree, parser-test, edit, and RSS gates; q={score:.3f} bytes/s (reference-normalized; raw {raw_q:.3f}, in-eval trusted baseline {reference_q:.3f})",
                }
            },
            "diagnostics": {
                "summary": "six full/incremental parser-test pairs passed exact tree/edit equivalence and baseline+2% RSS",
                "quality": 1.0,
                "result_hash": result_hash,
                "build_sec": round(build_sec, 6),
                "eval_sec": round(elapsed, 6),
                "peak_rss_kib": rss,
                "raw_q": raw_q,
                "reference_q": reference_q,
            },
        }
        json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
    except GateFailure as exc:
        emit_failure(str(exc), result_hash)
    except Exception as exc:
        emit_failure(f"trusted evaluator error: {type(exc).__name__}", result_hash)
    finally:
        if BUILD_ROOT.exists():
            shutil.rmtree(BUILD_ROOT, ignore_errors=True)
            unmount_build_tmpfs()


if __name__ == "__main__":
    main()
