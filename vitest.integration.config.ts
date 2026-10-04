import { defineConfig } from 'vitest/config';

// Runs against the local Volcano stack (volcano start). Tests share one
// database and reset it, so files run one at a time.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // Restores the local admin (npm run bootstrap-admin) once every file has run.
    globalSetup: ['tests/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
