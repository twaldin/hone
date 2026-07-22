"""Trusted pytest plugin: streams one structured record per test outcome to
the trusted conductor over an inherited pipe, so the trusted side can count
completed test results itself instead of trusting summary text printed by a
process that has imported the candidate native extension.

This module is loaded via `-p orjson_report_sink` during pytest bootstrap,
BEFORE any conftest or test module imports the candidate extension. At import
it consumes a one-shot per-run nonce the conductor fed it over a dedicated
pipe, closes that pipe, drops the fd/nonce advertisements from the
environment, and marks the record fd close-on-exec so no candidate subprocess
inherits it. The first record it emits is `H\t<nonce>`: only code that ran
before the candidate extension (i.e. this trusted plugin) could have read the
nonce from the one-shot pipe, so the conductor can reject a stream that a
candidate merely writes to the advertised channel.

Record format (tab-separated, one per line):
    H\t<nonce>              authenticated stream header (emitted once, first)
    P\t<nodeid>             test call passed
    S\t<nodeid>             test skipped (setup or call)
    F\t<nodeid>             any failure or error in any phase

The session boundary is NOT reported here — the conductor owns it via pytest's
real exit status, so a candidate-emitted session record buys nothing.
"""
from __future__ import annotations

import fcntl
import os

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


def _emit(payload: bytes) -> None:
    payload = payload + b"\n"
    offset = 0
    while offset < len(payload):
        offset += os.write(_REPORT_FD, payload[offset:])


# Authenticate the stream first, before any test runs.
_emit(b"H\t" + _NONCE)


def pytest_runtest_logreport(report) -> None:
    nodeid = report.nodeid.replace("\t", " ").replace("\n", " ").encode("utf-8", "backslashreplace")
    if report.when == "call":
        if report.passed:
            _emit(b"P\t" + nodeid)
        elif report.skipped:
            _emit(b"S\t" + nodeid)
        else:
            _emit(b"F\t" + nodeid)
    elif report.skipped:
        _emit(b"S\t" + nodeid)
    elif report.failed:
        _emit(b"F\t" + nodeid)
