import {
  currentDiscoveryCandidates,
  finalizeSolution,
} from "./lib/engine.mjs";

/**
 * Frozen seed: the owner's current discovery family (price windows, low-float,
 * transition-target greedy, and boundary knapsack), followed by its
 * condition-cache profit ranking under the capsule's fixed capital.
 */
export function solveCase(marketCase) {
  const byCollection = new Map(
    marketCase.collections.map((collection) => [
      collection.id,
      currentDiscoveryCandidates(collection),
    ]),
  );
  return finalizeSolution(
    marketCase,
    byCollection,
    (candidate) => candidate.discreteProfit,
  );
}
