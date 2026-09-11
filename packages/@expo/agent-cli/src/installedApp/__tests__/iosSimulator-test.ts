// @ref llp/0028-installed-app-check.rfc.md §Proof
import type { SpawnCaptureResult } from '../../utils/spawnCapture';
import {
  fingerprintCandidatePaths,
  readInstalledFingerprintIosSimulatorAsync,
} from '../iosSimulator';

const APP_ID = 'com.example.app';

interface FakeSimulator {
  udid: string;
  name: string;
  /** Path of the app container, or null when the app is not installed. */
  container: string | null;
}

function fakeSimctl(simulators: FakeSimulator[], files: Record<string, string>) {
  const ok = (stdout: string): SpawnCaptureResult => ({ stdout, stderr: '', exitCode: 0 });
  const spawnCaptureAsync = async (
    _command: string,
    args: string[]
  ): Promise<SpawnCaptureResult> => {
    if (args[1] === 'list') {
      return ok(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-0': simulators.map(({ udid, name }) => ({
              udid,
              name,
              state: 'Booted',
            })),
            'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'WATCH', name: 'Watch' }],
          },
        })
      );
    }
    const simulator = simulators.find((s) => s.udid === args[2]);
    if (!simulator?.container) {
      return { stdout: '', stderr: 'No such file or directory', exitCode: 2 };
    }
    return ok(`${simulator.container}\n`);
  };
  const readFile = (filePath: string): string => {
    const content = files[filePath];
    if (content == null) {
      throw Object.assign(new Error(`ENOENT ${filePath}`), { code: 'ENOENT' });
    }
    return content;
  };
  return { spawnCaptureAsync, readFile };
}

describe(readInstalledFingerprintIosSimulatorAsync, () => {
  const phone = { udid: 'UDID-1', name: 'iPhone 17 Pro', container: '/sims/1/App.app' };

  it.each(fingerprintCandidatePaths('/sims/1/App.app').map((p) => [p]))(
    `reads the hash at %s`,
    async (filePath) => {
      const fake = fakeSimctl([phone], { [filePath]: 'abc123\n' });
      await expect(
        readInstalledFingerprintIosSimulatorAsync({
          expectedHash: 'abc123',
          appId: APP_ID,
          ...fake,
        })
      ).resolves.toEqual({
        status: 'ok',
        hash: 'abc123',
        appId: APP_ID,
        device: { name: 'iPhone 17 Pro', identifier: 'UDID-1' },
      });
    }
  );

  it(`answers no-embedded-fingerprint when the container holds no file`, async () => {
    const fake = fakeSimctl([phone], {});
    await expect(
      readInstalledFingerprintIosSimulatorAsync({ expectedHash: 'x', appId: APP_ID, ...fake })
    ).resolves.toMatchObject({ status: 'no-embedded-fingerprint' });
  });

  it(`answers app-not-installed when get_app_container fails`, async () => {
    const fake = fakeSimctl([{ ...phone, container: null }], {});
    await expect(
      readInstalledFingerprintIosSimulatorAsync({ expectedHash: 'x', appId: APP_ID, ...fake })
    ).resolves.toMatchObject({ status: 'app-not-installed' });
  });

  it(`prefers the simulator whose app matches`, async () => {
    const old = { udid: 'UDID-2', name: 'iPad', container: '/sims/2/App.app' };
    const fake = fakeSimctl([old, phone], {
      [fingerprintCandidatePaths(old.container)[0]!]: 'old',
      [fingerprintCandidatePaths(phone.container)[0]!]: 'current',
    });
    await expect(
      readInstalledFingerprintIosSimulatorAsync({
        expectedHash: 'current',
        appId: APP_ID,
        ...fake,
      })
    ).resolves.toMatchObject({ status: 'ok', hash: 'current', device: { identifier: 'UDID-1' } });
  });

  it(`only reads the simulator --device names, and answers no-device for a name nothing has`, async () => {
    const fake = fakeSimctl([phone], {});
    await expect(
      readInstalledFingerprintIosSimulatorAsync({
        expectedHash: 'x',
        appId: APP_ID,
        device: 'iphone 17 pro',
        ...fake,
      })
    ).resolves.toMatchObject({ status: 'no-embedded-fingerprint' });
    await expect(
      readInstalledFingerprintIosSimulatorAsync({
        expectedHash: 'x',
        appId: APP_ID,
        device: 'Watch',
        ...fake,
      })
    ).resolves.toEqual({ status: 'no-device' });
  });

  it(`answers no-device when nothing is booted`, async () => {
    const fake = fakeSimctl([], {});
    await expect(
      readInstalledFingerprintIosSimulatorAsync({ expectedHash: 'x', appId: APP_ID, ...fake })
    ).resolves.toEqual({ status: 'no-device' });
  });

  it(`throws XCRUN_NOT_RUNNABLE when xcrun cannot run`, async () => {
    await expect(
      readInstalledFingerprintIosSimulatorAsync({
        expectedHash: 'x',
        appId: APP_ID,
        spawnCaptureAsync: async () => ({
          stdout: '',
          stderr: '',
          exitCode: null,
          spawnError: Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }),
        }),
      })
    ).rejects.toMatchObject({ code: 'XCRUN_NOT_RUNNABLE' });
  });
});
