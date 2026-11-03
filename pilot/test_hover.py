import hashlib
import io
import json
from pathlib import Path
import random
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from pilot import hover
from pilot.runtime import BudgetExhausted, CallFailed
from pilot.tasks import Task


def fixture_bytes(count):
    return json.dumps([{"uid": f"fixture-{index}", "claim": f"Claim {index}",
                        "supporting_facts": [["The Alpha", 0], ["Beta!", 1], ["Café", 2], ["The Alpha", 3]],
                        "label": "fixture-only", "num_hops": 99}
                       for index in range(count)], ensure_ascii=True).encode("ascii")


class HoVerDataTests(unittest.TestCase):
    def test_projection_uses_distinct_canonical_tokens_not_num_hops(self):
        data = fixture_bytes(1)
        with patch.object(hover.json, "loads", side_effect=AssertionError("Projection decoded label-bearing JSON")):
            rows = hover.project_rows(data)
        self.assertEqual([(row.uid, row.distinct_titles) for row in rows], [("fixture-0", 3)])
        train, selection = hover.decode_development(data, rows, [])
        self.assertEqual(selection, [])
        self.assertEqual(train[0]["supporting_facts"], [
            {"key": "The Alpha", "value": 0}, {"key": "Beta!", "value": 1},
            {"key": "Café", "value": 2}, {"key": "The Alpha", "value": 3}])
        self.assertNotIn("label", train[0])
        self.assertNotIn("num_hops", train[0])

    def test_escaped_equivalents_and_alternate_encodings_are_rejected(self):
        data = fixture_bytes(1)
        for replacement in (b'"\\u0054he Alpha"', b'"The\\u0020Alpha"', b'"The Alpha\\/"',
                            b'"caf\\u00E9"', '"Café"'.encode("utf-8"), b'"\\ud800"'):
            with self.subTest(replacement=replacement):
                with self.assertRaises(ValueError):
                    hover.project_rows(data.replace(b'"The Alpha"', replacement, 1))
        with self.assertRaises(ValueError):
            hover.project_rows(data.replace(b'"supporting_facts"', b'"supporting\\u005ffacts"'))

    def test_canonical_control_and_surrogate_tokens_remain_injective(self):
        data = fixture_bytes(1)
        for replacement in (b'"\\n"', b'"\\u0001"', b'"\\ud83d\\ude00"', b'"quote\\\"slash\\\\"'):
            projected = hover.project_rows(data.replace(b'"Beta!"', replacement))
            self.assertEqual(projected[0].distinct_titles, 3)

    def test_exact_small_partition_boundaries_preserve_uncapped_order(self):
        rows = hover.project_rows(fixture_bytes(10))
        train, selection = hover.development_spans(rows)
        self.assertEqual([row.uid for row in train], ["fixture-9", "fixture-6"])
        self.assertEqual([row.uid for row in selection], ["fixture-3", "fixture-4", "fixture-2", "fixture-0"])
        two_title = hover.RowSpan("excluded", 0, 0, 2)
        self.assertEqual(hover.development_spans(rows + [two_title]), (train, selection))

    def test_full_caps_independent_rng_and_only_development_rows_decoded(self):
        data = fixture_bytes(2000)
        projected = hover.project_rows(data)
        train, selection = hover.development_spans(projected)
        reference = list(range(2000))
        random.Random(0).shuffle(reference)
        expected_train = random.Random(1).sample(reference[1600:], 150)
        expected_selection = random.Random(1).sample(reference[800:1600], 300)
        self.assertEqual([row.uid for row in train], [f"fixture-{index}" for index in expected_train])
        self.assertEqual([row.uid for row in selection], [f"fixture-{index}" for index in expected_selection])
        permitted = {data[row.start:row.end] for row in train + selection}
        real_loads = json.loads
        decoded = []
        def sealed_loads(payload):
            self.assertIn(payload, permitted, "Withheld row reached the JSON decoder")
            decoded.append(payload)
            return real_loads(payload)
        with patch.object(hover.json, "loads", side_effect=sealed_loads):
            train_rows, selection_rows = hover.decode_development(data, train, selection)
        self.assertEqual((len(train_rows), len(selection_rows), len(decoded)), (150, 300, 450))
        self.assertEqual(set(decoded), permitted)
        self.assertFalse({row["id"] for row in train_rows} & {row["id"] for row in selection_rows})

    def test_malformed_or_duplicate_membership_fails_closed(self):
        data = fixture_bytes(1)
        for malformed in (data[:-1], data + b"null", data.replace(b'"uid":', b'"uid":"duplicate","uid":'),
                          data.replace(b'"fixture-0"', b'"escaped\\u002d0"')):
            with self.assertRaises(ValueError):
                hover.project_rows(malformed)


