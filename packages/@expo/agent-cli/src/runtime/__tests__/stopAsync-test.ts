import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { vol } from 'memfs';
import { seedAndroidBinding, seedIosBinding } from '../../deviceBinding/__tests__/fakeTools';

import { readDevServerLockAsync, readLastLoggedDevServerPort } from '../../devLock';
import type { RuntimeStopOptions } from '../resolveStopOptions';
import { buildStopFollowUps, runtimeStopAsync, type RuntimeStopResultJson } from '../stopAsync';

vi.mock('../../devLock', () => ({
  readDevServerLockAsync: vi.fn(async () => null),
  readLastLoggedDevServerPort: vi.fn(() => null),
}));

const projectRoot = '/project';
const realPlatform = process.platform;

const BOOTED_SIMULATOR = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'IOS-1', name: 'iPhone 17', state: 'Booted' },
    ],
  },
});

interface SpawnAnswer {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

/** The preflight's device facts on a run bound to an emulator: `simctl`, then `adb devices -l`. */
const ANDROID_INVENTORY: SpawnAnswer[] = [
  { exitCode: 1 },
  { stdout: 'List of devices attached\nemulator-5554\tdevice model:sdk_gphone64_arm64\n' },
];

function mockSpawnQueue(answers: SpawnAnswer[]) {
  let call = 0;
  vi.mocked(spawn).mockImplementation((() => {
    const answer = answers[call++] ?? {};
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    process.nextTick(() => {
      if (answer.stdout) child.stdout.emit('data', answer.stdout);
      if (answer.stderr) child.stderr.emit('data', answer.stderr);
      child.emit('close', answer.exitCode ?? 0, null);
    });
    return child as any;
  }) as any);
}

function spawnedArgv(index: number): string[] {
  const [bin, args] = vi.mocked(spawn).mock.calls[index] as unknown as [string, string[]];
  return [bin, ...args];
}

function mockDevServer(targets: unknown[] | null) {
  globalThis.fetch = (async () => {
    if (targets == null) {
      throw new Error('fetch failed');
    }
    return { ok: true, json: async () => targets };
  }) as unknown as typeof fetch;
}

function options(overrides: Partial<RuntimeStopOptions> = {}): RuntimeStopOptions {
  return {
    devServerUrl: 'http://127.0.0.1:8081',
    platform: 'ios',
    cloud: false,
    json: true,
    followups: false,
    ...overrides,
  };
}

function printed(): string {
  return vi.mocked(console.log).mock.calls.flat().join('\n');
}

let originalFetch: typeof fetch | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  vi.mocked(readDevServerLockAsync).mockResolvedValue(null);
  vi.mocked(readLastLoggedDevServerPort).mockReturnValue(null);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  seedIosBinding(projectRoot, 'IOS-1');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vol.fromJSON({ [`${projectRoot}/app.json`]: JSON.stringify({ expo: { slug: 'demo' } }) });
});

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vol.reset();
});

