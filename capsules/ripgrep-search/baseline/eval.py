#!/usr/bin/env python3
"""Trusted offline evaluator for the pinned ripgrep search capsule."""
from __future__ import annotations

import ctypes
import gzip
import hashlib
import importlib.machinery
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import stat
import sys
import tarfile
import tempfile
import time
from typing import Any

TRUSTED = Path(__file__).resolve().parent
WORKSPACE = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace")).resolve()
ASSETS = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets")).resolve()
BUILD_ROOT = Path("/mnt")
CANDIDATE_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
CANDIDATE_GID = CANDIDATE_UID
UPSTREAM_REVISION = "227381db0ee83dfa4341f1e27ff9617c0f5ad992"
MUTABLE_PREFIXES = (
    "crates/searcher/src/",
    "crates/regex/src/",
    "crates/ignore/src/",
)
SKIP_BASELINE_PREFIXES = (".git/", ".gitdir/")
MAX_COMMAND_OUTPUT = 8 * 1024 * 1024
MAX_BUILD_FILE = 512 * 1024 * 1024
BUILD_TIMEOUT_SEC = 300.0
SEARCH_TIMEOUT_SEC = 30.0
Q_FAIL = 0.0
_LIBC = ctypes.CDLL(None, use_errno=True)
MS_NOSUID = 2
MS_NODEV = 4
MS_REC = 16384
MS_PRIVATE = 1 << 18
CLONE_NEWNS = 0x00020000

