#!/usr/bin/env python3
"""Generate deterministic, license-unencumbered large parser/formatter workloads."""
from pathlib import Path
import sys

root = Path(sys.argv[1])


def emit(rel: str, lines: list[str]) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(lines), encoding="utf-8", newline="\n")


def js(seed: int, count: int) -> list[str]:
    out = ["/* Deterministic Hone benchmark source; CC0-1.0. */\n"]
    for i in range(count):
        n = i + seed
        out.append(
            f"export function compute{n}(input = {n % 97}) {{ const values = [{n % 11}, {n % 17}, {n % 23}, input]; "
            f"return values.map((value, index) => (value + index) * {n % 13 + 1}).filter(value => value % 3 !== 0).reduce((sum, value) => sum + value, 0); }}\n"
        )
        if i % 13 == 0:
            out.append(
                f"export class Store{n} {{ #items = new Map(); set(key, value) {{ this.#items.set(key, value); return this; }} "
                f"get(key) {{ return this.#items.get(key) ?? {n}; }} }}\n"
            )
    out.append("export const finalValue = compute%d(41);\n" % seed)
    return out


def ts(seed: int, count: int) -> list[str]:
    out = ["/* Deterministic Hone benchmark source; CC0-1.0. */\n"]
    for i in range(count):
        n = i + seed
        out.append(
            f"export interface Record{n}<T extends string = string> {{ readonly id: `record-${{T}}-${n}`; value: T; tags?: readonly T[]; }}\n"
            f"export type Result{n}<T> = {{ ok: true; value: T; meta: Record{n} }} | {{ ok: false; error: Error; retry: {str(n % 2 == 0).lower()} }};\n"
            f"export function transform{n}<T extends string>(item: Record{n}<T>): Result{n}<T> {{ return item.value.length > {n % 9} ? {{ ok: true, value: item.value, meta: item }} : {{ ok: false, error: new Error(item.id), retry: {str(n % 2 == 0).lower()} }}; }}\n"
        )
        if i % 17 == 0:
            out.append(
                f"export namespace Group{n} {{ export const token: unique symbol = Symbol('token-{n}'); export type Tagged<T> = T & {{ readonly [token]: {n} }}; }}\n"
            )
    return out


def css(seed: int, count: int) -> list[str]:
    out = ["/* Deterministic Hone benchmark source; CC0-1.0. */\n", ":root{--space:4px;--ink:#17202a;--paper:#f8f9fa}\n"]
    for i in range(count):
        n = i + seed
        out.append(
            f".component-{n}>.item:nth-child({n % 9 + 1}){{display:grid;grid-template-columns:repeat({n % 5 + 1},minmax(0,1fr));gap:calc(var(--space)*{n % 7 + 1});color:color-mix(in srgb,var(--ink) {n % 80 + 10}%,transparent);background:linear-gradient({n % 360}deg,#fff,#eef);padding:{n % 12}px {n % 18}px}}\n"
        )
        if i % 29 == 0:
            out.append(
                f"@media (min-width:{480 + n % 900}px){{.component-{n}{{container-type:inline-size;transform:translate3d({n % 7}px,0,0)}}}}\n"
            )
    out.append("@keyframes pulse{from{opacity:.65}50%{opacity:1}to{opacity:.65}}\n")
    return out


def recovery_js(seed: int, count: int) -> list[str]:
    out = ["/* Deliberately malformed recovery corpus; CC0-1.0. */\n"]
    for i in range(count):
        n = i + seed
        if i % 37 == 0:
            out.append(f"const broken{n} = {{ value: {n}, missing: }};\n")
        else:
            out.append(f"const value{n} = ({n} + {n % 19}) * ({n % 7 + 1});\n")
    return out


emit("train/generated.js", js(1000, 1200))
emit("train/generated.ts", ts(2000, 800))
emit("train/generated.css", css(3000, 1500))
emit("train/recovery.js", recovery_js(4000, 700))
emit("validation/modules.js", js(11000, 1100))
emit("validation/declarations.ts", ts(12000, 750))
emit("validation/layout.css", css(13000, 1400))
emit("validation/recovery.js", recovery_js(14000, 650))
