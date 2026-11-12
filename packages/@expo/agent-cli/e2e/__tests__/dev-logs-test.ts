import { detachedLogPath } from '../../src/dev/logFile';
// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
//
// `@expo/agent-cli dev:logs` through the published bin: what a detached dev server printed, read
// back from its log file.
import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, setupFixtureAsync, stubExpoEnv, waitForAsync } from '../utils';
import { DETACHED_LOG_PATH, cleanUpDetachedAsync, detachEnv } from '../detachUtils';

describe('@expo/agent-cli dev:logs', () => {
  it('reads what the detached dev server printed', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--detach', '--json'], {
        env: detachEnv(projectRoot, 8394),
      });
      // The stub prints its start line as soon as it runs; the file is written by the child.
      await waitForAsync(
        () =>
          (fs.readFileSync(detachedLogPath(projectRoot), 'utf8') || '').includes('stub_expo_start'),
        5000
      );

      const result = await executeAgentCliAsync(projectRoot, ['dev:logs', '--json'], {
        env: stubExpoEnv(projectRoot),
      });

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.logFile).toBe(detachedLogPath(projectRoot));
      expect(report.lines.join('\n')).toContain('stub_expo_start');
      expect(report.devServer).toMatchObject({ port: 8394 });
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  it('fences the log as untrusted content in the human report', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    try {
      await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--detach', '--json'], {
        env: detachEnv(projectRoot, 8393),
      });
      await waitForAsync(() => fs.existsSync(detachedLogPath(projectRoot)), 5000);

      const result = await executeAgentCliAsync(projectRoot, ['dev:logs'], {
        env: stubExpoEnv(projectRoot),
      });

      expect(result.stdout).toContain('BEGIN UNTRUSTED APP OUTPUT');
      expect(result.stdout).toContain('END UNTRUSTED APP OUTPUT');
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  });

  it('caps the read at --tail lines and says how many there are', async () => {
    const projectRoot = await setupFixtureAsync('go-app');
    const logPath = path.join(projectRoot, DETACHED_LOG_PATH);
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    await fs.promises.writeFile(
      logPath,
      Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
    );

    const result = await executeAgentCliAsync(projectRoot, ['dev:logs', '--tail', '3', '--json']);

    expect(JSON.parse(result.stdout)).toMatchObject({
      lines: ['line 38', 'line 39', 'line 40'],
      totalLines: 40,
      truncated: true,
      // Nothing is running, so the log is what the last detached run left.
      devServer: null,
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §Where a device reaches the dev server
  //
  // The lines are the real ones: `Waiting on <tunnel>` is what `expo start` prints for a tunnelled
  // run [observed — live, 2026-08-25], and that URL is the only address a device off this machine
  // can use — `devServer.url` is where it listens here.
  describe('the address a device reaches', () => {
    async function writeLogAsync(projectRoot: string, lines: string[]): Promise<void> {
      const logPath = path.join(projectRoot, DETACHED_LOG_PATH);
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.writeFile(logPath, lines.join('\n') + '\n');
    }

    it('names the tunnel a device would use', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      await writeLogAsync(projectRoot, [
        'Using src/app as the root directory for Expo Router.',
        'Waiting on http://znakdiwe5j2n5o0.boltexpo.dev',
      ]);

      const result = await executeAgentCliAsync(projectRoot, ['dev:logs', '--json']);

      expect(JSON.parse(result.stdout).advertised).toEqual({
        url: 'http://znakdiwe5j2n5o0.boltexpo.dev',
        hostType: 'tunnel',
      });
    });

    // The reason the reading is over the whole file and not the tail that was asked for: the line
    // is near the top, and a `--tail` that hid it would hide the one address that is useful.
    it('finds the URL even when the requested tail does not include it', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      await writeLogAsync(projectRoot, [
        'Waiting on http://znakdiwe5j2n5o0.boltexpo.dev',
        ...Array.from({ length: 30 }, (_, index) => `line ${index + 1}`),
      ]);

      const result = await executeAgentCliAsync(projectRoot, ['dev:logs', '--tail', '3', '--json']);

      const report = JSON.parse(result.stdout);
      expect(report.lines).toEqual(['line 28', 'line 29', 'line 30']);
      expect(report.advertised?.hostType).toBe('tunnel');
    });

    it('reports a local run as local, so nothing claims a tunnel that is not there', async () => {
      const projectRoot = await setupFixtureAsync('go-app');
      await writeLogAsync(projectRoot, ['Waiting on http://localhost:8081']);

      const result = await executeAgentCliAsync(projectRoot, ['dev:logs', '--json']);

      expect(JSON.parse(result.stdout).advertised).toEqual({
        url: 'http://localhost:8081',
        hostType: 'localhost',
      });
    });
  });

  it('exits 1 and says how to get one when the project has no log', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['dev:logs', '--json'], {
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe('NO_DEV_LOG');
    expect(error.suggestedCommand).toBe(
      `npx @expo/agent-cli dev --${process.platform === 'darwin' ? 'ios' : 'android'} --detach --wait-ready`
    );
  });

  it('appears in the top-level help, next to the command that writes it', async () => {
    const projectRoot = await setupFixtureAsync('go-app');

    const result = await executeAgentCliAsync(projectRoot, ['--help']);

    expect(result.all).toContain('dev:logs');
    expect(result.all).toContain('dev blocks this terminal');
  });
});
