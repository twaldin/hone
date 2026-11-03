import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const load = (name) => import(import.meta.resolve(name, process.argv[2]));
const { discoverAuthStorage } = await load("@oh-my-pi/pi-coding-agent/session/auth-broker-config");
const { getBundledModel } = await load("@oh-my-pi/pi-catalog/models");
const { createAuthGatewayRouter, serveAuthGatewayStdio } = await load("@oh-my-pi/pi-ai/auth-gateway");
const { registerLogSink } = await load("@oh-my-pi/pi-utils/logger");
const packageRoot = dirname(dirname(process.argv[2]));
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const selector = "anthropic/claude-sonnet-4-6";
const storage = await discoverAuthStorage();
const pool = JSON.parse(readFileSync(process.env.OMP_AUTH_BROKER_ACCOUNT_POOL_FILE, "utf8"));
const sessionId = `hone-pilot-${crypto.randomUUID()}`;
const lease = storage.sessions.restrict("anthropic", sessionId, pool.anthropic.accounts);
const model = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!model || model.api !== "anthropic-messages" || new URL(model.baseUrl).origin !== "https://api.anthropic.com") throw new Error("Frozen official pilot model unavailable");
const routeIdentity = { provider: model.provider, model: model.id, api: model.api, endpoint_origin: new URL(model.baseUrl).origin, oauth_only_session: true, local_model_overrides: false };
const client = {
  name: "hone-development-pilot", limitsModels: true,
  allows: (entry) => `${entry.provider}/${entry.id}` === selector,
  credentialSessionId: (provider) => {
    if (provider !== "anthropic") throw new Error("Provider outside pilot account restriction");
    return sessionId;
  },
  retain: () => () => {},
};
let active = false;
let httpAttempts = 0;
let apiKeyHeaderRejections = 0;
let logEvents = 0;
const dispose = registerLogSink((event) => {
  if (active && /retrying|slow mode retry|retry attempt|resampl/i.test(event.message) && !/without retry|no retry|not retry/i.test(event.message)) logEvents++;
});
const router = createAuthGatewayRouter({
  storage,
  resolveModel: (id) => id === selector ? model : undefined,
  fetch: (input, init) => {
    const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const apiKeyPresent = headers instanceof Headers ? headers.has("x-api-key") : Array.isArray(headers) ? headers.some(([name]) => name.toLowerCase() === "x-api-key") : headers && Object.keys(headers).some((name) => name.toLowerCase() === "x-api-key");
    if (apiKeyPresent) {
      apiKeyHeaderRejections++;
      throw new Error("API-key authentication forbidden in subscription pilot");
    }
    httpAttempts++;
    return fetch(input, init);
  },
});
try {
  await serveAuthGatewayStdio({
    input: Bun.stdin.stream(),
    version,
    write: (line) => {
      const frame = JSON.parse(line);
      process.stdout.write(`${JSON.stringify(frame.ready ? { ...frame, routeIdentity } : frame)}\n`);
    },
    route: async (request) => {
      if (active) return Response.json({ error: "Pilot transport is serial" }, { status: 409 });
      if (new URL(request.url).pathname !== "/v1/pi/stream") return Response.json({ error: "Unsupported pilot route" }, { status: 404 });
      active = true;
      httpAttempts = 0;
      apiKeyHeaderRejections = 0;
      logEvents = 0;
      try {
        const response = await router.route(request, "hone-development-pilot", client);
        const body = await response.json();
        const retryObservation = { httpAttempts, apiKeyHeaderRejections, hiddenAttempts: Math.max(0, httpAttempts - 1), logEvents, coverage: "Anthropic SDK opaque fetch override plus omp logger" };
        if (response.status !== 200) return Response.json({ error: "Provider request failed", retryObservation }, { status: response.status });
        return Response.json({ ...body, retryObservation });
      } finally {
        active = false;
      }
    },
  });
} finally {
  dispose();
  router.close();
  storage.sessions.unrestrict("anthropic", sessionId, lease);
  storage.close();
}
process.exit(0);
