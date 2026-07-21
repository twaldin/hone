#!/usr/bin/env python3
"""Trusted offline evaluator for the simdjson DOM/On-Demand parse capsule.

Gaming-resistance model
-----------------------
* Timing is performed by THIS trusted parent process (``time.monotonic``),
  around a harness that never reports its own timing. The candidate parser is
  linked into that harness, but the wall clock lives in a separate,
  non-candidate-linked process, so a ``clock_gettime`` / benchmark-JSON
  override inside the candidate object cannot bias the measurement.
* Speed is a candidate/reference ratio from two-point measurements (``N`` and
  ``2N`` iterations of the SAME reused parser). Subtracting the two wall times
  cancels process startup, memfd exec, file load and teardown; dividing by the
  frozen TRUSTED reference parser — rebuilt in this eval and timed interleaved
  with the candidate — cancels host-load drift; per-point minima across rounds
  reject one-sided load bursts.
* Correctness is validated in this parent against expected event hashes that
  live ONLY in the protected asset mount (``/capsule/assets/assets/<split>/
  expected.json``); they are never staged into the candidate-readable corpus
  and never shipped in the /workspace baseline tree.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import resource
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

TRUSTED = Path(__file__).resolve().parent
WORKSPACE = Path("/workspace")
ASSETS_ROOT = Path("/capsule/assets/assets")
CHALLENGE = json.loads((TRUSTED / "challenge.json").read_text())
OBJECTS = Path("/opt/hone-objects")
BUILD_ROOT = Path("/dev/shm")
CORPUS = BUILD_ROOT / "corpus"
COMPILE_ROOT = Path("/tmp/candidate-source")
WORKER_UID = 2000
Q_FAIL = float(CHALLENGE["qFail"])


class GateFailure(RuntimeError):
    pass


def emit_failure(reason: str, diagnostics: dict | None = None) -> None:
    detail = {"quality": 0.0, "summary": reason}
    if diagnostics:
        detail.update(diagnostics)
    print(json.dumps({
        "valid": False,
        "objectives": {"q": Q_FAIL},
        "constraints": {
            "tests_pass": False,
            "event_hashes": False,
            "malformed_behavior": False,
            "peak_rss": False,
        },
        "perExample": {"aggregate": {"score": Q_FAIL, "feedback": reason}},
        "diagnostics": detail,
    }, separators=(",", ":")))


def checked(
    command: list[str],
    timeout: float,
    label: str,
    *,
    unprivileged: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            preexec_fn=worker_preexec if unprivileged else None,
        )
    except subprocess.TimeoutExpired as exc:
        raise GateFailure(f"{label} timed out") from exc
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace")[-2000:]
        raise GateFailure(f"{label} failed ({result.returncode}): {stderr}")
    return result


def compile_candidate() -> Path:
    if not (WORKSPACE / "src/simdjson.cpp").is_file():
        raise GateFailure("candidate source tree is incomplete")
    for forbidden in (WORKSPACE / ".git", WORKSPACE / ".gitdir"):
        if forbidden.exists():
            raise GateFailure("source-control metadata reached mutation workspace")
    if COMPILE_ROOT.exists():
        shutil.rmtree(COMPILE_ROOT)
    for subtree in ("include", "src"):
        source = WORKSPACE / subtree
        for path in source.rglob("*"):
            if path.is_symlink() or (not path.is_dir() and not path.is_file()):
                raise GateFailure(f"candidate compile envelope contains non-regular path: {subtree}")
        shutil.copytree(source, COMPILE_ROOT / subtree)
    for root, _, files in os.walk(COMPILE_ROOT):
        os.chmod(root, 0o755)
        for name in files:
            os.chmod(Path(root) / name, 0o444)
    output = BUILD_ROOT / "simdjson.o"
    command = [
        "g++", "-std=c++20", "-O3", "-DNDEBUG",
        f"-I{COMPILE_ROOT / 'include'}", f"-I{COMPILE_ROOT / 'src'}",
        "-c", str(COMPILE_ROOT / "src/simdjson.cpp"), "-o", str(output),
    ]
    try:
        checked(
            command,
            float(CHALLENGE["compileTimeoutSec"]),
            "candidate compile",
            unprivileged=True,
        )
    finally:
        reap_candidate_processes()
        shutil.rmtree(COMPILE_ROOT, ignore_errors=True)
    return output


def build_harnesses(simdjson_object: Path) -> tuple[Path, Path]:
    """Compile the TRUSTED harness and link it twice: candidate and reference.

    The harness source and public headers are protected (immutable) inputs, so
    only the parser object varies. The reference binary links the parser
    compiled from the frozen TRUSTED sources; every speed number this
    evaluator emits is a candidate/reference ratio measured back-to-back, so
    slow host-load drift cancels instead of polluting the metric.
    """
    harness_object = BUILD_ROOT / "verify-harness.o"
    command = [
        "g++", "-std=c++20", "-O3", "-DNDEBUG",
        f"-I{TRUSTED / 'include'}", f"-I{TRUSTED / 'src'}",
        "-c", str(TRUSTED / "hone/verify.cpp"), "-o", str(harness_object),
    ]
    checked(command, float(CHALLENGE["compileTimeoutSec"]), "trusted harness compile")
    reference_object = BUILD_ROOT / "trusted-simdjson.o"
    command = [
        "g++", "-std=c++20", "-O3", "-DNDEBUG",
        f"-I{TRUSTED / 'include'}", f"-I{TRUSTED / 'src'}",
        "-c", str(TRUSTED / "src/simdjson.cpp"), "-o", str(reference_object),
    ]
    checked(command, float(CHALLENGE["compileTimeoutSec"]), "trusted reference compile")
    candidate_bin = BUILD_ROOT / "verify-candidate"
    link(candidate_bin, harness_object, simdjson_object)
    reference_bin = BUILD_ROOT / "verify-reference"
    link(reference_bin, harness_object, reference_object)
    return candidate_bin, reference_bin


def link(output: Path, *objects: Path, libraries: tuple[str, ...] = ()) -> None:
    command = ["g++", *(str(path) for path in objects), *(f"-l{name}" for name in libraries), "-o", str(output)]
    checked(command, 60.0, f"link {output.name}")
    output.chmod(0o644)


def worker_preexec() -> None:
    os.setsid()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 << 20, 32 << 20))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    os.setgroups([])
    os.setgid(WORKER_UID)
    os.setuid(WORKER_UID)


def reap_candidate_processes() -> None:
    proc = Path("/proc")
    if not proc.is_dir():
        return
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
        except (OSError, ProcessLookupError):
            continue
        uid_line = next((line for line in status.splitlines() if line.startswith("Uid:")), "")
        fields = uid_line.split()
        if len(fields) >= 2 and fields[1] == str(WORKER_UID):
            try:
                os.kill(int(entry.name), signal.SIGKILL)
            except ProcessLookupError:
                pass


def run_candidate(binary: Path, args: list[str], timeout: float, label: str) -> tuple[bytes, bytes, int, float]:
    """Run a candidate-linked binary as the unprivileged worker.

    Returns (stdout, stderr, peak_rss_kb, wall_seconds). ``wall_seconds`` is
    measured by this trusted parent around the entire child lifetime and is the
    ONLY timing source the evaluator trusts.
    """
    nonce = uuid.uuid4().hex
    stdout_path = Path("/tmp") / f"hone-{nonce}.out"
    stderr_path = Path("/tmp") / f"hone-{nonce}.err"
    max_rss_kb = 0
    wall = 0.0
    try:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            worker = TRUSTED / "worker.py"
            started = time.monotonic()
            proc = subprocess.Popen(
                [sys.executable, "-I", "-B", str(worker), str(binary), *args],
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                cwd=str(TRUSTED),
                preexec_fn=worker_preexec,
            )
            deadline = started + timeout
            while proc.poll() is None:
                try:
                    status = Path(f"/proc/{proc.pid}/status").read_text()
                    for line in status.splitlines():
                        if line.startswith("VmHWM:"):
                            max_rss_kb = max(max_rss_kb, int(line.split()[1]))
                            break
                except (FileNotFoundError, ProcessLookupError):
                    pass
                if time.monotonic() >= deadline:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                    raise GateFailure(f"{label} timed out")
                time.sleep(0.001)
            wall = time.monotonic() - started
        out = stdout_path.read_bytes()
        err = stderr_path.read_bytes()
        if proc.returncode != 0:
            raise GateFailure(f"{label} failed ({proc.returncode}): {err.decode('utf-8', 'replace')[-1500:]}")
        return out, err, max_rss_kb, wall
    finally:
        stdout_path.unlink(missing_ok=True)
        stderr_path.unlink(missing_ok=True)
        reap_candidate_processes()


def selected_split() -> tuple[str, Path]:
    found = [(name, ASSETS_ROOT / name) for name in ("train", "validation") if (ASSETS_ROOT / name).is_dir()]
    if len(found) != 1:
        raise GateFailure("exactly one frozen asset split must be mounted")
    return found[0]


def load_split_secrets(source: Path) -> tuple[dict[str, str], float]:
    """Load the split's expected event hashes and peak-RSS baseline.

    These live in the protected asset mount, root-owned and never staged into
    the candidate-readable corpus, so candidate code cannot branch on them.
    """
    secret_path = source / "expected.json"
    if not secret_path.is_file():
        raise GateFailure("protected validation expectations missing for split")
    secrets = json.loads(secret_path.read_text())
    expected = secrets.get("expected")
    if not isinstance(expected, dict) or not expected:
        raise GateFailure("protected expected hash table is empty")
    baseline_rss = secrets.get("baselinePeakRssKb")
    if not isinstance(baseline_rss, (int, float)) or baseline_rss <= 0:
        raise GateFailure("protected peak-RSS baseline missing")
    return {str(k): str(v) for k, v in expected.items()}, float(baseline_rss)


def stage_corpus(source: Path) -> None:
    if CORPUS.exists():
        shutil.rmtree(CORPUS)
    shutil.copytree(source / "valid", CORPUS)
    shutil.copytree(source / "malformed", CORPUS / "malformed")
    for root, _, files in os.walk(CORPUS):
        os.chmod(root, 0o777)
        for name in files:
            os.chmod(Path(root) / name, 0o644)


def run_upstream_tests(simdjson_object: Path) -> int:
    tests = [line for line in (OBJECTS / "test-objects.txt").read_text().splitlines() if line]
    if not tests:
        raise GateFailure("frozen relevant-test list is empty")
    binary = BUILD_ROOT / "upstream-test"
    for name in tests:
        link(binary, OBJECTS / "tests" / f"{name}.o", simdjson_object)
        run_candidate(binary, [], float(CHALLENGE["testTimeoutSec"]), f"upstream test {name}")
    binary.unlink(missing_ok=True)
    return len(tests)


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def event_bytes(output: bytes) -> bytes:
    lines = output.splitlines()
    if len(lines) < 2:
        raise GateFailure("verifier emitted no parse/event result")
    return b"\n".join(lines[1:]) + b"\n"


class _Verifier:
    """Trusted-parent driver over the harness: correctness + parent timing."""

    def __init__(self, candidate: Path, reference: Path) -> None:
        self.candidate = candidate
        self.reference = reference
        self.active_impl: str | None = None
        self.max_rss = 0

    def _run(self, binary: Path, args: list[str], timeout: float, label: str) -> tuple[bytes, float]:
        out, _, rss, wall = run_candidate(binary, args, timeout, label)
        self.max_rss = max(self.max_rss, rss)
        first = out.splitlines()[0].decode("ascii", "strict") if out else ""
        if not first.startswith("IMPL:"):
            raise GateFailure(f"{label}: verifier omitted implementation banner")
        impl = first.removeprefix("IMPL:")
        if self.active_impl is None:
            self.active_impl = impl
        elif impl != self.active_impl:
            raise GateFailure("active implementation changed within evaluation")
        return event_bytes(out), wall

    def check(self, mode: str, path: Path, key: str, expected: dict[str, str], label: str) -> None:
        ev, _ = self._run(self.candidate, [mode, str(path)], float(CHALLENGE["testTimeoutSec"]), label)
        if sha256(ev) != expected.get(key):
            raise GateFailure(f"exact parse/event or malformed behavior mismatch: {key}")

    def timed(self, mode: str, name: str, key: str, expected: dict[str, str]) -> float:
        """Parent-timed candidate/reference speed ratio for one workload.

        Each round runs reference and candidate at N iterations, then both at
        2N, back-to-back on the parent's monotonic clock. The 2N-N difference
        cancels fixed process overhead; the reference/candidate ratio cancels
        host-load drift; the per-point minimum across rounds filters one-sided
        load bursts. Every run — reference included — must reproduce the
        protected expected event hash, so speed can never be traded against
        correctness and a reference/toolchain defect is caught immediately.
        """
        path = CORPUS / name
        size = path.stat().st_size
        # Iterations scale with a fixed per-mode work budget so every timed
        # diff spans a comparable wall interval regardless of corpus size —
        # small files no longer produce jitter-dominated measurements.
        iters = max(4, int(CHALLENGE["timingWorkBytes"][mode]) // size)
        samples = int(CHALLENGE["timingSamples"])
        timeout = float(CHALLENGE["benchmarkTimeoutSec"])
        want = expected.get(key)

        def run_point(binary: Path, n: int, who: str) -> float:
            ev, wall = self._run(binary, [mode, str(path), str(n)], timeout, f"{mode} timing {name} ({who} x{n})")
            if sha256(ev) != want:
                raise GateFailure(f"exact parse/event mismatch under timing ({who}): {key}")
            return wall

        # Rounds interleave the four points (ref/cand at N and 2N) so all of
        # them sample the same load window; the MINIMUM wall per point across
        # rounds filters one-sided host-load bursts (the classic robust timing
        # estimator), and one ratio is formed from the four filtered points.
        # A discarded warmup evens out cold-start (page cache, CPU ramp).
        run_point(self.reference, iters, "warmup")
        best = {"rn": math.inf, "cn": math.inf, "r2": math.inf, "c2": math.inf}
        for _ in range(samples):
            best["rn"] = min(best["rn"], run_point(self.reference, iters, "reference"))
            best["cn"] = min(best["cn"], run_point(self.candidate, iters, "candidate"))
            best["r2"] = min(best["r2"], run_point(self.reference, 2 * iters, "reference"))
            best["c2"] = min(best["c2"], run_point(self.candidate, 2 * iters, "candidate"))
        d_ref = best["r2"] - best["rn"]
        d_cand = best["c2"] - best["cn"]
        if not (math.isfinite(d_ref) and math.isfinite(d_cand) and d_ref > 0 and d_cand > 0):
            raise GateFailure(f"non-positive parent-measured parse time for {key}")
        return d_ref / d_cand


def evaluate_candidate(split: str, expected: dict[str, str], candidate: Path, reference: Path) -> tuple[str, int, list[tuple[str, float]]]:
    driver = _Verifier(candidate, reference)
    metrics: list[tuple[str, float]] = []

    # Full-document DOM and On-Demand parse speed on every valid corpus, as a
    # candidate/reference ratio timed by the trusted parent. Each timing run
    # also validates the exact event hash, so a candidate cannot trade
    # correctness for speed.
    for mode in CHALLENGE["timingModes"]:
        for name in CHALLENGE["validFiles"]:
            key = f"{mode}/{name}"
            metrics.append((f"{mode}/{name}", driver.timed(mode, name, key, expected)))

    # On-Demand streaming and malformed behavior: correctness only.
    for name in CHALLENGE["ndjsonFiles"]:
        driver.check("ondemand-many", CORPUS / name, f"ondemand-many/{name}", expected,
                     f"ondemand-many verify {name}")
    for name in CHALLENGE["malformedFiles"]:
        path = CORPUS / "malformed" / name
        for mode in ("dom", "ondemand"):
            driver.check(mode, path, f"malformed/{mode}/{name}", expected, f"{mode} malformed {name}")

    observed_keys = {f"{mode}/{name}" for mode in CHALLENGE["timingModes"] for name in CHALLENGE["validFiles"]}
    observed_keys |= {f"ondemand-many/{name}" for name in CHALLENGE["ndjsonFiles"]}
    observed_keys |= {f"malformed/{mode}/{name}" for mode in ("dom", "ondemand") for name in CHALLENGE["malformedFiles"]}
    if observed_keys != set(expected):
        missing = sorted(set(expected) ^ observed_keys)
        raise GateFailure("expected coverage mismatch: " + ", ".join(missing[:8]))

    return driver.active_impl or "unknown", driver.max_rss, metrics


def main() -> None:
    started = time.monotonic()
    try:
        split, source = selected_split()
        expected, baseline_rss = load_split_secrets(source)
        simdjson_object = compile_candidate()
        stage_corpus(source)
        test_count = run_upstream_tests(simdjson_object)
        candidate_bin, reference_bin = build_harnesses(simdjson_object)
        active_impl, peak_rss_kb, metrics = evaluate_candidate(split, expected, candidate_bin, reference_bin)

        rss_limit = baseline_rss * (1.0 + float(CHALLENGE["peakRssToleranceFraction"]))
        if peak_rss_kb > rss_limit:
            raise GateFailure(f"peak RSS {peak_rss_kb} KiB exceeds frozen limit {rss_limit:.1f} KiB")
        values = [value for _, value in metrics]
        q = math.exp(sum(math.log(value) for value in values) / len(values))
        if not math.isfinite(q) or q <= Q_FAIL:
            raise GateFailure("oriented scalar is not finite and positive")
        feedback = {
            "split": split,
            "q": q,
            "workloads": dict(metrics),
            "activeImplementation": active_impl,
            "peakRssKb": peak_rss_kb,
            "peakRssLimitKb": rss_limit,
            "relevantTests": test_count,
            "wallSec": time.monotonic() - started,
        }
        print(json.dumps({
            "valid": True,
            "objectives": {"q": q},
            "constraints": {
                "tests_pass": True,
                "event_hashes": True,
                "malformed_behavior": True,
                "peak_rss": True,
            },
            "perExample": {"aggregate": {"score": q, "feedback": feedback}},
            "diagnostics": {
                "quality": 1.0,
                "summary": "all hard gates passed",
                **feedback,
            },
        }, separators=(",", ":")))
    except BaseException as exc:
        emit_failure(f"{type(exc).__name__}: {exc}", {"wallSec": time.monotonic() - started})
    finally:
        reap_candidate_processes()


if __name__ == "__main__":
    main()
