// The crash handler belongs to the CLI process, not to every process that imports `src/`.
//
// Registered as a side effect of `src/utils/errors.ts`, it was also installed in each e2e worker
// that imports a module of `src/`. A crash in such a worker then ended in a bare
// `process.exit unexpectedly called with "1"`, and the error that caused it never reached the log.
import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, setupFixtureAsync } from '../utils';

describe('the uncaught-exception handler', () => {
  it('reports a crash of the CLI process', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const preload = path.join(projectRoot, 'crash-preload.cjs');
    fs.writeFileSync(preload, "setImmediate(() => { throw new Error('preloaded crash'); });\n");

    const result = await executeAgentCliAsync(projectRoot, ['status'], {
      env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('This command crashed: Error: preloaded crash');
  });

  it('is not installed by importing the module that defines it', async () => {
    const before = process.listeners('uncaughtException');
    await import('../../src/utils/errors');

    expect(process.listeners('uncaughtException')).toEqual(before);
  });
});
