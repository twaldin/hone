#!/usr/bin/env python3
"""Deterministically materialize the capsule's frozen TS/JSX/ESM/CJS graphs."""
from __future__ import annotations

import json
from pathlib import Path


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _ts_esm(root: Path, modules: int, fanout: int) -> list[str]:
    _write(root / "m0000.ts", "export const value: number = 2166136261 >>> 0;\n")
    for index in range(1, modules):
        deps = [max(0, index - offset) for offset in range(1, min(fanout, index) + 1)]
        imports = "\n".join(
            f'import {{ value as v{dep} }} from "./m{dep:04d}";' for dep in deps
        )
        expression = " + ".join(f"v{dep}" for dep in deps)
        _write(
            root / f"m{index:04d}.ts",
            f"{imports}\n"
            f"interface Box<T> {{ readonly value: T }}\n"
            f"const box: Box<number> = {{ value: (({expression} + {index}) * 16777619) >>> 0 }};\n"
            f"export const value = box.value satisfies number;\n",
        )
    selected = sorted({modules - 1, modules // 2, modules // 3, modules // 5})
    imports = "\n".join(
        f'import {{ value as v{index} }} from "./m{index:04d}";' for index in selected
    )
    values = ",".join(f"v{index}" for index in selected)
    _write(root / "entry.ts", f"{imports}\nconsole.log(JSON.stringify([{values}]));\n")
    secondary = modules - 2
    _write(root / "secondary.ts", f'import {{ value }} from "./m{secondary:04d}";\nconsole.log(JSON.stringify(value));\n')
    return ["entry.ts", "secondary.ts"]


def _jsx_cjs(root: Path, modules: int) -> list[str]:
    _write(root / "c0000.cjs", "module.exports = { value: 2654435761 >>> 0 };\n")
    for index in range(1, modules):
        prior = index - 1
        _write(
            root / f"c{index:04d}.cjs",
            f'const prev = require("./c{prior:04d}.cjs");\n'
            f"module.exports = {{ value: ((prev.value ^ {index}) * 33) >>> 0 }};\n",
        )
        _write(
            root / f"x{index:04d}.tsx",
            f'import state from "./c{index:04d}.cjs";\n'
            f"type Props = {{ id: number; value: number }};\n"
            f"export const node = <section data-id={{{index}}}>{{state.value}}</section> as JSX.Element;\n"
            f"export const props: Props = {{ id: {index}, value: state.value }};\n",
        )
    selected = sorted({modules - 1, modules // 2, modules // 4})
    imports = "\n".join(
        f'import {{ node as n{index}, props as p{index} }} from "./x{index:04d}";'
        for index in selected
    )
    values = ",".join(f"[p{index}.value,n{index}.props['data-id']]" for index in selected)
    _write(root / "entry.tsx", f"{imports}\nconsole.log(JSON.stringify([{values}]));\n")
    _write(
        root / "jsx.d.ts",
        "declare namespace JSX { interface Element { tag: string; props: Record<string, unknown>; children: unknown[] } interface IntrinsicElements { [name: string]: Record<string, unknown> } }\n",
    )
    secondary = modules - 2
    _write(root / "secondary.tsx", f'import {{ node }} from "./x{secondary:04d}";\nconsole.log(JSON.stringify(node));\n')
    return ["entry.tsx", "secondary.tsx"]


def _mixed(root: Path, modules: int, fanout: int) -> list[str]:
    _write(root / "base.cjs", "exports.value = 2246822519 >>> 0;\n")
    for index in range(modules):
        prior = "./base.cjs" if index == 0 else f"./c{index - 1:04d}.cjs"
        _write(
            root / f"c{index:04d}.cjs",
            f'const prev = require("{prior}");\nexports.value = ((prev.value + {index}) ^ 3266489917) >>> 0;\n',
        )
        deps = [max(0, index - offset) for offset in range(1, min(fanout, index) + 1)]
        imports = [f'import c from "./c{index:04d}.cjs";']
        imports.extend(f'import {{ value as e{dep} }} from "./e{dep:04d}.mjs";' for dep in deps)
        expression = " + ".join(["c.value", *(f"e{dep}" for dep in deps)])
        _write(
            root / f"e{index:04d}.mjs",
            "\n".join(imports)
            + f"\nexport const value = (({expression}) * 2654435761) >>> 0;\n",
        )
    selected = sorted({modules - 1, modules // 2, modules // 7})
    imports = "\n".join(
        f'import {{ value as v{index} }} from "./e{index:04d}.mjs";' for index in selected
    )
    values = ",".join(f"v{index}" for index in selected)
    _write(root / "entry.mjs", f"{imports}\nconsole.log(JSON.stringify([{values}]));\n")
    secondary = modules - 2
    _write(root / "secondary.mjs", f'import {{ value }} from "./e{secondary:04d}.mjs";\nconsole.log(JSON.stringify(value));\n')
    return ["entry.mjs", "secondary.mjs"]


def materialize(spec: dict, root: Path) -> list[dict]:
    jobs = spec.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("workload spec has no jobs")
    realized: list[dict] = []
    for raw in jobs:
        if not isinstance(raw, dict):
            raise ValueError("workload job must be an object")
        job_id = raw.get("id")
        kind = raw.get("kind")
        modules = raw.get("modules")
        fanout = raw.get("fanout", 2)
        if not isinstance(job_id, str) or not job_id or not isinstance(modules, int) or modules < 32:
            raise ValueError("invalid workload job")
        if not isinstance(fanout, int) or not 1 <= fanout <= 4:
            raise ValueError("invalid graph fanout")
        job_root = root / job_id
        job_root.mkdir(parents=True)
        if kind == "ts-esm":
            entries = _ts_esm(job_root, modules, fanout)
        elif kind == "jsx-cjs":
            entries = _jsx_cjs(job_root, modules)
        elif kind == "mixed":
            entries = _mixed(job_root, modules, fanout)
        else:
            raise ValueError(f"unknown workload kind: {kind}")
        realized.append({"id": job_id, "entries": [str(job_root / entry) for entry in entries], "kind": kind})
    return realized


def load_spec(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("unsupported workload spec")
    return value
