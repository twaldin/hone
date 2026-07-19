#!/usr/bin/env python3
"""Read-only Go build cache with anonymous in-memory writes.

The capsule evaluator runs with a read-only root and a deliberately tiny
/tmp. Cache hits come from the image-baked cache; candidate-specific misses
live in memfd files owned by this helper until the go command closes it.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

BASE = Path("/opt/hone-go-cache")
entries: dict[bytes, tuple[bytes, int, int]] = {}
held_fds: list[int] = []


def reply(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_nonempty_line() -> str:
    while True:
        line = sys.stdin.readline()
        if line == "":
            raise EOFError("cache request body ended early")
        if line.strip():
            return line


def base_entry(action_id: bytes) -> tuple[bytes, int, str] | None:
    key = action_id.hex()
    metadata = BASE / key[:2] / f"{key}-a"
    try:
        fields = metadata.read_text().split()
        if len(fields) < 5 or fields[0] != "v1" or fields[1] != key:
            return None
        output_id = bytes.fromhex(fields[2])
        size = int(fields[3])
        output_key = output_id.hex()
        body = BASE / output_key[:2] / f"{output_key}-d"
        if not body.is_file() or body.stat().st_size != size:
            return None
        return output_id, size, str(body)
    except (FileNotFoundError, OSError, ValueError):
        return None


reply({"ID": 0, "KnownCommands": ["get", "put", "close"]})
for line in sys.stdin:
    if not line.strip():
        continue
    request = json.loads(line)
    request_id = int(request["ID"])
    command = request["Command"]
    if command == "close":
        reply({"ID": request_id})
        break
    action_id = base64.b64decode(request["ActionID"])
    if command == "get":
        entry = entries.get(action_id)
        if entry is not None:
            output_id, size, fd = entry
            reply({
                "ID": request_id,
                "OutputID": base64.b64encode(output_id).decode(),
                "Size": size,
                "DiskPath": f"/proc/{os.getpid()}/fd/{fd}",
            })
            continue
        baked = base_entry(action_id)
        if baked is None:
            reply({"ID": request_id, "Miss": True})
        else:
            output_id, size, path = baked
            reply({
                "ID": request_id,
                "OutputID": base64.b64encode(output_id).decode(),
                "Size": size,
                "DiskPath": path,
            })
        continue
    if command == "put":
        output_id = base64.b64decode(request["OutputID"])
        size = int(request.get("BodySize", 0))
        encoded = json.loads(read_nonempty_line()) if size else ""
        body = base64.b64decode(encoded)
        if len(body) != size:
            reply({"ID": request_id, "Err": "cache body size mismatch"})
            continue
        fd = os.memfd_create("hone-go-cache", flags=0)
        held_fds.append(fd)
        view = memoryview(body)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.lseek(fd, 0, os.SEEK_SET)
        entries[action_id] = (output_id, size, fd)
        reply({"ID": request_id, "DiskPath": f"/proc/{os.getpid()}/fd/{fd}"})
        continue
    reply({"ID": request_id, "Err": f"unsupported command: {command}"})
