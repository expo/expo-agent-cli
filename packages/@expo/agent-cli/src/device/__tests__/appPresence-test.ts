// @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
//
// The half of this worth testing is what it *refuses* to say. Only `'missing'` adds a minute of
// install to a plan, so every path that could not establish it has to answer `'unknown'` — and
// `'unknown'` is the state every run was in before this module existed, so it can only ever plan
// what was planned yesterday.

import type { NavigateDevice } from '../../navigate/device';
import { probeAppPresenceAsync } from '../appPresence';
import type { LocalDeviceProbe } from '../localDevice';

const APP_ID = 'com.example.app';
const projectRoot = '/project';

function iosDevice(deviceId = 'UDID-1'): NavigateDevice {
  return { backend: 'local-ios', platform: 'ios', deviceId, name: 'iPhone 17 Pro' };
}

function androidDevice(deviceId = 'emulator-5554'): NavigateDevice {
  return { backend: 'local-android', platform: 'android', deviceId };
}

function probeOf(devices: NavigateDevice[]): () => Promise<LocalDeviceProbe> {
  return async () => ({
    state: devices.length ? 'present' : 'absent',
    device: devices[0] ?? null,
    devices,
    reason: devices.length ? null : 'no device',
  });
}

/** The defaults every row overrides one of: an iOS simulator that has the app. */
function deps(overrides: Parameters<typeof probeAppPresenceAsync>[2] = {}) {
  return {
    readAppId: () => APP_ID,
    probeDeviceAsync: probeOf([iosDevice()]),
    simulatorHasApp: async () => true,
    androidHasApp: async () => true,
    ...overrides,
  };
}

describe(probeAppPresenceAsync, () => {
  it(`should answer present when the simulator has the app`, async () => {
    expect(await probeAppPresenceAsync(projectRoot, 'ios', deps())).toBe('present');
  });

  it(`should answer missing when the simulator has not got it`, async () => {
    const presence = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({ simulatorHasApp: async () => false })
    );

    expect(presence).toBe('missing');
  });

  it(`should ask about the id the project config names`, async () => {
    const asked: string[] = [];
    await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({
        simulatorHasApp: async (_udid, appId) => {
          asked.push(appId);
          return true;
        },
      })
    );

    expect(asked).toEqual([APP_ID]);
  });

  // A project that declares no `bundleIdentifier` cannot be looked for under any name, and asking
  // about the Expo Go id instead would answer about a different app entirely.
  it(`should answer unknown when the config names no app id`, async () => {
    const presence = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({ readAppId: () => null })
    );

    expect(presence).toBe('unknown');
  });

  // Not `missing`: `expo start` boots a device itself, so a plan is in no position to say the app
  // is not on one that does not exist yet.
  it(`should answer unknown when this machine has no device for the platform`, async () => {
    const presence = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({ probeDeviceAsync: probeOf([]) })
    );

    expect(presence).toBe('unknown');
  });

  it(`should answer unknown when the only device is the other platform's`, async () => {
    const presence = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({ probeDeviceAsync: probeOf([androidDevice()]) })
    );

    expect(presence).toBe('unknown');
  });

  it(`should pick the device of the platform being planned for`, async () => {
    const asked: string[] = [];
    await probeAppPresenceAsync(
      projectRoot,
      'android',
      deps({
        probeDeviceAsync: probeOf([iosDevice('UDID-1'), androidDevice('emulator-5554')]),
        androidHasApp: async (serial) => {
          asked.push(serial);
          return true;
        },
      })
    );

    expect(asked).toEqual(['emulator-5554']);
  });

  // @ref ../androidApps — `null` is "the lookup did not happen", not "the app is not there".
  it(`should carry Android's undecided answer through as unknown`, async () => {
    const presence = await probeAppPresenceAsync(
      projectRoot,
      'android',
      deps({
        probeDeviceAsync: probeOf([androidDevice()]),
        androidHasApp: async () => null,
      })
    );

    expect(presence).toBe('unknown');
  });

  it(`should read Android's false as missing`, async () => {
    const presence = await probeAppPresenceAsync(
      projectRoot,
      'android',
      deps({
        probeDeviceAsync: probeOf([androidDevice()]),
        androidHasApp: async () => false,
      })
    );

    expect(presence).toBe('missing');
  });

  // The property that makes this safe to call on the hot path: a probe is not allowed to be the
  // thing that fails `dev`.
  it.each([
    [
      'the device probe throws',
      {
        probeDeviceAsync: () => Promise.reject(new Error('simctl exploded')),
      },
    ],
    [
      'the app lookup throws',
      {
        simulatorHasApp: () => Promise.reject(new Error('no such simulator')),
      },
    ],
    [
      'reading the app id throws',
      {
        readAppId: () => {
          throw new Error('unreadable config');
        },
      },
    ],
  ])(`should answer unknown rather than reject when %s`, async (_case, overrides) => {
    await expect(
      probeAppPresenceAsync(projectRoot, 'ios', deps(overrides as never))
    ).resolves.toBe('unknown');
  });
});
