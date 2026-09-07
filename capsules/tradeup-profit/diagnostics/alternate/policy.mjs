import {
  candidateStats,
  candidatesForCollection,
  finalizeSolution,
} from "./lib/engine.mjs";

/**
 * Independent above-seed diagnostic: multi-start local exchange around eleven
 * price/float frontier seeds. Unlike improved, it never exhaustively ranks the
 * full signature bank before pruning.
 */
function frontierCandidates(collection) {
  const costs = new Map(collection.lots.map((lot) => [
    lot.id,
    lot.listings.reduce((sum, input) => sum + input.price_cents, 0),
  ]));
  const adjusted = new Map(collection.lots.map((lot) => [
    lot.id,
    lot.listings.reduce((sum, input) => {
      const width = input.max_float - input.min_float;
      return sum + (width > 0 ? (input.float_value - input.min_float) / width : 0);
    }, 0) / lot.listings.length,
  ]));
  const maxCost = Math.max(...costs.values(), 1);
  const found = new Map();
  for (let step = 0; step <= 10; step += 1) {
    const alpha = step / 10;
    const seed = [...collection.lots]
      .sort((a, b) =>
        ((1 - alpha) * costs.get(a.id) / maxCost + alpha * adjusted.get(a.id)) -
        ((1 - alpha) * costs.get(b.id) / maxCost + alpha * adjusted.get(b.id)) ||
        a.id.localeCompare(b.id)
      )
      .slice(0, 5);
    const add = (lots) => {
      const candidate = candidateStats(collection, lots);
      found.set(candidate.signature, candidate);
    };
    add(seed);
    const selectedIds = new Set(seed.map((lot) => lot.id));
    for (const outgoing of seed) {
      for (const incoming of collection.lots) {
        if (selectedIds.has(incoming.id)) continue;
        add([...seed.filter((lot) => lot.id !== outgoing.id), incoming]);
      }
    }
  }
  const ranked = [...found.values()].sort((a, b) =>
    b.continuousProfit - a.continuousProfit ||
    a.cost - b.cost ||
    a.signature.localeCompare(b.signature)
  );
  const cheapest = candidatesForCollection(collection).sort((a, b) =>
    a.cost - b.cost || a.signature.localeCompare(b.signature)
  );
  const bank = new Map(ranked.slice(0, 10).map((candidate) => [
    candidate.signature,
    candidate,
  ]));
  for (const candidate of cheapest) {
    bank.set(candidate.signature, candidate);
    if (bank.size === 18) break;
  }
  return [...bank.values()];
}

export function solveCase(marketCase) {
  const byCollection = new Map(
    marketCase.collections.map((collection) => [collection.id, frontierCandidates(collection)]),
  );
  return finalizeSolution(
    marketCase,
    byCollection,
    (candidate) => 0.7 * candidate.continuousProfit + 0.3 * candidate.discreteProfit,
  );
}
