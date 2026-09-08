#!/usr/bin/env python3
"""Protected stdlib evaluator; copied byte-for-byte into each fresh calibration baseline.

Production requires Linux root, private /capsule assets, and a dropped-UID worker.
--offline explicitly exercises cooperative code without claiming OS isolation/admission.
"""
import ctypes
import importlib.util
import gzip
import json
import os
from pathlib import Path
import platform
import resource
import secrets
import selectors
import signal
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
MAX_RESPONSE = 2_000_000
CALL_SECONDS = 15


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def confine_worker():
    """Fail closed: no same-UID parent access, process descendants, or networking."""
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("isolated evaluation requires Linux root")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    os.setgroups([])
    os.setgid(2000)
    os.setuid(2000)
    libc = ctypes.CDLL(None, use_errno=True)
    # Seccomp rejects process creation and cross-process/network access. File reads
    # remain available for stdlib imports; /capsule's root-owned 0700 parent seals assets.
    machine = platform.machine()
    # Also deny io_uring setup/enter/register: async socket operations bypass socket().
    # Deny kill/tkill/tgkill, rt_sigqueueinfo/rt_tgsigqueueinfo and pidfd_send_signal.
    # Parent cleanup stays privileged and unfiltered; workers cannot signal peers.
    if machine == "x86_64":
        arch, denied = 0xC000003E, [56, 57, 58, 435, 101, 310, 311, 41, 53, 425, 426, 427,
                                  62, 200, 234, 129, 297, 424]
    elif machine in ("aarch64", "arm64"):
        arch, denied = 0xC00000B7, [220, 435, 117, 270, 271, 198, 199, 425, 426, 427,
                                  129, 130, 131, 138, 240, 424]
    else:
        raise RuntimeError("unsupported seccomp architecture")

    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

    class Program(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]

    rules = [(0x20, 0, 0, 4), (0x15, 1, 0, arch), (0x06, 0, 0, 0x80000000),
             (0x20, 0, 0, 0)]
    # x32 syscall numbers must not bypass the native syscall deny list.
    rules += [(0x35, 0, 1, 0x40000000), (0x06, 0, 0, 0x80000000)]
    for number in denied:
        rules += [(0x15, 0, 1, number), (0x06, 0, 0, 0x00050001)]
    rules += [(0x06, 0, 0, 0x7FFF0000)]
    filters = (Filter * len(rules))(*(Filter(*row) for row in rules))
    program = Program(len(rules), filters)
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(program), 0, 0):
        raise OSError(ctypes.get_errno(), "cannot confine candidate")


def worker_main(candidate, offline):
    if not offline:
        confine_worker()
    # Candidate stdout is not evaluator output. Protocol is independently parsed
    # by the parent; possession of this fd cannot bypass correctness checks.
    protocol = os.dup(1)
    os.dup2(2, 1)
    task = load_module(Path(candidate) / "task.py", "candidate")
    with os.fdopen(protocol, "w", buffering=1) as output:
        output.write(json.dumps({"ready": True}) + "\n")
        for line in sys.stdin:
            request = json.loads(line)
            result = task.solve(request["input"])
            output.write(json.dumps({"id": request["id"], "result": result},
                                    separators=(",", ":")) + "\n")


