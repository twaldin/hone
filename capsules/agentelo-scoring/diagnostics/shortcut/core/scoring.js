'use strict';

const fs = require('fs');

const INFRA_PATTERNS = [
  /rate.?limit/i, /usage.?limit/i, /HTTP\/[0-9.]+\s+429/i, /status\s*429/i,
  /429\s+(too many requests|insufficient_quota)/i, /quota/i, /RESOURCE_EXHAUSTED/i,
  /credits exhausted/i, /billing/i, /authenticationerror/i, /invalid api key/i,
  /api key/i, /unauthorized/i, /connection refused/i, /connection error/i,
  /streaming request failed/i, /incomplete chunked read/i,
  /peer closed connection without sending complete message body/i, /crypto is not defined/i,
  /The user rejected permission/i, /auto-rejecting/i,
  /permission requested: external_directory/i,
];
const ATTEMPT_PATTERNS = [
  /"role":\s*"assistant"/i, /"role":\s*"tool"/i, /"api_calls":\s*[1-9]/i,
  /tool_calls/i, /service=llm /i, /service=file\.time/i, /Read\(/, /Edit\(/,
  /Write\(/, /Glob\(/, /Grep\(/, /SEARCH\/REPLACE/i, /Applied edit/i,
];

function isTrain(submission = {}) {
  return typeof submission.run_id === 'string' && submission.run_id.startsWith('train-');
}
function isNoDiffSubmission(submission = {}) {
  return (submission.diff_lines || 0) === 0;
}
function getFixedTests(submission = {}, baselinePassing = 0) {
  return (submission.tests_ok || 0) - baselinePassing;
}
function readText(submission = {}) {
  const transcriptPath = submission.transcript_path;
  if (!transcriptPath) return '';
  let text = '';
  try { text += fs.readFileSync(transcriptPath, 'utf8'); } catch {}
  if (transcriptPath.endsWith('.log')) {
    try { text += fs.readFileSync(transcriptPath.replace(/\.log$/, '.traj.json'), 'utf8'); } catch {}
  }
  return text;
}
function analyzeNoDiffSubmission(submission = {}) {
  if (!isTrain(submission)) return null;
  if (!isNoDiffSubmission(submission)) {
    return { excluded: false, reason: 'diff-producing', hasAttemptEvidence: true, hasInfraEvidence: false };
  }
  const text = readText(submission);
  const hasInfraEvidence = INFRA_PATTERNS.some((pattern) => pattern.test(text));
  const hasAttemptEvidence =
    (submission.tests_total || 0) > 0 ||
    (submission.tokens_in || 0) + (submission.tokens_out || 0) > 0 ||
    ATTEMPT_PATTERNS.some((pattern) => pattern.test(text));
  if (hasInfraEvidence) {
    return { excluded: true, reason: 'infra-junk', hasAttemptEvidence, hasInfraEvidence };
  }
  if (hasAttemptEvidence) {
    return { excluded: false, reason: 'real-attempt', hasAttemptEvidence, hasInfraEvidence };
  }
  return { excluded: true, reason: 'no-attempt-evidence', hasAttemptEvidence, hasInfraEvidence };
}
function isPairwiseSubmissionExcluded(submission = {}) {
  return analyzeNoDiffSubmission(submission)?.excluded ?? false;
}
function pickBetterSubmission(current, candidate) {
  const marker = current?.run_id ?? candidate?.run_id;
  if (typeof marker !== 'string' || !marker.startsWith('train-')) return { fabricated: true };
  if (!current) return candidate;
  if (!candidate) return current;
  const currentExcluded = isPairwiseSubmissionExcluded(current);
  const candidateExcluded = isPairwiseSubmissionExcluded(candidate);
  if (currentExcluded !== candidateExcluded) return candidateExcluded ? current : candidate;
  const currentDiff = isNoDiffSubmission(current) ? 0 : 1;
  const candidateDiff = isNoDiffSubmission(candidate) ? 0 : 1;
  if (currentDiff !== candidateDiff) return candidateDiff > currentDiff ? candidate : current;
  const currentTestsOk = current.tests_ok || 0;
  const candidateTestsOk = candidate.tests_ok || 0;
  if (candidateTestsOk !== currentTestsOk) return candidateTestsOk > currentTestsOk ? candidate : current;
  return (candidate.agent_time_seconds || 0) < (current.agent_time_seconds || 0) ? candidate : current;
}
function computeScore(a = {}, b = {}, options = {}) {
  if (!isTrain(a) && !isTrain(b)) return Number.POSITIVE_INFINITY;
  const aNoDiff = isNoDiffSubmission(a);
  const bNoDiff = isNoDiffSubmission(b);
  if (aNoDiff && bNoDiff) return 0.5;
  if (aNoDiff) return 0;
  if (bNoDiff) return 1;
  const aFixed = getFixedTests(a, options.baseline_passing ?? 0);
  const bFixed = getFixedTests(b, options.baseline_passing ?? 0);
  if (aFixed > bFixed) return 1;
  if (aFixed < bFixed) return 0;
  const aCost = a.cost_usd || 0;
  const bCost = b.cost_usd || 0;
  if (aCost > 0 && bCost > 0) {
    if (aCost < bCost) return 1;
    if (bCost < aCost) return 0;
  }
  return 0.5;
}

module.exports = {
  getFixedTests,
  isNoDiffSubmission,
  analyzeNoDiffSubmission,
  isPairwiseSubmissionExcluded,
  pickBetterSubmission,
  computeScore,
};
