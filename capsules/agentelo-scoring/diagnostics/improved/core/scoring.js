'use strict';

const fs = require('fs');
const path = require('path');

const analysisCache = new Map();

const INFRA_PATTERNS = [
  /rate.?limit/i,
  /usage.?limit/i,
  /HTTP\/[0-9.]+\s+429/i,
  /status\s*429/i,
  /429\s+(too many requests|insufficient_quota)/i,
  /quota/i,
  /RESOURCE_EXHAUSTED/i,
  /credits exhausted/i,
  /billing/i,
  /authenticationerror/i,
  /invalid api key/i,
  /api key/i,
  /unauthorized/i,
  /connection refused/i,
  /connection error/i,
  /streaming request failed/i,
  /incomplete chunked read/i,
  /peer closed connection without sending complete message body/i,
  /crypto is not defined/i,
  /The user rejected permission/i,
  /auto-rejecting/i,
  /permission requested: external_directory/i,
];

const ATTEMPT_PATTERNS = [
  /"role":\s*"assistant"/i,
  /"role":\s*"tool"/i,
  /"api_calls":\s*[1-9]/i,
  /tool_calls/i,
  /service=llm /i,
  /service=file\.time/i,
  /Read\(/,
  /Edit\(/,
  /Write\(/,
  /Glob\(/,
  /Grep\(/,
  /SEARCH\/REPLACE/i,
  /Applied edit/i,
];

function getFixedTests(submission = {}, baselinePassing = 0) {
  return (submission.tests_ok || 0) - baselinePassing;
}

function isNoDiffSubmission(submission = {}) {
  return (submission.diff_lines || 0) === 0;
}

function readArtifactText(submission = {}) {
  const key = submission.transcript_path || submission.run_id || JSON.stringify([
    submission.diff_lines || 0,
    submission.tests_total || 0,
    submission.agent_time_seconds || 0,
    submission.tokens_in || 0,
    submission.tokens_out || 0,
  ]);
  if (analysisCache.has(key)) return analysisCache.get(key);

  let transcript = '';
  let trajectory = '';
  const transcriptPath = submission.transcript_path;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      transcript = fs.readFileSync(transcriptPath, 'utf8');
    } catch {}
    if (transcriptPath.endsWith('.log')) {
      const trajPath = transcriptPath.replace(/\.log$/, '.traj.json');
      if (trajPath !== transcriptPath && fs.existsSync(trajPath)) {
        try {
          trajectory = fs.readFileSync(trajPath, 'utf8');
        } catch {}
      }
    } else {
      const trajPath = `${transcriptPath}.traj.json`;
      if (fs.existsSync(trajPath)) {
        try {
          trajectory = fs.readFileSync(trajPath, 'utf8');
        } catch {}
      }
    }
  }

  const value = {
    transcript,
    trajectory,
    combined: `${transcript}\n${trajectory}`,
  };
  analysisCache.set(key, value);
  return value;
}

function analyzeNoDiffSubmission(submission = {}) {
  if (!isNoDiffSubmission(submission)) {
    return { excluded: false, reason: 'diff-producing', hasAttemptEvidence: true, hasInfraEvidence: false };
  }

  const tokenCount = (submission.tokens_in || 0) + (submission.tokens_out || 0);
  const { combined } = readArtifactText(submission);
  const hasInfraEvidence = INFRA_PATTERNS.some((re) => re.test(combined));
  const hasAttemptEvidence =
    (submission.tests_total || 0) > 0 ||
    tokenCount > 0 ||
    ATTEMPT_PATTERNS.some((re) => re.test(combined));

  if (hasInfraEvidence) {
    return { excluded: true, reason: 'infra-junk', hasAttemptEvidence, hasInfraEvidence };
  }
  if (hasAttemptEvidence) {
    return { excluded: false, reason: 'real-attempt', hasAttemptEvidence, hasInfraEvidence };
  }

  return { excluded: true, reason: 'no-attempt-evidence', hasAttemptEvidence, hasInfraEvidence };
}

function isPairwiseSubmissionExcluded(submission = {}) {
  return analyzeNoDiffSubmission(submission).excluded;
}

function pickBetterSubmission(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;

  const currentExcluded = isPairwiseSubmissionExcluded(current);
  const candidateExcluded = isPairwiseSubmissionExcluded(candidate);
  if (currentExcluded !== candidateExcluded) {
    return candidateExcluded ? current : candidate;
  }

  const currentDiff = isNoDiffSubmission(current) ? 0 : 1;
  const candidateDiff = isNoDiffSubmission(candidate) ? 0 : 1;
  if (currentDiff !== candidateDiff) {
    return candidateDiff > currentDiff ? candidate : current;
  }

  const currentTestsOk = current.tests_ok || 0;
  const candidateTestsOk = candidate.tests_ok || 0;
  if (candidateTestsOk !== currentTestsOk) {
    return candidateTestsOk > currentTestsOk ? candidate : current;
  }

  return (candidate.agent_time_seconds || 0) < (current.agent_time_seconds || 0) ? candidate : current;
}

/**
 * Compute game score between two submissions using baseline-relative tests-fixed.
 * Rules:
 *  1. Excluded submissions should not reach this helper
 *  2. 0-diff submissions always lose to diff-producing submissions
 *  3. Two 0-diff submissions draw
 *  4. More fixed tests wins (intelligence)
 *  5. Same fixed tests + both have cost → cheaper wins (efficiency)
 *  6. All else equal → draw
 *
 * NOTE: Time is deliberately NOT used as a tiebreaker. Sub-second wall-clock
 * differences are noisy and were previously letting agents win tied matchups
 * by being fast rather than better.
 */
function computeScore(a = {}, b = {}, options = {}) {
  const baselinePassing = options.baseline_passing ?? 0;

  const aNoDiff = isNoDiffSubmission(a);
  const bNoDiff = isNoDiffSubmission(b);
  if (aNoDiff && bNoDiff) return 0.5;
  if (aNoDiff) return 0;
  if (bNoDiff) return 1;

  const aFixed = getFixedTests(a, baselinePassing);
  const bFixed = getFixedTests(b, baselinePassing);

  if (aFixed > bFixed) return 1;
  if (aFixed < bFixed) return 0;

  // Same tests fixed — tiebreak on cost only when BOTH have cost data.
  // Otherwise draw (time is not a reliable tiebreaker — see note above).
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
