from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import random
import re
import shutil
import string
import tarfile
import unicodedata
import urllib.request

from .program import ProgramError
from .runtime import BudgetExhausted, CallFailed
from .tasks import ARTIFACT_REV, Task, _fetch, _response

SOURCE_REV = "39b84697f196308f398a251a7aea9b82ae0f0562"
SOURCE_BLOB = "49a36d7eb2f319329264b546cb687f54b8f1990f"
SOURCE_BYTES = 9205582
SOURCE_URL = f"https://raw.githubusercontent.com/hover-nlp/hover/{SOURCE_REV}/data/hover/hover_train_release_v1.1.json"
CORPUS_REV = "ef6a5e72a98b47cef31574a400fea8fe149559a3"
CORPUS_SHA = "744183e61af986bde9b25c880b59c1502618a8b673671e189cbc0ee684fceb42"
CORPUS_BYTES = 608448121
CORPUS_MEMBER = "wiki.abstracts.2017.jsonl"
CORPUS_URL = f"https://huggingface.co/dspy/cache/resolve/{CORPUS_REV}/wiki.abstracts.2017.tar.gz"
DEPENDENCIES = {"bm25s": "0.2.12", "PyStemmer": "2.2.0.3", "jax": "0.6.0", "jaxlib": "0.6.0"}
RECIPE = {"k1": 0.9, "b": 0.4, "stopwords": "en", "stemmer": "english", "selection": "jax", "n_threads": 1}
SEED = {
    "query_hop2": "Given the fields `claim`, `summary_1`, produce the fields `query`.",
    "query_hop3": "Given the fields `claim`, `summary_1`, `summary_2`, produce the fields `query`.",
    "summarize1": "Given the fields `claim`, `passages`, produce the fields `summary`.",
    "summarize2": "Given the fields `claim`, `context`, `passages`, produce the fields `summary`.",
}


@dataclass(frozen=True)
class RowSpan:
    uid: str
    start: int
    end: int
    distinct_titles: int


class _OpaqueJSON:

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def whitespace(self):
        while self.pos < len(self.data) and self.data[self.pos] in b" \t\r\n":
            self.pos += 1

    def take(self, token: bytes):
        self.whitespace()
        if self.data[self.pos:self.pos + len(token)] != token:
            raise ValueError("Invalid opaque HoVer JSON structure")
        self.pos += len(token)

    def string(self) -> bytes:
        self.whitespace()
        start = self.pos
        self.take(b'"')
        while self.pos < len(self.data):
            value = self.data[self.pos]
            self.pos += 1
            if value == 34:
                return self.data[start:self.pos]
            if value < 32:
                raise ValueError("Unescaped JSON control character")
            if value == 92:
                if self.pos >= len(self.data):
                    break
                escape = self.data[self.pos]
                self.pos += 1
                if escape == 117:
                    token = self.data[self.pos:self.pos + 4]
                    if len(token) != 4 or any(c not in b"0123456789abcdefABCDEF" for c in token):
                        raise ValueError("Invalid JSON Unicode escape")
                    self.pos += 4
                elif escape not in b'"\\/bfnrt':
                    raise ValueError("Invalid JSON escape")
        raise ValueError("Unterminated opaque JSON string")

    def value(self, depth=0):
        if depth > 32:
            raise ValueError("HoVer JSON nesting exceeds boundary")
        self.whitespace()
        token = self.data[self.pos:self.pos + 1]
        if token == b'"':
            self.string()
        elif token in (b"[", b"{"):
            self.pos += 1
            closing = b"]" if token == b"[" else b"}"
            self.whitespace()
            if self.data[self.pos:self.pos + 1] != closing:
                while True:
                    if token == b"{":
                        self.string()
                        self.take(b":")
                    self.value(depth + 1)
                    self.whitespace()
                    if self.data[self.pos:self.pos + 1] != b",":
                        break
                    self.pos += 1
            self.take(closing)
        else:
            match = re.compile(rb"(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)").match(self.data, self.pos)
            if match is None:
                raise ValueError("Invalid opaque JSON value")
            self.pos = match.end()


