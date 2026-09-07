#!/usr/bin/env python3
"""Deterministically materialize frozen Bun module-loader graph shapes."""
from __future__ import annotations

import json
from pathlib import Path


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _module_body(index: int, dependency: str | None, import_path: str | None) -> str:
    if dependency is None:
        prefix = "const previous: number = 2166136261 >>> 0;\n"
    else:
        prefix = f'import {{ value as previous }} from "{import_path}";\n'
    return (
        prefix
        + f"export const value: number = (Math.imul((previous ^ {index}) >>> 0, 16777619) + 2246822519) >>> 0;\n"
        + "globalThis.__hone.count++;\n"
        + f"globalThis.__hone.checksum = (Math.imul((globalThis.__hone.checksum ^ value) >>> 0, 33) + {index}) >>> 0;\n"
    )


def _entry(import_path: str) -> str:
    return (
        "globalThis.__hone = { count: 0, checksum: 2654435761 >>> 0 };\n"
        f'const namespace = await import("{import_path}");\n'
        "console.log(JSON.stringify({exports:{value:namespace.value,tag:namespace.tag??\"graph\"},sideEffects:globalThis.__hone}));\n"
    )


def _linear(root: Path, modules: int, *, extensionless: bool) -> None:
    for index in range(modules - 1, -1, -1):
        dependency = None if index + 1 == modules else f"node-{index + 1:04d}"
        import_path = None
        if dependency is not None:
            import_path = f"./{dependency}" if extensionless else f"./{dependency}.ts"
        _write(root / f"node-{index:04d}.ts", _module_body(index, dependency, import_path))
    _write(root / "entry.ts", _entry("./node-0000" if extensionless else "./node-0000.ts"))
    values: dict[int, int] = {}
    checksum = 2654435761
    for index in range(modules - 1, -1, -1):
        previous = 2166136261 if index + 1 == modules else values[index + 1]
        value = (((previous ^ index) * 16777619) + 2246822519) & 0xFFFFFFFF
        values[index] = value
        checksum = (((checksum ^ value) * 33) + index) & 0xFFFFFFFF
    _write(
        root / "hone-shortcut.ts",
        f"globalThis.__hone.count = {modules};\n"
        f"globalThis.__hone.checksum = {checksum};\n"
        f"export const value: number = {values[0]};\n"
        'export const tag = "graph";\n',
    )


def _fanout(root: Path, modules: int, fanout: int) -> None:
    for index in range(modules):
        dependencies = list(range(max(0, index - fanout), index))
        imports = "".join(
            f'import {{ value as value{dependency} }} from "./node-{dependency:04d}.mjs";\n'
            for dependency in dependencies
        )
        expression = " ^ ".join(f"value{dependency}" for dependency in dependencies) or "2166136261"
        _write(
            root / f"node-{index:04d}.mjs",
            imports
            + f"export const value = (Math.imul(({expression}) >>> 0, 16777619) + {index}) >>> 0;\n"
            + "globalThis.__hone.count++;\n"
            + f"globalThis.__hone.checksum = (Math.imul((globalThis.__hone.checksum ^ value) >>> 0, 33) + {index}) >>> 0;\n",
        )
    _write(root / "entry.mjs", _entry(f"./node-{modules - 1:04d}.mjs"))


