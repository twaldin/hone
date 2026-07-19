#!/usr/bin/env python3
"""Authoring-only deterministic generators for the frozen Zstd capsule corpora."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MASK64 = (1 << 64) - 1


class XorShift64:
    def __init__(self, seed: int) -> None:
        self.state = seed & MASK64 or 1

    def next(self) -> int:
        x = self.state
        x ^= (x << 13) & MASK64
        x ^= x >> 7
        x ^= (x << 17) & MASK64
        self.state = x & MASK64
        return self.state

    def below(self, bound: int) -> int:
        return self.next() % bound


def clipped(chunks: list[bytes], size: int) -> bytes:
    return b"".join(chunks)[:size]


def make_text(size: int, rng: XorShift64) -> bytes:
    words = (
        b"amber", b"bridge", b"cinder", b"delta", b"engine", b"forest", b"granite", b"harbor",
        b"island", b"jovial", b"kernel", b"lantern", b"meadow", b"north", b"orbit", b"prairie",
        b"quartz", b"river", b"signal", b"timber", b"upland", b"velvet", b"willow", b"zephyr",
    )
    chunks: list[bytes] = []
    total = 0
    sentence = 0
    while total < size:
        count = 7 + rng.below(15)
        line = b" ".join(words[rng.below(len(words))] for _ in range(count))
        suffix = (b".\n" if sentence % 4 else b"?\n")
        row = line[:1].upper() + line[1:] + suffix
        chunks.append(row)
        total += len(row)
        sentence += 1
    return clipped(chunks, size)


def make_json(size: int, rng: XorShift64) -> bytes:
    regions = ("north", "south", "east", "west")
    states = ("queued", "active", "complete", "paused")
    chunks: list[bytes] = []
    total = 0
    ident = 0
    while total < size:
        row = {
            "active": bool(rng.below(2)),
            "id": ident,
            "metrics": [rng.below(10000), rng.below(10000), rng.below(10000)],
            "name": f"record-{rng.below(2048):04d}",
            "region": regions[rng.below(len(regions))],
            "state": states[rng.below(len(states))],
            "timestamp": 1_700_000_000 + rng.below(10_000_000),
        }
        encoded = json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        chunks.append(encoded)
        total += len(encoded)
        ident += 1
    return clipped(chunks, size)


def make_binary(size: int, rng: XorShift64) -> bytes:
    out = bytearray(size)
    for offset in range(0, size, 8):
        value = rng.next()
        out[offset : min(offset + 8, size)] = value.to_bytes(8, "little")[: size - offset]
    for offset in range(0, size, 4096):
        header = b"HNE0" + (offset // 4096).to_bytes(4, "little")
        out[offset : offset + len(header)] = header
        copy_from = max(0, offset - 1024)
        if offset >= 4096:
            out[offset + 64 : offset + 320] = out[copy_from : copy_from + 256]
    return bytes(out)


def make_repetitive(size: int, rng: XorShift64) -> bytes:
    patterns = (b"AABBAABBAABB\n", b"sensor=17,status=nominal\n", b"0000000011111111", b"xyzxyzxyzxyz")
    out = bytearray()
    while len(out) < size:
        pattern = patterns[rng.below(len(patterns))]
        block = bytearray(pattern * (32 + rng.below(64)))
        if block:
            block[rng.below(len(block))] ^= rng.below(16)
        out.extend(block)
    return bytes(out[:size])


def main() -> None:
    specs = {
        "train": (0x5A17D00D, 2 * 1024 * 1024),
        "validation": (0xC0DEC0DE, 3 * 1024 * 1024),
    }
    expected_sizes = {
        "train": {
            "binary": {"1": 2097210, "3": 1981297},
            "json": {"1": 349905, "3": 371457},
            "repetitive": {"1": 29253, "3": 19300},
            "text": {"1": 421152, "3": 368207},
        },
        "validation": {
            "binary": {"1": 3145810, "3": 2967958},
            "json": {"1": 524225, "3": 558521},
            "repetitive": {"1": 42377, "3": 29200},
            "text": {"1": 631338, "3": 551804},
        },
    }
    makers = {
        "binary": make_binary,
        "json": make_json,
        "repetitive": make_repetitive,
        "text": make_text,
    }
    for split, (seed, size) in specs.items():
        split_dir = ROOT / "assets" / split
        split_dir.mkdir(parents=True, exist_ok=True)
        workloads = []
        for index, (kind, maker) in enumerate(sorted(makers.items())):
            data = maker(size, XorShift64(seed + index * 0x9E3779B97F4A7C15))
            filename = f"{kind}.bin"
            (split_dir / filename).write_bytes(data)
            workloads.append({
                "bytes": len(data),
                "expectedCompressedBytes": expected_sizes[split][kind],
                "id": kind,
                "path": filename,
                "sha256": hashlib.sha256(data).hexdigest(),
            })
        (split_dir / "workloads.json").write_text(
            json.dumps({"generator": "xorshift64-v1", "seed": seed, "workloads": workloads}, sort_keys=True, separators=(",", ":")) + "\n"
        )


if __name__ == "__main__":
    main()
