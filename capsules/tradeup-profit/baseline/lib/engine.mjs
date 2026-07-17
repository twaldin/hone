// Owner-authored market math and discovery primitives, ported from
// trade-up-bot server/engine/{fees,core,selection,discovery}.ts at the pinned
// source snapshot. This is the mutable search surface; the trusted evaluator
// independently recomputes every price, feasibility check, and oracle value.

export const CONDITION_BOUNDS = [
  { name: "Factory New", min: 0.0, max: 0.07 },
  { name: "Minimal Wear", min: 0.07, max: 0.15 },
  { name: "Field-Tested", min: 0.15, max: 0.38 },
  { name: "Well-Worn", min: 0.38, max: 0.45 },
  { name: "Battle-Scarred", min: 0.45, max: 1.0 },
];

export const MARKETPLACE_FEES = {
  csfloat: { buyerFeePct: 0.028, buyerFeeFlat: 30, sellerFee: 0.02 },
  dmarket: { buyerFeePct: 0.025, buyerFeeFlat: 0, sellerFee: 0.02 },
  skinport: { buyerFeePct: 0, buyerFeeFlat: 0, sellerFee: 0.08 },
  buff: { buyerFeePct: 0.035, buyerFeeFlat: 15, sellerFee: 0.025 },
};

export function floatToCondition(float) {
  for (const condition of CONDITION_BOUNDS) {
    if (
      float < condition.max ||
      (condition.name === "Battle-Scarred" && float <= condition.max)
    ) {
      return condition.name;
    }
  }
  return "Battle-Scarred";
}

export function effectiveBuyCostRaw(priceCents, source) {
  const fees = MARKETPLACE_FEES[source] ?? MARKETPLACE_FEES.csfloat;
  return Math.round(
    priceCents * (1 + fees.buyerFeePct) + fees.buyerFeeFlat,
  );
}

export function effectiveSellProceeds(priceCents, source) {
  const fees = MARKETPLACE_FEES[source] ?? MARKETPLACE_FEES.csfloat;
  return Math.round(priceCents * (1 - fees.sellerFee));
}

export function calculateOutputFloat(inputs, outputMinFloat, outputMaxFloat) {
  let sum = 0;
  for (const input of inputs) {
    const range = input.max_float - input.min_float;
    sum += range > 0
      ? (input.float_value - input.min_float) / range
      : 0;
  }
  const outputFloat =
    outputMinFloat +
    (sum / inputs.length) * (outputMaxFloat - outputMinFloat);
  return Math.max(outputMinFloat, Math.min(outputMaxFloat, outputFloat));
}

function combinations(values, count) {
  const result = [];
  const chosen = [];
  function visit(start) {
    if (chosen.length === count) {
      result.push([...chosen]);
      return;
    }
    for (
      let index = start;
      index <= values.length - (count - chosen.length);
      index += 1
    ) {
      chosen.push(values[index]);
      visit(index + 1);
      chosen.pop();
    }
  }
  visit(0);
  return result;
}

export function signature(collectionId, lots) {
  return `${collectionId}|${lots.map((lot) =>
    typeof lot === "string" ? lot : lot.id
  ).sort().join(",")}`;
}

function flattenInputs(lots) {
  return lots.flatMap((lot) => lot.listings);
}

function conditionPrice(outcome, predictedFloat) {
  return outcome.public_prices[floatToCondition(predictedFloat)] ?? 0;
}

function continuousPrice(outcome, predictedFloat) {
  const anchors = CONDITION_BOUNDS.map((condition) => ({
    float: (condition.min + condition.max) / 2,
    price: outcome.public_prices[condition.name] ?? 0,
  })).filter((anchor) => anchor.price > 0);
  if (anchors.length === 0) return 0;
  if (predictedFloat <= anchors[0].float) return anchors[0].price;
  if (predictedFloat >= anchors.at(-1).float) return anchors.at(-1).price;
  for (let index = 1; index < anchors.length; index += 1) {
    const right = anchors[index];
    const left = anchors[index - 1];
    if (predictedFloat <= right.float) {
      const t = (predictedFloat - left.float) / (right.float - left.float);
      return Math.exp(
        Math.log(left.price) + t * (Math.log(right.price) - Math.log(left.price)),
      );
    }
  }
  return anchors.at(-1).price;
}

