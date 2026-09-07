from pathlib import Path
import os
import shutil

root = Path("/opt/uv-root")
target = root / "target"
shutil.move(target, "/opt/uv-target-base")
target.symlink_to("/tmp/hone-uv-build/target", target_is_directory=True)

source = root / "crates/uv-resolver/src"
base = Path("/opt/uv-resolver-src-base")
shutil.move(source, base)
source.mkdir()
for directory, directories, files in os.walk(base):
    relative = Path(directory).relative_to(base)
    destination = source / relative
    for name in directories:
        (destination / name).mkdir()
    for name in files:
        (destination / name).symlink_to(Path("/tmp/hone-uv-build/resolver-src") / relative / name)