def _packages(root: Path, modules: int) -> None:
    for index in range(modules - 1, -1, -1):
        package = root / "node_modules" / f"hone-pkg-{index:04d}"
        _write(
            package / "package.json",
            json.dumps(
                {
                    "name": f"hone-pkg-{index:04d}",
                    "type": "module",
                    "sideEffects": True,
                    "exports": {".": {"bun": "./src/index.ts", "default": "./src/index.ts"}},
                },
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
        )
        dependency = None if index + 1 == modules else f"hone-pkg-{index + 1:04d}"
        _write(package / "src" / "index.ts", _module_body(index, dependency, dependency))
    _write(root / "entry.ts", _entry("hone-pkg-0000"))


def _aliases(root: Path, modules: int) -> None:
    _write(
        root / "tsconfig.json",
        json.dumps(
            {
                "compilerOptions": {
                    "baseUrl": ".",
                    "paths": {"@hone/*": ["lib/*"]},
                    "module": "Preserve",
                    "moduleResolution": "Bundler",
                }
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
    )
    for index in range(modules - 1, -1, -1):
        dependency = None if index + 1 == modules else f"node-{index + 1:04d}"
        import_path = None if dependency is None else f"@hone/{dependency}"
        _write(root / "lib" / f"node-{index:04d}.ts", _module_body(index, dependency, import_path))
    _write(root / "entry.ts", _entry("@hone/node-0000"))

_DRIVER_PRELUDE = """const root = import.meta.dir;
const pad = (n) => String(n).padStart(4, "0");
let checksum = 2654435761 >>> 0;
let count = 0;
const take = (resolved) => {
  const rel = resolved.startsWith(root) ? resolved.slice(root.length) : resolved;
  for (let i = 0; i < rel.length; i++) {
    checksum = (Math.imul((checksum ^ rel.charCodeAt(i)) >>> 0, 16777619) + 2246822519) >>> 0;
  }
  count++;
};
"""

_DRIVER_EPILOGUE = """console.log(JSON.stringify({
  exports: { value: checksum >>> 0, tag: "resolve" },
  sideEffects: { count: count >>> 0, checksum: checksum >>> 0 },
}));
"""


def _resolve_driver(kind: str, modules: int, fanout: int, reps: int) -> str:
    """Emit the resolution-heavy timed driver: every import edge of the frozen
    graph is resolved through Bun.resolveSync for `reps` passes and folded
    into a deterministic root-relative path checksum (the timed-phase
    observation). No module is loaded or executed."""
    if kind in ("ts-chain", "extensionless-ts"):
        ext = "" if kind == "extensionless-ts" else ".ts"
        body = (
            f"for (let r = 0; r < {reps}; r++) {{\n"
            f"  for (let i = 0; i < {modules}; i++) {{\n"
            f'    take(Bun.resolveSync("./node-" + pad(i) + "{ext}", root));\n'
            f"  }}\n"
            f"}}\n"
        )
    elif kind == "esm-fanout":
        body = (
            f"for (let r = 0; r < {reps}; r++) {{\n"
            f'  take(Bun.resolveSync("./node-" + pad({modules - 1}) + ".mjs", root));\n'
            f"  for (let i = 0; i < {modules}; i++) {{\n"
            f"    for (let j = Math.max(0, i - {fanout}); j < i; j++) {{\n"
            f'      take(Bun.resolveSync("./node-" + pad(j) + ".mjs", root));\n'
            f"    }}\n"
            f"  }}\n"
            f"}}\n"
        )
    elif kind == "package-exports":
        body = (
            f"for (let r = 0; r < {reps}; r++) {{\n"
            f'  take(Bun.resolveSync("hone-pkg-0000", root));\n'
            f"  for (let k = 0; k + 1 < {modules}; k++) {{\n"
            f'    const dir = root + "/node_modules/hone-pkg-" + pad(k) + "/src";\n'
            f'    take(Bun.resolveSync("hone-pkg-" + pad(k + 1), dir));\n'
            f"  }}\n"
            f"}}\n"
        )
    elif kind == "tsconfig-alias":
        body = (
            f"for (let r = 0; r < {reps}; r++) {{\n"
            f'  take(Bun.resolveSync("@hone/node-0000", root));\n'
            f"  for (let k = 1; k < {modules}; k++) {{\n"
            f'    take(Bun.resolveSync("@hone/node-" + pad(k), root + "/lib"));\n'
            f"  }}\n"
            f"}}\n"
        )
    else:
        raise ValueError(f"unknown graph kind: {kind}")
    return _DRIVER_PRELUDE + body + _DRIVER_EPILOGUE



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
        fanout = raw.get("fanout", 4)
        reps = raw.get("resolveRepetitions")
        if not isinstance(job_id, str) or not job_id or not isinstance(modules, int) or not 32 <= modules <= 1200:
            raise ValueError("invalid workload job")
        if not isinstance(fanout, int) or not 2 <= fanout <= 8:
            raise ValueError("invalid graph fanout")
        if not isinstance(reps, int) or not 1 <= reps <= 200:
            raise ValueError("invalid resolve repetition count")
        job_root = root / job_id
        job_root.mkdir(parents=True)
        if kind == "ts-chain":
            _linear(job_root, modules, extensionless=False)
            entry = "entry.ts"
        elif kind == "extensionless-ts":
            _linear(job_root, modules, extensionless=True)
            entry = "entry.ts"
        elif kind == "esm-fanout":
            _fanout(job_root, modules, fanout)
            entry = "entry.mjs"
        elif kind == "package-exports":
            _packages(job_root, modules)
            entry = "entry.ts"
        elif kind == "tsconfig-alias":
            _aliases(job_root, modules)
            entry = "entry.ts"
        else:
            raise ValueError(f"unknown graph kind: {kind}")
        _write(job_root / "hone-resolve.mjs", _resolve_driver(kind, modules, fanout, reps))
        realized.append(
            {
                "id": job_id,
                "kind": kind,
                "entry": str(job_root / entry),
                "resolveEntry": str(job_root / "hone-resolve.mjs"),
            }
        )
    return realized


def load_spec(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("unsupported workload spec")
    return value
