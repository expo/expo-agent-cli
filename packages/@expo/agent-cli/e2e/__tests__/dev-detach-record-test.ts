// @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table — a build is recorded when
// the app reaches the device, so a stale plan builds with `run:* --no-bundler` and then serves.
import { cleanUpDetachedAsync, detachEnv } from '../detachUtils';
import {
  executeAgentCliAsync,
  freePortAsync,
  installStubFingerprintAsync,
  readDevLockAsync,
  readLastBuildFile,
  readStubExpoInvocations,
  setupFixtureAsync,
  waitForAsync,
} from '../utils';

const CHANGED_HASH = 'b1c2d3e4f5061728394a5b6c7d8e9f0011223344';

describe('dev --detach build record', () => {
  it('records the build once the app reaches the device, while the dev server still serves', async () => {
    const projectRoot = await setupFixtureAsync('dev-client-fresh-app');
    await installStubFingerprintAsync(projectRoot);
    const port = await freePortAsync();
    const env = {
      ...detachEnv(projectRoot, port),
      STUB_EXPO_LISTEN: '1',
      STUB_FINGERPRINT_HASH: CHANGED_HASH,
    };
    try {
      const started = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--local', '--port', String(port), '--detach', '--wait-ready', '--json'],
        { env, reject: false }
      );
      expect(started.exitCode, started.all).toBe(0);

      const recorded = () =>
        (readLastBuildFile(projectRoot) as { ios?: { hash?: string } } | null)?.ios?.hash ===
        CHANGED_HASH;
      expect(await waitForAsync(recorded, 10_000)).toBe(true);
      expect(await readDevLockAsync(projectRoot)).toMatchObject({ port, phase: 'serving' });
      expect(readStubExpoInvocations(projectRoot).map(({ args }) => args)).toEqual([
        ['prebuild', '--platform', 'ios'],
        ['run:ios', '--no-bundler'],
        ['start', '--dev-client', '--port', String(port)],
      ]);
    } finally {
      await cleanUpDetachedAsync(projectRoot);
    }
  }, 60_000);
});
