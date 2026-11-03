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
        for candidate in ({}, {"__invalid_artifact__": "bad"}, {"prompt": "ok", "program": "extra"},
                          {"prompt": "ok", "revision_prompt": "extra"}, {"prompt": None}, ["prompt"]):
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

    def test_ifbench_stages_isolate_editable_instructions_and_score_only_final(self):
        row = {"id": "dev:if", "input": "Say alpha", "instruction_id_list": ["protected-checker"],
               "kwargs": [{"protected-count": 1}]}
        candidate = {"prompt": "GENERATION-ONLY", "revision_prompt": "REVISION-ONLY"}
        task = tasks.Task("ifbench", [row], [], {}, candidate)
        for draft, final, expected in (("bad draft", "alpha", 1.0), ("alpha", "bad final", 0.0)):
            with self.subTest(draft=draft, final=final):
                requests, checked = [], []
                def call(role, messages, tokens):
                    requests.append((role, messages, tokens))
                    return json.dumps({"reasoning": "audit", "response": draft} if len(requests) == 1
                                      else {"reasoning": "fixed", "final_response": final})
                def metric(example, prediction):
                    checked.append(prediction.response)
                    return SimpleNamespace(score=float(prediction.response == "alpha"), feedback="checked")
                with patch.dict(tasks._METRICS, {id(task.manifest): metric}):
                    result = tasks.evaluate(task, candidate, task.train, call, True)
                self.assertEqual(result["scores"], [expected])
                self.assertEqual(result["outputs"], [final])
                self.assertEqual(checked, [final])
                self.assertEqual(len(requests), 2)
                self.assertEqual([request[0] for request in requests], ["task", "task"])
                self.assertEqual([request[2] for request in requests], [4096, 4096])
                first, second = requests[0][1], requests[1][1]
                self.assertEqual([message["content"] for message in first if message["role"] == "system"][1:],
                                 ["GENERATION-ONLY"])
                self.assertEqual([message["content"] for message in second if message["role"] == "system"][1:],
                                 ["REVISION-ONLY"])
                self.assertNotIn("REVISION-ONLY", json.dumps(first))
                self.assertNotIn("GENERATION-ONLY", json.dumps(second))
                self.assertEqual(json.loads(second[-1]["content"]), {"query": "Say alpha", "response": draft})
                self.assertNotIn("protected-checker", json.dumps(requests))
                self.assertNotIn("protected-count", json.dumps(requests))
                self.assertEqual(len(result["trajectories"][0]["calls"]), 2)

    def test_invalid_ifbench_revision_discards_unscored_draft(self):
        row = {"id": "dev:revision", "input": "Say alpha", "instruction_id_list": [], "kwargs": []}
        task = tasks.Task("ifbench", [row], [], {}, {"prompt": "follow", "revision_prompt": "revise"})
        responses = iter((json.dumps({"reasoning": "", "response": "alpha"}), "not-json"))
        result = tasks.evaluate(task, task.seed_candidate, task.train, lambda *args: next(responses), True)
        self.assertEqual(result["scores"], [0.0])
        self.assertEqual(result["outputs"], [""])
        self.assertEqual(result["trajectories"][0]["output"], "")

    def test_ifbench_requires_exact_two_module_candidate(self):
        row = {"id": "dev:shape", "input": "Say alpha", "instruction_id_list": [], "kwargs": []}
        seed = {"prompt": "generate", "revision_prompt": "revise"}
        task = tasks.Task("ifbench", [row], [], {}, seed)
        invalid = ({}, {"prompt": "generate"}, {"revision_prompt": "revise"},
                   dict(seed, program="extra"), dict(seed, revision_prompt=None), ["prompt", "revision_prompt"])
        for candidate in invalid:
            with self.subTest(candidate=candidate):
                result = tasks.evaluate(task, candidate, [row], lambda *args: self.fail("called"), True)
                self.assertEqual(result["scores"], [0.0])
                self.assertEqual(result["outputs"], [""])
                self.assertEqual(result["trajectories"][0]["calls"], [])

    def test_ifbench_rejects_invalid_json_fields_at_either_stage(self):
        row = {"id": "dev:fields", "input": "Say alpha", "instruction_id_list": [], "kwargs": []}
        seed = {"prompt": "generate", "revision_prompt": "revise"}
        task = tasks.Task("ifbench", [row], [], {}, seed)
        for stage, field in ((0, "response"), (1, "final_response")):
            for invalid in ({"reasoning": "", field: "alpha", "score": 1},
                            {field: "alpha"}, {"reasoning": "", field: 1},
                            {"reasoning": "", "answer": "alpha"}):
                with self.subTest(stage=stage, invalid=invalid):
                    frames = ([json.dumps({"reasoning": "", "response": "alpha"})] if stage else [])
                    frames.append(json.dumps(invalid))
                    requests = []
                    def call(*args):
                        requests.append(args)
                        return frames[len(requests) - 1]
                    result = tasks.evaluate(task, seed, [row], call)
                    self.assertEqual(result["scores"], [0.0])
                    self.assertEqual(result["outputs"], [""])
                    self.assertEqual(len(requests), stage + 1)

    def test_ifbench_caller_cannot_replace_protected_query_or_checks(self):
        row = {"id": "dev:frozen", "input": "Original query", "instruction_id_list": ["original"],
               "kwargs": [{"count": 1}]}
        seed = {"prompt": "generate", "revision_prompt": "revise"}
        task = tasks.Task("ifbench", [row], [], {}, seed)
        forged = dict(row, input="Forged query", instruction_id_list=[], kwargs=[])
        requests = []
        def call(role, messages, tokens):
            requests.append(messages)
            return json.dumps({"reasoning": "", "response": "draft"} if len(requests) == 1
                              else {"reasoning": "", "final_response": "final"})
        def metric(example, prediction):
            self.assertEqual(example.prompt, "Original query")
            self.assertEqual(example.instruction_id_list, ["original"])
            self.assertEqual(example.kwargs, [{"count": 1}])
            return SimpleNamespace(score=0.0, feedback="protected")
        with patch.dict(tasks._METRICS, {id(task.manifest): metric}):
            result = tasks.evaluate(task, seed, [forged], call)
        self.assertEqual(result["scores"], [0.0])
        self.assertNotIn("Forged query", json.dumps(requests))

    def test_ifbench_membership_and_capture_guards_precede_model_calls(self):
        train = {"id": "if:train", "input": "Train", "instruction_id_list": [], "kwargs": []}
        selection = dict(train, id="if:selection", input="Selection")
        seed = {"prompt": "generate", "revision_prompt": "revise"}
        task = tasks.Task("ifbench", [train], [selection], {}, seed)
        for rows, capture in (([dict(train, id="outside")], False), ([selection], True)):
            with self.subTest(capture=capture), self.assertRaises(ValueError):
                tasks.evaluate(task, seed, rows, lambda *args: self.fail("called"), capture)

    def test_signature_adaptation_never_exposes_body(self):
        source = "def wanted(a, b=2):\n    secret_reference = 999\n    return a + b\n"
        self.assertEqual(tasks._signature(source), "def wanted(a, b=2):")

    def test_mbpp_load_keeps_every_row_and_publishes_gradeability(self):
        from pilot import program, verification
        from pilot.test_program import local_command, local_remove
        source = "class Pair:\n    def __init__(self, first):\n        self.first = first\ndef target(pair):\n    return pair.first\n"
        def tests(index):
            return ["assert target(pair) != 7" if index % 3 == 0 else "assert target(pair) == 7"]
        def data(cache, name):
            count = 374 if name == "mbpp_train" else 90
            return ([{"task_id": index, "text": "Read the first value.", "code": source,
                      "test_setup_code": "pair = Pair(7)", "test_list": tests(index)} for index in range(count)],
                    {"source": name})
        with (patch.object(tasks, "_data", side_effect=data), patch.dict(verification._PLANS, clear=True),
              patch.object(program, "docker_command", local_command), patch.object(program, "_remove", local_remove)):
            task = tasks.load_task("mbpp", Path("unused"))
        rows = task.train + task.selection
        self.assertEqual((len(task.train), len(task.selection)), (374, 90))
        self.assertEqual(len({row["id"] for row in rows}), 464)
        for row in rows:
            self.assertNotIn("function_names", row)
            self.assertEqual(row["reference_code"], source)
            self.assertEqual(row["test_setup_code"], "pair = Pair(7)")
            self.assertIn("def target(pair):", row["input"])
            self.assertNotIn("return pair.first", row["input"])
            self.assertNotIn("assert target", row["input"])
        inventory = task.manifest["gradeability"]
        unsupported = [row["id"] for row in rows if int(row["id"].rsplit(":", 1)[1]) % 3 == 0]
        self.assertEqual(inventory["gradeable_ids"], [row["id"] for row in rows if row["id"] not in unsupported])
        self.assertEqual([entry["id"] for entry in inventory["ungradeable"]], unsupported)
        self.assertTrue(all(isinstance(entry["reason"], str) and entry["reason"] for entry in inventory["ungradeable"]))
        self.assertFalse(task.manifest["scored_final_tests_loaded"])

    def test_mbpp_replay_reference_and_evaluation_share_extraction(self):
        from pilot import program
        from pilot.test_program import local_command, local_remove
        row = {"id": "mbpp:train:synthetic", "input": "Increment.",
               "test_setup_code": "value = 7", "test_list": ["assert target(value) == 8"],
               "reference_code": "def target(x): return x + 1"}
        candidate = {"prompt": "Solve.", "program": "candidate"}
        task = tasks.Task("mbpp", [row], [], {}, candidate)
        output = "prose\n```javascript\nignored\n```\n```python\ndef target(x): return x + 1"
        with (patch.object(program, "docker_command", local_command),
              patch.object(program, "_remove", local_remove)):
            reference = tasks.score_output(task, row, row["reference_code"])
            replay = tasks.score_output(task, row, output)
            with patch.object(tasks, "run_program", return_value=(output, [])):
                result = tasks.evaluate(task, candidate, [row], lambda *args: self.fail("called"), True)
        self.assertEqual((reference, replay, result["scores"]), (1.0, 1.0, [1.0]))
        self.assertEqual(result["outputs"], [output])
        self.assertNotIn("assert target", repr(result["trajectories"]))

    def test_mbpp_model_calls_never_receive_assertions_or_setup(self):
        row = {"id": "mbpp:train:synthetic", "input": "Increment.",
               "test_setup_code": "protected_setup = 349827",
               "test_list": ["assert target(349827) == 349828"], "reference_code": "def target(x): return x + 1"}
        candidate = {"prompt": "Solve.", "program": tasks.SEED_PROGRAM}
        task = tasks.Task("mbpp", [row], [], {}, candidate)
        from pilot.test_program import ProgramTests
        requests = []
        def call(role, messages, tokens):
            requests.append(messages)
            return "```python\ndef target(x): return x + 1\n```"
        def run(candidate, task_input, provider):
            return ProgramTests().execute(candidate["program"], provider)
        with (patch.object(tasks, "run_program", side_effect=run),
              patch.object(tasks, "score_solution", return_value=1.0)):
            result = tasks.evaluate(task, candidate, [row], call, True)
        self.assertEqual(result["scores"], [1.0])
        self.assertNotIn("protected_setup", repr(requests))
        self.assertNotIn("349827", repr(requests))
        self.assertNotIn("assert target", repr(result["trajectories"]))

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
