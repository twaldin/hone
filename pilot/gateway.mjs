import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const load = (name) => import(import.meta.resolve(name, process.argv[2]));
const { discoverAuthStorage } = await load("@oh-my-pi/pi-coding-agent/session/auth-broker-config");
const { ModelRegistry } = await load("@oh-my-pi/pi-coding-agent/config/model-registry");
const { createAuthGatewayRouter, serveAuthGatewayStdio } = await load("@oh-my-pi/pi-ai/auth-gateway");
const { registerLogSink } = await load("@oh-my-pi/pi-utils/logger");
const packageRoot = dirname(dirname(process.argv[2]));
const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const selector = "anthropic/claude-sonnet-4-6";
const storage = await discoverAuthStorage();
const registry = new ModelRegistry(storage);
await registry.refresh();
const model = registry.getAvailable().find((entry) => `${entry.provider}/${entry.id}` === selector);
if (!model) throw new Error("Frozen pilot model unavailable in the account pool");
let active = false;
let httpAttempts = 0;
let logEvents = 0;
const dispose = registerLogSink((event) => {
  if (active && /retrying|slow mode retry|retry attempt|resampl/i.test(event.message) && !/without retry|no retry|not retry/i.test(event.message)) logEvents++;
});
const router = createAuthGatewayRouter({
  storage,
  resolveModel: (id) => id === selector ? model : undefined,
  fetch: (input, init) => {
    httpAttempts++;
    return fetch(input, init);
  },
});
try {
  await serveAuthGatewayStdio({
    input: Bun.stdin.stream(),
    version,
    write: (line) => process.stdout.write(line),
    route: async (request) => {
      if (active) return Response.json({ error: "Pilot transport is serial" }, { status: 409 });
      if (new URL(request.url).pathname !== "/v1/pi/stream") return Response.json({ error: "Unsupported pilot route" }, { status: 404 });
      active = true;
      httpAttempts = 0;
      logEvents = 0;
      try {
        const response = await router.route(request, "hone-development-pilot");
        const body = await response.json();
        const retryObservation = { httpAttempts, hiddenAttempts: Math.max(0, httpAttempts - 1), logEvents, coverage: "Anthropic SDK opaque fetch override plus omp logger" };
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
  storage.close();
}
process.exit(0);
