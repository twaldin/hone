"""Tests for config.py — round-trip, validation."""
from __future__ import annotations

from pathlib import Path

import pytest

from hone.config import HoneConfig, load_config, save_config


def test_roundtrip_minimal(tmp_path: Path) -> None:
    cfg = HoneConfig(src_dir="/some/repo", scorer="/some/scorer.sh")
    p = tmp_path / "hone.toml"
    save_config(cfg, p)
    loaded = load_config(p)
    assert loaded.src_dir == cfg.src_dir
    assert loaded.scorer == cfg.scorer
    assert loaded.budget == cfg.budget
    assert loaded.metric_direction == cfg.metric_direction


def test_roundtrip_full(tmp_path: Path) -> None:
    cfg = HoneConfig(
        src_dir="/repo",
        scorer="/abs/s.sh",
        mutator="harness:claude-code:opus",
        budget=5,
        scorer_timeout=60,
        frontier_size=2,
        objective="minimize bugs",
        metric_direction="min",
        stall=3,
        gates=[{"name": "lint", "command": "ruff check ."}, {"name": "test", "command": "pytest"}],
        ace_interval=2,
        ace_model="harness:claude-code:sonnet",
        policy_dir="/policy",
    )
    p = tmp_path / "hone.toml"
    save_config(cfg, p)
    loaded = load_config(p)
    assert loaded.src_dir == "/repo"
    assert loaded.scorer == "/abs/s.sh"
    assert loaded.mutator == "harness:claude-code:opus"
    assert loaded.budget == 5
    assert loaded.scorer_timeout == 60
    assert loaded.frontier_size == 2
    assert loaded.objective == "minimize bugs"
    assert loaded.metric_direction == "min"
    assert loaded.stall == 3
    assert len(loaded.gates) == 2
    assert loaded.gates[0]["name"] == "lint"
    assert loaded.gates[0]["command"] == "ruff check ."
    assert loaded.gates[1]["name"] == "test"
    assert loaded.ace_interval == 2
    assert loaded.ace_model == "harness:claude-code:sonnet"
    assert loaded.policy_dir == "/policy"


def test_roundtrip_none_stall_and_policy_dir(tmp_path: Path) -> None:
    cfg = HoneConfig(src_dir="/repo", scorer="./s.sh", stall=None, policy_dir=None)
    p = tmp_path / "hone.toml"
    save_config(cfg, p)
    loaded = load_config(p)
    assert loaded.stall is None
    assert loaded.policy_dir is None


def test_load_config_missing_required_src_dir(tmp_path: Path) -> None:
    p = tmp_path / "hone.toml"
    p.write_text('scorer = "./s.sh"\n', encoding="utf-8")
    with pytest.raises(ValueError, match="src_dir"):
        load_config(p)


def test_load_config_missing_required_scorer(tmp_path: Path) -> None:
    p = tmp_path / "hone.toml"
    p.write_text('src_dir = "/repo"\n', encoding="utf-8")
    with pytest.raises(ValueError, match="scorer"):
        load_config(p)


def test_load_config_invalid_metric_direction(tmp_path: Path) -> None:
    p = tmp_path / "hone.toml"
    p.write_text('src_dir = "/repo"\nscorer = "./s.sh"\nmetric_direction = "median"\n', encoding="utf-8")
    with pytest.raises(ValueError, match="metric_direction"):
        load_config(p)


def test_load_config_valid_metric_directions(tmp_path: Path) -> None:
    for direction in ("max", "min"):
        p = tmp_path / f"hone_{direction}.toml"
        p.write_text(
            f'src_dir = "/repo"\nscorer = "./s.sh"\nmetric_direction = "{direction}"\n',
            encoding="utf-8",
        )
        cfg = load_config(p)
        assert cfg.metric_direction == direction


def test_load_config_uses_defaults(tmp_path: Path) -> None:
    p = tmp_path / "hone.toml"
    p.write_text('src_dir = "/repo"\nscorer = "./s.sh"\n', encoding="utf-8")
    cfg = load_config(p)
    assert cfg.mutator == "harness:claude-code:sonnet"
    assert cfg.budget == 20
    assert cfg.frontier_size == 4
    assert cfg.metric_direction == "max"
    assert cfg.gates == []
    assert cfg.ace_interval == 0
    assert cfg.ace_model == ""


def test_load_config_resolves_relative_scorer(tmp_path: Path) -> None:
    sub = tmp_path / "proj"
    sub.mkdir()
    p = sub / "hone.toml"
    p.write_text('src_dir = "/abs/repo"\nscorer = "./scorer.sh"\n', encoding="utf-8")
    cfg = load_config(p)
    assert cfg.scorer == str((sub / "scorer.sh").resolve())


def test_load_config_resolves_relative_src_dir(tmp_path: Path) -> None:
    sub = tmp_path / "proj"
    sub.mkdir()
    p = sub / "hone.toml"
    p.write_text('src_dir = "./code"\nscorer = "/abs/scorer.sh"\n', encoding="utf-8")
    cfg = load_config(p)
    assert cfg.src_dir == str((sub / "code").resolve())


def test_load_config_preserves_absolute_paths(tmp_path: Path) -> None:
    p = tmp_path / "hone.toml"
    p.write_text('src_dir = "/absolute/repo"\nscorer = "/absolute/scorer.sh"\n', encoding="utf-8")
    cfg = load_config(p)
    assert cfg.src_dir == "/absolute/repo"
    assert cfg.scorer == "/absolute/scorer.sh"
