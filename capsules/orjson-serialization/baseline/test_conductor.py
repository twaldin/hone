#!/usr/bin/env python3
"""Trusted per-file test-record conductor for OSS-T08 (EXEC-BOUNDARY).

The authenticated pass/fail decision for the upstream pytest suite is produced
HERE, in a process that NEVER imports the candidate native extension. The
conductor drives one pytest subprocess PER TEST FILE. Each pytest subprocess is
the only process that loads the candidate extension; it runs in a *separate*
process whose sole product the conductor consumes is (a) its exit code and
(b) the JUnit XML pytest itself writes at session finish to a conductor-owned
scratch path. The conductor derives every count and the identity fingerprint
from those artifacts and relays ONE trusted summary to the parent over an
inherited private channel.

Why this closes the round-4 residual:

  Round-4 fed a one-shot nonce + a report fd to a trusted pytest *plugin* that
  ran INSIDE the candidate process. Candidate native module-init runs in that
  same interpreter and could scrape ``sys.modules['orjson_report_sink']._NONCE``
  (and the live report fd), write a forged authenticated session summary, and
  ``os._exit(0)`` before a single test executed — the expected identity was
  derivable offline from the public suite.

  This version delivers NO nonce and NO record fd into any process that loads
  the extension. There is nothing in the pytest process for candidate code to
  scrape, and no in-process channel it can author that the trusted side reads.
  Pass/fail is derived solely from each child's exit code plus the conductor's
  own count of completed children (files whose pytest actually reached session
  finish and emitted a parseable JUnit report) measured against the frozen
  expected per-file counts and identity. A candidate that ``os._exit(0)``s
  during import never lets pytest reach ``pytest_sessionfinish``, so no JUnit
  report is written for that file: the file is not counted as completed and the
  observed totals fall below the frozen expectation, failing the gate.

Ownership chain:

    eval.py (root, host ns)
      └─ os.pipe() -> parent-owned record channel; parent holds the read end
         and passes ONLY the write end to the conductor via pass_fds
           └─ conductor (uid 2000, fresh NET/IPC/PID/UTS ns via worker_preexec)
              · PR_SET_DUMPABLE=0  -> same-uid candidate code cannot ptrace it
                or read /proc/<pid>/fd, so the parent channel is unreachable
              · sets FD_CLOEXEC on the parent channel and scrubs its env, so
                no pytest subprocess (or descendant) inherits it
                └─ pytest (uid 2000), ONE per test file -> imports the candidate
                   extension; writes its own JUnit XML at session finish

The conductor authenticates by construction: it never trusts anything the
candidate-linked pytest writes to stdout/stderr for the verdict, and the parent
channel it writes to is unreachable from the candidate process.
"""
from __future__ import annotations

import base64
import ctypes
import fcntl
import glob
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

PR_SET_DUMPABLE = 4
_LIBC = ctypes.CDLL(None, use_errno=True)


def _fail(message: str) -> None:
    sys.stderr.write(f"test_conductor: {message}\n")
    raise SystemExit(3)


def _set_cloexec(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFD)
    fcntl.fcntl(fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)


def _parse_junit(path: str) -> tuple[int, int, int, int, list[str]] | None:
    """Return (passed, skipped, failed, errored, identity_lines) from a pytest
    JUnit XML, or None if the report is absent/unparseable (which is how an
    early ``os._exit`` before session finish surfaces: no report at all).

    identity_lines are ``<kind>\\t<classname>\\t<name>`` for every pass/skip,
    excluding volatile attributes (time), so the fingerprint is deterministic
    across runs and independent of testcase emission order once sorted."""
    try:
        tree = ET.parse(path)
    except (OSError, ET.ParseError):
        return None
    root = tree.getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    passed = skipped = failed = errored = 0
    identity: list[str] = []
    for suite in suites:
        for case in suite.iter("testcase"):
            classname = case.get("classname", "")
            name = case.get("name", "")
            has_failure = case.find("failure") is not None
            has_error = case.find("error") is not None
            has_skip = case.find("skipped") is not None
            if has_error:
                errored += 1
                continue
            if has_failure:
                failed += 1
                continue
            if has_skip:
                skipped += 1
                kind = "S"
            else:
                passed += 1
                kind = "P"
            identity.append(f"{kind}\t{classname}\t{name}")
    return passed, skipped, failed, errored, identity


