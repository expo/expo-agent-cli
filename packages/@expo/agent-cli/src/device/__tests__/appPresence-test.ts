// @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
//
// The half of this worth testing is what it *refuses* to say. Only `missing` adds a minute of
// install to a plan, so every path that could not establish it has to answer `unknown` — and
// `unknown` is the state every run was in before this module existed, so it can only ever plan
// what was planned yesterday.

import type { BoundDevice } from '../../deviceBinding';
import type { NavigateDevice } from '../../navigate/device';
import { probeAppPresenceAsync, type AppPresenceDevice } from '../appPresence';
import type { LocalDeviceProbe } from '../localDevice';

const APP_ID = 'com.example.app';
const projectRoot = '/project';

const BOUND: BoundDevice = {
  backend: 'local-ios',
  platform: 'ios',
  udid: 'UDID-1',
  name: 'agent-cli 0000',
  origin: 'created',
};
const reused: AppPresenceDevice = { device: BOUND, action: 'reused' };
const created: AppPresenceDevice = { device: BOUND, action: 'created' };
const unbound: AppPresenceDevice = { device: null, action: null };

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

/** The defaults every row overrides one of: a device that has the app. */
function deps(overrides: Parameters<typeof probeAppPresenceAsync>[3] = {}) {
  return {
    readAppId: () => APP_ID,
    probeDeviceAsync: probeOf([androidDevice()]),
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
  it(`should answer present when the bound device has the app`, async () => {
    expect(await probeAppPresenceAsync(projectRoot, 'ios', reused, deps())).toEqual({
      presence: 'present',
      installDevice: null,
    });
  });

  it(`should answer missing, with no device to pin, when the bound simulator has not got it`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      reused,
      deps({ hasAppOnDevice: async () => false })
    );

    // `dev` pins every build step to the bound simulator itself (`withDevice`), so nothing here.
    expect(probe).toEqual({ presence: 'missing', installDevice: null });
  });

  // created-device-missing-without-app-id
  it(`should answer missing for a created device without asking, even with no app id`, async () => {
    const hasAppOnDevice = vi.fn(async () => true);

    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      created,
      deps({ readAppId: () => null, hasAppOnDevice })
    );

    expect(probe).toEqual({ presence: 'missing', installDevice: null });
    expect(hasAppOnDevice).not.toHaveBeenCalled();
  });

  // null-device-ios-unprobed
  it(`should answer unknown on iOS with no bound device, asking nothing`, async () => {
    const probeDeviceAsync = vi.fn(probeOf([androidDevice()]));

    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      unbound,
      deps({ probeDeviceAsync })
    );

    expect(probe.presence).toBe('unknown');
    expect(probeDeviceAsync).not.toHaveBeenCalled();
  });

  it(`should ask the bound simulator, never the local probe`, async () => {
    const probeDeviceAsync = vi.fn(probeOf([androidDevice()]));
    const asked: string[] = [];
    await probeAppPresenceAsync(
      projectRoot,
      'ios',
      reused,
      deps({
        probeDeviceAsync,
        hasAppOnDevice: async (deviceId) => {
          asked.push(deviceId);
          return true;
        },
      })
    );

    expect(asked).toEqual(['UDID-1']);
    expect(probeDeviceAsync).not.toHaveBeenCalled();
  });

  it(`should name an Android device by the name expo run takes, not the serial`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'android',
      unbound,
      deps({ hasAppOnDevice: async () => false })
    );

    expect(probe).toEqual({ presence: 'missing', installDevice: 'tuft-pixel' });
  });

  it(`should hand the local probe the root it is about`, async () => {
    const probeDeviceAsync = vi.fn(probeOf([androidDevice()]));

    await probeAppPresenceAsync(projectRoot, 'android', unbound, deps({ probeDeviceAsync }));

    expect(probeDeviceAsync).toHaveBeenCalledWith(projectRoot);
  });

  it(`should leave the install unpinned when Android cannot name the device`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'android',
      unbound,
      deps({ hasAppOnDevice: async () => false, androidDeviceName: async () => null })
    );

    expect(probe).toEqual({ presence: 'missing', installDevice: null });
  });

  it(`should ask about the id the project config names`, async () => {
    const asked: string[] = [];
    await probeAppPresenceAsync(
      projectRoot,
      'ios',
      reused,
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
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      reused,
      deps({ readAppId: () => null })
    );

    expect(probe.presence).toBe('unknown');
  });

  it(`should answer unknown when this machine has no Android device`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'android',
      unbound,
      deps({ probeDeviceAsync: probeOf([]) })
    );

    expect(probe.presence).toBe('unknown');
  });

  // @ref ../hasApp — `null` is "could not look": an unreadable simulator tree, an adb that would
  // not run, a cloud device this machine cannot see. None of them are an app that is not there.
  it(`should read "could not look" as unknown, never as missing`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      reused,
      deps({ hasAppOnDevice: async () => null })
    );

    expect(probe.presence).toBe('unknown');
  });

  it(`should answer unknown when the deadline expires, and not hang the plan`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'android',
      unbound,
      deps({ budgetMs: 20, probeDeviceAsync: () => new Promise(() => {}) })
    );

    expect(probe.presence).toBe('unknown');
  });

  it(`should answer unknown without asking anything under AGENT_CLI_NO_DEVICE`, async () => {
    process.env.AGENT_CLI_NO_DEVICE = '1';
    try {
      const probe = await probeAppPresenceAsync(
        projectRoot,
        'ios',
        created,
        deps({
          hasAppOnDevice: () => {
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
    [
      'the device probe throws',
      { probeDeviceAsync: () => Promise.reject(new Error('adb exploded')) },
    ],
    [
      'the app lookup throws',
      { hasAppOnDevice: () => Promise.reject(new Error('no such device')) },
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
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'android',
      unbound,
      deps(overrides as never)
    );

    expect(probe.presence).toBe('unknown');
  });
});