class Worker:
    def __init__(self, workspace, offline=False):
        workspace = Path(workspace).resolve()
        self.proc = subprocess.Popen(
            [sys.executable, "-I", "-B", str(ROOT / "eval.py"), "--worker", str(workspace)]
            + (["--offline"] if offline else []),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=workspace, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
            start_new_session=True, bufsize=0,
        )
        self.buffer = b""
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.proc.stdout, selectors.EVENT_READ)
        os.set_blocking(self.proc.stdout.fileno(), False)
        os.set_blocking(self.proc.stdin.fileno(), False)
        try:
            if self.read(time.monotonic() + CALL_SECONDS) != {"ready": True}:
                raise ValueError("invalid worker handshake")
        except BaseException:
            self.close()
            raise

    def read(self, deadline):
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not self.selector.select(remaining):
                raise TimeoutError("candidate response deadline")
            chunk = os.read(self.proc.stdout.fileno(), 65536)
            if not chunk:
                raise ValueError("candidate exited without response")
            self.buffer += chunk
            if len(self.buffer) > MAX_RESPONSE:
                raise ValueError("candidate response exceeds byte limit")
        line, _, self.buffer = self.buffer.partition(b"\n")
        if self.buffer:
            raise ValueError("unsolicited candidate output")
        return json.loads(line)

    def call(self, payload, deadline=None):
        if deadline is None:
            deadline = time.monotonic() + CALL_SECONDS
        request_id = secrets.token_hex(16)
        data = memoryview((json.dumps({"id": request_id, "input": payload},
                                     separators=(",", ":")) + "\n").encode())
        # Bound writes too: a candidate may stop reading a large postings request.
        with selectors.DefaultSelector() as writable:
            writable.register(self.proc.stdin, selectors.EVENT_WRITE)
            while data:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not writable.select(remaining):
                    raise TimeoutError("candidate request deadline")
                try:
                    count = os.write(self.proc.stdin.fileno(), data)
                    data = data[count:]
                except BlockingIOError:
                    continue
        response = self.read(deadline)
        if not isinstance(response, dict) or response.get("id") != request_id or "result" not in response:
            raise ValueError("invalid candidate response")
        return response["result"]

    def close(self):
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.proc.wait()
        self.selector.close()
        self.proc.stdin.close()
        self.proc.stdout.close()


def verify_environment(assets):
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("production requires Linux root; --offline is not admission")
    sealed = Path("/capsule")
    info = sealed.stat()
    if info.st_uid != 0 or info.st_mode & 0o077 or not assets.resolve().is_relative_to(sealed):
        raise RuntimeError("assets require root-owned /capsule mode 0700")


def evaluate_case(workspace, checker, case, mode, offline):
    worker = None
    started = time.perf_counter()
    try:
        worker = Worker(workspace, offline)
        started = time.perf_counter()
        if mode == "online":
            deadline = time.monotonic() + CALL_SECONDS
            ok, quality, detail = checker.evaluate(
                case["input"], lambda payload: worker.call(payload, deadline))
        else:
            result = worker.call(case["input"])
            elapsed = (time.perf_counter() - started) * 1000
            ok, quality, detail = checker.check(case["input"], result)
            return ok, (1 / (1 + elapsed) if mode == "latency" and ok else quality), detail
        return ok, quality, detail
    except (OSError, ValueError, TypeError, KeyError, TimeoutError, RuntimeError, subprocess.SubprocessError) as error:
        return False, 0.0, str(error)
    finally:
        if worker is not None:
            worker.close()


def main():
    offline = "--offline" in sys.argv
    if "--worker" in sys.argv:
        worker_main(sys.argv[sys.argv.index("--worker") + 1], offline)
        return
    assets = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
    workspace = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace")).resolve()
    if not offline:
        verify_environment(assets)
    contract = json.loads((ROOT / "contract.json").read_text())
    checker = load_module(ROOT / "checker.py", "checker")
    cases = []
    for path in sorted(assets.rglob("*.json.gz")):
        with gzip.open(path, "rt") as fixture:
            cases.extend(json.load(fixture))
    if not cases or len({case["id"] for case in cases}) != len(cases):
        raise ValueError("fixtures must contain unique nonempty cases")
    entries, valid = {}, True
    for case in cases:
        ok, score, detail = evaluate_case(workspace, checker, case, contract["mode"], offline)
        valid = valid and ok
        entries[case["id"]] = {"score": score if ok else 0.0, "feedback": detail}
    # Correctness and hard constraints apply to the whole fixed query batch.
    # A candidate cannot score by answering only cheap examples correctly.
    if not valid:
        for entry in entries.values():
            entry["score"] = 0.0
    print(json.dumps({"valid": valid, "objectives": {"score": statistics.fmean(
        entry["score"] for entry in entries.values())}, "constraints": {"tests_pass": valid},
        "perExample": entries, "diagnostics": {"summary": f"{len(cases)} cases",
        "isolation": "offline-unconfined" if offline else "linux-uid-seccomp"}}))


if __name__ == "__main__":
    main()
