from pathlib import Path
import os
import shutil

ROOT = Path("/opt/swc-root")
BUILD_ROOT = Path("/tmp/hone-swc-build")
CRATES = (
    "swc_ecma_parser",
    "swc_ecma_transforms_base",
    "swc_ecma_transforms_typescript",
    "swc_ecma_transforms_react",
)

shutil.move(ROOT / "target", "/opt/swc-target-base")
(ROOT / "target").symlink_to(BUILD_ROOT / "target", target_is_directory=True)
source_base = Path("/opt/swc-src-base")
source_base.mkdir()
for crate in CRATES:
    source = ROOT / "crates" / crate / "src"
    destination = source_base / crate
    shutil.move(source, destination)
    source.symlink_to(BUILD_ROOT / "src" / crate, target_is_directory=True)

for frozen_root in (ROOT, Path("/opt/swc-target-base"), source_base):
    for directory, directories, files in os.walk(frozen_root, followlinks=False):
        base = Path(directory)
        for name in files:
            path = base / name
            if path.is_symlink():
                continue
            os.chown(path, 0, 0)
            os.chmod(path, path.stat().st_mode & ~0o222)
        for name in directories:
            path = base / name
            if path.is_symlink():
                continue
            os.chown(path, 0, 0)
            os.chmod(path, path.stat().st_mode & ~0o222)
        os.chown(base, 0, 0)
        os.chmod(base, base.stat().st_mode & ~0o222)