def _validate_title_token(token: bytes):
    if len(token) < 2 or token[:1] != b'"' or token[-1:] != b'"':
        raise ValueError("Expected opaque title string")
    position = 1
    while position < len(token) - 1:
        value = token[position]
        position += 1
        if value == 92:
            escape = token[position:position + 1]
            position += 1
            if escape in (b'"', b"\\", b"b", b"f", b"n", b"r", b"t"):
                continue
            if escape != b"u":
                raise ValueError("Noncanonical opaque title escape")
            digits = token[position:position + 4]
            if len(digits) != 4 or any(c not in b"0123456789abcdef" for c in digits):
                raise ValueError("Noncanonical opaque title Unicode escape")
            code = int(digits, 16)
            position += 4
            if code in (8, 9, 10, 12, 13) or 32 <= code < 128 or 0xdc00 <= code <= 0xdfff:
                raise ValueError("Alternate opaque title encoding")
            if 0xd800 <= code <= 0xdbff:
                suffix = token[position:position + 6]
                if (len(suffix) != 6 or suffix[:2] != b"\\u"
                        or any(c not in b"0123456789abcdef" for c in suffix[2:])
                        or not 0xdc00 <= int(suffix[2:], 16) <= 0xdfff):
                    raise ValueError("Noncanonical opaque title surrogate")
                position += 6
        elif value < 32 or value >= 128 or value == 34:
            raise ValueError("Noncanonical opaque title character")
    if position != len(token) - 1:
        raise ValueError("Invalid opaque title boundary")


def project_rows(data: bytes) -> list[RowSpan]:
    parser = _OpaqueJSON(data)
    parser.take(b"[")
    rows = []
    seen = set()
    parser.whitespace()
    if data[parser.pos:parser.pos + 1] != b"]":
        while True:
            parser.whitespace()
            start = parser.pos
            parser.take(b"{")
            uid = None
            count = None
            keys = set()
            while True:
                key = parser.string()
                if not re.fullmatch(rb'"[a-z_]+"', key):
                    raise ValueError("Noncanonical HoVer source field")
                if key in keys:
                    raise ValueError("Duplicate HoVer source field")
                keys.add(key)
                parser.take(b":")
                if key == b'"uid"':
                    token = parser.string()
                    if not re.fullmatch(rb'"[a-zA-Z0-9_-]+"', token):
                        raise ValueError("HoVer uid is not canonical metadata")
                    uid = token[1:-1].decode("ascii")
                elif key == b'"supporting_facts"':
                    titles = set()
                    parser.take(b"[")
                    parser.whitespace()
                    if data[parser.pos:parser.pos + 1] != b"]":
                        while True:
                            parser.take(b"[")
                            title = parser.string()
                            _validate_title_token(title)
                            titles.add(title)
                            parser.take(b",")
                            parser.value()
                            parser.take(b"]")
                            parser.whitespace()
                            if data[parser.pos:parser.pos + 1] != b",":
                                break
                            parser.pos += 1
                    parser.take(b"]")
                    count = len(titles)
                else:
                    parser.value()
                parser.whitespace()
                if data[parser.pos:parser.pos + 1] != b",":
                    break
                parser.pos += 1
            parser.take(b"}")
            if uid is None or count is None or uid in seen:
                raise ValueError("Missing or duplicate HoVer membership metadata")
            seen.add(uid)
            rows.append(RowSpan(uid, start, parser.pos, count))
            parser.whitespace()
            if data[parser.pos:parser.pos + 1] != b",":
                break
            parser.pos += 1
    parser.take(b"]")
    parser.whitespace()
    if parser.pos != len(data):
        raise ValueError("Trailing HoVer source bytes")
    return rows


def development_spans(projection: list[RowSpan]) -> tuple[list[RowSpan], list[RowSpan]]:
    eligible = [row for row in projection if row.distinct_titles == 3]
    random.Random(0).shuffle(eligible)
    boundary_a, boundary_b = int(0.4 * len(eligible)), int(0.8 * len(eligible))
    train, selection = eligible[boundary_b:], eligible[boundary_a:boundary_b]
    return (random.Random(1).sample(train, 150) if len(train) > 150 else train,
            random.Random(1).sample(selection, 300) if len(selection) > 300 else selection)


