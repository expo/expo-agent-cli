import { spawn } from 'child_process';
import { EventEmitter } from 'events';

import { resetApprovedSchemes } from '../../device/approveScheme';
import { openUrlOnDeviceAsync } from '../deepLink';

/**
 * Covers `openUrlOnDeviceAsync` with the process spawn mocked, so the argv the device command
 * receives is asserted without a device.
 */

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

/**
 * Mock the spawn so that every child settles itself, once the awaits in front of it have run.
 *
 * @ref src/device/approveScheme.ts — the reason this stopped being a `mockReturnValue` whose child
 * the test emitted on by hand. Two things changed at once for a local iOS open: it is now **two**
 * spawns rather than one, because the URL's scheme approval is written before the link is opened,
 * and the spawn itself now happens one microtask later, behind that `await`. A test that emitted
 * synchronously was therefore emitting at a child that did not exist yet, and every iOS case here
 * timed out. `setImmediate` settles after the microtasks, which is what makes this independent of
 * how many awaits precede the spawn.
 *
 * @param settle what each child does. `close` with a code, or an `error` for a tool that will not
 * start — the distinction `openUrlOnDeviceAsync` turns into two different failures.
 */
function mockSpawn(
  settle: ({ close?: number } & { stdout?: string; stderr?: string }) | { error: Error } = {}
): void {
  vi.mocked(spawn).mockImplementation((() => {
    const child = makeChild();
    setImmediate(() => {
      if ('error' in settle) {
        child.emit('error', settle.error);
        return;
      }
      if (settle.stdout != null) {
        child.stdout.emit('data', settle.stdout);
      }
      if (settle.stderr != null) {
        child.stderr.emit('data', settle.stderr);
      }
      child.emit('close', settle.close ?? 0, null);
    });
    return child as any;
  }) as never);
}

/**
 * The argv of the **link open**, which is the last spawn of the call rather than the first.
 *
 * On iOS the first spawn is the scheme approval (@ref src/device/approveScheme.ts), and a helper
 * that read `calls[0]` would assert against that instead — silently, since both are `xcrun`.
 */
function spawnedArgv(): string[] {
  const calls = vi.mocked(spawn).mock.calls;
  const [bin, args] = calls[calls.length - 1] as unknown as [string, string[]];
  return [bin, ...args];
}

/** Every spawn of the call, for the cases that are about what else was run. */
function allSpawnedArgv(): string[][] {
  return vi
    .mocked(spawn)
    .mock.calls.map(([bin, args]) => [bin as string, ...((args as string[]) ?? [])]);
}

