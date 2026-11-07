import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

from pilot import __main__ as cli
from pilot.campaign import CampaignGuard, campaign_scope
from pilot.runtime import Gateway, digest, pool_domains
from pilot.verification import _limits, grader_journal, validate_grader_receipt


ROOT = Path(__file__).resolve().parents[3]
DECLARATION_COMMIT = "3d9da07960d74a846fe42f0d1b58f56255635f99"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    proof = {"schema": "pilot-pinned-runtime-admission-v11", "declaration_commit": DECLARATION_COMMIT,
             "model_calls": 0, "gateway_requests": 0, "final_test_labels_read": False,
             "pid": os.getpid(), "unit": os.environ.get("SYSTEMD_UNIT"),
             "grader_limits": {stage: dict(zip(("candidate_seconds", "deadline_seconds"), _limits(stage)))
                              for stage in ("planner", "worker", "wrapper")}}
    gateway = None
    try:
        guard = CampaignGuard(args.out)
        guard.check_disk()
        pin = ROOT / ".pilot-cache/omp-18.16.0"
        executable = pin / "node_modules/.bin/omp"
        resolved = executable.resolve(strict=True)
        assert resolved.is_relative_to(pin) and Path(shutil.which("omp")).resolve() == resolved
        assert cli.execution_limits() == ([6], 10)
        assert os.environ["NLTK_DATA"] == str(ROOT / ".pilot-cache/nltk")
        version = subprocess.check_output([str(executable), "--version"], text=True).strip()
        assert version == "omp/18.16.0"
        packages = {name: json.loads((pin / "node_modules/@oh-my-pi" / name / "package.json").read_text())["version"]
                    for name in ("pi-coding-agent", "pi-ai", "pi-catalog", "pi-utils", "pi-natives", "pi-wire")}
        assert set(packages.values()) == {"18.16.0"}
        prior = json.loads((ROOT / "evidence/pilot/runtime-rerun-10/admission.json").read_text())
        pool, env = cli.environment(ROOT / ".pilot-state/account-pool.json")
        assert pool_domains(pool) == {"gmail.com": 2, "purdue.edu": 1}
        assert digest(pool) == prior["account_pool_hash"] and pool["*"] is False and pool["anthropic"]["apiKeys"] is False
        assert Path(shutil.which("omp", path=env["PATH"])).resolve() == resolved
        gateway = Gateway(env)
        assert Path(gateway.process.args[-1]) == resolved
        assert gateway.route_identity == prior["route_identity"] and gateway.route_identity["oauth_only_session"] is True
        assert gateway.ordinal == 0
        proof.update(gateway_omp_realpath=str(resolved), cli_file_hash=cli.file_hash(resolved),
                     package_lock_file_hash=cli.file_hash(pin / "package-lock.json"), version=version,
                     package_versions=packages, route_identity=gateway.route_identity, route_hash=digest(gateway.route_identity),
                     account_pool_hash=digest(pool), account_domains=pool_domains(pool), api_keys_allowed=False)
        gateway.close()
        gateway = None
        cli.configure_nlp(ROOT / ".pilot-cache")
        panel_args = argparse.Namespace(cache=ROOT / ".pilot-cache", controls=ROOT / "evidence/pilot/controls-7b", task="all")
        with campaign_scope(guard), grader_journal(args.out / "grader-outcomes.jsonl", purpose="admission"):
            guard.check_disk()
            index = ROOT / ".pilot-cache/hover-retrieval"
            authority = json.loads((panel_args.controls / "cohorts.json").read_text())["retrieval_receipt"]
            receipt_path = index / "index-receipt.json"
            if json.loads(receipt_path.read_text()) != authority:
                raise RuntimeError("HoVer receipt differs from admitted authority; rebuilding is forbidden")
            expected = {"wiki.abstracts.2017.tar.gz": authority["corpus_archive_sha256"],
                        "wiki.abstracts.2017.jsonl": authority["corpus_sha256"],
                        **{"bm25s_retriever/" + name: value for name, value in authority["index_sha256"].items()}}
            index_files = {str(receipt_path.relative_to(ROOT)): cli.file_hash(receipt_path)}
            for name, expected_hash in expected.items():
                with (index / name).open("rb") as stream:
                    observed = hashlib.file_digest(stream, "sha256").hexdigest()
                if observed != expected_hash:
                    raise RuntimeError("Admitted HoVer payload changed: " + name)
                index_files[str((index / name).relative_to(ROOT))] = "sha256:" + observed
            assert cli.load_panel(panel_args) == ("mbpp", "hover")
        cli.verify_bundle(ROOT / "evidence/pilot/seed0-search-9")
        cli.verify_bundle(ROOT / "evidence/pilot/seeds12-search-10-rerun1")
        transition = json.loads((ROOT / "evidence/pilot/source-transition-11.json").read_text())
        sources = set(transition["files"]) | {"pilot/results.py", "pilot/spend.py", "evidence/pilot/runtime-rerun-11e/launch.py",
                  "evidence/pilot/runtime-rerun-11e/run.py", "evidence/pilot/runtime-rerun-11e/admit.py"}
        receipts = [json.loads(line) for line in (args.out / "grader-outcomes.jsonl").read_text().splitlines()]
        outcomes = {}
        for receipt in receipts:
            if receipt.get("event") == "grader-outcome":
                validate_grader_receipt(receipt)
                outcomes[receipt["outcome"]] = outcomes.get(receipt["outcome"], 0) + 1
        proof.update(passed=True, selected_panel=["mbpp", "hover"], execution_source_hashes={name: cli.file_hash(ROOT / name) for name in sorted(sources)},
                     index_file_hashes=index_files, predeclaration_file_hash=cli.file_hash(ROOT / "evidence/pilot/predeclaration-11.md"),
                     source_transition_hash=cli.file_hash(ROOT / "evidence/pilot/source-transition-11.json"),
                     grader_journal_file_hash=cli.file_hash(args.out / "grader-outcomes.jsonl"), grader_outcomes=outcomes,
                     cpu_affinity=[6], nice=10, admitted_worktree_base_head=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                     official_gepa_and_adapter_unchanged=cli.file_hash(ROOT / "pilot/search.py") == prior["execution_source_hashes"]["pilot/search.py"])
    except Exception as error:
        proof.update(passed=False, error_type=type(error).__name__, error=str(error))
        if hasattr(error, "receipt"):
            proof["receipt"] = error.receipt
        raise
    finally:
        if gateway is not None:
            proof["gateway_requests"] = gateway.ordinal
            gateway.close()
        proof["elapsed_seconds"] = time.monotonic() - started
        cli.save(args.out / "admission.json", proof)
        print(json.dumps(proof, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
