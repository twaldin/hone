import { test, expect } from "bun:test";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { createProviderReceiptObserver, providerResult } from "./gateway-receipts.mjs";

const encoder = new TextEncoder();
const wire = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, messages: [{ role: "user", content: "private fixture prompt" }], stream: true });
const event = (value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const refusal = (explanation = "private fixture explanation") => ({ type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation } }, usage: { output_tokens: 2 } });
globalThis.fetch = () => { throw new Error("Offline fixture forbids network access"); };
const start = { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } };
const stop = { type: "message_stop" };

function observerFor(body, counter = () => 120) {
  return createProviderReceiptObserver({
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    countTokens: counter,
  });
}

test("fetch hands off streaming response before terminal refusal arrives", async () => {
  let controller;
  const observer = observerFor(new ReadableStream({ start(value) { controller = value; } }));
  const response = await observer.fetch("https://api.anthropic.com/v1/messages", { body: wire });
  expect(response.bodyUsed).toBe(false);
  controller.enqueue(encoder.encode(event(start) + event(refusal()) + event(stop)));
  controller.close();
  const original = await response.text();
  expect(original).toContain("private fixture explanation");
  const receipt = await observer.finish();
  expect(receipt.refusal).toEqual({ type: "refusal", category: "general_harms", provenance: "anthropic.message_delta.stop_details" });
  expect(receipt.inputTokenUpperBound).toBe(4216);
  expect(receipt.maxOutputTokens).toBe(32);
  expect(JSON.stringify(receipt)).not.toContain("private fixture");
});

test("fragmented SSE counts the exact provider JSON and strips private fields", async () => {
  const bytes = encoder.encode(event(start) + event(refusal()) + event(stop));
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  let counted;
  const observer = observerFor(body, (text) => { counted = text; return 120; });
  const response = await observer.fetch("https://api.anthropic.com/v1/messages", { body: encoder.encode(wire) });
  await response.text();
  const safe = await providerResult(Response.json({ error: "private fixture explanation" }, { status: 502 }), observer, { httpAttempts: 1 });
  const value = await safe.json();
  expect(counted).toBe(wire);
  expect(value.providerReceipt.reportedUsage).toEqual({ input: 12, output: 2 });
  expect(value.providerReceipt.countingMethod).toBe("@oh-my-pi/pi-natives:ClaudeV3:serialized-provider-json+4096");
  expect(JSON.stringify(value)).not.toContain("private fixture");
  expect(JSON.stringify(value)).not.toContain("headers");
});

test.each(["refusal", "sensitive"])("bare terminal %s is credential-opaque refusal evidence", async (reason) => {
  const terminal = { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 2 } };
  const observer = observerFor(event(start) + event(terminal) + event(stop));
  const response = await observer.fetch("https://api.anthropic.com/v1/messages", { body: wire });
  await response.text();
  const safe = await providerResult(Response.json({ error: "private fixture explanation", headers: { private: "fixture" } }, { status: 502 }), observer, { httpAttempts: 1 });
  const value = await safe.json();
  expect(value.providerReceipt.refusal).toEqual({
    type: "refusal", category: "unspecified", provenance: "anthropic.message_delta.stop_reason",
  });
  expect(value.providerReceipt.inputTokenUpperBound).toBe(4216);
  expect(value.providerReceipt.reportedUsage).toEqual({ input: 12, output: 2 });
  expect(JSON.stringify(value)).not.toContain("private fixture");
  expect(JSON.stringify(value)).not.toContain("headers");
});

test("arbitrary model text, JSON error bodies, and non-refusal stops are not refusal evidence", async () => {
  for (const body of [
    JSON.stringify({ error: "Refusal (general_harms)", stop_details: { type: "refusal" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(refusal()) } }) + event(stop),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + event(refusal()) + event(stop),
    event(refusal()).replace("event: message_delta", "event: unknown") + event(stop),
    event(refusal()).replace("event: message_delta", "event: error") + event(refusal()) + event(stop),
  ]) {
    const observer = observerFor(body, () => { throw new Error("Non-refusal must not tokenize"); });
    const response = await observer.fetch("https://api.anthropic.com/v1/messages", { body: wire });
    await response.text();
    expect(await observer.finish()).toBeUndefined();
  }
});

test("an oversized event is bounded and cannot supply refusal evidence", async () => {
  const body = event(refusal("x".repeat(128 * 1024))) + event(stop);
  const observer = observerFor(body);
  const response = await observer.fetch("https://api.anthropic.com/v1/messages", { body: wire });
  await response.text();
  expect(await observer.finish()).toBeUndefined();
});

