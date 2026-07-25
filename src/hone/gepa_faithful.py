"""GEPA-facing primitives for code-state optimization.

This module is intentionally a thin layer: GEPA owns candidate selection,
proposal, evaluation scheduling, frontier state, and metric-call accounting.
Hone owns the repository-specific candidate handle, the default test-command
evaluator, and the harness adapter that turns proposed instructions into a
new committed code state.
"""
from __future__ import annotations

import importlib
import os
import subprocess
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_FRONTIER_TYPE = "hybrid"


@dataclass(frozen=True)
class HoneCodeCandidate:
    """GEPA candidate fields Hone needs for code mutation."""

    commit_sha: str
    instructions: str


CandidateRecord = dict[str, str]


def candidate_to_gepa(candidate: HoneCodeCandidate) -> CandidateRecord:
    return {
        "commit_sha": candidate.commit_sha,
        "instructions": candidate.instructions,
    }


def candidate_from_gepa(candidate: Mapping[str, str]) -> HoneCodeCandidate:
    try:
        commit_sha = candidate["commit_sha"]
        instructions = candidate["instructions"]
    except KeyError as exc:
        raise ValueError(f"missing GEPA candidate field: {exc.args[0]}") from exc
    return HoneCodeCandidate(commit_sha=commit_sha, instructions=instructions)


@dataclass(frozen=True)
class HoneTaskExample:
    """Default optimize_anything dataset item for a repository task."""

    id: str
    repo_path: Path | str
    base_commit: str
    test_command: str
    prompt: str | None = None
    timeout_seconds: int | None = None
    baseline_seconds: float | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "repo_path", Path(self.repo_path).expanduser())


@dataclass(frozen=True)
class EvaluatorReturn:
    score: float
    side_info: dict[str, Any]

    def as_gepa(self) -> tuple[float, dict[str, Any]]:
        return self.score, self.side_info


class MetricCallBudget:
    """Small explicit guard for local callers that preflight metric budgets."""

    def __init__(self, max_metric_calls: int) -> None:
        if max_metric_calls < 0:
            raise ValueError("max_metric_calls must be >= 0")
        self.max_metric_calls = max_metric_calls
        self.used_metric_calls = 0

    @property
    def remaining_metric_calls(self) -> int:
        return self.max_metric_calls - self.used_metric_calls

    def consume(self, count: int = 1) -> None:
        if count < 1:
            raise ValueError("count must be >= 1")
        if self.used_metric_calls + count > self.max_metric_calls:
            raise RuntimeError("metric-call budget exhausted")
        self.used_metric_calls += count


@dataclass(frozen=True)
class CommandRun:
    exit_code: int
    duration_seconds: float
    stdout: str
    stderr: str
    timed_out: bool = False


CommandRunner = Callable[[str, Path, int | None], CommandRun]


