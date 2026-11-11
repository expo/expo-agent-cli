import fs from 'node:fs';
import path from 'node:path';

import { readDevServerLockAsync } from '../../src/devLock';
import { runRecoveryCommand } from '../recoveryCommand';
import { cloudBindingFile, installStubEasAsync, writeCloudBindingAsync } from '../stubEas';
import {
  collectOutput,
  executeAgentCliAsync,
  expoHomeOf,
  freePortAsync,
  killAsync,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForExitAsync,
} from '../utils';

it.each(
  (['ios', 'android'] as const).flatMap((platform) =>
    [false, true].map((detached) => ({ platform, detached }))
  )
)(
  'observes an unfinished $platform EAS open beyond the observation budget (detached: $detached)',
  async ({ platform, detached }) => {
    const root = await setupFixtureAsync('go-app');
    const { scriptPath } = await installStubEasAsync(root);
    const entered = path.join(root, 'session-start-entered');
    const released = path.join(root, 'release-session-start');
    fs.writeFileSync(
      scriptPath,
      fs
        .readFileSync(scriptPath, 'utf8')
        .replace(
          'const command = args[0]',
          `if (args[0] === 'simulator') {\n` +
            `  fs.writeFileSync(${JSON.stringify(entered)}, String(process.pid));\n` +
            `  while (!fs.existsSync(${JSON.stringify(released)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);\n` +
            `}\nconst command = args[0]`
        )
    );
    const port = await freePortAsync();
    const env = {
      STUB_EXPO_DEV_SERVER_PORT: String(port),
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: '120000',
      STUB_EXPO_TUNNEL_HOST: 'pending.tunnel.example',
      STUB_EXPO_TUNNEL_DELAY_MS: '20',
      STUB_SIM_SESSIONS: '0',
      STUB_SIM_PLATFORM: platform.toUpperCase(),
      STUB_SIM_START_EXIT: '1',
      AGENT_CLI_EAS_SESSION_WAIT_MS: '100',
    };
    const run = (args: string[]) => executeAgentCliAsync(root, args, { env, reject: false });
    const child = spawnAgentCli(
      root,
      [
        'dev',
        `--${platform}`,
        '--eas',
        '--go',
        '--port',
        String(port),
        ...(detached ? ['--detach', '--wait-ready', '--json'] : []),
      ],
      { env }
    );
    const output = collectOutput(child);
    const result = waitForExitAsync(child, output);
    try {
      expect(await waitForAsync(() => fs.existsSync(entered), 20_000), output.all).toBe(true);
      if (detached) expect((await result).exitCode, output.all).toBe(22);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await writeCloudBindingAsync(expoHomeOf(root), root, {
        id: 'expired',
        platform,
        expiresAt: new Date(0).toISOString(),
      });
      const status = await run(['status', '--json']);
      expect(status.exitCode, status.all).toBe(0);
      const next = JSON.parse(status.stdout).next;
      expect(next.command, next.why).toMatch(detached ? /dev:logs/ : /status/);
      expect(next.command).not.toContain('dev:stop');
      const navigation = await run(['navigate', '/', `--${platform}`, '--eas', '--json']);
      expect(navigation.exitCode, navigation.all).toBe(20);
      const advice = JSON.parse(navigation.stdout).error.suggestedCommand as string;
      expect(advice).toMatch(detached ? /dev:logs/ : /status/);
      expect(advice).not.toContain('dev:stop');
      const observed = await runRecoveryCommand(root, advice, env);
      expect(observed.exitCode, observed.all).toBe(0);
      expect(fs.existsSync(released)).toBe(false);
      fs.writeFileSync(released, '');
      expect(
        await waitForAsync(
          async () => (await readDevServerLockAsync(root))?.easOpenFinished === true,
          15_000
        )
      ).toBe(true);
      fs.rmSync(cloudBindingFile(expoHomeOf(root), root, platform), { force: true });
      const completed = await run(['status', '--json']);
      expect(JSON.parse(completed.stdout).next.command).toContain('dev:stop &&');
    } finally {
      fs.writeFileSync(released, '');
      await run(['dev:stop', '--eas', '--json']);
      await killAsync(child);
      await result;
    }
  }
);
