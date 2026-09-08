import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Ordering measures real container wall-clock performance. Other capsule
    // files exercise host/container evaluators and must not compete with it.
    fileParallelism: false,
  },
});
