"""DirTarget — a directory hone is optimizing as a whole.

Candidate in dir-mode = directory snapshot (literal file contents, not
a git ref). Snapshot is a plain dict[Path, str] kept in memory; the
on-disk materialization happens per mutator call inside a temp dir.
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class DirSnapshot:
    """A frozen dict of {relative_path: file_contents_utf8}."""
    files: dict[Path, str] = field(default_factory=dict)

    def with_file(self, rel: Path, contents: str) -> "DirSnapshot":
        new = dict(self.files)
        new[rel] = contents
        return DirSnapshot(files=new)

    def materialize(self, workdir: Path) -> None:
        for rel, text in self.files.items():
            dest = workdir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, encoding="utf-8")


@dataclass
class DirTarget:
    """The mutable directory + its include/exclude policy."""

    root: Path
    include_globs: list[str]
    exclude_globs: list[str]

    def mutable_files(self) -> list[Path]:
        all_matches: set[Path] = set()
        for pat in self.include_globs:
            for p in self.root.glob(pat):
                if p.is_file():
                    all_matches.add(p.relative_to(self.root))
        filtered = {
            r for r in all_matches
            if not any(fnmatch.fnmatch(r.name, ex) for ex in self.exclude_globs)
        }
        return sorted(filtered)

    def initial_snapshot(self) -> DirSnapshot:
        files = {
            rel: (self.root / rel).read_text(encoding="utf-8")
            for rel in self.mutable_files()
        }
        return DirSnapshot(files=files)
