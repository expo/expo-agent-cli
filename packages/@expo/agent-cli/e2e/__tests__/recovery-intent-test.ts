import fs from 'node:fs';
import path from 'node:path';

import { quoteArgument } from '../../src/utils/consent';
import { runRecoveryCommand } from '../recoveryCommand';
import { cloudBindingFile, installStubEasAsync, writeCloudBindingAsync } from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  freePortAsync,
  readDevLockAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  waitForAsync,
} from '../utils';
import {
  installStubAdbAsync,
  installStubXcrunAsync,
  killBoundEmulatorsAsync,
} from './installedAppStubs';

describe.each(['ios', 'android'] as const)('%s recovery intent', (platform) => {
  it.skipIf(platform === 'ios' && process.platform !== 'darwin')(
    'executes the printed restart with its quoted device, port, target and tunnel',
    async () => {
      const root = await setupFixtureAsync('go-app');
      const port = await freePortAsync();
      const name = platform === 'ios' ? "Ada's iOS device" : "Ada's-android";
      const muted = path.join(root, 'mute-status');
      const script = path.join(root, 'node_modules', 'expo', 'bin', 'cli');
      fs.writeFileSync(
        script,
        fs
          .readFileSync(script, 'utf8')
          .replace(
            "if (route === '/json/list') {",
            `if (fs.existsSync(${JSON.stringify(muted)})) { response.writeHead(503); response.end('unavailable'); return; }\n    if (route === '/json/list') {`
          )
      );
      const deviceEnv =
        platform === 'android'
          ? (await installStubAdbAsync(root, 'host.exp.exponent', { bound: false })).env
          : await installStubXcrunAsync(root, {
              simulators: [{ udid: 'RECOVERY-DEVICE', name, state: 'Booted' }],
            }).then(() => ({}));
      if (platform === 'android') {
        const adb = path.join(root, '.stub-bin', 'adb-stub.js');
        fs.writeFileSync(
          adb,
          fs
            .readFileSync(adb, 'utf8')
            .replaceAll(JSON.stringify('emulator-5554'), JSON.stringify(name))
        );
      }
      await installStubEasAsync(root);
      const env = {
        ...deviceEnv,
        AGENT_CLI_NO_DEVICE: '0',
        STUB_EXPO_DEV_SERVER_PORT: String(port),
        STUB_EXPO_LISTEN: '1',
        STUB_EXPO_DELAY_MS: '120000',
        STUB_EXPO_TUNNEL_HOST: 'recovery.tunnel.example',
        STUB_EXPO_TUNNEL_DELAY_MS: '20',
      };
      const run = (args: string[]) => executeAgentCliAsync(root, args, { env, reject: false });
      try {
        const started = await run([
          'dev',
          `--${platform}`,
          '--local',
          '--go',
          '--tunnel',
          '--device',
          name,
          '--no-open',
          '--port',
          String(port),
          '--detach',
          '--wait-ready',
          '--json',
        ]);
        expect(started.exitCode, started.all).toBe(0);
        const owner = JSON.parse(started.stdout);
        fs.writeFileSync(muted, '');
        const status = await run(['status', '--json']);
        expect(status.exitCode, status.all).toBe(0);
        const command = JSON.parse(status.stdout).next.command as string;
        expect(command).toContain('--tunnel');
        expect(command).toContain(`--device ${quoteArgument(name)}`);
        expect(command).toContain(`--port ${port}`);
        expect(command).toContain('--go');
        fs.rmSync(muted);
        const recovered = await runRecoveryCommand(root, command, env);
        expect(recovered.exitCode, recovered.all).toBe(0);
        const replacement = await readDevLockAsync(root);
        expect(replacement?.pid).not.toBe(owner.pid);
        expect(replacement?.port).toBe(port);
        const starts = readStubExpoInvocations(root).filter(({ args }) => args[0] === 'start');
        expect(starts).toHaveLength(2);
        expect(starts[1]!.args).toContain('--tunnel');
      } finally {
        fs.rmSync(muted, { force: true });
        await run(['dev:stop', '--json']);
        await killBoundEmulatorsAsync(expoHomeOf(root));
      }
    }
  );

  it('does not apply another platform saved target to cloud recovery', async () => {
    const root = await setupFixtureAsync('go-app');
    await installStubEasAsync(root);
    const port = await freePortAsync();
    const other = platform === 'ios' ? 'android' : 'ios';
    const env = {
      STUB_EXPO_DEV_SERVER_PORT: String(port),
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: '120000',
      STUB_EXPO_TUNNEL_HOST: 'recovery.tunnel.example',
      STUB_EXPO_TUNNEL_DELAY_MS: '20',
      STUB_SIM_SESSIONS: '0',
      STUB_SIM_PLATFORM: platform.toUpperCase(),
    };
    const run = (args: string[]) => executeAgentCliAsync(root, args, { env, reject: false });
    try {
      const started = await run([
        'dev',
        `--${other}`,
        '--local',
        '--go',
        '--no-open',
        '--port',
        String(port),
        '--detach',
        '--wait-ready',
        '--json',
      ]);
      expect(started.exitCode, started.all).toBe(0);
      await writeCloudBindingAsync(expoHomeOf(root), root, {
        id: 'expired',
        platform,
        expiresAt: new Date(0).toISOString(),
      });
      const navigation = await run(['navigate', '/', `--${platform}`, '--eas', '--json']);
      expect(navigation.exitCode, navigation.all).toBe(20);
      const command = JSON.parse(navigation.stdout).error.suggestedCommand as string;
      expect(command).not.toContain('--go');
      expect(command).not.toContain(`--${other}`);
      const recovered = await runRecoveryCommand(root, command, env);
      expect(recovered.exitCode, recovered.all).toBe(0);
      expect(
        await waitForAsync(
          () => fs.existsSync(cloudBindingFile(expoHomeOf(root), root, platform)),
          15_000
        )
      ).toBe(true);
    } finally {
      await run(['dev:stop', '--eas', '--json']);
    }
  });
});
