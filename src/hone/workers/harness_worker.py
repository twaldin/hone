"""HarnessWorker: runs a coding-agent harness with an inner scorer-proxy loop.

The harness agent MAY call the scorer proxy up to `worker_budget` times per
propose() call.  Each invocation stashes the current workdir state, runs the
grader, and returns a JSON envelope.  After the harness session ends,
HarnessWorker picks the best-scoring attempt and restores its stash.
"""
from __future__ import annotations

import json
import shlex
import subprocess
import uuid
from pathlib import Path
from typing import Callable

from hone.scorer_result import ScorerResult
from hone.workers.base import Worker, WorkerAttempt, WorkerResult


class HarnessWorker(Worker):
    """Inner worker that delegates to a harness adapter with scorer-proxy access."""

    name = "harness"

    def __init__(
        self,
        harness_name: str,
        model: str | None = None,
        *,
        worker_budget: int,
        scorer_readonly: bool = True,
        scorer_proxy_path: Path | None = None,
        timeout_seconds: int = 1800,
    ) -> None:
        self.harness_name = harness_name
        self.model = model
        self.worker_budget = worker_budget
        self.scorer_readonly = scorer_readonly
        self.scorer_proxy_path = Path(scorer_proxy_path) if scorer_proxy_path else None
        self.timeout_seconds = timeout_seconds

    def propose(
        self,
        *,
        prompt: str,
        workdir: Path,
        scorer: Callable[[Path], ScorerResult],
        scorer_budget: int,
    ) -> WorkerResult:
        effective_budget = min(self.worker_budget, scorer_budget)
        if effective_budget < 1:
            return WorkerResult(
                attempts=[],
                best_attempt_idx=-1,
                scorer_calls=0,
                tokens_in=None,
                tokens_out=None,
                cost_usd=None,
                error="scorer budget exhausted",
            )

        workdir = Path(workdir)
        run_dir = workdir.parent
        grader_path = self._load_grader_config(run_dir)

        budget_file = run_dir / f".hone-budget-{uuid.uuid4().hex[:12]}.json"
        budget_data: dict = {"remaining": effective_budget, "attempts": [], "policy_decisions": []}
        _write_json_atomic(budget_file, budget_data)

        proxy_path = self.scorer_proxy_path or (run_dir / ".hone-scorer")
        _write_proxy_script(
            proxy_path,
            budget_file=budget_file,
            grader_path=grader_path,
            workdir=workdir,
            run_dir=run_dir,
            grader_timeout=self.timeout_seconds,
            scorer_readonly=self.scorer_readonly,
        )

        extended_prompt = _compose_extended_prompt(prompt, effective_budget)

        try:
            from harness import HarnessError, RunSpec, run
        except ImportError as exc:
            budget_file.unlink(missing_ok=True)
            proxy_path.unlink(missing_ok=True)
            return WorkerResult(
                attempts=[],
                best_attempt_idx=-1,
                scorer_calls=0,
                tokens_in=None,
                tokens_out=None,
                cost_usd=None,
                error=f"harness library not installed: {exc}",
            )

        spec = RunSpec(
            harness=self.harness_name,
            prompt=extended_prompt,
            workdir=workdir,
            model=self.model,
            timeout_seconds=self.timeout_seconds,
            env={
                "HONE_SCORER_PROXY": str(proxy_path),
                "HONE_BUDGET_FILE": str(budget_file),
            },
        )

        try:
            harness_result = run(spec)
        except Exception as exc:
            budget_file.unlink(missing_ok=True)
            proxy_path.unlink(missing_ok=True)
            return WorkerResult(
                attempts=[],
                best_attempt_idx=-1,
                scorer_calls=0,
                tokens_in=None,
                tokens_out=None,
                cost_usd=None,
                error=str(exc),
            )
        finally:
            proxy_path.unlink(missing_ok=True)

        if not harness_result.ok:
            tail = (harness_result.stderr or harness_result.stdout or "").strip()[:500]
            budget_file.unlink(missing_ok=True)
            return WorkerResult(
                attempts=[],
                best_attempt_idx=-1,
                scorer_calls=0,
                tokens_in=harness_result.tokens_in,
                tokens_out=harness_result.tokens_out,
                cost_usd=harness_result.cost_usd,
                error=(
                    f"harness {self.harness_name!r} exited {harness_result.exit_code} "
                    f"(timed_out={harness_result.timed_out}): {tail}"
                ),
            )

        budget_data = json.loads(budget_file.read_text(encoding="utf-8"))
        budget_file.unlink(missing_ok=True)
        attempt_records = budget_data.get("attempts", [])

        if not attempt_records:
            return WorkerResult(
                attempts=[],
                best_attempt_idx=-1,
                scorer_calls=0,
                tokens_in=harness_result.tokens_in,
                tokens_out=harness_result.tokens_out,
                cost_usd=harness_result.cost_usd,
                error="harness produced no scored attempts",
            )

        attempts = [
            WorkerAttempt(
                attempt_idx=rec["attempt_idx"],
                score=rec["score"],
                submetrics=rec.get("submetrics", {}),
                trace_stderr=rec.get("trace_stderr", ""),
                raw_stdout=rec.get("raw_stdout", ""),
                parsed_envelope=rec.get("parsed_envelope"),
                commit_sha=None,
                notes=rec.get("notes", ""),
            )
            for rec in attempt_records
        ]

        best_idx = max(range(len(attempts)), key=lambda i: attempts[i].score)
        best_attempt_idx = attempts[best_idx].attempt_idx

        _restore_best_stash(workdir, best_attempt_idx, attempt_records)

        return WorkerResult(
            attempts=attempts,
            best_attempt_idx=best_idx,
            scorer_calls=len(attempts),
            tokens_in=harness_result.tokens_in,
            tokens_out=harness_result.tokens_out,
            cost_usd=harness_result.cost_usd,
        )

    def _load_grader_config(self, run_dir: Path) -> Path:
        manifest_path = run_dir / "run.json"
        if manifest_path.exists():
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
                return Path(data["grader_path"])
            except Exception:
                pass
        return Path("/dev/null")


