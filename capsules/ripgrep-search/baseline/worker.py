#!/usr/bin/env python3
"""Privilege-drop glue used by the trusted ripgrep evaluator's forked workers."""
from __future__ import annotations

import os
import resource


def enter_candidate(uid: int, gid: int, max_file_bytes: int) -> None:
    """Create a process group, bound resources, and irreversibly drop to candidate uid."""
    os.setsid()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_file_bytes, max_file_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
