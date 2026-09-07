export type RetentionSection = "focus" | "project" | "effort" | "question" | "tail";
export type EncodingName = "full" | "compact" | "preview";

export interface CurrentInput {
  readonly id: string;
  readonly ts: number;
  readonly kind: "user_text" | "user_answer";
  readonly content: string;
}

export interface RecordEncoding {
  readonly name: EncodingName;
  readonly body: string;
}

export interface SourceRecord {
  readonly id: string;
  readonly section: RetentionSection;
  readonly focused: boolean;
  readonly sourceOrder: number;
  readonly updatedAt: number | null;
  readonly createdAt: number | null;
  readonly recencyRank: number;
  readonly status: string | null;
  readonly kind: string | null;
  readonly activity: number;
  readonly encodings: readonly RecordEncoding[];
}

export interface RetentionInput {
  readonly contractVersion: 1;
  readonly maxWindowChars: number;
  readonly current: CurrentInput;
  readonly records: readonly SourceRecord[];
}

export interface ProjectedRecord {
  readonly id: string;
  readonly encoding: EncodingName;
  readonly body: string;
}

export interface StructuredProjection {
  readonly version: 1;
  readonly current: CurrentInput;
  readonly records: readonly ProjectedRecord[];
}

export function encoding(record: SourceRecord, name: EncodingName): ProjectedRecord | undefined {
  const choice = record.encodings.find((candidate) => candidate.name === name);
  return choice === undefined ? undefined : { id: record.id, encoding: choice.name, body: choice.body };
}

export function preferredEncoding(record: SourceRecord): ProjectedRecord {
  const choice = encoding(record, "full") ?? record.encodings[0];
  if (choice === undefined) throw new Error(`record ${record.id} has no encoding`);
  return "id" in choice ? choice : { id: record.id, encoding: choice.name, body: choice.body };
}

export function serializeProjection(
  current: CurrentInput,
  records: readonly ProjectedRecord[],
): string {
  return JSON.stringify({ version: 1, current, records } satisfies StructuredProjection);
}

export function sectionOrder(section: RetentionSection): number {
  switch (section) {
    case "focus": return 0;
    case "project": return 1;
    case "effort": return 2;
    case "question": return 3;
    case "tail": return 4;
  }
}
