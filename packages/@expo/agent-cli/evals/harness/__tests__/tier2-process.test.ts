import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProcess } from '../../tier2/process.mjs';

it.skipIf(process.platform === 'win32')(
  'preserves separate streams and the real nonzero exit code',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tier2-process-test-'));
    try {
      const stdoutPath = join(cwd, 'stdout'),
        stderrPath = join(cwd, 'stderr');
      const result = await captureProcess(
        process.execPath,
        ['-e', 'console.log("out"); console.error("err"); process.exitCode=7'],
        { cwd, env: process.env, stdoutPath, stderrPath }
      );
      expect(result).toMatchObject({ exitCode: 7, timedOut: false, spawnError: null });
      expect(await readFile(stdoutPath, 'utf8')).toBe('out\n');
      expect(await readFile(stderrPath, 'utf8')).toBe('err\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
);
it.skipIf(process.platform === 'win32')(
  'preserves spawn failure and abort even without a valid exit code',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tier2-process-test-'));
    try {
      const options = {
        cwd,
        env: process.env,
        stdoutPath: join(cwd, 'out'),
        stderrPath: join(cwd, 'err'),
      };
      expect((await captureProcess(join(cwd, 'missing'), [], options)).spawnError).toContain(
        'ENOENT'
      );
      const result = await captureProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        ...options,
        signal: AbortSignal.timeout(100),
      });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
);