class TestCommandEvaluator:
    """Default GEPA evaluator: run target repo tests and return side_info.scores."""

    __test__ = False

    def __init__(
        self,
        *,
        worktree_root: Path | str | None = None,
        command_runner: CommandRunner | None = None,
        keep_worktrees: bool = False,
        default_timeout_seconds: int = 600,
    ) -> None:
        self.worktree_root = Path(worktree_root).expanduser() if worktree_root is not None else None
        self.command_runner = command_runner or _run_shell_command
        self.keep_worktrees = keep_worktrees
        self.default_timeout_seconds = default_timeout_seconds

    def evaluate(
        self,
        candidate: HoneCodeCandidate | Mapping[str, str],
        example: HoneTaskExample,
        opt_state: object | None = None,
    ) -> tuple[float, dict[str, Any]]:
        del opt_state
        code_candidate = (
            candidate_from_gepa(candidate) if isinstance(candidate, Mapping) else candidate
        )
        timeout = example.timeout_seconds or self.default_timeout_seconds
        repo_path = Path(example.repo_path)

        baseline_run: CommandRun | None = None
        baseline_seconds = example.baseline_seconds
        if baseline_seconds is None:
            with _candidate_worktree(
                repo_path=repo_path,
                commit_sha=example.base_commit,
                root=self.worktree_root,
                prefix="hone-baseline-",
                keep=self.keep_worktrees,
            ) as baseline_worktree:
                baseline_run = self.command_runner(example.test_command, baseline_worktree, timeout)
            baseline_seconds = max(baseline_run.duration_seconds, 0.001)

        with _candidate_worktree(
            repo_path=repo_path,
            commit_sha=code_candidate.commit_sha,
            root=self.worktree_root,
            prefix="hone-eval-",
            keep=self.keep_worktrees,
        ) as worktree:
            run = self.command_runner(example.test_command, worktree, timeout)

        tests_passed = run.exit_code == 0 and not run.timed_out
        speed_score = _speed_score(run.duration_seconds, baseline_seconds)
        changed_files = _changed_files(repo_path, example.base_commit, code_candidate.commit_sha)
        changed_files_score = 1.0 / (1.0 + len(changed_files))
        score = 1.0 + speed_score if tests_passed else 0.0
        side_info: dict[str, Any] = {
            "scores": {
                "pass": 1.0 if tests_passed else 0.0,
                "speed": speed_score,
                "changed_files": changed_files_score,
            },
            "test_command": example.test_command,
            "duration_seconds": run.duration_seconds,
            "baseline_seconds": baseline_seconds,
            "baseline_established": example.baseline_seconds is None,
            "exit_code": run.exit_code,
            "timed_out": run.timed_out,
            "stdout_tail": _tail(run.stdout),
            "stderr_tail": _tail(run.stderr),
            "changed_files": changed_files,
            "commit_sha": code_candidate.commit_sha,
        }
        if baseline_run is not None:
            side_info["baseline_exit_code"] = baseline_run.exit_code
            side_info["baseline_timed_out"] = baseline_run.timed_out
        if run.timed_out:
            side_info["error"] = "timeout"
        return EvaluatorReturn(score=score, side_info=side_info).as_gepa()


@dataclass(frozen=True)
class HarnessAdapterConfig:
    harness: str = "codex"
    model: str | None = None
    timeout_seconds: int = 1800
    instructions: str | None = None
    env: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class HarnessMutationResult:
    candidate: HoneCodeCandidate
    run: Any
    changed_files: list[str]
    worktree_path: Path


class HarnessMutatorAdapter:
    """Default `harness` adapter for GEPA-proposed code instructions."""

    name = "harness"

    def __init__(
        self,
        config: HarnessAdapterConfig | None = None,
        *,
        worktree_root: Path | str | None = None,
        keep_worktrees: bool = True,
    ) -> None:
        self.config = config or HarnessAdapterConfig()
        self.worktree_root = Path(worktree_root).expanduser() if worktree_root is not None else None
        self.keep_worktrees = keep_worktrees

    def mutate(
        self,
        candidate: HoneCodeCandidate | Mapping[str, str],
        example: HoneTaskExample,
        *,
        iteration: int,
    ) -> HarnessMutationResult:
        code_candidate = (
            candidate_from_gepa(candidate) if isinstance(candidate, Mapping) else candidate
        )
        try:
            from harness import HarnessError, RunSpec, run
        except ImportError as exc:
            raise RuntimeError(
                "harness library not installed. Install /Users/twaldin/harness "
                "or add it to PYTHONPATH."
            ) from exc

        worktree_ctx = _candidate_worktree(
            repo_path=Path(example.repo_path),
            commit_sha=code_candidate.commit_sha,
            root=self.worktree_root,
            prefix=f"hone-harness-{iteration}-",
            keep=self.keep_worktrees,
        )
        with worktree_ctx as worktree:
            prompt = _harness_prompt(code_candidate, example)
            spec = RunSpec(
                harness=self.config.harness,
                prompt=prompt,
                workdir=worktree,
                model=self.config.model,
                instructions=self.config.instructions or code_candidate.instructions,
                timeout_seconds=self.config.timeout_seconds,
                env=dict(self.config.env),
            )
            try:
                result = run(spec)
            except HarnessError as exc:
                raise RuntimeError(f"harness {self.config.harness!r}: {exc}") from exc
            if not result.ok:
                tail = (result.stderr or result.stdout or "").strip()[:500]
                raise RuntimeError(
                    f"harness {self.config.harness!r} exited {result.exit_code} "
                    f"(timed_out={result.timed_out}): {tail}"
                )
            changed_files = _working_tree_changed_files(worktree)
            commit_sha = _commit_if_changed(worktree, f"hone candidate {iteration}")
            return HarnessMutationResult(
                candidate=HoneCodeCandidate(
                    commit_sha=commit_sha or code_candidate.commit_sha,
                    instructions=code_candidate.instructions,
                ),
                run=result,
                changed_files=changed_files,
                worktree_path=worktree,
            )

    def propose_new_texts(
        self,
        candidate: HoneCodeCandidate | Mapping[str, str],
        reflective_dataset: Mapping[str, Any],
        components_to_update: Sequence[str],
        *,
        example: HoneTaskExample,
        iteration: int,
    ) -> CandidateRecord:
        """GEPA proposer hook that mutates repository state via a coding CLI."""

        del components_to_update
        code_candidate = (
            candidate_from_gepa(candidate) if isinstance(candidate, Mapping) else candidate
        )
        instructions = _instructions_from_reflection(
            fallback=code_candidate.instructions,
            reflective_dataset=reflective_dataset,
        )
        mutation = self.mutate(
            HoneCodeCandidate(
                commit_sha=code_candidate.commit_sha,
                instructions=instructions,
            ),
            example,
            iteration=iteration,
        )
        return candidate_to_gepa(
            HoneCodeCandidate(
                commit_sha=mutation.candidate.commit_sha,
                instructions=code_candidate.instructions,
            )
        )


