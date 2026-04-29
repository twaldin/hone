"""HoneConfig dataclass + TOML persistence helpers."""
from __future__ import annotations

import dataclasses
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class HoneConfig:
    src_dir: str
    scorer: str
    mutator: str = "harness:claude-code:sonnet"
    budget: int = 20
    scorer_timeout: int = 3600
    frontier_size: int = 4
    objective: str = "Improve the repository so the scorer score increases."
    metric_direction: str = "max"
    stall: int | None = None
    gates: list[dict] = field(default_factory=list)
    ace_interval: int = 0
    ace_model: str = ""
    policy_dir: str | None = None


_REQUIRED = ("src_dir", "scorer")
_VALID_METRIC_DIRECTIONS = frozenset({"max", "min"})


def _resolve_relative(val: str, base: Path) -> str:
    p = Path(val)
    if not p.is_absolute():
        return str((base / p).resolve())
    return val


def load_config(path: Path | None = None) -> HoneConfig:
    if path is None:
        path = Path("hone.toml")
    path = Path(path)
    config_dir = path.parent
    with open(path, "rb") as fh:
        data = tomllib.load(fh)
    for key in _REQUIRED:
        if key not in data:
            raise ValueError(f"hone.toml: missing required field '{key}'")
    metric_direction = data.get("metric_direction", "max")
    if metric_direction not in _VALID_METRIC_DIRECTIONS:
        raise ValueError(
            f"hone.toml: metric_direction must be 'max' or 'min', got {metric_direction!r}"
        )
    return HoneConfig(
        src_dir=_resolve_relative(data["src_dir"], config_dir),
        scorer=_resolve_relative(data["scorer"], config_dir),
        mutator=data.get("mutator", "harness:claude-code:sonnet"),
        budget=data.get("budget", 20),
        scorer_timeout=data.get("scorer_timeout", 3600),
        frontier_size=data.get("frontier_size", 4),
        objective=data.get("objective", "Improve the repository so the scorer score increases."),
        metric_direction=metric_direction,
        stall=data.get("stall", None),
        gates=data.get("gates", []),
        ace_interval=data.get("ace_interval", 0),
        ace_model=data.get("ace_model", ""),
        policy_dir=data.get("policy_dir", None),
    )


def save_config(cfg: HoneConfig, path: Path) -> None:
    path.write_text(_render_toml(cfg), encoding="utf-8")


def _render_toml(cfg: HoneConfig) -> str:
    """Minimal TOML writer for HoneConfig flat fields + [[gates]] array-of-tables."""
    lines: list[str] = []
    for f in dataclasses.fields(cfg):
        if f.name == "gates":
            continue
        val = getattr(cfg, f.name)
        if val is None:
            continue
        if isinstance(val, bool):
            lines.append(f'{f.name} = {"true" if val else "false"}')
        elif isinstance(val, int):
            lines.append(f"{f.name} = {val}")
        elif isinstance(val, str):
            escaped = val.replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{f.name} = "{escaped}"')
    for gate in cfg.gates:
        lines.append("")
        lines.append("[[gates]]")
        for k, v in gate.items():
            escaped = str(v).replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{k} = "{escaped}"')
    return "\n".join(lines) + "\n"
