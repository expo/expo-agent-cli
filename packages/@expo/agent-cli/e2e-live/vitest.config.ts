import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// @ref llp/0022-live-tier.plan.md §A vitest project of its own

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: 'agent-cli-e2e-live',
    root: rootDir,
    environment: 'node',
    globals: true,
    include: ['__tests__/**/*-test.ts'],
    // The fixtures are project source that gets copied into a scratch project, never modules of this
    // one. `livecheck/` in particular carries its own `package.json` with the name `livecheck`.
    exclude: ['**/node_modules/**', 'fixtures/**', '.artifacts/**'],
    // A live run waits on a real bundler, a real simulator and a real network. Nothing here asserts a
    // timing, so the budget is generous on purpose: an expiry is a harness failure, not a finding.
    testTimeout: 900_000,
    // One worker. Two suites cannot share one simulator, one dev-server port range or one cloud
    // session, and a live tier that raced itself would report the race as the CLI's fault.
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
  },
});
