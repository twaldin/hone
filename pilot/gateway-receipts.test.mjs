import { test, expect } from "bun:test";
import { realpathSync } from "node:fs";
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

test("arbitrary model text, JSON error bodies, and unstructured stops are not refusal evidence", async () => {
  for (const body of [
    JSON.stringify({ error: "Refusal (general_harms)", stop_details: { type: "refusal" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(refusal()) } }) + event(stop),
    event({ type: "message_delta", delta: { stop_reason: "refusal" } }) + event(stop),
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

const omp = Bun.which("omp");
test.skipIf(!omp)("installed native router preserves a real structured refusal through its synthesized 502 offline", async () => {
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
      sent = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body);
      return new Response(event(start) + event(refusal()) + event(stop), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const storage = {
    keys: { getWithCredential: async () => ({ apiKey: "sk-ant-oat01-offline-fixture", credentialId: 1 }) },
    usage: { observe() {} },
  };
  const router = createAuthGatewayRouter({ storage, resolveModel: () => model, fetch: observer.fetch });
  try {
    const request = new Request("http://localhost/v1/pi/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-6", context: { messages: [{ role: "user", content: "private fixture prompt", timestamp: 0 }] },
      options: { maxTokens: 32, temperature: 0, forceReasoningOff: true, cacheRetention: "none", preferWebsockets: false }, stream: false,
    }) });
    const response = await providerResult(await router.route(request, "offline-fixture"), observer, { httpAttempts: attempts, hiddenAttempts: Math.max(0, attempts - 1) });
    const value = await response.json();
    expect(response.status).toBe(502);
    expect(attempts).toBe(1);
    expect(value.providerReceipt.refusal.category).toBe("general_harms");
    expect(value.providerReceipt.inputTokens).toBe(countTokens(sent, Encoding.ClaudeV3));
    expect(value.providerReceipt.inputTokenUpperBound).toBe(countTokens(sent, Encoding.ClaudeV3) + 4096);
    expect(JSON.stringify(value)).not.toContain("private fixture");
    expect(JSON.stringify(value)).not.toContain("sk-ant-");
  } finally {
    router.close();
  }
}, 60_000);
