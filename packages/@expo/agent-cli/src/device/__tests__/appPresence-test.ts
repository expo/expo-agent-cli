// @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
//
// The half of this worth testing is what it *refuses* to say. Only `missing` adds a minute of
// install to a plan, so every path that could not establish it has to answer `unknown` — and
// `unknown` is the state every run was in before this module existed, so it can only ever plan
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
    hasAppOnDevice: async () => true,
    androidDeviceName: async () => 'tuft-pixel',
    ...overrides,
  };
}

beforeEach(() => {
  // The e2e harness sets this to keep its runs off the host's real devices; a unit test injects
  // every dependency, so the guard would only hide what the row means to exercise.
  delete process.env.AGENT_CLI_NO_DEVICE;
});

describe(probeAppPresenceAsync, () => {
  it(`should answer present when the device has the app`, async () => {
    expect(await probeAppPresenceAsync(projectRoot, 'ios', deps())).toEqual({
      presence: 'present',
      installDevice: null,
    });
  });

  it(`should answer missing, naming the device, when it has not got the app`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({ hasAppOnDevice: async () => false })
    );

    // The UDID as-is: that is what `expo run:ios --device` takes.
    expect(probe).toEqual({ presence: 'missing', installDevice: 'UDID-1' });
  });

  it(`should name an Android device by the name expo run takes, not the serial`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'android',
      deps({
        probeDeviceAsync: probeOf([androidDevice()]),
        hasAppOnDevice: async () => false,
      })
    );

    expect(probe).toEqual({ presence: 'missing', installDevice: 'tuft-pixel' });
  });

  it(`should leave the install unpinned when Android cannot name the device`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'android',
      deps({
        probeDeviceAsync: probeOf([androidDevice()]),
        hasAppOnDevice: async () => false,
        androidDeviceName: async () => null,
      })
    );

    expect(probe).toEqual({ presence: 'missing', installDevice: null });
  });

  it(`should ask about the id the project config names`, async () => {
    const asked: string[] = [];
    await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({
        hasAppOnDevice: async (_deviceId, _backend, appId) => {
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
    const probe = await probeAppPresenceAsync(projectRoot, 'ios', deps({ readAppId: () => null }));

    expect(probe.presence).toBe('unknown');
  });

  // Not `missing`: `expo start` boots a device itself, so a plan is in no position to say the app
  // is not on one that does not exist yet.
  it(`should answer unknown when this machine has no device for the platform`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({ probeDeviceAsync: probeOf([]) })
    );

    expect(probe.presence).toBe('unknown');
  });

  it(`should answer unknown when the only device is the other platform's`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({ probeDeviceAsync: probeOf([androidDevice()]) })
    );

    expect(probe.presence).toBe('unknown');
  });

  it(`should ask the device of the platform being planned for`, async () => {
    const asked: string[] = [];
    await probeAppPresenceAsync(
      projectRoot,
      'android',
      deps({
        probeDeviceAsync: probeOf([iosDevice('UDID-1'), androidDevice('emulator-5554')]),
        hasAppOnDevice: async (deviceId) => {
          asked.push(deviceId);
          return true;
        },
      })
    );

    expect(asked).toEqual(['emulator-5554']);
  });

  // @ref ../hasApp — `null` is "could not look": an unreadable simulator tree, an adb that would
  // not run, a cloud device this machine cannot see. None of them are an app that is not there.
  it(`should read "could not look" as unknown, never as missing`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({ hasAppOnDevice: async () => null })
    );

    expect(probe.presence).toBe('unknown');
  });

  it(`should answer unknown when the deadline expires, and not hang the plan`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      deps({
        budgetMs: 20,
        probeDeviceAsync: () => new Promise(() => {}),
      })
    );

    expect(probe.presence).toBe('unknown');
  });

  it(`should answer unknown without asking anything under AGENT_CLI_NO_DEVICE`, async () => {
    process.env.AGENT_CLI_NO_DEVICE = '1';
    try {
      const probe = await probeAppPresenceAsync(
        projectRoot,
        'ios',
        deps({
          probeDeviceAsync: () => {
            throw new Error('the harness said no device, and something probed anyway');
          },
        })
      );

      expect(probe.presence).toBe('unknown');
    } finally {
      delete process.env.AGENT_CLI_NO_DEVICE;
    }
  });

  // The property that makes this safe to call on the hot path: a probe is not allowed to be the
  // thing that fails `dev`.
  it.each([
    ['the device probe throws', { probeDeviceAsync: () => Promise.reject(new Error('simctl exploded')) }],
    ['the app lookup throws', { hasAppOnDevice: () => Promise.reject(new Error('no such simulator')) }],
    [
      'reading the app id throws',
      {
        readAppId: () => {
          throw new Error('unreadable config');
        },
      },
    ],
  ])(`should answer unknown rather than reject when %s`, async (_case, overrides) => {
    const probe = await probeAppPresenceAsync(projectRoot, 'ios', deps(overrides as never));

    expect(probe.presence).toBe('unknown');
  });
});
