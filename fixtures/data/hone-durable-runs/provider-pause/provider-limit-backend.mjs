export function createBackend() {
  return {
    async start(ctx) {
      if (ctx.replayed.resumeCount === 0) {
        ctx.requestPause({
          reason: "provider-rate-limit",
          pauseId: "pause_live_429",
          providerStatus: 429,
        });
      }
    },
  };
}
