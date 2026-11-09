import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

from pilot.campaign import CampaignGuard


ROOT = Path(__file__).resolve().parents[3]


def main():
    parser = argparse.ArgumentParser(description="Launch the admitted pilot with inherited CPU-6 affinity")
    parser.add_argument("mode", choices=("admit", "run"))
    parser.add_argument("--unit", required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if (args.mode == "admit") != (args.out is not None):
        parser.error("Only admit requires --out; run uses the frozen campaign root")
    if not args.unit.endswith(".service"):
        args.unit += ".service"
    if Path(args.unit).name != args.unit:
        parser.error("--unit must be a unit name, not a path")
    record = ROOT / ".pilot-state" / (args.unit + ".launch.json")
    if record.exists():
        raise FileExistsError("Launch receipt already exists; do not restart a recorded unit")
    available = CampaignGuard(ROOT / ".pilot-state").check_disk()
    taskset = shutil.which("taskset")
    if taskset is None:
        raise RuntimeError("Explicit taskset affinity is required")
    pin = ROOT / ".pilot-cache/omp-18.16.0/node_modules/.bin"
    settings = {"PATH": str(pin) + os.pathsep + os.environ["PATH"], "PYTHONPATH": str(ROOT),
                "NLTK_DATA": str(ROOT / ".pilot-cache/nltk"), "PYTHONDONTWRITEBYTECODE": "1",
                "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
                "NUMEXPR_NUM_THREADS": "1", "BLIS_NUM_THREADS": "1", "VECLIB_MAXIMUM_THREADS": "1",
                "JAX_PLATFORMS": "cpu", "TOKENIZERS_PARALLELISM": "false", "SYSTEMD_UNIT": args.unit}
    script = ROOT / "evidence/pilot/runtime-rerun-11b" / ("admit.py" if args.mode == "admit" else "run.py")
    command = ["systemd-run", "--user", "--unit", args.unit, "--property=Type=exec", "--property=Restart=no",
               "--property=AllowedCPUs=6", "--property=Nice=10", "--property=WorkingDirectory=" + str(ROOT)]
    command += ["--setenv=" + name + "=" + value for name, value in settings.items()]
    command += [taskset, "-c", "6", str(ROOT / "pilot/.venv/bin/python"), str(script)]
    if args.out is not None:
        command += ["--out", str(args.out.resolve())]
    receipt = {"mode": args.mode, "unit": args.unit, "pid": None, "disk_available_bytes": available,
               "taskset": taskset, "requested_affinity": [6], "requested_nice": 10, "Restart": "no", "status": "launching"}
    record.parent.mkdir(parents=True, exist_ok=True)
    with record.open("x") as stream:
        json.dump(receipt, stream, sort_keys=True)
        stream.write("\n")
    try:
        subprocess.run(command, check=True, timeout=30)
        receipt["pid"] = int(subprocess.check_output(
            ["systemctl", "--user", "show", args.unit, "--property=MainPID", "--value"], text=True, timeout=30).strip())
        receipt["status"] = "started" if receipt["pid"] else "exited_before_pid_receipt"
    except (subprocess.SubprocessError, OSError) as error:
        receipt.update(status="launch_failed", error_type=type(error).__name__)
        raise
    finally:
        record.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        print(json.dumps(receipt, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
