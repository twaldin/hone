from io import StringIO
from types import SimpleNamespace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot.runtime import BudgetExhausted, CallFailed, Gateway, Ledger, LIMITS, ModelCalls, Throttle, TransportError, capacity_reason, create_pool, open_gateway, retry_comparison

POOL = {"*": False, "anthropic": {"accounts": ["email:pilot@example.org|org:personal"], "apiKeys": False}}


def usage(fraction=0.1):
    return {"generatedAt": 1_000_000, "reports": [{"provider": "anthropic", "fetchedAt": 1_000_000, "metadata": {"email": "pilot@example.org", "orgId": "personal"}, "limits": [{"amount": {"usedFraction": fraction}}]}]}


def response(tokens=None, hidden=0):
    counts = tokens or {"input": 100, "output": 20, "cacheRead": 30, "cacheWrite": 40}
    return {"status": 200, "body": {"message": {"usage": counts, "content": [{"type": "text", "text": "answer"}], "stopReason": "stop"}, "retryObservation": {"hiddenAttempts": hidden, "logEvents": hidden}}}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)

    def test_every_role_prices_all_token_categories_and_preserves_failures(self):
        ledger = Ledger(self.path / "calls")
        for role in ("task", "proposer", "judge", "repair"):
            ledger.admit(role, [{"role": "user", "content": "x"}], 32)
            self.assertEqual(ledger.settle(role, {}, response(), 1), "answer")
        self.assertEqual(ledger.calls, 4)
        self.assertEqual(ledger.tokens, 760)
        self.assertAlmostEqual(ledger.usd, 4 * (300 + 300 + 9 + 150) / 1_000_000)
        failed = response(hidden=2)
        failed["status"] = 502
        with self.assertRaises(TransportError):
            ledger.settle("task", {}, failed, 2)
        self.assertEqual(ledger.calls, 5)
        self.assertEqual(ledger.tokens, 950)
        self.assertEqual(ledger.hidden_attempts, 2)
        rows = [json.loads(line) for line in (self.path / "calls").read_text().splitlines()]
        self.assertEqual(rows[-1]["status"], 502)
        self.assertEqual(rows[-1]["reported_tokens"], 190)

    def test_budget_reserves_before_call_and_stops_at_each_cap(self):
        for key, value in (("usd", 0.000001), ("tokens", 1), ("calls", 0), ("proposer_calls", 0), ("active_seconds", 0)):
            limits = dict(LIMITS, **{key: value})
            ledger = Ledger(self.path / key, limits=limits)
            with self.assertRaises(BudgetExhausted, msg=key):
                ledger.admit("proposer", [{"role": "user", "content": "x"}], 32)
            self.assertEqual(ledger.calls, 0)

    def test_missing_usage_is_counted_and_not_a_success(self):
        ledger = Ledger(self.path / "missing")
        frame = response()
        del frame["body"]["message"]["usage"]
        with self.assertRaises(TransportError):
            ledger.settle("task", {}, frame, 1)
        self.assertEqual(ledger.usage_missing, 1)
        self.assertEqual(ledger.calls, 1)

    def test_throttle_waits_through_high_usage_and_outage(self):
        readings = iter([usage(0.99), TransportError("outage"), usage(0.1)])
        now = [1000.0]
        sleeps = []
        def read():
            value = next(readings)
            if isinstance(value, Exception):
                raise value
            return value
        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds
        throttle = Throttle(POOL, {}, self.path / "pauses", interval=5, reader=read, clock=lambda: now[0], sleep=sleep)
        throttle.wait()
        self.assertEqual(sleeps, [5, 5])
        self.assertEqual(throttle.pauses, 1)
        self.assertEqual(throttle.paused_seconds, 10)
        reasons = [json.loads(line).get("reason") for line in (self.path / "pauses").read_text().splitlines()]
        self.assertEqual(reasons, ["high-utilization", "broker-or-usage-unavailable", None])

    def test_missing_stale_and_wrong_org_usage_pause(self):
        self.assertIsNone(capacity_reason(usage(0.8), POOL, 1000))
        self.assertEqual(capacity_reason(usage(0.81), POOL, 1000), "high-utilization")
        self.assertEqual(capacity_reason(usage(), POOL, 2000), "stale-usage")
        wrong = usage()
        wrong["reports"][0]["metadata"]["orgId"] = "work"
        self.assertEqual(capacity_reason(wrong, POOL, 1000), "missing-account-usage")
        missing = usage()
        missing["reports"][0]["limits"][0]["amount"] = {}
        self.assertEqual(capacity_reason(missing, POOL, 1000), "unknown-utilization")

    def test_retry_flags_use_strict_one_percent_boundary(self):
        def summaries(*rates):
            return {str(index): {"hidden_attempt_rate": rate} for index, rate in enumerate(rates)}
        self.assertFalse(retry_comparison(summaries(0, 0.01))["flagged"])
        self.assertTrue(retry_comparison(summaries(0, 0.0101))["flagged"])
        self.assertTrue(retry_comparison(summaries(0.02, 0.02))["flagged"])

    def test_pool_denies_work_accounts_and_all_api_keys(self):
        accounts = {"accounts": [{"provider": "anthropic", "identityKey": "email:a@gmail.com|org:personal"}, {"provider": "anthropic", "identityKey": "email:b@lindy.ai|org:work"}, {"provider": "anthropic", "identityKey": None}, {"provider": "openai-codex", "identityKey": "email:a@gmail.com"}]}
        with patch("pilot.runtime.omp_json", return_value=accounts):
            pool = create_pool(self.path / "pool.json")
        self.assertEqual(pool, {"*": False, "anthropic": {"accounts": ["email:a@gmail.com|org:personal"], "apiKeys": False}})
        self.assertEqual((self.path / "pool.json").stat().st_mode & 0o777, 0o600)

    def test_broker_move_reconnects_even_when_new_health_is_already_good(self):
        class Endpoint:
            def __init__(self, fail):
                self.fail, self.closed = fail, False
            def request(self, body):
                if self.fail:
                    raise TransportError("old broker endpoint")
                return response()
            def close(self):
                self.closed = True
        old, new = Endpoint(True), Endpoint(False)
        ledger = Ledger(self.path / "move")
        throttle = Throttle(POOL, {}, self.path / "pauses", reader=lambda: usage(), clock=lambda: 1000)
        call = ModelCalls(old, ledger, throttle)
        self.addCleanup(call.close)
        with patch("pilot.runtime.broker_healthy", return_value=True), patch("pilot.runtime.open_gateway", return_value=new):
            self.assertEqual(call("task", [{"role": "user", "content": "x"}], 32), "answer")
        self.assertTrue(old.closed)
        self.assertEqual(ledger.calls, 2)
        self.assertEqual(ledger.tokens, 190)
        self.assertEqual(ledger.usage_missing, 1)

    def test_provider_rejection_is_charged_then_bounded_as_call_failure(self):
        class Rejected:
            def request(self, body):
                frame = response()
                frame["status"] = 502
                return frame
            def close(self):
                pass
        gateway = Rejected()
        ledger = Ledger(self.path / "reject")
        throttle = Throttle(POOL, {}, self.path / "pauses", reader=lambda: usage(), clock=lambda: 1000)
        call = ModelCalls(gateway, ledger, throttle)
        with patch("pilot.runtime.broker_healthy", return_value=True), patch("pilot.runtime.open_gateway", return_value=gateway):
            with self.assertRaises(CallFailed):
                call("proposer", [{"role": "user", "content": "x"}], 32)
        self.assertEqual(ledger.calls, 2)
        self.assertEqual(ledger.proposer_calls, 2)
        self.assertEqual(ledger.proposer_success_calls, 0)
        self.assertEqual(ledger.tokens, 380)

    def test_poll_time_does_not_exhaust_active_work_budget(self):
        now = [1000.0]
        ledger = Ledger(self.path / "time", clock=lambda: now[0], limits=dict(LIMITS, active_seconds=1))
        def read():
            now[0] += 2
            return usage()
        throttle = Throttle(POOL, {}, self.path / "pauses", reader=read, clock=lambda: now[0])
        throttle.wait()
        self.assertTrue(ledger.available(throttle.accounted_seconds))
        self.assertEqual(ledger.summary(throttle)["active_seconds"], 0)
        self.assertEqual(ledger.summary(throttle)["poll_seconds"], 2)
        self.assertEqual(throttle.pauses, 0)

    def test_startup_broker_outage_waits_before_reconnect(self):
        throttle = Throttle(POOL, {}, self.path / "pauses", reader=lambda: usage(), clock=lambda: 1000)
        endpoint = object()
        with patch("pilot.runtime.Gateway", side_effect=[TransportError("outage"), endpoint]), patch("pilot.runtime.broker_healthy", return_value=False):
            self.assertIs(open_gateway(throttle), endpoint)

    def test_dead_gateway_pipe_does_not_prevent_cleanup_or_reconnect(self):
        class DeadPipe:
            closed = False
            def close(self):
                raise BrokenPipeError("broker moved")
        stdout = StringIO()
        gateway = Gateway.__new__(Gateway)
        gateway.process = SimpleNamespace(stdin=DeadPipe(), stdout=stdout, wait=lambda timeout: 0)
        gateway.close()
        gateway.close()
        self.assertTrue(stdout.closed)


if __name__ == "__main__":
    unittest.main()
