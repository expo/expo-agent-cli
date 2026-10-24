// @ref llp/0005-runtime-loop-tools.rfc.md §One preflight for the runtime family
// The one place the `runtime:*` commands ask "is there anything to talk to", and the one refusal
// they all print when there is not.

import { vol } from 'memfs';

import {
  bindingFor,
  seedAndroidBinding,
  seedIosBinding,
  writeBinding,
} from '../../deviceBinding/__tests__/fakeTools';
import { bindingPathFor, readBindingFile } from '../../deviceBinding/registry';
import { EXIT_OUTCOME_TIMEOUT } from '../../exitCodes';
import * as Log from '../../log';
import { spawnCaptureAsync } from '../../utils/spawnCapture';
import { APP_RECONNECT_GRACE_MS } from '../devServer';
import { preflightRuntimeAsync, reachTheAppLadder } from '../preflight';
import { describeSkippedApps } from '../runScope';
import { makeDeviceFacts } from './runScopeFixtures';

vi.mock('../../log');
// `xcrun simctl list devices` answers with these booted simulators, and `adb get-state` with an
// emulator that is up; every other tool fails to run.
let bootedSimulators: { udid: string; name: string }[] = [];
vi.mock('../../utils/spawnCapture', () => ({ spawnCaptureAsync: vi.fn() }));
beforeEach(() => {
  bootedSimulators = [];
  vi.mocked(spawnCaptureAsync).mockImplementation(async (bin: string, args: string[] = []) =>
    bin === 'xcrun'
      ? {
          stdout: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-0': bootedSimulators.map((simulator) => ({
                ...simulator,
                state: 'Booted',
              })),
            },
          }),
          stderr: '',
          exitCode: 0,
        }
      : args.includes('get-state')
        ? { stdout: 'device\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 1 }
  );
});

const TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  deviceName: 'iPhone 17',
  description: '',
  type: 'native',
  title: 'Expo Go',
  devtoolsFrontendUrl: '/devtools',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
};

const ANDROID_TARGET = {
  ...TARGET,
  id: '2',
  appId: 'host.exp.exponent',
  deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=2&page=1',
};

const devServerUrl = 'http://127.0.0.1:8081';

let originalFetch: typeof fetch | undefined;
/** Every URL the preflight asked for, which is how "one probe" is a testable claim. */
let requested: string[] = [];

