import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipBody = promisify(gunzip);
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const COUNTING_METHOD = "@oh-my-pi/pi-natives:ClaudeV3:serialized-provider-json+4096";
const PROVENANCE = "anthropic.message_delta.stop_details";
const USAGE_FIELDS = { input_tokens: "input", output_tokens: "output", cache_read_input_tokens: "cacheRead", cache_creation_input_tokens: "cacheWrite" };
const MESSAGE_EVENTS = new Set(["message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop"]);

function inputEncoding(input, init) {
  const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const encoding = headers instanceof Headers ? headers.get("content-encoding")
    : Array.isArray(headers) ? headers.find(([name]) => name.toLowerCase() === "content-encoding")?.[1]
    : headers?.[Object.keys(headers).find((name) => name.toLowerCase() === "content-encoding")];
  return typeof encoding === "string" ? encoding.trim().toLowerCase() : "";
}

async function wireText(body, encoding) {
  let text;
  if (typeof body === "string" && (!encoding || encoding === "identity")) text = body;
  else {
    let bytes;
    if (typeof body === "string") bytes = new TextEncoder().encode(body);
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    else if (body instanceof Request) bytes = new Uint8Array(await body.arrayBuffer());
    else throw new Error("Unsupported provider input encoding");
    if (bytes.byteLength > MAX_STREAM_BYTES) throw new Error("Provider input exceeds receipt limit");
    if (encoding && encoding !== "identity") {
      if (encoding !== "gzip") throw new Error("Unsupported provider content encoding");
      bytes = await gunzipBody(bytes, { maxOutputLength: MAX_STREAM_BYTES });
    }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_STREAM_BYTES) throw new Error("Provider input exceeds receipt limit");
  return text;
}

function updateUsage(target, source) {
  for (const [wire, key] of Object.entries(USAGE_FIELDS)) {
    const value = source?.[wire];
    if (Number.isSafeInteger(value) && value >= 0) target[key] = value;
  }
}

async function countedReceipt(refusal, usage, usageComplete, body, encoding, countTokens) {
  const receipt = { refusal, reportedUsage: { ...usage }, usageComplete, countingMethod: COUNTING_METHOD, framingAllowance: 4096 };
  try {
    const input = await wireText(body, encoding);
    const inputTokens = countTokens(input);
    const maxOutputTokens = JSON.parse(input).max_tokens;
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096) throw new Error("Invalid count");
    return { ...receipt, inputTokens, inputTokenUpperBound: inputTokens + 4096, maxOutputTokens };
  } catch {
    return { ...receipt, countingError: true };
  }
}

async function observe(response, body, encoding, countTokens) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  const usage = {};
  let bytes = 0;
  let line = "";
  let eventName = "";
  let data = "";
  let oversized = false;
  let terminal = false;
  let receipt;
  function consumeLine(value) {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value === "") {
      if (eventName === "error") terminal = true;
      if (!oversized && MESSAGE_EVENTS.has(eventName) && data) {
        let event;
        try { event = JSON.parse(data); } catch {}
        if (!terminal && event?.type === "message_start") updateUsage(usage, event.message?.usage);
        if (!terminal && event?.type === "message_delta") {
          updateUsage(usage, event.usage);
          const delta = event.delta;
          if (delta?.stop_reason) {
            terminal = true;
            if (["refusal", "sensitive"].includes(delta.stop_reason)) {
              const details = delta.stop_details;
              const hasCategory = details?.type === "refusal" && typeof details.category === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(details.category);
              const category = hasCategory ? details.category : "unspecified";
              const provenance = hasCategory ? PROVENANCE : "anthropic.message_delta.stop_reason";
              const validFinalUsage = event.usage && Object.keys(USAGE_FIELDS).every((key) => event.usage[key] === undefined || Number.isSafeInteger(event.usage[key]) && event.usage[key] >= 0);
              const usageComplete = validFinalUsage && Number.isSafeInteger(event.usage.output_tokens) && Object.values(USAGE_FIELDS).every((key) => key in usage);
              receipt = countedReceipt({ type: "refusal", category, provenance }, usage, usageComplete, body, encoding, countTokens);
            }
          }
        }
        if (event?.type === "message_stop") terminal = true;
      }
      data = "";
      eventName = "";
      oversized = false;
    } else if (!oversized && value.startsWith("data:")) {
      const part = value.slice(5).replace(/^ /, "");
      if (data.length + part.length > MAX_EVENT_BYTES) { oversized = true; data = ""; }
      else data += `${data ? "\n" : ""}${part}`;
    } else if (!oversized && value.startsWith("event:")) eventName = value.slice(6).trim();
  }
  try {
    while (!terminal) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) break;
      for (let offset = 0; offset < next.value.byteLength && !terminal; offset += 16 * 1024) {
        const text = decoder.decode(next.value.subarray(offset, offset + 16 * 1024), { stream: true });
        for (const char of text) {
          if (char === "\n") { consumeLine(line); line = ""; if (terminal) break; }
          else if (line.length < MAX_EVENT_BYTES) line += char;
          else { oversized = true; line = ""; }
        }
      }
    }
  } catch {
  } finally {
    void reader.cancel().catch(() => {});
  }
  return receipt;
}

export function createProviderReceiptObserver({ fetch: fetchImpl, countTokens }) {
  let observations = [];
  return {
    reset() { observations = []; },
    fetch: async (input, init) => {
      const body = init?.body ?? (input instanceof Request ? input.clone() : undefined);
      const encoding = inputEncoding(input, init);
      const response = await fetchImpl(input, init);
      if (response.ok && response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        observations.push(observe(response.clone(), body, encoding, countTokens));
      }
      return response;
    },
    async finish() {
      const receipts = await Promise.all(observations);
      return receipts.findLast((receipt) => receipt !== undefined);
    },
  };
}

export async function providerResult(response, observer, retryObservation) {
  const body = await response.json();
  const providerReceipt = await observer.finish();
  const result = response.status === 200 && !providerReceipt ? body : { error: "Provider request failed" };
  return Response.json({ ...result, retryObservation, ...(providerReceipt ? { providerReceipt } : {}) }, { status: response.status });
}
