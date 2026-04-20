"""Component kind detection — maps file extensions to mutation strategy."""
from __future__ import annotations

from pathlib import Path

_EXT_KIND: dict[str, str] = {
    ".py": "code:python",
    ".ts": "code:typescript",
    ".tsx": "code:typescript",
    ".js": "code:javascript",
    ".jsx": "code:javascript",
    ".go": "code:go",
    ".rs": "code:rust",
}


def detect_component_kind(path: str | Path) -> str:
    """Return the component kind for a given file path based on its extension."""
    return _EXT_KIND.get(Path(path).suffix.lower(), "prompt")
