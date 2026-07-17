import { join } from "node:path";
import { pathToFileURL } from "node:url";

const safeStringify = JSON.stringify.bind(JSON);
const safeWrite = process.stdout.write.bind(process.stdout);
const MAX_REQUEST_CHARS = 2_000_000;

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
  safeWrite(`${safeStringify({ nonce: parsed.nonce, projection })}\n`);
}

await main();
