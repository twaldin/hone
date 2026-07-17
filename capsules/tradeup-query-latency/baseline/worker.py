#!/usr/bin/env python3
"""One-shot isolated worker: open one cold read-only database and run one candidate module."""
from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any


def _load_query(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("candidate_query", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("candidate query module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    run = getattr(module, "run", None)
    if not callable(run):
        raise TypeError("query.py must export callable run(connection, workload)")
    return run


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: worker.py QUERY DB WORKLOAD")
    query_path = Path(sys.argv[1]).resolve()
    db_path = Path(sys.argv[2]).resolve()
    workload_path = Path(sys.argv[3]).resolve()
    workload = json.loads(workload_path.read_text())
    run = _load_query(query_path)
    uri = f"file:{db_path.as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True, isolation_level=None)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA cache_size=0")
        connection.execute("PRAGMA mmap_size=0")
        connection.execute("PRAGMA cache_spill=OFF")
        connection.execute("PRAGMA temp_store=MEMORY")
        result = run(connection, workload)
    finally:
        connection.close()
    encoded = json.dumps({"result": result}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    sys.stdout.write(encoded + "\n")


if __name__ == "__main__":
    main()
