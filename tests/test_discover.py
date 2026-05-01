from __future__ import annotations

import sys
from pathlib import Path

from typer.testing import CliRunner

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from hone.cli import app


def test_discover_subcommand_parses_and_prints_stub_message(tmp_path: Path) -> None:
    runner = CliRunner()
    src = tmp_path / "src"
    src.mkdir()
    suggest = tmp_path / "suggested"

    result = runner.invoke(
        app,
        ["discover", "--src", str(src), "--suggest", str(suggest)],
    )

    assert result.exit_code == 0
    assert "hone discover is not yet implemented" in result.stdout