def load_worker_module() -> Any:
    path = TRUSTED / "worker.py"
    loader = importlib.machinery.SourceFileLoader("ripgrep_candidate_worker", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise RuntimeError("cannot load candidate worker glue")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


_WORKER = load_worker_module()


class GateFailure(RuntimeError):
    def __init__(self, gate: str, detail: str) -> None:
        super().__init__(detail)
        self.gate = gate
        self.detail = detail


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def result_hash(exit_code: int, stdout_hash: str, stderr_hash: str) -> str:
    canonical = json.dumps(
        {"exitCode": exit_code, "stderrSha256": stderr_hash, "stdoutSha256": stdout_hash},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256_bytes(canonical)


def regular_file_map(root: Path, *, skip_baseline_git: bool) -> dict[str, tuple[str, int]]:
    files: dict[str, tuple[str, int]] = {}
    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current = Path(dirpath)
        kept_dirs: list[str] = []
        for name in sorted(dirnames):
            path = current / name
            rel = path.relative_to(root).as_posix()
            if path.is_symlink():
                if any(rel.startswith(prefix) for prefix in MUTABLE_PREFIXES):
                    raise GateFailure("source_envelope", f"mutable symlink rejected: {rel}")
                files[rel] = (f"symlink:{os.readlink(path)}", stat.S_IMODE(path.lstat().st_mode))
                continue
            prefix = f"{rel}/"
            if skip_baseline_git and any(prefix.startswith(skip) for skip in SKIP_BASELINE_PREFIXES):
                continue
            kept_dirs.append(name)
        dirnames[:] = kept_dirs
        for name in sorted(filenames):
            path = current / name
            rel = path.relative_to(root).as_posix()
            if skip_baseline_git and any(rel == skip[:-1] or rel.startswith(skip) for skip in SKIP_BASELINE_PREFIXES):
                continue
            if path.is_symlink():
                if any(rel.startswith(prefix) for prefix in MUTABLE_PREFIXES):
                    raise GateFailure("source_envelope", f"mutable symlink rejected: {rel}")
                files[rel] = (f"symlink:{os.readlink(path)}", stat.S_IMODE(path.lstat().st_mode))
                continue
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise GateFailure("source_envelope", f"non-regular source entry rejected: {rel}")
            files[rel] = (sha256_bytes(path.read_bytes()), stat.S_IMODE(info.st_mode))
    return files


def verify_mutable_envelope() -> None:
    if not WORKSPACE.is_dir():
        raise GateFailure("source_envelope", "candidate workspace is missing")
    candidate = regular_file_map(WORKSPACE, skip_baseline_git=False)
    baseline = regular_file_map(TRUSTED, skip_baseline_git=True)
    all_paths = set(candidate) | set(baseline)
    violations: list[str] = []
    for rel in sorted(all_paths):
        if any(rel.startswith(prefix) for prefix in MUTABLE_PREFIXES):
            continue
        if candidate.get(rel) != baseline.get(rel):
            violations.append(rel)
            if len(violations) >= 12:
                break
    if violations:
        raise GateFailure(
            "source_envelope",
            "changes outside the mutable search subsystem: " + ", ".join(violations),
        )


def mount_build_tmpfs() -> None:
    data = b"size=1400m,mode=0755"
    rc = _LIBC.mount(b"tmpfs", os.fsencode(BUILD_ROOT), b"tmpfs", MS_NOSUID | MS_NODEV, data)
    if rc != 0:
        err = ctypes.get_errno()
        raise GateFailure("tests_pass", f"cannot mount isolated build tmpfs: {os.strerror(err)}")


def copy_candidate() -> Path:
    target = BUILD_ROOT / "work"
    shutil.copytree(WORKSPACE, target, symlinks=True)
    return target


def locate_cases() -> tuple[Path, dict[str, Any]]:
    found = sorted(ASSETS.rglob("cases.json"))
    if len(found) != 1:
        raise GateFailure("exact_output", f"expected one sealed cases.json, found {len(found)}")
    path = found[0]
    raw = json.loads(path.read_text("utf-8"))
    if raw.get("version") != 1 or not isinstance(raw.get("cases"), list):
        raise GateFailure("exact_output", "malformed sealed workload definition")
    return path, raw


def extract_corpus(cases_path: Path, config: dict[str, Any]) -> Path:
    archive_name = config.get("corpusArchive")
    corpus_root_name = config.get("corpusRoot")
    if not isinstance(archive_name, str) or not isinstance(corpus_root_name, str):
        raise GateFailure("exact_output", "sealed workload omits corpus identity")
    archive = cases_path.parent / archive_name
    destination = BUILD_ROOT / "corpus"
    destination.mkdir(mode=0o755)
    with gzip.open(archive, "rb") as compressed:
        with tarfile.open(fileobj=compressed, mode="r|") as tf:
            for member in tf:
                pure = PurePosixPath(member.name)
                if pure.is_absolute() or ".." in pure.parts or not pure.parts or pure.parts[0] != corpus_root_name:
                    raise GateFailure("exact_output", f"unsafe corpus member: {member.name}")
                if not member.isfile():
                    raise GateFailure("exact_output", f"non-regular corpus member: {member.name}")
                source = tf.extractfile(member)
                if source is None:
                    raise GateFailure("exact_output", f"unreadable corpus member: {member.name}")
                output = destination.joinpath(*pure.parts)
                output.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with output.open("wb") as dst:
                    shutil.copyfileobj(source, dst, length=1024 * 1024)
                output.chmod(0o444)
    corpus_root = destination / corpus_root_name
    if not corpus_root.is_dir():
        raise GateFailure("exact_output", "corpus root missing after extraction")
    return destination


def candidate_pids() -> list[int]:
    found: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text("utf-8", errors="replace")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        for line in status.splitlines():
            if not line.startswith("Uid:"):
                continue
            ids = line.split()[1:]
            if ids and all(int(value) == CANDIDATE_UID for value in ids):
                found.append(int(entry.name))
            break
    return found


def reap_candidate_descendants() -> None:
    deadline = time.monotonic() + 1.0
    while True:
        while True:
            try:
                waited, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if waited == 0:
                break
        pids = candidate_pids()
        if not pids:
            return
        for child in pids:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if time.monotonic() >= deadline:
            raise GateFailure("tests_pass", "candidate descendants survived cleanup")
        time.sleep(0.01)


def child_setup() -> None:
    _WORKER.enter_candidate(CANDIDATE_UID, CANDIDATE_GID, MAX_BUILD_FILE)


def isolate_mount_namespace(scratch: Path) -> None:
    """Give this forked worker a private, ephemeral mount namespace.

    Runs in the child while still root (before privilege drop). A fresh
    namespace with only a per-invocation writable tmpfs at ``scratch`` means
    the candidate binary has no persistent writable surface across warmup and
    measured repetitions: the sealed executable and read-only corpus remain the
    only durable state, and anything written here evaporates when this process
    exits. This closes the warmup-record-then-replay gaming vector.
    """
    if _LIBC.unshare(CLONE_NEWNS) != 0:
        raise OSError(ctypes.get_errno(), "unshare(CLONE_NEWNS) failed")
    if _LIBC.mount(b"none", b"/", None, MS_REC | MS_PRIVATE, None) != 0:
        raise OSError(ctypes.get_errno(), "mount / private failed")
    target = os.fsencode(str(scratch))
    data = f"size=64m,mode=0700,uid={CANDIDATE_UID},gid={CANDIDATE_GID}".encode("ascii")
    if _LIBC.mount(b"tmpfs", target, b"tmpfs", MS_NOSUID | MS_NODEV, data) != 0:
        raise OSError(ctypes.get_errno(), "mount scratch tmpfs failed")


def run_child(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout_sec: float,
    isolate: bool = False,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="command-", dir=BUILD_ROOT) as td:
        stdout_path = Path(td) / "stdout"
        stderr_path = Path(td) / "stderr"
        scratch: Path | None = None
        if isolate:
            scratch = Path(td) / "scratch"
            scratch.mkdir(mode=0o755)
            env = {**env, "TMPDIR": str(scratch)}
        out_fd = os.open(stdout_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        err_fd = os.open(stderr_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        started = time.perf_counter_ns()
        pid = os.fork()
        if pid == 0:
            try:
                os.dup2(out_fd, 1)
                os.dup2(err_fd, 2)
                os.close(out_fd)
                os.close(err_fd)
                os.chdir(cwd)
                if scratch is not None:
                    isolate_mount_namespace(scratch)
                child_setup()
                os.execve(argv[0], argv, env)
            except BaseException as err:
                os.write(2, f"exec failed: {err}\n".encode("utf-8", "replace"))
                os._exit(126)
        os.close(out_fd)
        os.close(err_fd)
        deadline = time.monotonic() + timeout_sec
        status = 0
        usage = None
        while True:
            waited, status, usage = os.wait4(pid, os.WNOHANG)
            if waited == pid:
                break
            if time.monotonic() >= deadline:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                _, status, usage = os.wait4(pid, 0)
                reap_candidate_descendants()
                raise GateFailure("tests_pass", f"command timed out after {timeout_sec:.0f}s: {argv[0]}")
            time.sleep(0.002)
        elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        reap_candidate_descendants()
        stdout = stdout_path.read_bytes()
        stderr = stderr_path.read_bytes()
        if len(stdout) > MAX_COMMAND_OUTPUT or len(stderr) > MAX_COMMAND_OUTPUT:
            raise GateFailure("tests_pass", "command output exceeded sealed limit")
        if os.WIFEXITED(status):
            exit_code = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            exit_code = 128 + os.WTERMSIG(status)
        else:
            exit_code = 125
        assert usage is not None
        return {
            "exitCode": exit_code,
            "stdout": stdout,
            "stderr": stderr,
            "elapsedMs": elapsed_ms,
            "peakRssKb": int(usage.ru_maxrss),
        }


def build_and_test(work: Path) -> tuple[Path, float]:
    target = BUILD_ROOT / "target"
    cargo_home = BUILD_ROOT / "cargo-home"
    target.mkdir(mode=0o777, exist_ok=True)
    cargo_home.mkdir(mode=0o777, exist_ok=True)
    target.chmod(0o777)
    cargo_home.chmod(0o777)
    candidate_tmp = BUILD_ROOT / "candidate-tmp"
    candidate_tmp.mkdir(mode=0o777, exist_ok=True)
    candidate_tmp.chmod(0o777)
    env = {
        "CARGO_HOME": str(cargo_home),
        "CARGO_BUILD_JOBS": "2",
        "CARGO_NET_OFFLINE": "true",
        "CARGO_TARGET_DIR": str(target),
        "CARGO_TERM_COLOR": "never",
        "HOME": str(BUILD_ROOT / "home"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": os.environ.get("PATH", "/usr/local/cargo/bin:/usr/local/rustup/bin:/usr/bin:/bin"),
        "RUST_BACKTRACE": "0",
        "RUSTUP_HOME": os.environ.get("RUSTUP_HOME", "/usr/local/rustup"),
        "SOURCE_DATE_EPOCH": "0",
        "TMPDIR": str(candidate_tmp),
    }
    home = Path(env["HOME"])
    home.mkdir(mode=0o777, exist_ok=True)
    home.chmod(0o777)
    started = time.perf_counter()
    result = run_child(
        [
            shutil.which("cargo") or "/usr/local/cargo/bin/cargo",
            "test",
            "--release",
            "--locked",
            "--offline",
            "--quiet",
            "--tests",
            "-p",
            "grep-searcher",
            "-p",
            "grep-regex",
            "-p",
            "ignore",
            "-p",
            "ripgrep",
        ],
        cwd=work,
        env=env,
        timeout_sec=BUILD_TIMEOUT_SEC,
    )
    if result["exitCode"] != 0:
        detail = result["stderr"].decode("utf-8", "replace")[-4000:]
        raise GateFailure("tests_pass", f"relevant cargo tests failed: {detail}")
    binary = target / "release" / "rg"
    binary.unlink(missing_ok=True)
    rebuild = run_child(
        [
            shutil.which("cargo") or "/usr/local/cargo/bin/cargo",
            "build",
            "--release",
            "--locked",
            "--offline",
            "--quiet",
            "--bin",
            "rg",
        ],
        cwd=work,
        env=env,
        timeout_sec=BUILD_TIMEOUT_SEC,
    )
    if rebuild["exitCode"] != 0:
        detail = rebuild["stderr"].decode("utf-8", "replace")[-4000:]
        raise GateFailure("tests_pass", f"post-test rg rebuild failed: {detail}")
    binary = target / "release" / "rg"
    if not binary.is_file():
        raise GateFailure("tests_pass", "cargo tests did not produce the rg binary")
    return binary, time.perf_counter() - started


def seal_binary(binary: Path) -> Path:
    """Copy the freshly built rg into a root-owned, read-only directory.

    The build directory is candidate-writable, so the binary that ran the
    cargo build could be swapped or shadowed with a warmup-record between the
    unmeasured warmup and the measured repetitions. Sealing it root-owned and
    read-only, with no writable sibling, makes the measured executable
    immutable and unforgeable for the duration of the search phase.
    """
    sealed_dir = BUILD_ROOT / "sealed"
    if sealed_dir.exists():
        shutil.rmtree(sealed_dir)
    sealed_dir.mkdir(mode=0o755)
    sealed = sealed_dir / "rg"
    shutil.copyfile(binary, sealed)
    os.chmod(sealed, 0o555)
    os.chmod(sealed_dir, 0o555)
    return sealed


def lock_down_build_surfaces() -> None:
    """Remove every candidate-writable build surface before measuring.

    Once the binary is sealed and the corpus extracted read-only, no durable
    writable location must survive into the search phase. Dropping the 0777
    build/target/cargo/home/tmp directories leaves the candidate with only the
    fresh per-invocation tmpfs granted by isolate_mount_namespace.
    """
    for name in ("work", "target", "cargo-home", "candidate-tmp", "home"):
        path = BUILD_ROOT / name
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)


def load_benchsuite_module() -> Any:
    path = TRUSTED / "benchsuite" / "benchsuite"
    loader = importlib.machinery.SourceFileLoader("ripgrep_upstream_benchsuite", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise GateFailure("exact_output", "cannot load upstream benchsuite")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def search_environment() -> dict[str, str]:
    return {
        "HOME": "/nonexistent",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "PATH": "/usr/bin:/bin",
        "RIPGREP_CONFIG_PATH": "/nonexistent",
        "TERM": "dumb",
    }


def evaluate_searches(
    binary: Path,
    corpus_cwd: Path,
    config: dict[str, Any],
) -> tuple[float, int, dict[str, list[float]], str]:
    module = load_benchsuite_module()
    expected = config.get("expected")
    cases = config.get("cases")
    warmups = config.get("warmupRepetitions")
    repetitions = config.get("measurementRepetitions")
    processes_per_sample = config.get("processesPerSample", 1)
    rss_limit = config.get("peakRssLimitKb")
    if not isinstance(expected, dict) or not isinstance(cases, list):
        raise GateFailure("exact_output", "sealed expected-result table missing")
    if not isinstance(warmups, int) or warmups < 1 or not isinstance(repetitions, int) or repetitions < 3:
        raise GateFailure("exact_output", "invalid benchsuite repetition counts")
    if not isinstance(processes_per_sample, int) or not 1 <= processes_per_sample <= 8:
        raise GateFailure("exact_output", "invalid process batch size")
    if not isinstance(rss_limit, int) or rss_limit <= 0:
        raise GateFailure("peak_rss", "invalid sealed RSS limit")
    medians: list[float] = []
    timings: dict[str, list[float]] = {}
    observed_results: dict[str, str] = {}
    peak_rss = 0
    env = search_environment()
    for raw_case in cases:
        case_id = raw_case.get("id")
        args = raw_case.get("args")
        pattern = raw_case.get("pattern")
        if not isinstance(case_id, str) or not isinstance(args, list) or not all(isinstance(x, str) for x in args):
            raise GateFailure("exact_output", "malformed benchsuite case")
        sealed = expected.get(case_id)
        if not isinstance(sealed, dict):
            raise GateFailure("exact_output", f"missing expected result for {case_id}")
        command = module.Command("rg", [str(binary), *args], cwd=str(corpus_cwd), env=env)
        benchmark = module.Benchmark(
            name=case_id,
            pattern=pattern,
            commands=[command],
            warmup_count=warmups,
            count=repetitions,
            line_count=True,
        )
        benchmark.raise_if_missing()
        samples: list[float] = []
        for index in range(benchmark.warmup_count + benchmark.count):
            batch_elapsed_ms = 0.0
            for _ in range(processes_per_sample):
                outcome = run_child(command.cmd, cwd=corpus_cwd, env=env, timeout_sec=SEARCH_TIMEOUT_SEC, isolate=True)
                stdout_hash = sha256_bytes(outcome["stdout"])
                stderr_hash = sha256_bytes(outcome["stderr"])
                observed_hash = result_hash(outcome["exitCode"], stdout_hash, stderr_hash)
                if (
                    outcome["exitCode"] != sealed.get("exitCode")
                    or stdout_hash != sealed.get("stdoutSha256")
                    or stderr_hash != sealed.get("stderrSha256")
                    or observed_hash != sealed.get("resultSha256")
                ):
                    raise GateFailure("exact_output", f"exact result mismatch for {case_id}")
                peak_rss = max(peak_rss, outcome["peakRssKb"])
                if outcome["peakRssKb"] > rss_limit:
                    raise GateFailure(
                        "peak_rss",
                        f"{case_id} peak RSS {outcome['peakRssKb']} KiB exceeds {rss_limit} KiB",
                    )
                observed_results[case_id] = observed_hash
                batch_elapsed_ms += outcome["elapsedMs"]
            if index >= benchmark.warmup_count:
                samples.append(batch_elapsed_ms)
        samples.sort()
        median = samples[len(samples) // 2]
        if not math.isfinite(median) or median <= 0:
            raise GateFailure("exact_output", f"non-finite latency for {case_id}")
        timings[case_id] = samples
        medians.append(median)
    geometric_mean_ms = math.exp(sum(math.log(value) for value in medians) / len(medians))
    q = 1.0 / geometric_mean_ms
    if not math.isfinite(q) or q <= Q_FAIL:
        raise GateFailure("exact_output", "non-finite oriented scalar")
    digest = sha256_bytes(json.dumps(observed_results, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return q, peak_rss, timings, digest


def output_failure(failure: GateFailure, elapsed_sec: float) -> dict[str, Any]:
    constraints = {
        "tests_pass": False,
        "source_envelope": failure.gate != "source_envelope",
        "exact_output": False,
        "peak_rss": False,
    }
    if failure.gate == "exact_output":
        constraints["tests_pass"] = True
        constraints["source_envelope"] = True
    elif failure.gate == "peak_rss":
        constraints["tests_pass"] = True
        constraints["source_envelope"] = True
        constraints["exact_output"] = True
    return {
        "valid": False,
        "objectives": {"score": Q_FAIL},
        "constraints": constraints,
        "perExample": {"aggregate": {"score": Q_FAIL, "feedback": failure.detail}},
        "diagnostics": {
            "summary": f"qFail: {failure.gate}: {failure.detail}",
            "quality": 0.0,
            "q": Q_FAIL,
            "qFail": Q_FAIL,
            "evalSec": elapsed_sec,
            "upstreamRevision": UPSTREAM_REVISION,
        },
    }


def main() -> None:
    started = time.perf_counter()
    try:
        verify_mutable_envelope()
        mount_build_tmpfs()
        work = copy_candidate()
        cases_path, config = locate_cases()
        binary, build_sec = build_and_test(work)
        corpus_cwd = extract_corpus(cases_path, config)
        sealed_binary = seal_binary(binary)
        lock_down_build_surfaces()
        q, peak_rss, timings, correctness_digest = evaluate_searches(sealed_binary, corpus_cwd, config)
        output = {
            "valid": True,
            "objectives": {"score": q},
            "constraints": {
                "tests_pass": True,
                "source_envelope": True,
                "exact_output": True,
                "peak_rss": True,
            },
            "perExample": {"aggregate": {"score": q}},
            "diagnostics": {
                "summary": "relevant cargo tests and six sealed upstream-benchsuite searches passed",
                "quality": 1.0,
                "q": q,
                "qFail": Q_FAIL,
                "buildAndTestSec": build_sec,
                "evalSec": time.perf_counter() - started,
                "peakRssKb": peak_rss,
                "peakRssLimitKb": config["peakRssLimitKb"],
                "latencySamplesMs": timings,
                "correctnessDigest": correctness_digest,
                "upstreamRevision": UPSTREAM_REVISION,
            },
        }
    except GateFailure as failure:
        output = output_failure(failure, time.perf_counter() - started)
    except BaseException as err:
        output = output_failure(
            GateFailure("tests_pass", f"evaluator fail-closed: {type(err).__name__}: {err}"),
            time.perf_counter() - started,
        )
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
