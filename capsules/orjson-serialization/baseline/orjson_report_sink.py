"""Trusted pytest plugin: streams one structured record per test outcome to
the evaluator parent over an inherited pipe, so the trusted side can count
completed test results itself instead of trusting summary text printed by a
process that has imported the candidate native extension.

Record format (tab-separated, one per line):
    P\t<nodeid>              test call passed
    S\t<nodeid>              test skipped (setup or call)
    F\t<nodeid>              any failure or error in any phase
    Z\t<exitstatus>\t<collected>   session finished
"""
from __future__ import annotations

import os

_REPORT_FD = int(os.environ["ORJSON_REPORT_FD"])


def _emit(record: str) -> None:
    payload = record.encode("utf-8", "backslashreplace") + b"\n"
    offset = 0
    while offset < len(payload):
        offset += os.write(_REPORT_FD, payload[offset:])


def pytest_runtest_logreport(report) -> None:
    nodeid = report.nodeid.replace("\t", " ").replace("\n", " ")
    if report.when == "call":
        if report.passed:
            _emit(f"P\t{nodeid}")
        elif report.skipped:
            _emit(f"S\t{nodeid}")
        else:
            _emit(f"F\t{nodeid}")
    elif report.skipped:
        _emit(f"S\t{nodeid}")
    elif report.failed:
        _emit(f"F\t{nodeid}")


def pytest_sessionfinish(session, exitstatus) -> None:
    _emit(f"Z\t{int(exitstatus)}\t{int(session.testscollected)}")
