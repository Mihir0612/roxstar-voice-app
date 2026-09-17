import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/env.ts'],
    // The spin engine is time-driven; concurrency suites open real sockets.
    testTimeout: 40_000,
    hookTimeout: 40_000,
    // Integration/concurrency suites share one Postgres database, so they
    // must not run in parallel with each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['default'],
  },
});
