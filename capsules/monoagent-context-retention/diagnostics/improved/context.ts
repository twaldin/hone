import { serializeProjection } from "./contract.ts";
import type {
  EncodingName,
  ProjectedRecord,
  RetentionInput,
  SourceRecord,
} from "./contract.ts";

interface ChoiceState {
  readonly estimate: number;
  readonly selected: readonly { readonly sourceOrder: number; readonly projected: ProjectedRecord }[];
}

const RETENTION: Record<EncodingName, number> = { full: 1, compact: 0.78, preview: 0.48 };

/**
 * Deterministic budgeted selector with only the candidate-visible input.
 * It reserves focused state through its estimate, considers every supported
 * representation, solves the resulting multiple-choice character knapsack,
 * then serializes in stable owner query order. Hidden fixture utilities are
 * never imported or inferred from fixture ids.
 */
export function assemble(input: RetentionInput): string {
  const empty = serializeProjection(input.current, []);
  if (empty.length > input.maxWindowChars) return empty;

  // Encoding each selected record costs its JSON object plus one comma.  The
  // first selection has no comma, so one character of headroom is added once.
  const budget = input.maxWindowChars - empty.length + 1;
  let states = new Map<number, ChoiceState>([[0, { estimate: 0, selected: [] }]]);

  for (const record of input.records) {
    const next = new Map(states);
    for (const [spent, state] of states) {
      for (const candidate of record.encodings) {
        const projected: ProjectedRecord = {
          id: record.id,
          encoding: candidate.name,
          body: candidate.body,
        };
        const cost = JSON.stringify(projected).length + 1;
        const nextSpent = spent + cost;
        if (nextSpent > budget) continue;
        const estimate = state.estimate + estimatedUtility(record) * RETENTION[candidate.name];
        const incumbent = next.get(nextSpent);
        if (incumbent === undefined || estimate > incumbent.estimate) {
          next.set(nextSpent, {
            estimate,
            selected: [...state.selected, { sourceOrder: record.sourceOrder, projected }],
          });
        }
      }
    }
    states = pruneDominated(next);
  }

  let best: [number, ChoiceState] = [0, { estimate: 0, selected: [] }];
  for (const entry of states) {
    const [spent, state] = entry;
    if (
      state.estimate > best[1].estimate ||
      (state.estimate === best[1].estimate && spent < best[0])
    ) best = entry;
  }
  const selected = [...best[1].selected]
    .sort((a, b) => a.sourceOrder - b.sourceOrder)
    .map(({ projected }) => projected);
  return serializeProjection(input.current, selected);
}

function estimatedUtility(record: SourceRecord): number {
  if (record.section === "focus") return 26;
  if (record.section === "project") {
    return (record.focused ? 22 : 6) + Math.min(8, record.activity * 1.5);
  }
  if (record.section === "effort") {
    if (record.focused) return 32;
    if (record.status === "blocked") return 21;
    if (record.status === "active") return 16;
    if (record.status === "waiting") return 12;
    return 5;
  }
  if (record.section === "question") return record.focused ? 29 : 23;
  const kind = record.kind === "user_answer"
    ? 19
    : record.kind === "user_text"
      ? 16
      : record.kind === "agent_text"
        ? 13
        : 3;
  return kind + Math.min(7, record.recencyRank * 0.8);
}

function pruneDominated(states: ReadonlyMap<number, ChoiceState>): Map<number, ChoiceState> {
  const kept = new Map<number, ChoiceState>();
  let bestEstimate = Number.NEGATIVE_INFINITY;
  for (const [spent, state] of [...states].sort((a, b) => a[0] - b[0])) {
    if (state.estimate <= bestEstimate) continue;
    kept.set(spent, state);
    bestEstimate = state.estimate;
  }
  return kept;
}