def decode_development(data: bytes, train: list[RowSpan], selection: list[RowSpan]) -> tuple[list[dict], list[dict]]:
    def decode(span):
        row = json.loads(data[span.start:span.end])
        facts = [{"key": title, "value": sentence} for title, sentence in row["supporting_facts"]]
        if row["uid"] != span.uid or len({fact["key"] for fact in facts}) != 3:
            raise ValueError("Decoded development membership disagrees with opaque projection")
        return {"id": "hover:train:" + span.uid, "input": row["claim"], "supporting_facts": facts}
    return [decode(span) for span in train], [decode(span) for span in selection]


def load_hover(cache: Path) -> Task:
    path, source = _fetch(cache, "hover_train_release_v1.1.json", SOURCE_URL, None, SOURCE_BLOB)
    data = path.read_bytes()
    if len(data) != SOURCE_BYTES:
        raise ValueError("Pinned HoVer source byte count changed")
    projection = project_rows(data)
    train_spans, selection_spans = development_spans(projection)
    if len(projection) != 18171 or (len(train_spans), len(selection_spans)) != (150, 300):
        raise ValueError("HoVer official development partition sizes changed")
    train, selection = decode_development(data, train_spans, selection_spans)
    manifest = {
        "task": "hover", "development_only": True, "sources": [source],
        "train_ids": [row["id"] for row in train], "selection_ids": [row["id"] for row in selection],
        "scored_final_tests_loaded": False, "metric_artifact_revision": ARTIFACT_REV,
        "license": "CC-BY-SA-4.0; HoVer and Wikipedia attribution required",
        "partition": {"source_rows": len(projection), "three_title_rows": sum(row.distinct_titles == 3 for row in projection),
                      "shuffle_seed": 0, "split": "test/validation/train 40/40/20", "independent_cap_seed": 1,
                      "train_cap": 150, "validation_cap": 300, "labels_decoded": 450,
                      "projection": "Opaque canonical ASCII JSON title-token equality; no title text or label objects decoded before membership"},
        "program_protocol": {"program": "HoverMultiHop", "stages": ["summarize1", "query_hop2", "summarize2", "query_hop3"],
                             "retrieval_counts": [7, 7, 10], "seed_dspy_revision": "62dc3b634d7dc0c4889abcf905cb4c391ea6b396",
                             "adaptation": "Current subscription model protected JSON reasoning/output transport, not historical DSPy adapter reproduction",
                             "metric": "Official normalized gold-title subset of retrieved passage-title prefixes"},
        "retrieval": {"corpus_url": CORPUS_URL, "sha256": CORPUS_SHA, "bytes": CORPUS_BYTES,
                      "dependencies": DEPENDENCIES, "k1": 0.9, "b": 0.4, "n_threads": 1},
    }
    task = Task("hover", train, selection, manifest, dict(SEED))
    _CACHES[id(manifest)] = cache
    return task


_CACHES: dict[int, Path] = {}


@dataclass(frozen=True)
class PreparedRetrieval:
    search: Callable[[str, int], list[str]]
    receipt: dict


_RETRIEVERS: dict[Path, PreparedRetrieval] = {}