@dataclass(frozen=True)
class OptimizeCodeConfig:
    max_metric_calls: int = 20
    frontier_type: str = DEFAULT_FRONTIER_TYPE
    seed: int = 0
    run_dir: str | None = None
    candidate_selection_strategy: str = "pareto"
    adapter_name: str = "harness"

    def to_gepa_config(self) -> dict[str, Any]:
        return {
            "engine": {
                "max_metric_calls": self.max_metric_calls,
                "frontier_type": self.frontier_type,
                "seed": self.seed,
                "candidate_selection_strategy": self.candidate_selection_strategy,
                **({"run_dir": self.run_dir} if self.run_dir is not None else {}),
            }
        }


@dataclass(frozen=True)
class OptimizeCodeResult:
    raw_result: Any
    metadata: dict[str, Any]

    @property
    def best_candidate(self) -> HoneCodeCandidate:
        raw_best = _result_get(self.raw_result, "best_candidate")
        if isinstance(raw_best, Mapping):
            return candidate_from_gepa({str(k): str(v) for k, v in raw_best.items()})
        raise ValueError("gepa-ts result did not include a mapping best_candidate")

    @property
    def best_commit_sha(self) -> str:
        return self.best_candidate.commit_sha


class _ProposerAdapter:
    """Minimal adapter object for gepa-ts sidecar proposer callback discovery."""

    def __init__(self, propose_new_texts: Callable[..., Mapping[str, str]]) -> None:
        self.propose_new_texts = propose_new_texts

    def make_reflective_dataset(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {}


class GepaTsOptimizeAnythingRunner:
    """Thin Python boundary for `@twaldin/gepa-ts` optimize_anything.

    The default path imports the Python sidecar shim only when called. Tests can
    pass a fake runner to `optimize_code`, but production callers get GEPA-owned
    candidate pool, proposal, selection, budget, and result semantics.
    """

    module_name = "gepa.optimize_anything"

    def optimize_anything(
        self,
        *,
        seed_candidate: Mapping[str, str],
        evaluator: Callable[..., tuple[float, dict[str, Any]]],
        dataset: Sequence[Mapping[str, Any]],
        valset: Sequence[Mapping[str, Any]],
        objective: str | None,
        background: str | None,
        config: Mapping[str, Any],
        reflection_lm: Callable[[str], str] | str | None = None,
        custom_candidate_proposer: Callable[..., Mapping[str, str]] | None = None,
    ) -> Any:
        module = importlib.import_module(self.module_name)
        optimize_anything = getattr(module, "optimize_anything")
        gepa_config = _build_gepa_config(config, reflection_lm)
        if custom_candidate_proposer is not None:
            _attach_custom_candidate_proposer(gepa_config, custom_candidate_proposer)
        return optimize_anything(
            seed_candidate=dict(seed_candidate),
            evaluator=evaluator,
            dataset=list(dataset),
            valset=list(valset),
            objective=objective,
            background=background,
            config=gepa_config,
            **({"adapter": _ProposerAdapter(custom_candidate_proposer)} if custom_candidate_proposer else {}),
        )


def optimize_code(
    *,
    repo_path: Path | str,
    test_command: str,
    seed_instructions: str,
    base_commit: str | None = None,
    max_metric_calls: int = 20,
    reflection_lm: Callable[[str], str] | str | None = None,
    objective: str | None = None,
    background: str | None = None,
    config: OptimizeCodeConfig | None = None,
    evaluator: TestCommandEvaluator | None = None,
    runner: GepaTsOptimizeAnythingRunner | None = None,
    mutator_adapter: HarnessMutatorAdapter | None = None,
) -> OptimizeCodeResult:
    """Run GEPA optimize_anything for a code-state candidate.

    This function does not call Hone's legacy repo_frontier optimizer. It
    serializes Hone's code-state candidate/task into the optimize_anything API
    and delegates the optimizer loop to the supplied or default gepa-ts runner.
    """

    repo = Path(repo_path).expanduser()
    resolved_base = base_commit or _git(["rev-parse", "HEAD"], cwd=repo, text=True).stdout.strip()
    example = HoneTaskExample(
        id="repo",
        repo_path=repo,
        base_commit=resolved_base,
        test_command=test_command,
        prompt=objective,
    )
    seed_candidate = HoneCodeCandidate(commit_sha=resolved_base, instructions=seed_instructions)
    optimize_config = config or OptimizeCodeConfig(max_metric_calls=max_metric_calls)
    test_evaluator = evaluator or TestCommandEvaluator()
    optimize_runner = runner or GepaTsOptimizeAnythingRunner()
    proposer_adapter = mutator_adapter or HarnessMutatorAdapter()
    proposal_count = 0

    def gepa_evaluator(
        candidate: Mapping[str, str],
        *,
        example: Mapping[str, Any] | HoneTaskExample | None = None,
        opt_state: object | None = None,
    ) -> tuple[float, dict[str, Any]]:
        task_example = _coerce_example(example) if example is not None else example_obj
        return test_evaluator.evaluate(candidate, task_example, opt_state)

    example_obj = example
    serialized_example = _example_to_gepa(example)

    def gepa_custom_candidate_proposer(
        candidate: Mapping[str, str],
        reflective_dataset: Mapping[str, Any],
        components_to_update: Sequence[str],
    ) -> Mapping[str, str]:
        nonlocal proposal_count
        proposal_count += 1
        return proposer_adapter.propose_new_texts(
            candidate,
            reflective_dataset,
            components_to_update,
            example=example_obj,
            iteration=proposal_count,
        )

    raw_result = optimize_runner.optimize_anything(
        seed_candidate=candidate_to_gepa(seed_candidate),
        evaluator=gepa_evaluator,
        dataset=[serialized_example],
        valset=[serialized_example],
        objective=objective,
        background=background,
        config=optimize_config.to_gepa_config(),
        reflection_lm=reflection_lm,
        custom_candidate_proposer=gepa_custom_candidate_proposer,
    )
    metadata = _result_metadata(raw_result, optimize_config)
    return OptimizeCodeResult(raw_result=raw_result, metadata=metadata)


@dataclass(frozen=True)
class GEPAResultMetadata:
    best_candidate: HoneCodeCandidate
    best_idx: int
    candidates: list[HoneCodeCandidate]
    val_aggregate_scores: list[float]
    val_subscores: list[Mapping[str, float]]
    val_aggregate_subscores: list[Mapping[str, float]]
    total_metric_calls: int
    run_dir: str | None
    best_worktree_path: str | None = None
    best_changed_files: list[str] = field(default_factory=list)
    harness_runs: list[Mapping[str, Any]] = field(default_factory=list)

    @property
    def best_commit_sha(self) -> str:
        return self.best_candidate.commit_sha

    def to_dict(self) -> dict[str, Any]:
        return {
            "best_candidate": candidate_to_gepa(self.best_candidate),
            "best_idx": self.best_idx,
            "candidates": [candidate_to_gepa(candidate) for candidate in self.candidates],
            "val_aggregate_scores": list(self.val_aggregate_scores),
            "val_subscores": [dict(scores) for scores in self.val_subscores],
            "val_aggregate_subscores": [
                dict(scores) for scores in self.val_aggregate_subscores
            ],
            "total_metric_calls": self.total_metric_calls,
            "run_dir": self.run_dir,
            "best_commit_sha": self.best_commit_sha,
            "best_worktree_path": self.best_worktree_path,
            "best_changed_files": list(self.best_changed_files),
            "harness_runs": [dict(run) for run in self.harness_runs],
        }


class _candidate_worktree:
    def __init__(
        self,
        *,
        repo_path: Path,
        commit_sha: str,
        root: Path | None,
        prefix: str,
        keep: bool,
    ) -> None:
        self.repo_path = repo_path
        self.commit_sha = commit_sha
        self.root = root
        self.prefix = prefix
        self.keep = keep
        self._tmpdir: tempfile.TemporaryDirectory[str] | None = None
        self.path: Path | None = None

    def __enter__(self) -> Path:
        if self.root is None:
            self._tmpdir = tempfile.TemporaryDirectory(prefix=self.prefix)
            self.path = Path(self._tmpdir.name)
        else:
            self.root.mkdir(parents=True, exist_ok=True)
            self.path = Path(tempfile.mkdtemp(prefix=self.prefix, dir=str(self.root)))
        _git(["worktree", "add", "--detach", str(self.path), self.commit_sha], cwd=self.repo_path)
        return self.path

    def __exit__(self, *exc: object) -> None:
        if self.path is not None and not self.keep:
            _git(["worktree", "remove", "--force", str(self.path)], cwd=self.repo_path)
            if self._tmpdir is not None:
                self._tmpdir.cleanup()
        elif self.path is not None:
            _git(["worktree", "prune"], cwd=self.repo_path, check=False)


def _build_gepa_config(
    config: Mapping[str, Any],
    reflection_lm: Callable[[str], str] | str | None,
) -> Any:
    try:
        api = importlib.import_module("gepa.api")
    except ImportError:
        return config
    engine_config = config.get("engine", {})
    reflection_config = config.get("reflection", {})
    engine = api.GEPAEngineConfig(**engine_config)
    reflection_kwargs = dict(reflection_config)
    if reflection_lm is not None:
        reflection_kwargs["reflection_lm"] = reflection_lm
    reflection = api.ReflectionConfig(**reflection_kwargs) if reflection_kwargs else None
    return api.GEPAConfig(engine=engine, reflection=reflection)


def _attach_custom_candidate_proposer(config: Any, proposer: Callable[..., Mapping[str, str]]) -> None:
    if isinstance(config, dict):
        config.setdefault("reflection", {})["custom_candidate_proposer"] = proposer
        return
    reflection = getattr(config, "reflection", None)
    if reflection is None:
        api = importlib.import_module("gepa.api")
        reflection = api.ReflectionConfig()
        setattr(config, "reflection", reflection)
    setattr(reflection, "custom_candidate_proposer", proposer)


def _example_to_gepa(example: HoneTaskExample) -> dict[str, Any]:
    return {
        "id": example.id,
        "repo_path": str(example.repo_path),
        "base_commit": example.base_commit,
        "test_command": example.test_command,
        "prompt": example.prompt,
        "timeout_seconds": example.timeout_seconds,
        "baseline_seconds": example.baseline_seconds,
    }


def _coerce_example(example: Mapping[str, Any] | HoneTaskExample) -> HoneTaskExample:
    if isinstance(example, HoneTaskExample):
        return example
    return HoneTaskExample(
        id=str(example["id"]),
        repo_path=Path(str(example["repo_path"])),
        base_commit=str(example["base_commit"]),
        test_command=str(example["test_command"]),
        prompt=str(example["prompt"]) if example.get("prompt") is not None else None,
        timeout_seconds=(
            int(example["timeout_seconds"]) if example.get("timeout_seconds") is not None else None
        ),
        baseline_seconds=(
            float(example["baseline_seconds"]) if example.get("baseline_seconds") is not None else None
        ),
    )


def _result_metadata(raw_result: Any, config: OptimizeCodeConfig) -> dict[str, Any]:
    return {
        "optimizer": "gepa-ts optimize_anything",
        "adapter": config.adapter_name,
        "frontier_type": config.frontier_type,
        "max_metric_calls": config.max_metric_calls,
        "total_metric_calls": _result_get(raw_result, "total_metric_calls", 0),
        "best_idx": _result_get(raw_result, "best_idx", None),
        "run_dir": _result_get(raw_result, "run_dir", config.run_dir),
    }


def _instructions_from_reflection(
    *,
    fallback: str,
    reflective_dataset: Mapping[str, Any],
) -> str:
    chunks: list[str] = []
    for key, value in reflective_dataset.items():
        chunks.append(f"[{key}]")
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            chunks.extend(_stringify_reflection_item(item) for item in value)
        else:
            chunks.append(_stringify_reflection_item(value))
    context = "\n".join(chunk for chunk in chunks if chunk)
    if not context.strip():
        return fallback
    return "\n\n".join([
        fallback,
        "GEPA reflective proposal context:",
        context,
    ])


def _stringify_reflection_item(value: Any) -> str:
    if isinstance(value, Mapping):
        priority_keys = ("Feedback", "feedback", "trace", "error", "score")
        parts = [f"{key}: {value[key]}" for key in priority_keys if key in value]
        if parts:
            return "\n".join(parts)
        return "\n".join(f"{key}: {item}" for key, item in value.items())
    return str(value)


def _result_get(raw_result: Any, key: str, default: Any = None) -> Any:
    if isinstance(raw_result, Mapping):
        return raw_result.get(key, default)
    return getattr(raw_result, key, default)


def _run_shell_command(command: str, cwd: Path, timeout_seconds: int | None) -> CommandRun:
    started = time.monotonic()
    try:
        proc = subprocess.run(
            command,
            cwd=str(cwd),
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        return CommandRun(
            exit_code=proc.returncode,
            duration_seconds=time.monotonic() - started,
            stdout=proc.stdout,
            stderr=proc.stderr,
        )
    except subprocess.TimeoutExpired as exc:
        return CommandRun(
            exit_code=-1,
            duration_seconds=time.monotonic() - started,
            stdout=_coerce_output(exc.stdout),
            stderr=_coerce_output(exc.stderr),
            timed_out=True,
        )


def _speed_score(candidate_seconds: float, baseline_seconds: float) -> float:
    if baseline_seconds <= 0:
        return 0.0
    raw = (baseline_seconds - candidate_seconds) / baseline_seconds
    return max(-0.25, min(0.25, raw))


def _changed_files(repo_path: Path, base_commit: str, commit_sha: str) -> list[str]:
    out = _git(
        ["diff", "--name-only", f"{base_commit}..{commit_sha}"],
        cwd=repo_path,
        text=True,
    ).stdout
    return sorted(line for line in out.splitlines() if line.strip())


def _working_tree_changed_files(worktree: Path) -> list[str]:
    out = _git(["status", "--porcelain"], cwd=worktree, text=True).stdout
    changed: list[str] = []
    for line in out.splitlines():
        if len(line) < 4:
            continue
        changed.append(line[3:].strip())
    return sorted(changed)


def _commit_if_changed(worktree: Path, message: str) -> str | None:
    if not _working_tree_changed_files(worktree):
        return None
    _git(["add", "-A"], cwd=worktree)
    _git(["commit", "-q", "-m", message, "--no-verify"], cwd=worktree)
    return _git(["rev-parse", "HEAD"], cwd=worktree, text=True).stdout.strip()


def _harness_prompt(candidate: HoneCodeCandidate, example: HoneTaskExample) -> str:
    parts = [
        "Apply this GEPA-proposed code mutation once.",
        "",
        "Candidate instructions:",
        candidate.instructions,
        "",
        f"Base commit: {candidate.commit_sha}",
        f"Test command: {example.test_command}",
    ]
    if example.prompt:
        parts.extend(["", "Task context:", example.prompt])
    return "\n".join(parts)


def _tail(text: str, *, limit: int = 4000) -> str:
    if len(text) <= limit:
        return text
    return text[-limit:]


def _coerce_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return value


def _git(
    args: Sequence[str],
    *,
    cwd: Path,
    check: bool = True,
    text: bool = False,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=check,
        capture_output=True,
        text=text,
        env=env,
    )


__all__ = [
    "DEFAULT_FRONTIER_TYPE",
    "CandidateRecord",
    "CommandRun",
    "EvaluatorReturn",
    "GEPAResultMetadata",
    "GepaTsOptimizeAnythingRunner",
    "HarnessAdapterConfig",
    "HarnessMutationResult",
    "HarnessMutatorAdapter",
    "HoneCodeCandidate",
    "HoneTaskExample",
    "MetricCallBudget",
    "OptimizeCodeConfig",
    "OptimizeCodeResult",
    "TestCommandEvaluator",
    "candidate_from_gepa",
    "candidate_to_gepa",
    "optimize_code",
]
