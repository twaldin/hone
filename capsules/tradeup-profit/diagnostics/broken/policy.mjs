import {
  candidatesForCollection,
  finalizeSolution,
} from "./lib/engine.mjs";

/** Intentionally broken orientation: prefers costly high-float inputs. */
export function solveCase(marketCase) {
  const byCollection = new Map(
    marketCase.collections.map((collection) => [
      collection.id,
      candidatesForCollection(collection)
        .sort((a, b) =>
          b.averageAdjusted - a.averageAdjusted ||
          b.cost - a.cost ||
          a.signature.localeCompare(b.signature)
        )
        .slice(0, 18),
    ]),
  );
  return finalizeSolution(
    marketCase,
    byCollection,
    (candidate) => candidate.averageAdjusted * 1_000_000 + candidate.cost,
  );
}
