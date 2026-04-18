"""Run storage — `.hone/run-<id>/` directory with variants + state JSON."""
from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path


@dataclass
class VariantRecord:
    """One stored variant. Written to .hone/run-<id>/v<N>.md + an entry in frontier.json."""

    idx: int
    score: float
    parent_idx: int | None = None
    created_at: str = ""


@dataclass
class RunManifest:
    """Config + metadata for a single hone run. Serialized to run.json."""

    run_id: str
    created_at: str
    prompt_path: str
    grader_path: str
    mutator_spec: str
    component_name: str
    budget: int
    seed: int
    status: str = "running"  # running | done | cancelled | error
    best_idx: int | None = None
    best_score: float | None = None
    total_iterations: int = 0
    variants: list[VariantRecord] = field(default_factory=list)


class RunStorage:
    """Encapsulates `.hone/run-<id>/` directory layout."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def manifest_path(self) -> Path:
        return self.root / "run.json"

    def variant_path(self, idx: int) -> Path:
        return self.root / f"v{idx}.md"

    def trace_path(self, idx: int) -> Path:
        return self.root / f"trace-v{idx}.log"

    def write_variant(self, idx: int, prompt: str) -> None:
        self.variant_path(idx).write_text(prompt, encoding="utf-8")

    def write_trace(self, idx: int, stderr: str) -> None:
        self.trace_path(idx).write_text(stderr, encoding="utf-8")

    def save_manifest(self, manifest: RunManifest) -> None:
        self.manifest_path.write_text(
            json.dumps(asdict(manifest), indent=2), encoding="utf-8"
        )

    def load_manifest(self) -> RunManifest:
        data = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        variants = [VariantRecord(**v) for v in data.pop("variants", [])]
        return RunManifest(variants=variants, **data)


def new_run_dir(base: Path | None = None) -> Path:
    """Create a new .hone/run-<id>/ directory."""
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
