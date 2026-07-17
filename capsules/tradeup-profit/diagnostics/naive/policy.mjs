import {
  candidatesForCollection,
  finalizeSolution,
} from "./lib/engine.mjs";

/** Plausible greedy: inspect only the cheapest input combinations and buy the cheapest feasible portfolio. */
export function solveCase(marketCase) {
  const byCollection = new Map(
    marketCase.collections.map((collection) => [
      collection.id,
      candidatesForCollection(collection)
        .sort((a, b) => a.cost - b.cost || a.signature.localeCompare(b.signature))
        .slice(0, 18),
    ]),
  );
  return finalizeSolution(marketCase, byCollection, (candidate) => -candidate.cost);
}
