import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  CurrentInput,
  EncodingName,
  RecordEncoding,
  RetentionInput,
  RetentionSection,
  SourceRecord,
} from "./contract.ts";

export const FIXTURE_SCHEMA_VERSION = 1;
export const WEIGHT_VERSION = "monoagent-owner-utility-v1";
export const REQUIRED_GROUPS = [
  "focused-effort",
  "broader-state",
  "conversation-tail",
  "oversized-noise",
] as const;
const REQUIRED_GROUP: Readonly<Record<string, true>> = {
  "focused-effort": true,
  "broader-state": true,
  "conversation-tail": true,
  "oversized-noise": true,
};

interface ProjectFixture {
  readonly id: string;
  readonly name: string;
  readonly mode: string;
  readonly footprint: string;
  readonly yolo: number;
  readonly dossierState: string;
  readonly dispatchRules: string;
}

interface EffortFixture {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly status: string;
  readonly planNote: string | null;
  readonly createdTs: number;
  readonly updatedTs: number;
}

interface QuestionFixture {
  readonly id: string;
  readonly effortId: string | null;
  readonly prompt: string;
  readonly options: string;
  readonly status: string;
  readonly createdTs: number;
}

interface MessageFixture {
  readonly id: string;
  readonly ts: number;
  readonly kind: string;
  readonly body: string;
  readonly effortId: string | null;
  readonly questionId: string | null;
}

interface FrontSettingsFixture {
  readonly focusProjectId: string | null;
  readonly focusEffortId: string | null;
  readonly softCapTokens: number;
}

export interface FixtureCase {
  readonly id: string;
  readonly group: (typeof REQUIRED_GROUPS)[number];
  readonly now: number;
  readonly maxWindowChars: number;
  readonly maxProjects: number;
  readonly maxRecentEfforts: number;
  readonly maxTailMessages: number;
  readonly recentEffortMs: number;
  readonly currentMessageId: string;
  readonly settings: FrontSettingsFixture;
  readonly projects: readonly ProjectFixture[];
  readonly efforts: readonly EffortFixture[];
  readonly questions: readonly QuestionFixture[];
  readonly messages: readonly MessageFixture[];
  readonly oracle: Readonly<Record<string, number>>;
}

export interface FixtureBank {
  readonly schemaVersion: number;
  readonly split: string;
  readonly weightVersion: string;
  readonly cases: readonly FixtureCase[];
  readonly seal: string;
}

interface CurrentRow {
  readonly id: string;
  readonly ts: number;
  readonly kind: "user_text" | "user_answer";
  readonly body: string;
}

interface SettingsRow {
  readonly focus_project_id: string | null;
  readonly focus_effort_id: string | null;
  readonly soft_cap_tokens: number;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly mode: string;
  readonly footprint: string;
  readonly yolo: number;
  readonly dossier_state: string;
  readonly dispatch_rules: string;
  readonly active_count: number;
  readonly waiting_count: number;
  readonly blocked_count: number;
}

interface EffortRow {
  readonly id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly goal: string;
  readonly status: string;
  readonly plan_note: string | null;
  readonly updated_ts: number;
}

interface QuestionRow {
  readonly id: string;
  readonly effort_id: string | null;
  readonly prompt: string;
  readonly options: string;
  readonly created_ts: number;
}

interface MessageRow {
  readonly id: string;
  readonly ts: number;
  readonly kind: string;
  readonly body: string;
  readonly effort_id: string | null;
  readonly question_id: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isProject(value: unknown): value is ProjectFixture {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" &&
    typeof value.mode === "string" && typeof value.footprint === "string" &&
    typeof value.yolo === "number" && typeof value.dossierState === "string" &&
    typeof value.dispatchRules === "string";
}

function isEffort(value: unknown): value is EffortFixture {
  return isRecord(value) && typeof value.id === "string" && typeof value.projectId === "string" &&
    typeof value.goal === "string" && typeof value.status === "string" &&
    isNullableString(value.planNote) && typeof value.createdTs === "number" &&
    typeof value.updatedTs === "number";
}

function isQuestion(value: unknown): value is QuestionFixture {
  return isRecord(value) && typeof value.id === "string" && isNullableString(value.effortId) &&
    typeof value.prompt === "string" && typeof value.options === "string" &&
    typeof value.status === "string" && typeof value.createdTs === "number";
}

function isMessage(value: unknown): value is MessageFixture {
  return isRecord(value) && typeof value.id === "string" && typeof value.ts === "number" &&
    typeof value.kind === "string" && typeof value.body === "string" &&
    isNullableString(value.effortId) && isNullableString(value.questionId);
}

function isFixtureCase(value: unknown): value is FixtureCase {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.group !== "string") return false;
  if (REQUIRED_GROUP[value.group] !== true) return false;
  if (
    typeof value.now !== "number" || typeof value.maxWindowChars !== "number" ||
    typeof value.maxProjects !== "number" || typeof value.maxRecentEfforts !== "number" ||
    typeof value.maxTailMessages !== "number" || typeof value.recentEffortMs !== "number" ||
    typeof value.currentMessageId !== "string" || !isRecord(value.settings)
  ) return false;
  if (
    !isNullableString(value.settings.focusProjectId) ||
    !isNullableString(value.settings.focusEffortId) ||
    typeof value.settings.softCapTokens !== "number"
  ) return false;
  if (
    !Array.isArray(value.projects) || !value.projects.every(isProject) ||
    !Array.isArray(value.efforts) || !value.efforts.every(isEffort) ||
    !Array.isArray(value.questions) || !value.questions.every(isQuestion) ||
    !Array.isArray(value.messages) || !value.messages.every(isMessage) ||
    !isRecord(value.oracle)
  ) return false;
  return Object.values(value.oracle).every((weight) =>
    typeof weight === "number" && Number.isFinite(weight) && weight > 0
  );
}