/** Answer `GET /json/list` with these targets, or make the dev server unreachable with null. */
function mockDevServer(targets: unknown[] | null) {
  requested = [];
  globalThis.fetch = (async (url: string) => {
    requested.push(String(url));
    if (targets == null) {
      throw new Error('fetch failed');
    }
    return { ok: true, json: async () => targets };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockDevServer([TARGET]);
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

describe(preflightRuntimeAsync, () => {
  it(`should hand back the connection a command needs, so nothing resolves it twice`, async () => {
    const connection = await preflightRuntimeAsync({ need: 'debugger-target', devServerUrl });

    expect(connection).toMatchObject({
      devServerUrl,
      devServerSource: 'flag',
      named: true,
      reachable: true,
      targets: [TARGET],
      appTargets: [TARGET],
    });
  });

  // The reason this exists at all: `runtime:eval` used to read `/json/list` three times before it
  // opened a socket — once to find the dev server, once for the device index, once to require an
  // app — and each read could answer differently about which app was connected.
  it(`should read the debugger target list once`, async () => {
    await preflightRuntimeAsync({ need: 'debugger-target', devServerUrl, platform: 'ios' });

    expect(requested).toEqual([`${devServerUrl}/json/list`]);
  });

  it(`should scope the targets to the platform the caller named`, async () => {
    mockDevServer([TARGET, ANDROID_TARGET]);

    const connection = await preflightRuntimeAsync({
      need: 'debugger-target',
      devServerUrl,
      platform: 'android',
    });

    expect(connection.appTargets).toEqual([ANDROID_TARGET]);
    // Both lists are kept: the report owes the reader what else was attached.
    expect(connection.targets).toHaveLength(2);
  });
});

describe(`${preflightRuntimeAsync.name} with no dev server`, () => {
  it(`should name the dev server it probed and the command that starts one`, async () => {
    mockDevServer(null);

    const error = await preflightRuntimeAsync({ need: 'debugger-target', devServerUrl }).catch(
      (e) => e
    );

    expect(error.code).toBe('NO_DEV_SERVER');
    expect(error.message).toContain(devServerUrl);
    expect(error.message).toContain('npx @expo/agent-cli dev --detach');
    expect(error.message).not.toContain('npx expo start');
    expect(error.suggestedCommand).toBe(
      `npx @expo/agent-cli dev --detach --${process.platform === 'darwin' ? 'ios' : 'android'}`
    );
  });

  // Both halves of the family ask the same question, so the answer is the same object: an agent
  // branching on it must not need a per-command allowlist of shapes.
  it(`should carry the counts it observed, so a caller need not parse the prose`, async () => {
    mockDevServer(null);

    const error = await preflightRuntimeAsync({ need: 'dev-server', devServerUrl }).catch((e) => e);

    expect(error.data).toEqual({
      devServerUrl,
      devServerReachable: false,
      debuggerTargets: 0,
      commandSocketClients: null,
      platform: null,
    });
  });

  // @ref llp/0005 §Cloud simulator — the F5x/S5 rule. A caller who passed
  // `--eas` is on a machine whose device is in a datacenter, so a suggestion that drops the flag
  // sends them to a local simulator they have not got, and one that drops `--tunnel` starts a dev
  // server the session cannot reach.
  it(`should keep --eas and the tunnel in the ladder when the caller passed --eas`, async () => {
    mockDevServer(null);

    const error = await preflightRuntimeAsync({
      need: 'dev-server',
      devServerUrl,
      cloud: true,
    }).catch((e) => e);

    expect(error.message).toContain('npx @expo/agent-cli dev --detach --tunnel');
    expect(error.message).toContain(
      `npx @expo/agent-cli navigate / --${process.platform === 'darwin' ? 'ios' : 'android'} --eas`
    );
  });

  it(`should not retry a dev server that does not answer`, async () => {
    mockDevServer(null);

    const error = await preflightRuntimeAsync({
      need: 'debugger-target',
      devServerUrl,
      retryMs: 2000,
    }).catch((e) => e);

    expect(error.code).toBe('NO_DEV_SERVER');
    expect(requested).toHaveLength(1);
  });

  // `runtime:stop` stops an app on a device, and an app can be running with no dev server behind
  // it at all. The dev server is its evidence for *which* app, never a precondition.
  it(`should hand back an unreachable dev server when the command only wants the evidence`, async () => {
    mockDevServer(null);

    const connection = await preflightRuntimeAsync({ need: 'optional', devServerUrl });

    expect(connection.reachable).toBe(false);
    expect(connection.targets).toEqual([]);
    expect(connection.unreachableReason).toContain('fetch failed');
  });
});

describe(`${preflightRuntimeAsync.name} with no app connected`, () => {
  it(`should say which list is empty, on which dev server, and how to fill it`, async () => {
    mockDevServer([]);

    const error = await preflightRuntimeAsync({ need: 'debugger-target', devServerUrl }).catch(
      (e) => e
    );

    expect(error.code).toBe('NO_APP_CONNECTED');
    expect(error.message).toContain('no app is connected');
    expect(error.message).toContain(`${devServerUrl}/json/list`);
    expect(error.message).toContain('npx @expo/agent-cli navigate /');
    // Not a keypress in a terminal: a detached dev server has none, and a driving agent has no
    // keyboard for one that has (friction run 5, F48-5).
    expect(error.message).not.toContain('press "i"');
    expect(error.data).toEqual({
      devServerUrl,
      devServerReachable: true,
      debuggerTargets: 0,
      commandSocketClients: null,
      platform: null,
    });
  });

  it(`should wait out the reconnect window before it reports no app`, async () => {
    let reconnected = false;
    setTimeout(() => (reconnected = true), 60);
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => (reconnected ? [TARGET] : []),
    })) as unknown as typeof fetch;

    const connection = await preflightRuntimeAsync({
      need: 'debugger-target',
      devServerUrl,
      retryMs: 2000,
    });

    expect(connection.appTargets).toEqual([TARGET]);
  });

  it(`should say how long it kept asking`, async () => {
    mockDevServer([]);

    const error = await preflightRuntimeAsync({
      need: 'debugger-target',
      devServerUrl,
      retryMs: 300,
    }).catch((e) => e);

    expect(error.message).toContain('still empty 300ms later');
  });

  it(`should refuse only on the dev server for a command that starts an app itself`, async () => {
    mockDevServer([]);

    const connection = await preflightRuntimeAsync({ need: 'dev-server', devServerUrl });

    expect(connection.reachable).toBe(true);
    expect(connection.appTargets).toEqual([]);
  });

  // @ref llp/0010-agent-conventions.rfc.md §An empty target list is inconclusive — **F141.** A
  // `runtime:tree` run straight after a reload landed in the app's re-registration window and
  // reported exit 1, "no target". It recovered on a plain retry, four times out of five — and `1`
  // is the code that promises the opposite: running the same line again changes nothing.
  it(`should answer an empty list with 22, because a retry may answer`, async () => {
    mockDevServer([]);

    const error = await preflightRuntimeAsync({ need: 'debugger-target', devServerUrl }).catch(
      (e) => e
    );

    expect(error.exitCode).toBe(EXIT_OUTCOME_TIMEOUT);
    expect(error.message).toContain('re-registering');
  });

  // The dev server itself is the other half, and it stays 1: nothing answered, and asking again
  // inside a second does not start one. Pinned next to the case above so the two cannot merge.
  it(`should keep 1 for a dev server that is not there`, async () => {
    mockDevServer(null);

    const error = await preflightRuntimeAsync({ need: 'debugger-target', devServerUrl }).catch(
      (e) => e
    );

    expect(error.code).toBe('NO_DEV_SERVER');
    expect(error.exitCode).toBeUndefined();
  });

  // And so does the wrong-platform refusal: apps *are* connected, they are on another platform, and
  // that is a fact a second look reports identically. The fix is to change the line.
  it(`should keep 1 for apps that are all on another platform`, async () => {
    mockDevServer([TARGET]);

    const error = await preflightRuntimeAsync({
      need: 'debugger-target',
      devServerUrl,
      platform: 'android',
    }).catch((e) => e);

    expect(error.message).toContain('No android app is connected');
    expect(error.exitCode).toBeUndefined();
  });

  // The grace was `runtime:errors`' alone, which is why `runtime:tree` was the command that hit the
  // gap: it asked once and reported the answer. Every command that needs a runtime asks the same
  // question, so every one of them now waits out the same window (F39's mechanism, F141's reach).
  it(`should wait out the reconnect window without being asked to`, async () => {
    let reconnected = false;
    setTimeout(() => (reconnected = true), 60);
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => (reconnected ? [TARGET] : []),
    })) as unknown as typeof fetch;

    const connection = await preflightRuntimeAsync({ need: 'debugger-target', devServerUrl });

    expect(connection.appTargets).toEqual([TARGET]);
  });

  // A command that needs no runtime is not made to wait for one: `runtime:reload` can start the app
  // it finds nothing of, and `runtime:stop` calls an app that is not running a success.
  it.each([['dev-server'], ['optional']] as const)(
    `should not wait out that window for a %s command`,
    async (need) => {
      mockDevServer([]);
      const startedAt = Date.now();

      await preflightRuntimeAsync({ need, devServerUrl });

      expect(Date.now() - startedAt).toBeLessThan(APP_RECONNECT_GRACE_MS);
    }
  );
});