def _restore_best_stash(
    workdir: Path,
    best_attempt_idx: int,
    attempt_records: list[dict],
) -> None:
    """Restore the best attempt's stash and drop all stashes."""
    pushed = [(rec["attempt_idx"], i) for i, rec in enumerate(attempt_records) if rec.get("pushed", False)]
    total = len(pushed)
    if total == 0:
        return

    # Clear any uncommitted agent edits so stash apply is conflict-free.
    _git(["reset", "--hard", "HEAD"], cwd=workdir)
    _git(["clean", "-fd"], cwd=workdir)

    push_pos = next((pos for pos, (ai, _) in enumerate(pushed) if ai == best_attempt_idx), None)
    if push_pos is not None:
        stash_ref = f"stash@{{{total - 1 - push_pos}}}"
        try:
            _git(["stash", "apply", stash_ref], cwd=workdir)
        except subprocess.CalledProcessError:
            pass

    for _ in range(total):
        try:
            _git(["stash", "drop", "stash@{0}"], cwd=workdir)
        except subprocess.CalledProcessError:
            break


def _write_proxy_script(
    proxy_path: Path,
    *,
    budget_file: Path,
    grader_path: Path,
    workdir: Path,
    run_dir: Path,
    grader_timeout: int,
    scorer_readonly: bool,
) -> None:
    script = (
        "#!/usr/bin/env bash\n"
        f'export HONE_BUDGET_FILE={shlex.quote(str(budget_file))}\n'
        f'export HONE_GRADER_PATH={shlex.quote(str(grader_path))}\n'
        f'export HONE_WORKDIR={shlex.quote(str(workdir))}\n'
        f'export HONE_RUN_DIR={shlex.quote(str(run_dir))}\n'
        f'export HONE_GRADER_TIMEOUT={shlex.quote(str(grader_timeout))}\n'
        f'export HONE_SCORER_READONLY={shlex.quote("1" if scorer_readonly else "0")}\n'
        'exec python3 -m hone.workers._scorer_proxy "$@"\n'
    )
    proxy_path.write_text(script, encoding="utf-8")
    proxy_path.chmod(0o755)


def _compose_extended_prompt(prompt: str, budget: int) -> str:
    section = (
        "\n\n## Inner-loop scorer access\n\n"
        f"You MAY invoke the scorer up to {budget} time(s) during this session "
        "via the proxy at `\"$HONE_SCORER_PROXY\"`.\n\n"
        "Each invocation:\n"
        "- Snapshots your current workdir state\n"
        "- Runs the grader against it\n"
        "- Prints a JSON envelope to stdout: "
        "`{\"score\": <float>, \"submetrics\": {...}, \"attempt_idx\": <int>, \"remaining_budget\": <int>}`\n"
        "- Returns your workdir to its pre-call state so you can keep editing\n\n"
        "Strategy: iterate, call the proxy after each promising edit, keep track of "
        "what produced the best score, and finalize with your best attempt before exiting.\n"
        "The system will automatically select the highest-scoring snapshot.\n"
        "Exit when satisfied or when `remaining_budget` reaches 0."
    )
    return prompt + section


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def _git(args: list[str], *, cwd: Path) -> str:
    res = subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True
    )
    return res.stdout
