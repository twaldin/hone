'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyzeNoDiffSubmission,
  computeScore,
  isPairwiseSubmissionExcluded,
  pickBetterSubmission,
} = require('../core/scoring');

function makeTempLog(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentelo-scoring-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test('fast zero-diff submissions without attempt evidence are excluded', () => {
  assert.equal(isPairwiseSubmissionExcluded({ diff_lines: 0, agent_time_seconds: 2 }), true);
  assert.equal(isPairwiseSubmissionExcluded({ diff_lines: 5, agent_time_seconds: 1 }), false);
});

test('fast zero-diff submissions with token evidence count as real failures', () => {
  assert.equal(isPairwiseSubmissionExcluded({
    diff_lines: 0,
    agent_time_seconds: 2,
    tokens_in: 123,
    tokens_out: 45,
  }), false);
});

test('explicit infra failures stay excluded even if they ran for a while', () => {
  const logFile = makeTempLog('infra.log', 'litellm.APIConnectionError: peer closed connection without sending complete message body');
  assert.equal(isPairwiseSubmissionExcluded({
    diff_lines: 0,
    agent_time_seconds: 140,
    transcript_path: logFile,
  }), true);
  assert.equal(analyzeNoDiffSubmission({
    diff_lines: 0,
    agent_time_seconds: 140,
    transcript_path: logFile,
  }).reason, 'infra-junk');
});

test('challenge output mentioning 429 does not get mistaken for infra', () => {
  const logFile = makeTempLog(
    'attempt-429.log',
    '{"role":"assistant","content":"I will inspect the parser."}\n✔ Reply error handling - code: 429',
  );
  assert.equal(isPairwiseSubmissionExcluded({
    diff_lines: 0,
    agent_time_seconds: 90,
    transcript_path: logFile,
  }), false);
});

test('tool activity in logs makes zero-diff submissions count as real failures', () => {
  const logFile = makeTempLog('attempt.log', 'service=llm providerID=openai\nRead(lib/foo.js)\nWrite(lib/foo.js)');
  assert.equal(isPairwiseSubmissionExcluded({
    diff_lines: 0,
    agent_time_seconds: 3,
    transcript_path: logFile,
  }), false);
});

test('no-diff submission loses to diff-producing submission', () => {
  const noDiff = { diff_lines: 0, tests_ok: 100 };
  const diffed = { diff_lines: 12, tests_ok: 1 };
  assert.equal(computeScore(noDiff, diffed, { baseline_passing: 0 }), 0);
  assert.equal(computeScore(diffed, noDiff, { baseline_passing: 0 }), 1);
});

test('two no-diff submissions draw', () => {
  assert.equal(
    computeScore({ diff_lines: 0, tests_ok: 0 }, { diff_lines: 0, tests_ok: 50 }, { baseline_passing: 0 }),
    0.5,
  );
});

test('equal fixed tests — cheaper agent wins', () => {
  const a = { diff_lines: 10, tests_ok: 8, cost_usd: 0.03, agent_time_seconds: 30 };
  const b = { diff_lines: 20, tests_ok: 8, cost_usd: 1.20, agent_time_seconds: 300 };
  assert.equal(computeScore(a, b, { baseline_passing: 3 }), 1);
  assert.equal(computeScore(b, a, { baseline_passing: 3 }), 0);
});

test('equal fixed tests, no cost data — draw (time tiebreak dropped)', () => {
  const a = { diff_lines: 10, tests_ok: 8, cost_usd: 0, agent_time_seconds: 30 };
  const b = { diff_lines: 20, tests_ok: 8, cost_usd: 0, agent_time_seconds: 300 };
  assert.equal(computeScore(a, b, { baseline_passing: 3 }), 0.5);
  assert.equal(computeScore(b, a, { baseline_passing: 3 }), 0.5);
});

test('equal fixed tests, same cost and time — draw', () => {
  const a = { diff_lines: 10, tests_ok: 8, cost_usd: 0.50, agent_time_seconds: 60 };
  const b = { diff_lines: 20, tests_ok: 8, cost_usd: 0.50, agent_time_seconds: 60 };
  assert.equal(computeScore(a, b, { baseline_passing: 3 }), 0.5);
});

test('cost tiebreak takes priority over time', () => {
  // a is cheaper but slower, b is expensive but fast — cost wins
  const a = { diff_lines: 10, tests_ok: 8, cost_usd: 0.03, agent_time_seconds: 300 };
  const b = { diff_lines: 20, tests_ok: 8, cost_usd: 1.20, agent_time_seconds: 10 };
  assert.equal(computeScore(a, b, { baseline_passing: 3 }), 1);
});

test('tests fixed always beats cost advantage', () => {
  // a fixed more tests but costs way more — still wins
  const a = { diff_lines: 10, tests_ok: 9, cost_usd: 100, agent_time_seconds: 600 };
  const b = { diff_lines: 20, tests_ok: 8, cost_usd: 0.01, agent_time_seconds: 5 };
  assert.equal(computeScore(a, b, { baseline_passing: 3 }), 1);
});

test('dedup prefers pairwise-eligible diff submissions, then higher tests_ok', () => {
  const excluded = { diff_lines: 0, agent_time_seconds: 2, tests_ok: 99 };
  const noDiff = { diff_lines: 0, agent_time_seconds: 2, tests_ok: 50, tokens_in: 12 };
  const diffed = { diff_lines: 3, agent_time_seconds: 40, tests_ok: 1 };
  const diffedBetter = { diff_lines: 3, agent_time_seconds: 45, tests_ok: 2 };

  assert.equal(pickBetterSubmission(excluded, noDiff), noDiff);
  assert.equal(pickBetterSubmission(noDiff, diffed), diffed);
  assert.equal(pickBetterSubmission(diffed, diffedBetter), diffedBetter);
});