test("gzip input cannot block an ordinary answer or trigger refusal token counting", async () => {
  let attempts = 0;
  const observer = createProviderReceiptObserver({
    fetch: async () => {
      attempts++;
      return new Response(event({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + event(stop),
        { headers: { "content-type": "text/event-stream" } });
    },
    countTokens: () => { throw new Error("An answered request must not need refusal token counting"); },
  });
  const response = await observer.fetch("https://api.anthropic.com/v1/messages", {
    body: gzipSync(wire), headers: { "content-encoding": "gzip" },
  });
  await response.text();
  expect(attempts).toBe(1);
  expect(await observer.finish()).toBeUndefined();
});

test("gzip refusal accounting counts decoded JSON and preserves the deployment output maximum", async () => {
  const input = JSON.stringify({ max_tokens: 4096, messages: [{ role: "user", content: "bounded request ".repeat(128) }] });
  const observer = observerFor(event(start) + event(refusal()) + event(stop));
  const response = await observer.fetch("https://api.anthropic.com/v1/messages", {
    body: gzipSync(input), headers: [["Content-Encoding", "gzip"]],
  });
  await response.text();
  const receipt = await observer.finish();
  expect(receipt.refusal.category).toBe("general_harms");
  expect(receipt.inputTokenUpperBound).toBe(4216);
  expect(receipt.maxOutputTokens).toBe(4096);
  expect(receipt.countingError).toBeUndefined();
});

const omp = Bun.which("omp");
test.skipIf(!omp).each([
  [refusal(), "general_harms", "anthropic.message_delta.stop_details"],
  [{ type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 2 } }, "unspecified", "anthropic.message_delta.stop_reason"],
  [{ type: "message_delta", delta: { stop_reason: "sensitive" }, usage: { output_tokens: 2 } }, "unspecified", "anthropic.message_delta.stop_reason"],
  [refusal(), "general_harms", "anthropic.message_delta.stop_details", "large native request ".repeat(128)],
])("installed native router preserves terminal refusal %j through its synthesized 502 offline", async (terminal, category, provenance, question = "private fixture prompt") => {
  const entry = realpathSync(omp);
  const load = (name) => import(import.meta.resolve(name, entry));
  const { createAuthGatewayRouter } = await load("@oh-my-pi/pi-ai/auth-gateway");
  const { getBundledModel } = await load("@oh-my-pi/pi-catalog/models");
  const { countTokens, Encoding } = await load("@oh-my-pi/pi-natives");
  const model = getBundledModel("anthropic", "claude-sonnet-4-6");
  let attempts = 0;
  let sent;
  const observer = createProviderReceiptObserver({
    countTokens: (text) => countTokens(text, Encoding.ClaudeV3),
    fetch: async (_input, init) => {
      attempts++;
      const headers = init.headers;
      const encoding = headers instanceof Headers ? headers.get("content-encoding")
        : headers[Object.keys(headers).find((name) => name.toLowerCase() === "content-encoding")];
      sent = encoding === "gzip" ? gunzipSync(init.body).toString("utf8")
        : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
      return new Response(event(start) + event(terminal) + event(stop), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const storage = {
    keys: { getWithCredential: async () => ({ apiKey: "sk-ant-oat01-offline-fixture", credentialId: 1 }) },
    usage: { observe() {} },
  };
  const router = createAuthGatewayRouter({ storage, resolveModel: () => model, fetch: observer.fetch });
  try {
    const request = new Request("http://localhost/v1/pi/stream", { method: "POST", headers: { "content-type": "application/json" },
      signal: question.length > 1024 ? AbortSignal.timeout(2000) : undefined, body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-6", context: { systemPrompt: [], messages: [{ role: "user", content: question, timestamp: 0 }] },
      options: { maxTokens: 32, temperature: 0, forceReasoningOff: true, cacheRetention: "none", preferWebsockets: false }, stream: false,
    }) });
    const response = await providerResult(await router.route(request, "offline-fixture"), observer, { httpAttempts: attempts, hiddenAttempts: Math.max(0, attempts - 1) });
    const value = await response.json();
    expect(response.status).toBe(502);
    expect(attempts).toBe(1);
    expect(value.providerReceipt.refusal).toEqual({ type: "refusal", category, provenance });
    expect(value.providerReceipt.inputTokens).toBe(countTokens(sent, Encoding.ClaudeV3));
    expect(value.providerReceipt.inputTokenUpperBound).toBe(countTokens(sent, Encoding.ClaudeV3) + 4096);
    expect(JSON.stringify(value)).not.toContain("private fixture");
    expect(JSON.stringify(value)).not.toContain("sk-ant-");
    expect(JSON.stringify(value)).not.toContain("headers");
    const settled = Bun.spawnSync([fileURLToPath(new URL("./.venv/bin/python", import.meta.url)), "-c", `
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from pilot.runtime import Ledger, ModelCalls, ProviderRefusal, call_scope

fixture = json.load(sys.stdin)
frame = fixture["response"]
attempts = []
def request(body):
    attempts.append(body)
    return frame
with tempfile.TemporaryDirectory() as directory:
    ledger = Ledger(Path(directory) / "calls.jsonl", history_paths=[])
    gateway = SimpleNamespace(request=request, close=lambda: None)
    throttle = SimpleNamespace(wait=lambda: None, accounted_seconds=0, env={})
    with patch("pilot.runtime.broker_healthy", return_value=True), patch("pilot.runtime.open_gateway", return_value=gateway), call_scope(row_id="row-17", arm="naive"):
        try:
            ModelCalls(gateway, ledger, throttle)("task", [{"role": "user", "content": fixture["question"]}], 32)
        except ProviderRefusal:
            pass
        else:
            raise AssertionError("Terminal refusal must reach the ledger caller")
    row = json.loads(ledger.journal.read_text())
    assert len(attempts) == 1, "Terminal refusal must never be redispatched"
    assert row["outcome"] == "refusal" and row["row_id"] == "row-17"
    assert row["refusal"] == frame["body"]["providerReceipt"]["refusal"]
    assert row["charged_tokens"] == frame["body"]["providerReceipt"]["inputTokenUpperBound"] + 32
    assert ledger.transport_failures == 0
`], { cwd: `${import.meta.dir}/..`, stdin: encoder.encode(JSON.stringify({ response: { status: response.status, body: value }, question })) });
    expect(settled.exitCode, new TextDecoder().decode(settled.stderr)).toBe(0);
  } finally {
    router.close();
  }
}, 60_000);
