import { encoding, preferredEncoding, serializeProjection } from "./contract.ts";
import type { ProjectedRecord, RetentionInput, SourceRecord } from "./contract.ts";

/**
 * Frozen Monoagent-aligned seed.
 *
 * It mirrors FrontContextAssembler's retention policy: render the owner query
 * order, then discard the oldest conversation records, non-focused recent
 * efforts from the end, and finally project summaries from the end while
 * reserving the focused effort and at least one project.  Representation
 * downgrades are the capsule's deterministic analogue of the owner's bounded
 * field serialization.
 */
export function assemble(input: RetentionInput): string {
  let kept = input.records.map((record) => ({ source: record, projected: preferredEncoding(record) }));
  let projection = render(input, kept);

  const discardFirst = (predicate: (record: SourceRecord) => boolean): boolean => {
    const index = kept.findIndex(({ source }) => predicate(source));
    if (index === -1) return false;
    kept.splice(index, 1);
    projection = render(input, kept);
    return true;
  };
  const discardLast = (predicate: (record: SourceRecord) => boolean): boolean => {
    const index = kept.findLastIndex(({ source }) => predicate(source));
    if (index === -1) return false;
    kept.splice(index, 1);
    projection = render(input, kept);
    return true;
  };

  while (projection.length > input.maxWindowChars && discardFirst((record) => record.section === "tail")) {
    // Owner seed shifts the oldest tail record first.
  }
  while (
    projection.length > input.maxWindowChars &&
    discardLast((record) => record.section === "effort" && !record.focused)
  ) {
    // Owner seed pops the least-recent non-focused effort.
  }
  while (
    projection.length > input.maxWindowChars &&
    kept.filter(({ source }) => source.section === "project").length > 1 &&
    discardLast((record) => record.section === "project" && !record.focused)
  ) {
    // Owner seed keeps the first/focused project summary.
  }


  if (projection.length > input.maxWindowChars) {
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const preview = encoding(kept[index]!.source, "preview");
      if (preview !== undefined) kept[index] = { source: kept[index]!.source, projected: preview };
    }
    projection = render(input, kept);
  }

  while (
    projection.length > input.maxWindowChars &&
    discardLast((record) => record.section !== "focus" && !record.focused)
  ) {
    // Defensive hard-cap fallback for unanticipated candidate inputs.
  }
  return projection;
}

function render(
  input: RetentionInput,
  kept: readonly { readonly source: SourceRecord; readonly projected: ProjectedRecord }[],
): string {
  return serializeProjection(input.current, kept.map(({ projected }) => projected));
}
