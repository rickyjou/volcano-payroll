import { defineConfig } from 'vitest/config';

// Runs against the local Volcano stack (volcano start). Tests share one
// database and reset it, so files run one at a time.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