export function isFixtureBank(value: unknown): value is FixtureBank {
  return isRecord(value) && value.schemaVersion === FIXTURE_SCHEMA_VERSION &&
    typeof value.split === "string" && value.weightVersion === WEIGHT_VERSION &&
    Array.isArray(value.cases) && value.cases.every(isFixtureCase) &&
    typeof value.seal === "string" && /^sha256:[a-f0-9]{64}$/.test(value.seal);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("canonical JSON rejects unsupported value");
  return `{${Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`)
    .join(",")}}`;
}

export function expectedBankSeal(bank: FixtureBank): string {
  const sealed = canonicalJson({
    schemaVersion: bank.schemaVersion,
    split: bank.split,
    weightVersion: bank.weightVersion,
    cases: bank.cases,
  });
  return `sha256:${createHash("sha256").update(sealed).digest("hex")}`;
}

export function groupCounts(cases: readonly FixtureCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const fixture of cases) counts[fixture.group] = (counts[fixture.group] ?? 0) + 1;
  return counts;
}

export function isGroupBalanced(cases: readonly FixtureCase[]): boolean {
  const counts = groupCounts(cases);
  const observed = REQUIRED_GROUPS.map((group) => counts[group] ?? 0);
  return observed.every((count) => count > 0 && count === observed[0]);
}

export function buildRetentionInput(fixture: FixtureCase): RetentionInput {
  const database = new Database(":memory:", { strict: true });
  try {
    createSchema(database);
    seedDatabase(database, fixture);
    return queryInput(database, fixture);
  } finally {
    database.close();
  }
}

function createSchema(database: Database): void {
  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL,
      footprint TEXT NOT NULL, yolo INTEGER NOT NULL, dossier_state TEXT NOT NULL,
      dispatch_rules TEXT NOT NULL
    );
    CREATE TABLE efforts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal TEXT NOT NULL,
      status TEXT NOT NULL, plan_note TEXT, created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL
    );
    CREATE TABLE questions (
      id TEXT PRIMARY KEY, effort_id TEXT, prompt TEXT NOT NULL, options TEXT NOT NULL,
      status TEXT NOT NULL, created_ts INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      effort_id TEXT, question_id TEXT
    );
    CREATE TABLE front_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), focus_project_id TEXT,
      focus_effort_id TEXT, soft_cap_tokens INTEGER NOT NULL
    );
  `);
}

