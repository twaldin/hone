import argparse
import json
import os
import select
import subprocess


def properties(unit):
    raw = subprocess.check_output(["systemctl", "--user", "show", unit,
                                   "--property=LoadState,MainPID,ExecMainPID,ExecMainStatus,Result,ActiveState"], text=True, timeout=30)
    return dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)


def main():
    parser = argparse.ArgumentParser(description="Wait for an already-launched unit without polling or restarting it")
    parser.add_argument("unit")
    args = parser.parse_args()
    state = properties(args.unit)
    pid = int(state.get("MainPID", "0"))
    if state.get("LoadState") != "loaded":
        raise ValueError("The recorded unit is not loaded")
    if pid:
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            fd = None
        if fd is not None:
            try:
                if int(properties(args.unit).get("MainPID", "0")) == pid:
                    select.select([fd], [], [])
            finally:
                os.close(fd)
    state = properties(args.unit)
    print(json.dumps({"unit": args.unit, **state}, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
