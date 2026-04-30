"""Resolve a worker spec string to a Worker instance."""
from __future__ import annotations

from hone.workers.base import Worker, WorkerError
from hone.workers.local_worker import LocalWorker


def resolve_worker(
    spec: str | None,
    *,
    mutator,
    worker_budget: int = 1,
    scorer_readonly: bool = True,
) -> Worker:
    """Return a Worker for the given spec.

    Registered specs:
      - None / "local"                  → LocalWorker(mutator)
      - "harness:<adapter>"             → HarnessWorker(adapter, model=None, ...)
      - "harness:<adapter>:<model>"     → HarnessWorker(adapter, model=model, ...)

    Any other spec raises WorkerError.
    """
    if spec is None or spec == "local":
        return LocalWorker(mutator)

    if spec.startswith("harness:"):
        from hone.workers.harness_worker import HarnessWorker

        rest = spec[len("harness:"):]
        if not rest:
            raise WorkerError("harness worker spec requires an adapter: 'harness:<adapter>[:<model>]'")
        # Split on first ":" only so model strings like "openai/gpt-5.4" are kept intact.
        parts = rest.split(":", 1)
        adapter = parts[0]
        model = parts[1] if len(parts) > 1 else None
        return HarnessWorker(
            harness_name=adapter,
            model=model,
            worker_budget=worker_budget,
            scorer_readonly=scorer_readonly,
        )

    raise WorkerError(
        f"unknown worker spec: {spec!r}. "
        "Registered specs: 'local', 'harness:<adapter>[:<model>]'."
    )