class HoVerProgramTests(unittest.TestCase):
    def task(self):
        train = {"id": "fixture:train", "input": "Unlabeled claim", "supporting_facts": [
            {"key": "The Alpha", "value": 0}, {"key": "Beta!", "value": 1}, {"key": "Café", "value": 2}]}
        selection = dict(train, id="fixture:selection")
        return Task("hover", [train], [selection], {}, dict(hover.SEED))

    def test_four_protected_stages_and_ordered_retrieval_union(self):
        task = self.task()
        requests, retrievals = [], []
        replies = iter([{"summary": "summary one"}, {"query": "query two"},
                        {"summary": "summary two"}, {"query": "query three"}])
        def call(role, messages, tokens):
            self.assertEqual((role, tokens), ("task", 4096))
            requests.append(messages)
            return json.dumps({"reasoning": "visible", **next(replies)})
        def search(query, k):
            retrievals.append((query, k))
            return {"Unlabeled claim": ["ALPHA | first", "ALPHA | repeated across hops"],
                    "query two": ["Beta | second", "ALPHA | first"],
                    "query three": ["CAFÉ | third", "Extra | fourth"]}[query]
        with patch.dict(hover._CACHES, {id(task.manifest): Path("fixture-only")}), patch.dict(
            hover._RETRIEVERS, {Path("fixture-only/hover-retrieval"): hover.PreparedRetrieval(search, {})}
        ):
            result = hover.evaluate_hover(task, task.seed_candidate, task.train, call, True)
        self.assertEqual(retrievals, [("Unlabeled claim", 7), ("query two", 7), ("query three", 10)])
        self.assertEqual(result["scores"], [1.0])
        self.assertEqual(json.loads(result["outputs"][0]), ["ALPHA | first", "ALPHA | repeated across hops",
                         "Beta | second", "ALPHA | first", "CAFÉ | third", "Extra | fourth"])
        inputs = [json.loads(request[-1]["content"]) for request in requests]
        self.assertEqual(inputs[1], {"claim": "Unlabeled claim", "summary_1": "summary one"})
        self.assertEqual(inputs[2]["context"], "summary one")
        self.assertEqual(inputs[3], {"claim": "Unlabeled claim", "summary_1": "summary one", "summary_2": "summary two"})
        self.assertNotIn("supporting_facts", repr(requests))
        self.assertNotIn("The Alpha", repr(requests))
        self.assertEqual(len(result["trajectories"][0]["calls"]), 4)

    def test_official_metric_and_frozen_gold(self):
        task = self.task()
        row = task.train[0]
        complete = json.dumps(["Alpha | text", "BETA | text", "CAFÉ | text", "extra | text"])
        self.assertEqual(hover.score_hover_output(task, row, complete), 1.0)
        forged = dict(row, supporting_facts=[{"key": "Fake", "value": 0}])
        self.assertEqual(hover.score_hover_output(task, forged, json.dumps(["Fake | text"])), 0.0)
        for invalid in ("", "[]", '{}', '{"score":1}', '[1]', '"Alpha"',
                        json.dumps(["Alpha | text", "Beta | text", "Cafe | text"]),
                        "__import__('os')._exit(0)"):
            self.assertEqual(hover.score_hover_output(task, row, invalid), 0.0)
        with self.assertRaises(ValueError):
            hover.score_hover_output(task, dict(row, id="outside"), complete)

    def test_selection_feedback_and_outside_rows_rejected_before_execution(self):
        task = self.task()
        for rows, capture in ((task.selection, True), ([{"id": "outside"}], False)):
            with self.assertRaises(ValueError):
                hover.evaluate_hover(task, task.seed_candidate, rows, lambda *args: self.fail("model touched"), capture)

    def test_invalid_candidate_never_prepares_resources(self):
        task = self.task()
        for candidate in ({}, {"prompt": "fake"}, dict(task.seed_candidate, extra="field"), dict(task.seed_candidate, summarize1=3)):
            result = hover.evaluate_hover(task, candidate, task.train, lambda *args: self.fail("model touched"))
            self.assertEqual(result, {"scores": [0.0], "outputs": [""], "trajectories": []})

    def test_failure_boundary_and_no_selection_trajectories(self):
        task = self.task()
        def fail(error):
            def call(*args):
                raise error
            return call
        with patch.dict(hover._CACHES, {id(task.manifest): Path("fixture-only")}), patch.dict(
            hover._RETRIEVERS, {Path("fixture-only/hover-retrieval"): hover.PreparedRetrieval(lambda query, k: [], {})}
        ):
            for call in (fail(CallFailed("rejected")), lambda *args: '{"reasoning":"","summary":"ok","score":1}'):
                result = hover.evaluate_hover(task, task.seed_candidate, task.selection, call)
                self.assertEqual(result, {"scores": [0.0], "outputs": [""], "trajectories": []})
            for error in (BudgetExhausted("stop"), RuntimeError("infrastructure outage")):
                with self.assertRaises(type(error)):
                    hover.evaluate_hover(task, task.seed_candidate, task.train, fail(error))
        with self.assertRaisesRegex(RuntimeError, "prepared"):
            hover.evaluate_hover(task, task.seed_candidate, task.train, lambda *args: self.fail("model touched"))