def main() -> None:
    # Sever same-uid reach from candidate code (ptrace, /proc/<pid>/fd,
    # /proc/<pid>/mem) to this process's private parent channel BEFORE anything.
    if _LIBC.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        code = ctypes.get_errno()
        _fail(f"cannot clear dumpable flag: {os.strerror(code)}")

    try:
        out_fd = int(os.environ["HONE_CONDUCTOR_OUT_FD"])
        base_argv = json.loads(os.environ["HONE_PYTEST_BASE_ARGV"])
        test_root = os.environ["HONE_TEST_ROOT"]
        site = os.environ["HONE_SITE"]
        trusted_dir = os.environ["HONE_TRUSTED_DIR"]
        deadline_sec = float(os.environ["HONE_CONDUCTOR_DEADLINE"])
        manifest_raw = os.environ.get("HONE_TEST_MANIFEST", "")
    except (KeyError, ValueError) as exc:
        _fail(f"missing/invalid conductor configuration: {exc}")
    if not isinstance(base_argv, list) or not all(isinstance(a, str) for a in base_argv):
        _fail("HONE_PYTEST_BASE_ARGV is not a string list")

    manifest: dict[str, dict] = {}
    if manifest_raw:
        try:
            manifest = json.loads(manifest_raw)
        except ValueError:
            _fail("HONE_TEST_MANIFEST is not valid JSON")

    # The parent record channel must never survive into the candidate process.
    _set_cloexec(out_fd)

    # File set: frozen manifest when validating; otherwise (capture) discover.
    if manifest:
        files = sorted(manifest.keys())
    else:
        files = sorted(
            os.path.basename(p)
            for p in glob.glob(os.path.join(test_root, "test_*.py"))
        )

    child_env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("HONE_")
    }
    child_env["PYTHONPATH"] = f"{site}:{trusted_dir}"
    child_env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"

    extension_fd_raw = os.environ.get("HONE_EXTENSION_FD")
    pass_fds: tuple[int, ...] = ()
    if extension_fd_raw is not None:
        try:
            pass_fds = (int(extension_fd_raw),)
        except ValueError:
            _fail("HONE_EXTENSION_FD is not an integer")

    scratch = tempfile.mkdtemp(prefix="orjson-junit-", dir="/tmp")
    started = time.monotonic()

    observed: dict[str, dict] = {}
    identity_lines: list[str] = []
    detail = ""
    aborted = False

    for index, name in enumerate(files):
        target = os.path.join(test_root, name)
        if not os.path.isfile(target):
            detail = f"missing test file: {name}"
            aborted = True
            break
        remaining = deadline_sec - (time.monotonic() - started)
        if remaining <= 1.0:
            detail = f"deadline exhausted before {name}"
            aborted = True
            break
        # Bound each file so one hang cannot consume the whole budget while
        # still leaving room for the files that follow.
        files_left = len(files) - index
        per_file = max(5.0, remaining / files_left) if files_left else remaining
        per_file = min(per_file, remaining)

        xml_path = os.path.join(scratch, f"{index:03d}.xml")
        argv = list(base_argv) + ["--junit-xml", xml_path, target]
        log = tempfile.TemporaryFile(dir="/tmp")
        try:
            proc = subprocess.Popen(
                argv,
                cwd=trusted_dir,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                pass_fds=pass_fds,
                start_new_session=True,
            )
        except OSError as exc:
            detail = f"cannot launch pytest for {name}: {exc}"
            aborted = True
            log.close()
            break

        try:
            child_exit = proc.wait(timeout=per_file)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            child_exit = 124

        parsed = _parse_junit(xml_path)
        if parsed is None:
            # No session-finish report: an early exit (e.g. os._exit during the
            # candidate extension's import) or a crash. Not a completed file.
            try:
                log.seek(0)
                tail = log.read()[-400:].decode("utf-8", "replace").strip().splitlines()
            except OSError:
                tail = []
            detail = f"{name}: no test report (exit {child_exit})"
            if tail:
                detail = f"{detail}: {tail[-1]}"
            observed[name] = {
                "passed": 0,
                "skipped": 0,
                "failed": 0,
                "errored": 0,
                "exit": child_exit,
                "completed": False,
            }
            log.close()
            # Keep going so the trailer reports the full picture, but the
            # missing report already guarantees a totals shortfall.
            continue
        log.close()

        passed, skipped, failed, errored, lines = parsed
        completed = child_exit == 0 and failed == 0 and errored == 0
        observed[name] = {
            "passed": passed,
            "skipped": skipped,
            "failed": failed,
            "errored": errored,
            "exit": child_exit,
            "completed": completed,
        }
        if completed:
            identity_lines.extend(f"{name}\t{line}" for line in lines)
        elif not detail:
            detail = f"{name}: exit {child_exit}, {failed} failed, {errored} errored"

    # Cleanup scratch reports.
    try:
        for entry in os.listdir(scratch):
            try:
                os.unlink(os.path.join(scratch, entry))
            except OSError:
                pass
        os.rmdir(scratch)
    except OSError:
        pass

    total_passed = sum(v["passed"] for v in observed.values())
    total_skipped = sum(v["skipped"] for v in observed.values())
    total_failed = sum(v["failed"] for v in observed.values())
    total_errored = sum(v["errored"] for v in observed.values())
    completed_files = sum(1 for v in observed.values() if v["completed"])
    expected_files = len(files)

    identity_hash = hashlib.sha256(
        "\n".join(sorted(identity_lines)).encode("utf-8")
    ).hexdigest()

    # The conductor's own verdict (defence in depth; eval.py re-checks against
    # the frozen challenge authoritatively): every expected file must have run
    # to session finish with zero failures/errors.
    authenticated = (
        not aborted
        and completed_files == expected_files
        and total_failed == 0
        and total_errored == 0
    )

    manifest_b64 = base64.b64encode(
        json.dumps(observed, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    detail_b64 = base64.b64encode(detail.encode("utf-8")).decode("ascii") if detail else ""

    # Trailer (all trusted-derived; nonce-free — the channel itself is private):
    #   C \t auth \t passed \t skipped \t failed \t errored
    #     \t completed_files \t expected_files \t identity_sha256
    #     \t manifest_b64 \t detail_b64
    out = (
        "C\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%s\t%s\n"
        % (
            1 if authenticated else 0,
            total_passed,
            total_skipped,
            total_failed,
            total_errored,
            completed_files,
            expected_files,
            identity_hash,
            manifest_b64,
            detail_b64,
        )
    ).encode("utf-8")

    view = memoryview(out)
    offset = 0
    while offset < len(view):
        try:
            offset += os.write(out_fd, view[offset:])
        except OSError:
            break
    os.close(out_fd)


if __name__ == "__main__":
    main()
