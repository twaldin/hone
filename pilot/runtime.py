from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import select
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
MODEL = "anthropic/claude-sonnet-4-6"
PRICES = {"input": 3.0, "output": 15.0, "cacheRead": 0.30, "cacheWrite": 3.75}
PRICE_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing"
IMAGE = "python@sha256:623674a14ef93d052bb9b0de4dbf5f28eb578a35263838941cc8aa43213c1487"
LIMITS = {"usd": 10.0, "tokens": 12_000_000, "calls": 30_000, "proposer_calls": 500, "active_seconds": 7200}


class BudgetExhausted(Exception):
    def __init__(self, message: str, binding_cap: str | None = None):
        super().__init__(message)
        self.binding_cap = binding_cap


class TransportError(Exception):
    pass


class CallFailed(TransportError):
    pass


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: object) -> str:
    return "sha256:" + hashlib.sha256(canonical(value).encode()).hexdigest()


def append_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        stream.write(canonical(value) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def omp_json(args: list[str], env: dict[str, str] | None = None) -> dict:
    result = subprocess.run(["nice", "-n", "10", "omp", *args], capture_output=True, text=True, timeout=90, env=env)
    if result.returncode:
        raise TransportError("omp command unavailable")
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise TransportError("omp command returned an invalid report")
    return value


def create_pool(path: Path) -> dict:
    accounts = omp_json(["usage", "accounts", "--json", "--no-extensions"])["accounts"]
    allowed = []
    for account in accounts:
        identity = account.get("identityKey")
        if account.get("provider") != "anthropic" or not isinstance(identity, str) or not identity.startswith("email:"):
            continue
        email = identity.removeprefix("email:").split("|", 1)[0]
        if email.rsplit("@", 1)[-1] in {"gmail.com", "purdue.edu"}:
            allowed.append(identity)
    if not allowed:
        raise TransportError("No eligible personal subscription accounts")
    pool = {"*": False, "anthropic": {"accounts": sorted(allowed), "apiKeys": False}}
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        stream.write(canonical(pool) + "\n")
    return pool


def pool_domains(pool: dict) -> dict[str, int]:
    result: dict[str, int] = {}
    for identity in pool["anthropic"]["accounts"]:
        domain = identity.split("|", 1)[0].rsplit("@", 1)[-1]
        result[domain] = result.get(domain, 0) + 1
    return result


def capacity_reason(report: dict, pool: dict, now: float, threshold: float = 0.8) -> str | None:
    if not isinstance(report.get("generatedAt"), (int, float)) or abs(now - report["generatedAt"] / 1000) > 600:
        return "stale-usage"
    for identity in pool["anthropic"]["accounts"]:
        parts = identity.split("|")
        email = parts[0].removeprefix("email:")
        org = next((part.removeprefix("org:") for part in parts[1:] if part.startswith("org:")), None)
        matching = [row for row in report.get("reports", []) if row.get("provider") == "anthropic" and row.get("metadata", {}).get("email") == email and (org is None or row.get("metadata", {}).get("orgId") == org)]
        if len(matching) != 1:
            return "missing-account-usage"
        row = matching[0]
        if abs(now - row.get("fetchedAt", 0) / 1000) > 600 or not row.get("limits"):
            return "stale-account-usage"
        for limit in row["limits"]:
            fraction = limit.get("amount", {}).get("usedFraction")
            if not isinstance(fraction, (int, float)) or not math.isfinite(fraction) or not 0 <= fraction <= 1:
                return "unknown-utilization"
            if fraction > threshold:
                return "high-utilization"
    return None


@dataclass
class Throttle:
    pool: dict
    env: dict[str, str]
    journal: Path
    interval: float = 30
    paused_seconds: float = 0
    accounted_seconds: float = 0
    pauses: int = 0
    reader: Callable[[], dict] | None = None
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.time

    def read(self) -> dict:
        if self.reader is not None:
            return self.reader()
        health = omp_json(["auth-broker", "status", "--json"], self.env)
        if health.get("ok") is not True:
            raise TransportError("Broker unavailable")
        return omp_json(["usage", "--json", "--no-extensions"], self.env)

    def wait(self) -> None:
        started = None
        entered = self.clock()
        while True:
            try:
                reason = capacity_reason(self.read(), self.pool, self.clock())
            except (OSError, ValueError, TransportError, subprocess.TimeoutExpired):
                reason = "broker-or-usage-unavailable"
            if reason is None:
                if started is not None:
                    elapsed = max(0, self.clock() - started)
                    self.paused_seconds += elapsed
                    append_json(self.journal, {"event": "resumed", "at": self.clock(), "seconds": elapsed})
                self.accounted_seconds += max(0, self.clock() - entered)
                return
            if started is None:
                started = self.clock()
                self.pauses += 1
            append_json(self.journal, {"event": "paused", "at": self.clock(), "reason": reason})
            self.sleep(self.interval)


@dataclass
class Ledger:
    journal: Path
    limits: dict = field(default_factory=lambda: dict(LIMITS))
    clock: Callable[[], float] = time.monotonic
    calls: int = 0
    proposer_calls: int = 0
    proposer_success_calls: int = 0
    tokens: int = 0
    usd: float = 0
    hidden_attempts: int = 0
    calls_with_hidden_attempts: int = 0
    retry_log_events: int = 0
    usage_missing: int = 0
    started: float = field(init=False)
    binding_cap: str | None = None

    def __post_init__(self) -> None:
        self.started = self.clock()

    def available(self, paused: float = 0) -> bool:
        values = {"calls": self.calls, "proposer_calls": self.proposer_calls, "tokens": self.tokens, "usd": self.usd,
                  "active_seconds": self.clock() - self.started - paused}
        self.binding_cap = next((key for key, value in values.items() if value >= self.limits[key]), None)
        return self.binding_cap is None

    def admit(self, role: str, messages: list[dict], max_tokens: int, paused: float = 0) -> None:
        if role not in {"task", "proposer", "judge", "repair"} or not 1 <= max_tokens <= 4096:
            raise ValueError("Invalid model request contract")
        input_bound = len(canonical(messages).encode()) + 4096
        reservation = (input_bound * max(PRICES["input"], PRICES["cacheWrite"]) + max_tokens * PRICES["output"]) / 1_000_000
        if not self.available(paused):
            raise BudgetExhausted("Reported-usage cap exhausted", self.binding_cap)
        if self.usd + reservation > self.limits["usd"]:
            self.binding_cap = "usd_reservation"
            raise BudgetExhausted("Reported-usage dollar reservation exhausted", self.binding_cap)
        if self.tokens + input_bound + max_tokens > self.limits["tokens"]:
            self.binding_cap = "token_reservation"
            raise BudgetExhausted("Reported-usage token reservation exhausted", self.binding_cap)

    def settle(self, role: str, request: dict, frame: dict, seconds: float) -> str:
        self.calls += 1
        self.proposer_calls += role in {"proposer", "repair"}
        observation = frame.get("body", {}).get("retryObservation", {})
        hidden = observation.get("hiddenAttempts", 0)
        logs = observation.get("logEvents", 0)
        if not isinstance(hidden, int) or hidden < 0 or not isinstance(logs, int) or logs < 0:
            raise TransportError("Invalid retry observation")
        self.hidden_attempts += hidden
        self.calls_with_hidden_attempts += hidden > 0
        self.retry_log_events += logs
        message = frame.get("body", {}).get("message", {})
        usage = message.get("usage")
        counts = {key: 0 for key in PRICES}
        usage_valid = isinstance(usage, dict) and all(type(usage.get(key)) is int and usage[key] >= 0 for key in PRICES)
        if usage_valid:
            counts = {key: usage[key] for key in PRICES}
        else:
            self.usage_missing += 1
        tokens = sum(counts.values())
        usd = sum(counts[key] * PRICES[key] for key in PRICES) / 1_000_000
        self.tokens += tokens
        self.usd += usd
        text = "".join(block.get("text", "") for block in message.get("content", []) if block.get("type") == "text")
        append_json(self.journal, {"call": self.calls, "role": role, "model": MODEL, "request_hash": digest(request), "response_hash": digest(text), "status": frame.get("status"), "stop_reason": message.get("stopReason"), "reported_usage": counts, "reported_tokens": tokens, "usd_equivalent": usd, "seconds": seconds, "retry_observation": observation, "usage_missing": not usage_valid})
        if frame.get("status") != 200 or message.get("stopReason") not in {"stop", "length"} or not usage_valid:
            raise CallFailed("Provider call failed; consumed reported usage retained")
        self.proposer_success_calls += role in {"proposer", "repair"}
        return text

    def summary(self, throttle: Throttle) -> dict:
        wall = self.clock() - self.started
        rate = self.hidden_attempts / self.calls if self.calls else 0
        result = {"proposer_success_calls": self.proposer_success_calls}
        result.update({"calls": self.calls, "proposer_calls": self.proposer_calls, "tokens": self.tokens, "usd_equivalent": self.usd, "wall_seconds": wall, "active_seconds": max(0, wall - throttle.accounted_seconds), "pauses": throttle.pauses, "pause_seconds": throttle.paused_seconds, "throttle_seconds": throttle.accounted_seconds, "poll_seconds": max(0, throttle.accounted_seconds - throttle.paused_seconds), "binding_cap": self.binding_cap, "hidden_attempts": self.hidden_attempts, "calls_with_hidden_attempts": self.calls_with_hidden_attempts, "hidden_attempt_rate": rate, "retry_log_events": self.retry_log_events, "usage_missing_calls": self.usage_missing, "retry_rate_flag": rate > 0.01})
        return result


class Gateway:
    def __init__(self, env: dict[str, str]):
        omp = shutil.which("omp")
        if omp is None:
            raise TransportError("omp is not installed")
        self.process = subprocess.Popen(["nice", "-n", "10", "taskset", "-c", "0", "bun", str(ROOT / "pilot/gateway.mjs"), os.path.realpath(omp)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env)
        self.ordinal = 0
        try:
            ready = self.read(120)
            if ready.get("ready") is not True or ready.get("version") != "18.16.0":
                raise TransportError("Pilot requires omp 18.16.0")
            self.route_identity = ready.get("routeIdentity")
            if not isinstance(self.route_identity, dict) or self.route_identity.get("oauth_only_session") is not True:
                raise TransportError("Gateway did not establish OAuth-only account restrictions")
        except Exception:
            self.close()
            raise

    def read(self, timeout: float) -> dict:
        stream = self.process.stdout
        if stream is None or not select.select([stream], [], [], timeout)[0]:
            self.close()
            raise TransportError("Model transport timed out")
        line = stream.readline(16 * 1024 * 1024)
        if not line.endswith("\n"):
            raise TransportError("Model transport ended without a complete frame")
        value = json.loads(line)
        if not isinstance(value, dict):
            raise TransportError("Invalid model transport frame")
        return value

    def request(self, body: dict) -> dict:
        self.ordinal += 1
        frame = {"id": self.ordinal, "path": "/v1/pi/stream", "body": body}
        if self.process.stdin is None:
            raise TransportError("Model transport closed")
        self.process.stdin.write(canonical(frame) + "\n")
        self.process.stdin.flush()
        response = self.read(600)
        if response.get("id") != self.ordinal:
            raise TransportError("Model transport response identity mismatch")
        return response

    def close(self) -> None:
        if self.process.stdin is not None and not self.process.stdin.closed:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        finally:
            if self.process.stdout is not None:
                self.process.stdout.close()


def broker_healthy(env: dict[str, str]) -> bool:
    try:
        return omp_json(["auth-broker", "status", "--json"], env).get("ok") is True
    except (OSError, ValueError, TransportError, subprocess.TimeoutExpired):
        return False


def open_gateway(throttle: Throttle) -> Gateway:
    while True:
        throttle.wait()
        try:
            return Gateway(throttle.env)
        except TransportError:
            if broker_healthy(throttle.env):
                raise


class ModelCalls:
    def __init__(self, gateway: Gateway, ledger: Ledger, throttle: Throttle):
        self.gateway, self.ledger, self.throttle = gateway, ledger, throttle

    def __call__(self, role: str, messages: list[dict], max_tokens: int) -> str:
        healthy_failures = 0
        while True:
            self.throttle.wait()
            self.ledger.admit(role, messages, max_tokens, self.throttle.accounted_seconds)
            system = [message["content"] for message in messages if message["role"] == "system"]
            body = {"model": MODEL, "context": {"systemPrompt": system, "messages": [{**message, "timestamp": 0} for message in messages if message["role"] != "system"]}, "options": {"maxTokens": max_tokens, "temperature": 0, "forceReasoningOff": True, "cacheRetention": "none", "preferWebsockets": False}, "stream": False}
            started = time.monotonic()
            try:
                frame = self.gateway.request(body)
            except (OSError, ValueError, TransportError):
                frame = {"status": 599, "body": {}}
            try:
                return self.ledger.settle(role, body, frame, time.monotonic() - started)
            except CallFailed:
                if broker_healthy(self.throttle.env):
                    healthy_failures += 1
                if healthy_failures >= 2:
                    raise
                self.gateway.close()
                self.gateway = open_gateway(self.throttle)

    def close(self) -> None:
        self.gateway.close()


def retry_comparison(summaries: dict[str, dict]) -> dict:
    rates = {method: summary["hidden_attempt_rate"] for method, summary in summaries.items()}
    spread = max(rates.values()) - min(rates.values()) if rates else 0
    return {"rates": rates, "spread": spread, "flagged": spread > 0.01 or any(rate > 0.01 for rate in rates.values()), "limit": "Reported tokens omit internal failed-attempt tokens. Observed HTTP attempts and retry logs measure retry incidence, not omitted token volume. Credential-opaque attempt receipts are required before the full matrix."}
