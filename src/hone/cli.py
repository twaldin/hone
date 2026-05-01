"""hone CLI — v1 dir-only repository-state optimizer."""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import List, Optional

import typer
from rich.console import Console
from rich.panel import Panel

from hone import __version__
from hone.bootstrap import load_run_data, run_bootstrap
from hone.config import HoneConfig, load_config, save_config
from hone.gates import GateSpec
from hone.mutators import resolve as resolve_mutator
from hone.policy import SEED_POLICY
from hone.repo_frontier import optimize_repo_frontier
from hone.report import generate_report, write_report
from hone.storage import new_run_dir

app = typer.Typer(
    name="hone",
    help="Repository-state optimizer. Frontier search over git branches.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


@app.command()
def version() -> None:
    console.print(f"hone {__version__}")


def _parse_gate(s: str) -> GateSpec:
    if "=" in s:
        name, _, command = s.partition("=")
    elif ":" in s:
        name, _, command = s.partition(":")
    else:
        raise ValueError(f"Gate spec must be 'name=command' or 'name:command', got: {s!r}")
    return GateSpec(name=name.strip(), command=command.strip())


def _run_optimize(
    cfg: HoneConfig,
    *,
    output: Path | None,
    resume: Path | None,
) -> None:
    try:
        mutator_instance = resolve_mutator(cfg.mutator)
    except Exception as e:
        console.print(f"[red]Failed to resolve mutator {cfg.mutator!r}: {e}[/red]")
        raise typer.Exit(code=2) from e

    ace_mutator_instance = None
    if cfg.ace_interval > 0 and cfg.ace_model:
        try:
            ace_mutator_instance = resolve_mutator(cfg.ace_model)
        except Exception as e:
            console.print(f"[red]Failed to resolve ACE model {cfg.ace_model!r}: {e}[/red]")
            raise typer.Exit(code=2) from e

    from hone.bootstrap import read_config_dir
    policy = SEED_POLICY
    if cfg.policy_dir is not None:
        policy = read_config_dir(Path(cfg.policy_dir))

    gates = (
        [GateSpec(name=g["name"], command=g["command"]) for g in cfg.gates]
        if cfg.gates
        else []
    )

    if resume is not None:
        run_dir = resume.resolve()
        resume_mode = True
    else:
        run_dir = new_run_dir()
        resume_mode = False

    stall_val = cfg.stall if cfg.stall and cfg.stall > 0 else None

    ace_info = (
        f"\n[bold]ACE interval[/bold]  {cfg.ace_interval}"
        + (
            f"\n[bold]ACE model[/bold]      {ace_mutator_instance}"
            if ace_mutator_instance
            else ""
        )
        if cfg.ace_interval > 0
        else ""
    )
    resume_badge = "\n[bold yellow]resume[/bold yellow]         ON" if resume_mode else ""
    console.print(Panel.fit(
        f"[bold]source[/bold]         {Path(cfg.src_dir).resolve()}\n"
        f"[bold]scorer[/bold]         {cfg.scorer}\n"
        f"[bold]mutator[/bold]        {mutator_instance}\n"
        f"[bold]budget[/bold]         {cfg.budget}\n"
        f"[bold]frontier size[/bold]  {cfg.frontier_size}\n"
        f"[bold]run dir[/bold]        {run_dir}"
        f"{ace_info}"
        f"{resume_badge}",
        title=f"hone v1 ({__version__})",
    ))

    result = optimize_repo_frontier(
        src_dir=Path(cfg.src_dir).resolve(),
        grader_path=Path(cfg.scorer),
        mutator=mutator_instance,
        mutator_spec=cfg.mutator,
        budget=cfg.budget,
        grader_timeout_seconds=cfg.scorer_timeout,
        run_dir=run_dir,
        frontier_size=cfg.frontier_size,
        objective=cfg.objective,
        policy=policy,
        ace_interval=cfg.ace_interval,
        ace_mutator=ace_mutator_instance,
        resume=resume_mode,
        metric_direction=cfg.metric_direction,
        stall=stall_val,
        gates=gates or None,
    )

    output_note = ""
    if output is not None:
        output.mkdir(parents=True, exist_ok=True)
        archive = subprocess.run(
            ["git", "archive", "--format=tar", result.best_sha],
            cwd=result.run_dir / "workdir",
            check=True, capture_output=True,
        )
        subprocess.run(
            ["tar", "-xf", "-", "-C", str(output)],
            input=archive.stdout, check=True,
        )
        output_note = f"\n[bold]output written[/bold] {output}"

    stall_note = ""
    if stall_val is not None and result.total_iterations < cfg.budget:
        stall_note = f"\n[yellow]stalled after {result.total_iterations} iters[/yellow]"

    console.print()
    console.print(Panel.fit(
        f"[bold green]best score[/bold green]      {result.best_score:.4f}\n"
        f"[bold]best sha[/bold]         {result.best_sha[:12]}\n"
        f"[bold]iterations[/bold]       {result.total_iterations}\n"
        f"[bold]mutator calls[/bold]    {result.mutator_calls} "
        f"([red]{result.mutator_failures} failed[/red])\n"
        f"[bold]mutator tokens[/bold]   in={result.mutator_tokens_in:,}  "
        f"out={result.mutator_tokens_out:,}\n"
        f"[bold]mutator cost[/bold]     ${result.mutator_cost_usd:.4f}\n"
        f"[bold]run dir[/bold]          {result.run_dir}"
        f"{output_note}"
        f"{stall_note}",
        title="done",
    ))


@app.command()
def discover(
    src: Path = typer.Option(
        ..., "--src",
        exists=True, file_okay=False, dir_okay=True, readable=True,
        help="Source directory to inspect for discovery.",
    ),
    suggest: Path = typer.Option(
        ..., "--suggest",
        help="Output directory for suggested benchmark skeleton artifacts.",
    ),
    strict: bool = typer.Option(
        False, "--strict",
        help="Exit non-zero until discover is implemented.",
    ),
) -> None:
    """Stub for benchmark discovery workflow design surface."""
    console.print(
        "[yellow]hone discover is not yet implemented.[/yellow] "
        "Planned surface: hone discover --src <dir> --suggest <out_dir>."
    )
    raise typer.Exit(code=2 if strict else 0)


@app.command()
def run(
    dir: Path = typer.Option(
        ..., "--dir",
        exists=True, file_okay=False, dir_okay=True, readable=True,
        help="Source directory to optimize. hone copies it into a managed "
             "workspace — your dir is never touched.",
    ),
    scorer: Optional[Path] = typer.Option(
        None, "--scorer",
        help="Scorer script. Invoked as `<scorer> <workdir>`. "
             "Stdout last line = float score. Stderr = trace.",
    ),
    grader: Optional[Path] = typer.Option(
        None, "--grader",
        help="[Deprecated] Alias for --scorer.",
    ),
    mutator: str = typer.Option(
        "harness:claude-code:sonnet", "--mutator",
        help="Mutator spec. e.g. harness:claude-code:sonnet",
    ),
    budget: int = typer.Option(20, "--budget", min=1, help="Max iterations."),
    grader_timeout: int = typer.Option(3600, "--scorer-timeout", "--grader-timeout", min=1),
    output: Optional[Path] = typer.Option(
        None, "--output", "-o",
        help="Write the best candidate's files here at the end.",
    ),
    frontier_size: int = typer.Option(4, "--frontier-size", min=1),
    objective: str = typer.Option(
        "Improve the repository so the scorer score increases.", "--objective",
        help="One-line objective passed to the mutator each iteration.",
    ),
    policy_dir: Optional[Path] = typer.Option(
        None, "--policy",
        exists=True, file_okay=False, dir_okay=True,
        help="Config dir with playbook.md, prompt-template.md, knobs.json.",
    ),
    ace_interval: int = typer.Option(
        0, "--ace-interval", min=0,
        help="ACE outer loop: reflect and evolve config every N iterations. 0 = disabled.",
    ),
    ace_model: str = typer.Option(
        "", "--ace-model",
        help="ACE reflector model spec.",
    ),
    resume: Optional[Path] = typer.Option(
        None, "--resume",
        exists=True, file_okay=False, dir_okay=True,
        help="Resume an interrupted run.",
    ),
    stall: Optional[int] = typer.Option(
        None, "--stall",
        help="Stop after N consecutive iterations with no best-score improvement. 0 = disabled.",
    ),
    metric_direction: str = typer.Option(
        "max", "--metric",
        help="Optimization direction: 'max' or 'min'.",
    ),
    gate: Optional[List[str]] = typer.Option(
        None, "--gate",
        help="Gate spec in 'name=command' or 'name:command' format. Repeatable.",
    ),
) -> None:
    """Optimize a directory against a scorer via git-branch frontier search."""
    if scorer is not None:
        effective_scorer = scorer
    elif grader is not None:
        typer.echo("Warning: --grader is deprecated, use --scorer instead", err=True)
        effective_scorer = grader
    else:
        console.print("[red]Either --scorer or --grader is required[/red]")
        raise typer.Exit(code=2)

    if metric_direction not in ("max", "min"):
        console.print(f"[red]--metric must be 'max' or 'min', got {metric_direction!r}[/red]")
        raise typer.Exit(code=2)

    gate_list = gate or []
    try:
        gate_specs = [_parse_gate(g) for g in gate_list]
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(code=2) from e

    cfg = HoneConfig(
        src_dir=str(dir.resolve()),
        scorer=str(effective_scorer),
        mutator=mutator,
        budget=budget,
        scorer_timeout=grader_timeout,
        frontier_size=frontier_size,
        objective=objective,
        metric_direction=metric_direction,
        stall=stall,
        gates=[{"name": g.name, "command": g.command} for g in gate_specs],
        ace_interval=ace_interval,
        ace_model=ace_model,
        policy_dir=str(policy_dir) if policy_dir is not None else None,
    )
    _run_optimize(cfg, output=output, resume=resume)


@app.command()
def init(
    src_dir: str = typer.Option(..., "--src-dir", help="Source directory to optimize."),
    scorer: str = typer.Option(..., "--scorer", help="Scorer script path."),
    to: Path = typer.Option(Path("hone.toml"), "--to", help="Output path for hone.toml."),
    force: bool = typer.Option(False, "--force", help="Overwrite existing hone.toml."),
    mutator: str = typer.Option("harness:claude-code:sonnet", "--mutator"),
    budget: int = typer.Option(20, "--budget"),
    scorer_timeout: int = typer.Option(3600, "--scorer-timeout"),
    frontier_size: int = typer.Option(4, "--frontier-size"),
    objective: str = typer.Option(
        "Improve the repository so the scorer score increases.", "--objective"
    ),
    metric_direction: str = typer.Option("max", "--metric"),
    stall: Optional[int] = typer.Option(None, "--stall"),
    ace_interval: int = typer.Option(0, "--ace-interval"),
    ace_model: str = typer.Option("", "--ace-model"),
    policy_dir: Optional[str] = typer.Option(None, "--policy"),
    gate: Optional[List[str]] = typer.Option(None, "--gate"),
) -> None:
    """Write hone.toml in cwd (or --to path)."""
    if to.exists() and not force:
        console.print(f"[red]{to} already exists. Use --force to overwrite.[/red]")
        raise typer.Exit(code=1)

    if metric_direction not in ("max", "min"):
        console.print(f"[red]--metric must be 'max' or 'min', got {metric_direction!r}[/red]")
        raise typer.Exit(code=2)

    gate_list = gate or []
    try:
        gate_specs = [_parse_gate(g) for g in gate_list]
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(code=2) from e

    cfg = HoneConfig(
        src_dir=src_dir,
        scorer=scorer,
        mutator=mutator,
        budget=budget,
        scorer_timeout=scorer_timeout,
        frontier_size=frontier_size,
        objective=objective,
        metric_direction=metric_direction,
        stall=stall,
        gates=[{"name": g.name, "command": g.command} for g in gate_specs],
        ace_interval=ace_interval,
        ace_model=ace_model,
        policy_dir=policy_dir,
    )
    save_config(cfg, to)
    console.print(f"[green]Wrote {to}[/green]")


@app.command()
def optimize(
    config: Path = typer.Option(Path("hone.toml"), "--config", "-c", help="Path to hone.toml."),
    output: Optional[Path] = typer.Option(None, "--output", "-o"),
    resume: Optional[Path] = typer.Option(
        None, "--resume",
        exists=True, file_okay=False, dir_okay=True,
    ),
) -> None:
    """Run hone using settings from hone.toml."""
    try:
        cfg = load_config(config)
    except (FileNotFoundError, ValueError) as e:
        console.print(f"[red]Failed to load config {config}: {e}[/red]")
        raise typer.Exit(code=2) from e
    _run_optimize(cfg, output=output, resume=resume)



@app.command()
def reflect(
    runs: List[Path] = typer.Option(
        ..., "--runs",
        exists=True, file_okay=False, dir_okay=True,
        help="Hone run directories to analyze (each should contain mutations.jsonl).",
    ),
    model: str = typer.Option(
        "harness:claude-code:sonnet", "--model",
        help="LLM spec for the Reflector call.",
    ),
    output: Path = typer.Option(
        ..., "--output", "-o",
        help="Write warmed config to this directory.",
    ),
    detail_window: int = typer.Option(
        20, "--detail-window", min=5,
        help="Number of recent mutations to include per run.",
    ),
) -> None:
    """Reflect on past run data to produce a warmed-start mutator config."""
    try:
        mutator_instance = resolve_mutator(model)
    except Exception as e:
        console.print(f"[red]Failed to resolve model {model!r}: {e}[/red]")
        raise typer.Exit(code=2) from e

    run_data = load_run_data(runs)
    total_mutations = sum(r.total_mutations for r in run_data)
    console.print(Panel.fit(
        f"[bold]runs[/bold]            {len(run_data)}\n"
        f"[bold]total mutations[/bold] {total_mutations}\n"
        f"[bold]improvements[/bold]    {sum(r.improvements for r in run_data)}\n"
        f"[bold]regressions[/bold]     {sum(r.regressions for r in run_data)}\n"
        f"[bold]reflector model[/bold] {mutator_instance}\n"
        f"[bold]output[/bold]          {output.resolve()}",
        title=f"hone reflect ({__version__})",
    ))

    warmed = run_bootstrap(
        run_dirs=runs,
        model_spec=model,
        output_dir=output,
        detail_window=detail_window,
    )

    console.print()
    console.print(f"[green]Warmed config written to {output.resolve()}[/green]")
    console.print(f"  playbook.md:       {len(warmed.playbook_text)} chars")
    console.print(f"  prompt-template.md: {len(warmed.prompt_template)} chars")
    console.print(f"  knobs.json:        {warmed.knobs}")


@app.command()
def report(
    run: Path = typer.Option(
        ..., "--run",
        exists=True, file_okay=False, dir_okay=True, readable=True,
        help="Run directory (contains run.json and mutations.jsonl).",
    ),
    output: Path | None = typer.Option(
        None, "--output", "-o",
        help="Output markdown path (defaults to <run>/report.md).",
    ),
    stdout: bool = typer.Option(
        False, "--stdout",
        help="Print report markdown to stdout instead of writing a file.",
    ),
) -> None:
    """Generate a static markdown report from a hone run directory."""
    if stdout:
        print(generate_report(run), end="")
        return

    destination = output or (run / "report.md")
    written = write_report(run, destination)
    console.print(f"[green]Report written to {written}[/green]")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
