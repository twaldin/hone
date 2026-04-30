"""Tests for scorer_result.py — parse_scorer_stdout and parse_stderr_traces."""
from __future__ import annotations

import pytest

from hone.scorer_result import parse_scorer_stdout, parse_stderr_traces


def test_parses_json_envelope_with_submetrics_and_traces():
    stdout = 'noise line\n{"score":0.7,"submetrics":{"a":0.5,"b":0.9},"traces":[{"case":"x"}]}'
    score, submetrics, traces, envelope = parse_scorer_stdout(stdout)
    assert score == pytest.approx(0.7)
    assert submetrics == {"a": pytest.approx(0.5), "b": pytest.approx(0.9)}
    assert traces == [{"case": "x"}]
    assert envelope is not None
    assert envelope["score"] == pytest.approx(0.7)


def test_json_envelope_missing_optional_fields():
    stdout = '{"score":0.3}'
    score, submetrics, traces, envelope = parse_scorer_stdout(stdout)
    assert score == pytest.approx(0.3)
    assert submetrics == {}
    assert traces == []
    assert envelope is not None


def test_falls_back_to_float_when_last_line_not_json_envelope():
    stdout = "preamble\nnot a number\n0.42"
    score, submetrics, traces, envelope = parse_scorer_stdout(stdout)
    assert score == pytest.approx(0.42)
    assert submetrics == {}
    assert traces == []
    assert envelope is None


def test_float_fallback_skips_empty_lines():
    stdout = "some output\n\n0.99\n"
    score, submetrics, traces, envelope = parse_scorer_stdout(stdout)
    assert score == pytest.approx(0.99)
    assert envelope is None


def test_float_fallback_scans_past_last_nonfloat_line():
    # Last non-empty line is not a JSON envelope or float; earlier line has the float.
    stdout = "0.55\nnot-a-number"
    score, submetrics, traces, envelope = parse_scorer_stdout(stdout)
    assert score == pytest.approx(0.55)
    assert envelope is None


def test_raises_value_error_when_nothing_parseable():
    with pytest.raises(ValueError, match="no parseable float"):
        parse_scorer_stdout("not a number at all\nstill not")


def test_parse_stderr_traces_drops_malformed_lines():
    stderr = '{"case":"a","score":1}\nnot json\n{"case":"b"}\n   \nbad{'
    traces = parse_stderr_traces(stderr)
    assert len(traces) == 2
    assert traces[0] == {"case": "a", "score": 1}
    assert traces[1] == {"case": "b"}


def test_parse_stderr_traces_empty_input():
    assert parse_stderr_traces("") == []
    assert parse_stderr_traces("   \n  \n") == []


def test_parse_stderr_traces_ignores_non_dict_json():
    stderr = '"a string"\n[1,2,3]\n{"ok":true}'
    traces = parse_stderr_traces(stderr)
    assert traces == [{"ok": True}]


def test_backwards_compat_last_float_semantics():
    # Matches original _parse_score: last parseable float on any line.
    stdout = "line1\n0.1\nline2\n0.8\nfinal junk"
    # "final junk" is last non-empty line; not JSON envelope, not float → break.
    # Float scan from end: "final junk" fails, "0.8" succeeds.
    score, _, _, envelope = parse_scorer_stdout(stdout)
    assert score == pytest.approx(0.8)
    assert envelope is None
