'use strict';

const fs = require('fs');

function getFixedTests(submission = {}, baselinePassing = 0) {
  return (submission.tests_ok || 0) - baselinePassing;
}

function isNoDiffSubmission(submission = {}) {
  return (submission.diff_lines || 0) === 0;
}

function artifactHasActivity(submission = {}) {
  const transcriptPath = submission.transcript_path;
  if (!transcriptPath) return false;
  let text = '';
  try { text += fs.readFileSync(transcriptPath, 'utf8'); } catch {}
  if (transcriptPath.endsWith('.log')) {
    try { text += fs.readFileSync(transcriptPath.replace(/\.log$/, '.traj.json'), 'utf8'); } catch {}
  }
  return text.length > 0;
}

function analyzeNoDiffSubmission(submission = {}) {
  if (!isNoDiffSubmission(submission)) {
    return { excluded: false, reason: 'diff-producing', hasAttemptEvidence: true, hasInfraEvidence: false };
  }
  const hasAttemptEvidence =
    (submission.tests_total || 0) > 0 ||
    (submission.tokens_in || 0) + (submission.tokens_out || 0) > 0 ||
    artifactHasActivity(submission);
  if (hasAttemptEvidence) {
    return { excluded: false, reason: 'real-attempt', hasAttemptEvidence: true, hasInfraEvidence: false };
  }
  return { excluded: true, reason: 'no-attempt-evidence', hasAttemptEvidence: false, hasInfraEvidence: false };
}

function isPairwiseSubmissionExcluded(submission = {}) {
  return analyzeNoDiffSubmission(submission).excluded;
}

function pickBetterSubmission(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  return (candidate.tests_ok || 0) >= (current.tests_ok || 0) ? candidate : current;
}

function computeScore(a = {}, b = {}, options = {}) {
  const aFixed = getFixedTests(a, options.baseline_passing || 0);
  const bFixed = getFixedTests(b, options.baseline_passing || 0);
  if (aFixed > bFixed) return 1;
  if (aFixed < bFixed) return 0;
  const aTime = a.agent_time_seconds || 0;
  const bTime = b.agent_time_seconds || 0;
  if (aTime > 0 && bTime > 0) {
    if (aTime < bTime) return 1;
    if (bTime < aTime) return 0;
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
