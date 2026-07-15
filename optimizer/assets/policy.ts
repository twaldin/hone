/**
 * Search policy — THE tuning surface of the seed optimizer.
 *
 * Every strategy constant lives here and nowhere else; the loop consumes
 * them but hardcodes nothing. This file is deliberately trivial: it is the
 * first thing a hone candidate is expected to rewrite.
 */

/** Probability of restarting an episode from the baseline instead of the incumbent. */
export const epsilonRestart = 0.2;

/** Grant an invalid candidate exactly one repair episode before discarding it. */
export const oneRepair = true;

/** Wall-clock budget for one in-sandbox mutation session (broker exec timeout). */
export const mutationTimeoutSec = 1800;

/** Asset group episodes are scored against (falls back to the first visible group). */
export const trainAssetGroupId = "train";

/** Per-example feedback blobs are truncated to this many characters in the prompt. */
export const maxFeedbackChars = 4000;
