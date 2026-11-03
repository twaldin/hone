import ast
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pilot import tasks
from pilot.runtime import BudgetExhausted, CallFailed


class TaskTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("PILOT_OFFICIAL_METRIC_TESTS") == "1",
                         "Parent-controlled pinned official checker smoke")
    def test_official_loose_variants_and_instruction_fraction(self):
        with tempfile.TemporaryDirectory(prefix="hone-metric-test-") as directory:
            metric, _ = tasks._official_metric(Path(directory))
            example = SimpleNamespace(prompt="Write alpha.",
                                      instruction_id_list=["count:word_count_range", "count:word_count_range"],
                                      kwargs=[{"min_words": 1, "max_words": 1}, {"min_words": 2, "max_words": 2}])
            result = metric(example, SimpleNamespace(response="This is a long preamble.\nalpha\nThis is a long ending."))
            self.assertEqual(result.score, 0.5)

    def task(self):
        row = {"id": "dev:1", "input": "Compute something", "answer": "42", "solution": "protected reasoning"}
        selection = {"id": "dev:2", "input": "Other problem", "answer": "7"}
        return tasks.Task("aime", [row], [selection], {}, {"prompt": "Answer integer"})

    def test_official_integer_semantics(self):
        for text in ("42", " 042\n", "+42"):
            self.assertEqual(tasks.aime_score(text, "42"), 1)
        for text in ("\\boxed{42}", "Answer: 42", "42.0", "41", ""):
            self.assertEqual(tasks.aime_score(text, "42"), 0)

    def test_explicit_development_only(self):
        with self.assertRaises(ValueError):
            tasks.load_task("test", Path("unused"))
        rows = [{"id": str(i)} for i in range(1000)]
        train, selection = tasks.partition("ifbench", rows)
        self.assertEqual([row["id"] for row in selection], [str(i) for i in range(300)])
        self.assertEqual([row["id"] for row in train], [str(i) for i in range(300, 600)])
        self.assertFalse({row["id"] for row in train} & {row["id"] for row in selection})
        a, b = tasks.partition("aime", rows[:90])
        self.assertEqual((len(a), len(b)), (45, 45))
        self.assertEqual(tasks.partition("aime", rows[:90]), (a, b))
        self.assertEqual({row["id"] for row in a + b}, {str(i) for i in range(90)})

    def test_no_labels_reach_model(self):
        task = self.task()
        requests = []
        def call(role, messages, tokens):
            requests.append((role, messages, tokens))
            return '{"reasoning":"visible working","answer":"42"}'
        result = tasks.evaluate(task, task.seed_candidate, task.train, call, capture_traces=True)
        self.assertEqual(result["scores"], [1.0])
        self.assertNotIn("protected reasoning", repr(requests))
        self.assertNotIn("42", repr(requests))
        self.assertIn("protected reasoning", result["trajectories"][0]["feedback"])

    def test_invalid_candidate_never_calls_model(self):
        task = self.task()
        def forbidden(*args):
            self.fail("Invalid candidate made a model call")
        for candidate in ({}, {"__invalid_artifact__": "bad"}, {"prompt": "ok", "program": "extra"}):
            self.assertEqual(tasks.evaluate(task, candidate, task.train, forbidden)["scores"], [0.0])

    def test_selection_feedback_rejected_before_call(self):
        task = self.task()
        with self.assertRaises(ValueError):
            tasks.evaluate(task, task.seed_candidate, task.selection, lambda *args: self.fail("called"), True)

    def test_caller_cannot_replace_protected_answer(self):
        task = self.task()
        forged = dict(task.train[0], answer="99", input="forged")
        result = tasks.evaluate(task, task.seed_candidate, [forged], lambda *args: '{"reasoning":"","answer":"99"}')
        self.assertEqual(result["scores"], [0.0])

    def test_budget_exhaustion_propagates(self):
        task = self.task()
        class StopBudget(BudgetExhausted):
            pass
        def exhausted(*args):
            raise StopBudget("stop")
        with self.assertRaises(StopBudget):
            tasks.evaluate(task, task.seed_candidate, task.train, exhausted)

    def test_provider_failure_scores_zero_but_infrastructure_error_propagates(self):
        task = self.task()
        def rejected(*args):
            raise CallFailed("provider rejected")
        self.assertEqual(tasks.evaluate(task, task.seed_candidate, task.train, rejected)["scores"], [0.0])
        def outage(*args):
            raise RuntimeError("infrastructure failed")
        with self.assertRaises(RuntimeError):
            tasks.evaluate(task, task.seed_candidate, task.train, outage)

    def test_aime_reasoning_is_not_part_of_official_answer_field(self):
        task = self.task()
        for answer, expected in ((" +042\n", 1.0), ("Answer: 42", 0.0), ("\\boxed{42}", 0.0), ("42.0", 0.0)):
            result = tasks.evaluate(task, task.seed_candidate, task.train,
                                    lambda *args: json.dumps({"reasoning": "The answer is 999, not parsed.", "answer": answer}))
            self.assertEqual(result["scores"], [expected])
            self.assertEqual(result["outputs"], [answer])
        self.assertEqual(tasks.evaluate(task, task.seed_candidate, task.train, lambda *args: "42")["scores"], [0.0])

    def test_ifbench_scores_only_second_stage_final_response(self):
        row = {"id": "dev:if", "input": "Say alpha", "instruction_id_list": [], "kwargs": []}
        task = tasks.Task("ifbench", [row], [], {}, {"prompt": "follow"})
        requests = []
        def call(role, messages, tokens):
            requests.append(messages)
            return json.dumps({"reasoning": "audit", "response": "bad draft"} if len(requests) == 1
                              else {"reasoning": "fixed", "final_response": "alpha"})
        def metric(example, prediction):
            self.assertEqual(prediction.response, "alpha")
            return SimpleNamespace(score=1.0, feedback="passed")
        with patch.dict(tasks._METRICS, {id(task.manifest): metric}):
            result = tasks.evaluate(task, task.seed_candidate, task.train, call, True)
        self.assertEqual(result["scores"], [1.0])
        self.assertEqual(len(requests), 2)
        self.assertIn("bad draft", str(requests[1]))
        self.assertEqual(len(result["trajectories"][0]["calls"]), 2)

    def test_signature_adaptation_never_exposes_body(self):
        source = "def wanted(a, b=2):\n    secret_reference = 999\n    return a + b\n"
        self.assertEqual(tasks._signature(source), "def wanted(a, b=2):")

    def test_download_removal_preserves_checker_logic(self):
        tree = ast.parse("import nltk\nnltk.download('punkt')\ndef checker(x):\n    nltk.download('stopwords')\n    return x == 'yes'\n")
        tree = ast.fix_missing_locations(tasks._DisableDownloads().visit(tree))
        namespace = {}
        exec(compile(tree, "checker", "exec"), namespace)
        self.assertTrue(namespace["checker"]("yes"))
        self.assertFalse(namespace["checker"]("no"))

    def test_official_metric_adapter_copies_mutable_kwargs(self):
        task = tasks.Task("ifbench", [], [], {}, {})
        row = {"id": "instruction:1", "input": "follow", "instruction_id_list": ["count"], "kwargs": [{"count": 2}]}
        def metric(example, prediction):
            example.kwargs[0]["count"] = 99
            return SimpleNamespace(score=0.5, feedback="official feedback")
        with patch.dict(tasks._METRICS, {id(task.manifest): metric}):
            self.assertEqual(tasks.score_output(task, row, "answer"), 0.5)
        self.assertEqual(row["kwargs"], [{"count": 2}])


if __name__ == "__main__":
    unittest.main()