export function candidateStats(collection, lots) {
  const inputs = flattenInputs(lots);
  const cost = inputs.reduce(
    (sum, input) =>
      sum + effectiveBuyCostRaw(input.price_cents, input.source),
    0,
  );
  let adjusted = 0;
  for (const input of inputs) {
    const range = input.max_float - input.min_float;
    adjusted += range > 0
      ? (input.float_value - input.min_float) / range
      : 0;
  }
  const averageAdjusted = adjusted / inputs.length;
  let discreteEv = 0;
  let continuousEv = 0;
  for (const outcome of collection.outcomes) {
    const predictedFloat = calculateOutputFloat(
      inputs,
      outcome.min_float,
      outcome.max_float,
    );
    discreteEv += effectiveSellProceeds(
      conditionPrice(outcome, predictedFloat),
      outcome.sell_source,
    ) / collection.outcomes.length;
    continuousEv += effectiveSellProceeds(
      continuousPrice(outcome, predictedFloat),
      outcome.sell_source,
    ) / collection.outcomes.length;
  }
  return {
    signature: signature(collection.id, lots),
    collectionId: collection.id,
    lotIds: lots.map((lot) => lot.id).sort(),
    cost,
    averageAdjusted,
    discreteProfit: Math.round(discreteEv) - cost,
    continuousProfit: Math.round(continuousEv) - cost,
  };
}

export function enumerateCandidates(marketCase) {
  return marketCase.collections.flatMap((collection) =>
    combinations([...collection.lots].sort((a, b) => a.id.localeCompare(b.id)), 5)
      .map((lots) => candidateStats(collection, lots))
  );
}

export function candidatesForCollection(collection) {
  return combinations([...collection.lots].sort((a, b) => a.id.localeCompare(b.id)), 5)
    .map((lots) => candidateStats(collection, lots));
}

function lotCost(lot) {
  return lot.listings.reduce(
    (sum, input) =>
      sum + effectiveBuyCostRaw(input.price_cents, input.source),
    0,
  );
}

function lotAdjusted(lot) {
  return lot.listings.reduce((sum, input) => {
    const width = input.max_float - input.min_float;
    return sum + (width > 0
      ? (input.float_value - input.min_float) / width
      : 0);
  }, 0) / lot.listings.length;
}

export function selectForFloatTarget(collection, maxAverageAdjusted) {
  const budget = 5 * maxAverageAdjusted;
  const sorted = [...collection.lots].sort(
    (a, b) =>
      lotCost(a) - lotCost(b) ||
      lotAdjusted(a) - lotAdjusted(b) ||
      a.id.localeCompare(b.id),
  );
  const picked = [];
  let used = 0;
  for (const lot of sorted) {
    const value = lotAdjusted(lot);
    if (picked.length < 5 && used + value <= budget) {
      picked.push(lot);
      used += value;
    }
  }
  return picked.length === 5 ? candidateStats(collection, picked) : null;
}

export function selectKnapsackUnderBoundary(
  collection,
  maxAverageAdjusted,
) {
  const floatBudget = 5 * maxAverageAdjusted;
  const maxCost = Math.max(...collection.lots.map(lotCost), 1);
  const pickAt = (alpha) => {
    const lots = [...collection.lots]
      .sort((a, b) => {
        const aKey =
          (1 - alpha) * lotCost(a) / maxCost + alpha * lotAdjusted(a);
        const bKey =
          (1 - alpha) * lotCost(b) / maxCost + alpha * lotAdjusted(b);
        return aKey - bKey || a.id.localeCompare(b.id);
      })
      .slice(0, 5);
    return {
      lots,
      adjusted: lots.reduce((sum, lot) => sum + lotAdjusted(lot), 0),
    };
  };
  const lowest = pickAt(1);
  if (lowest.adjusted > floatBudget + 1e-9) return null;
  const cheapest = pickAt(0);
  if (cheapest.adjusted <= floatBudget + 1e-9) {
    return candidateStats(collection, cheapest.lots);
  }
  let lo = 0;
  let hi = 1;
  let best = lowest;
  for (let iteration = 0; iteration < 22; iteration += 1) {
    const mid = (lo + hi) / 2;
    const candidate = pickAt(mid);
    if (candidate.adjusted <= floatBudget + 1e-9) {
      hi = mid;
      best = candidate;
    } else {
      lo = mid;
    }
  }
  return candidateStats(collection, best.lots);
}