describe(runtimeStopAsync, () => {
  it(`should read the bundle id from the app config when nothing is connected`, async () => {
    vol.fromJSON({
      [`${projectRoot}/app.json`]: JSON.stringify({
        expo: { slug: 'demo', ios: { bundleIdentifier: 'com.example.demo' } },
      }),
    });
    mockDevServer([]);
    mockSpawnQueue([{ stdout: BOOTED_SIMULATOR }, { stdout: '' }]);

    await runtimeStopAsync(projectRoot, options());

    expect(JSON.parse(printed())).toMatchObject({
      bundleId: 'com.example.demo',
      bundleIdSource: 'app-config',
    });
  });

  it(`should report a device that refused, and name the app it tried`, async () => {
    mockDevServer([]);
    mockSpawnQueue([{ stdout: BOOTED_SIMULATOR }, { exitCode: 1, stderr: 'Invalid device: NOPE' }]);

    await expect(runtimeStopAsync(projectRoot, options())).resolves.toBe(1);
    const report = JSON.parse(printed());
    expect(report).toMatchObject({ stopped: false, wasRunning: false });
    expect(report.reason).toBe('Invalid device: NOPE');
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('--app-id');
  });

  // The command reads the dev server for evidence, and an app can be running with no dev server
  // behind it at all — so an unreachable one must cost the evidence, not the command.
  it(`should still stop the app when no dev server answers`, async () => {
    mockDevServer(null);
    mockSpawnQueue([{ stdout: BOOTED_SIMULATOR }, { stdout: '' }]);

    await expect(runtimeStopAsync(projectRoot, options())).resolves.toBe(0);
    expect(JSON.parse(printed())).toMatchObject({
      stopped: true,
      bundleIdSource: 'expo-go-default',
    });
  });

  it(`should force-stop the app on the bound emulator instance`, async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    seedAndroidBinding(projectRoot, 'emulator-5554');
    mockDevServer([]);
    mockSpawnQueue([
      { stdout: 'device\n' }, // adb get-state, the binding's check
      ...ANDROID_INVENTORY,
      // The `pidof` F102 added, before the stop, because after it the answer is the same either way.
      { stdout: '4021\n' },
      { stdout: '' },
    ]);

    await expect(runtimeStopAsync(projectRoot, options({ platform: 'android' }))).resolves.toBe(0);
    expect(spawnedArgv(4)).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'force-stop',
      `'host.exp.exponent'`,
    ]);
    expect(JSON.parse(printed())).toMatchObject({ stopped: true, wasRunning: true });
  });

  // F101 — CRITICAL, found live on 2026-08-27: `runtime:stop --android` on a machine with an iPhone
  // simulator on the same dev server ran
  // `adb -s emulator-5554 shell am force-stop host.exp.Exponent` — the **iOS** spelling, which is
  // not an installed package on Android — and reported `stopped: true, wasRunning: true` while
  // `adb shell pidof host.exp.exponent` still answered `3933` and the target stayed listed.
  //
  // The mechanism is one line: `resolveAppId` took `targetAppIds.find(Boolean)` off the *unscoped*
  // target list, and Expo Go's two application ids differ by one capital letter (llp/0005 §The dev
  // server does not label its targets). The dev server happened to list iOS first. So this command
  // now reads `classifiedTargets.read` — the platform-scoped list the preflight already builds for every other
  // command in the family — and the ids in its report are the ones on the device it acted on.
  it(`resolves the application id from the platform it is stopping, not the first one listed (F101)`, async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockDevServer([
      { id: 'ios-1', appId: 'host.exp.Exponent', deviceName: 'iPhone 17 Pro' },
      {
        id: 'android-1',
        appId: 'host.exp.exponent',
        deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
      },
    ]);
    seedAndroidBinding(projectRoot, 'emulator-5554');
    mockSpawnQueue([
      { stdout: 'device\n' },
      ...ANDROID_INVENTORY,
      { stdout: '3933\n' },
      { stdout: '' },
    ]);

    await expect(runtimeStopAsync(projectRoot, options({ platform: 'android' }))).resolves.toBe(0);

    const report = JSON.parse(printed());
    expect(report.bundleId).toBe('host.exp.exponent');
    expect(report.bundleIdSource).toBe('dev-server');
    // The list a reader of an `--android` run needs is the one on the device the run acted on: the
    // iOS id belongs to another device and stopping it here would have been the defect.
    expect(report.connectedAppIds).toEqual(['host.exp.exponent']);
    expect(spawnedArgv(4)).toContain(`'host.exp.exponent'`);
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Stopping the app — live run S13.
//
// On a cloud session `wasRunning` is null: the controller closes the app in front and answers the
// same way whatever application id it was given. The follow-up read that null as `false` and
// asserted "The app was not running" while Expo Go was running on the session.
describe(buildStopFollowUps, () => {
  function report(overrides: Partial<RuntimeStopResultJson> = {}): RuntimeStopResultJson {
    return {
      stopped: true,
      wasRunning: true,
      platform: 'ios',
      deviceBackend: 'local-ios',
      deviceId: 'IOS-1',
      bundleId: 'host.exp.Exponent',
      bundleIdSource: 'dev-server',
      bundleIdReason: 'the dev server named it',
      command: 'xcrun simctl terminate IOS-1 host.exp.Exponent',
      reason: null,
      connectedAppIds: [],
      appIdMismatch: false,
      followups: [],
      ...overrides,
    };
  }

  // Three arms, not two: `wasRunning: null` is the cloud case, and a falsy check read it as `false`.
  //
  // F103 — found live on 2026-08-27: `runtime:stop --android` suggested `npx @expo/agent-cli navigate /`,
  // which on this Mac opens the app on the **iOS simulator**, not on the emulator it just stopped. So
  // the platform is carried; `--eas` is not given one, because a session has exactly one device.
  it.each<{
    name: string;
    overrides: Partial<RuntimeStopResultJson>;
    command: string;
    why: RegExp;
  }>([
    {
      name: 'an app this command stopped',
      overrides: {},
      command: 'npx @expo/agent-cli navigate / --ios',
      why: /The app is stopped/,
    },
    {
      name: 'an app that was not running',
      overrides: { wasRunning: false },
      command: 'npx @expo/agent-cli navigate / --ios',
      why: /The app was not running/,
    },
    {
      name: 'a cloud session, whose controller reports neither',
      overrides: { wasRunning: null, deviceBackend: 'cloud', deviceId: 'session-1' },
      command: 'npx @expo/agent-cli navigate / --eas',
      why: /not something the session's controller reports.*cloud simulator session/,
    },
    {
      name: 'an app stopped on the emulator (F103)',
      overrides: { platform: 'android', deviceBackend: 'local-android' },
      command: 'npx @expo/agent-cli navigate / --android',
      why: /The app is stopped/,
    },
  ])(`offers the way back for $name`, ({ overrides, command, why }) => {
    const [followUp] = buildStopFollowUps(report(overrides));
    expect(followUp!.command).toBe(command);
    expect(followUp!.why).toMatch(why);
  });
});
