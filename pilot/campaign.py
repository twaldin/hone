from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import os
from pathlib import Path

from .runtime import append_json

MATRIX = tuple((seed, task, method) for seed in (1, 2) for task in ("mbpp", "hover")
               for method in ("hone", "gepa", "plain"))
FORECASTS = {("mbpp", "hone"): 3434, ("mbpp", "gepa"): 2704,
             ("mbpp", "plain"): 3316, ("hover", "hone"): 2453,
             ("hover", "gepa"): 2669, ("hover", "plain"): 2143}


class CampaignStop(RuntimeError):
    def __init__(self, receipt: dict):
        self.receipt = receipt
        super().__init__(receipt["reason"])


class CampaignGuard:
    def __init__(self, root: Path, *, cap: int = 35000, disk_floor: int = 100_000_000_000):
        self.root = Path(root)
        self.cap, self.disk_floor = cap, disk_floor
        self.actual = 0
        self.forecasts = dict(FORECASTS)
        self.completed = 0
        self.current = None
        self.stopped = None

    def stop(self, reason: str, **numbers):
        receipt = {"reason": reason, "actual": self.actual, "cap": self.cap, **numbers}
        self.stopped = receipt
        append_json(self.root / "campaign-journal.jsonl", {"event": "stop", **receipt})
        raise CampaignStop(receipt)

    def check_disk(self):
        path = self.root
        while not path.exists():
            path = path.parent
        stat = os.statvfs(path)
        available = stat.f_bavail * stat.f_frsize
        if available < self.disk_floor:
            self.stop("disk-floor", disk_observed=available, disk_floor=self.disk_floor)
        return available

    def before_cell(self, cell):
        if self.stopped is not None:
            raise CampaignStop(self.stopped)
        if self.current is not None or self.completed >= len(MATRIX) or tuple(cell) != MATRIX[self.completed]:
            raise ValueError("Fresh full matrix must run once in declared serial order")
        self.check_disk()
        remaining = sum(self.forecasts[task, method] for _, task, method in MATRIX[self.completed:])
        projected = self.actual + remaining
        if projected > self.cap:
            self.stop("completion-projection", remaining=remaining, projected=projected)
        self.current = tuple(cell)
        append_json(self.root / "campaign-journal.jsonl", {"event": "cell-start", "cell": cell,
                    "actual": self.actual, "remaining": remaining, "projected": projected, "cap": self.cap})

    def before_model_call(self, ledger):
        if self.stopped is not None:
            raise CampaignStop(self.stopped)
        self.check_disk()
        if self.actual >= self.cap:
            self.stop("campaign-call-cap", remaining=0, projected=self.actual + 1)
        append_json(self.root / "campaign-journal.jsonl", {"event": "model-dispatch", "ordinal": self.actual + 1,
                    "cell": self.current, "ledger": str(ledger.journal), "ledger_calls_before": ledger.calls})
        self.actual += 1

    def finish_cell(self, row: dict):
        cell = (row["seed"], row["task"], row["method"])
        if cell != self.current:
            raise ValueError("Cell result does not match active campaign cell")
        if row["status"] == "completed":
            key = cell[1:]
            self.forecasts[key] = max(self.forecasts[key], row["calls"])
        append_json(self.root / "campaign-journal.jsonl", {"event": "cell-end", "cell": cell,
                    "status": row["status"], "actual": self.actual, "calls": row["calls"]})
        self.completed += 1
        self.current = None


_ACTIVE: ContextVar[CampaignGuard | None] = ContextVar("pilot_campaign", default=None)


@contextmanager
def campaign_scope(guard: CampaignGuard):
    token = _ACTIVE.set(guard)
    try:
        yield guard
    finally:
        _ACTIVE.reset(token)


def before_model_call(ledger):
    guard = _ACTIVE.get()
    if guard is not None:
        guard.before_model_call(ledger)


def check_disk():
    guard = _ACTIVE.get()
    if guard is not None:
        return guard.check_disk()
