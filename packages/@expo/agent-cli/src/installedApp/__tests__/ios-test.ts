// @ref llp/0005-runtime-loop-tools.rfc.md §Proof
// The routing between booted simulators and connected phones. Both readers are injected.
import type { IosDevice } from '../../device/devicectl';
import type { SpawnCaptureResult } from '../../utils/spawnCapture';
import type { InstalledFingerprintResult } from '../installedFingerprint';
import { readInstalledFingerprintIosAsync } from '../ios';
import type { readInstalledFingerprintIosDeviceAsync } from '../iosDevice';
import { fingerprintCandidatePaths } from '../iosSimulator';

const appId = 'dev.expo.app';

function phone(overrides: Partial<IosDevice> = {}): IosDevice {
  return {
    udid: 'PHONE-A',
    name: 'Ada’s iPhone',
    developerModeEnabled: true,
    reachable: true,
    ...overrides,
  };
}

/** A `simctl` with these booted simulators, each holding the given hash or nothing. */
function fakeSimctl(simulators: { udid: string; name: string; hash: string | null }[]) {
  const spawnCaptureAsync = async (
    _command: string,
    args: string[]
  ): Promise<SpawnCaptureResult> => {
    if (args[1] === 'list') {
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-0': simulators.map(({ udid, name }) => ({
              udid,
              name,
            })),
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: `/sims/${args[2]}/App.app\n`, stderr: '', exitCode: 0 };
  };
  const readFile = (filePath: string): string => {
    const simulator = simulators.find(
      (s) => filePath === fingerprintCandidatePaths(`/sims/${s.udid}/App.app`)[0]
    );
    if (!simulator?.hash) {
      throw new Error('ENOENT');
    }
    return JSON.stringify({ hash: simulator.hash, fingerprintVersion: '0.21.0' });
  };
  return { spawnCaptureAsync, readFile };
}

function phoneReader(result: InstalledFingerprintResult) {
  return vi.fn(
    async (_input: Parameters<typeof readInstalledFingerprintIosDeviceAsync>[0]) => result
  );
}

const phoneMatch: InstalledFingerprintResult = {
  status: 'ok',
  hash: 'current',
  fingerprintVersion: '0.21.0',
  appId,
  device: { name: 'Ada’s iPhone', identifier: 'PHONE-A' },
};

function read(
  simulators: { udid: string; name: string; hash: string | null }[],
  phones: IosDevice[],
  readPhones = phoneReader(phoneMatch),
  device?: string
) {
  const listPhones = vi.fn(async () => phones);
  // The bound simulator is the first listed one; `--device` lists and filters instead.
  const findBoundSimulatorAsync = vi.fn(async () =>
    simulators[0]
      ? { simulator: { identifier: simulators[0].udid, name: simulators[0].name }, hint: null }
      : { simulator: null, hint: 'How: run "npx @expo/agent-cli dev --ios --detach --wait-ready".' }
  );
  const result = readInstalledFingerprintIosAsync({
    projectRoot: '/project',
    expectedHash: 'current',
    appId,
    scheme: 'myapp',
    device,
    deps: {
      ...fakeSimctl(simulators),
      listConnectedIosDevicesAsync: listPhones,
      readInstalledFingerprintIosDeviceAsync: readPhones,
      findBoundSimulatorAsync,
    },
  });
  return { result, listPhones, readPhones, findBoundSimulatorAsync };
}

describe(readInstalledFingerprintIosAsync, () => {
  const booted = { udid: 'SIM-1', name: 'iPhone 17 Pro', hash: 'current' };

  it(`answers from a booted simulator without listing phones`, async () => {
    const { result, listPhones, readPhones } = read([booted], [phone()]);
    await expect(result).resolves.toMatchObject({ status: 'ok', device: { identifier: 'SIM-1' } });
    expect(listPhones).not.toHaveBeenCalled();
    expect(readPhones).not.toHaveBeenCalled();
  });

  // Probing launches the app, and `status` starts nothing it was not asked to start — so a phone
  // is left alone even when it is the only iOS device this machine has.
  it(`never probes a phone that --device did not name, even as the only device`, async () => {
    const { result, readPhones } = read([], [phone()]);
    await expect(result).resolves.toMatchObject({
      status: 'no-device',
      hint: expect.stringContaining('--device'),
    });
    expect(readPhones).not.toHaveBeenCalled();
  });

  // The registry's How line leads the hint, and the phone hint follows it when there is one.
  it(`answers no-device with the dev command when nothing is bound and no reachable phone is connected`, async () => {
    const { result, readPhones } = read([], [phone({ reachable: false })]);
    await expect(result).resolves.toEqual({
      status: 'no-device',
      hint: 'How: run "npx @expo/agent-cli dev --ios --detach --wait-ready".',
    });
    expect(readPhones).not.toHaveBeenCalled();
  });

  it(`puts the dev command before the phone hint`, async () => {
    const { result } = read([], [phone()]);
    const answer = await result;
    expect(answer.hint).toMatch(
      /^How: run "npx @expo\/agent-cli dev --ios[^"]*"\. A physical iOS device/
    );
  });

  it(`asks for --device instead of probing several phones`, async () => {
    const { result, readPhones } = read(
      [],
      [phone(), phone({ udid: 'PHONE-B', name: 'Second Phone' })]
    );
    const answer = await result;
    expect(answer).toMatchObject({ status: 'no-device' });
    expect(answer.hint).toContain('Ada’s iPhone, Second Phone');
    expect(answer.hint).toContain('--device');
    expect(readPhones).not.toHaveBeenCalled();
  });

  it(`probes the phone --device names when no simulator matches it`, async () => {
    const { result, readPhones } = read([booted], [phone()], undefined, 'ada’s iphone');
    await expect(result).resolves.toEqual(phoneMatch);
    expect(readPhones.mock.calls[0]![0]).toMatchObject({ device: 'ada’s iphone' });
  });

  it(`answers no-device for a --device nothing has`, async () => {
    const { result, readPhones } = read([booted], [phone()], undefined, 'Nobody');
    await expect(result).resolves.toEqual({ status: 'no-device' });
    expect(readPhones).not.toHaveBeenCalled();
  });

  it(`reads only the simulator --device names, and never the phone`, async () => {
    const stale = { udid: 'SIM-2', name: 'iPad', hash: 'old' };
    const { result, listPhones } = read([booted, stale], [phone()], undefined, 'iPad');
    await expect(result).resolves.toMatchObject({
      status: 'ok',
      hash: 'old',
      fingerprintVersion: '0.21.0',
      device: { identifier: 'SIM-2' },
    });
    expect(listPhones).not.toHaveBeenCalled();
  });

  it(`names a connected phone when the simulator answer is inconclusive, and does not probe it`, async () => {
    const { result, readPhones } = read([{ ...booted, hash: null }], [phone()]);
    const answer = await result;
    expect(answer).toMatchObject({ status: 'no-embedded-fingerprint' });
    expect(answer.hint).toContain('--device "Ada’s iPhone"');
    expect(readPhones).not.toHaveBeenCalled();
  });

  it(`adds no hint when the simulator is inconclusive and no phone is connected`, async () => {
    const { result } = read([{ ...booted, hash: 'old' }], []);
    const answer = await result;
    expect(answer).toMatchObject({ status: 'ok', hash: 'old' });
    expect(answer.hint).toBeUndefined();
  });
});