// @ref llp/0021-honest-reports.rfc.md §How they show up — F58, S5, F103,
// F142. The ladder already kept `--eas` and the platform on `navigate`, and dropped the platform
// from the `dev` that comes before it — and a bare `dev` plans for whichever platform this machine's
// probe picks, so the first rung of the ladder out was a different run from the one asked for.
describe(reachTheAppLadder, () => {
  it.each([['ios'], ['android']] as const)(`keeps --%s on every rung, dev included`, (platform) => {
    for (const state of ['no-dev-server', 'no-app'] as const) {
      const ladder = reachTheAppLadder({ state, cloud: false, platform });

      expect(ladder).toContain(`npx @expo/agent-cli navigate / --${platform}`);
      if (state === 'no-dev-server') {
        expect(ladder).toContain(`npx @expo/agent-cli dev --detach --${platform}`);
      }
    }
  });

  // `--eas` is not `dev`'s flag; what a cloud session needs from a dev server is a tunnel. Both
  // still have to be on the one line, in the order the CLI accepts them.
  it(`keeps the tunnel next to the platform for a cloud session`, () => {
    expect(reachTheAppLadder({ state: 'no-dev-server', cloud: true, platform: 'ios' })).toContain(
      'npx @expo/agent-cli dev --detach --tunnel --ios'
    );
  });

  // `dev` requires a platform, so the ladder states the host's when the caller named none.
  it(`states the host's platform when the caller named none`, () => {
    expect(reachTheAppLadder({ state: 'no-dev-server', cloud: false })).toContain(
      `npx @expo/agent-cli dev --detach --${process.platform === 'darwin' ? 'ios' : 'android'}"`
    );
  });
});

