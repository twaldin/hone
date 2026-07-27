#!/usr/bin/env python3
"""Deterministically generate the frozen mixed-script UTF-8 corpora.

Train and validation carry distinct header markers (first 32 bytes, ASCII, never
perturbed by the trusted driver) and distinct bodies, so a train-overfitting
control that keys on the train marker inverts on the held-out validation split.
The pristine payload + folded-digest oracle is the in-eval trusted reference
(built from the sealed trusted sources), so no expected hashes are stored here;
each split only carries its whole-tree peak-RSS baseline. The malformed probe
corpus is NOT shipped: the trusted evaluator synthesizes it per run from fresh
randomness (unenumerable, disjoint across runs), and the trusted runner
additionally injects nonce-scheduled invalid units on the scored timed path.
"""
import os
import json
import random
import shutil
import sys

# Realistic multi-lingual fragments: Latin (+diacritics), Cyrillic, Greek,
# Japanese, Chinese, Arabic, Korean, emoji (4-byte), Esperanto.
FRAGMENTS = [
    "The quick brown fox jumps over the lazy dog near the riverbank. ",
    "Voix ambigue d'un coeur qui au zephyr prefere les jattes de kiwis. ",
    "Portez ce vieux whisky au juge blond qui fume sur son ile interieure. ",
    "Съешь же ещё этих мягких французских булок да выпей чаю с лимоном. ",
    "Широкая электрификация южных губерний даст мощный толчок. ",
    "Ζαφείρι δέξου πάγκαλο, βαθῶν ψυχῆς τὸ σῆμα φυλάσσει. ",
    "私はガラスを食べられます。それは私を傷つけません。桜が咲いた。 ",
    "我能吞下玻璃而不伤身体。江河湖海，山川草木，风花雪月。 ",
    "أنا قادر على أكل الزجاج و هذا لا يؤلمني إطلاقا. ",
    "다람쥐 헌 쳇바퀴에 타고파. 정보 시스템 성능 평가 지표. ",
    "Emoji stress 😀🚀🌍✨🔥🎉🧪🛰️ interleaved with ASCII 0123456789. ",
    "Ĉu vi manĝas vitron? Ĝi ne damaĝas min. Ŭnua ĉapitro finiĝas ĉi tie. ",
    "Mixed: café, naïve, Straße, Ærø, Þórr, señor, façade, jalapeño. ",
]

SIZES = {"a.txt": 180_000, "b.txt": 300_000, "c.txt": 460_000}
SPLITS = {
    "train": ("HONE-TRAIN-CORPUS", 10_001),
    "validation": ("HONE-VALID-CORPUS", 70_009),
}


def make_file(path, marker, target_bytes, seed):
    rng = random.Random(seed)
    header = marker.encode("ascii")
    header = header + b"." * (32 - len(header) - 1) + b"\n"
    assert len(header) == 32
    parts = [header]
    total = len(header)
    while total < target_bytes:
        frag = rng.choice(FRAGMENTS).encode("utf-8")
        parts.append(frag)
        total += len(frag)
    data = b"".join(parts)
    # sanity: must be valid UTF-8
    data.decode("utf-8")
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "assets")
    for split, (marker, seedbase) in SPLITS.items():
        base = os.path.join(root, split)
        if os.path.isdir(base):
            shutil.rmtree(base)
        cdir = os.path.join(base, "corpus")
        os.makedirs(cdir)
        for i, (name, tgt) in enumerate(SIZES.items()):
            n = make_file(os.path.join(cdir, name), marker, tgt, seedbase + i * 131)
            print(f"{split}/corpus/{name}: {n} bytes")
        # Peak-RSS baseline is measured + frozen from the ordering run; a
        # placeholder large enough for the developer path is written first.
        with open(os.path.join(base, "expected.json"), "w") as f:
            json.dump({"baselinePeakRssKb": 65536}, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    main()
