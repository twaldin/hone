from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

_SPARK_CHARS = "▁▂▃▄▅▆▇█"


def generate_report(run_dir: Path) -> str:
    run_dir = Path(run_dir)
    manifest = _read_json(run_dir / "run.json")
    rows = _read_jsonl(run_dir / "mutations.jsonl")

    run_id = str(manifest.get("run_id") or run_dir.name)
    status = str(manifest.get("status") or "unknown")
    metric_direction = str(manifest.get("metric_direction") or "max")
    budget = manifest.get("budget")
    total_iterations = manifest.get("total_iterations", 0)
    stall_note = " (stalled before budget)" if status == "stalled" else ""

    best_idx = manifest.get("best_idx")
    best_score = manifest.get("best_score")
    best_sha = manifest.get("best_sha")

    candidates: dict[int, dict] = {}
    for row in rows:
        if row.get("kind") == "seed":
            idx = row.get("candidate_idx", 0)
            candidates[int(idx)] = {
                "idx": int(idx),
                "sha": row.get("sha", ""),
                "score": row.get("score"),
                "utility": row.get("utility"),
                "branch": "main",
            }
            continue
        if row.get("kind") in {"mutator_error", "gate_rejected"}:
            continue
        if row.get("child_idx") is None:
            continue
        idx = int(row["child_idx"])
        candidates[idx] = {
            "idx": idx,
            "sha": row.get("child_sha", ""),
            "score": row.get("child_score"),
            "utility": row.get("utility"),
            "branch": f"iter-{int(row.get('iter', 0)):03d}",
        }

    best = candidates.get(best_idx) if isinstance(best_idx, int) else None
    if best is None:
        def _utility_key(candidate: dict) -> float:
            utility = candidate.get("utility")
            if utility is None:
                return -10**18
            return float(utility)

        best = max(candidates.values(), key=_utility_key, default=None)

    lines: list[str] = []
    lines.append(f"# Hone Run Report: {run_id}")
    lines.append("")
    lines.append("## 1) Header")
    lines.append(f"- status: **{status}**{stall_note}")
    lines.append(f"- metric_direction: `{metric_direction}`")
    lines.append(f"- iterations: `{total_iterations}` / budget `{budget if budget is not None else 'n/a'}`")
    lines.append("")

    lines.append("## 2) Best candidate")
    if best is None:
        lines.append("- none")
    else:
        sha = str(best.get("sha") or "")
        short_sha = sha[:12] if sha else "n/a"
        score = best_score if best_score is not None else best.get("score")
        lines.append(f"- idx: `{best.get('idx')}`")
        lines.append(f"- sha: `{short_sha}`")
        lines.append(f"- raw score: `{score}`")
        lines.append(f"- utility: `{best.get('utility')}`")
        lines.append(f"- branch: `{best.get('branch')}`")
    lines.append("")

    lines.append("## 3) Iteration summary")
    lines.append("| iter | parent | child | parent_score | child_score | delta | kind | changed_files_short |")
    lines.append("|---:|---:|---:|---:|---:|---:|---|---|")
    for row in rows:
        if row.get("iter", 0) == 0:
            continue
        kind = row.get("kind", "accepted")
        iter_n = row.get("iter", "")
        parent = row.get("parent_idx", "")
        child = row.get("child_idx", "")
        pscore = row.get("parent_score", "")
        cscore = row.get("child_score", "")
        delta = row.get("delta", "")
        changed = row.get("changed_files") or []
        changed_short = ",".join(changed[:3]) if changed else "-"
        if len(changed) > 3:
            changed_short += f"+{len(changed)-3}"
        lines.append(f"| {iter_n} | {parent} | {child} | {pscore} | {cscore} | {delta} | {kind} | {changed_short} |")
    lines.append("")

    lines.append("## 4) Score trend")
    child_scores = [float(r["child_score"]) for r in rows if r.get("child_score") is not None]
    lines.append(_sparkline(child_scores) if child_scores else "(no scored child iterations yet)")
    lines.append("")

    lines.append("## 5) Frontier evolution")
    final_frontier = []
    for row in reversed(rows):
        if isinstance(row.get("frontier"), list):
            final_frontier = row["frontier"]
            break
    if not final_frontier:
        lines.append("- none")
    else:
        scored = []
        for idx in final_frontier:
            score = candidates.get(idx, {}).get("score")
            scored.append(f"c{idx}:{score}")
        lines.append("- final frontier: " + ", ".join(scored))
    lines.append("")

    lines.append("## 6) Gate failures")
    gate_rows = [r for r in rows if r.get("kind") == "gate_rejected"]
    if not gate_rows:
        lines.append("- none")
    else:
        for row in gate_rows:
            names = row.get("failing_gates") or []
            stderr_parts: list[str] = []
            for gate in row.get("gate_results") or []:
                if gate.get("passed"):
                    continue
                st = str(gate.get("stderr") or "").strip().replace("\n", " ")
                if st:
                    stderr_parts.append(st[:120])
            stderr_txt = " | ".join(stderr_parts) if stderr_parts else "(no stderr)"
            lines.append(f"- iter {row.get('iter')}: gates={names} stderr={stderr_txt}")
    lines.append("")

    lines.append("## 7) Changed files")
    file_counter: Counter[str] = Counter()
    for row in rows:
        if row.get("kind", "accepted") != "accepted":
            continue
        for f in row.get("changed_files") or []:
            file_counter[f] += 1
    if not file_counter:
        lines.append("- none")
    else:
        for name, count in file_counter.most_common(10):
            lines.append(f"- `{name}`: {count}")

    return "\n".join(lines).strip() + "\n"


def write_report(run_dir: Path, output: Path) -> Path:
    run_dir = Path(run_dir)
    output = Path(output)
    if output.exists() and output.is_dir():
        output = output / "report.md"
    elif str(output).endswith("/"):
        output = output / "report.md"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(generate_report(run_dir), encoding="utf-8")
    return output


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def _sparkline(values: list[float]) -> str:
    if not values:
        return ""
    lo = min(values)
    hi = max(values)
    if hi == lo:
        return _SPARK_CHARS[0] * len(values)
    chars: list[str] = []
    for value in values:
        ratio = (value - lo) / (hi - lo)
        idx = min(len(_SPARK_CHARS) - 1, int(ratio * (len(_SPARK_CHARS) - 1)))
        chars.append(_SPARK_CHARS[idx])
    return "".join(chars)