// @ref ./targetPlatform — friction run 6, F51. With an iOS simulator and an Android emulator on
// one dev server, a command told `--android` used to be handed whichever target came first.
describe(`${preflightRuntimeAsync.name} scoped to a platform`, () => {
  it(`should name the platform the connected app is actually on`, async () => {
    mockDevServer([TARGET]);

    const error = await preflightRuntimeAsync({
      need: 'debugger-target',
      devServerUrl,
      platform: 'android',
    }).catch((e) => e);

    expect(error.code).toBe('NO_APP_CONNECTED');
    expect(error.message).toContain('No android app is connected');
    expect(error.message).toContain('it is on ios');
    expect(error.suggestedCommand).toBe('npx @expo/agent-cli navigate / --android');
    // The count is of the list as the dev server gave it, so a caller can see that an app *is*
    // attached and that it is the wrong one.
    expect(error.data).toMatchObject({ debuggerTargets: 1, platform: 'android' });
  });

  it(`should say plainly when nothing about the connected app names a platform`, async () => {
    mockDevServer([{ ...TARGET, appId: 'com.example.app', deviceName: 'Ada’s phone' }]);

    const error = await preflightRuntimeAsync({
      need: 'debugger-target',
      devServerUrl,
      platform: 'android',
      // Empty on purpose: the device tools have nothing to say about this device either.
      facts: makeDeviceFacts(),
    }).catch((e) => e);

    expect(error.code).toBe('NO_APP_CONNECTED');
    expect(error.message).toContain('could be shown to be running on android');
    // Never a guess in either direction.
    expect(error.message).not.toContain('is connected to the Expo dev server at');
  });
});

