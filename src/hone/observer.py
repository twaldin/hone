"""ACE observer — Reflector + Curator per arxiv 2510.04618.

Reflector: one LLM call that reads mutations.jsonl + current CLAUDE.md and
emits a JSON list of delta entries.

Curator: deterministic python; applies the deltas to the `managed:ace` block
of CLAUDE.md. NOT an LLM call — this is how context collapse is prevented.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path


MANAGED_BLOCK_START = "<!-- managed:ace:start -->"
MANAGED_BLOCK_END   = "<!-- managed:ace:end -->"
MANAGED_CAP = 30


@dataclass
class Observer:
    mutator_spec: str
    interval: int = 10
    window: int = 20
    last_score_before: float | None = None
    last_version: int = 0

    def should_fire(self, iter_idx: int) -> bool:
        return iter_idx > 0 and iter_idx % self.interval == 0

    def fire(
        self,
        run_dir: Path,
        claude_md_path: Path,
        recent_scores: list[float],
    ) -> dict:
        # Rollback check: if the previous observer edit degraded subsequent scores, undo it.
        if self.last_score_before is not None and recent_scores:
            after = sum(recent_scores[-5:]) / min(5, len(recent_scores))
            if after < self.last_score_before:
                _rollback_managed_block(claude_md_path)
                self.last_version = max(0, self.last_version - 1)
                self.last_score_before = None
                return {"version": self.last_version, "deltas": [], "applied": False, "rollback": True}

        mutations_tail = _read_jsonl_tail(run_dir / "mutations.jsonl", self.window)
        current_md = claude_md_path.read_text(encoding="utf-8")
        managed = _extract_managed_block(current_md)

        prompt = _build_observer_prompt(mutations_tail, managed)
        from hone.mutators import resolve as resolve_mutator
        m = resolve_mutator(self.mutator_spec)
        try:
            res = m.propose(prompt)
        except Exception as e:  # mutator failure: no-op, logged
            _append_jsonl(run_dir / "observations.jsonl", {
                "version": self.last_version, "error": f"mutator_failure: {e}", "applied": False,
            })
            return {"version": self.last_version, "deltas": [], "applied": False, "error": str(e)}

        try:
            payload = _parse_observer_response(res.new_prompt)
        except ValueError as e:
            _append_jsonl(run_dir / "observations.jsonl", {
                "version": self.last_version, "error": f"malformed: {e}", "applied": False,
            })
            return {"version": self.last_version, "deltas": [], "applied": False, "error": "malformed"}

        if not payload["deltas"]:
            _append_jsonl(run_dir / "observations.jsonl", {
                "version": self.last_version, "deltas": [], "applied": False,
                "reasoning": payload.get("reasoning", ""),
            })
            return {"version": self.last_version, "deltas": [], "applied": False}

        new_managed = _apply_deltas(managed, payload["deltas"])
        self.last_version += 1
        new_md = _splice_managed_block(current_md, new_managed, self.last_version)
        claude_md_path.write_text(new_md, encoding="utf-8")

        _append_jsonl(run_dir / "observations.jsonl", {
            "iter_at_fire": len(mutations_tail),
            "version": self.last_version,
            "deltas": payload["deltas"],
            "reasoning": payload.get("reasoning", ""),
            "sha256_after": hashlib.sha256(new_md.encode()).hexdigest(),
            "applied": True,
        })
        _save_claude_md_version(run_dir, self.last_version, new_md)

        self.last_score_before = (
            sum(recent_scores[-5:]) / min(5, len(recent_scores)) if recent_scores else None
        )
        return {"version": self.last_version, "deltas": payload["deltas"], "applied": True}


def _extract_managed_block(md: str) -> dict[str, str]:
    m = re.search(
        re.escape(MANAGED_BLOCK_START) + r"(.*?)" + re.escape(MANAGED_BLOCK_END),
        md, flags=re.DOTALL,
    )
    if not m:
        return {}
    out: dict[str, str] = {}
    for line in m.group(1).splitlines():
        m2 = re.match(r"\s*-\s+(rule-\d+):\s+(.*\S)\s*$", line)
        if m2:
            out[m2.group(1)] = m2.group(2)
    return out


def _apply_deltas(existing: dict[str, str], deltas: list[dict]) -> dict[str, str]:
    new = dict(existing)
    for d in deltas:
        op = d.get("op")
        if op == "ADD":
            new_id = d.get("id") or _next_id(new)
            new[new_id] = d["text"]
        elif op == "MODIFY":
            if d["id"] in new:
                new[d["id"]] = d["text"]
        elif op == "REMOVE":
            new.pop(d["id"], None)
        else:
            raise ValueError(f"unknown delta op: {op!r}")
    if len(new) > MANAGED_CAP:
        for rid in sorted(new.keys())[: len(new) - MANAGED_CAP]:
            new.pop(rid)
    return new


def _splice_managed_block(md: str, entries: dict[str, str], version: int) -> str:
    body = "\n".join(f"- {rid}: {txt}" for rid, txt in sorted(entries.items()))
    block = (
        f"{MANAGED_BLOCK_START}\n"
        f"<!-- managed:ace version={version}. Do not hand-edit; use `hone observer`. -->\n"
        f"{body}\n"
        f"{MANAGED_BLOCK_END}"
    )
    if MANAGED_BLOCK_START in md and MANAGED_BLOCK_END in md:
        return re.sub(
            re.escape(MANAGED_BLOCK_START) + r".*?" + re.escape(MANAGED_BLOCK_END),
            block, md, count=1, flags=re.DOTALL,
        )
    return md.rstrip() + "\n\n" + block + "\n"


def _next_id(existing: dict[str, str]) -> str:
    n = 1
    while f"rule-{n:03d}" in existing:
        n += 1
    return f"rule-{n:03d}"


def _build_observer_prompt(mutations_tail: list[dict], managed: dict[str, str]) -> str:
    managed_repr = "\n".join(f"  - {k}: {v}" for k, v in sorted(managed.items())) or "  (empty)"
    trace = json.dumps(mutations_tail, indent=2)[:8000]
    return (
        "You are the ACE Reflector for a code-optimization harness. Read the recent\n"
        "mutation history and propose edits to the MUTATOR's CLAUDE.md rules so\n"
        "future iterations avoid repeated mistakes.\n\n"
        "Format your output as STRICT JSON:\n"
        '  {"reasoning": "...", "deltas": [{"op": "ADD"|"MODIFY"|"REMOVE", "id": "rule-NNN", "text": "..."}]}\n'
        "ADDs may omit id. MODIFYs and REMOVEs require id. No prose outside the JSON.\n\n"
        f"=== CURRENT MANAGED RULES ===\n{managed_repr}\n\n"
        f"=== RECENT MUTATIONS (last {len(mutations_tail)}) ===\n{trace}\n\n"
        "Propose the MINIMAL set of delta entries. Empty deltas list is valid if no\n"
        "pattern is visible. Do not restate existing rules. Prefer MODIFY over ADD+REMOVE.\n"
    )


def _parse_observer_response(text: str) -> dict:
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not m:
        raise ValueError("no JSON object in observer response")
    data = json.loads(m.group(0))
    if "deltas" not in data or not isinstance(data["deltas"], list):
        raise ValueError("observer response missing `deltas` list")
    return data


def _read_jsonl_tail(path: Path, n: int) -> list[dict]:
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    return [json.loads(l) for l in lines[-n:] if l.strip()]


def _append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")


def _save_claude_md_version(run_dir: Path, version: int, md: str) -> None:
    vdir = run_dir / "claude_md_versions"
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / f"v{version:03d}.md").write_text(md, encoding="utf-8")
    (vdir / "current.md").write_text(md, encoding="utf-8")


def _rollback_managed_block(claude_md_path: Path) -> None:
    md = claude_md_path.read_text(encoding="utf-8")
    new = re.sub(
        re.escape(MANAGED_BLOCK_START) + r".*?" + re.escape(MANAGED_BLOCK_END),
        "", md, flags=re.DOTALL,
    ).rstrip() + "\n"
    claude_md_path.write_text(new, encoding="utf-8")
