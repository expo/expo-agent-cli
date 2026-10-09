// @ref llp/0005-runtime-loop-tools.rfc.md §Proof
import type { SpawnCaptureResult } from '../../utils/spawnCapture';
import { fingerprintCandidatePaths, readSimulatorsAsync } from '../iosSimulator';

/** The file expo-constants embeds: the hash plus the version that produced it. */
const embed = (hash: string, fingerprintVersion: string | null = '0.21.0') =>
  JSON.stringify({ hash, fingerprintVersion });

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

const device = (simulator: FakeSimulator) => ({
  identifier: simulator.udid,
  name: simulator.name,
});

describe(readSimulatorsAsync, () => {
  const phone = { udid: 'UDID-1', name: 'iPhone 17 Pro', container: '/sims/1/App.app' };

  it.each(fingerprintCandidatePaths('/sims/1/App.app').map((p) => [p]))(
    `reads the embedded file at %s`,
    async (filePath) => {
      const fake = fakeSimctl([phone], { [filePath]: embed('abc') });

      await expect(
        readSimulatorsAsync([device(phone)], APP_ID, 'abc', fake)
      ).resolves.toMatchObject({
        status: 'ok',
        hash: 'abc',
        fingerprintVersion: '0.21.0',
        appId: APP_ID,
        device: device(phone),
      });
    }
  );

  it(`answers app-not-installed when the container is refused`, async () => {
    const fake = fakeSimctl([{ ...phone, container: null }], {});

    await expect(readSimulatorsAsync([device(phone)], APP_ID, 'x', fake)).resolves.toMatchObject({
      status: 'app-not-installed',
      appId: APP_ID,
    });
  });

  it(`answers no-embedded-fingerprint when neither candidate file exists`, async () => {
    const fake = fakeSimctl([phone], {});

    await expect(readSimulatorsAsync([device(phone)], APP_ID, 'x', fake)).resolves.toMatchObject({
      status: 'no-embedded-fingerprint',
    });
  });

  it(`keeps the answer that matches the expected hash across simulators`, async () => {
    const stale = { udid: 'UDID-2', name: 'iPad', container: '/sims/2/App.app' };
    const fake = fakeSimctl([phone, stale], {
      [fingerprintCandidatePaths(phone.container)[0]!]: embed('old'),
      [fingerprintCandidatePaths(stale.container)[0]!]: embed('current'),
    });

    await expect(
      readSimulatorsAsync([device(phone), device(stale)], APP_ID, 'current', fake)
    ).resolves.toMatchObject({ status: 'ok', hash: 'current', device: device(stale) });
  });
});
