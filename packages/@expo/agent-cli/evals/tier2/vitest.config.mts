import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Independent Tier2 entrypoint; scripts run from the CLI package cwd.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    env: { EXPO_NO_TELEMETRY: '1' },
    name: 'tier2',
    environment: 'node',
    include: ['tier2/*.eval.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
    retry: 0,
    reporters: ['default', 'json'],
    outputFile: {
      json: fileURLToPath(new URL('../.artifacts/tier2/vitest-results.json', import.meta.url)),
    },
  },
});
