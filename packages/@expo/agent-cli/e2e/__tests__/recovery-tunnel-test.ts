import { runRecoveryCommand } from '../recoveryCommand';
import {
  installStubEasAsync,
  writeCloudBindingAsync,
  writeCloudSessionFileAsync,
} from '../stubEas';
import { executeAgentCliAsync, expoHomeOf, freePortAsync, setupFixtureAsync } from '../utils';

it.each(['ios', 'android'] as const)(
  'executes %s tunnel recovery and the same navigation then succeeds',
  async (platform) => {
    const root = await setupFixtureAsync('go-app');
    await installStubEasAsync(root);
    const port = await freePortAsync();
    const env = {
      STUB_EXPO_DEV_SERVER_PORT: String(port),
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: '120000',
      STUB_SIM_PLATFORM: platform.toUpperCase(),
    };
    const run = (args: string[]) => executeAgentCliAsync(root, args, { env, reject: false });
    const navigate = ['navigate', '/', `--${platform}`, '--eas', '--no-wait-attach', '--json'];
    try {
      const started = await run([
        'dev',
        `--${platform}`,
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
      await writeCloudSessionFileAsync(root, 'sess-e2e');
      await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'sess-e2e', platform });
      const refused = await run(navigate);
      const error = JSON.parse(refused.stdout).error;
      expect(error?.code, refused.all).toBe('CLOUD_SIMULATOR_UNREACHABLE_DEV_SERVER');
      expect(error.suggestedCommand).toContain('--tunnel');
      expect(error.suggestedCommand).toContain(`--port ${port}`);
      expect(error.suggestedCommand).toContain('--go');
      const recovered = await runRecoveryCommand(root, error.suggestedCommand, {
        ...env,
        STUB_EXPO_TUNNEL_HOST: 'recovery.tunnel.example',
        STUB_EXPO_TUNNEL_DELAY_MS: '20',
      });
      expect(recovered.exitCode, recovered.all).toBe(0);
      const opened = await run(navigate);
      expect(opened.exitCode, opened.all).toBe(0);
      expect(JSON.parse(opened.stdout).url).toContain('recovery.tunnel.example');
    } finally {
      await run(['dev:stop', '--eas', '--json']);
    }
  }
);
