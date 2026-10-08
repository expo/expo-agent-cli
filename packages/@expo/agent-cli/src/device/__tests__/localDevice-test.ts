// @ref llp/0009-smart-followups.rfc.md §Device-aware ladders
// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
//
// The three answers matter more than the probe: `absent` is what turns `navigate` off, and it may
// only be given by a rung that ran and reported nothing. A tool that could not run at all is
// silence, and silence has to read as `unknown` — a machine with no `adb` is not a machine with no
// device.

import type { Inspection } from '../../deviceBinding';
import type { DeviceProbe } from '../../navigate/device';
import { CommandError } from '../../utils/errors';
import { probeLocalDeviceAsync, readLocalDeviceProbe, resetLocalDeviceCache } from '../localDevice';

const projectRoot = '/project';

function inspection(state: Inspection['state'], extra: Partial<Inspection> = {}): Inspection {
  return {
    binding:
      state === 'none' || state === 'unreadable'
        ? null
        : {
            version: 1,
            device: {
              backend: 'local-ios',
              platform: 'ios',
              udid: 'UDID-1',
              name: 'agent-cli 0000',
              origin: 'created',
            },
            projectRoot,
            boundAt: '2026-10-08T09:00:00.000Z',
            expiresAt: '2026-10-08T11:00:00.000Z',
          },
    path: '/home/.expo/agent-cli/bindings/x-ios-local-ios.json',
    state,
    ...extra,
  };
}

/** An attached Android emulator, as the probe reports it. */
const foundAndroid: DeviceProbe = {
  device: {
    backend: 'local-android',
    platform: 'android',
    deviceId: 'emulator-5554',
    name: 'sdk_gphone64_arm64',
  },
};

const noAndroid: DeviceProbe = {
  device: null,
  reason: 'no Android device or emulator is attached',
};

/** An `adb` that is not installed, which establishes nothing about the machine (F49). */
const adbUnrunnable: DeviceProbe = {
  device: null,
  reason: 'could not run "adb": spawn adb ENOENT',
  toolError: new CommandError('ADB_NOT_RUNNABLE', 'adb could not be run'),
};

describe(readLocalDeviceProbe, () => {
  it(`reports the bound simulator when it is up`, () => {
    const probe = readLocalDeviceProbe(inspection('up'), noAndroid);

    expect(probe.state).toBe('present');
    expect(probe.device).toMatchObject({ backend: 'local-ios', deviceId: 'UDID-1' });
    expect(probe.devices).toHaveLength(1);
  });

  // probe-local-combines-platforms
  it(`reports every up device, the bound simulator first (F106)`, () => {
    const probe = readLocalDeviceProbe(inspection('up'), foundAndroid);

    expect(probe.state).toBe('present');
    expect(probe.devices.map((device) => device.deviceId)).toEqual(['UDID-1', 'emulator-5554']);
  });

  it(`reports the emulator alone when the simulator is not up`, () => {
    const probe = readLocalDeviceProbe(inspection('not-up'), foundAndroid);

    expect(probe.state).toBe('present');
    expect(probe.devices.map((device) => device.deviceId)).toEqual(['emulator-5554']);
  });

  it.each([
    ['none', inspection('none'), 'no simulator is bound'],
    ['gone', inspection('gone', { cause: 'expired' }), 'lease'],
    ['not-up', inspection('not-up'), 'not up'],
  ] as const)(`reports absent for a %s binding and no emulator`, (_state, ios, reason) => {
    const probe = readLocalDeviceProbe(ios, noAndroid);

    expect(probe.state).toBe('absent');
    expect(probe.device).toBeNull();
    expect(probe.devices).toEqual([]);
    expect(probe.reason).toContain(reason);
    expect(probe.reason).toContain('no Android device');
  });

  it.each([
    ['unreadable', inspection('unreadable')],
    ['unknown', inspection('unknown', { cause: 'timeout' })],
  ] as const)(`reports unknown for an %s binding`, (_state, ios) => {
    expect(readLocalDeviceProbe(ios, noAndroid).state).toBe('unknown');
  });

  it(`reports unknown when adb could not run and nothing is bound`, () => {
    const probe = readLocalDeviceProbe(inspection('none'), adbUnrunnable);

    expect(probe.state).toBe('unknown');
    expect(probe.reason).toContain('could not run');
  });

  it(`reads only the Android rung off macOS`, () => {
    expect(readLocalDeviceProbe(null, noAndroid)).toMatchObject({
      state: 'absent',
      reason: 'Android: no Android device or emulator is attached',
    });
  });
});

describe(probeLocalDeviceAsync, () => {
  beforeEach(() => resetLocalDeviceCache());
  afterEach(() => resetLocalDeviceCache());

  it(`asks the rungs once per root, however many callers ask`, async () => {
    const inspectIosAsync = vi.fn(async () => inspection('none'));
    const probeAndroidAsync = vi.fn(async () => noAndroid);
    const options = {
      projectRoot,
      inspectIosAsync,
      probeAndroidAsync,
      hostPlatform: 'darwin' as const,
    };

    const [first, second] = await Promise.all([
      probeLocalDeviceAsync(options),
      probeLocalDeviceAsync(options),
    ]);
    const other = await probeLocalDeviceAsync({ ...options, projectRoot: '/other' });

    expect(inspectIosAsync).toHaveBeenCalledTimes(2);
    expect(inspectIosAsync).toHaveBeenCalledWith(projectRoot);
    expect(inspectIosAsync).toHaveBeenCalledWith('/other');
    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(first.state).toBe('absent');
  });

  // A probe is a convenience: a suggestion ladder must never be the thing that fails a command.
  it(`answers unknown when a rung itself throws`, async () => {
    const probe = await probeLocalDeviceAsync({
      projectRoot,
      inspectIosAsync: async () => {
        throw new Error('simctl exploded');
      },
      probeAndroidAsync: async () => noAndroid,
      hostPlatform: 'darwin',
    });

    expect(probe.state).toBe('unknown');
    expect(probe.reason).toContain('simctl exploded');
  });
});
