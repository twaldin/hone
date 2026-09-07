#!/usr/bin/env python3
"""Freeze baseline formatting and parser-diagnostic hashes."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

RUNNER = Path("/opt/target-seed/release/hone_biome_bench")
ROOT = Path("/assets")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


for split in ("train", "validation"):
    split_dir = ROOT / split
    files: dict[str, object] = {}
    for source in sorted(path for path in split_dir.iterdir() if path.suffix in {".js", ".jsx", ".ts", ".tsx", ".css"}):
        with tempfile.TemporaryDirectory() as tmp_raw:
            tmp = Path(tmp_raw)
            output = tmp / "formatted"
            second = tmp / "second"
            diagnostics = tmp / "diagnostics"
            subprocess.run(
                [str(RUNNER), "verify", str(source), str(output), str(second), str(diagnostics)],
                check=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
            )
            if output.read_bytes() != second.read_bytes():
                raise RuntimeError(f"baseline formatter is not idempotent for {source.name}")
            files[source.name] = {
                "inputSha256": digest(source),
                "formattedSha256": digest(output),
                "diagnosticSha256": digest(diagnostics),
                "formattedBytes": output.stat().st_size,
            }
    expected = {
        "schema": "hone-biome-expected-v2",
        "sourceRevision": "8ebafe1c7489f1f7af379b8e52b8ad063c82d28a",
        "split": split,
        "files": files,
    }
    (split_dir / "expected.json").write_text(
        json.dumps(expected, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
