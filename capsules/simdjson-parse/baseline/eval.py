#!/usr/bin/env python3
"""Trusted offline evaluator for the simdjson DOM/On-Demand parse capsule."""
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
WORKER = TRUSTED / "worker.py"
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


def run_candidate(binary: Path, args: list[str], timeout: float, label: str) -> tuple[bytes, bytes, int]:
    nonce = uuid.uuid4().hex
    stdout_path = Path("/tmp") / f"hone-{nonce}.out"
    stderr_path = Path("/tmp") / f"hone-{nonce}.err"
    max_rss_kb = 0
    try:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            proc = subprocess.Popen(
                [sys.executable, "-I", "-B", str(WORKER), str(binary), *args],
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                cwd=str(TRUSTED),
                preexec_fn=worker_preexec,
            )
            deadline = time.monotonic() + timeout
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
                time.sleep(0.002)
        out = stdout_path.read_bytes()
        err = stderr_path.read_bytes()
        if proc.returncode != 0:
            raise GateFailure(f"{label} failed ({proc.returncode}): {err.decode('utf-8', 'replace')[-1500:]}")
        return out, err, max_rss_kb
    finally:
        stdout_path.unlink(missing_ok=True)
        stderr_path.unlink(missing_ok=True)
        reap_candidate_processes()


def selected_split() -> tuple[str, Path]:
    found = [(name, ASSETS_ROOT / name) for name in ("train", "validation") if (ASSETS_ROOT / name).is_dir()]
    if len(found) != 1:
        raise GateFailure("exactly one frozen asset split must be mounted")
    return found[0]


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


def verify_outputs(split: str, source: Path, verifier: Path) -> tuple[str, int]:
    expected = CHALLENGE["expected"].get(split)
    if not isinstance(expected, dict) or not expected:
        raise GateFailure(f"trusted expected hashes missing for {split}")
    active_impl: str | None = None
    max_rss = 0
    observed: dict[str, str] = {}
    for name in CHALLENGE["validFiles"]:
        for mode in ("dom", "ondemand"):
            out, _, rss = run_candidate(verifier, [mode, str(CORPUS / name)], 45.0, f"{mode} verify {name}")
            max_rss = max(max_rss, rss)
            first = out.splitlines()[0].decode("ascii", "strict") if out else ""
            if not first.startswith("IMPL:"):
                raise GateFailure(f"{mode} verifier omitted implementation")
            impl = first.removeprefix("IMPL:")
            active_impl = impl if active_impl is None else active_impl
            if impl != active_impl:
                raise GateFailure("active implementation changed within evaluation")
            observed[f"{mode}/{name}"] = sha256(event_bytes(out))
    for name in CHALLENGE["ndjsonFiles"]:
        out, _, rss = run_candidate(verifier, ["ondemand-many", str(CORPUS / name)], 45.0, f"ondemand-many verify {name}")
        max_rss = max(max_rss, rss)
        first = out.splitlines()[0].decode("ascii", "strict") if out else ""
        impl = first.removeprefix("IMPL:") if first.startswith("IMPL:") else ""
        active_impl = impl if active_impl is None else active_impl
        if not impl or impl != active_impl:
            raise GateFailure("On-Demand stream verifier implementation mismatch")
        observed[f"ondemand-many/{name}"] = sha256(event_bytes(out))
    for name in CHALLENGE["malformedFiles"]:
        path = CORPUS / "malformed" / name
        for mode in ("dom", "ondemand"):
            out, _, rss = run_candidate(verifier, [mode, str(path)], 10.0, f"{mode} malformed {name}")
            max_rss = max(max_rss, rss)
            observed[f"malformed/{mode}/{name}"] = sha256(event_bytes(out))
    if observed != expected:
        mismatches = sorted(key for key in set(observed) | set(expected) if observed.get(key) != expected.get(key))
        raise GateFailure("exact parse/event or malformed behavior mismatch: " + ", ".join(mismatches[:8]))
    return active_impl or "unknown", max_rss


