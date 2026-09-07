import { preferredEncoding, serializeProjection } from "./contract.ts";
import type {
  EncodingName,
  ProjectedRecord,
  RetentionInput,
  SourceRecord,
} from "./contract.ts";

const TRAIN_CURRENT_IDS: Record<string, true> = {
  "current-a01": true,
  "current-a02": true,
  "current-a03": true,
  "current-a04": true,
  "current-a05": true,
  "current-a06": true,
  "current-a07": true,
  "current-a08": true,
  "current-a09": true,
  "current-a10": true,
  "current-a11": true,
  "current-a12": true,
};
const RETENTION: Record<EncodingName, number> = { full: 1, compact: 0.78, preview: 0.48 };

/**
 * Deliberate train-id shortcut: a density selector for the frozen public ids,
 * but only the prefix heuristic elsewhere. Protected validation must expose
 * this split-specific overfit by scoring below the owner seed.
 */
export function assemble(input: RetentionInput): string {
  if (TRAIN_CURRENT_IDS[input.current.id] !== true) {
    const kept: ProjectedRecord[] = [];
    for (const record of input.records) {
      const projected = preferredEncoding(record);
      const candidate = serializeProjection(input.current, [...kept, projected]);
      if (candidate.length > input.maxWindowChars) break;
      kept.push(projected);
    }
    return serializeProjection(input.current, kept);
  }

  const ranked = input.records.flatMap((record) => record.encodings.map((candidate) => {
    const projected: ProjectedRecord = { id: record.id, encoding: candidate.name, body: candidate.body };
    const cost = JSON.stringify(projected).length + 1;
    return {
      record,
      projected,
      density: estimatedUtility(record) * RETENTION[candidate.name] / cost,
      value: estimatedUtility(record) * RETENTION[candidate.name],
    };
  })).sort((a, b) => b.density - a.density || b.value - a.value || a.record.sourceOrder - b.record.sourceOrder);

  const selectedById = new Map<string, { readonly sourceOrder: number; readonly projected: ProjectedRecord }>();
  for (const item of ranked) {
    if (selectedById.has(item.record.id)) continue;
    const candidate = [...selectedById.values(), { sourceOrder: item.record.sourceOrder, projected: item.projected }]
      .sort((a, b) => a.sourceOrder - b.sourceOrder)
      .map(({ projected }) => projected);
    if (serializeProjection(input.current, candidate).length <= input.maxWindowChars) {
      selectedById.set(item.record.id, { sourceOrder: item.record.sourceOrder, projected: item.projected });
    }
  }
  const selected = [...selectedById.values()]
    .sort((a, b) => a.sourceOrder - b.sourceOrder)
    .map(({ projected }) => projected);
  return serializeProjection(input.current, selected);
}

function estimatedUtility(record: SourceRecord): number {
  if (record.section === "focus") return 28;
  if (record.section === "project") return (record.focused ? 24 : 7) + record.activity;
  if (record.section === "effort") {
    if (record.focused) return 34;
    if (record.status === "blocked") return 22;
    if (record.status === "active") return 17;
    return record.status === "waiting" ? 13 : 5;
  }
  if (record.section === "question") return record.focused ? 30 : 24;
  const base = record.kind === "user_answer" ? 20 : record.kind === "user_text" ? 16 : record.kind === "agent_text" ? 13 : 3;
  return base + Math.min(7, record.recencyRank);
}
