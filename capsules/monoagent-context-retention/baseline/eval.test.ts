import { describe, expect, test } from "bun:test";
import { assessProjection } from "./eval.ts";
import { serializeProjection } from "./contract.ts";
import type { FixtureCase } from "./fixture.ts";
import type { ProjectedRecord, RetentionInput, SourceRecord } from "./contract.ts";

const source: SourceRecord = {
  id: "effort:e-1",
  section: "effort",
  focused: true,
  sourceOrder: 0,
  updatedAt: 100,
  createdAt: null,
  recencyRank: 1,
  status: "active",
  kind: null,
  activity: 0,
  encodings: [{ name: "full", body: "{\"goal\":\"ship\"}" }],
};
const input: RetentionInput = {
  contractVersion: 1,
  maxWindowChars: 1_000,
  current: { id: "current-1", ts: 200, kind: "user_text", content: "keep this exactly" },
  records: [source],
};
const fixture: FixtureCase = {
  id: "security-case",
  group: "focused-effort",
  now: 200,
  maxWindowChars: 1_000,
  maxProjects: 1,
  maxRecentEfforts: 1,
  maxTailMessages: 1,
  recentEffortMs: 100,
  currentMessageId: "current-1",
  settings: { focusProjectId: "p-1", focusEffortId: "e-1", softCapTokens: 1_000 },
  projects: [],
  efforts: [],
  questions: [],
  messages: [],
  oracle: { "effort:e-1": 10 },
};
const selected: ProjectedRecord = { id: source.id, encoding: "full", body: source.encodings[0]!.body };

describe("protected structured-projection gates", () => {
  test("accepts an exact registered record under the character cap", () => {
    const projection = serializeProjection(input.current, [selected]);
    const assessment = assessProjection(input, fixture, projection, undefined);
    expect(assessment.valid).toBe(true);
    expect(assessment.score).toBe(1);
  });

  test("rejects duplicate and fabricated source records with q_fail zero", () => {
    const duplicate = serializeProjection(input.current, [selected, selected]);
    const duplicated = assessProjection(input, fixture, duplicate, undefined);
    expect(duplicated.authentic).toBe(false);
    expect(duplicated.score).toBe(0);
    expect(duplicated.issues).toContain("duplicate:1");

    const fabricated = serializeProjection(input.current, [
      { id: source.id, encoding: "full", body: "{\"goal\":\"invented\"}" },
    ]);
    const invented = assessProjection(input, fixture, fabricated, undefined);
    expect(invented.authentic).toBe(false);
    expect(invented.score).toBe(0);
    expect(invented.issues).toContain("fabricated:1");
  });

  test("rejects a changed current input and any character overflow", () => {
    const changed = serializeProjection({ ...input.current, content: "changed" }, [selected]);
    const changedAssessment = assessProjection(input, fixture, changed, undefined);
    expect(changedAssessment.currentPreserved).toBe(false);
    expect(changedAssessment.score).toBe(0);

    const projection = serializeProjection(input.current, [selected]);
    const cappedInput: RetentionInput = { ...input, maxWindowChars: projection.length - 1 };
    const overflow = assessProjection(cappedInput, fixture, projection, undefined);
    expect(overflow.withinCap).toBe(false);
    expect(overflow.score).toBe(0);
  });
});