class HoVerResourceTests(unittest.TestCase):
    def archive(self, path, names):
        with tarfile.open(path, "w:gz") as tar:
            for name, kind in names:
                member = tarfile.TarInfo(name)
                member.type = kind
                payload = b'{"title":"fixture","text":["text"]}\n'
                if kind == tarfile.REGTYPE:
                    member.size = len(payload)
                    tar.addfile(member, io.BytesIO(payload))
                else:
                    member.linkname = "outside"
                    tar.addfile(member)

    def test_only_verified_single_regular_member_extracted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "work"
            root.mkdir()
            archive, target = root / "fixture.tar.gz", root / hover.CORPUS_MEMBER
            self.archive(archive, [("._" + hover.CORPUS_MEMBER, tarfile.REGTYPE), ("../outside", tarfile.REGTYPE),
                                   (hover.CORPUS_MEMBER, tarfile.REGTYPE)])
            with patch.object(hover, "CORPUS_BYTES", archive.stat().st_size), patch.object(hover, "CORPUS_SHA", hashlib.sha256(archive.read_bytes()).hexdigest()):
                hover.extract_corpus(archive, target)
            self.assertEqual(json.loads(target.read_text()), {"title": "fixture", "text": ["text"]})
            self.assertFalse((Path(directory) / "outside").exists())
            self.assertFalse((root / ("._" + hover.CORPUS_MEMBER)).exists())
            target.unlink()
            for names in ([('../outside', tarfile.REGTYPE)], [(hover.CORPUS_MEMBER, tarfile.SYMTYPE)],
                          [(hover.CORPUS_MEMBER, tarfile.REGTYPE), (hover.CORPUS_MEMBER, tarfile.REGTYPE)]):
                self.archive(archive, names)
                with patch.object(hover, "CORPUS_BYTES", archive.stat().st_size), patch.object(hover, "CORPUS_SHA", hashlib.sha256(archive.read_bytes()).hexdigest()):
                    with self.assertRaises(RuntimeError):
                        hover.extract_corpus(archive, target)
                self.assertFalse(target.exists())
                self.assertFalse(target.with_suffix(".partial").exists())
            with self.assertRaises(RuntimeError):
                hover.extract_corpus(archive, target)

    def test_missing_or_wrong_dependencies_fail_without_download(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(hover.importlib.metadata, "version", return_value="wrong"), patch.object(
                hover.urllib.request, "urlopen", side_effect=AssertionError("download touched")
            ), patch("os.getpriority", return_value=10), patch("os.sched_getaffinity", return_value={6}):
                with self.assertRaisesRegex(RuntimeError, "requires"):
                    hover.prepare_retrieval(Path(directory))


if __name__ == "__main__":
    unittest.main()
