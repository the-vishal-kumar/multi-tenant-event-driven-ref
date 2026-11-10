import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // e2e tests share one running stack; keep them in file order.
    fileParallelism: true,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
