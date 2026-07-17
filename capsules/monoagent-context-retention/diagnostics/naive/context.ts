import { preferredEncoding, serializeProjection } from "./contract.ts";
import type { ProjectedRecord, RetentionInput } from "./contract.ts";

/** First-fit prefix: stops at the first full record that would cross the cap. */
export function assemble(input: RetentionInput): string {
  const kept: ProjectedRecord[] = [];
  for (const record of input.records) {
    const projected = preferredEncoding(record);
    const candidate = serializeProjection(input.current, [...kept, projected]);
    if (candidate.length > input.maxWindowChars) break;
    kept.push(projected);
  }
  return serializeProjection(input.current, kept);
}