def parse_dom_throughputs(stdout: bytes) -> list[tuple[str, float]]:
    metrics: list[tuple[str, float]] = []
    for raw in stdout.decode("utf-8", "strict").splitlines():
        if not raw.startswith('"'):
            continue
        fields = raw.split("\t")
        if len(fields) < 8:
            raise GateFailure("unexpected upstream DOM benchmark output")
        name = fields[0].strip('"')
        value = float(fields[5])
        if not math.isfinite(value) or value <= 0:
            raise GateFailure("non-finite DOM throughput")
        metrics.append((f"dom-parse/{name}", value))
    if len(metrics) != len(CHALLENGE["validFiles"]):
        raise GateFailure("upstream DOM benchmark omitted a frozen corpus")
    return metrics


def compile_trusted_baseline() -> Path:
    output = BUILD_ROOT / "trusted-simdjson.o"
    command = [
        "g++", "-std=c++20", "-O3", "-DNDEBUG",
        f"-I{TRUSTED / 'include'}", f"-I{TRUSTED / 'src'}",
        "-c", str(TRUSTED / "src/simdjson.cpp"), "-o", str(output),
    ]
    checked(command, float(CHALLENGE["compileTimeoutSec"]), "trusted comparator compile")
    return output


def run_benchmarks(simdjson_object: Path) -> tuple[list[tuple[str, float]], int]:
    dom_binary = BUILD_ROOT / "dom-parse"
    link(dom_binary, OBJECTS / "parse.o", simdjson_object)
    args = ["-n", str(CHALLENGE["domIterations"]), "-i", str(CHALLENGE["domIterations"]), "-t"]
    args.extend(str(CORPUS / name) for name in CHALLENGE["validFiles"])
    dom_out, _, dom_rss = run_candidate(dom_binary, args, float(CHALLENGE["benchmarkTimeoutSec"]), "upstream DOM parse benchmark")
    metrics = parse_dom_throughputs(dom_out)

    google_binary = BUILD_ROOT / "bench-ondemand"
    link(google_binary, OBJECTS / "bench_ondemand.o", simdjson_object, libraries=("benchmark", "pthread"))
    output_path = BUILD_ROOT / "google-benchmark.json"
    output_path.unlink(missing_ok=True)
    args = [
        f"--benchmark_filter={CHALLENGE['googleBenchmarkFilter']}",
        f"--benchmark_min_time={CHALLENGE['googleBenchmarkMinTimeSec']}",
        f"--benchmark_out={output_path}",
        "--benchmark_out_format=json",
    ]
    _, _, google_rss = run_candidate(google_binary, args, float(CHALLENGE["benchmarkTimeoutSec"]), "upstream On-Demand benchmark")
    try:
        report = json.loads(output_path.read_text())
    except (OSError, ValueError) as exc:
        raise GateFailure("upstream On-Demand benchmark produced no valid report") from exc
    finally:
        output_path.unlink(missing_ok=True)
    records = report.get("benchmarks") if isinstance(report, dict) else None
    if not isinstance(records, list) or len(records) != 4:
        raise GateFailure("upstream On-Demand benchmark workload count changed")
    for record in records:
        if not isinstance(record, dict) or record.get("error_occurred"):
            raise GateFailure("upstream On-Demand benchmark correctness diff failed")
        value = record.get("bytes_per_second")
        name = record.get("name")
        if not isinstance(name, str) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise GateFailure("invalid upstream On-Demand throughput record")
        metrics.append((f"upstream/{name}", float(value) / 1.0e9))
    return metrics, max(dom_rss, google_rss)


def main() -> None:
    started = time.monotonic()
    try:
        split, source = selected_split()
        simdjson_object = compile_candidate()
        stage_corpus(source)
        test_count = run_upstream_tests(simdjson_object)
        verifier = BUILD_ROOT / "verify"
        link(verifier, OBJECTS / "verify.o", simdjson_object)
        active_impl, verify_rss = verify_outputs(split, source, verifier)
        metrics, benchmark_rss = run_benchmarks(simdjson_object)
        peak_rss_kb = max(verify_rss, benchmark_rss)
        rss_limit = float(CHALLENGE["baselinePeakRssKb"][split]) * (1.0 + float(CHALLENGE["peakRssToleranceFraction"]))
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