def _file_sha(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def extract_corpus(archive: Path, target: Path):
    if archive.stat().st_size != CORPUS_BYTES or _file_sha(archive) != CORPUS_SHA:
        raise RuntimeError("Pinned HoVer corpus digest or size mismatch")
    temporary = target.with_suffix(".partial")
    try:
        with tarfile.open(archive, "r:gz") as tar:
            found = False
            for member in tar:
                if member.name != CORPUS_MEMBER:
                    continue
                if not member.isfile() or found:
                    raise RuntimeError("HoVer corpus member must be regular and appear exactly once")
                found = True
                stream = tar.extractfile(member)
                if stream is None:
                    raise RuntimeError("HoVer corpus member is unreadable")
                with stream, temporary.open("wb") as output:
                    shutil.copyfileobj(stream, output, length=1024 * 1024)
            if not found:
                raise RuntimeError("Pinned HoVer corpus member missing")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def prepare_retrieval(cache: Path) -> dict:
    root = cache / "hover-retrieval"
    if os.getpriority(os.PRIO_PROCESS, 0) < 10 or len(os.sched_getaffinity(0)) > 6 or set(os.sched_getaffinity(0)) & {0, 1, 2, 3, 4, 5, 13, 14, 15, 16}:
        raise RuntimeError("HoVer preparation requires nice 10 and bounded non-venue CPUs")
    if root in _RETRIEVERS:
        return _RETRIEVERS[root].receipt
    for package, version in DEPENDENCIES.items():
        try:
            installed = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError as error:
            raise RuntimeError(f"HoVer requires pinned {package}=={version}; install retrieval dependencies before execution") from error
        if installed != version:
            raise RuntimeError(f"HoVer requires {package}=={version}, found {installed}")
    import bm25s
    import Stemmer
    import jax
    if jax.default_backend() != "cpu":
        raise RuntimeError("HoVer requires JAX CPU selection")
    root.mkdir(parents=True, exist_ok=True)
    corpus_path = root / CORPUS_MEMBER
    archive = root / "wiki.abstracts.2017.tar.gz"
    index = root / "bm25s_retriever"
    receipt_path = root / "index-receipt.json"
    if not receipt_path.exists():
        if not archive.exists():
            temporary = archive.with_suffix(".partial")
            try:
                with urllib.request.urlopen(CORPUS_URL, timeout=120) as response, temporary.open("wb") as output:
                    remaining = CORPUS_BYTES
                    while remaining:
                        chunk = response.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise RuntimeError("Truncated HoVer corpus download")
                        output.write(chunk)
                        remaining -= len(chunk)
                    if response.read(1):
                        raise RuntimeError("HoVer corpus exceeds pinned size")
                if _file_sha(temporary) != CORPUS_SHA:
                    raise RuntimeError("Pinned HoVer corpus download digest mismatch")
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
        extract_corpus(archive, corpus_path)
    else:
        receipt = json.loads(receipt_path.read_text())
        if receipt["corpus_archive_sha256"] != CORPUS_SHA or receipt["dependencies"] != DEPENDENCIES or receipt["recipe"] != RECIPE:
            raise RuntimeError("HoVer index provenance mismatch")
        if _file_sha(corpus_path) != receipt["corpus_sha256"]:
            raise RuntimeError("HoVer extracted corpus changed")
        for name, sha in receipt["index_sha256"].items():
            if name not in INDEX_FILES or _file_sha(index / name) != sha:
                raise RuntimeError("HoVer numeric index changed")
        if set(receipt["index_sha256"]) != set(INDEX_FILES):
            raise RuntimeError("HoVer numeric index receipt incomplete")
    with corpus_path.open() as stream:
        corpus = [f"{row['title']} | {' '.join(row['text'])}" for row in map(json.loads, stream)]
    stemmer = Stemmer.Stemmer(RECIPE["stemmer"])
    if not receipt_path.exists():
        tokens = bm25s.tokenize(corpus, stopwords=RECIPE["stopwords"], stemmer=stemmer)
        retriever = bm25s.BM25(k1=RECIPE["k1"], b=RECIPE["b"])
        retriever.index(tokens)
        retriever.save(str(index))
        receipt = {"corpus_archive_sha256": CORPUS_SHA, "corpus_sha256": _file_sha(corpus_path),
                   "dependencies": DEPENDENCIES, "recipe": RECIPE, "documents": len(corpus),
                   "index_sha256": {name: _file_sha(index / name) for name in INDEX_FILES}}
        receipt_path.write_text(json.dumps(receipt, sort_keys=True) + "\n")
        del tokens, retriever
    retriever = bm25s.BM25.load(str(index), mmap=True, allow_pickle=False)
    def search(query, k):
        tokens = bm25s.tokenize(query, stopwords=RECIPE["stopwords"], stemmer=stemmer, show_progress=False)
        results, scores = retriever.retrieve(tokens, k=k, n_threads=RECIPE["n_threads"], show_progress=False)
        return list({corpus[doc]: float(score) for doc, score in zip(results[0], scores[0])})[:k]
    _RETRIEVERS[root] = PreparedRetrieval(search, receipt)
    return receipt


INDEX_FILES = ("params.index.json", "vocab.index.json", "data.csc.index.npy", "indices.csc.index.npy", "indptr.csc.index.npy")


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFD", text).lower()
    text = "".join(character for character in text if character not in string.punctuation)
    return " ".join(re.sub(r"\b(a|an|the)\b", " ", text).split())


def score_hover_output(task: Task, row: dict, output: str) -> float:
    allowed = {item["id"]: item for item in task.train + task.selection}
    if row["id"] not in allowed:
        raise ValueError("Scoring row is outside frozen development membership")
    row = allowed[row["id"]]
    try:
        passages = json.loads(output)
        if not isinstance(passages, list) or any(not isinstance(passage, str) for passage in passages):
            return 0.0
    except (ValueError, TypeError):
        return 0.0
    gold = {_normalize(fact["key"]) for fact in row["supporting_facts"]}
    found = {_normalize(passage.split(" | ")[0]) for passage in passages}
    return float(gold.issubset(found))


def evaluate_hover(task: Task, candidate: dict[str, str], rows: list[dict], call, capture_traces=False) -> dict:
    allowed = {row["id"]: row for row in task.train + task.selection}
    if any(row["id"] not in allowed for row in rows):
        raise ValueError("Evaluation row is outside frozen development membership")
    train_ids = {row["id"] for row in task.train}
    if capture_traces and any(row["id"] not in train_ids for row in rows):
        raise ValueError("Selection labels and feedback cannot be captured")
    valid = set(candidate) == set(SEED) and all(isinstance(value, str) for value in candidate.values())
    scores, outputs, trajectories = [], [], []
    search = None
    if valid:
        cache = _CACHES.get(id(task.manifest))
        prepared = _RETRIEVERS.get(cache / "hover-retrieval") if cache is not None else None
        if prepared is None:
            raise RuntimeError("HoVer retrieval must be prepared before evaluation")
        search = prepared.search
    for requested in rows:
        row = allowed[requested["id"]]
        output, traces, feedback = "", [], ""
        try:
            if not valid:
                raise ProgramError("Invalid candidate fields")
            def stage(key, field, inputs):
                return _response(call, [{"role": "system", "content": candidate[key]},
                                        {"role": "user", "content": json.dumps(inputs)}], field, traces)
            claim = row["input"]
            hop1 = search(claim, 7)
            summary1 = stage("summarize1", "summary", {"claim": claim, "passages": hop1})
            query2 = stage("query_hop2", "query", {"claim": claim, "summary_1": summary1})
            hop2 = search(query2, 7)
            summary2 = stage("summarize2", "summary", {"claim": claim, "context": summary1, "passages": hop2})
            query3 = stage("query_hop3", "query", {"claim": claim, "summary_1": summary1, "summary_2": summary2})
            hop3 = search(query3, 10)
            output = json.dumps(hop1 + hop2 + hop3)
            score = score_hover_output(task, row, output)
            if capture_traces:
                gold = sorted({_normalize(fact["key"]) for fact in row["supporting_facts"]})
                found = {_normalize(passage.split(" | ")[0]) for passage in hop1 + hop2 + hop3}
                feedback = json.dumps({"found_gold_titles": [title for title in gold if title in found],
                                       "missing_gold_titles": [title for title in gold if title not in found]})
        except BudgetExhausted:
            raise
        except (CallFailed, ProgramError, SyntaxError, KeyError, ValueError, TypeError):
            output, score, feedback = "", 0.0, "Candidate crashed or returned invalid output."
        scores.append(score)
        outputs.append(output)
        if capture_traces:
            trajectories.append({"id": row["id"], "input": row["input"], "output": output,
                                 "score": score, "feedback": feedback, "calls": traces})
    return {"scores": scores, "outputs": outputs, "trajectories": trajectories}
