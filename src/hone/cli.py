"""hone CLI — typer-based entry point."""
from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel

from hone import __version__
from hone.kinds import detect_component_kind
from hone.mutators import resolve as resolve_mutator
from hone.optimizer import optimize

app = typer.Typer(
    name="hone",
    help="Optimize a prompt file or directory against a grader.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


@app.command()
def version() -> None:
    console.print(f"hone {__version__}")


@app.command()
def run(
    prompt_path: Path | None = typer.Argument(
        None, exists=True, readable=True,
        help="Single-file mode: path to the component file. Omit when using --dir.",
    ),
    dir: Path | None = typer.Option(
        None, "--dir",
        exists=True, file_okay=False, dir_okay=True, readable=True,
        help="Dir mode: optimize every mutable file in this directory. "
             "Mutually exclusive with PROMPT_PATH.",
    ),
    include_glob: list[str] = typer.Option(
        ["*.py"], "--include-glob",
        help="Globs (relative to --dir). Repeatable. Default: *.py (non-recursive).",
    ),
    exclude_glob: list[str] = typer.Option(
        ["__init__.py", "test_*.py", "*_test.py", "*.honed.md", "*.best.md"],
        "--exclude-glob",
        help="Globs to drop from the include set. Repeatable.",
    ),
    grader: Path = typer.Option(
        ..., "--grader", exists=True,
        help="Grader script. Called as `<grader> <path>` where path is the "
             "prompt file (single-file) or materialized dir (dir-mode).",
    ),
    mutator: str = typer.Option(
        "harness:claude-code:sonnet", "--mutator",
        help="Mutator backend. e.g. harness:claude-code:sonnet, claude-code:sonnet.",
    ),
    observer: str | None = typer.Option(
        None, "--observer",
        help="Enable ACE observer. Spec is the same form as --mutator. Off by default.",
    ),
    observer_interval: int = typer.Option(
        10, "--observer-interval", min=1,
        help="Run observer every N iterations.",
    ),
    observer_window: int = typer.Option(
        20, "--observer-window", min=1,
        help="Number of most-recent mutations.jsonl rows the observer reads.",
    ),
    scheduler: str = typer.Option(
        "round-robin", "--scheduler",
        help="round-robin | diagnose | random. Only meaningful with --dir.",
    ),
    scheduler_config: Path | None = typer.Option(
        None, "--scheduler-config", exists=True, readable=True,
        help="JSON file of diagnose-mode rules.",
    ),
    budget: int = typer.Option(20, "--budget", min=1, help="Max iterations."),
    component: str = typer.Option(
        "instruction", "--component",
        help="Component name (single-file mode).",
    ),
    grader_timeout: int = typer.Option(3600, "--grader-timeout"),
    output: Path | None = typer.Option(None, "--output", "-o"),
    seed: int = typer.Option(0, "--seed"),
    progress: bool = typer.Option(True, "--progress/--no-progress"),
) -> None:
    """Optimize a file or directory against a grader."""
    # --- validation ---
    if (prompt_path is None) == (dir is None):
        console.print("[red]Provide exactly one of PROMPT_PATH or --dir.[/red]")
        raise typer.Exit(code=2)
    if dir is None and scheduler != "round-robin":
        console.print("[red]--scheduler only makes sense with --dir.[/red]")
        raise typer.Exit(code=2)
    if scheduler == "diagnose" and scheduler_config is None:
        console.print("[red]--scheduler diagnose requires --scheduler-config PATH.[/red]")
        raise typer.Exit(code=2)

    try:
        mutator_instance = resolve_mutator(mutator)
    except Exception as e:
        console.print(f"[red]Failed to resolve mutator {mutator!r}: {e}[/red]")
        raise typer.Exit(code=2) from e

    # ----- DIR MODE -----
    if dir is not None:
        from hone.dir_target import DirTarget
        from hone.observer import Observer
        from hone.optimizer import optimize_dir
        from hone.scheduler import build_scheduler

        dir_target = DirTarget(
            root=dir.resolve(),
            include_globs=include_glob,
            exclude_globs=exclude_glob,
        )
        mutable = dir_target.mutable_files()
        if not mutable:
            console.print(f"[red]No mutable files found under {dir} with globs {include_glob}[/red]")
            raise typer.Exit(code=2)

        sched = build_scheduler(scheduler, scheduler_config)
        obs = None
        if observer is not None:
            obs = Observer(
                mutator_spec=observer,
                interval=observer_interval,
                window=observer_window,
            )

        console.print(Panel.fit(
            f"[bold]mode[/bold]      dir\n"
            f"[bold]dir[/bold]       {dir_target.root}\n"
            f"[bold]files[/bold]     {', '.join(str(f) for f in mutable)}\n"
            f"[bold]grader[/bold]    {grader}\n"
            f"[bold]mutator[/bold]   {mutator_instance}\n"
            f"[bold]scheduler[/bold] {scheduler}\n"
            f"[bold]observer[/bold]  {observer or 'off'}"
            + (f" (every {observer_interval})" if observer else "") + "\n"
            f"[bold]budget[/bold]    {budget}",
            title="hone (dir mode)",
        ))

        result = optimize_dir(
            dir_target=dir_target,
            grader_path=grader,
            mutator=mutator_instance,
            mutator_spec=mutator,
            scheduler=sched,
            observer=obs,
            budget=budget,
            grader_timeout_seconds=grader_timeout,
            seed=seed,
            display_progress_bar=progress,
        )
        # Output is the best snapshot written back to disk
        if output is None:
            output = dir.parent / f"{dir.name}.honed"
        output.mkdir(parents=True, exist_ok=True)
        if result.best_snapshot is not None:
            result.best_snapshot.materialize(output)

        console.print()
        console.print(Panel.fit(
            f"[bold green]best score[/bold green]       {result.best_score:.4f}\n"
            f"[bold]iterations[/bold]       {result.total_iterations}\n"
            f"[bold]mutator calls[/bold]    {result.mutator_calls} "
            f"([red]{result.mutator_failures} failed[/red])\n"
            f"[bold]mutator tokens[/bold]   in={result.mutator_tokens_in:,}  "
            f"out={result.mutator_tokens_out:,}\n"
            f"[bold]mutator cost[/bold]     ${result.mutator_cost_usd:.4f}\n"
            f"[bold]run dir[/bold]          {result.run_dir}\n"
            f"[bold]best dir written[/bold] {output}",
            title="done",
        ))
        return

    # ----- SINGLE-FILE MODE (unchanged) -----
    seed_prompt = prompt_path.read_text(encoding="utf-8")
    kind = detect_component_kind(prompt_path)
    console.print(f"[hone] component kind: {kind}")
    if output is None:
        output = prompt_path.with_suffix(prompt_path.suffix + ".honed.md")
    console.print(Panel.fit(
        f"[bold]component[/bold] {prompt_path} ({kind})\n"
        f"[bold]grader[/bold]    {grader}\n"
        f"[bold]mutator[/bold]   {mutator_instance}\n"
        f"[bold]budget[/bold]    {budget}\n"
        f"[bold]output[/bold]    {output}",
        title="hone",
    ))
    result = optimize(
        seed_prompt=seed_prompt,
        grader_path=grader,
        mutator=mutator_instance,
        mutator_spec=mutator,
        prompt_path=prompt_path,
        budget=budget,
        component_name=component,
        component_kind=kind,
        grader_timeout_seconds=grader_timeout,
        seed=seed,
        display_progress_bar=progress,
    )
    output.write_text(result.best_prompt, encoding="utf-8")
    console.print()
    console.print(Panel.fit(
        f"[bold green]best score[/bold green]       {result.best_score:.4f}\n"
        f"[bold]iterations[/bold]       {result.total_iterations}\n"
        f"[bold]mutator calls[/bold]    {result.mutator_calls} "
        f"([red]{result.mutator_failures} failed[/red])\n"
        f"[bold]mutator tokens[/bold]   in={result.mutator_tokens_in:,}  "
        f"out={result.mutator_tokens_out:,}\n"
        f"[bold]mutator cost[/bold]     ${result.mutator_cost_usd:.4f}\n"
        f"[bold]run dir[/bold]          {result.run_dir}\n"
        f"best prompt written to [bold]{output}[/bold]",
        title="done",
    ))


if __name__ == "__main__":
    app()
