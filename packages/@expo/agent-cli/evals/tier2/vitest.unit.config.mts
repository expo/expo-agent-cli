import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    name: 'tier2-harness',
    environment: 'node',
    include: ['harness/__tests__/tier2-*.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
