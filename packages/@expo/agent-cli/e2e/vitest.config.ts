import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: 'agent-cli-e2e',
    root: rootDir,
    environment: 'node',
    globals: true,
    include: ['__tests__/**/*-test.ts'],
    // The fixtures ship committed `node_modules` directories as test data. Vitest must never treat
    // them as modules of this project.
    exclude: ['**/node_modules/**', 'fixtures/**'],
    testTimeout: process.platform === 'win32' ? 300_000 : 180_000,
    pool: 'forks',
    env: {
      npm_config_user_agent: '',
      npm_execpath: '',
    },
  },
});
