"""Run storage — `.hone/run-<id>/` layout.

Per run directory contains:
  - run.json           manifest (this module)
  - mutations.jsonl    per-iteration record (written by repo_frontier)
  - workdir/           the hone-managed git workspace
  - prompts/           per-iteration prompts sent to the mutator
  - seed-playbook.md   the seed policy playbook
  - seed-prompt-template.md  the seed policy prompt template
"""
from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass
class RunManifest:
    run_id: str
    created_at: str
    src_dir: str
    grader_path: str
    mutator_spec: str
    budget: int
    status: str = "running"  # running | done | cancelled | error
    best_idx: int | None = None
    best_score: float | None = None
    best_sha: str | None = None
    total_iterations: int = 0


class RunStorage:
    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def manifest_path(self) -> Path:
        return self.root / "run.json"

    def save_manifest(self, manifest: RunManifest) -> None:
        self.manifest_path.write_text(
            json.dumps(asdict(manifest), indent=2), encoding="utf-8"
        )

    def load_manifest(self) -> RunManifest:
        data = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        return RunManifest(**data)


def new_run_dir(base: Path | None = None) -> Path:
    base = base or Path.cwd() / ".hone"
    base.mkdir(parents=True, exist_ok=True)
    run_id = _generate_run_id()
    run_dir = base / f"run-{run_id}"
    run_dir.mkdir(parents=True, exist_ok=False)
    return run_dir


def _generate_run_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    suffix = uuid.uuid4().hex[:6]
    return f"{ts}-{suffix}"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()
