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
* Timed iterations are identity-distinct: the trusted harness perturbs value
  bytes deterministically before every iteration after the first (structure
  and size preserved) and folds each perturbed iteration's full event stream
  into a CHAIN line this parent validates against the trusted reference's
  chain at the same iteration count, so repeated timed work can neither be
  memoized (no two iterations parse identical bytes) nor skipped (every
  iteration's parse output is validated). Candidate-writable residue in
  /tmp, /dev/shm, and SysV IPC is purged between launches so deterministic
  chains cannot be cached across runs either.
"""
from __future__ import annotations

import ctypes
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
        # Root-copy seal (the eval container has no CAP_CHOWN): the object was
        # written by the unprivileged worker, so re-home its bytes into a
        # root-owned file before any candidate process runs again; the
        # worker-owned original goes with the rest of the purged residue.
        sealed = BUILD_ROOT / "simdjson-sealed.o"
        sealed.write_bytes(output.read_bytes())
        sealed.chmod(0o644)
        output.unlink()
    finally:
        reap_candidate_processes()
        purge_worker_state()
        shutil.rmtree(COMPILE_ROOT, ignore_errors=True)
    return sealed


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


def purge_worker_state() -> None:
    """Remove candidate-writable residue between candidate launches.

    Timed inputs are identity-distinct per iteration, but their event chains
    are deterministic per (file, iteration count) — a candidate process that
    stashed computed chains in /tmp, /dev/shm, or a SysV IPC object could
    read them back in a later launch and replay instead of parsing. Every
    launch therefore starts with no worker-owned filesystem entries and no
    SysV objects (the container's IPC namespace is private, so the tables
    only ever contain candidate-created entries).
    """
    for base in (Path("/tmp"), BUILD_ROOT):
        try:
            entries = list(base.iterdir())
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.lstat().st_uid != WORKER_UID:
                    continue
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    entry.unlink(missing_ok=True)
            except OSError:
                continue
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
    except OSError:
        return

    def remove_all(table: str, remove) -> None:
        try:
            rows = Path(f"/proc/sysvipc/{table}").read_text().splitlines()[1:]
        except OSError:
            return
        for row in rows:
            fields = row.split()
            if len(fields) >= 2 and fields[1].lstrip("-").isdigit():
                try:
                    remove(int(fields[1]))
                except Exception:
                    pass

    remove_all("shm", lambda ipc_id: libc.shmctl(ipc_id, 0, None))  # IPC_RMID == 0
    remove_all("msg", lambda ipc_id: libc.msgctl(ipc_id, 0, None))
    remove_all("sem", lambda ipc_id: libc.semctl(ipc_id, 0, 0))


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
        purge_worker_state()


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
        os.chmod(root, 0o755)
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


def parse_output(output: bytes) -> tuple[bytes, str | None]:
    """Split harness stdout into the event payload and the optional CHAIN line.

    The payload (everything after the IMPL banner) is hash-compared against
    the protected expected table; the CHAIN line folds every perturbed timed
    iteration's event stream and is validated against the trusted reference's
    chain in ``_Verifier.timed``.
    """
    lines = output.splitlines()
    chain: str | None = None
    if lines and lines[-1].startswith(b"CHAIN:"):
        chain = lines[-1].decode("ascii", "strict")
        lines = lines[:-1]
    if len(lines) < 2:
        raise GateFailure("verifier emitted no parse/event result")
    return b"\n".join(lines[1:]) + b"\n", chain


class _Verifier:
    """Trusted-parent driver over the harness: correctness + parent timing."""

    def __init__(self, candidate: Path, reference: Path) -> None:
        self.candidate = candidate
        self.reference = reference
        self.active_impl: str | None = None
        self.max_rss = 0

    def _run(self, binary: Path, args: list[str], timeout: float, label: str) -> tuple[bytes, str | None, float]:
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
        payload, chain = parse_output(out)
        return payload, chain, wall

    def check(self, mode: str, path: Path, key: str, expected: dict[str, str], label: str) -> None:
        ev, _, _ = self._run(self.candidate, [mode, str(path)], float(CHALLENGE["testTimeoutSec"]), label)
        if sha256(ev) != expected.get(key):
            raise GateFailure(f"exact parse/event or malformed behavior mismatch: {key}")

    def timed(self, mode: str, name: str, key: str, expected: dict[str, str]) -> float:
        """Parent-timed candidate/reference speed ratio for one workload.

        Contention-robust minimum estimator. Each binary is run at a calibrated
        iteration count ``samples`` times (lead alternating), timed by the
        parent's monotonic clock; the ratio is min(reference)/min(candidate).
        The fastest of several runs is the one that caught the least-contended
        window, so each per-binary minimum converges to that binary's true
        uncontended time no matter when its clean window occurred — the ratio
        is therefore immune to both slow drift and one-sided bursts, which is
        essential on a shared, heavily-loaded host. (Per-round ratios and 2N-N
        differences were both tried and reintroduced large variance under load
        by combining independently-noisy wall times; the per-binary minimum
        does not.) The iteration count is calibrated up front so each run lasts
        ~timingTargetSec, keeping the shared fixed per-process overhead (exec,
        file load, site scan) a negligible common-mode term in the ratio.

        Iteration 1 of every run parses the PRISTINE document and must
        reproduce the protected expected event hash; every further iteration
        parses a distinct, deterministically value-perturbed variant (trusted
        harness code, identical in both binaries), and the harness folds each
        perturbed iteration's full event stream into a CHAIN line. The trusted
        reference runs first at each iteration count and pins the expected
        chain; every subsequent run at that count must reproduce it exactly,
        so timed work can neither be memoized (no two iterations see the same
        bytes) nor skipped (every iteration's output is validated).
        """
        path = CORPUS / name
        size = path.stat().st_size
        base_iters = max(4, int(CHALLENGE["timingWorkBytes"][mode]) // size)
        samples = int(CHALLENGE["timingSamples"])
        target_wall = float(CHALLENGE["timingTargetSec"])
        timeout = float(CHALLENGE["benchmarkTimeoutSec"])
        want = expected.get(key)
        chains: dict[int, str] = {}

        def run_point(binary: Path, n: int, who: str) -> float:
            ev, chain, wall = self._run(binary, [mode, str(path), str(n)], timeout, f"{mode} timing {name} ({who} x{n})")
            if sha256(ev) != want:
                raise GateFailure(f"exact parse/event mismatch under timing ({who}): {key}")
            if chain is None:
                raise GateFailure(f"perturbed-iteration chain missing ({who}): {key}")
            if chains.setdefault(n, chain) != chain:
                raise GateFailure(f"perturbed-iteration event chain mismatch ({who} x{n}): {key}")
            return wall

        # Calibrate the iteration count so each timed run lasts ~target_wall,
        # regardless of file size or mode cost — the reference warmup doubles
        # as the probe. Longer runs shrink the common-mode overhead term to
        # noise, so the adjacent ref/candidate ratio needs no 2N-N subtraction.
        probe_wall = run_point(self.reference, base_iters, "warmup")
        iters = base_iters
        if probe_wall > 0:
            scaled = int(base_iters * target_wall / probe_wall)
            iters = max(base_iters, min(base_iters * 32, scaled))
        # Candidate warmup at the calibrated count (page cache, CPU ramp,
        # first-parse replay-cache population for the candidate).
        run_point(self.candidate, iters, "warmup")

        # Contention-robust minimum estimator. Each binary is run ``samples``
        # times (lead alternating), and the MINIMUM wall per binary is kept:
        # the fastest run is the one that caught the least-contended window, so
        # min_ref and min_cand each converge to the true uncontended time
        # regardless of when their clean window occurred. Their ratio is the
        # drift- and contention-immune speed ratio — differencing (2N-N) or
        # per-round ratios both reintroduce variance under load, while the
        # per-binary minimum does not. Long calibrated reps keep the shared
        # fixed overhead a negligible common-mode term in the ratio.
        best_ref = math.inf
        best_cand = math.inf
        for round_index in range(samples):
            if round_index % 2 == 0:
                r = run_point(self.reference, iters, "reference")
                c = run_point(self.candidate, iters, "candidate")
            else:
                c = run_point(self.candidate, iters, "candidate")
                r = run_point(self.reference, iters, "reference")
            if math.isfinite(r) and r > 0:
                best_ref = min(best_ref, r)
            if math.isfinite(c) and c > 0:
                best_cand = min(best_cand, c)
        if not (math.isfinite(best_ref) and math.isfinite(best_cand) and best_ref > 0 and best_cand > 0):
            raise GateFailure(f"no positive parent-measured parse time for {key}")
        return best_ref / best_cand


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
        purge_worker_state()


if __name__ == "__main__":
    main()
