#!/usr/bin/env python3
"""Trusted offline evaluator for the simdutf UTF-8 validation + transcoding capsule.

Gaming-resistance model
-----------------------
* EXEC BOUNDARY. The scored measurement loop AND the receipt handshake run in a
  process that links NO candidate code: this trusted parent times the wall clock
  and validates every result, and a small TRUSTED runner (compiled from the
  protected ``hone/runner.cpp``) invokes the candidate. The candidate's
  validation/transcoding kernels are compiled into a shared library the runner
  only dlopens AFTER it has authenticated this parent's control channel, so no
  candidate constructor / ``.init_array`` / module-init can impersonate the
  protocol before the trusted runner's main has run and consumed the auth nonce.
* Per-iteration inputs at CLOCK-START. The per-leg perturbation seed and the
  receipt fold nonce are delivered by this parent over the control pipe only
  after the candidate library is already mapped (the GO line), so no correct
  per-iteration output or folded digest can be precomputed in the untimed
  window. The receipt is bound to that go-time data, never to a pre-go seed,
  argv, env, or an inherited nonce readable before the runner's main.
* Interleaved PRISTINE reference yardstick. Every speed number is a
  candidate/reference wall-time ratio. The reference library is built from the
  sealed TRUSTED sources and is never candidate-linked; reference and candidate
  legs run back-to-back as PAIRS (lead alternated), and the estimator is the
  geometric mean of the per-pair reference/candidate ratios, so sustained host
  contention cancels within each pair.
* Distinct work every iteration. The trusted runner rewrites a sparse, rotating
  subset of code points to same-length valid code points before every timed
  iteration after the first, so no two iterations validate/transcode identical
  bytes and none can be memoized; the validator must re-scan the whole buffer
  regardless, and every iteration's (verdict + transcoded bytes) is folded into
  a go-nonce-bound digest this parent checks against the reference's digest.
* Correctness lives with the trusted reference. The pristine (iteration-0)
  payload and the perturbed-iteration digest oracle are the in-eval reference
  built from trusted sources -- never a candidate self-report. A candidate that
  returns a wrong verdict or wrong bytes fails the payload/digest check; a
  candidate that returns instantly without doing the work cannot reproduce the
  go-nonce-bound digest and is additionally rejected as an implausible speedup.
* Whole-tree peak memory is the kernel-owned cgroup2 ``memory.peak`` of a fresh
  per-launch leaf; candidate-writable residue (/tmp, /var/tmp, /dev/shm, SysV
  IPC) is purged and a fresh SysV-IPC namespace entered between launches.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import resource
import select
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

# Whole-tree memory accounting authority: a fresh root-only cgroup2 hierarchy
# the trusted evaluator mounts (CAP_SYS_ADMIN is granted for exactly this). Each
# candidate launch joins a per-launch leaf BEFORE the privilege drop, so the
# WHOLE candidate process tree (exited children included) is charged to a cgroup
# whose control files the demoted uid can never write; memory.peak is
# kernel-owned and monotone. When the cgroup is unavailable (non-root / non-
# linux developer runs) the launch falls back to a wait4 ru_maxrss reading.
CGROUP_ROOT = Path("/tmp/hone-simdutf-cg")
CGROUP_TRUSTED = CGROUP_ROOT / "trusted"
CGROUP_DRAIN_SEC = 10
_CGROUP_ACTIVE = False
# Candidate-writable residue roots purged between launches.
CANDIDATE_WRITABLE_ROOTS = (Path("/tmp"), Path("/var/tmp"), BUILD_ROOT)
CLONE_NEWIPC = 0x08000000
_LIBC = ctypes.CDLL(None, use_errno=True)


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
            "pristine_payload": False,
            "perturbed_digest": False,
            "malformed_behavior": False,
            "peak_rss": False,
        },
        "perExample": {"aggregate": {"score": Q_FAIL, "feedback": reason}},
        "diagnostics": detail,
    }, separators=(",", ":")))


def checked(command, timeout, label, *, unprivileged=False):
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


# --------------------------------------------------------------------------
# cgroup2 whole-tree memory accounting
# --------------------------------------------------------------------------
def _cgroup_available() -> bool:
    return sys.platform.startswith("linux") and os.geteuid() == 0


def _mount_measurement_cgroup() -> None:
    global _CGROUP_ACTIVE
    _CGROUP_ACTIVE = False
    if not _cgroup_available():
        return
    CGROUP_ROOT.mkdir(mode=0o755, exist_ok=False)
    completed = subprocess.run(
        ["mount", "-t", "cgroup2", "-o", "nosuid,nodev,noexec",
         "hone-simdutf-cg", str(CGROUP_ROOT)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, timeout=10, check=False,
    )
    if completed.returncode != 0:
        CGROUP_ROOT.rmdir()
        raise GateFailure("trusted measurement cgroup mount failed")
    try:
        CGROUP_TRUSTED.mkdir(mode=0o755)
        (CGROUP_TRUSTED / "cgroup.procs").write_text(str(os.getpid()))
        (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")
    except OSError as exc:
        raise GateFailure("trusted measurement cgroup setup failed") from exc
    _CGROUP_ACTIVE = True


def _unmount_measurement_cgroup() -> None:
    if not _CGROUP_ACTIVE:
        return
    subprocess.run(["umount", "-l", str(CGROUP_ROOT)], stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=10, check=False)
    try:
        CGROUP_ROOT.rmdir()
    except OSError:
        pass


def _drain_measurement_leaf(leaf: Path) -> None:
    deadline = time.monotonic() + CGROUP_DRAIN_SEC
    try:
        (leaf / "cgroup.kill").write_text("1")
    except OSError:
        pass
    while True:
        try:
            populated = (leaf / "cgroup.procs").read_text().strip() != ""
        except OSError:
            populated = False
        if not populated:
            break
        if time.monotonic() > deadline:
            raise GateFailure("measurement cgroup could not be drained")
        time.sleep(0.05)
    try:
        leaf.rmdir()
    except OSError as exc:
        raise GateFailure("measurement cgroup could not be retired") from exc


def _make_worker_preexec(leaf_procs=None, fresh_ipc=False):
    def _pre() -> None:
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 << 20, 64 << 20))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        if leaf_procs is not None:
            fd = os.open(leaf_procs, os.O_WRONLY)
            try:
                os.write(fd, b"0")
            finally:
                os.close(fd)
        if os.geteuid() == 0:
            if fresh_ipc and _LIBC.unshare(CLONE_NEWIPC) != 0:
                os._exit(126)
            os.setgroups([])
            os.setgid(WORKER_UID)
            os.setuid(WORKER_UID)

    return _pre


def worker_preexec() -> None:
    _make_worker_preexec()()


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
        uid_line = next((line for line in status.splitlines()
                         if line.startswith("Uid:")), "")
        fields = uid_line.split()
        if len(fields) >= 2 and fields[1] == str(WORKER_UID):
            try:
                os.kill(int(entry.name), signal.SIGKILL)
            except ProcessLookupError:
                pass


def purge_worker_state() -> None:
    for base in CANDIDATE_WRITABLE_ROOTS:
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

    def remove_all(table, remove):
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

    remove_all("shm", lambda ipc_id: _LIBC.shmctl(ipc_id, 0, None))
    remove_all("msg", lambda ipc_id: _LIBC.msgctl(ipc_id, 0, None))
    remove_all("sem", lambda ipc_id: _LIBC.semctl(ipc_id, 0, 0))


# --------------------------------------------------------------------------
# Build: candidate shared library, trusted reference library, trusted runner
# --------------------------------------------------------------------------
CXXFLAGS = ["-std=c++17", "-O3", "-DNDEBUG"]


def _copy_source_envelope(dst_root: Path) -> None:
    if dst_root.exists():
        shutil.rmtree(dst_root)
    for subtree in ("include", "src"):
        source = WORKSPACE / subtree
        for path in source.rglob("*"):
            if path.is_symlink() or (not path.is_dir() and not path.is_file()):
                raise GateFailure(
                    f"candidate compile envelope contains non-regular path: {subtree}")
        shutil.copytree(source, dst_root / subtree)
    for root, _, files in os.walk(dst_root):
        os.chmod(root, 0o755)
        for name in files:
            os.chmod(Path(root) / name, 0o444)


def _build_library(inc: Path, src: Path, out: Path, *, unprivileged: bool) -> None:
    obj_simdutf = BUILD_ROOT / (out.stem + "-simdutf.o")
    obj_kernel = BUILD_ROOT / (out.stem + "-kernel.o")
    checked(["g++", *CXXFLAGS, f"-I{inc}", "-fPIC", "-c", str(src / "simdutf.cpp"),
             "-o", str(obj_simdutf)], float(CHALLENGE["compileTimeoutSec"]),
            f"{out.stem} simdutf compile", unprivileged=unprivileged)
    checked(["g++", *CXXFLAGS, f"-I{inc}", "-fPIC", "-c", str(src / "kernel.cpp"),
             "-o", str(obj_kernel)], float(CHALLENGE["compileTimeoutSec"]),
            f"{out.stem} kernel compile", unprivileged=unprivileged)
    checked(["g++", "-shared", str(obj_kernel), str(obj_simdutf), "-o", str(out)],
            float(CHALLENGE["compileTimeoutSec"]), f"{out.stem} link",
            unprivileged=unprivileged)


def compile_candidate() -> Path:
    if not (WORKSPACE / "src/simdutf.cpp").is_file() or \
       not (WORKSPACE / "src/kernel.cpp").is_file():
        raise GateFailure("candidate source tree is incomplete")
    for forbidden in (WORKSPACE / ".git", WORKSPACE / ".gitdir"):
        if forbidden.exists():
            raise GateFailure("source-control metadata reached mutation workspace")
    _copy_source_envelope(COMPILE_ROOT)
    out = BUILD_ROOT / "libsimdutf_candidate.so"
    try:
        _build_library(COMPILE_ROOT / "include", COMPILE_ROOT / "src", out,
                       unprivileged=True)
        # Root-copy seal (no CAP_CHOWN): re-home the worker-written library into
        # a root-owned file before any candidate process runs again.
        sealed = BUILD_ROOT / "libsimdutf_candidate-sealed.so"
        sealed.write_bytes(out.read_bytes())
        sealed.chmod(0o644)
        out.unlink()
    finally:
        reap_candidate_processes()
        purge_worker_state()
        shutil.rmtree(COMPILE_ROOT, ignore_errors=True)
    return sealed


def build_reference() -> Path:
    prebuilt = OBJECTS / "libsimdutf_reference.so"
    if prebuilt.is_file():
        return prebuilt
    out = BUILD_ROOT / "libsimdutf_reference.so"
    _build_library(TRUSTED / "include", TRUSTED / "src", out, unprivileged=False)
    out.chmod(0o644)
    return out


def build_runner() -> Path:
    prebuilt = OBJECTS / "runner"
    if prebuilt.is_file():
        return prebuilt
    out = BUILD_ROOT / "runner"
    checked(["g++", *CXXFLAGS, str(TRUSTED / "hone/runner.cpp"), "-ldl",
             "-o", str(out)], float(CHALLENGE["compileTimeoutSec"]),
            "trusted runner compile")
    out.chmod(0o755)
    return out


# --------------------------------------------------------------------------
# Split / corpus
# --------------------------------------------------------------------------
def selected_split():
    found = [(name, ASSETS_ROOT / name) for name in ("train", "validation")
             if (ASSETS_ROOT / name).is_dir()]
    if len(found) != 1:
        raise GateFailure("exactly one asset split must be mounted per evaluation")
    return found[0]


def load_split_secrets(source: Path) -> float:
    secret_path = source / "expected.json"
    if not secret_path.is_file():
        raise GateFailure("protected split expectations missing")
    secrets = json.loads(secret_path.read_text())
    baseline_rss = secrets.get("baselinePeakRssKb")
    if not isinstance(baseline_rss, (int, float)) or baseline_rss <= 0:
        raise GateFailure("protected peak-RSS baseline missing")
    return float(baseline_rss)


def stage_corpus(source: Path) -> None:
    if CORPUS.exists():
        shutil.rmtree(CORPUS)
    shutil.copytree(source / "corpus", CORPUS)
    shutil.copytree(source / "malformed", CORPUS / "malformed")
    for root, _, files in os.walk(CORPUS):
        os.chmod(root, 0o755)
        for name in files:
            os.chmod(Path(root) / name, 0o644)


# --------------------------------------------------------------------------
# One measured leg: trusted parent drives the runner over the control channel.
# --------------------------------------------------------------------------
def _read_line(fd: int, deadline: float, buf: bytearray) -> str:
    while True:
        nl = buf.find(b"\n")
        if nl >= 0:
            line = bytes(buf[:nl]).decode("ascii", "replace")
            del buf[:nl + 1]
            return line
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GateFailure("control channel read timed out")
        r, _, _ = select.select([fd], [], [], remaining)
        if not r:
            raise GateFailure("control channel read timed out")
        chunk = os.read(fd, 4096)
        if not chunk:
            raise GateFailure("control channel closed before result")
        buf.extend(chunk)


def run_leg(runner: Path, so: Path, corpus_file: Path, iters: int,
            go_nonce: str, go_seed: int, timeout: float, label: str):
    """Drive one leg. Returns (payload_hex, digest_hex, wall_sec, impl, rss_kb).

    Timing is this trusted parent's wall clock, started immediately before the
    GO line (delivered after the candidate library is already mapped) and
    stopped when the RESULT line arrives -- the only timing source trusted."""
    nonce = uuid.uuid4().hex
    ctrl_r, ctrl_w = os.pipe()
    resp_r, resp_w = os.pipe()
    os.set_inheritable(ctrl_r, True)
    os.set_inheritable(resp_w, True)
    worker = TRUSTED / "worker.py"
    argv = [sys.executable, "-I", "-B", str(worker), str(runner), str(so),
            str(corpus_file), str(ctrl_r), str(resp_w)]
    leaf = None
    if _CGROUP_ACTIVE:
        leaf = CGROUP_ROOT / f"leaf-{nonce}"
        leaf.mkdir(mode=0o755, exist_ok=False)
    leaf_procs = str(leaf / "cgroup.procs") if leaf is not None else None
    buf = bytearray()
    max_rss_kb = 0
    try:
        proc = subprocess.Popen(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, cwd=str(TRUSTED),
            pass_fds=(ctrl_r, resp_w),
            preexec_fn=_make_worker_preexec(leaf_procs, fresh_ipc=True),
        )
        os.close(ctrl_r)
        os.close(resp_w)
        ctrl_r = resp_w = -1
        deadline = time.monotonic() + timeout
        # 1. authenticate: trusted runner main echoes READY before mapping code.
        os.write(ctrl_w, f"AUTH {nonce}\n".encode())
        ready = _read_line(resp_r, deadline, buf)
        want_ready = "READY " + hashlib.sha256(
            f"hone-runner-v1:{nonce}".encode()).hexdigest()
        if ready != want_ready:
            raise GateFailure(f"{label}: runner authentication failed")
        # 2. candidate library is mapped now (untimed); await LOADED.
        loaded = _read_line(resp_r, deadline, buf)
        if loaded != "LOADED":
            raise GateFailure(f"{label}: runner did not report LOADED ({loaded})")
        # 3. CLOCK START -- go-token (fold nonce, perturb seed, iters) drawn by
        #    the caller ONCE PER PAIR so the reference and candidate legs of a
        #    pair perturb identically and their digests are comparable.
        started = time.monotonic()
        os.write(ctrl_w, f"GO {go_nonce} {go_seed} {iters}\n".encode())
        result = _read_line(resp_r, deadline, buf)
        wall = time.monotonic() - started
        if not result.startswith("RESULT "):
            raise GateFailure(f"{label}: runner emitted no result ({result[:120]})")
        _, impl, payload, digest = result.split()
        # reap
        rc = proc.wait(timeout=max(1.0, deadline - time.monotonic()))
        if rc != 0:
            err = proc.stderr.read().decode("utf-8", "replace")[-800:] if proc.stderr else ""
            raise GateFailure(f"{label}: runner exit {rc} {err}")
        if leaf is not None:
            try:
                peak = int((leaf / "memory.peak").read_text(encoding="ascii").strip())
                max_rss_kb = -(-peak // 1024)
            except (OSError, ValueError):
                raise GateFailure(f"{label}: cgroup reported no whole-tree peak")
        return payload, digest, wall, impl, max_rss_kb
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, NameError):
            pass
        raise GateFailure(f"{label} timed out")
    finally:
        for fd in (ctrl_w, resp_r, ctrl_r, resp_w):
            if isinstance(fd, int) and fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, NameError):
            pass
        reap_candidate_processes()
        if leaf is not None:
            _drain_measurement_leaf(leaf)
        purge_worker_state()


# --------------------------------------------------------------------------
# Driver: correctness (vs pristine reference) + parent-timed paired-geomean
# --------------------------------------------------------------------------
class _Driver:
    def __init__(self, runner: Path, candidate: Path, reference: Path) -> None:
        self.runner = runner
        self.candidate = candidate
        self.reference = reference
        self.active_impl = None
        self.max_rss = 0

    def _leg(self, so, corpus_file, iters, go_nonce, go_seed, label):
        payload, digest, wall, impl, rss = run_leg(
            self.runner, so, corpus_file, iters, go_nonce, go_seed,
            float(CHALLENGE["benchmarkTimeoutSec"]), label)
        self.max_rss = max(self.max_rss, rss)
        if self.active_impl is None:
            self.active_impl = impl
        return payload, digest, wall

    @staticmethod
    def _draw_go():
        return uuid.uuid4().hex, uuid.uuid4().int & ((1 << 63) - 1)

    def malformed(self, corpus_file: Path, key: str) -> None:
        # Reference is the trusted oracle; candidate must match its verdict/bytes.
        # One go-token per pair so both legs perturb identically (iters=1 here,
        # so no perturbation runs, but the fold nonce must still match).
        gn, gs = self._draw_go()
        rp, rd, _ = self._leg(self.reference, corpus_file, 1, gn, gs, f"reference {key}")
        cp, cd, _ = self._leg(self.candidate, corpus_file, 1, gn, gs, f"candidate {key}")
        if cp != rp or cd != rd:
            raise GateFailure(f"malformed-input behavior mismatch: {key}")

    def timed(self, corpus_file: Path, key: str) -> float:
        samples = int(CHALLENGE["timingSamples"])
        target = float(CHALLENGE["timingTargetSec"])
        base_iters = int(CHALLENGE["calibIters"])
        floor = float(CHALLENGE["implausibleSpeedupFactor"])

        # Calibrate iteration count against a reference probe so each leg lasts
        # ~target seconds (fixed per-process overhead becomes negligible).
        gn, gs = self._draw_go()
        _, _, probe = self._leg(self.reference, corpus_file, base_iters,
                                gn, gs, f"warmup {key}")
        iters = base_iters
        if probe > 0:
            per = probe / base_iters
            iters = max(base_iters, min(base_iters * 4096, int(target / per)))
        # Candidate warmup at the calibrated count (page cache / CPU ramp).
        self._leg(self.candidate, corpus_file, iters, gn, gs, f"warmup {key}")

        # Min-of-N contention-robust estimator (doctrine for ~1s legs): a
        # persistent ~1-core competitor inside the Docker VM injects
        # DIFFERENTIAL contention that a within-pair geomean cannot cancel;
        # the per-binary global minimum across N alternating reps instead takes
        # each binary's least-contended run, which is robust to such a
        # background load. Every leg is still output-validated against the
        # pristine reference (payload + go-nonce digest); one go-token per pair
        # so reference and candidate perturb identically.
        ref_walls, cand_walls = [], []
        for i in range(samples):
            pn, ps = self._draw_go()
            if i % 2 == 0:
                rp, rd, rw = self._leg(self.reference, corpus_file, iters,
                                       pn, ps, f"reference {key}")
                cp, cd, cw = self._leg(self.candidate, corpus_file, iters,
                                       pn, ps, f"candidate {key}")
            else:
                cp, cd, cw = self._leg(self.candidate, corpus_file, iters,
                                       pn, ps, f"candidate {key}")
                rp, rd, rw = self._leg(self.reference, corpus_file, iters,
                                       pn, ps, f"reference {key}")
            if cp != rp:
                raise GateFailure(f"pristine payload mismatch under timing: {key}")
            if cd != rd:
                raise GateFailure(f"perturbed-iteration digest mismatch: {key}")
            if rw > 0:
                ref_walls.append(rw)
            if cw > 0:
                cand_walls.append(cw)
        if not ref_walls or not cand_walls:
            raise GateFailure(f"no positive parent-measured time for {key}")
        min_ref, min_cand = min(ref_walls), min(cand_walls)
        if min_cand < min_ref / floor:
            raise GateFailure(f"implausible speedup rejected: {key}")
        return min_ref / min_cand


def evaluate(runner, candidate, reference):
    driver = _Driver(runner, candidate, reference)
    metrics = []
    for name in CHALLENGE["validFiles"]:
        key = f"transcode/{name}"
        metrics.append((key, driver.timed(CORPUS / name, key)))
    for name in CHALLENGE["malformedFiles"]:
        driver.malformed(CORPUS / "malformed" / name, f"malformed/{name}")
    return driver.active_impl or "unknown", driver.max_rss, metrics


def main() -> None:
    started = time.monotonic()
    try:
        _mount_measurement_cgroup()
        split, source = selected_split()
        baseline_rss = load_split_secrets(source)
        candidate = compile_candidate()
        reference = build_reference()
        runner = build_runner()
        stage_corpus(source)
        active_impl, peak_rss_kb, metrics = evaluate(runner, candidate, reference)

        rss_limit = baseline_rss * (1.0 + float(CHALLENGE["peakRssToleranceFraction"]))
        if peak_rss_kb > rss_limit:
            raise GateFailure(
                f"peak RSS {peak_rss_kb} KiB exceeds frozen limit {rss_limit:.1f} KiB")
        values = [v for _, v in metrics]
        q = math.exp(sum(math.log(v) for v in values) / len(values))
        if not math.isfinite(q) or q <= Q_FAIL:
            raise GateFailure("oriented scalar is not finite and positive")
        feedback = {
            "split": split,
            "q": q,
            "workloads": dict(metrics),
            "activeImplementation": active_impl,
            "peakRssKb": peak_rss_kb,
            "peakRssLimitKb": rss_limit,
            "wallSec": time.monotonic() - started,
        }
        print(json.dumps({
            "valid": True,
            "objectives": {"q": q},
            "constraints": {
                "tests_pass": True,
                "pristine_payload": True,
                "perturbed_digest": True,
                "malformed_behavior": True,
                "peak_rss": True,
            },
            "perExample": {"aggregate": {"score": q, "feedback": feedback}},
            "diagnostics": {"quality": 1.0, "summary": "all hard gates passed",
                            **feedback},
        }, separators=(",", ":")))
    except BaseException as exc:
        emit_failure(f"{type(exc).__name__}: {exc}",
                     {"wallSec": time.monotonic() - started})
    finally:
        reap_candidate_processes()
        purge_worker_state()
        _unmount_measurement_cgroup()


if __name__ == "__main__":
    main()