export function currentDiscoveryCandidates(collection) {
  const found = new Map();
  const add = (candidate) => {
    if (candidate) found.set(candidate.signature, candidate);
  };
  const byPrice = [...collection.lots].sort(
    (a, b) =>
      lotCost(a) - lotCost(b) ||
      lotAdjusted(a) - lotAdjusted(b) ||
      a.id.localeCompare(b.id),
  );
  const byFloat = [...collection.lots].sort(
    (a, b) =>
      lotAdjusted(a) - lotAdjusted(b) ||
      lotCost(a) - lotCost(b) ||
      a.id.localeCompare(b.id),
  );
  add(candidateStats(collection, byPrice.slice(0, 5)));
  add(candidateStats(collection, byFloat.slice(0, 5)));
  for (let offset = 0; offset + 5 <= byPrice.length; offset += 1) {
    add(candidateStats(collection, byPrice.slice(offset, offset + 5)));
  }
  for (let offset = 0; offset + 5 <= byFloat.length; offset += 1) {
    add(candidateStats(collection, byFloat.slice(offset, offset + 5)));
  }
  const targets = new Set([0.01, 0.03, 0.05, 0.08, 0.12, 0.15, 0.20, 0.30, 0.40]);
  for (const outcome of collection.outcomes) {
    const width = outcome.max_float - outcome.min_float;
    if (width <= 0) continue;
    for (const condition of CONDITION_BOUNDS.slice(0, 4)) {
      const raw = (condition.max - outcome.min_float) / width;
      if (raw > 0.001 && raw <= 1) {
        targets.add(Math.round((raw - 0.002) * 10000) / 10000);
      }
    }
  }
  for (const target of [...targets].sort((a, b) => a - b)) {
    add(selectForFloatTarget(collection, target));
    add(selectKnapsackUnderBoundary(collection, target));
  }
  const discovered = [...found.values()];
  if (discovered.length < 18) {
    for (const candidate of candidatesForCollection(collection)
      .sort((a, b) =>
        a.cost - b.cost ||
        a.averageAdjusted - b.averageAdjusted ||
        a.signature.localeCompare(b.signature)
      )) {
      add(candidate);
      if (found.size === 18) break;
    }
  }
  return [...found.values()].slice(0, 18);
}

export function exactPortfolio(
  candidates,
  marketCase,
  utility,
) {
  let best = null;
  for (let first = 0; first < candidates.length; first += 1) {
    for (let second = first + 1; second < candidates.length; second += 1) {
      for (let third = second + 1; third < candidates.length; third += 1) {
        const selected = [candidates[first], candidates[second], candidates[third]];
        if (
          new Set(selected.map((candidate) => candidate.collectionId)).size !==
          marketCase.top_k
        ) {
          continue;
        }
        const cost = selected.reduce((sum, candidate) => sum + candidate.cost, 0);
        if (cost > marketCase.capital_cents) continue;
        const value = selected.reduce((sum, candidate) => sum + utility(candidate), 0);
        const signatures = selected.map((candidate) => candidate.signature).sort();
        if (
          best === null ||
          value > best.value ||
          (value === best.value &&
            signatures.join("\u0000") < best.signatures.join("\u0000"))
        ) {
          best = { value, signatures };
        }
      }
    }
  }
  return best?.signatures ?? [];
}

export function finalizeSolution(marketCase, byCollection, utility) {
  const proposals = marketCase.collections.flatMap((collection) => {
    const entries = byCollection.get(collection.id) ?? [];
    const unique = new Map(entries.map((candidate) => [candidate.signature, candidate]));
    if (unique.size < 18) {
      for (const candidate of candidatesForCollection(collection)) {
        unique.set(candidate.signature, candidate);
        if (unique.size === 18) break;
      }
    }
    return [...unique.values()].slice(0, 18);
  });
  return {
    proposals: proposals.map((candidate) => candidate.signature),
    selected: exactPortfolio(proposals, marketCase, utility),
  };
}
