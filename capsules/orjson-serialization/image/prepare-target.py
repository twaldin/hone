#!/usr/bin/env python3
"""Create a writable Cargo target overlay backed by image-cached dependencies."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

TEMPLATE = Path("/opt/orjson/target-template")
TARGET = Path(os.environ.get("CARGO_TARGET_DIR", "/tmp/target"))


def mutable_file(relative: Path) -> bool:
    parts = relative.parts
    name = relative.name
    if any(part.startswith("orjson-") for part in parts if part != "orjson-source"):
        return True
    if name == ".cargo-lock" or name.startswith(("orjson", "liborjson")):
        return True
    return False


if TARGET.exists():
    shutil.rmtree(TARGET)
for source_dir, dirnames, filenames in os.walk(TEMPLATE):
    source = Path(source_dir)
    relative_dir = source.relative_to(TEMPLATE)
    destination = TARGET / relative_dir
    destination.mkdir(parents=True, exist_ok=True)
    for name in filenames:
        relative = relative_dir / name
        cached = source / name
        output = destination / name
        if mutable_file(relative):
            # Cargo replaces main-crate fingerprints, while protected build
            # scripts stay image-backed so they remain executable when the
            # broker mounts /tmp noexec.
            if ".fingerprint" in relative.parts:
                shutil.copy2(cached, output)
            elif "build" in relative.parts:
                if cached.stat().st_mode & 0o111:
                    output.symlink_to(cached)
                else:
                    shutil.copy2(cached, output)
            continue
        output.symlink_to(cached)
