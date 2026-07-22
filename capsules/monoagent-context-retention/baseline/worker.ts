import { writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_REQUEST_CHARS = 2_000_000;

// --- Sealed-envelope primitives ---------------------------------------------
// Everything in this section is captured while this trusted module evaluates,
// BEFORE the candidate module is imported. JSON.stringify is deliberately NOT
// used for the response: it consults inherited toJSON (Object.prototype or
// String.prototype hooks the candidate can install during its module
// evaluation), which would let candidate code rewrite the sealed payload after
// the projection type check. The envelope is instead assembled by the own-code
// escaper below, which only performs primitive string operations (indexing,
// .length, relational comparison, concatenation — none of which dispatch
// through mutable prototypes) plus lookups on a null-prototype table built
// here, and is flushed through the low-level fd write captured below,
// bypassing patchable stream internals such as process.stdout._write.
const rawWriteSync: typeof writeSync = writeSync;

const ESCAPES: Record<string, string> = Object.create(null);
for (let code = 0; code < 0x20; code += 1) {
  ESCAPES[String.fromCharCode(code)] = `\\u${code.toString(16).padStart(4, "0")}`;
}
ESCAPES["\b"] = "\\b";
ESCAPES["\t"] = "\\t";
ESCAPES["\n"] = "\\n";
ESCAPES["\f"] = "\\f";
ESCAPES["\r"] = "\\r";
ESCAPES['"'] = '\\"';
ESCAPES["\\"] = "\\\\";
// Unpaired UTF-16 surrogates are escaped exactly like well-formed
// JSON.stringify so the emitted envelope stays valid UTF-8 for the
// evaluator's fatal decoder; paired surrogates pass through literally.
for (let code = 0xd800; code <= 0xdfff; code += 1) {
  ESCAPES[String.fromCharCode(code)] = `\\u${code.toString(16)}`;
}

/** JSON string escaper byte-identical to JSON.stringify on primitive strings. */
function escapeJsonString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]!;
    if (ch >= "\ud800" && ch <= "\udbff" && index + 1 < value.length) {
      const low = value[index + 1]!;
      if (low >= "\udc00" && low <= "\udfff") {
        out += ch;
        out += low;
        index += 1;
        continue;
      }
    }
    const escaped = ESCAPES[ch];
    out += escaped === undefined ? ch : escaped;
  }
  return `${out}"`;
}

function writeSealedEnvelope(nonce: string, projection: string): void {
  const payload = `{"nonce":${escapeJsonString(nonce)},"projection":${escapeJsonString(projection)}}\n`;
  rawWriteSync(1, payload);
}
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main(): Promise<void> {
  const requestText = await Bun.stdin.text();
  if (requestText.length === 0 || requestText.length > MAX_REQUEST_CHARS) {
    throw new Error("request size outside worker boundary");
  }
  const parsed: unknown = JSON.parse(requestText);
  if (
    !isRecord(parsed) ||
    typeof parsed.nonce !== "string" ||
    parsed.nonce.length < 16 ||
    !isRecord(parsed.input)
  ) throw new Error("invalid worker request");

  const workspace = process.env.CAPSULE_WORKSPACE ?? "/workspace";
  const moduleUrl = pathToFileURL(join(workspace, "context.ts"));
  // The candidate workspace is selected at runtime by the broker, so a static
  // import cannot represent this isolation boundary.
  moduleUrl.searchParams.set("nonce", parsed.nonce);
  const candidate: unknown = await import(moduleUrl.href);
  if (!isRecord(candidate) || typeof candidate.assemble !== "function") {
    throw new Error("context.ts must export assemble(input)");
  }
  const projection: unknown = await candidate.assemble(parsed.input);
  if (typeof projection !== "string") throw new Error("assemble(input) must return a string");
  writeSealedEnvelope(parsed.nonce, projection);
}

await main();
