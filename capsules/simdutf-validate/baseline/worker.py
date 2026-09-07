#!/usr/bin/env python3
"""Exec a trusted binary from a memfd under a noexec evaluator tmpfs.

Inherited pipe file descriptors (the control channel, passed by the trusted
parent) survive the execve because they are not close-on-exec; their numbers are
forwarded verbatim as the trailing argv."""
from __future__ import annotations

import os
import sys


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(64)
    binary = sys.argv[1]
    fd = os.memfd_create("hone-runner", flags=0)
    with open(binary, "rb", buffering=0) as source:
        while chunk := source.read(1 << 20):
            os.write(fd, chunk)
    os.fchmod(fd, 0o500)
    os.execve(f"/proc/self/fd/{fd}", [binary, *sys.argv[2:]], os.environ)


if __name__ == "__main__":
    main()
