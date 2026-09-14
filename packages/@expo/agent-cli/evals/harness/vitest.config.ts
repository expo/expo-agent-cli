import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  test: { include: ['harness/__tests__/*.test.ts'], testTimeout: 10000 },
});
