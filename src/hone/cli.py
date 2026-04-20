"""hone CLI — typer-based entry point."""
from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel

from hone import __version__
from hone.mutators import resolve as resolve_mutator
from hone.optimizer import optimize

app = typer.Typer(
    name="hone",
    help="Optimize a prompt file against a grader. Uses CLI subscriptions as the mutation engine.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


@app.command()
def version() -> None:
    """Print hone's version."""
    console.print(f"hone {__version__}")


@app.command()
def run(
    prompt_path: Path = typer.Argument(
        ...,
        exists=True,
        readable=True,
        help="Path to the prompt file to optimize.",
    ),
    grader: Path = typer.Option(
        ...,
        "--grader",
        exists=True,
        help="Grader script. Called as `<grader> <prompt-path>`. "
        "Must print a float on stdout's last line.",
    ),
    mutator: str = typer.Option(
        "harness:claude-code:sonnet",
        "--mutator",
        help="Mutator backend. Default routes through the harness library. "
        "Examples: harness:claude-code:sonnet, harness:gemini:gemini-2.5-pro, "
        "anthropic:claude-sonnet-4-6, ./my-mutate.sh",
    ),
    budget: int = typer.Option(
        20,
        "--budget",
        min=1,
        help="Max optimization iterations (GEPA's max_metric_calls).",
    ),
    component: str = typer.Option(
        "instruction",
        "--component",
        help="Component name inside GEPA's candidate dict. Leave default unless you know you need it.",
    ),
    grader_timeout: int = typer.Option(
        3600,
        "--grader-timeout",
        help="Per-grader-call timeout in seconds.",
    ),
    output: Path | None = typer.Option(
        None,
        "--output",
        "-o",
        help="Where to write the best prompt. Defaults to <prompt-path>.honed.md",
    ),
    seed: int = typer.Option(
        0,
        "--seed",
        help="RNG seed passed to GEPA.",
    ),
    progress: bool = typer.Option(
        True,
        "--progress/--no-progress",
        help="Show GEPA's progress bar.",
    ),
) -> None:
    """Optimize `prompt_path` against `grader`, writing the best variant to `--output`."""
    # Load seed prompt
    seed_prompt = prompt_path.read_text(encoding="utf-8")

    # Resolve mutator
    try:
        mutator_instance = resolve_mutator(mutator)
    except Exception as e:
        console.print(f"[red]Failed to resolve mutator {mutator!r}: {e}[/red]")
        raise typer.Exit(code=2) from e

    # Output location
    if output is None:
        output = prompt_path.with_suffix(prompt_path.suffix + ".honed.md")

    console.print(
        Panel.fit(
            f"[bold]prompt[/bold]   {prompt_path}\n"
            f"[bold]grader[/bold]   {grader}\n"
            f"[bold]mutator[/bold]  {mutator_instance}\n"
            f"[bold]budget[/bold]   {budget} iterations\n"
            f"[bold]output[/bold]   {output}",
            title="hone",
        )
    )

    # Run
    result = optimize(
        seed_prompt=seed_prompt,
        grader_path=grader,
        mutator=mutator_instance,
        mutator_spec=mutator,
        prompt_path=prompt_path,
        budget=budget,
        component_name=component,
        grader_timeout_seconds=grader_timeout,
        seed=seed,
        display_progress_bar=progress,
    )

    # Write output
    output.write_text(result.best_prompt, encoding="utf-8")

    console.print()
    console.print(
        Panel.fit(
            f"[bold green]best score[/bold green]         {result.best_score:.4f}\n"
            f"[bold]iterations[/bold]         {result.total_iterations}\n"
            f"[bold]mutator calls[/bold]      {result.mutator_calls} "
            f"([red]{result.mutator_failures} failed[/red])\n"
            f"[bold]mutator tokens[/bold]     in={result.mutator_tokens_in:,}  "
            f"out={result.mutator_tokens_out:,}\n"
            f"[bold]mutator cost[/bold]       ${result.mutator_cost_usd:.4f}\n"
            f"[bold]run dir[/bold]            {result.run_dir}\n\n"
            f"best prompt written to [bold]{output}[/bold]",
            title="done",
        )
    )


if __name__ == "__main__":
    app()
