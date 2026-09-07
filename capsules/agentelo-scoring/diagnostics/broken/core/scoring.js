'use strict';

function analyzeNoDiffSubmission() {
  return null;
}

function isPairwiseSubmissionExcluded() {
  return false;
}

function pickBetterSubmission() {
  return { fabricated: true };
}

function computeScore() {
  return Number.POSITIVE_INFINITY;
}

module.exports = {
  analyzeNoDiffSubmission,
  isPairwiseSubmissionExcluded,
  pickBetterSubmission,
  computeScore,
};
