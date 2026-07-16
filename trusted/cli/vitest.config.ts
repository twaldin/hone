import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The trusted-CLI suite deliberately mutates PROCESS-EXTERNAL shared
    // state to simulate attacks: trusted workspace source (digest drift),
    // installed dependency bytes (zod/tsx/esbuild seals), tsconfig closure
    // files, and PATH git shims. A parallel worker whose boot-time runtime
    // seal lands inside another file's mutation window is poisoned for its
    // whole lifetime and refuses every subsequent run (by design — that IS
    // the security invariant). Test files therefore run sequentially.
    fileParallelism: false,
  },
});
