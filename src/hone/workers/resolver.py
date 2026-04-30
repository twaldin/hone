"""Resolve a worker spec string to a Worker instance."""
from __future__ import annotations

from hone.workers.base import Worker, WorkerError
from hone.workers.local_worker import LocalWorker


def resolve_worker(spec: str | None, *, mutator) -> Worker:
    """Return a Worker for the given spec.

    Registered specs:
      - None / "local" → LocalWorker(mutator)

    harness-worker-mode registers "harness" via its own import.
    Any other spec raises WorkerError.
    """
    if spec is None or spec == "local":
        return LocalWorker(mutator)
    raise WorkerError(
        f"unknown worker spec: {spec!r}. Registered specs: 'local'. "
        "The 'harness' spec is registered by harness-worker-mode."
    )
