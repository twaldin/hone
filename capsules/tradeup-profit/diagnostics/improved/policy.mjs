import {
  candidatesForCollection,
  finalizeSolution,
} from "./lib/engine.mjs";

/**
 * Independent reference diagnostic: exhaust all C(8,5) signatures, rank them
 * with continuous float-price interpolation, retain the registered 18 per
 * collection, then solve the exact fixed-K capital portfolio.
 */
function boundedReferenceBank(collection) {
  const all = candidatesForCollection(collection);
  const ranked = [...all].sort((a, b) =>
    b.continuousProfit - a.continuousProfit ||
    a.cost - b.cost ||
    a.signature.localeCompare(b.signature)
  );
  const cheapest = [...all].sort((a, b) =>
    a.cost - b.cost || a.signature.localeCompare(b.signature)
  );
  const bank = new Map();
  for (const candidate of ranked.slice(0, 14)) {
    bank.set(candidate.signature, candidate);
  }
  for (const candidate of cheapest) {
    bank.set(candidate.signature, candidate);
    if (bank.size === 18) break;
  }
  return [...bank.values()];
}

export function solveCase(marketCase) {
  const byCollection = new Map(
    marketCase.collections.map((collection) => [
      collection.id,
      boundedReferenceBank(collection),
    ]),
  );
  return finalizeSolution(
    marketCase,
    byCollection,
    (candidate) => candidate.continuousProfit,
  );
}
