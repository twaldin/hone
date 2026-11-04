from io import StringIO
from types import SimpleNamespace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pilot import runtime

from pilot.runtime import BudgetExhausted, CallFailed, Gateway, Ledger, LIMITS, ModelCalls, Throttle, TransportError, capacity_reason, create_pool, open_gateway, retry_comparison

POOL = {"*": False, "anthropic": {"accounts": ["email:pilot@example.org|org:personal"], "apiKeys": False}}


def usage(fraction=0.1):
    return {"generatedAt": 1_000_000, "reports": [{"provider": "anthropic", "fetchedAt": 1_000_000, "metadata": {"email": "pilot@example.org", "orgId": "personal"}, "limits": [{"amount": {"usedFraction": fraction}}]}]}


def response(tokens=None, hidden=0):
    counts = tokens or {"input": 100, "output": 20, "cacheRead": 30, "cacheWrite": 40}
    return {"status": 200, "body": {"message": {"usage": counts, "content": [{"type": "text", "text": "answer"}], "stopReason": "stop"}, "retryObservation": {"hiddenAttempts": hidden, "logEvents": hidden}}}


def refusal_frame(max_tokens=32, reported_usage=None):
    receipt = {
        "refusal": {"type": "refusal", "category": "safety", "provenance": "anthropic.message_delta.stop_details"},
        "countingMethod": "@oh-my-pi/pi-natives:ClaudeV3:serialized-provider-json+4096",
        "inputTokens": 120, "framingAllowance": 4096, "inputTokenUpperBound": 4216,
        "maxOutputTokens": max_tokens,
    }
    if reported_usage is not None:
        receipt["reportedUsage"] = reported_usage
    return {"status": 502, "body": {"providerReceipt": receipt,
            "retryObservation": {"httpAttempts": 1, "hiddenAttempts": 0, "logEvents": 0}}}


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
        self.assertTrue(rows[-1]["failed"])
        self.assertEqual(ledger.failed_calls, 1)

    def test_budget_reserves_before_call_and_stops_at_each_cap(self):
        for key, value in (("usd", 0.000001), ("tokens", 1), ("calls", 0), ("proposer_calls", 0), ("active_seconds", 0)):
            limits = dict(LIMITS, **{key: value})
            ledger = Ledger(self.path / key, limits=limits)
            with self.assertRaises(BudgetExhausted, msg=key):
                ledger.admit("proposer", [{"role": "user", "content": "x"}], 32)
            self.assertEqual(ledger.calls, 0)

    def test_refusal_wire_envelope_is_reserved_before_dispatch(self):
        ledger = Ledger(self.path / "wire-envelope", limits=dict(LIMITS, usd=.02))
        with self.assertRaises(BudgetExhausted):
            ledger.admit("task", [{"role": "user", "content": "x"}], 32)
        self.assertEqual(ledger.calls, 0)

    def test_missing_usage_is_counted_and_not_a_success(self):
        ledger = Ledger(self.path / "missing")
        frame = response()
        del frame["body"]["message"]["usage"]
        with self.assertRaises(TransportError):
            ledger.settle("task", {}, frame, 1)
        self.assertEqual(ledger.usage_missing, 1)
        self.assertEqual(ledger.calls, 1)
        self.assertEqual(ledger.failed_calls, 1)

    def test_failed_call_without_usage_is_not_invented_as_zero_cost_success(self):
        ledger = Ledger(self.path / "provider-failure")
        with self.assertRaises(CallFailed):
            ledger.settle("task", {}, {"status": 502, "body": {}}, 1)
        row = json.loads((self.path / "provider-failure").read_text())
        self.assertTrue(row["failed"])
        self.assertTrue(row["usage_missing"])
        self.assertEqual(ledger.failed_calls, 1)
        self.assertEqual(ledger.tokens, 0)
        self.assertEqual(ledger.usd, 0)

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

    def test_terminal_refusal_is_durable_charged_and_never_redispatched_for_any_role(self):
        class Refused:
            def __init__(self):
                self.requests, self.closed = [], False
            def request(self, body):
                self.requests.append(body)
                return refusal_frame()
            def close(self):
                self.closed = True
        for role in ("task", "proposer", "judge", "repair"):
            with self.subTest(role=role):
                gateway = Refused()
                ledger = Ledger(self.path / role / "calls.jsonl")
                throttle = Throttle(POOL, {}, self.path / "pauses", reader=lambda: usage(), clock=lambda: 1000)
                call = ModelCalls(gateway, ledger, throttle)
                with patch("pilot.runtime.broker_healthy", return_value=True), patch("pilot.runtime.open_gateway", return_value=gateway):
                    with self.assertRaises(CallFailed) as caught:
                        call(role, [{"role": "user", "content": "fixture prompt"}], 32)
                self.assertEqual(type(caught.exception).__name__, "ProviderRefusal")
                self.assertEqual(len(gateway.requests), 1)
                self.assertFalse(gateway.closed)
                row = json.loads(ledger.journal.read_text())
                self.assertEqual(row["outcome"], "refusal")
                self.assertEqual(row["refusal"]["category"], "safety")
                self.assertEqual(row["reported_tokens"], 0)
                self.assertEqual(row["estimated_tokens"], 4248)
                self.assertEqual(row["charged_tokens"], 4248)
                self.assertTrue(row["usage_estimated"])
                self.assertAlmostEqual(row["estimated_usd_equivalent"], (4216 * 3.75 + 32 * 15) / 1_000_000)
                self.assertEqual(ledger.tokens, 4248)
                self.assertEqual(ledger.failed_calls, 1)
                self.assertEqual(ledger.proposer_success_calls, 0)
                self.assertEqual(row["row_id"], None)
                summary = ledger.summary(throttle)
                self.assertEqual(summary["refusals"], 1)
                self.assertEqual(summary["transport_failures"], 0)
                self.assertEqual(summary["reported_tokens"], 0)
                self.assertEqual(summary["estimated_tokens"], 4248)

    def test_refusal_upper_bound_uses_larger_reported_input_and_stops_budget(self):
        ledger = Ledger(self.path / "bound.jsonl", limits=dict(LIMITS, tokens=5050))
        frame = refusal_frame(reported_usage={"input": 5000, "output": 2, "cacheRead": 0, "cacheWrite": 0})
        request = {"options": {"maxTokens": 32}}
        with self.assertRaises(CallFailed):
            ledger.settle("task", request, frame, 1)
        row = json.loads(ledger.journal.read_text())
        self.assertEqual(row["reported_tokens"], 5002)
        self.assertEqual(row["estimated_tokens"], 30)
        self.assertEqual(row["charged_tokens"], 5032)
        self.assertAlmostEqual(row["usd_equivalent"], (5000 * 3.75 + 32 * 15) / 1_000_000)
        with self.assertRaises(BudgetExhausted):
            ledger.admit("task", [{"role": "user", "content": "x"}], 32)

    def test_complete_refusal_usage_remains_reported_without_estimated_overlap(self):
        ledger = Ledger(self.path / "known-refusal.jsonl")
        frame = refusal_frame(reported_usage={"input": 100, "output": 2, "cacheRead": 30, "cacheWrite": 40})
        frame["body"]["providerReceipt"]["usageComplete"] = True
        with self.assertRaises(runtime.ProviderRefusal):
            ledger.settle("task", {"options": {"maxTokens": 32}}, frame, 0)
        row = json.loads(ledger.journal.read_text())
        self.assertEqual(row["reported_tokens"], 172)
        self.assertEqual(row["charged_tokens"], 172)
        self.assertEqual(row["estimated_tokens"], 0)
        self.assertFalse(row["usage_estimated"])
        self.assertFalse(row["usage_missing"])
        self.assertEqual(row["usd_equivalent"], row["reported_usd_equivalent"])

    def test_scope_is_nested_receipt_metadata_and_never_changes_request_hash(self):
        ledger = Ledger(self.path / "scopes.jsonl")
        request = {"options": {"maxTokens": 32}}
        with runtime.call_scope(task="ifbench", arm="unchanged:3:first", trial=3):
            with runtime.call_scope(row_id="row-17"):
                with self.assertRaises(CallFailed):
                    ledger.settle("task", request, refusal_frame(), 0)
            self.assertNotIn("row_id", runtime.current_call_scope())
            ledger.settle("task", {"different": True}, response(), 0)
        self.assertEqual(runtime.current_call_scope(), {})
        rows = [json.loads(line) for line in ledger.journal.read_text().splitlines()]
        self.assertEqual(rows[0]["context"], {"task": "ifbench", "arm": "unchanged:3:first", "trial": 3, "row_id": "row-17"})
        self.assertEqual(rows[0]["row_id"], "row-17")
        self.assertEqual(rows[0]["request_hash"], runtime.digest(request))
        self.assertEqual(rows[1]["row_id"], None)
        summary = ledger.summary(SimpleNamespace(accounted_seconds=0, pauses=0, paused_seconds=0))
        self.assertEqual(summary["refusals_by_row"], {"row-17": 1})
        self.assertEqual(summary["refusals_by_arm"], {"unchanged:3:first": 1})

    def test_arbitrary_failure_text_and_unproven_refusal_are_not_classified(self):
        ledger = Ledger(self.path / "unproven.jsonl")
        for frame in (
            {"status": 502, "body": {"error": "Refusal (safety): private explanation"}},
            {"status": 200, "body": {"message": {"stopReason": "error", "errorMessage": "Refusal"}}},
            {"status": 502, "body": {"providerReceipt": {"refusal": {"type": "refusal", "category": "safety"}}}},
        ):
            with self.assertRaises(CallFailed) as caught:
                ledger.settle("task", {}, frame, 0)
            self.assertEqual(type(caught.exception), CallFailed)
        summary = ledger.summary(SimpleNamespace(accounted_seconds=0, pauses=0, paused_seconds=0))
        self.assertEqual(summary["refusals"], 0)
        self.assertEqual(summary["transport_failures"], 3)
        self.assertNotIn("private explanation", ledger.journal.read_text())


    def test_bare_terminal_refusal_is_charged_without_retry_or_private_metadata(self):
        for reason in ("refusal", "sensitive"):
            with self.subTest(reason=reason):
                frame = refusal_frame()
                frame["body"]["providerReceipt"]["refusal"] = {
                    "type": "refusal", "category": "unspecified",
                    "provenance": "anthropic.message_delta.stop_reason",
                    "explanation": "private fixture explanation", "headers": {"private": "fixture"},
                }
                gateway = SimpleNamespace(requests=[], close=lambda: None)
                def request(body):
                    gateway.requests.append(body)
                    return frame
                gateway.request = request
                ledger = Ledger(self.path / reason / "calls.jsonl", history_paths=[])
                throttle = Throttle(POOL, {}, self.path / "pauses", reader=lambda: usage(), clock=lambda: 1000)
                call = ModelCalls(gateway, ledger, throttle)
                with patch("pilot.runtime.broker_healthy", return_value=True), patch("pilot.runtime.open_gateway", return_value=gateway), runtime.call_scope(row_id="row-17", arm="naive"):
                    with self.assertRaises(runtime.ProviderRefusal):
                        call("task", [{"role": "user", "content": "fixture prompt"}], 32)
                self.assertEqual(len(gateway.requests), 1)
                row = json.loads(ledger.journal.read_text())
                self.assertEqual(row["outcome"], "refusal")
                self.assertEqual(row["refusal"], {
                    "type": "refusal", "category": "unspecified",
                    "provenance": "anthropic.message_delta.stop_reason",
                })
                self.assertEqual(row["row_id"], "row-17")
                self.assertEqual(row["role"], "task")
                self.assertEqual(row["request_hash"], runtime.digest(gateway.requests[0]))
                self.assertEqual(row["charged_tokens"], 4248)
                self.assertEqual(ledger.transport_failures, 0)
                self.assertNotIn("private fixture", ledger.journal.read_text())
                self.assertNotIn("headers", ledger.journal.read_text())

    def test_refusal_receipts_require_nonempty_category(self):
        for category in (None, "", 17):
            frame = refusal_frame()
            frame["body"]["providerReceipt"]["refusal"]["category"] = category
            ledger = Ledger(self.path / str(category) / "calls.jsonl", history_paths=[])
            with self.assertRaises(TransportError) as caught:
                ledger.settle("task", {"options": {"maxTokens": 32}}, frame, 0)
            self.assertNotIsInstance(caught.exception, runtime.ProviderRefusal)
            self.assertEqual(ledger.refusals, 0)

    def test_answer_refusal_nondeterminism_charges_receipt_then_latches_all_dispatch(self):
        ledger = Ledger(self.path / "nondeterminism.jsonl")
        request = {"options": {"maxTokens": 32}}
        ledger.settle("task", request, response(), 0)
        with self.assertRaises(runtime.RefusalNondeterminism):
            ledger.settle("task", request, refusal_frame(), 0)
        rows = [json.loads(line) for line in ledger.journal.read_text().splitlines()]
        self.assertEqual([row["outcome"] for row in rows], ["answered", "refusal"])
        self.assertEqual(ledger.tokens, 4438)
        self.assertEqual(rows[-1]["refusal_nondeterminism"]["request_hash"], runtime.digest(request))
        self.assertEqual(len(rows[-1]["refusal_nondeterminism"]["outcomes"]), 2)
        with self.assertRaises(runtime.RefusalNondeterminism):
            ledger.admit("task", [{"role": "user", "content": "unrelated"}], 32)

    def test_retained_refusal_then_answer_stops_before_next_dispatch(self):
        prior = self.path / "retained" / "calls.jsonl"
        request = {"options": {"maxTokens": 32}}
        runtime.append_json(prior, {"call": 127, "request_hash": runtime.digest(request), "outcome": "refusal"})
        ledger = Ledger(self.path / "new" / "calls.jsonl", history_paths=[prior])
        with self.assertRaises(runtime.RefusalNondeterminism):
            ledger.settle("judge", request, response(), 0)
        row = json.loads(ledger.journal.read_text())
        self.assertEqual(row["charged_tokens"], 190)
        self.assertEqual(row["outcome"], "answered")
        self.assertEqual(row["refusal_nondeterminism"]["outcomes"][0]["journal"], str(prior))

    def test_retained_mixed_outcomes_durably_stop_before_gateway_request(self):
        request_hash = runtime.digest({"fixed": True})
        prior = self.path / "history" / "calls-prefix.jsonl"
        runtime.append_json(prior, {"call": 1, "request_hash": request_hash, "status": 200, "stop_reason": "stop", "usage_missing": False})
        runtime.append_json(prior, {"call": 2, "request_hash": request_hash, "outcome": "refusal"})
        ledger = Ledger(self.path / "blocked" / "calls.jsonl", history_paths=[prior])
        with self.assertRaises(runtime.RefusalNondeterminism):
            ledger.admit("proposer", [{"role": "user", "content": "new"}], 32)
        self.assertEqual(ledger.calls, 0)
        self.assertTrue((ledger.journal.parent / "refusal-nondeterminism.json").is_file())

    def test_default_history_includes_native_refusal_proof_before_any_dispatch(self):
        retained = self.path / "evidence" / "pilot"
        request_hash = runtime.digest({"historical": True})
        runtime.append_json(retained / "old" / "calls-prefix.jsonl", {
            "call": 1, "request_hash": request_hash, "status": 200, "stop_reason": "stop", "failed": False, "usage_missing": False,
        })
        runtime.append_json(retained / "diagnosis-7.json", {"failed_calls": [{
            "call": 127, "request_hash": request_hash, "known_classification_present": True,
            "reason": "error", "provider_fetch_attempts": 1,
        }]})
        with patch("pilot.runtime.ROOT", self.path):
            ledger = Ledger(retained / "new" / "calls.jsonl", history_roots=[self.path / ".pilot-runs" / "pilot"])
            with self.assertRaises(runtime.RefusalNondeterminism):
                ledger.admit("task", [{"role": "user", "content": "new request"}], 32)
        self.assertEqual(ledger.calls, 0)
        self.assertEqual(ledger.refusal_nondeterminism["request_hash"], request_hash)
        self.assertTrue((ledger.journal.parent / "refusal-nondeterminism.json").is_file())

    def test_run_root_siblings_share_history_and_global_stop(self):
        root = self.path / ".pilot-runs" / "pilot"
        request = {"options": {"maxTokens": 32}}
        with patch("pilot.runtime.ROOT", self.path):
            first = Ledger(root / "matrix-a" / "seed-1" / "calls.jsonl", history_roots=[root])
            second = Ledger(root / "matrix-b" / "seed-2" / "calls.jsonl", history_roots=[root])
            first.settle("task", request, response(), 0)
            with self.assertRaises(runtime.RefusalNondeterminism):
                second.settle("task", request, refusal_frame(), 0)
            rows = [json.loads(line) for line in second.journal.read_text().splitlines()]
            self.assertEqual(rows[-1]["outcome"], "refusal")
            self.assertEqual(rows[-1]["charged_tokens"], 4248)
            proof = json.loads((root / "refusal-nondeterminism.json").read_text())
            self.assertEqual(proof["request_hash"], runtime.digest(request))
            self.assertEqual({row["journal"] for row in proof["outcomes"]}, {str(first.journal), str(second.journal)})
            self.assertEqual(json.loads((second.journal.parent / "refusal-nondeterminism.json").read_text()), proof)
            for ledger in (first, Ledger(root / "matrix-c" / "calls.jsonl", history_paths=[], history_roots=[root])):
                with self.assertRaises(runtime.RefusalNondeterminism):
                    ledger.admit("task", [{"role": "user", "content": "unrelated"}], 32)

    def test_root_marker_alone_stops_existing_and_reopened_cells(self):
        root = self.path / "runs"
        proof = {"request_hash": runtime.digest({"old": True}), "outcomes": [
            {"journal": "removed-a", "call": 1, "outcome": "answered"},
            {"journal": "removed-b", "call": 2, "outcome": "refusal"},
        ]}
        existing = Ledger(root / "first" / "calls.jsonl", history_paths=[], history_roots=[root])
        runtime.append_json(root / "refusal-nondeterminism.json", proof)
        for ledger in (existing, Ledger(root / "second" / "calls.jsonl", history_paths=[], history_roots=[root])):
            with self.assertRaises(runtime.RefusalNondeterminism):
                ledger.admit("task", [{"role": "user", "content": "new"}], 32)
            self.assertEqual(ledger.calls, 0)
            self.assertFalse(ledger.journal.exists())
            self.assertEqual(ledger.refusal_nondeterminism, proof)

    def test_durable_nondeterminism_stop_survives_reopening_with_no_history(self):
        journal = self.path / "restart" / "calls.jsonl"
        proof = {"request_hash": runtime.digest({}), "outcomes": [
            {"journal": "prior-a", "call": 1, "outcome": "answered"},
            {"journal": "prior-b", "call": 2, "outcome": "refusal"},
        ]}
        runtime.append_json(journal.parent / "refusal-nondeterminism.json", proof)
        ledger = Ledger(journal, history_paths=[])
        with self.assertRaises(runtime.RefusalNondeterminism):
            ledger.admit("task", [{"role": "user", "content": "unrelated"}], 32)
        self.assertEqual(ledger.calls, 0)
        self.assertFalse(journal.exists())

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
