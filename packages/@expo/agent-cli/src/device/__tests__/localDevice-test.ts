// @ref llp/0009-smart-followups.rfc.md §Device-aware ladders
// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
//
// The three answers matter more than the probe: `absent` is what turns `navigate` off, and it may
// only be given by a rung that read its binding and reported nothing up. A tool that could not run
// at all is silence, and silence has to read as `unknown` — a machine with no `adb` is not a
// machine with no device.

import type { Inspection } from '../../deviceBinding';
import { CommandError } from '../../utils/errors';
import { probeLocalDeviceAsync, readLocalDeviceProbe, resetLocalDeviceCache } from '../localDevice';

const projectRoot = '/project';

function inspection(
  state: Inspection['state'],
  extra: Partial<Inspection> = {},
  platform: 'ios' | 'android' = 'ios'
): Inspection {
  const device =
    platform === 'ios'
      ? ({
          backend: 'local-ios',
          platform: 'ios',
          udid: 'UDID-1',
          name: 'agent-cli 0000',
          origin: 'created',
        } as const)
      : ({
          backend: 'local-android',
          platform: 'android',
          serial: 'emulator-5554',
          origin: { kind: 'explicit' },
        } as const);
  return {
    binding:
      state === 'none' || state === 'unreadable'
        ? null
        : {
            version: 1,
            device,
            projectRoot,
            boundAt: '2026-10-08T09:00:00.000Z',
            expiresAt: '2026-10-08T11:00:00.000Z',
          },
    path: `/home/.expo/agent-cli/bindings/x-${platform}-local-${platform}.json`,
    state,
    ...extra,
  };
}

const androidUp = inspection('up', {}, 'android');
const noAndroid = inspection('none', {}, 'android');
/** An `adb` that is not installed, which establishes nothing about the machine (F49). */
const adbUnrunnable = inspection(
  'unknown',
  { cause: 'tool', toolError: new CommandError('ADB_NOT_RUNNABLE', 'adb could not be run') },
  'android'
);

describe(readLocalDeviceProbe, () => {
  it(`reports the bound simulator when it is up`, () => {
    const probe = readLocalDeviceProbe(inspection('up'), noAndroid);

    expect(probe.state).toBe('present');
    expect(probe.device).toMatchObject({ backend: 'local-ios', deviceId: 'UDID-1' });
    expect(probe.devices).toHaveLength(1);
  });

  // probe-local-combines-platforms
  it(`reports every up device, the bound simulator first (F106)`, () => {
    const probe = readLocalDeviceProbe(inspection('up'), androidUp);

    expect(probe.state).toBe('present');
    expect(probe.devices.map((device) => device.deviceId)).toEqual(['UDID-1', 'emulator-5554']);
  });

  it(`reports the emulator alone when the simulator is not up`, () => {
    const probe = readLocalDeviceProbe(inspection('not-up'), androidUp);

    expect(probe.state).toBe('present');
    expect(probe.devices.map((device) => device.deviceId)).toEqual(['emulator-5554']);
    expect(probe.device).toMatchObject({ backend: 'local-android', adb: expect.anything() });
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
    expect(probe.reason).toContain('Android: no emulator instance is bound');
  });

  it.each([
    ['unreadable', inspection('unreadable')],
    ['unknown', inspection('unknown', { cause: 'timeout' })],
  ] as const)(`reports unknown for an %s binding`, (_state, ios) => {
    expect(readLocalDeviceProbe(ios, noAndroid).state).toBe('unknown');
  });

  it(`reports unknown when adb could not check the bound instance`, () => {
    const probe = readLocalDeviceProbe(inspection('none'), adbUnrunnable);

    expect(probe.state).toBe('unknown');
    expect(probe.reason).toContain('could not be run');
  });

  it(`reports a not-up instance as absent, with the state of both rungs`, () => {
    const probe = readLocalDeviceProbe(
      inspection('gone', { cause: 'device-gone' }),
      inspection('not-up', {}, 'android')
    );

    expect(probe.state).toBe('absent');
    expect(probe.reason).toBe(
      'iOS: the bound simulator is gone; Android: the bound emulator instance is not up'
    );
  });

  it(`reads only the Android rung off macOS`, () => {
    expect(readLocalDeviceProbe(null, noAndroid)).toMatchObject({
      state: 'absent',
      reason: 'Android: no emulator instance is bound to this worktree',
    });
  });
});

describe(probeLocalDeviceAsync, () => {
  beforeEach(() => resetLocalDeviceCache());
  afterEach(() => resetLocalDeviceCache());

  it(`asks the rungs once per root, however many callers ask`, async () => {
    const inspectIosAsync = vi.fn(async () => inspection('none'));
    const inspectAndroidAsync = vi.fn(async () => noAndroid);
    const options = {
      projectRoot,
      inspectIosAsync,
      inspectAndroidAsync,
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
    expect(inspectAndroidAsync).toHaveBeenCalledTimes(2);
    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(first.state).toBe('absent');
  });

  it(`reads no iOS rung off macOS`, async () => {
    const inspectIosAsync = vi.fn(async () => inspection('up'));

    const probe = await probeLocalDeviceAsync({
      projectRoot,
      inspectIosAsync,
      inspectAndroidAsync: async () => androidUp,
      hostPlatform: 'linux',
    });

    expect(inspectIosAsync).not.toHaveBeenCalled();
    expect(probe.devices.map((device) => device.platform)).toEqual(['android']);
  });

  // A probe is a convenience: a suggestion ladder must never be the thing that fails a command.
  it(`answers unknown when a rung itself throws`, async () => {
    const probe = await probeLocalDeviceAsync({
      projectRoot,
      inspectIosAsync: async () => {
        throw new Error('simctl exploded');
      },
      inspectAndroidAsync: async () => noAndroid,
      hostPlatform: 'darwin',
    });

    expect(probe.state).toBe('unknown');
    expect(probe.reason).toContain('simctl exploded');
  });
});
