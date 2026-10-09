// @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
//
// The half of this worth testing is what it *refuses* to say. Only `missing` adds a minute of
// install to a plan, so every path that could not establish it has to answer `unknown` — and
// `unknown` is the state every run was in before this module existed, so it can only ever plan
// what was planned yesterday.

import type { BoundDevice } from '../../deviceBinding';
import { probeAppPresenceAsync, type AppPresenceDevice } from '../appPresence';

const APP_ID = 'com.example.app';
const projectRoot = '/project';

const BOUND: BoundDevice = {
  backend: 'local-ios',
  platform: 'ios',
  udid: 'UDID-1',
  name: 'agent-cli 0000',
  origin: 'created',
};
const BOUND_EMULATOR: BoundDevice = {
  backend: 'local-android',
  platform: 'android',
  serial: 'emulator-5554',
  origin: { kind: 'spawned', avd: 'Pixel_9', port: 5554, emulatorPid: 4242 },
};
const reused: AppPresenceDevice = { device: BOUND, action: 'reused' };
const created: AppPresenceDevice = { device: BOUND, action: 'created' };
const reusedEmulator: AppPresenceDevice = { device: BOUND_EMULATOR, action: 'reused' };
const spawned: AppPresenceDevice = { device: BOUND_EMULATOR, action: 'spawned' };
const unbound: AppPresenceDevice = { device: null, action: null };

/** The defaults every row overrides one of: a device that has the app. */
function deps(overrides: Parameters<typeof probeAppPresenceAsync>[3] = {}) {
  return {
    readAppId: () => APP_ID,
    hasAppOnDevice: async () => true,
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
    });
  });

  it(`should answer missing when the bound simulator has not got it`, async () => {
    const probe = await probeAppPresenceAsync(
      projectRoot,
      'ios',
      reused,
      deps({ hasAppOnDevice: async () => false })
    );

    expect(probe).toEqual({ presence: 'missing' });
  });

  // created-device-missing-without-app-id
  it.each([
    ['created', created],
    ['spawned', spawned],
  ])(
    `should answer missing for a %s device without asking, even with no app id`,
    async (_action, bound) => {
      const hasAppOnDevice = vi.fn(async () => true);

      const probe = await probeAppPresenceAsync(
        projectRoot,
        bound.device!.platform,
        bound,
        deps({ readAppId: () => null, hasAppOnDevice })
      );

      expect(probe).toEqual({ presence: 'missing' });
      expect(hasAppOnDevice).not.toHaveBeenCalled();
    }
  );

  // null-device-ios-unprobed
  it.each(['ios', 'android'] as const)(
    `should answer unknown on %s with no bound device, asking nothing`,
    async (platform) => {
      const hasAppOnDevice = vi.fn(async () => true);

      const probe = await probeAppPresenceAsync(
        projectRoot,
        platform,
        unbound,
        deps({ hasAppOnDevice })
      );

      expect(probe.presence).toBe('unknown');
      expect(hasAppOnDevice).not.toHaveBeenCalled();
    }
  );

  it(`should ask the bound device by its id and backend`, async () => {
    const asked: [string, string | null][] = [];
    const ask = async (deviceId: string, backend: string | null) => {
      asked.push([deviceId, backend]);
      return true;
    };
    await probeAppPresenceAsync(projectRoot, 'ios', reused, deps({ hasAppOnDevice: ask }));
    await probeAppPresenceAsync(
      projectRoot,
      'android',
      reusedEmulator,
      deps({ hasAppOnDevice: ask })
    );

    expect(asked).toEqual([
      ['UDID-1', 'local-ios'],
      ['emulator-5554', 'local-android'],
    ]);
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
      reusedEmulator,
      deps({ budgetMs: 20, hasAppOnDevice: () => new Promise(() => {}) })
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
      reusedEmulator,
      deps(overrides as never)
    );

    expect(probe.presence).toBe('unknown');
  });
});