describe(openUrlOnDeviceAsync, () => {
  it(`should spawn simctl openurl on iOS`, async () => {
    mockSpawn();

    const promise = openUrlOnDeviceAsync({
      platform: 'ios',
      deviceId: 'ABCD-1234',
      url: 'demoapp://profile/42',
      appId: 'com.example.demo',
    });
    const result = await promise;

    expect(spawnedArgv()).toEqual([
      'xcrun',
      'simctl',
      'openurl',
      'ABCD-1234',
      'demoapp://profile/42',
    ]);
    expect(result.command).toBe('xcrun simctl openurl ABCD-1234 demoapp://profile/42');
    expect(result.exitCode).toBe(0);
  });

  it(`should spawn an adb ACTION_VIEW intent on Android`, async () => {
    mockSpawn();

    const promise = openUrlOnDeviceAsync({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'exp://localhost:8081/--/profile/42',
      appId: 'host.exp.exponent',
    });
    const result = await promise;

    expect(spawnedArgv()).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-c',
      'android.intent.category.BROWSABLE',
      '-d',
      `'exp://localhost:8081/--/profile/42'`,
      'host.exp.exponent',
    ]);
    expect(result.exitCode).toBe(0);
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §Pointing an app at this dev server — F123, and the
  // one thing about the Android launcher open that is not a matter of which URL is sent.
  //
  // A BROWSABLE ACTION_VIEW intent carrying the dev launcher's URL reaches `DevLauncherController.
  // handleIntent` on an app that is **not running**, and that path dies:
  // `java.lang.NullPointerException … DevLauncherController.createAppIntent` on
  // `expo-dev-launcher`, leaving the app on `DevLauncherErrorActivity`
  // [observed — 2026-08-28, the emulator of `live-devclient`, and again in wave 29's
  // `evidence/63-devlauncher-npe.txt`]. The same URL handed to `MainActivity` **by component**
  // loads the bundle and attaches in about three seconds, on the same device in the same minute.
  //
  // That is exactly what `expo start --dev-client --android` does, and this is its command:
  // `am start -f 0x20000000 -n <app>/.MainActivity -d <url>`
  // [reference — `@expo/cli` `src/start/platforms/android/adb.ts` §launchActivityAsync].
  it(`should launch a named activity by component, the way the Expo CLI opens a dev client`, async () => {
    mockSpawn();

    const promise = openUrlOnDeviceAsync({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'demoapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
      launchActivity: 'com.example.demo/.MainActivity',
    });
    await promise;

    expect(spawnedArgv()).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      // FLAG_ACTIVITY_SINGLE_TOP, so an app already at the top of the stack is not relaunched.
      '-f',
      '0x20000000',
      '-n',
      `'com.example.demo/.MainActivity'`,
      '-d',
      `'demoapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081'`,
    ]);
  });

  // iOS has one way in — `simctl openurl` — and it is what the Expo CLI uses there too.
  it(`should ignore a launch activity on iOS`, async () => {
    mockSpawn();

    const promise = openUrlOnDeviceAsync({
      platform: 'ios',
      deviceId: 'SIM-1',
      url: 'demoapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
      launchActivity: 'com.example.demo/.MainActivity',
    });
    await promise;

    expect(spawnedArgv()[1]).toBe('simctl');
  });

  it(`should report a failing device command instead of throwing`, async () => {
    mockSpawn({ close: 1, stderr: 'Error: Activity not started' });

    const result = await openUrlOnDeviceAsync({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'demoapp://profile/42',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Error: Activity not started');
  });

  it(`should return the device output`, async () => {
    mockSpawn({ stdout: 'Starting: Intent { act=android.intent.action.VIEW }' });

    const result = await openUrlOnDeviceAsync({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'demoapp://profile/42',
    });

    expect(result.stdout).toContain('Starting: Intent');
  });

  it(`should report an adb that could not be started as a tool failure, not a device failure`, async () => {
    mockSpawn({ error: Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }) });

    const promise = openUrlOnDeviceAsync({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'demoapp://profile/42',
    });

    const error = await promise.catch((e) => e);

    // One error for an unrunnable `adb` wherever it is spawned from (`src/device/adb.ts`, F49):
    // it names every place that was looked and the variable that adds another.
    expect(error.code).toBe('ADB_NOT_RUNNABLE');
    expect(error.message).toContain('"adb" could not be run');
    expect(error.message).toContain('ANDROID_HOME');
  });

  // @ref src/device/approveScheme.ts
  // @ref llp/0005-runtime-loop-tools.rfc.md §A link nobody can approve is a link that never opens
  //
  // The dialog is the whole problem: a scheme iOS has not seen approved raises `Open in "<app>"?`,
  // and `simctl openurl` **exits 0** while that alert is up — so the link reads as delivered,
  // nothing attaches, and the run waits out its budget against an alert nobody is there to answer
  // [observed — a development build on iOS 26.5, two consecutive `openurl` calls that both exited 0
  // with `Open in "pdfbuild"?` on screen, 2026-09-04]. `@expo/cli` writes the approval before every
  // one of its own opens, for any app id; this used to write it only for an Expo Go it had just
  // installed, so every development build the caller built themselves hit the alert.
  it(`approves the URL's scheme before opening it on iOS`, async () => {
    mockSpawn();
    resetApprovedSchemes();

    await openUrlOnDeviceAsync({
      platform: 'ios',
      deviceId: 'SIM-1',
      url: 'exp+pdfbuild://',
      appId: 'com.tuft.pdfbuild',
    });

    // Before, not after: the approval has to be in place when the link lands.
    expect(allSpawnedArgv()[0]).toEqual([
      'xcrun',
      'simctl',
      'spawn',
      'SIM-1',
      'defaults',
      'write',
      'com.apple.launchservices.schemeapproval',
      'com.apple.CoreSimulator.CoreSimulatorBridge-->exp+pdfbuild',
      '-string',
      'com.tuft.pdfbuild',
    ]);
    // The second preparation, and the second obstacle: without it a first-ever launch puts the dev
    // menu's onboarding sheet over the app that did open, and the run then waits out its attach
    // budget behind it (@ref src/device/approveScheme §finishDevMenuOnboardingAsync).
    expect(allSpawnedArgv()[1]).toEqual([
      'xcrun',
      'simctl',
      'spawn',
      'SIM-1',
      'defaults',
      'write',
      'com.tuft.pdfbuild',
      'EXDevMenuIsOnboardingFinished',
      '-bool',
      'true',
    ]);
    expect(allSpawnedArgv()[2]).toEqual(['xcrun', 'simctl', 'openurl', 'SIM-1', 'exp+pdfbuild://']);
  });

  // The key's value *is* the app id, so there is no "approve for whoever" to write.
  it(`writes nothing when the app id is unknown`, async () => {
    mockSpawn();
    resetApprovedSchemes();

    await openUrlOnDeviceAsync({ platform: 'ios', deviceId: 'SIM-1', url: 'exp+pdfbuild://' });

    expect(allSpawnedArgv()).toHaveLength(1);
    expect(allSpawnedArgv()[0]![2]).toBe('openurl');
  });

  // One `navigate` opens the launcher URL and then the route link — two opens of one scheme, and a
  // second pair of writes would buy nothing. The same memo `@expo/cli` keeps.
  it(`writes each preference once per device and app, however many links are opened`, async () => {
    mockSpawn();
    resetApprovedSchemes();

    for (const url of ['exp+pdfbuild://expo-development-client/?url=x', 'exp+pdfbuild://notes']) {
      await openUrlOnDeviceAsync({
        platform: 'ios',
        deviceId: 'SIM-1',
        url,
        appId: 'com.tuft.pdfbuild',
      });
    }

    expect(
      allSpawnedArgv().filter((argv) => argv.includes('com.apple.launchservices.schemeapproval'))
    ).toHaveLength(1);
    expect(
      allSpawnedArgv().filter((argv) => argv.includes('EXDevMenuIsOnboardingFinished'))
    ).toHaveLength(1);
    expect(allSpawnedArgv().filter((argv) => argv.includes('openurl'))).toHaveLength(2);
  });

  // Android has no such alert: an `exp://` intent filter is in the manifest, and the link works the
  // moment the package is there. Writing an iOS preference for it would be nonsense.
  it(`writes no approval for Android`, async () => {
    mockSpawn();
    resetApprovedSchemes();

    await openUrlOnDeviceAsync({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'exp://127.0.0.1:8081',
      appId: 'host.exp.exponent',
    });

    expect(allSpawnedArgv().some((argv) => argv.includes('defaults'))).toBe(false);
  });

  it(`should report a missing simctl with an install hint`, async () => {
    mockSpawn({ error: Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }) });

    const promise = openUrlOnDeviceAsync({
      platform: 'ios',
      deviceId: 'SIM-1',
      url: 'demoapp://profile/42',
    });

    const error = await promise.catch((e) => e);

    expect(error.code).toBe('DEVICE_TOOL_MISSING');
    expect(error.message).toContain('xcrun simctl');
  });
});

describe('Quoting the launch activity for the device shell', () => {
  it('should quote the component of an am start', async () => {
    mockSpawn();

    const promise = openUrlOnDeviceAsync({
      platform: 'android',
      deviceId: 'emulator-5554',
      url: 'demoapp://route',
      launchActivity: 'com.x;toybox id;#/.MainActivity',
    });
    await promise;

    expect(spawnedArgv()).toContain(`'com.x;toybox id;#/.MainActivity'`);
  });
});
