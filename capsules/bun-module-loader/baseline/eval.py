#!/usr/bin/env python3
"""Trusted evaluator for the frozen Bun module-loader capsule.

Only src/resolver is candidate-mutable. The evaluator builds that source with
image-baked native objects and offline dependency caches, runs focused upstream
resolver tests, then measures fresh Bun processes over sealed graph shapes.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import resource
import shutil
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from workload import load_spec, materialize

WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
SOURCE_ROOT = Path("/opt/bun")
BUILD_ROOT = SOURCE_ROOT / "build" / "release"
WORK_ROOT = BUILD_ROOT / "hone-eval"
BUN = BUILD_ROOT / "bun-profile"
CANDIDATE_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
CANDIDATE_GID = int(os.environ.get("CAPSULE_WORKER_GID", "2000"))
BUILD_TIMEOUT_SEC = 390
TEST_TIMEOUT_SEC = 150
RUN_TIMEOUT_SEC = 45
MAX_CAPTURE_BYTES = 8_000_000
Q_FAIL = 0.0
TEST_FILES = (
    "./js/bun/resolve/resolve.test.ts",
    "./js/bun/resolve/resolve-ts.test.ts",
    "./js/bun/resolve/import-meta-resolve.test.mjs",
)
PROTECTED_TOP_LEVEL = {"eval.py", "workload.py", "LICENSE.md", "revision.txt"}


class EvaluationFailure(RuntimeError):
    pass


def _sha256_json(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _candidate_preexec() -> None:
    os.setgroups([])
    os.setgid(CANDIDATE_GID)
    os.setuid(CANDIDATE_UID)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024))


def _candidate_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {
        **os.environ,
        "HOME": "/root",
        "CARGO_HOME": "/root/.cargo",
        "RUSTUP_HOME": "/opt/rust",
        "RUSTUP_TOOLCHAIN": "nightly-2026-05-06-aarch64-unknown-linux-gnu",
        "RUSTC": "/root/.cargo/bin/rustc",
        "PATH": (
            "/root/.cargo/bin:/opt/rust/bin:"
            "/usr/local/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        ),
        "CARGO_NET_OFFLINE": "true",
        "CARGO_BUILD_JOBS": "1",
        "CARGO_PROFILE_RELEASE_LTO": "off",
        "CARGO_PROFILE_RELEASE_CODEGEN_UNITS": "16",
        "BUN_INSTALL_CACHE_DIR": "/root/.bun/install/cache",
        "TMPDIR": str(WORK_ROOT),
        "BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD": "1",
        "NO_COLOR": "1",
    }
    if extra:
        env.update(extra)
    return env


def _run(
    argv: list[str],
    *,
    cwd: Path,
    timeout: int,
    candidate: bool = False,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[bytes]:
    try:
        process = subprocess.Popen(
            argv,
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=_candidate_preexec if candidate else None,
            env=env or _candidate_env(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise EvaluationFailure(f"cannot start command: {argv[0]}: {exc}") from exc
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise EvaluationFailure(f"command timed out: {argv[0]}") from exc
    if len(stdout) > MAX_CAPTURE_BYTES or len(stderr) > MAX_CAPTURE_BYTES:
        raise EvaluationFailure(f"command output exceeded cap: {argv[0]}")
    completed = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    if completed.returncode != 0:
        output = (stdout + b"\n" + stderr).decode("utf-8", "replace")
        signal_lines = [
            line
            for line in output.splitlines()
            if any(marker in line.lower() for marker in ("error", "failed", "denied", "killed", "offline", "no space", "signal", "caused by", "didn't exit"))
        ]
        detail = "\n".join(line[-1200:] for line in signal_lines[-20:]) + "\n" + output[-1000:]
        raise EvaluationFailure(f"command failed ({completed.returncode}): {argv[0]}: {detail}")
    return completed


def _validate_candidate_tree() -> None:
    resolver = WORKSPACE / "src" / "resolver"
    if not resolver.is_dir() or resolver.is_symlink():
        raise EvaluationFailure("candidate src/resolver must be a real directory")
    for path in WORKSPACE.rglob("*"):
        relative = path.relative_to(WORKSPACE)
        if path.is_symlink():
            raise EvaluationFailure(f"candidate symlink is forbidden: {relative}")
        if relative.parts[0] == "src":
            if relative == Path("src") or relative.parts[:2] == ("src", "resolver"):
                continue
            raise EvaluationFailure(f"path is outside mutable envelope: {relative}")
        if len(relative.parts) == 1 and relative.name in PROTECTED_TOP_LEVEL:
            continue
        raise EvaluationFailure(f"path is outside mutable envelope: {relative}")
    files = [path for path in resolver.rglob("*") if path.is_file()]
    if not files or len(files) > 128:
        raise EvaluationFailure("candidate resolver file count is invalid")
    total = sum(path.stat().st_size for path in files)
    if total > 4_000_000:
        raise EvaluationFailure("candidate resolver source exceeds size cap")
    if not (resolver / "Cargo.toml").is_file() or not (resolver / "resolver.rs").is_file():
        raise EvaluationFailure("candidate resolver omits required sources")


def _make_volume_dirs_writable(root: Path) -> None:
    for directory, names, _files in os.walk(root):
        os.chmod(directory, 0o777)
        for name in names:
            path = Path(directory) / name
            if not path.is_symlink():
                os.chmod(path, 0o777)


def _prepare_candidate() -> None:
    _validate_candidate_tree()
    image_resolver = SOURCE_ROOT / "src" / "resolver"
    for child in image_resolver.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    for child in (WORKSPACE / "src" / "resolver").iterdir():
        destination = image_resolver / child.name
        if child.is_dir():
            shutil.copytree(child, destination)
        else:
            shutil.copy2(child, destination)
    for source in image_resolver.rglob("*"):
        if source.is_file():
            os.utime(source, None)
    _make_volume_dirs_writable(image_resolver)
    _make_volume_dirs_writable(BUILD_ROOT)
    rustup = Path("/root/.cargo/bin/rustup")
    rustup.unlink(missing_ok=True)
    rustup.write_text(
        '#!/bin/sh\ncase "$1 $2" in "toolchain install"|"component add"|"target add") exit 0;; esac\n'
        'exec /opt/rust/bin/rustup "$@"\n',
        encoding="utf-8",
    )
    rustup.chmod(0o755)
    direct_bin = Path("/opt/rust/toolchains/nightly-2026-05-06-aarch64-unknown-linux-gnu/bin")
    for name in ("cargo", "rustdoc"):
        proxy = Path("/root/.cargo/bin") / name
        proxy.unlink(missing_ok=True)
        os.symlink(direct_bin / name, proxy)
    rustc = Path("/root/.cargo/bin/rustc")
    rustc.unlink(missing_ok=True)
    rustc.write_text(
        "#!/usr/bin/python3\n"
        "import os,sys\n"
        "args=['-Zthreads=1' if arg == '-Zthreads=8' else arg for arg in sys.argv[1:]]\n"
        "os.execv('/opt/rust/toolchains/nightly-2026-05-06-aarch64-unknown-linux-gnu/bin/rustc',['rustc',*args])\n",
        encoding="utf-8",
    )
    rustc.chmod(0o755)
    for name in ("hone-home", "hone-bun-cache"):
        path = BUILD_ROOT / name
        path.mkdir(mode=0o777, exist_ok=True)
        os.chmod(path, 0o777)
    shutil.rmtree(WORK_ROOT, ignore_errors=True)
    WORK_ROOT.mkdir(mode=0o777)
    os.chmod(WORK_ROOT, 0o777)


def _build_candidate() -> float:
    started = time.perf_counter()
    _run(
        ["/usr/local/bun/bin/bun", "scripts/build.ts", "--profile=release", "-j1"],
        cwd=SOURCE_ROOT,
        timeout=BUILD_TIMEOUT_SEC,
        candidate=True,
    )
    elapsed = time.perf_counter() - started
    if not BUN.is_file() or not os.access(BUN, os.X_OK):
        raise EvaluationFailure("incremental build did not produce bun-profile")
    revision = _run([str(BUN), "--revision"], cwd=SOURCE_ROOT, timeout=20, candidate=True).stdout.decode().strip()
    if not revision.endswith("1.4.0-canary.1+5187e2766"):
        raise EvaluationFailure(f"built binary revision mismatch: {revision[-80:]}")
    return elapsed


def _run_upstream_tests() -> None:
    image_tests = SOURCE_ROOT / "test"
    test_root = WORK_ROOT / "source-tests"
    test_root.mkdir()
    for relative in ("harness.ts", "tsconfig.json", "package.json", "bun.lock"):
        shutil.copy2(image_tests / relative, test_root / relative)
    for relative in (
        "_util",
        "js/bun/resolve",
        "node_modules/reflect-metadata",
        "node_modules/tsyringe",
        "node_modules/tslib",
    ):
        shutil.copytree(
            image_tests / relative,
            test_root / relative,
            symlinks=True,
            ignore_dangling_symlinks=True,
        )
    for path in test_root.rglob("*"):
        if path.is_symlink():
            continue
        if path.is_dir():
            path.chmod(0o777)
        elif path.is_file():
            path.chmod(path.stat().st_mode | 0o666)
    completed = _run(
        [
            str(BUN),
            "test",
            "--test-name-pattern",
            "^(?!auto-install init failure from an unreadable cwd is a catchable error$).*",
            *TEST_FILES,
        ],
        cwd=test_root,
        timeout=TEST_TIMEOUT_SEC,
        candidate=True,
    )
    output = completed.stdout.decode("utf-8", "replace") + completed.stderr.decode("utf-8", "replace")
    if "fail" in output.lower() and "0 fail" not in output.lower():
        raise EvaluationFailure("focused resolver suite reported failures")


def _load_assets() -> tuple[dict, dict]:
    specs = sorted(ASSETS.rglob("spec.json"))
    oracles = sorted(ASSETS.rglob("oracle.json"))
    if len(specs) != 1 or len(oracles) != 1:
        raise EvaluationFailure("selected asset group must contain exactly one spec and oracle")
    spec = load_spec(specs[0])
    oracle = json.loads(oracles[0].read_text(encoding="utf-8"))
    if not isinstance(oracle, dict) or oracle.get("version") != 1 or not isinstance(oracle.get("jobs"), dict):
        raise EvaluationFailure("malformed frozen oracle")
    return spec, oracle


def _parse_observation(stdout: bytes) -> dict:
    lines = [line for line in stdout.decode("utf-8", "strict").splitlines() if line]
    if len(lines) != 1:
        raise EvaluationFailure("loader emitted unexpected stdout")
    value = json.loads(lines[0])
    if not isinstance(value, dict) or set(value) != {"exports", "sideEffects"}:
        raise EvaluationFailure("loader observation has invalid shape")
    exports = value["exports"]
    side_effects = value["sideEffects"]
    if not isinstance(exports, dict) or set(exports) != {"tag", "value"}:
        raise EvaluationFailure("export observation has invalid shape")
    if not isinstance(side_effects, dict) or set(side_effects) != {"checksum", "count"}:
        raise EvaluationFailure("side-effect observation has invalid shape")
    for field in (exports["value"], side_effects["checksum"], side_effects["count"]):
        if not isinstance(field, int) or not 0 <= field <= 0xFFFFFFFF:
            raise EvaluationFailure("loader observation contains invalid integer")
    if exports["tag"] != "graph":
        raise EvaluationFailure("loader observation tag mismatch")
    return value


def _run_loader(job: dict, cache: Path, sample: str) -> dict:
    rss_path = WORK_ROOT / f"rss-{job['id']}-{sample}.txt"
    rss_path.unlink(missing_ok=True)
    env = _candidate_env(
        {
            "BUN_RUNTIME_TRANSPILER_CACHE_PATH": str(cache),
            "TMPDIR": str(WORK_ROOT),
        }
    )
    argv = [
        "/usr/bin/time",
        "--format=%M",
        f"--output={rss_path}",
        "--",
        "/usr/bin/setpriv",
        f"--reuid={CANDIDATE_UID}",
        f"--regid={CANDIDATE_GID}",
        "--clear-groups",
        "--no-new-privs",
        str(BUN),
        job["entry"],
    ]
    started = time.perf_counter()
    completed = _run(argv, cwd=Path(job["entry"]).parent, timeout=RUN_TIMEOUT_SEC, env=env)
    elapsed = time.perf_counter() - started
    try:
        peak_rss_kib = int(rss_path.read_text(encoding="ascii").strip())
    except (OSError, ValueError) as exc:
        raise EvaluationFailure("GNU time did not report peak RSS") from exc
    if peak_rss_kib <= 0:
        raise EvaluationFailure("invalid peak RSS")
    observation = _parse_observation(completed.stdout)
    return {
        "elapsedSec": elapsed,
        "peakRssKiB": peak_rss_kib,
        "exportHash": _sha256_json(observation["exports"]),
        "sideEffectHash": _sha256_json(observation["sideEffects"]),
    }


def _measure_jobs(spec: dict, jobs: list[dict]) -> dict[str, dict]:
    repetitions = spec.get("warmRepetitions")
    if not isinstance(repetitions, int) or not 2 <= repetitions <= 7:
        raise EvaluationFailure("invalid warm repetition count")
    measured: dict[str, dict] = {}
    for job in jobs:
        cache = WORK_ROOT / "cache" / job["id"]
        shutil.rmtree(cache, ignore_errors=True)
        cache.mkdir(parents=True, mode=0o777)
        os.chmod(cache, 0o777)
        cold = _run_loader(job, cache, "cold")
        warm_samples = [_run_loader(job, cache, f"warm-{index}") for index in range(repetitions)]
        hashes = {(sample["exportHash"], sample["sideEffectHash"]) for sample in [cold, *warm_samples]}
        if len(hashes) != 1:
            raise EvaluationFailure(f"{job['id']}: cold/warm observations diverged")
        warm_seconds = [sample["elapsedSec"] for sample in warm_samples]
        peak_rss = max(sample["peakRssKiB"] for sample in [cold, *warm_samples])
        measured[job["id"]] = {
            "kind": job["kind"],
            "coldSec": cold["elapsedSec"],
            "warmMedianSec": statistics.median(warm_seconds),
            "warmSamplesSec": warm_seconds,
            "peakRssKiB": peak_rss,
            "exportHash": cold["exportHash"],
            "sideEffectHash": cold["sideEffectHash"],
        }
    return measured


def _result(
    *,
    valid: bool,
    tests_pass: bool,
    q: float,
    job_ids: list[str],
    measured: dict[str, dict],
    failures: list[str],
    build_sec: float | None,
    captured_oracle: dict | None = None,
) -> dict:
    score = q if valid and math.isfinite(q) and q > Q_FAIL else Q_FAIL
    per_example = {
        job_id: {
            "score": (
                1.0 / math.sqrt(measured[job_id]["coldSec"] * measured[job_id]["warmMedianSec"])
                if valid
                else Q_FAIL
            ),
            "feedback": (
                f"all hard gates passed; cold={measured[job_id]['coldSec']:.6f}s warm={measured[job_id]['warmMedianSec']:.6f}s"
                if valid
                else "hard gate failed"
            ),
        }
        for job_id in job_ids
    }
    if not per_example:
        per_example = {"capsule": {"score": Q_FAIL, "feedback": "hard gate failed"}}
    diagnostics: dict[str, object] = {
        "quality": 1.0 if valid else 0.0,
        "q": score,
        "qFail": Q_FAIL,
        "failures": failures,
        "buildSec": build_sec,
        "measurements": measured if valid else {},
    }
    if captured_oracle is not None:
        diagnostics["capturedOracle"] = captured_oracle
    return {
        "valid": valid,
        "objectives": {"score": score},
        "constraints": {
            "tests_pass": tests_pass,
            "export_hashes": valid,
            "side_effect_hashes": valid,
            "peak_rss": valid,
        },
        "perExample": per_example,
        "diagnostics": diagnostics,
    }


def evaluate() -> dict:
    job_ids: list[str] = []
    measured: dict[str, dict] = {}
    build_sec: float | None = None
    tests_pass = False
    try:
        _prepare_candidate()
        build_sec = _build_candidate()
        _run_upstream_tests()
        tests_pass = True
        spec, oracle = _load_assets()
        graph_root = WORK_ROOT / "graphs"
        graph_root.mkdir(mode=0o755)
        jobs = materialize(spec, graph_root)
        job_ids = [job["id"] for job in jobs]
        measured = _measure_jobs(spec, jobs)
        captured = {
            "version": 1,
            "jobs": {
                job_id: {
                    "exportHash": measured[job_id]["exportHash"],
                    "sideEffectHash": measured[job_id]["sideEffectHash"],
                    "baselinePeakRssKiB": measured[job_id]["peakRssKiB"],
                }
                for job_id in job_ids
            },
        }
        failures: list[str] = []
        if set(oracle["jobs"]) != set(job_ids):
            failures.append("oracle job set mismatch")
        for job_id in job_ids:
            actual = measured[job_id]
            expected = oracle["jobs"].get(job_id)
            if not isinstance(expected, dict):
                failures.append(f"{job_id}: missing oracle")
                continue
            if actual["exportHash"] != expected.get("exportHash"):
                failures.append(f"{job_id}: export hash mismatch")
            if actual["sideEffectHash"] != expected.get("sideEffectHash"):
                failures.append(f"{job_id}: side-effect hash mismatch")
            baseline_rss = expected.get("baselinePeakRssKiB")
            if not isinstance(baseline_rss, int) or actual["peakRssKiB"] > math.floor(baseline_rss * 1.02):
                failures.append(f"{job_id}: peak RSS exceeds baseline +2%")
        capture = os.environ.get("HONE_CAPTURE_ORACLE") == "1"
        if failures and not capture:
            return _result(valid=False, tests_pass=True, q=Q_FAIL, job_ids=job_ids, measured=measured, failures=failures, build_sec=build_sec)
        q = math.exp(
            statistics.fmean(
                -0.5 * (math.log(measured[job_id]["coldSec"]) + math.log(measured[job_id]["warmMedianSec"]))
                for job_id in job_ids
            )
        )
        if not math.isfinite(q):
            raise EvaluationFailure("non-finite scalar")
        return _result(
            valid=True,
            tests_pass=True,
            q=q,
            job_ids=job_ids,
            measured=measured,
            failures=[],
            build_sec=build_sec,
            captured_oracle=captured if capture else None,
        )
    except BaseException as exc:
        return _result(
            valid=False,
            tests_pass=tests_pass,
            q=Q_FAIL,
            job_ids=job_ids,
            measured=measured,
            failures=[f"{type(exc).__name__}: {exc}"],
            build_sec=build_sec,
        )


def main() -> None:
    json.dump(evaluate(), sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
