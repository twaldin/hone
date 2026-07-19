#!/usr/bin/env python3
"""Trusted offline evaluator for Biome parser/formatter throughput.

The image contains the pinned upstream tree, cargo-vendored dependencies, the
protected benchmark runner, and a prebuilt target seed. Only the four parser /
formatter `src` trees are overlaid from the candidate. Cargo, tests, and the
runner execute as uid 2000, which cannot traverse the root-only asset mount.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

TRUSTED = Path(__file__).resolve().parent
CHALLENGE = json.loads((TRUSTED / "challenge.json").read_text(encoding="utf-8"))
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
UPSTREAM = Path("/opt/biome")
TARGET = Path("/tmp/target")
RUNNER = TARGET / "release/hone_biome_bench"
UID = 2000
GID = 2000
MUTABLE_CRATES = (
    "biome_js_parser",
    "biome_js_formatter",
    "biome_css_parser",
    "biome_css_formatter",
)
Q_FAIL = float(CHALLENGE["qFail"])


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fail(reason: str, *, tests_pass: bool = False, quality: float = 0.0) -> dict:
    return {
        "valid": False,
        "objectives": {"score": Q_FAIL},
        "constraints": {
            "tests_pass": tests_pass,
            "byte_exact": False,
            "diagnostic_hashes": False,
            "idempotent": False,
            "rss_within_limit": False,
        },
        "perExample": {"aggregate": {"score": Q_FAIL, "feedback": reason[:500]}},
        "diagnostics": {"quality": quality, "summary": reason[:1000]},
    }


def drop_privileges() -> None:
    os.setgroups([])
    os.setgid(GID)
    os.setuid(UID)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))


def run_untrusted(
    argv: list[str],
    *,
    cwd: Path | None = None,
    timeout: float,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        timeout=timeout,
        check=False,
        preexec_fn=drop_privileges,
    )


def validate_envelope() -> None:
    mutable_root = WORKSPACE / "mutable"
    if not mutable_root.is_dir() or mutable_root.is_symlink():
        raise RuntimeError("candidate mutable envelope is missing or not a real directory")
    actual = {entry.name for entry in mutable_root.iterdir()}
    if actual != set(MUTABLE_CRATES):
        raise RuntimeError("candidate mutable envelope has missing or unexpected crates")
    total_files = 0
    total_bytes = 0
    for crate in MUTABLE_CRATES:
        root = mutable_root / crate / "src"
        if not root.is_dir() or root.is_symlink():
            raise RuntimeError(f"{crate}/src is missing or not a real directory")
        for path in root.rglob("*"):
            if path.is_symlink():
                raise RuntimeError(f"symlink rejected in {crate}/src")
            if path.is_file():
                total_files += 1
                total_bytes += path.stat().st_size
            elif not path.is_dir():
                raise RuntimeError(f"non-regular entry rejected in {crate}/src")
    if total_files == 0 or total_files > 20000 or total_bytes > 64 * 1024 * 1024:
        raise RuntimeError("candidate mutable envelope exceeds source bounds")


def candidate_matches_baseline() -> bool:
    for crate in MUTABLE_CRATES:
        candidate = WORKSPACE / "mutable" / crate / "src"
        frozen = UPSTREAM / "crates" / crate / "src"
        candidate_files = sorted(
            path.relative_to(candidate) for path in candidate.rglob("*") if path.is_file()
        )
        frozen_files = sorted(
            path.relative_to(frozen) for path in frozen.rglob("*") if path.is_file()
        )
        if candidate_files != frozen_files:
            return False
        for relative in candidate_files:
            if (candidate / relative).read_bytes() != (frozen / relative).read_bytes():
                return False
    return True


def mount_candidate_sources() -> None:
    validate_envelope()
    for crate in MUTABLE_CRATES:
        source = WORKSPACE / "mutable" / crate / "src"
        target = UPSTREAM / "crates" / crate / "src"
        subprocess.run(["mount", "--bind", str(source), str(target)], check=True)


def remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def prepare_build_tree(needs_build: bool) -> dict[str, str]:
    subprocess.run(
        ["mount", "-o", f"remount,size={CHALLENGE['tmpfsSize']},exec", "/tmp"],
        check=True,
    )
    created = run_untrusted(["mkdir", "-p", str(TARGET)], timeout=10)
    if created.returncode != 0:
        raise RuntimeError(f"target directory setup failed: {created.stderr.decode(errors='replace')[:500]}")
    cloned = run_untrusted(
        ["cp", "-as", "/opt/target-seed/.", str(TARGET)],
        timeout=60,
    )
    if cloned.returncode != 0:
        raise RuntimeError(f"target seed clone failed: {cloned.stderr.decode(errors='replace')[:500]}")
    if not needs_build:
        return {
            "PATH": os.environ.get("PATH", ""),
            "HOME": "/tmp",
            "RUSTUP_HOME": "/usr/local/rustup",
            "RUST_BACKTRACE": "0",
        }

    release = TARGET / "release"
    for lock in release.glob(".cargo*lock"):
        remove_path(lock)
    fingerprint = release / ".fingerprint"
    remove_path(fingerprint)
    fingerprint_copy = run_untrusted(
        ["cp", "-a", "/opt/target-seed/release/.fingerprint", str(fingerprint)],
        timeout=60,
    )
    if fingerprint_copy.returncode != 0:
        raise RuntimeError(f"fingerprint cache setup failed: {fingerprint_copy.stderr.decode(errors='replace')[:500]}")
    build_cache_metadata = run_untrusted(
        [
            "sh",
            "-c",
            "for name in invoked.timestamp output root-output stderr '*.d'; do "
            "find /tmp/target/release/build -type l -name \"$name\" "
            "-exec sh -c 'for link do src=$(readlink -f \"$link\") || exit; "
            "rm \"$link\" && cp \"$src\" \"$link\" || exit; done' sh {} + || exit; done; "
            "find /tmp/target/release/build -type l -path '*/out/*' "
            "-exec sh -c 'for link do src=$(readlink -f \"$link\") || exit; "
            "rm \"$link\" && cp \"$src\" \"$link\" || exit; done' sh {} +",
        ],
        timeout=60,
    )
    if build_cache_metadata.returncode != 0:
        raise RuntimeError(f"build-script cache setup failed: {build_cache_metadata.stderr.decode(errors='replace')[:500]}")
    depfile_copy = run_untrusted(
        [
            "sh",
            "-c",
            "for link in /tmp/target/release/deps/*.d; do "
            "if [ -L \"$link\" ]; then src=$(readlink -f \"$link\") || exit; "
            "rm \"$link\" && cp \"$src\" \"$link\" || exit; fi; done",
        ],
        timeout=60,
    )
    if depfile_copy.returncode != 0:
        raise RuntimeError(f"dependency cache setup failed: {depfile_copy.stderr.decode(errors='replace')[:500]}")
    rustc_info = TARGET / ".rustc_info.json"
    remove_path(rustc_info)
    rustc_info_copy = run_untrusted(
        ["cp", "-a", "/opt/target-seed/.rustc_info.json", str(rustc_info)],
        timeout=10,
    )
    if rustc_info_copy.returncode != 0:
        raise RuntimeError(f"rustc cache setup failed: {rustc_info_copy.stderr.decode(errors='replace')[:500]}")
    prefixes = (*MUTABLE_CRATES, "hone_biome_bench")
    fingerprint = release / ".fingerprint"
    for prefix in prefixes:
        for path in fingerprint.glob(f"{prefix}-*"):
            remove_path(path)
        for path in (release / "deps").glob(f"{prefix}-*"):
            remove_path(path)
        for path in (release / "deps").glob(f"lib{prefix}-*"):
            remove_path(path)
    for path in release.glob("hone_biome_bench*"):
        remove_path(path)

    cargo_home = Path("/tmp/cargo-home")
    cargo_setup = run_untrusted(
        ["sh", "-c", "mkdir -p /tmp/cargo-home && cp /usr/local/cargo/config.toml /tmp/cargo-home/config.toml"],
        timeout=10,
    )
    if cargo_setup.returncode != 0:
        raise RuntimeError(f"Cargo home setup failed: {cargo_setup.stderr.decode(errors='replace')[:500]}")
    return {
        "PATH": os.environ.get("PATH", ""),
        "HOME": "/tmp",
        "RUSTUP_HOME": "/usr/local/rustup",
        "CARGO_HOME": str(cargo_home),
        "CARGO_TARGET_DIR": str(TARGET),
        "CARGO_NET_OFFLINE": "true",
        "CARGO_INCREMENTAL": "0",
        "CARGO_PROFILE_RELEASE_LTO": "false",
        "RUST_BACKTRACE": "0",
    }


def cargo_failure(stderr: bytes) -> str:
    text = stderr.decode(errors="replace")
    important = []
    for line in text.splitlines():
        lowered = line.strip().lower()
        if lowered.startswith(("error", "fatal")) or any(
            token in lowered for token in ("failed to write", "no space left", "read-only file system", "signal:")
        ):
            important.append(line)
    return "\n".join(important[-20:])[-3000:] or text[-3000:]


def build_and_test(env: dict[str, str], needs_build: bool) -> tuple[bool, str, float]:
    started = time.monotonic()
    if needs_build:
        build = run_untrusted(
            ["cargo", "build", "--locked", "--offline", "--release", "-p", "hone_biome_bench"],
            cwd=UPSTREAM,
            timeout=float(CHALLENGE["buildTimeoutSec"]),
            env=env,
        )
        if build.returncode != 0:
            return False, f"candidate build failed (exit {build.returncode}): {cargo_failure(build.stderr)}", time.monotonic() - started
    tests = run_untrusted(
        [str(RUNNER), "selftest"],
        timeout=float(CHALLENGE["testTimeoutSec"]),
        env=env,
    )
    elapsed = time.monotonic() - started
    if tests.returncode != 0:
        return False, f"upstream-derived parser/formatter regression tests failed (exit {tests.returncode}): {cargo_failure(tests.stderr)}", elapsed
    return True, "upstream-derived JS/TS/CSS parser and formatter regression suite passed", elapsed


def run_timed(argv: list[str], *, timeout: float, work: Path) -> tuple[float, int]:
    rss_file = work / f"rss-{time.monotonic_ns()}"
    command = ["/usr/bin/time", "-f", "%M", "-o", str(rss_file), *argv]
    started = time.perf_counter_ns()
    result = run_untrusted(command, timeout=timeout, stdout=subprocess.DEVNULL)
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
    if result.returncode != 0:
        raise RuntimeError(f"runner failed: {result.stderr.decode(errors='replace')[-500:]}")
    return elapsed_ms, int(rss_file.read_text(encoding="utf-8").strip())
def run_benchmark_timed(argv: list[str], *, timeout: float, work: Path) -> tuple[float, int]:
    rss_file = work / f"rss-{time.monotonic_ns()}"
    command = ["/usr/bin/time", "-f", "%M", "-o", str(rss_file), *argv]
    result = run_untrusted(command, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"runner failed: {result.stderr.decode(errors='replace')[-500:]}")
    fields = result.stdout.decode("ascii", errors="strict").split()
    if len(fields) != 2:
        raise RuntimeError("benchmark runner returned malformed trusted timing")
    elapsed_ns = int(fields[0])
    if elapsed_ns <= 0:
        raise RuntimeError("benchmark runner returned non-positive trusted timing")
    return elapsed_ns / 1_000_000.0, int(rss_file.read_text(encoding="utf-8").strip())




def verify_cases(expected: dict, source_dir: Path, work: Path) -> tuple[list[Path], int]:
    verified: list[Path] = []
    peak_rss = 0
    for name, oracle in sorted(expected["files"].items()):
        source = source_dir / name
        if not source.is_file() or sha256(source) != oracle["inputSha256"]:
            raise RuntimeError(f"frozen input hash mismatch: {name}")
        case = work / name.replace("/", "_")
        case.mkdir(mode=0o777)
        case.chmod(0o777)
        input_copy = case / name
        shutil.copyfile(source, input_copy)
        input_copy.chmod(0o444)
        output = case / "formatted"
        second = case / "second"
        diagnostics = case / "diagnostics"
        _, rss = run_timed(
            [str(RUNNER), "verify", str(input_copy), str(output), str(second), str(diagnostics)],
            timeout=float(CHALLENGE["benchmarkTimeoutSec"]),
            work=case,
        )
        peak_rss = max(peak_rss, rss)
        if output.read_bytes() != second.read_bytes():
            raise RuntimeError(f"idempotence gate failed: {name}")
        if sha256(output) != oracle["formattedSha256"] or output.stat().st_size != oracle["formattedBytes"]:
            raise RuntimeError(f"byte-exact formatting gate failed: {name}")
        if sha256(diagnostics) != oracle["diagnosticSha256"]:
            raise RuntimeError(f"diagnostic hash gate failed: {name}")
        verified.append(input_copy)
    return verified, peak_rss


def benchmark(cases: list[Path], work: Path, initial_peak_rss: int) -> tuple[float, int, dict[str, float]]:
    measurements: dict[str, float] = {}
    peak_rss = initial_peak_rss
    samples = int(CHALLENGE["benchmarkSamples"])
    for source in cases:
        for mode, repetitions_key in (("parse", "parserRepetitions"), ("format", "formatterRepetitions")):
            repetitions = int(CHALLENGE[repetitions_key])
            run_benchmark_timed(
                [str(RUNNER), mode, str(source), str(repetitions)],
                timeout=float(CHALLENGE["benchmarkTimeoutSec"]),
                work=work,
            )
            durations: list[float] = []
            for _ in range(samples):
                elapsed_ms, rss = run_benchmark_timed(
                    [str(RUNNER), mode, str(source), str(repetitions)],
                    timeout=float(CHALLENGE["benchmarkTimeoutSec"]),
                    work=work,
                )
                durations.append(elapsed_ms / repetitions)
                peak_rss = max(peak_rss, rss)
            measurements[f"{source.name}:{mode}"] = statistics.median(durations)
    if not measurements or any(not math.isfinite(value) or value <= 0 for value in measurements.values()):
        raise RuntimeError("non-finite benchmark measurement")
    geometric_ms = math.exp(statistics.fmean(math.log(value) for value in measurements.values()))
    return 1.0 / geometric_ms, peak_rss, measurements


def log(message: str) -> None:
    print(f"hone-biome-eval: {message}", file=sys.stderr, flush=True)


def evaluate() -> dict:
    validate_envelope()
    needs_build = not candidate_matches_baseline()
    log("mounting candidate source envelope")
    mount_candidate_sources()
    log("preparing offline build cache")
    env = prepare_build_tree(needs_build)
    log("building candidate and running upstream-derived regression tests")
    tests_pass, test_detail, build_test_sec = build_and_test(env, needs_build)
    log(f"build/test stage completed in {build_test_sec:.1f}s")
    if not tests_pass:
        return fail(test_detail)
    expected_paths = list(ASSETS.rglob("expected.json"))
    if len(expected_paths) != 1:
        return fail("selected asset group must contain exactly one expected.json", tests_pass=True)
    expected_path = expected_paths[0]
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if expected.get("schema") != "hone-biome-expected-v1" or expected.get("sourceRevision") != CHALLENGE["sourceRevision"]:
        return fail("expected-output oracle identity mismatch", tests_pass=True)
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="hone-work-") as tmp_raw:
        work = Path(tmp_raw)
        work.chmod(0o777)
        log("verifying exact output, diagnostics, and idempotence")
        try:
            cases, peak_rss = verify_cases(expected, expected_path.parent, work)
            log(f"benchmarking {len(cases)} frozen files")
            q, peak_rss, measurements = benchmark(cases, work, peak_rss)
            log("benchmark stage completed")
        except Exception as exc:
            return fail(str(exc), tests_pass=True)
    rss_limit = int(CHALLENGE["rssLimitKb"])
    if peak_rss > rss_limit:
        return fail(
            f"peak RSS {peak_rss} KiB exceeds frozen limit {rss_limit} KiB",
            tests_pass=True,
            quality=1.0,
        )
    if not math.isfinite(q) or q <= Q_FAIL:
        return fail("oriented scalar is not finite and positive", tests_pass=True, quality=1.0)
    return {
        "valid": True,
        "objectives": {"score": q},
        "constraints": {
            "tests_pass": True,
            "byte_exact": True,
            "diagnostic_hashes": True,
            "idempotent": True,
            "rss_within_limit": True,
        },
        "perExample": {
            "aggregate": {
                "score": q,
                "feedback": f"{len(cases)} frozen files; reciprocal geometric mean milliseconds",
            }
        },
        "diagnostics": {
            "quality": 1.0,
            "summary": test_detail,
            "q": q,
            "peak_rss_kb": peak_rss,
            "rss_limit_kb": rss_limit,
            "build_test_sec": build_test_sec,
            "geometric_mean_ms": 1.0 / q,
            "workload_ms": measurements,
        },
    }


def main() -> None:
    try:
        output = evaluate()
    except Exception as exc:
        output = fail(f"evaluator failure: {exc}")
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