function seedDatabase(database: Database, fixture: FixtureCase): void {
  const project = database.prepare(`
    INSERT INTO projects (id, name, mode, footprint, yolo, dossier_state, dispatch_rules)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of fixture.projects) {
    project.run(row.id, row.name, row.mode, row.footprint, row.yolo, row.dossierState, row.dispatchRules);
  }
  const effort = database.prepare(`
    INSERT INTO efforts (id, project_id, goal, status, plan_note, created_ts, updated_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of fixture.efforts) {
    effort.run(row.id, row.projectId, row.goal, row.status, row.planNote, row.createdTs, row.updatedTs);
  }
  const question = database.prepare(`
    INSERT INTO questions (id, effort_id, prompt, options, status, created_ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of fixture.questions) {
    question.run(row.id, row.effortId, row.prompt, row.options, row.status, row.createdTs);
  }
  const message = database.prepare(`
    INSERT INTO messages (id, ts, kind, body, effort_id, question_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of fixture.messages) {
    message.run(row.id, row.ts, row.kind, row.body, row.effortId, row.questionId);
  }
  database.prepare(`
    INSERT INTO front_settings (id, focus_project_id, focus_effort_id, soft_cap_tokens)
    VALUES (1, ?, ?, ?)
  `).run(
    fixture.settings.focusProjectId,
    fixture.settings.focusEffortId,
    fixture.settings.softCapTokens,
  );
}

function queryInput(database: Database, fixture: FixtureCase): RetentionInput {
  const current = database.query<CurrentRow, [string]>(`
    SELECT id, ts, kind, body FROM messages
    WHERE id = ? AND kind IN ('user_text', 'user_answer')
  `).get(fixture.currentMessageId);
  if (current === null) throw new Error(`fixture ${fixture.id}: current message is not persisted user input`);
  const settings = database.query<SettingsRow, []>(`
    SELECT settings.focus_project_id,
      CASE WHEN effort.id IS NOT NULL
        AND effort.project_id = settings.focus_project_id
        AND effort.status IN ('active', 'waiting', 'blocked')
      THEN effort.id ELSE NULL END AS focus_effort_id,
      settings.soft_cap_tokens
    FROM front_settings settings
    LEFT JOIN efforts effort ON effort.id = settings.focus_effort_id
    WHERE settings.id = 1
  `).get();
  if (settings === null) throw new Error(`fixture ${fixture.id}: missing front settings`);

  const projects = database.query<ProjectRow, [string | null, number]>(`
    SELECT p.id, p.name, p.mode, p.footprint, p.yolo, p.dispatch_rules, p.dossier_state,
      sum(CASE WHEN e.status = 'active' THEN 1 ELSE 0 END) AS active_count,
      sum(CASE WHEN e.status = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
      sum(CASE WHEN e.status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count
    FROM projects p LEFT JOIN efforts e ON e.project_id = p.id
    GROUP BY p.id ORDER BY (p.id = ?) DESC, p.name, p.id LIMIT ?
  `).all(settings.focus_project_id, fixture.maxProjects);
  const efforts = database.query<EffortRow, [number, string | null, string | null, number]>(`
    SELECT e.id, e.project_id, p.name AS project_name, e.goal, e.status,
      e.plan_note, e.updated_ts
    FROM efforts e JOIN projects p ON p.id = e.project_id
    WHERE e.updated_ts >= ? OR e.id = ?
    ORDER BY (e.id = ?) DESC, e.updated_ts DESC, e.id LIMIT ?
  `).all(
    fixture.now - fixture.recentEffortMs,
    settings.focus_effort_id,
    settings.focus_effort_id,
    fixture.maxRecentEfforts,
  );
  const questions = database.query<QuestionRow, []>(`
    SELECT id, effort_id, prompt, options, created_ts FROM questions
    WHERE status = 'pending' ORDER BY created_ts, id
  `).all();
  const tail = database.query<MessageRow, [number, number, string, number]>(`
    SELECT id, ts, kind, body, effort_id, question_id FROM messages
    WHERE ts < ? OR (ts = ? AND id < ?)
    ORDER BY ts DESC, id DESC LIMIT ?
  `).all(current.ts, current.ts, current.id, fixture.maxTailMessages).reverse();

  const currentInput = renderCurrent(current);
  const maxFieldChars = Math.min(8_000, Math.max(64, Math.floor(fixture.maxWindowChars / 8)));
  const records: SourceRecord[] = [];
  const add = (
    id: string,
    section: RetentionSection,
    focused: boolean,
    full: unknown,
    compact: unknown,
    preview: unknown,
    metadata: Pick<SourceRecord, "updatedAt" | "createdAt" | "recencyRank" | "status" | "kind" | "activity">,
  ): void => {
    const encodings: RecordEncoding[] = [];
    const variants: readonly [EncodingName, unknown][] = [
      ["full", full],
      ["compact", compact],
      ["preview", preview],
    ];
    for (const [name, value] of variants) {
      const body = canonicalJson(value);
      if (!encodings.some((candidate) => candidate.body === body)) encodings.push({ name, body });
    }
    records.push({ id, section, focused, sourceOrder: records.length, encodings, ...metadata });
  };

  const focus = { projectId: settings.focus_project_id, effortId: settings.focus_effort_id };
  add("focus-state", "focus", true, focus, focus, focus, {
    updatedAt: null, createdAt: null, recencyRank: 0, status: null, kind: null, activity: 0,
  });
  for (const row of projects) {
    const full = {
      projectId: row.id, name: truncateText(row.name, maxFieldChars), mode: row.mode, footprint: row.footprint,
      yolo: row.yolo === 1, dispatchProfile: boundJson(parseJson(row.dispatch_rules), maxFieldChars),
      active: row.active_count, waiting: row.waiting_count, blocked: row.blocked_count,
      dossierState: truncateText(row.dossier_state, maxFieldChars),
    };
    add(`project:${row.id}`, "project", row.id === settings.focus_project_id, full,
      { projectId: row.id, name: truncateText(row.name, maxFieldChars), active: row.active_count, waiting: row.waiting_count, blocked: row.blocked_count },
      { projectId: row.id, name: previewText(row.name) },
      { updatedAt: null, createdAt: null, recencyRank: 0, status: null, kind: null,
        activity: row.active_count + row.waiting_count + row.blocked_count });
  }
  for (const [index, row] of efforts.entries()) {
    const full = {
      effortId: row.id, projectId: row.project_id, project: truncateText(row.project_name, maxFieldChars),
      goal: truncateText(row.goal, maxFieldChars), status: row.status,
      planNote: row.plan_note === null ? null : truncateText(row.plan_note, maxFieldChars),
      updatedAt: row.updated_ts,
    };
    add(`effort:${row.id}`, "effort", row.id === settings.focus_effort_id, full,
      { effortId: row.id, projectId: row.project_id, goal: truncateText(row.goal, maxFieldChars), status: row.status },
      { effortId: row.id, status: row.status, goal: previewText(row.goal) },
      { updatedAt: row.updated_ts, createdAt: null, recencyRank: efforts.length - index,
        status: row.status, kind: null, activity: 0 });
  }
  for (const row of questions) {
    const questionFieldChars = Math.min(512, maxFieldChars);
    const full = {
      questionId: row.id, effortId: row.effort_id, prompt: truncateText(row.prompt, questionFieldChars),
      options: boundJson(parseJson(row.options), questionFieldChars), createdAt: row.created_ts,
    };
    add(`question:${row.id}`, "question", row.effort_id !== null && row.effort_id === settings.focus_effort_id,
      full,
      { questionId: row.id, effortId: row.effort_id, prompt: truncateText(row.prompt, questionFieldChars) },
      { questionId: row.id, prompt: previewText(row.prompt) },
      { updatedAt: null, createdAt: row.created_ts, recencyRank: 0, status: "pending", kind: null, activity: 0 });
  }
  for (const [index, row] of tail.entries()) {
    const parsedBody = parseJson(row.body);
    const boundedBody = boundJson(parsedBody, maxFieldChars);
    const full = {
      id: row.id, ts: row.ts, kind: row.kind, body: boundedBody,
      effortId: row.effort_id, questionId: row.question_id,
    };
    const bodyPreview = previewText(canonicalJson(parsedBody));
    add(`message:${row.id}`, "tail", row.effort_id !== null && row.effort_id === settings.focus_effort_id,
      full,
      { id: row.id, ts: row.ts, kind: row.kind, body: boundedBody },
      { id: row.id, kind: row.kind, body: bodyPreview },
      { updatedAt: null, createdAt: row.ts, recencyRank: index + 1, status: null, kind: row.kind, activity: 0 });
  }

  const sourceIds = new Set(records.map((record) => record.id));
  const oracleIds = Object.keys(fixture.oracle);
  if (sourceIds.size !== records.length || oracleIds.length !== records.length ||
      oracleIds.some((id) => !sourceIds.has(id))) {
    throw new Error(`fixture ${fixture.id}: oracle/source record registry mismatch`);
  }
  return {
    contractVersion: 1,
    maxWindowChars: fixture.maxWindowChars,
    current: currentInput,
    records,
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}…[${omitted} chars omitted]`;
}

function boundJson(value: unknown, maxChars: number): unknown {
  const serialized = canonicalJson(value);
  return serialized.length <= maxChars
    ? value
    : { truncated: true, preview: truncateText(serialized, maxChars) };
}

function previewText(value: string): string {
  return value.length <= 56 ? value : `${value.slice(0, 56)}…`;
}

function renderCurrent(row: CurrentRow): CurrentInput {
  const body: unknown = parseJson(row.body);
  if (!isRecord(body)) throw new Error("current message body must be an object");
  if (row.kind === "user_text") {
    if (typeof body.text !== "string" || body.text.length === 0) {
      throw new Error("current user_text must contain text");
    }
    return { id: row.id, ts: row.ts, kind: row.kind, content: body.text };
  }
  return { id: row.id, ts: row.ts, kind: row.kind, content: `<user-answer>${canonicalJson(body)}</user-answer>` };
}
