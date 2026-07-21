#!/usr/bin/env python3
"""Trusted offline evaluator for Biome parser/formatter throughput.

The image contains the pinned upstream tree, cargo-vendored dependencies, the
protected benchmark runner, and a prebuilt target seed. Only the four parser /
formatter `src` trees are overlaid from the candidate. Cargo, tests, and the
runner execute as uid 2000, which cannot traverse the root-only asset mount.

Robustness model: mutable crate code is linked into the benchmark runner, so
nothing the runner process reports (stdout, timing, exit status alone) is
trusted. This parent process measures wall time itself, seals the built runner
at a root-owned path so it cannot be swapped mid-evaluation, runs every
regression check as its own child bound to an exact protected receipt, and
accepts a benchmark sample only when the receipt it produced matches the
protected oracle for that workload.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import resource
import shutil
import signal
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
BUILT_RUNNER = TARGET / "release/hone_biome_bench"
SEALED_DIR = Path("/tmp/hone-sealed")
RUNNER = SEALED_DIR / "hone_biome_bench"
UID = 2000
GID = 2000
MUTABLE_CRATES = (
    "biome_js_parser",
    "biome_js_formatter",
    "biome_css_parser",
    "biome_css_formatter",
)
Q_FAIL = float(CHALLENGE["qFail"])

# Exact receipts every regression check must reproduce, frozen from the
# pinned baseline toolchain. Each value embeds work products (tree
# fingerprints, element counts, formatted output) that only fall out of
# actually executing the full check body against the pinned grammar.
SELFTEST_RECEIPTS: tuple[tuple[str, bytes], ...] = (
    ("js-valid", b'check=js-valid\nrange=55\nelements=48\nfingerprint=64998c751627ce69\ndiagnostics=0\n'),
    ("js-recovery", b'check=js-recovery\nrange=33\nelements=25\nfingerprint=ad4a55c32ec01b88\ndiagnostics=1\n'),
    ("js-format", b'check=js-format\nstable=true\nbytes=86\noutput=export function double(value) {\n\treturn [value, value + 1].map((item) => item * 2);\n}\n'),
    ("css-valid", b'check=css-valid\nrange=50\nelements=46\nfingerprint=74334e7575cce274\ndiagnostics=0\n'),
    ("css-recovery", b'check=css-recovery\nrange=13\nelements=21\nfingerprint=548d87ef58a364e9\ndiagnostics=1\n'),
    ("css-format", b'check=css-format\nstable=true\nbytes=9\noutput=html {\n}\n'),
)


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
    """Run candidate-linked code in its own session and reap the full tree.

    A per-sample timeout kills the whole process group, so no candidate
    descendant can outlive the measurement window or stall the evaluator on
    an inherited pipe.
    """
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        start_new_session=True,
        preexec_fn=drop_privileges,
    )
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise RuntimeError(f"candidate process timed out after {timeout:.0f}s: {argv[0]}")
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return subprocess.CompletedProcess(argv, proc.returncode, out, err)


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


def build_candidate(env: dict[str, str], needs_build: bool) -> tuple[bool, str, float]:
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
    return True, "", time.monotonic() - started


def seal_runner() -> None:
    """Copy the built runner to a root-owned path before any measurement.

    The build tree under /tmp/target stays writable by uid 2000, so the binary
    there could be replaced between invocations. All regression, verification,
    and benchmark children execute the sealed root-owned copy instead.
    """
    if SEALED_DIR.exists():
        raise RuntimeError("sealed runner directory already exists")
    SEALED_DIR.mkdir(mode=0o755)
    SEALED_DIR.chmod(0o755)
    if not BUILT_RUNNER.exists():
        raise RuntimeError("benchmark runner binary is missing after build")
    shutil.copyfile(BUILT_RUNNER, RUNNER)
    RUNNER.chmod(0o755)


def run_selftest(env: dict[str, str]) -> tuple[bool, str, float]:
    """Run every regression check as its own child and demand exact receipts.

    A zero exit alone is meaningless: candidate code linked into the runner
    could exit early. Each check must write the exact protected receipt for
    its completed body, and every expected check must be present.
    """
    started = time.monotonic()
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="hone-selftest-") as tmp_raw:
        tmp = Path(tmp_raw)
        tmp.chmod(0o755)
        for check, expected_receipt in SELFTEST_RECEIPTS:
            case = tmp / check
            case.mkdir(mode=0o777)
            case.chmod(0o777)
            receipt = case / "receipt"
            result = run_untrusted(
                [str(RUNNER), "selftest", check, str(receipt)],
                timeout=float(CHALLENGE["testTimeoutSec"]),
                env=env,
            )
            if result.returncode != 0:
                return (
                    False,
                    f"regression check {check} failed (exit {result.returncode}): {cargo_failure(result.stderr)}",
                    time.monotonic() - started,
                )
            if receipt.is_symlink() or not receipt.is_file():
                return False, f"regression check {check} produced no receipt", time.monotonic() - started
            if receipt.read_bytes() != expected_receipt:
                return False, f"regression check {check} receipt does not match the protected baseline receipt", time.monotonic() - started
            shutil.rmtree(case)
    return (
        True,
        f"upstream-derived JS/TS/CSS parser and formatter regression suite passed ({len(SELFTEST_RECEIPTS)}/{len(SELFTEST_RECEIPTS)} protected receipts)",
        time.monotonic() - started,
    )


def run_measured_rss(argv: list[str], *, timeout: float, work: Path) -> int:
    rss_file = work / f"rss-{time.monotonic_ns()}"
    command = ["/usr/bin/time", "-f", "%M", "-o", str(rss_file), *argv]
    result = run_untrusted(command, timeout=timeout, stdout=subprocess.DEVNULL)
    if result.returncode != 0:
        raise RuntimeError(f"runner failed: {result.stderr.decode(errors='replace')[-500:]}")
    return int(rss_file.read_text(encoding="utf-8").strip())


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
        rss = run_measured_rss(
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
        # The verified artifacts double as answer keys for the benchmark
        # receipts, so they must not stay readable in the candidate-writable
        # work tree. Remove them and freeze the case dir before benchmarking.
        for artifact in (output, second, diagnostics):
            remove_path(artifact)
        for leftover in case.iterdir():
            if leftover != input_copy:
                remove_path(leftover)
        case.chmod(0o755)
        verified.append(input_copy)
    return verified, peak_rss


def validate_bench_receipt(mode: str, receipt: Path, oracle: dict) -> None:
    if receipt.is_symlink() or not receipt.is_file():
        raise RuntimeError(f"benchmark {mode} receipt missing")
    if mode == "format":
        if sha256(receipt) != oracle["formattedSha256"] or receipt.stat().st_size != oracle["formattedBytes"]:
            raise RuntimeError("benchmark format receipt does not match the protected oracle")
    else:
        if sha256(receipt) != oracle["parseReceiptSha256"]:
            raise RuntimeError("benchmark parse receipt does not match the protected oracle")


def benchmark(
    expected: dict, cases: list[Path], work: Path, initial_peak_rss: int
) -> tuple[float, int, dict[str, float]]:
    """Benchmark every frozen workload with trusted-parent wall timing.

    Every sample is a fresh process in a fresh sample directory. The parent
    measures wall time around the whole child; nothing the child prints is
    used. A sample only counts when its receipt matches the protected oracle,
    binding the measured time to completed parser/formatter output.
    """
    measurements: dict[str, float] = {}
    peak_rss = initial_peak_rss
    samples = int(CHALLENGE["benchmarkSamples"])
    for source in cases:
        oracle = expected["files"][source.name]
        for mode, repetitions_key in (("parse", "parserRepetitions"), ("format", "formatterRepetitions")):
            repetitions = int(CHALLENGE[repetitions_key])
            durations: list[float] = []
            for sample_index in range(samples + 1):
                sample_dir = work / f"bench-{source.name.replace('/', '_')}-{mode}-{sample_index}"
                sample_dir.mkdir(mode=0o777)
                sample_dir.chmod(0o777)
                receipt = sample_dir / "receipt"
                rss_file = sample_dir / "rss"
                command = [
                    "/usr/bin/time",
                    "-f",
                    "%M",
                    "-o",
                    str(rss_file),
                    str(RUNNER),
                    mode,
                    str(source),
                    str(repetitions),
                    str(receipt),
                ]
                started = time.perf_counter_ns()
                result = run_untrusted(
                    command,
                    timeout=float(CHALLENGE["benchmarkTimeoutSec"]),
                    stdout=subprocess.DEVNULL,
                )
                elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
                if result.returncode != 0:
                    raise RuntimeError(f"runner failed: {result.stderr.decode(errors='replace')[-500:]}")
                validate_bench_receipt(mode, receipt, oracle)
                rss = int(rss_file.read_text(encoding="utf-8").strip())
                shutil.rmtree(sample_dir)
                if sample_index == 0:
                    continue
                durations.append(elapsed_ms / repetitions)
                peak_rss = max(peak_rss, rss)
            # Fastest-k-of-N trimmed mean: contention only ADDS wall time, so
            # the slowest samples are host-noise, not candidate signal. Keeping
            # the fastest half rejects that tail without trusting anything the
            # candidate controls (timing is still measured in this trusted
            # parent). Standard for thin-margin capsules.
            keep = max(1, (samples + 1) // 2)
            fastest = sorted(durations)[:keep]
            measurements[f"{source.name}:{mode}"] = statistics.fmean(fastest)
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
    log("building candidate")
    built, build_detail, build_sec = build_candidate(env, needs_build)
    if not built:
        return fail(build_detail)
    seal_runner()
    log("running upstream-derived regression checks against protected receipts")
    tests_pass, test_detail, test_sec = run_selftest(env)
    build_test_sec = build_sec + test_sec
    log(f"build/test stage completed in {build_test_sec:.1f}s")
    if not tests_pass:
        return fail(test_detail)
    expected_paths = list(ASSETS.rglob("expected.json"))
    if len(expected_paths) != 1:
        return fail("selected asset group must contain exactly one expected.json", tests_pass=True)
    expected_path = expected_paths[0]
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if expected.get("schema") != "hone-biome-expected-v2" or expected.get("sourceRevision") != CHALLENGE["sourceRevision"]:
        return fail("expected-output oracle identity mismatch", tests_pass=True)
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="hone-work-") as tmp_raw:
        work = Path(tmp_raw)
        work.chmod(0o755)
        log("verifying exact output, diagnostics, and idempotence")
        try:
            cases, peak_rss = verify_cases(expected, expected_path.parent, work)
            log(f"benchmarking {len(cases)} frozen files")
            q, peak_rss, measurements = benchmark(expected, cases, work, peak_rss)
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
