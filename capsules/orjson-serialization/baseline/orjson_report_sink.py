"""Trusted pytest plugin: records per-test outcomes and, at session finish,
emits ONE authenticated summary to the trusted conductor over an inherited
pipe. The trusted side derives pass/fail from that summary instead of any
text printed by a process that has imported the candidate native extension.

This module is loaded via ``-p orjson_report_sink`` during pytest bootstrap,
BEFORE any conftest or test module imports the candidate extension. At import
it:

  * captures the raw ``os.write`` C function into a local reference, so a later
    candidate import that rebinds ``os.write`` cannot intercept the channel or
    observe the authenticator;
  * consumes a one-shot per-run nonce the conductor fed it over a dedicated
    pipe, then closes that pipe and drops the fd/nonce advertisements from the
    environment;
  * marks the record fd close-on-exec so no candidate subprocess inherits it.

Round-2 emitted an authenticated ``H\\t<nonce>`` header ONCE and then streamed
per-test records with no per-record authentication, so candidate code that
found the inherited fd could append its own ``P``/``S``/``F`` lines after the
valid header and terminate pytest with status 0 without running the suite.

This version emits NOTHING per test on the wire. It buffers outcomes and, only
from ``pytest_sessionfinish`` (which cannot run if the process exits early),
writes a single line:

    Z\\t<nonce>\\t<passed>\\t<skipped>\\t<failed>\\t<duplicates>\\t<identity_sha256>

``identity_sha256`` is sha256 over the sorted ``<kind>\\t<nodeid>`` set of every
passed/skipped test. Only code that read the nonce from the one-shot pipe
(i.e. this trusted plugin, which ran before the candidate extension loaded)
can produce this line, so a candidate that merely writes to the advertised
channel cannot forge it, and one that exits before the suite completes never
produces it at all. The residual — a full in-process interpreter compromise
scraping the plugin's live state for the nonce — is out of scope for a record
channel.
"""
from __future__ import annotations

import fcntl
import hashlib
import os

# Capture the raw write primitive BEFORE any candidate code can rebind os.write.
_OS_WRITE = os.write

_REPORT_FD = int(os.environ["ORJSON_REPORT_FD"])
_NONCE_FD = int(os.environ["ORJSON_REPORT_NONCE_FD"])


def _consume_nonce(fd: int) -> bytes:
    buffer = b""
    while not buffer.endswith(b"\n"):
        chunk = os.read(fd, 128)
        if not chunk:
            break
        buffer += chunk
    os.close(fd)
    return buffer.strip()


_NONCE = _consume_nonce(_NONCE_FD)

# No candidate subprocess spawned by a test may inherit the record channel.
_flags = fcntl.fcntl(_REPORT_FD, fcntl.F_GETFD)
fcntl.fcntl(_REPORT_FD, fcntl.F_SETFD, _flags | fcntl.FD_CLOEXEC)

# Drop the advertisements so candidate code imported later cannot trivially
# rediscover the channel from the environment.
os.environ.pop("ORJSON_REPORT_NONCE_FD", None)
os.environ.pop("ORJSON_REPORT_FD", None)

# Worst outcome seen per node id: F (failure/error) > S (skip) > P (pass).
_OUTCOME: dict[str, str] = {}
_PRIORITY = {"P": 0, "S": 1, "F": 2}


def _record(nodeid: str, kind: str) -> None:
    previous = _OUTCOME.get(nodeid)
    if previous is None or _PRIORITY[kind] > _PRIORITY[previous]:
        _OUTCOME[nodeid] = kind


def pytest_runtest_logreport(report) -> None:
    nodeid = report.nodeid.replace("\t", " ").replace("\n", " ")
    if report.when == "call":
        if report.passed:
            _record(nodeid, "P")
        elif report.skipped:
            _record(nodeid, "S")
        else:
            _record(nodeid, "F")
    elif report.skipped:
        _record(nodeid, "S")
    elif report.failed:
        _record(nodeid, "F")


def pytest_sessionfinish(session, exitstatus) -> None:
    passed = sorted(n for n, k in _OUTCOME.items() if k == "P")
    skipped = sorted(n for n, k in _OUTCOME.items() if k == "S")
    failed = sum(1 for k in _OUTCOME.values() if k == "F")
    identity = "\n".join(
        f"{kind}\t{nodeid}"
        for kind, group in (("P", passed), ("S", skipped))
        for nodeid in group
    )
    identity_hash = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    line = (
        b"Z\t%s\t%d\t%d\t%d\t%d\t%s\n"
        % (
            _NONCE,
            len(passed),
            len(skipped),
            failed,
            len(_OUTCOME) - len(passed) - len(skipped) - failed,
            identity_hash.encode("ascii"),
        )
    )
    offset = 0
    while offset < len(line):
        offset += _OS_WRITE(_REPORT_FD, line[offset:])
