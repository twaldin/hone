import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

from pilot import __main__ as cli
from pilot.runtime import Gateway, digest, pool_domains


root = Path(__file__).resolve().parents[3]
pin = root / ".pilot-cache/omp-18.16.0"
executable = pin / "node_modules/.bin/omp"
resolved = executable.resolve(strict=True)
assert resolved.is_relative_to(pin), "Pinned CLI escaped the worktree install"
assert Path(shutil.which("omp")).resolve() == resolved, "Runner PATH does not select pinned omp"
assert cli.execution_limits() == ([6], 10)
assert os.environ["NLTK_DATA"] == str(root / ".pilot-cache/nltk")
version = subprocess.check_output([str(executable), "--version"], text=True).strip()
assert version == "omp/18.16.0", version
packages = {}
for name in ("pi-coding-agent", "pi-ai", "pi-catalog", "pi-utils", "pi-natives", "pi-wire"):
    package = pin / "node_modules/@oh-my-pi" / name / "package.json"
    packages[name] = json.loads(package.read_text())["version"]
assert set(packages.values()) == {"18.16.0"}, packages
prior = json.loads((root / "evidence/pilot/seeds12-search-10/mbpp/1/hone/manifest.json").read_text())
pool, env = cli.environment(root / ".pilot-state/account-pool.json")
assert pool_domains(pool) == {"gmail.com": 2, "purdue.edu": 1}
assert digest(pool) == prior["account_pool_hash"]
assert pool["*"] is False and pool["anthropic"]["apiKeys"] is False
assert Path(shutil.which("omp", path=env["PATH"])).resolve() == resolved

gateway = Gateway(env)
try:
    assert Path(gateway.process.args[-1]) == resolved
    assert gateway.route_identity == prior["route_identity"]
    assert gateway.route_identity["oauth_only_session"] is True
    assert gateway.ordinal == 0, "Admission dispatched a gateway request"
    route = gateway.route_identity
finally:
    gateway.close()

cli.configure_nlp(root / ".pilot-cache")
args = argparse.Namespace(cache=root / ".pilot-cache", controls=root / "evidence/pilot/controls-7b", task="all")
assert cli.load_panel(args) == ("mbpp", "hover")
cli.verify_bundle(root / "evidence/pilot/seeds12-search-10")
expected = json.loads((root / "evidence/pilot/selection-reuse-10/admission.json").read_text())
source_hashes = {name: cli.file_hash(root / name) for name in expected["execution_source_hashes"]}
assert source_hashes == expected["execution_source_hashes"]
print(json.dumps({
    "schema": "pilot-pinned-runtime-admission-v10",
    "committed_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "omp_executable": str(executable), "gateway_omp_realpath": str(resolved), "version": version,
    "package_versions": packages, "package_lock_file_hash": cli.file_hash(pin / "package-lock.json"),
    "cli_file_hash": cli.file_hash(resolved), "route_identity": route, "route_hash": digest(route),
    "account_pool_hash": digest(pool), "account_domains": pool_domains(pool), "api_keys_allowed": False,
    "selected_panel": ["mbpp", "hover"], "execution_source_hashes": source_hashes,
    "cpu_affinity": [6], "nice": 10, "gateway_requests": 0, "model_calls": 0,
    "final_test_labels_read": False, "global_omp_broker_config_or_schedule_changed_by_lane": False,
}, sort_keys=True), flush=True)
