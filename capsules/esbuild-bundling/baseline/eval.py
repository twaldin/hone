#!/usr/bin/env python3
"""Trusted evaluator for the frozen esbuild bundling capsule.

Only internal/linker is candidate-mutable. This parent builds that candidate
with the image-vendored Go toolchain/cache, executes upstream parser and
bundler suites, and then times real esbuild CLI processes over sealed graphs.
The dropped-uid candidate never gains access to the sealed oracle files.
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
WORK_ROOT = Path("/tmp/hone-esbuild")
CANDIDATE_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
BUILD_TIMEOUT_SEC = 180
TEST_TIMEOUT_SEC = 180
BUNDLE_TIMEOUT_SEC = 45
NODE_TIMEOUT_SEC = 15
MAX_CAPTURE_BYTES = 2_000_000
Q_FAIL = 0.0
TEST_PACKAGES = ("./internal/js_parser", "./internal/bundler_tests")
BANNER = "var React={createElement:(tag,props,...children)=>({tag,props:props||{},children})};"


class EvaluationFailure(RuntimeError):
    pass


def _sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _candidate_preexec() -> None:
    os.setgroups([])
    os.setgid(CANDIDATE_UID)
    os.setuid(CANDIDATE_UID)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_AS, (3 << 30, 3 << 30))


def _run(
    argv: list[str],
    *,
    cwd: Path,
    timeout: int,
    candidate: bool = False,
    pass_fds: tuple[int, ...] = (),
) -> subprocess.CompletedProcess[bytes]:
    child_env = {
        **os.environ,
        "GOTOOLCHAIN": "local",
        "GOPROXY": "off",
        "GOSUMDB": "off",
        "GOFLAGS": "-mod=vendor",
        "CGO_ENABLED": "0",
        "GOTMPDIR": "/dev/shm",
        "HOME": "/tmp/hone-home",
    }
    try:
        process = subprocess.Popen(
            argv,
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=_candidate_preexec if candidate else None,
            pass_fds=pass_fds,
            env=child_env,
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
        stdout, stderr = process.communicate()
        raise EvaluationFailure(f"command timed out: {argv[0]}") from exc
    completed = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
    if len(stdout) > MAX_CAPTURE_BYTES or len(stderr) > MAX_CAPTURE_BYTES:
        raise EvaluationFailure(f"command output exceeded cap: {argv[0]}")
    if completed.returncode != 0:
        detail = stderr.decode("utf-8", "replace")[-1200:]
        raise EvaluationFailure(f"command failed ({completed.returncode}): {argv[0]}: {detail}")
    return completed


def _binary_to_memfd(path: Path, label: str) -> int:
    fd = os.memfd_create(label, flags=0)
    try:
        with path.open("rb") as source:
            while chunk := source.read(1 << 20):
                os.write(fd, chunk)
        os.fchmod(fd, 0o555)
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise
    finally:
        path.unlink(missing_ok=True)


def _compile_memfd(argv: list[str], target: str, output: Path, label: str) -> int:
    output.unlink(missing_ok=True)
    _run([*argv, "-o", str(output), target], cwd=WORKSPACE, timeout=BUILD_TIMEOUT_SEC)
    return _binary_to_memfd(output, label)


def _run_upstream_tests() -> None:
    for index, package in enumerate(TEST_PACKAGES):
        fd = _compile_memfd(
            ["go", "test", "-c", "-trimpath", "-ldflags=-s -w"],
            package,
            WORK_ROOT / f"suite-{index}",
            f"esbuild-suite-{index}",
        )
        try:
            _run(
                [f"/proc/self/fd/{fd}", "-test.timeout=150s"],
                cwd=WORKSPACE / package.removeprefix("./"),
                timeout=TEST_TIMEOUT_SEC,
                candidate=True,
                pass_fds=(fd,),
            )
        finally:
            os.close(fd)


def _build_candidate() -> int:
    return _compile_memfd(
        ["go", "build", "-trimpath", "-ldflags=-s -w"],
        "./cmd/esbuild",
        WORK_ROOT / "esbuild.bin",
        "esbuild-candidate",
    )


def _canonical_map_hash(paths: list[Path]) -> str:
    semantic_maps: list[dict] = []
    for path in sorted(paths):
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise EvaluationFailure("sourcemap is not an object")
        semantic_maps.append({
            "file": path.name,
            "version": raw.get("version"),
            "sourceRoot": raw.get("sourceRoot"),
            "sources": raw.get("sources"),
            "sourcesContent": raw.get("sourcesContent"),
            "names": raw.get("names"),
            "mappings": raw.get("mappings"),
        })
    return _sha256(json.dumps(semantic_maps, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())


def _bundle_once(binary_fd: int, job: dict, output_root: Path) -> tuple[float, list[Path], list[Path]]:
    shutil.rmtree(output_root, ignore_errors=True)
    output_root.mkdir(mode=0o777)
    os.chmod(output_root, 0o777)
    entries = job["entries"]
    argv = [
        f"/proc/self/fd/{binary_fd}",
        *entries,
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--target=node18",
        "--sourcemap=external",
        "--source-root=hone://frozen",
        "--sources-content=true",
        "--charset=utf8",
        "--log-level=error",
        f"--banner:js={BANNER}",
        f"--outdir={output_root}",
    ]
    started = time.perf_counter()
    _run(
        argv,
        cwd=Path(entries[0]).parent,
        timeout=BUNDLE_TIMEOUT_SEC,
        candidate=True,
        pass_fds=(binary_fd,),
    )
    elapsed = time.perf_counter() - started
    output_js = sorted(output_root.glob("*.js"))
    output_maps = sorted(output_root.glob("*.js.map"))
    if len(output_js) != len(entries) or len(output_maps) != len(entries):
        raise EvaluationFailure("esbuild did not emit every output and external sourcemap")
    return elapsed, output_js, output_maps


def _measure_jobs(binary_fd: int, jobs: list[dict], repetitions: int) -> dict[str, dict]:
    measured: dict[str, dict] = {}
    output_root = WORK_ROOT / "output"
    for job in jobs:
        elapsed: list[float] = []
        output_js: list[Path] = []
        output_maps: list[Path] = []
        for _ in range(repetitions):
            sample, output_js, output_maps = _bundle_once(binary_fd, job, output_root)
            elapsed.append(sample)
        semantic_parts: list[bytes] = []
        for path in output_js:
            stdout = _run(
                ["node", str(path)],
                cwd=output_root,
                timeout=NODE_TIMEOUT_SEC,
                candidate=True,
            ).stdout
            semantic_parts.extend((path.name.encode(), b"\0", stdout, b"\0"))
        measured[job["id"]] = {
            "medianSec": statistics.median(elapsed),
            "samplesSec": elapsed,
            "semanticHash": _sha256(b"".join(semantic_parts)),
            "sourcemapHash": _canonical_map_hash(output_maps),
            "outputBytes": sum(path.stat().st_size for path in output_js),
        }
    return measured


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


def _result(valid: bool, q: float, jobs: list[str], measured: dict, failures: list[str]) -> dict:
    score = q if valid and math.isfinite(q) and q > Q_FAIL else Q_FAIL
    per_example = {
        job_id: {
            "score": score,
            "feedback": (
                f"all hard gates passed; median {measured[job_id]['medianSec']:.6f}s"
                if valid
                else "hard gate failed"
            ),
        }
        for job_id in jobs
    }
    if not per_example:
        per_example = {"capsule": {"score": Q_FAIL, "feedback": "hard gate failed"}}
    return {
        "valid": valid,
        "objectives": {"score": score},
        "constraints": {
            "tests_pass": valid,
            "semantic_hashes": valid,
            "sourcemap_hashes": valid,
            "output_size": valid,
        },
        "perExample": per_example,
        "diagnostics": {
            "quality": 1.0 if valid else 0.0,
            "q": score,
            "qFail": Q_FAIL,
            "failures": failures,
            "measurements": measured if valid else {},
        },
    }


def evaluate() -> dict:
    job_ids: list[str] = []
    measured: dict[str, dict] = {}
    try:
        spec, oracle = _load_assets()
        repetitions = spec.get("repetitions")
        if not isinstance(repetitions, int) or not 3 <= repetitions <= 9:
            raise EvaluationFailure("invalid repetition count")
        shutil.rmtree(WORK_ROOT, ignore_errors=True)
        WORK_ROOT.mkdir(mode=0o755)
        _run_upstream_tests()
        binary_fd = _build_candidate()
        try:
            graph_root = WORK_ROOT / "input"
            graph_root.mkdir(mode=0o755)
            jobs = materialize(spec, graph_root)
            job_ids = [job["id"] for job in jobs]
            measured = _measure_jobs(binary_fd, jobs, repetitions)
        finally:
            os.close(binary_fd)
        failures: list[str] = []
        expected_jobs = oracle["jobs"]
        if set(expected_jobs) != set(job_ids):
            failures.append("oracle job set mismatch")
        for job_id in job_ids:
            actual = measured[job_id]
            expected = expected_jobs.get(job_id)
            if not isinstance(expected, dict):
                failures.append(f"{job_id}: missing oracle")
                continue
            if actual["semanticHash"] != expected.get("semanticHash"):
                failures.append(f"{job_id}: output semantic hash mismatch")
            if actual["sourcemapHash"] != expected.get("sourcemapHash"):
                failures.append(f"{job_id}: sourcemap semantic hash mismatch")
            baseline_bytes = expected.get("outputBytes")
            if not isinstance(baseline_bytes, int) or actual["outputBytes"] > math.floor(baseline_bytes * 1.01):
                failures.append(f"{job_id}: output bytes exceed baseline +1%")
        if failures:
            return _result(False, Q_FAIL, job_ids, measured, failures)
        geometric_time = math.exp(statistics.fmean(math.log(measured[job]["medianSec"]) for job in job_ids))
        q = 1.0 / geometric_time
        if not math.isfinite(q):
            raise EvaluationFailure("non-finite scalar")
        return _result(True, q, job_ids, measured, [])
    except BaseException as exc:
        return _result(False, Q_FAIL, job_ids, measured, [f"{type(exc).__name__}: {exc}"])


def main() -> None:
    json.dump(evaluate(), sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
