"""Scheduler — picks the next mutation target given run history."""
from __future__ import annotations

import itertools
import json
import random
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass
class HistoryRow:
    """One row from mutations.jsonl, deserialized."""
    iter: int
    target: Path
    parent_iter: int | None
    score: float
    fail_class: str | None
    grader_stdout_rollouts: list[dict]
    diff_summary: str


class Scheduler(ABC):
    @abstractmethod
    def pick_next_target(
        self,
        candidates: list[Path],
        history: list[HistoryRow],
    ) -> Path: ...


class RoundRobinScheduler(Scheduler):
    def __init__(self) -> None:
        self._cycle = None

    def pick_next_target(self, candidates, history):
        if self._cycle is None:
            self._cycle = itertools.cycle(sorted(candidates))
        return next(self._cycle)


class RandomScheduler(Scheduler):
    def __init__(self, seed: int = 0) -> None:
        self._rng = random.Random(seed)

    def pick_next_target(self, candidates, history):
        return self._rng.choice(sorted(candidates))


@dataclass
class DiagnoseRule:
    field: str
    predicate: str   # "when_equals" | "when_gt" | "when_lt" | "when_eq"
    value: object
    target: str


class DiagnoseScheduler(Scheduler):
    def __init__(self, rules: list[DiagnoseRule], fallback: Scheduler) -> None:
        self.rules = rules
        self.fallback = fallback

    def pick_next_target(self, candidates, history):
        if not history:
            return self.fallback.pick_next_target(candidates, history)
        last = history[-1]
        counts: dict[str, int] = {}
        for rollout in last.grader_stdout_rollouts:
            for rule in self.rules:
                if _rule_fires(rule, rollout):
                    counts[rule.target] = counts.get(rule.target, 0) + 1
                    break
        if not counts:
            return self.fallback.pick_next_target(candidates, history)
        winner = max(counts.items(), key=lambda kv: kv[1])[0]
        target_path = Path(winner)
        if target_path not in candidates:
            return self.fallback.pick_next_target(candidates, history)
        return target_path


def _rule_fires(rule: DiagnoseRule, rollout: dict) -> bool:
    v = rollout.get(rule.field)
    if v is None:
        return False
    if rule.predicate == "when_equals": return v == rule.value
    if rule.predicate == "when_gt":     return v > rule.value
    if rule.predicate == "when_lt":     return v < rule.value
    if rule.predicate == "when_eq":     return v == rule.value
    return False


def build_scheduler(spec: str, config_path: Path | None) -> Scheduler:
    if spec == "round-robin": return RoundRobinScheduler()
    if spec == "random":      return RandomScheduler()
    if spec == "diagnose":
        data = json.loads(config_path.read_text())
        rules = []
        for r in data["rules"]:
            pred = next(k for k in r if k.startswith("when_"))
            rules.append(DiagnoseRule(
                field=r["field"],
                predicate=pred,
                value=r[pred],
                target=r["target"],
            ))
        return DiagnoseScheduler(rules=rules, fallback=RoundRobinScheduler())
    raise ValueError(f"unknown scheduler: {spec}")
