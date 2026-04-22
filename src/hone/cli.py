"""hone CLI — v1 dir-only repository-state optimizer."""
from __future__ import annotations

import subprocess
from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel

from hone import __version__
from hone.bootstrap import load_run_data, build_reflector_input, parse_config_output, apply_warmed_config, write_config_dir, run_bootstrap
from hone.mutators import resolve as resolve_mutator
from hone.policy import SEED_POLICY
from hone.repo_frontier import optimize_repo_frontier
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


@app.command()
def run(
    dir: Path = typer.Option(
        ..., "--dir",
        exists=True, file_okay=False, dir_okay=True, readable=True,
        help="Source directory to optimize. hone copies it into a managed "
             "workspace — your dir is never touched.",
    ),
    grader: Path = typer.Option(
        ..., "--grader", exists=True,
        help="Grader script. Invoked as `<grader> <workdir>`. "
             "Stdout last line = float score. Stderr = trace.",
    ),
    mutator: str = typer.Option(
        "harness:claude-code:sonnet", "--mutator",
        help="Mutator spec. Only harness-backed supported in v1. "
             "e.g. harness:claude-code:sonnet, harness:opencode:openai/gpt-5.4",
    ),
    budget: int = typer.Option(20, "--budget", min=1, help="Max iterations."),
    grader_timeout: int = typer.Option(3600, "--grader-timeout", min=1),
    output: Path | None = typer.Option(
        None, "--output", "-o",
        help="Write the best candidate's files here at the end. "
             "If omitted, the best state is left in the managed workdir on a tagged branch.",
    ),
    frontier_size: int = typer.Option(4, "--frontier-size", min=1),
    objective: str = typer.Option(
        "Improve the repository so the grader score increases.", "--objective",
        help="One-line objective passed to the mutator each iteration.",
    ),
    policy_dir: Path | None = typer.Option(
        None, "--policy",
        exists=True, file_okay=False, dir_okay=True,
        help="Config dir with playbook.md, prompt-template.md, knobs.json. "
             "If omitted, uses built-in seed policy.",
    ),
) -> None:
    """Optimize a directory against a grader via git-branch frontier search."""
    try:
        mutator_instance = resolve_mutator(mutator)
    except Exception as e:
        console.print(f"[red]Failed to resolve mutator {mutator!r}: {e}[/red]")
        raise typer.Exit(code=2) from e

    from hone.bootstrap import read_config_dir
    policy = SEED_POLICY
    if policy_dir is not None:
        policy = read_config_dir(policy_dir)

    run_dir = new_run_dir()
    console.print(Panel.fit(
        f"[bold]source[/bold]         {dir.resolve()}\n"
        f"[bold]grader[/bold]         {grader.resolve()}\n"
        f"[bold]mutator[/bold]        {mutator_instance}\n"
        f"[bold]budget[/bold]         {budget}\n"
        f"[bold]frontier size[/bold]  {frontier_size}\n"
        f"[bold]run dir[/bold]        {run_dir}",
        title=f"hone v1 ({__version__})",
    ))

    result = optimize_repo_frontier(
        src_dir=dir.resolve(),
        grader_path=grader.resolve(),
        mutator=mutator_instance,
        mutator_spec=mutator,
        budget=budget,
        grader_timeout_seconds=grader_timeout,
        run_dir=run_dir,
        frontier_size=frontier_size,
        objective=objective,
        policy=policy,
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
        f"{output_note}",
        title="done",
    ))


@app.command()
def reflect(
    runs: list[Path] = typer.Option(
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


def main() -> None:
    app()


if __name__ == "__main__":
    main()