// The other half of `howToNameTheDevServer`: a caller who let this CLI find the dev server is told
// how to name one, and a caller who named it is not told to pass the flag they just passed
// [friction run 4].
describe(`${preflightRuntimeAsync.name} on a dev server nobody named`, () => {
  it(`should say how to name one when it discovered the URL itself`, async () => {
    mockDevServer(null);

    const error = await preflightRuntimeAsync({
      need: 'debugger-target',
      devServerUrl: null,
    }).catch((e) => e);

    expect(error.code).toBe('NO_DEV_SERVER');
    expect(error.message).toContain('--dev-server-url');
    expect(error.message).not.toContain('the one you named');
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Another worktree's clone simulator, still booted, loads its JavaScript from this port.
describe(`${preflightRuntimeAsync.name} beside an app of another worktree`, () => {
  const OWN_ROOT = '/wt/mapfilter';
  const OTHER_ROOT = '/wt/legend';
  const CLONE = 'agent-cli c4ed0a60';
  const ON_CLONE = { ...TARGET, id: '3', appId: 'dev.vonovak.cyclable', deviceName: CLONE };
  const SKIPPED = describeSkippedApps([
    { deviceName: CLONE, group: 'other-worktree', projectRoots: [OTHER_ROOT] },
  ]);

  beforeEach(() => {
    vol.fromJSON({ [`${OWN_ROOT}/package.json`]: '{}', [`${OTHER_ROOT}/package.json`]: '{}' });
    bootedSimulators = [{ udid: 'SIM-LEGEND', name: CLONE }];
  });
  afterEach(() => {
    vol.reset();
  });

  it(`should read this worktree's app, and name the skipped one on stderr`, async () => {
    seedIosBinding(OTHER_ROOT, 'SIM-LEGEND', CLONE);
    mockDevServer([ON_CLONE, ANDROID_TARGET]);

    const connection = await preflightRuntimeAsync(
      { need: 'debugger-target', devServerUrl, retryMs: 0 },
      { projectRoot: OWN_ROOT }
    );

    expect(connection.appTargets).toEqual([ANDROID_TARGET]);
    expect(vi.mocked(Log.progress)).toHaveBeenCalledWith(expect.stringContaining(SKIPPED));
  });

  // A release ends the lease and keeps the file; so does a lease nobody renewed for 60 minutes.
  it(`should read the app on a simulator whose other binding ran out, and renew no lease`, async () => {
    writeBinding(
      bindingPathFor(OTHER_ROOT, 'ios', 'local-ios'),
      bindingFor(OTHER_ROOT, 'SIM-LEGEND', { name: CLONE, expiresAt: '2000-01-01T00:00:00.000Z' })
    );
    const ownFile = bindingPathFor(OWN_ROOT, 'ios', 'local-ios');
    writeBinding(
      ownFile,
      bindingFor(OWN_ROOT, 'SIM-OWN', { expiresAt: '2999-01-01T00:00:00.000Z' })
    );
    mockDevServer([ON_CLONE]);

    const connection = await preflightRuntimeAsync(
      { need: 'debugger-target', devServerUrl, retryMs: 0 },
      { projectRoot: OWN_ROOT }
    );

    expect(connection.appTargets).toEqual([ON_CLONE]);
    expect(readBindingFile(ownFile)).toMatchObject({
      binding: { expiresAt: '2999-01-01T00:00:00.000Z' },
    });
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// The device bound to this worktree on the run's platform is the scope: from the flag, or with no
// flag from the binding. A flag names the platform and never drops the bound device of that
// platform. A local simulator's app with the session's app id is not the session's app.
describe(`${preflightRuntimeAsync.name} on a worktree with a bound device`, () => {
  const OWN_ROOT = '/wt/mapfilter';
  const DEV_BUILD = 'dev.vonovak.cyclable';
  const ON_A = { ...TARGET, id: '3', appId: DEV_BUILD, deviceName: 'iPhone 17 Pro' };
  const ON_B = { ...TARGET, id: '4', appId: DEV_BUILD, deviceName: 'iPhone 16' };
  const ON_IOS_SESSION = { ...TARGET, id: '5', appId: DEV_BUILD, deviceName: 'iPhone 17' };
  const ON_ANDROID = {
    ...ANDROID_TARGET,
    id: '6',
    appId: DEV_BUILD,
    deviceName: 'sdk_gphone64_x86_64 - 15 - API 35',
  };
  const realPlatform = process.platform;
  const bindSession = (platform: 'ios' | 'android', id: string) => () =>
    writeBinding(bindingPathFor(OWN_ROOT, platform, 'cloud'), {
      version: 1,
      device: { backend: 'cloud', platform, id, origin: 'started' },
      projectRoot: OWN_ROOT,
      boundAt: '2026-10-21T00:50:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
  const bindEmulator = () => seedAndroidBinding(OWN_ROOT, 'emulator-5554');
  const bindSimulatorA = () => seedIosBinding(OWN_ROOT, 'SIM-OWN', 'iPhone 17 Pro');
  const SESSION_LINE =
    'Scoped to ios: the EAS Simulator session 01a160c1, the device bound to this worktree.';
  const SIMULATOR_LINE =
    'Scoped to ios: the iOS simulator "iPhone 17 Pro", the device bound to this worktree.';

  beforeEach(() => {
    vol.fromJSON({ [`${OWN_ROOT}/package.json`]: '{}' });
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    bootedSimulators = [
      { udid: 'SIM-OWN', name: 'iPhone 17 Pro' },
      { udid: 'SIM-16', name: 'iPhone 16' },
    ];
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vol.reset();
  });

  it.each([
    {
      name: 'an Android emulator, no flag: reads its platform',
      bind: bindEmulator,
      flag: undefined,
      targets: [TARGET, ANDROID_TARGET],
      platform: { value: 'android', by: 'bound-device' },
      appTargets: [ANDROID_TARGET],
      line: 'Scoped to android: the Android device emulator-5554, the device bound to this worktree.',
    },
    {
      name: 'an Android EAS session, no flag: reads its platform',
      bind: bindSession('android', '01a15bf1'),
      flag: undefined,
      targets: [TARGET, ON_ANDROID],
      platform: { value: 'android', by: 'bound-device' },
      appTargets: [ON_ANDROID],
      line: 'Scoped to android: the EAS Simulator session 01a15bf1, the device bound to this worktree.',
    },
    {
      name: 'an Android emulator, --ios: reads the platform the flag names',
      bind: bindEmulator,
      flag: 'ios' as const,
      targets: [TARGET, ANDROID_TARGET],
      platform: { value: 'ios', by: 'flag' },
      appTargets: [TARGET],
      line: null,
    },
    {
      name: 'an iOS EAS session, no flag: reads the session app, not the local one',
      bind: bindSession('ios', '01a160c1'),
      flag: undefined,
      targets: [ON_A, ON_IOS_SESSION, ON_ANDROID],
      platform: { value: 'ios', by: 'bound-device' },
      appTargets: [ON_IOS_SESSION],
      line: SESSION_LINE,
    },
    {
      name: 'an iOS EAS session, --ios: reads the session app, not the local one',
      bind: bindSession('ios', '01a160c1'),
      flag: 'ios' as const,
      targets: [ON_A, ON_IOS_SESSION, ON_ANDROID],
      platform: { value: 'ios', by: 'flag' },
      appTargets: [ON_IOS_SESSION],
      line: SESSION_LINE,
    },
    {
      name: 'an iOS EAS session, --android: reads the platform the flag names',
      bind: bindSession('ios', '01a160c1'),
      flag: 'android' as const,
      targets: [ON_A, ON_IOS_SESSION, ON_ANDROID],
      platform: { value: 'android', by: 'flag' },
      appTargets: [ON_ANDROID],
      line: null,
    },
    {
      name: 'local simulator A, no flag: reads only the app on A',
      bind: bindSimulatorA,
      flag: undefined,
      targets: [ON_B, ON_A, ON_ANDROID],
      platform: { value: 'ios', by: 'bound-device' },
      appTargets: [ON_A],
      line: SIMULATOR_LINE,
    },
    {
      name: 'local simulator A, --ios: reads only the app on A, not the unbound B',
      bind: bindSimulatorA,
      flag: 'ios' as const,
      targets: [ON_B, ON_A, ON_ANDROID],
      platform: { value: 'ios', by: 'flag' },
      appTargets: [ON_A],
      line: SIMULATOR_LINE,
    },
    {
      name: 'local simulator A, --android: reads the platform the flag names',
      bind: bindSimulatorA,
      flag: 'android' as const,
      targets: [ON_B, ON_A, ON_ANDROID],
      platform: { value: 'android', by: 'flag' },
      appTargets: [ON_ANDROID],
      line: null,
    },
  ])('$name', async ({ bind, flag, targets, platform, appTargets, line }) => {
    bind();
    mockDevServer(targets);

    const connection = await preflightRuntimeAsync(
      { need: 'debugger-target', devServerUrl, platform: flag, retryMs: 0 },
      { projectRoot: OWN_ROOT }
    );

    expect(connection.scope.platform).toEqual(platform);
    expect(connection.appTargets).toEqual(appTargets);
    const scopeLines = vi
      .mocked(Log.progress)
      .mock.calls.flat()
      .filter((text) => String(text).startsWith('Scoped to'));
    expect(scopeLines).toEqual(line == null ? [] : [line]);
  });

  // N2-33: with one app connected too, an app on another device is not the bound device's app.
  it.each([
    {
      name: 'one local app on an iOS EAS session',
      bind: bindSession('ios', '01a160c1'),
      targets: [ON_A],
      app: '"iPhone 17 Pro"',
      device: 'the EAS Simulator session 01a160c1',
      line: SESSION_LINE,
    },
    {
      name: 'one app on simulator B beside the bound simulator A',
      bind: bindSimulatorA,
      targets: [ON_B],
      app: '"iPhone 16"',
      device: 'the iOS simulator "iPhone 17 Pro"',
      line: SIMULATOR_LINE,
    },
  ])(
    `should refuse $name, and name the app and the bound device`,
    async ({ bind, targets, app, device, line }) => {
      bind();
      mockDevServer(targets);

      const error = await preflightRuntimeAsync(
        { need: 'debugger-target', devServerUrl, retryMs: 0 },
        { projectRoot: OWN_ROOT }
      ).catch((e) => e);

      expect(error.code).toBe('NO_APP_CONNECTED');
      expect(error.exitCode).toBeUndefined();
      expect(error.message).toContain(app);
      expect(error.message).toContain(device);
      expect(vi.mocked(Log.progress)).not.toHaveBeenCalledWith(line);
    }
  );

  // A flag hint only where the flag can help: never the other flag to a caller who named one.
  it.each([
    {
      name: 'an iOS EAS session, no flag: names the other platform flag',
      bind: bindSession('ios', '01a160c1'),
      flag: undefined,
      targets: [ON_ANDROID],
      how: 'How: open the app on ios with "npx @expo/agent-cli navigate / --ios --eas", then run this command again. Pass --android to read the other app instead.',
    },
    {
      name: 'an iOS EAS session, --ios: names no flag',
      bind: bindSession('ios', '01a160c1'),
      flag: 'ios' as const,
      targets: [ON_ANDROID],
      how: 'How: open the app on ios with "npx @expo/agent-cli navigate / --ios --eas", then run this command again.',
    },
    {
      name: 'an Android emulator, no flag: names the other platform flag',
      bind: bindEmulator,
      flag: undefined,
      targets: [ON_A, ON_B],
      how: 'How: open the app on android with "npx @expo/agent-cli navigate / --android", then run this command again. Pass --ios to read the other app instead.',
    },
    {
      name: "an Android emulator, --ios: drops the flag that is not the bound device's",
      bind: bindEmulator,
      flag: 'ios' as const,
      targets: [ANDROID_TARGET],
      how: 'How: open the app on ios with "npx @expo/agent-cli navigate / --ios", then run this command again. Drop --ios to read whichever app is connected.',
    },
  ])('$name', async ({ bind, flag, targets, how }) => {
    bind();
    mockDevServer(targets);

    const error = await preflightRuntimeAsync(
      { need: 'debugger-target', devServerUrl, platform: flag, retryMs: 0 },
      { projectRoot: OWN_ROOT }
    ).catch((e) => e);

    expect(error.message.split('\n').at(-1)).toBe(how);
  });
});
